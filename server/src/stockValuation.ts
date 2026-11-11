import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hantooGet, hantooReady } from "./hantooClient.js";
import { noteLife } from "./lifecycle.js";

/**
 * **종목별 PER·PBR** — 조건검색이 쓰는 값 (2026-11-12).
 *
 * 벤티지: "조건 검색에 이거 하나 추가할 수 있겠다. PER, PBR 등 지표들 해가지고 그 종목
 * 조회하는 거, 그리고 타 종목 대비 PER이 고평가나 저평가인지도 평가 검색하는 거 식
 * 만들 수 있겠는데 그거 이미 우리 들고 있는 거잖아"
 *
 * 절반은 맞았다. **업종 평균**은 이미 매일 낸다(`sectorValuation.ts`, 38업종×상위10).
 * 없던 건 **전 종목의 PER** 이다 — 비교의 분자 쪽이다.
 *
 * ## 매일 2,700 건을 받지 않는다
 *
 * 벤티지가 전에 짚은 사실이 길을 연다 — 키움·한투의 `per` 은 **「오늘 주가 ÷ 직전 결산
 * EPS」** 다([[kiwoom-valuation-is-last-fy]]). 분모가 **1년에 한 번만** 바뀐다. 그러면
 * 매일 받을 이유가 없다:
 *
 *     한 번 받아 둔다      : per·pbr 과 **그때의 주가**
 *     매일 계산한다        : PER = 오늘주가 × per받을때 ÷ 그때주가
 *
 * 전종목 스냅샷에 오늘 주가가 있으므로(조회 0회) **매일 드는 조회가 0** 이다.
 *
 * ## ⚠️ EPS 를 안 쓴다 — 단위를 안 믿는 것이다
 *
 * `price ÷ eps` 로 내도 같지만, 한투 EPS 는 **10배로 온 적이 있다**
 * ([[number-units-verify-by-product]]). 위 식은 **눈금이 아니라 비율**이라 단위가 아예
 * 안 끼어든다 — `per` 과 `주가` 가 같은 응답에서 오고, 둘의 비는 무엇으로 재든 같다.
 *
 * 받은 `eps`·`bps` 는 **화면에 보여 줄 용도로만** 같이 저장하고, 계산에는 안 쓴다.
 * 저장할 때 `price ÷ eps ≈ per` 인지 검산해 어긋나면 적어 둔다 — 언젠가 또 10배가
 * 오면 그 줄이 말해 준다.
 *
 * ## 기준은 「작년 결산」이다
 *
 * `sectorValuation` 과 **같은 성질**이라 그대로 견줄 수 있다. 최근 4분기(TTM)·포워드와
 * 섞으면 안 된다 — 그쪽은 네이버고 기준이 다르다.
 */

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "stockValuation.json");
/** 이만큼 지나면 다시 받는다 — 결산은 연 1회지만 분기 공시로 바뀌는 종목도 있다 */
const REFRESH_DAYS = 45;
/** 한 번 돌 때 최대 몇 종목 — 2,700 을 한 판에 받으면 다른 정리를 민다 */
const BATCH = 400;
/** 한 종목과 다음 종목 사이. 한투 큐(초당 2.5건)를 막지 않을 만큼 — sectorValuation 과 같은 값 */
const GAP_MS = 450;

export interface StockValue {
  /** 받을 때의 PER (= 그때주가 ÷ 직전결산 EPS) */
  per: number;
  /** 받을 때의 PBR */
  pbr: number;
  /** **그때의 주가** — 오늘 값으로 되살리는 데 쓰는 기준점 */
  price: number;
  /** 참고용. 계산에는 **안 쓴다**(위 머리말) */
  eps: number | null;
  bps: number | null;
  /** 받은 시각(ms) */
  at: number;
}

interface Store {
  byCode: Record<string, StockValue>;
}

let store: Store | null = null;
let loading: Promise<void> | null = null;
let running = false;
let stat = { 받음: 0, 실패: 0, 단위어긋남: 0, 마지막: "" };

async function load(): Promise<void> {
  if (store || loading) return loading ?? undefined;
  loading = (async () => {
    try {
      store = JSON.parse(await readFile(FILE, "utf-8")) as Store;
      if (!store.byCode) store = { byCode: {} };
    } catch {
      store = { byCode: {} };
    } finally {
      loading = null;
    }
  })();
  return loading;
}

async function save(): Promise<void> {
  if (!store) return;
  await writeFile(FILE, JSON.stringify(store), "utf-8");
}

/**
 * **파일을 메모리로** — `valuationOf` 는 동기라 미리 불러 둬야 한다.
 *
 * 안 부르고 `valuationOf` 를 쓰면 전 종목이 조용히 `null` 이 되고, 조건식은 「아무도
 * 조건에 안 맞는다」로 읽힌다. 마크를 굽기 전에 반드시 한 번 기다린다.
 */
export async function loadStockValuation(): Promise<void> {
  await load();
}

/** health.json 「종목밸류」 */
export function stockValuationStat(): Record<string, unknown> {
  return {
    종목수: store ? Object.keys(store.byCode).length : 0,
    수집중: running,
    ...stat,
  };
}

