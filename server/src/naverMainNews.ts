import { recordApiCall } from "./apiUsage.js";

/**
 * 네이버 증권 **주요뉴스** (2026-08-25 실측).
 *
 *   GET https://m.stock.naver.com/api/news/list?category=mainnews&page=1&pageSize=N
 *   → [{ tit, subcontent, thumbUrl, oid, aid, ohnm(매체), dt(YYYYMMDDHHmmss) }]
 *
 * 네이버 검색 API 뉴스와 뭐가 다른가 —
 *   · **사람(편집자)이 고른 목록**이다. 검색은 우리가 검색어로 긁는 것이고,
 *     이건 네이버 증권 첫 화면에 걸리는 그 주요뉴스다.
 *   · **썸네일이 있다.** 검색 API 는 이미지를 안 준다 — 「너무 텍스트」 문제의 답.
 *
 * 인증이 없다(모바일 증권 공개 API — ETF 구성종목과 같은 출처). 5분 캐시.
 * 원문 링크는 oid/aid 로 조립한다: https://n.news.naver.com/article/{oid}/{aid}
 */

export interface MainNewsItem {
  title: string;
  summary: string;
  /** 썸네일 — 없을 수 있다(텍스트 기사) */
  thumb: string | null;
  press: string;
  link: string;
  /** "20260825184107" → ISO */
  at: string;
}

/*
 * ── 카테고리 (2026-08-26 확장·전부 실측) ──
 *
 * m-api(list?category=)가 받는 값은 mainnews·flashnews·ranknews 뿐이다(후보 11개
 * 탐침). 시황·전망/기업·종목/해외증시/부동산은 **PC 금융뉴스**(news_list.naver,
 * EUC-KR HTML)의 section_id2 로만 있다 — 기사 표본으로 판별했다:
 *
 *   258 시황·전망 · 402 기업·종목분석(마윈·프로그램 매물) ·
 *   403 해외증시(뉴욕증시) · 260 부동산(종부세·주담대)
 *
 * PC 목록도 썸네일(thumb70)·요약·매체·시각을 다 준다. 한 쪽 20건, page 파라미터로
 * 뒤 페이지를 넘긴다(m-api 도 page 를 받는다).
 */
export type NaverCat = "main" | "flash" | "market" | "company" | "world" | "estate";

const M_API: Partial<Record<NaverCat, string>> = { main: "mainnews", flash: "flashnews" };
const PC_SECTION: Partial<Record<NaverCat, string>> = {
  market: "258",
  company: "402",
  world: "403",
  estate: "260",
};

const cacheMap = new Map<string, { at: number; items: MainNewsItem[]; hasMore: boolean }>();
const TTL = 5 * 60_000;

/** EUC-KR HTML 에 섞여 오는 엔티티 — 제목에 그대로 남으면 「&quot;」가 화면에 찍힌다 */
function unescapeHtml(s: string): string {
  const NAMED: Record<string, string> = {
    quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " ", hellip: "…", middot: "·",
    lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", uarr: "↑", darr: "↓", rarr: "→", larr: "←",
  };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&([a-z]+);/g, (m, name: string) => NAMED[name] ?? m)
    .trim();
}

/*
 * PC 금융뉴스의 쪽 넘김은 **날짜 단위**다 (2026-08-26 실측) —
 * `date=YYYYMMDD&page=N` 이고, page 는 그 날짜 안에서만 돈다. date 없이 page=2 를
 * 넣으면 빈 목록이 온다(자정 직후 실측: 오늘 1쪽뿐, 어제는 46쪽). 그래서 화면의
 * 「전역 쪽 번호」는 오늘부터 날짜를 거슬러 걸으며 날짜별 쪽수를 세어 맞춘다.
 */

/** KST 기준 back 일 전 날짜 — 서버가 어느 시간대에 있든 네이버(한국 날짜)와 맞아야 한다 */
function kstDate(back: number): string {
  return new Date(Date.now() + 9 * 3600_000 - back * 86_400_000)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "");
}

/** 날짜+쪽 하나의 캐시. 지난 날짜는 내용이 안 바뀌니 오래 들고 있는다 */
const pcPageCache = new Map<string, { at: number; items: MainNewsItem[]; maxPage: number }>();

