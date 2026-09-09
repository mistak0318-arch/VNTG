/**
 * 조회순위 줄의 **버즈** — 뉴스 N회 · 텔레그램 N회, 그리고 눌렀을 때 펼칠 목록 (2026-09-09).
 *
 * 벤티지: "뉴스 N회, 텔레그램 N회 하고 누르면 우리 이미 긁고 있잖아. 그러니까 그거를
 * 이제 미니 창으로 보여주는 게 … 클릭하면 뉴스 볼 수 있게 해줘."
 *
 * 둘 다 **이미 있는 것**에서 센다.
 * - 뉴스: 네이버 뉴스 검색(종목명, 최신 100건, 5분 캐시)에서 **24시간 안**의 기사 수.
 *   같은 캐시를 종목 상세 뉴스 탭이 쓰므로 조회순위 20종목이 부하를 더하지 않는다 —
 *   같은 종목을 5분 안에 다시 물으면 네이버에 안 간다.
 * - 텔레그램: 채널 창고(31일 JSONL)를 **한 번만 훑어** 24시간 안 언급 수. 종목명과
 *   앞 네 글자(7자 이상일 때 — 「삼성전자」는 그대로, 「한화에어로스페이스」는 「한화에어」)
 *   로 잡는다. 채널 검색 화면과 같은 규칙이다.
 *
 * ## 24시간인 이유
 *
 * 조회순위는 **지금** 눈이 몰리는 종목이다. 「이 종목이 왜 지금 조회되나」에 답하려면
 * 오늘 나온 것을 세야지, 한 달치 뉴스 수는 대형주가 늘 크게 나와 아무 말도 안 한다.
 */
import { searchNews, type NewsItem } from "./newsDisclosure.js";
import { countMany, search, type StoreHit } from "./channelStore.js";

const WINDOW_MIN = 24 * 60;

export interface Buzz {
  code: string;
  /** 24시간 안 뉴스 수 (중복 제목·광고 제외). 못 세면 null */
  news: number | null;
  /** 24시간 안 텔레그램 언급 수. 못 세면 null */
  tg: number | null;
}

/** 채널 검색 화면과 같은 규칙 — 긴 이름은 앞 네 글자로도 잡는다 */
export function buzzWords(name: string): string[] {
  const n = name.replace(/\s+/g, "");
  const words = [name];
  if (n.length >= 7) words.push(n.slice(0, 4));
  return words;
}

/** 뉴스 수 캐시 — 검색 자체가 5분 캐시라 여기서는 계산만 아낀다 */
const newsCountCache = new Map<string, { at: number; n: number }>();
const NEWS_TTL = 5 * 60_000;

async function newsCount24h(name: string): Promise<number | null> {
  const hit = newsCountCache.get(name);
  if (hit && Date.now() - hit.at < NEWS_TTL) return hit.n;
  try {
    const items = await searchNews(name, { majorOnly: false, limit: 100 });
    const cutoff = Date.now() - WINDOW_MIN * 60_000;
    const n = items.filter((i) => i.publishedAt && new Date(i.publishedAt).getTime() >= cutoff).length;
    newsCountCache.set(name, { at: Date.now(), n });
    return n;
  } catch {
    return null;
  }
}

/** 텔레그램 수 — 종목 묶음 단위 캐시. 같은 20종목을 10초마다 물어도 창고는 5분에 한 번 */
let tgCache: { key: string; at: number; counts: Map<string, number> } | null = null;
const TG_TTL = 5 * 60_000;

async function tgCounts(stocks: { code: string; name: string }[]): Promise<Map<string, number> | null> {
  const key = stocks.map((s) => s.code).sort().join(",");
  if (tgCache && tgCache.key === key && Date.now() - tgCache.at < TG_TTL) return tgCache.counts;
  try {
    const counts = await countMany(
      stocks.map((s) => ({ key: s.code, words: buzzWords(s.name) })),
      WINDOW_MIN,
    );
    tgCache = { key, at: Date.now(), counts };
    return counts;
  } catch {
    return null;
  }
}

/**
 * 여러 종목의 버즈. 뉴스는 종목마다(캐시가 종목 단위), 텔레그램은 한 번에.
 * 뉴스 검색은 동시에 5개씩 — 네이버 검색 API 를 스무 개 한꺼번에 때리지 않는다.
 */
export async function buzzMany(stocks: { code: string; name: string }[]): Promise<Buzz[]> {
  const rows = stocks.slice(0, 40);
  const news: (number | null)[] = new Array(rows.length).fill(null);
  let i = 0;
  const worker = async () => {
    while (i < rows.length) {
      const k = i++;
      news[k] = await newsCount24h(rows[k].name);
    }
  };
  const [tg] = await Promise.all([tgCounts(rows), ...Array.from({ length: 5 }, worker)]);
  return rows.map((s, k) => ({
    code: s.code,
    news: news[k],
    tg: tg ? (tg.get(s.code) ?? 0) : null,
  }));
}

export interface BuzzDetail {
  code: string;
  name: string;
  /** 24시간 안 뉴스 — 최신순, 주요 언론사 여부는 항목의 `major` */
  news: NewsItem[];
  /** 24시간 안 텔레그램 글 — 최신순 */
  tg: StoreHit[];
  words: string[];
}

/** 눌렀을 때 펼칠 목록 */
export async function buzzDetail(code: string, name: string): Promise<BuzzDetail> {
  const cutoff = Date.now() - WINDOW_MIN * 60_000;
  const words = buzzWords(name);
  const [newsAll, tgRes] = await Promise.all([
    searchNews(name, { majorOnly: false, limit: 100 }).catch(() => [] as NewsItem[]),
    search(words, WINDOW_MIN).catch(() => null),
  ]);
  return {
    code,
    name,
    news: newsAll.filter((i) => i.publishedAt && new Date(i.publishedAt).getTime() >= cutoff).slice(0, 40),
    tg: (tgRes?.hits ?? []).slice(0, 60),
    words,
  };
}

/* ------------------------------------------------------------------ */
/* 새로 진입 — 직전 응답에 없던 종목                                     */
/* ------------------------------------------------------------------ */

/**
 * **어느 종목이 방금 들어왔나** (2026-09-09 — 벤티지 "삼 번은 네가 추천한 방법으로 하자").
 *
 * 순위 변동(±N)은 이미 목록에 있던 종목의 얘기다. 정작 보고 싶은 것은 **없다가 생긴**
 * 종목이다 — 눈이 새로 몰린 곳. 기준(30초·1분…)마다 마지막으로 본 스무 종목과 각각
 * **처음 본 시각**을 들고 있다가, 이번 응답에 없던 코드에 지금 시각을 찍는다. 목록에서
 * 빠지면 잊는다 — 다시 들어오면 다시 「새로」다.
 *
 * ⚠️ 서버가 막 떴을 때의 첫 응답은 **기준선**이다. 그때 스무 종목이 다 「새로」면 거짓말이다.
 * 메모리에만 두므로 재시작하면 기준선부터 다시 시작한다 — 그래도 되는 값이다.
 */
const seenByMode = new Map<string, Map<string, string | null>>();

export function markEntered(mode: string, codes: string[], now = new Date()): Map<string, string | null> {
  const prev = seenByMode.get(mode);
  const next = new Map<string, string | null>();
  const stamp = now.toISOString();
  for (const c of codes) {
    if (!prev) next.set(c, null); // 기준선 — 아무것도 새롭지 않다
    else next.set(c, prev.has(c) ? (prev.get(c) ?? null) : stamp);
  }
  seenByMode.set(mode, next);
  return next;
}
