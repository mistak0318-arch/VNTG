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
 * ── 카테고리 ──
 *
 * m-api(list?category=)가 받는 값은 **mainnews·flashnews·worldnews** 뿐이다
 * (2026-09-22 재탐침 12개: sise·market·company·stock·estate·economy… 전부 HTTP 400.
 * worldnews 는 200 이지만 오늘은 0건이라 안 쓴다).
 *
 * ⚠️ **PC 금융뉴스는 2026-09 개편으로 사라졌다** (2026-09-22 실측 — 벤티지: "시황 부동산
 * 이런것들은 아예 안 넘어오네 네이버 개편되면서 빠진건지").
 *
 *   finance.naver.com/news/news_list.naver?…section_id2=258  → 302 stock.naver.com/news/flashnews
 *   finance.naver.com/news/news_list.naver?…section_id2=260  → 302 stock.naver.com/news/flashnews
 *   finance.naver.com/news/mainnews.naver                    → 302 stock.naver.com/news/mainnews
 *
 * **세 갈래가 한 곳으로 간다.** 새 SPA 의 뉴스 갈래를 뽑아 보니 「뉴스 홈 · 실시간 속보 ·
 * 주요 뉴스 · 많이 본 뉴스 · 뉴스 포커스 · 해외 뉴스 · 공시」다 — 옛 `시황·전망(401)`,
 * `기업·종목(402)` 은 **네이버에서 없어진 갈래**라 되살릴 원본이 없다.
 *
 * 그래서 **news.naver.com 의 경제 섹션**으로 옮긴다(2026-09-22 실측, 전부 200 · 36건/쪽):
 *
 *   258 증권 · 259 금융 · 260 부동산 · 261 산업·재계 · 262 글로벌 경제
 *
 * 부동산(260)은 옛 탭과 **정확히 같은 갈래**다. 나머지는 없어진 잔가지 대신 그 위 줄기를
 * 쓴다 — 화면 라벨도 네이버 것에 맞춰 바꿨다(없는 갈래 이름을 달아 두면 거짓말이 된다).
 *
 * 얻은 것도 있다: 옛 PC 목록은 한 쪽 20건이었는데 여기는 **36건**이고, 요약·썸네일·언론사가
 * 다 온다. 잃은 것은 **정확한 시각** — 상대 표기("7분전"·"3시간전"·"3일전")뿐이다(아래 `agoToIso`).
 */
export type NaverCat = "main" | "flash" | "market" | "company" | "world" | "estate" | "money";

const M_API: Partial<Record<NaverCat, string>> = { main: "mainnews", flash: "flashnews" };
/** news.naver.com 경제(101)의 하위 분야 번호 */
const SECTION_SID2: Partial<Record<NaverCat, string>> = {
  market: "258", // 증권
  company: "261", // 산업·재계
  world: "262", // 글로벌 경제
  estate: "260", // 부동산
  money: "259", // 금융
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
    /* 섹션 API 의 썸네일 주소는 `?type&#x3D;nf220_150` 처럼 **16진수** 엔티티로 온다 (2026-09-22) */
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&([a-z]+);/g, (m, name: string) => NAMED[name] ?? m)
    .trim();
}

/**
 * **상대 시각 → ISO** (2026-09-22).
 *
 * 섹션 목록은 절대 시각을 안 준다 — `7분전`·`3시간전`·`3일전` 뿐이다(오래된 날짜 페이지까지
 * 확인했다). 기사를 하나씩 열어야 정확한 시각이 나오는데 목록 한 쪽에 36건이라 그럴 수 없다.
 *
 * 그래서 **받은 시점에서 되짚어 만든다.** 분 단위는 정확하고, 시간·일 단위는 그만큼 거칠다.
 * 목록이 이미 최신순이라 **순서는 안 틀어진다** — 「얼마나 새 기사냐」를 읽는 데 쓰는 값이다.
 */