/** PC 금융뉴스 한 쪽 파서 — thumb·제목·요약·매체·시각 + 그 날짜의 총 쪽수 */
async function fetchPcPage(
  sectionId2: string,
  date: string,
  page: number,
): Promise<{ items: MainNewsItem[]; maxPage: number }> {
  const key = `${sectionId2}:${date}:${page}`;
  const hit = pcPageCache.get(key);
  const ttl = date === kstDate(0) ? TTL : 12 * 3600_000;
  if (hit && Date.now() - hit.at < ttl) return hit;

  const res = await fetch(
    `https://finance.naver.com/news/news_list.naver?mode=LSS2D&section_id=101&section_id2=${sectionId2}&date=${date}&page=${page}`,
    { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const html = new TextDecoder("euc-kr").decode(await res.arrayBuffer());

  const items: MainNewsItem[] = [];
  /*
   * 기사 하나 = (썸네일 dt 는 있을 수도) + articleSubject(제목·링크) + articleSummary
   * (요약 + press + wdate). subject 를 닻으로 잡고 앞뒤에서 줍는다.
   */
  const re =
    /(?:<dt class="thumb">\s*<a[^>]*><img src="([^"]+)"[\s\S]{0,200}?)?<dd class="articleSubject">\s*<a href="[^"]*article_id=(\d+)&office_id=(\d+)[^"]*"[^>]*title="([^"]+)"[\s\S]*?<dd class="articleSummary">\s*([\s\S]*?)<span class="press">([^<]+)<\/span>[\s\S]*?<span class="wdate">([^<]+)<\/span>/g;
  for (const m of html.matchAll(re)) {
    const [, thumb, articleId, officeId, tit, summaryRaw, press, wdate] = m;
    items.push({
      title: unescapeHtml(tit),
      summary: unescapeHtml(summaryRaw.replace(/<[^>]+>/g, "")).slice(0, 160),
      thumb: thumb || null,
      press: unescapeHtml(press),
      link: `https://n.news.naver.com/article/${officeId}/${articleId}`,
      at: /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(wdate.trim())
        ? `${wdate.trim().replace(" ", "T")}:00+09:00`
        : "",
    });
  }

  /*
   * 그 날짜의 총 쪽수 — 페이지 내비(Nnavi) 안의 쪽 번호 최댓값(「맨뒤」 링크 포함).
   * 기사가 적은 날은 Nnavi 자체가 없다 → 1쪽. 본문 전체에서 page= 를 세면
   * 기사 링크의 page=1 같은 게 섞이므로 **Nnavi 구간만** 본다.
   */
  let maxPage = 1;
  const navAt = html.indexOf('class="Nnavi"');
  if (navAt >= 0) {
    // 링크가 `&amp;page=2` 로 이스케이프돼 있다 — [?&] 를 앞에 걸면 하나도 안 잡힌다(실측)
    const nav = html.slice(navAt, html.indexOf("</table>", navAt) + 8);
    for (const m of nav.matchAll(/page=(\d+)/g)) maxPage = Math.max(maxPage, Number(m[1]));
  }

  const out = { at: Date.now(), items, maxPage };
  pcPageCache.set(key, out);
  if (pcPageCache.size > 300) {
    const first = pcPageCache.keys().next().value;
    if (first) pcPageCache.delete(first);
  }
  return out;
}

/** 전역 쪽 번호 → (날짜, 그 날짜 안의 쪽)으로 풀어 걷는다 */
async function fetchPcSection(
  sectionId2: string,
  page: number,
): Promise<{ items: MainNewsItem[]; hasMore: boolean }> {
  let skip = page - 1;
  // 3주면 충분히 깊다 — 뉴스 화면에서 그 뒤까지 넘겨 볼 일은 없다
  for (let back = 0; back < 21; back++) {
    const date = kstDate(back);
    const first = await fetchPcPage(sectionId2, date, 1);
    if (first.items.length === 0) continue; // 기사가 없는 날(연휴 등)은 건너뛴다
    const pages = Math.max(1, first.maxPage);
    if (skip >= pages) {
      skip -= pages;
      continue;
    }
    const target = skip === 0 ? first : await fetchPcPage(sectionId2, date, skip + 1);
    // 지난 날짜는 늘 더 있다 — 벽(21일)에 닿기 전까지는 다음 쪽이 있다고 본다
    return { items: target.items, hasMore: true };
  }
  return { items: [], hasMore: false };
}

function toIso(dt: string): string {
  if (!/^\d{14}$/.test(dt)) return "";
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(8, 10)}:${dt.slice(10, 12)}:${dt.slice(12, 14)}+09:00`;
}

/** m-api (주요뉴스·속보) — 썸네일 포함, page 단위 */
async function fetchMApi(category: string, page: number): Promise<{ items: MainNewsItem[]; hasMore: boolean }> {
  const res = await fetch(
    `https://m.stock.naver.com/api/news/list?category=${category}&page=${page}&pageSize=20`,
    { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) },
  );
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rows = (await res.json()) as Record<string, unknown>[];
  const items: MainNewsItem[] = rows
    .map((r) => ({
      title: String(r.tit ?? "").trim(),
      summary: String(r.subcontent ?? "").trim(),
      thumb: typeof r.thumbUrl === "string" && r.thumbUrl ? r.thumbUrl : null,
      press: String(r.ohnm ?? ""),
      link: r.oid && r.aid ? `https://n.news.naver.com/article/${r.oid}/${r.aid}` : "",
      at: toIso(String(r.dt ?? "")),
    }))
    .filter((x) => x.title && x.link);
  return { items, hasMore: rows.length >= 20 };
}

/**
 * 네이버 뉴스 — 카테고리·페이지 단위. 5분 캐시(카테고리+페이지별).
 * 실패하면 지난 캐시라도 — 뉴스가 5분 늦는 건 문제가 아니다.
 */
export async function naverNews(
  cat: NaverCat,
  page = 1,
): Promise<{ items: MainNewsItem[]; hasMore: boolean }> {
  const key = `${cat}:${page}`;
  const hit = cacheMap.get(key);
  if (hit && Date.now() - hit.at < TTL) return { items: hit.items, hasMore: hit.hasMore };
  try {
    const got = M_API[cat]
      ? await fetchMApi(M_API[cat]!, page)
      : await fetchPcSection(PC_SECTION[cat]!, page);
    if (got.items.length > 0) cacheMap.set(key, { at: Date.now(), ...got });
    if (cacheMap.size > 60) {
      const first = cacheMap.keys().next().value;
      if (first) cacheMap.delete(first);
    }
    void recordApiCall("naver", `news:${cat}`, "ok");
    return got;
  } catch (e) {
    void recordApiCall("naver", `news:${cat}`, "failed");
    if (hit) return { items: hit.items, hasMore: hit.hasMore };
    throw e;
  }
}

/** 예전 이름 유지 — 주요뉴스 1쪽 */
export async function mainNews(size = 20): Promise<MainNewsItem[]> {
  return (await naverNews("main", 1)).items.slice(0, size);
}
