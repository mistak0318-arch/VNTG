import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hantooGet, hantooReady } from "./hantooClient.js";
import { isRealSector, peekSnapshot } from "./marketSnapshot.js";

/**
 * **업종 평균 PER·PBR** (2026-10-21 — 벤티지: "업종 평균은 못구하나?").
 *
 * ## 받아올 데가 없다 — 그래서 우리가 낸다
 *
 * 전수로 찾아봤고 전부 없었다:
 *
 *   키움    없다. 앱에 보이는 업종PER 은 FnGuide 를 앱에 심은 것이다
 *   한투    업종 TR(`FHPUP02140000`)은 되는데 **PER 류 필드가 0개**다 —
 *           38 업종의 지수·등락·거래량·거래대금뿐
 *   네이버  `industry`·`industryCompare`·`overviewInfo` 등 여덟 경로 전부 404
 *   KRX     `GET` 은 200 인데 `POST` 가 안 끝난다(세션 쿠키가 필요한 구조로 보인다)
 *
 * 그런데 **재료의 대부분은 이미 우리 것**이다. 전종목 스냅샷에 업종과 시총이 들어 있고
 * (2,730 종목, 조회 0회), 종목별 PER 만 붙이면 집계가 된다:
 *
 *     순이익ᵢ = 시총ᵢ ÷ PERᵢ
 *     업종PER = Σ시총ᵢ ÷ Σ순이익ᵢ          (시총가중)
 *
 * ## 왜 업종당 열 종목인가
 *
 * 시총가중이라 **큰 종목이 값을 정한다.** 업종 시총의 대부분이 상위 열 개에 몰려 있어서,
 * 꼬리를 더 붙여도 소수점이나 바뀐다. 2,730 종목을 다 받으면 마감 뒤 수집이 한 시간쯤
 * 늘고 소형주 적자를 거르는 규칙을 따로 정해야 하는데, 얻는 게 그만큼이 아니다.
 * 38 업종 × 10 = **380 조회**, 하루 한 번.
 *
 * ## 왜 한투인가 (국내는 키움인데)
 *
 * PER·PBR 만큼은 **두 곳이 같은 값**임을 실측했다 — 하이닉스 10/21 에 키움 `per 21.78`
 * `eps 58955`, 한투 `per 21.85` `eps 58955` (주가 시점만 다르다). 같은 벤더다.
 * 그러면 **키움 한도를 안 먹는 쪽**이 낫다. 키움 조회 한도는 장중 느려짐의 단골
 * 원인이고, 이 수집은 하루 한 번 380 건이나 되기 때문이다.
 *
 * ⚠️ 한투 큐는 **20 건을 넘으면 즉시 `QUEUE_FULL`** 이다. 한꺼번에 밀어 넣지 말고
 *    반드시 **하나씩 await** 한다(아래 `collect`).
 *
 * ## 적자는 뺀다
 *
 * PER 이 0 이하인 종목을 넣으면 순이익이 음수로 더해져 **업종 PER 이 낮아진다** —
 * 적자 기업이 많을수록 업종이 싸 보이는 거꾸로 된 값이 된다. 표준 관행대로 빼고,
 * **몇을 뺐는지 같이 내보낸다**(`skipped`). 화면이 「열 중 셋을 빼고 낸 값」임을
 * 말할 수 있어야 한다.
 *
 * ## 기준은 「작년 결산」
 *
 * 벤티지가 고른 칸이다. 키움·한투의 per 은 **오늘 주가 ÷ 직전 결산 EPS** 이므로
 * (2026-10-21 전수점검, `ValuationStrip` 머리말), 이 평균도 같은 성질이다.
 * 띠의 **작년 칸**과만 견준다 — 최근 4분기 칸 옆에 놓으면 기준이 섞인다.
 */

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "sectorValuation.json");
/** 업종당 몇 종목까지 */
const TOP_N = 10;
/** 이만큼은 남아야 「평균」이라 부른다 — 아래 `enough` 주석 */
const MIN_USED = 3;
/** 이만큼 지나면 낡았다 — 하루 한 번이면 충분하다 */
const STALE_MS = 20 * 3600_000;
/** 한 종목과 다음 종목 사이. 한투 큐(초당 2.5건)를 막지 않을 만큼 */
const GAP_MS = 450;