/**
 * **오늘 기준 PER·PBR.** 오늘 주가를 넘기면 받을 때의 비율로 되살린다.
 *
 * 받은 적 없는 종목이면 `null` — 「PER 0」으로 굳히지 않는다. 조건식에서 0 은
 * 「아주 싸다」로 읽히는데, 모르는 것과 싼 것은 다르다.
 */
export function valuationOf(code: string, todayPrice: number | null | undefined): {
  per: number | null;
  pbr: number | null;
  eps: number | null;
  bps: number | null;
  asOf: number;
} | null {
  const v = store?.byCode[code.replace(/_(AL|NX)$/i, "")];
  if (!v) return null;
  /* 기준 주가가 없으면 되살릴 수가 없다 — 받을 때 값을 그대로 준다 */
  const scale = todayPrice && todayPrice > 0 && v.price > 0 ? todayPrice / v.price : 1;
  return {
    /* per 이 0 이하인 건 **적자**다. 비율을 곱해도 뜻이 없으므로 그대로 둔다 */
    per: v.per > 0 ? v.per * scale : v.per,
    pbr: v.pbr > 0 ? v.pbr * scale : v.pbr,
    eps: v.eps,
    bps: v.bps,
    asOf: v.at,
  };
}

/** 한투 현재가에서 per·pbr·eps·bps 와 **그때의 주가**를 같이 (sectorValuation 과 같은 TR) */
async function fetchOne(code: string): Promise<StockValue | null> {
  const body = await hantooGet<{ output?: Record<string, string> }>(
    "/uapi/domestic-stock/v1/quotations/inquire-price",
    "FHKST01010100",
    { fid_cond_mrkt_div_code: "J", fid_input_iscd: code },
    "종목밸류",
  );
  const o = body.output;
  if (!o) return null;
  const per = Number(o.per);
  const pbr = Number(o.pbr);
  const price = Math.abs(Number(o.stck_prpr));
  if (!Number.isFinite(per) || !Number.isFinite(pbr) || !Number.isFinite(price) || price <= 0) return null;
  const eps = Number(o.eps);
  const bps = Number(o.bps);
  /*
   * **검산** — `주가 ÷ eps` 가 `per` 과 맞나. 안 맞으면 단위가 어긋난 것이다(전에 10배가
   * 왔다). 계산에는 어차피 eps 를 안 쓰지만, 화면에 보여 줄 값이라 세어 둔다.
   */
  if (Number.isFinite(eps) && eps > 0 && per > 0) {
    const implied = price / eps;
    if (Math.abs(implied - per) / per > 0.05) stat.단위어긋남 += 1;
  }
  return {
    per,
    pbr,
    price,
    eps: Number.isFinite(eps) ? eps : null,
    bps: Number.isFinite(bps) ? bps : null,
    at: Date.now(),
  };
}

/** 다시 받아야 하는 종목 — 받은 적 없거나 오래된 것. 오래된 순서로 */
function stale(codes: string[]): string[] {
  const now = Date.now();
  const cut = REFRESH_DAYS * 86_400_000;
  return codes
    .filter((c) => {
      const v = store?.byCode[c];
      return !v || now - v.at > cut;
    })
    .sort((a, b) => (store?.byCode[a]?.at ?? 0) - (store?.byCode[b]?.at ?? 0))
    .slice(0, BATCH);
}

/**
 * 배경 수집 — 한 번에 최대 `BATCH` 종목, **하나씩**.
 *
 * ⚠️ 중간에 실패해도 멈추지 않는다. 한 종목 때문에 전체가 비면 안 된다.
 * 2,700 종목이면 일곱 번쯤 돌아야 한 바퀴다 — 결산이 연 1회라 급할 게 없다.
 */
export async function refreshStockValuation(codes: string[]): Promise<void> {
  if (running || !hantooReady()) return;
  await load();
  const targets = stale(codes);
  if (targets.length === 0) return;
  running = true;
  stat = { 받음: 0, 실패: 0, 단위어긋남: 0, 마지막: "" };
  const t0 = Date.now();
  try {
    for (const code of targets) {
      try {
        const v = await fetchOne(code);
        if (v && store) {
          store.byCode[code] = v;
          stat.받음 += 1;
          stat.마지막 = code;
        } else {
          stat.실패 += 1;
        }
      } catch {
        stat.실패 += 1;
      }
      await new Promise((ok) => setTimeout(ok, GAP_MS));
    }
    await save();
    const 남음 = codes.filter((c) => {
      const v = store?.byCode[c];
      return !v || Date.now() - v.at > REFRESH_DAYS * 86_400_000;
    }).length;
    noteLife(
      "START",
      `종목밸류 수집 — 받음 ${stat.받음} · 실패 ${stat.실패} · 남음 ${남음} (${Math.round((Date.now() - t0) / 1000)}초)` +
        (stat.단위어긋남 > 0 ? ` ⚠️ eps 단위 어긋남 ${stat.단위어긋남}건` : ""),
    );
  } finally {
    running = false;
  }
}