function agoToIso(text: string, now = Date.now()): string {
  const t = text.replace(/\s/g, "");
  if (/^방금/.test(t)) return new Date(now).toISOString();
  const m = t.match(/^(\d+)(분|시간|일|주)전$/);
  if (m) {
    const n = Number(m[1]);
    const unit = { 분: 60_000, 시간: 3600_000, 일: 86_400_000, 주: 7 * 86_400_000 }[m[2]] ?? 0;
    return new Date(now - n * unit).toISOString();
  }
  /* 아주 오래된 기사는 `2026.09.18.` 로 온다 — 그 날 정오로 둔다(시각을 모른다) */
  const d = t.match(/^(\d{4})\.(\d{2})\.(\d{2})\.?$/);
  if (d) return `${d[1]}-${d[2]}-${d[3]}T12:00:00+09:00`;
  return "";
}

/** 목록 한 번치 — 기사들과 **다음 장 커서** */
interface SectionBatch {
  items: MainNewsItem[];
  cursor: string | null;
  hasNext: boolean;
}

/**
 * news.naver.com 경제 섹션 한 장 (2026-09-22 실측).
 *
 *   GET /section/template/SECTION_ARTICLE_LIST_FOR_LATEST?sid=101&sid2=260&sort=standard&pageNo=N[&next=커서]
 *   → { component, renderedComponent: { <이름>: "<html>" }, uhv }
 *
 * ⚠️ **`pageNo` 만으로는 안 넘어간다.** 커서 없이 pageNo 만 2·5·20 으로 바꿔 불러 봤더니
 * 매번 **같은 36건**이 왔다. 목록 껍데기의 `data-cursor` 를 다음 호출의 `next` 로 넘겨야
 * 진짜로 넘어간다 — 그렇게 5번 불러 180건, 겹침 0 을 확인했다.
 */