export interface SectorValue {
  sector: string;
  per: number | null;
  pbr: number | null;
  /** 집계에 쓴 종목 수 */
  used: number;
  /** 적자·무자료로 뺀 종목 수 */
  skipped: number;
}

interface Store {
  at: number;
  sectors: Record<string, SectorValue>;
}

let store: Store | null = null;
let loading: Promise<void> | null = null;
let running = false;
let stat = { 받음: 0, 실패: 0, 마지막: "" };

async function load(): Promise<void> {
  if (store || loading) return loading ?? undefined;
  loading = (async () => {
    try {
      store = JSON.parse(await readFile(FILE, "utf-8")) as Store;
    } catch {
      store = null; // 없으면 처음 돌 때 만들어진다
    } finally {
      loading = null;
    }
  })();
  return loading;
}

/** health.json 「업종평균」 */
export function sectorValuationStat(): Record<string, unknown> {
  return {
    업종수: store ? Object.keys(store.sectors).length : 0,
    갱신: store ? new Date(store.at).toISOString() : null,
    수집중: running,
    ...stat,
  };
}

/**
 * 한 종목의 업종 평균. **기다리지 않는다** — 낡았으면 배경 수집만 걸고
 * 들고 있던 값을 바로 준다(없으면 null). 첫 조회가 화면을 세우면 안 된다.
 */
export async function sectorValueOf(code: string): Promise<SectorValue | null> {
  await load();
  const snap = peekSnapshot();
  const sector = snap?.byCode.get(code.replace(/_(AL|NX)$/i, ""))?.sector ?? "";
  if (!store || Date.now() - store.at > STALE_MS) void refresh();
  if (!sector || !store) return null;
  return store.sectors[sector] ?? null;
}

/** 전 업종 — 나중에 업종 비교 화면을 만들 때 쓴다 */
export async function allSectorValues(): Promise<{ at: number; sectors: SectorValue[] } | null> {
  await load();
  if (!store) {
    void refresh();
    return null;
  }
  if (Date.now() - store.at > STALE_MS) void refresh();
  return { at: store.at, sectors: Object.values(store.sectors).sort((a, b) => a.sector.localeCompare(b.sector, "ko")) };
}

/**
 * 스냅샷의 종목들 — 메모리에 없으면 **디스크에서** 읽는다 (2026-10-21).
 *
 * `peekSnapshot()` 은 메모리 캐시라 서버가 막 떴을 때는 비어 있다. 그때 빈손으로
 * 돌아가면 이 수집은 **스냅샷이 처음 채워질 때까지 한 번도 못 돈다.** 파일은 어제
 * 것이라도 「업종마다 누가 큰가」를 고르는 데는 충분하다 — 시총 순위는 하루에 안 바뀐다.
 */
async function snapshotStocks(): Promise<{ code: string; sector: string; marketCap: number | null }[]> {
  const mem = peekSnapshot();
  if (mem) return [...mem.byCode.values()].map((s) => ({ code: s.code, sector: s.sector, marketCap: s.marketCap }));
  try {
    const raw = JSON.parse(
      await readFile(join(dirname(fileURLToPath(import.meta.url)), "..", "data", "marketSnapshot.json"), "utf-8"),
    ) as { stocks?: { code: string; sector: string; marketCap: number }[] };
    return raw.stocks ?? [];
  } catch {
    return [];
  }
}

