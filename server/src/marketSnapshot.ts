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

const TTL_MS = 5 * 60_000;

let cache: MarketSnapshot | null = null;
/** 만드는 중이면 같은 약속을 돌려줘서 65회 조회가 겹치지 않게 한다 */
let building: Promise<MarketSnapshot> | null = null;

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
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache;
  if (building) return building;

  building = build(client)
    .then((snap) => {
      // 절반도 못 받았으면 이전 스냅샷을 유지한다 — 반쪽 데이터로 테마 등락률을 내면 틀린다
      if (cache && snap.byCode.size < cache.byCode.size / 2) return cache;
      cache = snap;
      return snap;
    })
    .finally(() => {
      building = null;
    });

  return building;
}

/** 캐시에 있으면 준다. 없으면 null — 조회를 기다릴 수 없는 자리에서 쓴다 */
export function peekSnapshot(): MarketSnapshot | null {
  return cache && Date.now() - cache.at < TTL_MS ? cache : null;
}