async function fetchSectionBatch(sid2: string, pageNo: number, next?: string): Promise<SectionBatch> {
  const url =
    `https://news.naver.com/section/template/SECTION_ARTICLE_LIST_FOR_LATEST?sid=101&sid2=${sid2}&sort=standard&pageNo=${pageNo}` +
    (next ? `&next=${encodeURIComponent(next)}` : "");
  const res = await fetch(url, {
    /* Referer 가 없으면 네이버가 빈 껍데기를 준다 */
    headers: { "user-agent": "Mozilla/5.0", referer: `https://news.naver.com/section/101` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { renderedComponent?: Record<string, string> | string };
  const rc = body.renderedComponent;
  const html = typeof rc === "string" ? rc : String(Object.values(rc ?? {})[0] ?? "");

  const now = Date.now();
  const items: MainNewsItem[] = [];
  for (const block of html.match(/<li class="sa_item[\s\S]*?<\/li>/g) ?? []) {
    /* 기사 링크. `article/comment/029/...`(댓글)은 세 자리 숫자가 아니라 안 걸린다 */
    const link = block.match(/href="(https:\/\/n\.news\.naver\.com\/article\/\d{3}\/\d+)"/);
    const title = block.match(/class="sa_text_strong"[^>]*>([\s\S]*?)<\/strong>/);
    if (!link || !title) continue;
    const lede = block.match(/class="sa_text_lede"[^>]*>([\s\S]*?)<\/div>/);
    const press = block.match(/class="sa_text_press"[^>]*>([\s\S]*?)<\/div>/);
    const when = block.match(/class="sa_text_datetime[^"]*"[^>]*>\s*<b>([\s\S]*?)<\/b>/);
    /* 썸네일은 지연 로딩이라 `src` 가 아니라 `data-src` 에 있다 */
    const thumb = block.match(/<img[^>]+data-src="([^"]+)"/);
    items.push({
      title: unescapeHtml(title[1].replace(/<[^>]+>/g, "")),
      summary: lede ? unescapeHtml(lede[1].replace(/<[^>]+>/g, "")).slice(0, 160) : "",
      thumb: thumb ? unescapeHtml(thumb[1]) : null,
      press: press ? unescapeHtml(press[1].replace(/<[^>]+>/g, "")) : "",
      link: link[1],
      at: when ? agoToIso(unescapeHtml(when[1]), now) : "",
    });
  }

  /* 목록 껍데기가 다음 장 커서를 들고 있다 */
  const meta = html.match(/class="section_latest_article _CONTENT_LIST[^"]*"([^>]*)>/);
  const attr = (n: string): string | null => (meta ? (meta[1].match(new RegExp(`${n}="([^"]*)"`)) ?? [])[1] ?? null : null);
  return { items, cursor: attr("data-cursor"), hasNext: attr("data-has-next") === "true" };
}

/**
 * 쪽 번호로 부르는 화면에 커서 목록을 맞춰 준다.
 *
 * 화면은 「← 이전 / 다음 →」으로 **한 칸씩만** 움직인다(MainNewsPanel). 그래서 갈래마다
 * 받아 둔 장을 순서대로 쌓아 두면, 다음 쪽 요청은 늘 **마지막 장의 커서 하나**로 끝난다.
 * 캐시가 식었거나 깊은 쪽을 바로 부르면 1장부터 걸어가되 **20장에서 멈춘다**(720건).
 */
const chainOf = new Map<string, { at: number; pages: SectionBatch[]; refreshing: Promise<void> | null }>();
const CHAIN_TTL = 5 * 60_000;
const MAX_PAGES = 20;

/** 커서를 따라 `want` 장까지 채운다 — 앞 장이 「다음 없음」이거나 빈 장이면 멈춘다 */
async function walk(sid2: string, want: number, pages: SectionBatch[]): Promise<void> {
  while (pages.length < want) {
    const prev = pages[pages.length - 1];
    if (prev && !prev.hasNext) break;
    const got = await fetchSectionBatch(sid2, pages.length + 1, prev?.cursor ?? undefined);
    if (got.items.length === 0) break;
    pages.push(got);
  }
}

/*
 * **식어도 옛 장을 먼저 준다** (2026-09-23 — 벤티지: "뉴스 … 갑자기 로딩이 엄청 느렸었다").
 * 전엔 5분이 지나면 장을 버리고 1장부터 다시 걸었다 — 8쪽을 보고 있었으면 그 새로고침 한 번에 네이버를
 * 여덟 번 순서대로(장당 0.3~0.5초) 불러 몇 초가 걸렸고, 그게 5분마다 한 번씩 「갑자기」였다.
 * 이제 식으면 옛 장을 그대로 주고 **뒤에서** 같은 깊이까지 새로 걸어 바꿔 끼운다. 못 받으면 옛 장이 남는다.
 */
async function fetchSection(sid2: string, page: number): Promise<{ items: MainNewsItem[]; hasMore: boolean }> {
  const want = Math.max(1, Math.min(page, MAX_PAGES));
  let chain = chainOf.get(sid2);
  if (!chain) {
    chain = { at: Date.now(), pages: [], refreshing: null };
    chainOf.set(sid2, chain);
  }
  if (Date.now() - chain.at >= CHAIN_TTL && chain.pages.length > 0 && !chain.refreshing) {
    const c = chain;
    const depth = Math.max(c.pages.length, want);
    c.refreshing = (async () => {
      const fresh: SectionBatch[] = [];
      await walk(sid2, depth, fresh);
      if (fresh.length > 0) {
        c.pages = fresh;
        c.at = Date.now();
      }
    })()
      .catch(() => undefined)
      .finally(() => {
        c.refreshing = null;
      });
  }
  if (chain.pages.length === 0) chain.at = Date.now(); // 처음(또는 빈 채 식음) — 지금부터 5분
  await walk(sid2, want, chain.pages);
  const hit = chain.pages[want - 1];
  if (!hit) return { items: [], hasMore: false };
  return { items: hit.items, hasMore: hit.hasNext && want < MAX_PAGES };
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
      : await fetchSection(SECTION_SID2[cat]!, page);
    if (got.items.length > 0) cacheMap.set(key, { at: Date.now(), ...got });
    if (cacheMap.size > 60) {
      const first = cacheMap.keys().next().value;
      if (first) cacheMap.delete(first);
    }
    /*
     * ⚠️ **빈 1쪽은 성공이 아니다** (2026-09-22).
     *
     * 이 화면이 한 달 가까이 조용히 비어 있었던 까닭이 여기다. 네이버가 개편돼 파서가 0건을
     * 뱉는데도 HTTP 는 200 이라 `ok` 로 기록됐다 — 그날 계기판은 `naver ok 1507 · failed 0`,
     * `news:market 140건` 이었다. **호출은 다 성공인데 기사가 0건**이니 아무 데도 안 걸린다.
     * 1쪽이 비면 `failed` 로 적는다. 뒷쪽이 비는 건 바닥에 닿은 것이라 정상이다.
     */
    void recordApiCall("naver", `news:${cat}`, page === 1 && got.items.length === 0 ? "failed" : "ok");
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
