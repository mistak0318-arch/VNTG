import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSection, getSectorStocks, type Sectors, type StockRow } from "./marketOverview.js";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 전종목 시세 스냅샷.
 *
 * 수동 테마의 등락률을 내려면 구성종목의 현재가와 시가총액이 필요하다.
 * 종목마다 조회하면 테마 10개 × 10종목 = 100회라 초당 5회 제한에 걸려 못 쓴다.
 *
 * **모든 종목은 업종 하나에 속한다.** 그래서 업종 구성종목을 전부 모으면
 * 65회(코스피 31 + 코스닥 34) 호출로 전종목 등락률·시총이 나온다.
 * 한 번 만들어두면 테마가 몇 개든 계산만 하면 되므로 추가 호출이 0이다.
 *
 * 65회를 초당 5회로 나눠 부르면 13초쯤 걸린다. 그래서:
 *   - 5분 캐시를 둔다
 *   - 만들어지는 동안 들어온 요청은 같은 약속을 기다린다 (중복 조회 방지)
 *   - 실패한 업종이 있어도 나머지로 스냅샷을 만든다 (전부 아니면 무 방식은 취약하다)
 */

export interface SnapshotStock {
  code: string;
  name: string;
  changeRate: number;
  price: number;
  /** 시가총액(억원). 키움이 안 주는 종목이 있다 */
  marketCap: number | null;
  sector: string;
  market: "kospi" | "kosdaq";
}

export interface MarketSnapshot {
  /** 6자리 종목코드 → 시세. `_AL` 접미사는 떼서 넣는다 */
  byCode: Map<string, SnapshotStock>;
  at: number;
  /** 조회에 실패한 업종 수 — 스냅샷이 얼마나 온전한지 판단용 */
  failedSectors: number;
  totalSectors: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "marketSnapshot.json");

/** 장중에는 시세가 계속 바뀌므로 짧게 */
const INTRADAY_TTL_MS = 5 * 60_000;

let cache: MarketSnapshot | null = null;
/** 만드는 중이면 같은 약속을 돌려줘서 65회 조회가 겹치지 않게 한다 */
let building: Promise<MarketSnapshot> | null = null;
/** 디스크에서 한 번만 읽어오면 되므로 */
let restored = false;

/**
 * 스냅샷이 언제까지 쓸 만한가.
 *
 * 장이 끝나면 종가는 더 안 바뀐다. 그런데 예전엔 5분 TTL을 그대로 써서 마감 후에도,
 * 주말에도 5분마다 65업종을 다시 불렀다 — 같은 숫자를 받으려고 15초를 쓴 셈이다.
 *
 * 그래서 장중에만 5분을 쓰고, 그 밖에는 **다음 개장(09:00 KST)까지** 유지한다.
 * 주말이면 자연히 월요일 09시까지 간다. 공휴일 달력은 없지만, 휴장일에 만료돼 봐야
 * 직전 거래일 종가를 다시 받아올 뿐이라 손해가 없다.
 */
function expiryOf(at: number): number {
  const d = new Date(at);
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  const minutes = kst.getHours() * 60 + kst.getMinutes();
  const weekday = kst.getDay() !== 0 && kst.getDay() !== 6;
  const duringSession = weekday && minutes >= 9 * 60 && minutes < 15 * 60 + 40;

  if (duringSession) return at + INTRADAY_TTL_MS;

  // 다음 개장 09:00 KST — 오늘 09시가 아직 안 지났으면 오늘, 지났으면 그다음 평일
  const next = new Date(kst);
  next.setHours(9, 0, 0, 0);
  if (next.getTime() <= kst.getTime()) next.setDate(next.getDate() + 1);
  // 주말을 건너뛴다. 안 그러면 토·일 아침마다 같은 종가를 받으려고 65회를 다시 부른다
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  return at + (next.getTime() - kst.getTime());
}

function isFresh(snap: MarketSnapshot | null): snap is MarketSnapshot {
  return Boolean(snap && Date.now() < expiryOf(snap.at));
}

// ---------------------------------------------------------------- 디스크 보관

interface StoredSnapshot {
  at: number;
  failedSectors: number;
  totalSectors: number;
  stocks: SnapshotStock[];
}

/**
 * 재시작해도 다시 안 부르도록 디스크에 남긴다.
 * 미니PC를 껐다 켜는 일이 잦은데, 그때마다 65회 조회를 다시 하면 15초를 기다려야 한다.
 */
