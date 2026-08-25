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

let cache: { at: number; items: MainNewsItem[] } = { at: 0, items: [] };
const TTL = 5 * 60_000;

function toIso(dt: string): string {
  if (!/^\d{14}$/.test(dt)) return "";
  return `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}T${dt.slice(8, 10)}:${dt.slice(10, 12)}:${dt.slice(12, 14)}+09:00`;
}

export async function mainNews(size = 20): Promise<MainNewsItem[]> {
  if (Date.now() - cache.at < TTL && cache.items.length >= size) return cache.items.slice(0, size);
  try {
    /*
     * ⚠️ 항상 40개를 받아 캐시한다. 요청 크기대로 받으면 **첫 요청이 4개였을 때
     * 캐시가 4개로 굳어서** 다음 5분간 24개를 달라 해도 4개만 나간다 — 실제로 그랬다.
     */
    const res = await fetch(
      `https://m.stock.naver.com/api/news/list?category=mainnews&page=1&pageSize=40`,
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
        link:
          r.oid && r.aid ? `https://n.news.naver.com/article/${r.oid}/${r.aid}` : "",
        at: toIso(String(r.dt ?? "")),
      }))
      .filter((x) => x.title && x.link);
    if (items.length > 0) cache = { at: Date.now(), items };
    void recordApiCall("naver", "mainNews", "ok");
    return items.slice(0, size);
  } catch (e) {
    void recordApiCall("naver", "mainNews", "failed");
    // 못 받으면 지난 캐시라도 — 뉴스가 5분 늦는 건 문제가 아니다
    if (cache.items.length > 0) return cache.items.slice(0, size);
    throw e;
  }
}
