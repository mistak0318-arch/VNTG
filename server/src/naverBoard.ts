import { recordApiCall } from "./apiUsage.js";

/**
 * **네이버 종목토론실** (2026-09-09).
 *
 * 벤티지: "각 종목들 클릭하면 나오는 거 종목상세 마지막 탭에 네이버 종목토론실 연결해서
 * 보여줄 수 있나?"
 *
 * ## 어디서 가져오나 — HTML 이 아니라 JSON 이다
 *
 * `finance.naver.com/item/board.naver` 는 목록만 HTML 로 주고 **본문은 iframe** 안에
 * 있다(그 안쪽은 자바스크립트라 긁어도 빈 껍데기다). 그 iframe 이 실제로 부르는 것을
 * 따라가면 JSON API 가 나온다:
 *
 *   GET m.stock.naver.com/front-api/discussion/list
 *       ?discussionType=domesticStock&itemCode=000660&size=20[&offset=…]
 *
 * 실측(2026-09-09, SK하이닉스): 한 번에 20건, **본문까지 같이** 온다. 목록만 긁고 본문을
 * 다시 부르는 짓을 안 해도 되므로 호출이 스무 배 적다. 파라미터를 틀리면 서버가
 * **뭘 틀렸는지 이름으로 알려 준다**(`discussionType` 은 domesticStock/foreignStock…).
 *
 * ## 쓰는 값
 *
 *   · `contentSwReplaced` 본문(줄바꿈이 `<br>`) — 태그는 우리가 털어서 글자만 넘긴다
 *   · `isHolderVerified` **주주 인증** — 실제로 들고 있는 사람인지. 이 판에서 유일하게
 *     값이 있는 표식이라 화면에서 따로 표시한다
 *   · `isCleanbotPassed` 네이버 클린봇이 거른 글
 *   · `replyDepth`/`parentId` 답글 — 원글만 볼 수 있게 깊이를 넘긴다
 *   · `viewCount`·`recommendCount`·`notRecommendCount`
 *
 * ## 예의
 *
 * **화면이 열려 있을 때만** 부른다. 배경에서 도는 수집기를 두지 않는다 — 종목이 3,900개고
 * 토론실은 분 단위로 바뀌어서, 미리 쌓으려 들면 그 순간 크롤러가 된다. 같은 종목은
 * 30초 캐시로 묶는다(사람이 연달아 눌러도 한 번만 나간다).
 */

const BASE = "https://m.stock.naver.com/front-api/discussion/list";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const TTL_MS = 30_000;

export interface BoardPost {
  id: string;
  title: string;
  /** 본문 — 태그를 턴 글자만. 없을 수도 있다(제목만 쓴 글) */
  body: string;
  writer: string;
  /** 주주 인증 — 실제로 이 종목을 들고 있는 계정 */
  holder: boolean;
  at: string;
  views: number;
  good: number;
  bad: number;
  /** 답글이면 1 이상 */
  depth: number;
  /** 클린봇이 거른 글 */
  filtered: boolean;
  images: number;
  /** 네이버에서 열기 */
  link: string;
}

export interface BoardPage {
  posts: BoardPost[];
  /** 다음 쪽을 부를 때 그대로 넘긴다. 없으면 끝 */
  next: string | null;
  error?: string;
}

interface RawPost {
  id?: string;
  title?: string;
  contentSwReplaced?: string;
  contentSwReplacedButImg?: string;
  writer?: { nickname?: string; isHolderVerified?: boolean };
  writtenAt?: string;
  viewCount?: number;
  recommendCount?: number;
  notRecommendCount?: number;
  replyDepth?: number;
  isCleanbotPassed?: boolean;
  imageCount?: number;
}

/**
 * `<br>` 만 줄바꿈으로 살리고 나머지 태그는 턴다.
 *
 * 본문을 HTML 그대로 넘기면 화면에서 `dangerouslySetInnerHTML` 을 써야 하는데,
 * **남이 쓴 글**이다. 글자만 넘기면 그 걱정이 통째로 사라진다.
 */
function plain(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    /* &amp; 는 맨 나중이다 — 먼저 풀면 &amp;lt; 가 < 로 두 번 풀린다 */
    .replace(/&amp;/g, "&")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const cache = new Map<string, { at: number; page: BoardPage }>();

/** 캐시가 커지지 않게 — 넣을 때마다 묵은 것을 턴다 (2026-09-09 재검토에서 잡힘: 무한히 자라고 있었다) */
function prune(): void {
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at >= TTL_MS) cache.delete(k);
}

export async function naverBoard(code: string, offset?: string): Promise<BoardPage> {
  /* 코드가 비면 네이버까지 안 간다 — `itemCode=` 로 나가던 헛호출 (재검토에서 잡힘) */
  if (!/^\d{6}$/.test(code)) return { posts: [], next: null, error: "종목코드가 아닙니다" };
  const key = `${code}|${offset ?? ""}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.page;
  prune();

  const url =
    `${BASE}?discussionType=domesticStock&itemCode=${encodeURIComponent(code)}&size=20` +
    (offset ? `&offset=${encodeURIComponent(offset)}` : "");

  try {
    const res = await fetch(url, {
      headers: {
        "user-agent": UA,
        /* 이 두 줄이 없으면 네이버가 400 을 준다 — 자기 화면에서 온 요청만 받는다 */
        referer: `https://m.stock.naver.com/pc/domestic/stock/${code}/discussion`,
        accept: "application/json",
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      void recordApiCall("naver", "discussion", "failed");
      /* 실패도 30초 기억한다 — 막힌 네이버를 탭 누를 때마다 다시 때리면 그게 곧 예의 없음이다 */
      const page: BoardPage = { posts: [], next: null, error: `네이버 응답 ${res.status}` };
      cache.set(key, { at: Date.now(), page });
      return page;
    }
    const j = (await res.json()) as {
      isSuccess?: boolean;
      result?: { posts?: RawPost[]; lastOffset?: string };
    };
    void recordApiCall("naver", "discussion", "ok");

    const raw = j.result?.posts ?? [];
    const posts: BoardPost[] = raw.map((p) => ({
      id: String(p.id ?? ""),
      title: plain(String(p.title ?? "")),
      body: plain(String(p.contentSwReplaced ?? p.contentSwReplacedButImg ?? "")),
      writer: String(p.writer?.nickname ?? "").trim() || "익명",
      holder: Boolean(p.writer?.isHolderVerified),
      at: String(p.writtenAt ?? ""),
      views: Number(p.viewCount) || 0,
      good: Number(p.recommendCount) || 0,
      bad: Number(p.notRecommendCount) || 0,
      depth: Number(p.replyDepth) || 0,
      filtered: p.isCleanbotPassed === false,
      images: Number(p.imageCount) || 0,
      link: `https://m.stock.naver.com/pc/domestic/stock/${code}/discussion/${String(p.id ?? "")}`,
    }));

    /*
     * 끝인지 아닌지. 스무 건이 꽉 안 찼으면 더 없다 — `lastOffset` 은 마지막 글 번호라
     * 마지막 쪽에서도 값이 오기 때문에, 그것만 믿으면 빈 쪽을 계속 부른다.
     */
    const next = posts.length >= 20 ? (j.result?.lastOffset ?? null) : null;
    const page: BoardPage = { posts, next };
    cache.set(key, { at: Date.now(), page });
    return page;
  } catch (e) {
    void recordApiCall("naver", "discussion", "failed");
    return {
      posts: [],
      next: null,
      error: e instanceof Error ? e.message : "네이버 종목토론실을 못 불렀습니다",
    };
  }
}