async function persist(snap: MarketSnapshot): Promise<void> {
  const stored: StoredSnapshot = {
    at: snap.at,
    failedSectors: snap.failedSectors,
    totalSectors: snap.totalSectors,
    stocks: [...snap.byCode.values()],
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(stored), "utf-8");
}

async function restore(): Promise<MarketSnapshot | null> {
  try {
    const stored = JSON.parse(await readFile(FILE, "utf-8")) as StoredSnapshot;
    if (!Array.isArray(stored.stocks) || stored.stocks.length === 0) return null;
    return {
      byCode: new Map(stored.stocks.map((s) => [s.code, s])),
      at: stored.at,
      failedSectors: stored.failedSectors ?? 0,
      totalSectors: stored.totalSectors ?? 0,
    };
  } catch {
    return null;
  }
}

/** 키움은 종목코드에 `_AL`(NXT 통합) 접미사를 붙여 준다. 우리 기준은 6자리다 */
export function bareCode(code: string): string {
  return code.replace(/_AL$/, "").trim();
}

async function build(client: KiwoomClient): Promise<MarketSnapshot> {
  const section = await getSection("sectors", client).catch(() => null);
  const sectors = (section?.data ?? null) as Sectors | null;

  const targets: { market: "kospi" | "kosdaq"; code: string; name: string }[] = [];
  for (const market of ["kospi", "kosdaq"] as const) {
    for (const s of (market === "kospi" ? sectors?.kospi : sectors?.kosdaq) ?? []) {
      if (s.code) targets.push({ market, code: s.code, name: s.name });
    }
  }

  const byCode = new Map<string, SnapshotStock>();
  let failed = 0;

  // 초당 5회 제한 — 5개씩 묶어 돌린다
  for (let i = 0; i < targets.length; i += 5) {
    const chunk = targets.slice(i, i + 5);
    const results = await Promise.all(
      chunk.map((t) =>
        getSectorStocks(client, t.market, t.code)
          .then((rows) => ({ t, rows }))
          .catch(() => ({ t, rows: [] as StockRow[] })),
      ),
    );

    for (const { t, rows } of results) {
      if (rows.length === 0) {
        failed += 1;
        continue;
      }
      for (const r of rows) {
        const code = bareCode(r.code);
        if (!code) continue;
        // 같은 종목이 두 업종에 나오는 일은 없지만, 나와도 먼저 것을 유지한다
        if (byCode.has(code)) continue;
        byCode.set(code, {
          code,
          name: r.name,
          changeRate: r.changeRate,
          price: r.price ?? 0,
          marketCap: r.marketCap ?? null,
          sector: t.name,
          market: t.market,
        });
      }
    }

    if (i + 5 < targets.length) await new Promise((r) => setTimeout(r, 1100));
  }

  return { byCode, at: Date.now(), failedSectors: failed, totalSectors: targets.length };
}

export async function getMarketSnapshot(
  client: KiwoomClient,
  force = false,
): Promise<MarketSnapshot> {
  if (!force && isFresh(cache)) return cache;

  // 메모리에 없으면 디스크부터 본다 (재시작 직후)
  if (!force && !restored) {
    restored = true;
    const saved = await restore();
    if (saved && (!cache || saved.at > cache.at)) cache = saved;
    if (isFresh(cache)) return cache;
  }

  if (building) return building;

  building = build(client)
    .then(async (snap) => {
      // 절반도 못 받았으면 이전 스냅샷을 유지한다 — 반쪽 데이터로 테마 등락률을 내면 틀린다
      if (cache && snap.byCode.size < cache.byCode.size / 2) return cache;
      cache = snap;
      await persist(snap).catch(() => undefined);
      return snap;
    })
    .finally(() => {
      building = null;
    });

  return building;
}

/** 캐시에 있으면 준다. 없으면 null — 조회를 기다릴 수 없는 자리에서 쓴다 */
export function peekSnapshot(): MarketSnapshot | null {
  return isFresh(cache) ? cache : null;
}

/** 스냅샷이 언제 찍힌 것이고 언제까지 쓰는지 — 화면에 보여주기 위해 */
export function snapshotStatus(): { at: number; expiresAt: number; size: number } | null {
  return cache ? { at: cache.at, expiresAt: expiryOf(cache.at), size: cache.byCode.size } : null;
}