/** 업종마다 시총 상위 `TOP_N` — 조회 0회(스냅샷만 읽는다) */
async function pickTargets(): Promise<Map<string, { code: string; cap: number }[]>> {
  const stocks = await snapshotStocks();
  const out = new Map<string, { code: string; cap: number }[]>();
  for (const s of stocks) {
    const sector = s.sector ?? "";
    /* 「종합」·「대형주」 같은 지수 묶음은 업종이 아니다 — 섞으면 평균이 뜻을 잃는다 */
    if (!sector || !isRealSector(sector)) continue;
    const cap = Number(s.marketCap);
    if (!Number.isFinite(cap) || cap <= 0) continue;
    const list = out.get(sector) ?? [];
    list.push({ code: s.code, cap });
    out.set(sector, list);
  }
  for (const [k, list] of out) {
    list.sort((a, b) => b.cap - a.cap);
    out.set(k, list.slice(0, TOP_N));
  }
  return out;
}

/** 한투 현재가에서 per·pbr 만 (키움과 같은 값 — 머리말 참고) */
async function ratiosOf(code: string): Promise<{ per: number; pbr: number } | null> {
  const body = await hantooGet<{ output?: Record<string, string> }>(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    "FHKST01010100",
    { fid_cond_mrkt_div_code: "J", fid_input_iscd: code },
    "업종평균",
  );
  const o = body.output;
  if (!o) return null;
  const per = Number(o.per);
  const pbr = Number(o.pbr);
  if (!Number.isFinite(per) || !Number.isFinite(pbr)) return null;
  return { per, pbr };
}

/**
 * 배경 수집 — 380 건쯤을 **하나씩** 받는다. 한 번에 하나만 돈다.
 *
 * ⚠️ 중간에 실패해도 멈추지 않는다. 한 종목 때문에 업종 전체가 비면 소켓 시절과 같다.
 */
export async function refresh(): Promise<void> {
  if (running || !hantooReady()) return;
  const targets = await pickTargets();
  if (targets.size === 0) return; // 스냅샷이 아직 없다 — 다음 기회에
  running = true;
  stat = { 받음: 0, 실패: 0, 마지막: "" };
  try {
    const sectors: Record<string, SectorValue> = {};
    for (const [sector, list] of targets) {
      let capPer = 0;
      let netSum = 0;
      let capPbr = 0;
      let bookSum = 0;
      let used = 0;
      let skipped = 0;
      for (const t of list) {
        let r: { per: number; pbr: number } | null = null;
        try {
          r = await ratiosOf(t.code);
          stat.받음 += 1;
          stat.마지막 = t.code;
        } catch {
          stat.실패 += 1;
        }
        await new Promise((ok) => setTimeout(ok, GAP_MS));
        if (!r) {
          skipped += 1;
          continue;
        }
        /* 적자(또는 자료 없음)는 뺀다 — 넣으면 업종이 거꾸로 싸 보인다 */
        if (r.per > 0) {
          capPer += t.cap;
          netSum += t.cap / r.per;
          used += 1;
        } else {
          skipped += 1;
        }
        if (r.pbr > 0) {
          capPbr += t.cap;
          bookSum += t.cap / r.pbr;
        }
      }
      /*
       * **세 종목은 모여야 평균이다** (2026-10-21 첫 실측에서 드러났다).
       *
       * 스냅샷 분류에는 종목이 한둘뿐인 업종이 있다 — 「은행」 1종목, 「종이/목재」
       * 1종목이었다. 시총가중이라 한 종목이면 그건 **그 종목의 PER** 이고, 거기에
       * 「업종 평균」이라는 이름을 붙이면 거짓말이 된다. 적자를 빼다 보면 열 개로
       * 시작해도 셋이 안 남는 업종이 생긴다(「기타제조」는 10 중 7 이 적자였다).
       *
       * 못 내는 것은 **안 적는다.** 아래 `used`·`skipped` 는 그대로 내보내므로
       * 화면이 「왜 없는지」는 말할 수 있다.
       */
      const enough = used >= MIN_USED;
      sectors[sector] = {
        sector,
        per: enough && netSum > 0 ? capPer / netSum : null,
        pbr: enough && bookSum > 0 ? capPbr / bookSum : null,
        used,
        skipped,
      };
    }
    store = { at: Date.now(), sectors };
    await writeFile(FILE, JSON.stringify(store, null, 1), "utf-8");
  } finally {
    running = false;
  }
}
