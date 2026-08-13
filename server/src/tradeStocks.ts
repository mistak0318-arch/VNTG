import type { KiwoomClient } from "./kiwoomClient.js";
import { getSectorStocks, getThemeStocks, type StockRow } from "./marketOverview.js";

/**
 * 수출 품목 ↔ 관련 종목.
 *
 * "반도체 수출 +166%"만 보면 그래서 뭘 보라는 건지 모른다. 종목이 붙어야 행동으로 이어진다.
 *
 * **종목코드를 손으로 적지 않는다.** 기억으로 적으면 틀리고, 상장폐지·합병·이름변경을
 * 따라갈 수 없다. 대신 키움이 관리하는 테마·업종 구성종목을 그대로 쓴다.
 *
 * 두 단계로 찾는다:
 *   1) 키움 테마 검색 (ka90001, 테마명으로) — 정밀하다. "화장품", "타이어" 처럼 딱 맞는 테마가 있다
 *   2) 없으면 업종 구성종목 — 거칠지만 항상 있다
 */

const THME_RESOURCE = "/api/dostk/thme";

export interface RelatedStock {
  code: string;
  name: string;
  changeRate: number;
  /** 시가총액(억원). 키움이 안 주는 종목이 있어 null 을 허용한다 */
  marketCap?: number | null;
}

export interface RelatedResult {
  stocks: RelatedStock[];
  /** 어디서 가져왔는지 — 화면에 밝혀서 신뢰도를 판단할 수 있게 한다 */
  from: "theme" | "sector" | "none";
  label: string;
}

interface ThemeHit {
  code: string;
  name: string;
}

const themeSearchCache = new Map<string, { hits: ThemeHit[]; at: number }>();
const stocksCache = new Map<string, { data: RelatedResult; at: number }>();
const TTL_MS = 30 * 60_000;

/**
 * 전체 테마 목록.
 *
 * 처음엔 ka90001 에 `thema_nm` 검색어를 주는 방식을 썼는데 **아무것도 안 나왔다.**
 * 그 파라미터는 우리가 기대한 검색이 아니었다.
 * 대신 cont-yn 페이지네이션으로 전체 목록을 받아 이름으로 걸러낸다.
 *
 * 테마는 하루에 바뀌지 않으므로 6시간 캐시면 충분하다.
 */
let allThemes: { list: ThemeHit[]; at: number } | null = null;
const THEME_LIST_TTL_MS = 6 * 3600_000;

async function fetchAllThemes(client: KiwoomClient): Promise<ThemeHit[]> {
  if (allThemes && Date.now() - allThemes.at < THEME_LIST_TTL_MS) return allThemes.list;

  const out: ThemeHit[] = [];
  const seen = new Set<string>();
  let contYn = "N";
  let nextKey = "";

  // 무한 루프 방지 — 테마가 수백 개라 10페이지면 충분하다
  for (let page = 0; page < 10; page += 1) {
    const res = await client.request<Record<string, unknown>>(
      THME_RESOURCE,
      "ka90001",
      { qry_tp: "0", stk_cd: "", date_tp: "1", thema_nm: "", flu_pl_amt_tp: "3", stex_tp: "3" },
      page === 0 ? {} : { contYn, nextKey },
    );
    const rows = Array.isArray(res.data.thema_grp)
      ? (res.data.thema_grp as Record<string, unknown>[])
      : [];
    for (const r of rows) {
      const code = String(r.thema_grp_cd ?? "");
      const name = String(r.thema_nm ?? "");
      if (code && name && !seen.has(code)) {
        seen.add(code);
        out.push({ code, name });
      }
    }
    if (res.contYn !== "Y" || !res.nextKey) break;
    contYn = "Y";
    nextKey = res.nextKey;
    await new Promise((r) => setTimeout(r, 220)); // TR당 초당 5회 제한
  }

  allThemes = { list: out, at: Date.now() };
  return out;
}

/** 검색어가 들어간 테마를 찾는다 */
async function searchThemes(client: KiwoomClient, keyword: string): Promise<ThemeHit[]> {
  const hit = themeSearchCache.get(keyword);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hits;

  const list = await fetchAllThemes(client).catch(() => [] as ThemeHit[]);
  const k = keyword.replace(/[\s_]/g, "");
  const hits = list.filter((t) => t.name.replace(/[\s_]/g, "").includes(k));
  themeSearchCache.set(keyword, { hits, at: Date.now() });
  return hits;
}

/** 디버깅용 — 어떤 테마가 있는지 확인할 때 */
export async function listAllThemes(client: KiwoomClient): Promise<ThemeHit[]> {
  return fetchAllThemes(client);
}

function toRelated(rows: StockRow[], limit: number): RelatedStock[] {
  return rows
    .slice()
    // 시가총액이 있으면 큰 순, 없으면 등락률 순 — 대표 종목이 위로 오게
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0) || b.changeRate - a.changeRate)
    .slice(0, limit)
    .map((r) => ({
      code: r.code,
      name: r.name,
      changeRate: r.changeRate,
      marketCap: r.marketCap,
    }));
}

/**
 * 한 품목의 관련 종목을 찾는다.
 *
 * @param themeKeywords 테마 검색어. 앞에 있는 것부터 시도한다
 * @param sector 테마를 못 찾았을 때 쓸 업종명
 */
export async function relatedStocks(
  client: KiwoomClient,
  themeKeywords: string[],
  sector: { market: "kospi" | "kosdaq"; code: string; name: string } | null,
  limit = 6,
): Promise<RelatedResult> {
  const cacheKey = `${themeKeywords.join("|")}::${sector?.code ?? ""}`;
  const hit = stocksCache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  // 1) 테마 우선
  for (const kw of themeKeywords) {
    const themes = await searchThemes(client, kw);
    // 검색어와 가장 짧게 일치하는 테마가 보통 가장 정확하다
    // ("화장품" 검색에 "화장품"이 "화장품_ODM"보다 대표성이 높다)
    const best = themes.slice().sort((a, b) => a.name.length - b.name.length)[0];
    if (!best) continue;

    const rows = await getThemeStocks(client, best.code).catch(() => [] as StockRow[]);
    if (rows.length > 0) {
      const data: RelatedResult = {
        stocks: toRelated(rows, limit),
        from: "theme",
        label: `${best.name} 테마`,
      };
      stocksCache.set(cacheKey, { data, at: Date.now() });
      return data;
    }
  }

  // 2) 업종 폴백
  if (sector?.code) {
    const rows = await getSectorStocks(client, sector.market, sector.code).catch(
      () => [] as StockRow[],
    );
    if (rows.length > 0) {
      const data: RelatedResult = {
        stocks: toRelated(rows, limit),
        from: "sector",
        label: `${sector.name} 업종`,
      };
      stocksCache.set(cacheKey, { data, at: Date.now() });
      return data;
    }
  }

  const empty: RelatedResult = { stocks: [], from: "none", label: "" };
  stocksCache.set(cacheKey, { data: empty, at: Date.now() });
  return empty;
}
