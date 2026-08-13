import type { KiwoomClient } from "./kiwoomClient.js";
import { getSection } from "./marketOverview.js";
import type { Themes, ThemeRow, Sectors, SectorRow } from "./marketOverview.js";
import { sectorNews, type ScoredNews } from "./newsDisclosure.js";
import { listWatchlist } from "./watchlist.js";

/**
 * 리포트 조립 레이어.
 *
 * 웹 화면 / 메일 / 텔레그램이 **같은 데이터 구조**를 쓰도록 서버에서 한 번만 조립한다.
 * 화면에서 조립하면 나중에 메일·텔레그램용으로 똑같은 로직을 또 짜야 한다.
 *
 * 지금은 "강한 테마·업종 + 그 이유(관련 뉴스)"만 다루고,
 * 앞으로 지수·수급·특징주 섹션도 여기로 모은다.
 */

export interface ThemeWithReason {
  code: string;
  name: string;
  changeRate: number;
  stockCount: number;
  mainStock: string;
  /** 왜 올랐나 — 이 테마와 연관된 기사 */
  reasons: ScoredNews[];
}

export interface SectorWithReason {
  code: string;
  name: string;
  changeRate: number;
  market: "코스피" | "코스닥";
  reasons: ScoredNews[];
}

export interface MarketDriverReport {
  fetchedAt: string;
  themes: { up: ThemeWithReason[]; down: ThemeWithReason[] };
  sectors: SectorWithReason[];
}

/**
 * 테마명에서 뉴스 매칭에 쓸 키워드를 뽑는다.
 * 키움 테마명은 "반도체_생산", "2차전지(생산)" 처럼 구분자가 섞여 있다.
 */
function themeKeywords(name: string): string[] {
  return name
    .split(/[_/()\[\],·]/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/** "삼성전자, SK하이닉스" → ["삼성전자", "SK하이닉스"] */
function mainStockNames(mainStock: string): string[] {
  return mainStock
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
}

/**
 * 기사 중 이 테마를 설명할 만한 것을 고른다.
 * 대표 종목명이 제목에 있으면 가장 확실하고, 없으면 테마 키워드로 찾는다.
 */
function findReasons(
  news: ScoredNews[],
  keywords: string[],
  stocks: string[],
  limit = 2,
): ScoredNews[] {
  const scored = news
    .map((n) => {
      // 대표 종목명 일치가 테마 키워드보다 훨씬 강한 근거다
      const stockHit = stocks.filter((s) => n.title.includes(s)).length * 3;
      const kwHit = keywords.filter((k) => n.title.includes(k)).length;
      return { n, relevance: stockHit + kwHit };
    })
    .filter((x) => x.relevance > 0)
    // 연관도가 같으면 뉴스 자체 점수(보도량·임팩트)가 높은 것을 우선
    .sort((a, b) => b.relevance - a.relevance || b.n.score - a.n.score);

  const out: ScoredNews[] = [];
  const seen = new Set<string>();
  for (const { n } of scored) {
    if (seen.has(n.link)) continue;
    seen.add(n.link);
    out.push(n);
    if (out.length >= limit) break;
  }
  return out;
}

export async function buildMarketDrivers(
  client: KiwoomClient,
  opts: { topN?: number } = {},
): Promise<MarketDriverReport> {
  const { topN = 5 } = opts;

  const watchNames = (await listWatchlist().catch(() => [])).map((w) => w.name);
  const [themeSection, sectorSection, news] = await Promise.all([
    getSection("themes", client).catch(() => null),
    getSection("sectors", client).catch(() => null),
    sectorNews({ majorOnly: true, perSector: 12, watchNames }),
  ]);

  // 모든 분야 기사를 한 통에 모아 두고 테마별로 골라 쓴다
  const allNews = news.sectors.flatMap((s) => s.items);

  const themes = (themeSection?.data ?? null) as Themes | null;
  const sectors = (sectorSection?.data ?? null) as Sectors | null;

  const attach = (t: ThemeRow): ThemeWithReason => ({
    code: t.code,
    name: t.name,
    changeRate: t.changeRate,
    stockCount: t.stockCount,
    mainStock: t.mainStock,
    reasons: findReasons(allNews, themeKeywords(t.name), mainStockNames(t.mainStock)),
  });

  const attachSector = (s: SectorRow, market: "코스피" | "코스닥"): SectorWithReason => ({
    code: s.code,
    name: s.name,
    changeRate: s.changeRate,
    market,
    reasons: findReasons(allNews, themeKeywords(s.name), []),
  });

  // 코스피·코스닥 업종을 합쳐 등락률 상위만
  const allSectors = [
    ...(sectors?.kospi ?? []).map((s) => attachSector(s, "코스피")),
    ...(sectors?.kosdaq ?? []).map((s) => attachSector(s, "코스닥")),
  ]
    .sort((a, b) => b.changeRate - a.changeRate)
    .slice(0, topN);

  return {
    fetchedAt: new Date().toISOString(),
    themes: {
      up: (themes?.top ?? []).slice(0, topN).map(attach),
      down: (themes?.bottom ?? []).slice(0, topN).map(attach),
    },
    sectors: allSectors,
  };
}
