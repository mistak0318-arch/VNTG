import { recordApiCall } from "./apiUsage.js";
import { peekSnapshot } from "./marketSnapshot.js";

/**
 * **네이버 증권(개편판) 에서 가져오는 넷** (2026-09-16).
 *
 * 벤티지: "네이버 증권이 개편됐거든 … 우리한테 넣으면 좋을 만한 기능이 있는지 분석해 줘" → 선택지에서 넷 다.
 * stock.naver.com 은 자바스크립트 앱이고 화면 뒤에서 `stock.naver.com/api/...` 를 부른다. 번들 116개를 훑어
 * 경로를 뽑고, **로그인 없이 되는 것**만 골랐다:
 *
 *   ① 해외 인기 종목      GET  stockSecurity/aggregate/foreignPopularStock?size=       — 네이버 사용자가 많이 본 미국 종목
 *   ② 증시자금동향        GET  domestic/market/trendDeposit?startIdx=&pageSize=       — 고객예탁금·신용잔고·펀드(억원)
 *   ③ 시장 캘린더         POST marketCalendars/v1/events/search {codes,from,to,myStocksOnly,category}
 *                              category: economicIndicators · expiration · dividends · ipo
 *   ④ 리서치              GET  stockSecurity/researches/v2/{company/goal-price-changed?direction= ·
 *                              industry/industries · weekly-hot?startDate= · latestResearch?size=}
 *
 * ⚠️ **공식 API 가 아니다.** 9/15 에 네이버 테마 주소가 말없이 바뀐 것처럼 언제든 바뀐다. 그래서 전부
 * **캐시 + 옛 값 버티기**다 — 못 받으면 마지막으로 받은 값을 `stale` 표시와 함께 돌려주고, 처음부터 못 받으면
 * 빈 값. 화면은 「네이버에서 못 받음」이라고만 적는다. 한 번에 한 요청, 15초 제한.
 */

const BASE = "https://stock.naver.com/api/";
const HEADERS = { "User-Agent": "Mozilla/5.0", Referer: "https://stock.naver.com/" };

async function naver<T>(path: string, feature: string, init?: { body: unknown }): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15_000);
  try {
    const res = await fetch(BASE + path, {
      method: init ? "POST" : "GET",
      headers: init ? { ...HEADERS, "Content-Type": "application/json" } : HEADERS,
      body: init ? JSON.stringify(init.body) : undefined,
      signal: ctl.signal,
    });
    if (!res.ok) {
      void recordApiCall("naver", feature, res.status === 429 ? "rateLimited" : "failed", undefined, `HTTP ${res.status}`);
      throw new Error(`네이버 ${feature} ${res.status}`);
    }
    void recordApiCall("naver", feature, "ok");
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** 캐시 — 신선하면 그대로, 낡았으면 새로 받고, 못 받으면 옛 값에 stale 을 붙인다 */
const store = new Map<string, { at: number; data: unknown }>();
/** 「비어 있다」 — 배열이 비었거나, 물건인데 배열 칸이 전부 비었거나(리서치처럼 칸이 여럿인 것) */
function isEmptyPayload(v: unknown): boolean {
  if (Array.isArray(v)) return v.length === 0;
  if (v && typeof v === "object") {
    const arrs = Object.values(v as Record<string, unknown>).filter(Array.isArray);
    if (arrs.length > 0) return arrs.every((a) => (a as unknown[]).length === 0);
    const objs = Object.values(v as Record<string, unknown>).filter((x) => x && typeof x === "object");
    if (objs.length > 0) return objs.every(isEmptyPayload);
  }
  return v === null || v === undefined;
}

/**
 * 캐시 + 옛 값 버티기.
 *
 * ⚠️ **빈 성공 응답도 옛 값을 못 덮는다** (2026-09-16 점검). 예외만 막고 있었는데, 네이버는 잠깐 빈 배열을
 * 200 으로 주는 일이 있다(9/15 테마가 그렇게 지워졌다). 옛 값이 있으면 그것을 `stale` 로 돌려주고, 처음부터
 * 비었으면 빈 값을 그대로 준다 — 「없다」와 「못 받았다」는 다르지만 첫 응답이 빈 건 가릴 방법이 없다.
 */
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<{ data: T; at: number; stale: boolean }> {
  const hit = store.get(key) as { data: T; at: number } | undefined;
  if (hit && Date.now() - hit.at < ttlMs) return { data: hit.data, at: hit.at, stale: false };
  try {
    const data = await fn();
    if (hit && isEmptyPayload(data) && !isEmptyPayload(hit.data)) {
      console.warn(`[naver] ${key} — 빈 응답이라 옛 값을 지킨다`);
      return { data: hit.data, at: hit.at, stale: true };
    }
    store.set(key, { data, at: Date.now() });
    /* 날짜가 든 열쇠(cal:…, npay:…)가 끝없이 쌓이지 않게 */
    if (store.size > 200) {
      const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 50);
      for (const [k] of oldest) store.delete(k);
    }
    return { data, at: Date.now(), stale: false };
  } catch (err) {
    if (hit) return { data: hit.data, at: hit.at, stale: true };
    throw err;
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};
const stripHtml = (s: unknown) =>
  String(s ?? "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

/* ------------------------------------------------------------------ */
/* ① 해외 인기 종목 — 시세분석(해외) 「인기」 탭                           */
/* ------------------------------------------------------------------ */

export interface PopularUsRow {
  rank: number;
  prevRank: number | null;
  /** 조회 수(네이버 사용자) */
  hits: number | null;
  symbol: string;
  reuters: string;
  name: string;
  exchange: string;
  kind: string;
  price: number | null;
  change: number | null;
  rate: number | null;
  volume: number | null;
  value: number | null;
  cap: number | null;
  industry: string | null;
  over: { session: "pre" | "after"; price: number | null; rate: number | null } | null;
}

export async function usPopular(size = 40): Promise<{ rows: PopularUsRow[]; at: number; stale: boolean }> {
  const r = await cached(`usPopular:${size}`, 60_000, async () => {
    const j = await naver<{ items?: Record<string, unknown>[] }>(`stockSecurity/aggregate/foreignPopularStock?size=${size}`, "usPopular");
    return (j.items ?? []).map((it): PopularUsRow => {
      const p = (it.price ?? {}) as Record<string, unknown>;
      const om = p.overMarketPriceInfo as { tradingSessionType?: string; currentPrice?: unknown; changeRate?: unknown } | undefined;
      const session = om?.tradingSessionType ? (/PRE/i.test(om.tradingSessionType) ? "pre" : /AFTER/i.test(om.tradingSessionType) ? "after" : null) : null;
      const ex = String(p.exchangeCode ?? "");
      return {
        rank: num(it.ranking) ?? 0,
        prevRank: num(it.previousRanking),
        hits: num(it.hitCount),
        symbol: String(p.symbolCode ?? it.itemCode ?? ""),
        reuters: String(p.itemCode ?? it.itemCode ?? ""),
        name: String(p.itemName ?? ""),
        exchange: ex === "NASDAQ" || ex === "NYSE" || ex === "AMEX" ? ex : ex || "기타",
        kind: String(p.stockEndType ?? "stock"),
        price: num(p.currentPrice),
        change: num(p.changePrice),
        rate: num(p.changeRate),
        volume: num(p.tradingVolume),
        value: num(p.tradingValue),
        cap: num(p.marketCap),
        industry: p.sectorName ? String(p.sectorName) : null,
        over: session ? { session, price: num(om?.currentPrice), rate: num(om?.changeRate) } : null,
      };
    });
  });
  return { rows: r.data, at: r.at, stale: r.stale };
}

/* ------------------------------------------------------------------ */
/* ② 증시자금동향 — 억원                                                */
/* ------------------------------------------------------------------ */

export interface DepositDay {
  date: string;
  /** 고객예탁금 */
  deposit: number | null;
  depositDiff: number | null;
  /** 신용잔고(신용융자) */
  credit: number | null;
  creditDiff: number | null;
  /** 수익증권 — 주식형·채권형·혼합형 펀드 */
  fundStock: number | null;
  fundBond: number | null;
  fundMixed: number | null;
}

export async function depositTrend(days = 60): Promise<{ days: DepositDay[]; at: number; stale: boolean }> {
  /* 하루 한 번 바뀌는 값(전 영업일 기준) — 한 시간 캐시 */
  const r = await cached(`deposit:${days}`, 3600_000, async () => {
    const j = await naver<{ content?: Record<string, unknown>[] }>(`domestic/market/trendDeposit?startIdx=0&pageSize=${days}`, "depositTrend");
    return (j.content ?? [])
      .map((c) => ({
        date: String(c.bizdate ?? "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
        deposit: num(c.customerDeposit),
        depositDiff: num(c.customerDepositDiff),
        credit: num(c.creditLoan),
        creditDiff: num(c.creditLoanDiff),
        fundStock: num(c.beneficiaryCertificateStock),
        fundBond: num(c.beneficiaryCertificateBond),
        fundMixed: num(c.beneficiaryCertificateMixing),
      }))
      .filter((d) => d.date.length === 10)
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  });
  return { days: r.data, at: r.at, stale: r.stale };
}

/* ------------------------------------------------------------------ */
/* ③ 시장 캘린더 — 경제지표 · 만기 · 배당 · 공모주                         */
/* ------------------------------------------------------------------ */

export type CalCategory = "economicIndicators" | "expiration" | "dividends" | "ipo";
const CAL_CATS: CalCategory[] = ["economicIndicators", "expiration", "dividends", "ipo"];

export interface CalEvent {
  date: string;
  category: CalCategory;
  /** USA · KOR … 모르면 null */
  nation: string | null;
  title: string;
  /** 「21:30 예정」 같은 한국 시각 — 경제지표만 */
  time: string | null;
  /** 시장 영향력 — 「매우 높음」 · 「높음」 … */
  impact: string | null;
  info: { label: string; value: string; badge: string | null }[];
  /** 종목코드(배당·공모) 또는 지표 코드 */
  code: string | null;
}

export async function marketCalendar(from: string, to: string): Promise<{ events: CalEvent[]; at: number; stale: boolean; more: Record<string, number> }> {
  const r = await cached(`cal:${from}:${to}`, 30 * 60_000, async () => {
    const events: CalEvent[] = [];
    const more: Record<string, number> = {};
    for (const category of CAL_CATS) {
      const j = await naver<{ dateGroups?: { date: string; totalCount?: string; events?: Record<string, unknown>[] }[] }>(
        "marketCalendars/v1/events/search",
        "marketCalendar",
        { body: { codes: [], from, to, myStocksOnly: false, category } },
      );
      for (const g of j.dateGroups ?? []) {
        const got = g.events ?? [];
        const total = num(g.totalCount) ?? got.length;
        if (total > got.length) more[`${g.date}:${category}`] = total - got.length;
        for (const e of got) {
          const sub = String(e.subtitle ?? "");
          const pk = e.productKey as { itemCode?: string } | undefined;
          events.push({
            date: g.date,
            category,
            nation: e.nationType ? String(e.nationType) : null,
            title: String(e.title ?? ""),
            time: sub.match(/(\d{1,2}:\d{2})/)?.[1] ?? null,
            impact: sub.match(/영향력\s*([가-힣 ]+)/)?.[1]?.trim() ?? null,
            info: ((e.information as { label?: string; value?: string; badge?: string | null }[] | undefined) ?? []).map((x) => ({
              label: String(x.label ?? ""),
              value: String(x.value ?? ""),
              badge: x.badge ?? null,
            })),
            code: pk?.itemCode ?? null,
          });
        }
      }
    }
    events.sort((a, b) => (a.date === b.date ? (a.time ?? "99").localeCompare(b.time ?? "99") : a.date < b.date ? -1 : 1));
    return { events, more };
  });
  return { events: r.data.events, more: r.data.more, at: r.at, stale: r.stale };
}

/* ------------------------------------------------------------------ */
/* ④ 리서치 보드                                                        */
/* ------------------------------------------------------------------ */

export interface GoalChange {
  code: string;
  name: string;
  broker: string;
  title: string;
  goal: number | null;
  prevGoal: number | null;
  diffRate: number | null;
  date: string;
}
export interface ResearchItem {
  nid: string;
  type: string;
  title: string;
  broker: string;
  date: string;
  reads: number | null;
  code: string | null;
  name: string | null;
  industry: string | null;
  /** 본문(태그 걷어 냄) — 목록에선 앞부분만 쓰고 펼치면 전부 */
  body: string;
}

function nameOf(code: string | null): string | null {
  if (!code) return null;
  return peekSnapshot()?.byCode.get(code)?.name ?? null;
}

/** 마지막으로 채워졌던 목표주가 변경 — 아침에 빈 응답이 올 때 버틴다 (바로 아래 주석) */
let lastGoalUp: GoalChange[] = [];
let lastGoalDown: GoalChange[] = [];

export async function researchBoard(): Promise<{
  goalUp: GoalChange[];
  goalDown: GoalChange[];
  industries: { name: string; count: number; latest: string }[];
  hot: ResearchItem[];
  latest: Record<string, ResearchItem[]>;
  at: number;
  stale: boolean;
}> {
  const r = await cached("research", 15 * 60_000, async () => {
    const goal = async (direction: "up" | "down"): Promise<GoalChange[]> => {
      const j = await naver<{ researchSets?: Record<string, unknown>[] }>(
        `stockSecurity/researches/v2/company/goal-price-changed?direction=${direction}&size=10`,
        "researchGoal",
      );
      return (j.researchSets ?? []).map((s) => {
        const code = String(s.itemCode ?? "");
        return {
          code,
          name: String(s.itemName ?? s.stockName ?? nameOf(code) ?? code),
          broker: String(s.brokerName ?? ""),
          title: String(s.title ?? ""),
          goal: num(s.goalPrice),
          prevGoal: num(s.prevGoalPrice),
          diffRate: num(s.goalPriceDiffRate),
          date: String(s.writeDate ?? ""),
        };
      });
    };
    /*
     * 칸마다 따로 받는다 — 하나가 400 이어도 나머지는 보인다(목표주가는 size 20 이 400 이었다, 10 까지 된다).
     * 전부 실패했을 때만 던져서 캐시의 옛 값으로 버틴다.
     */
    const soft = async <T>(p: Promise<T>, empty: T): Promise<{ v: T; ok: boolean }> => {
      try {
        return { v: await p, ok: true };
      } catch {
        return { v: empty, ok: false };
      }
    };
    const [up, down] = await Promise.all([soft(goal("up"), [] as GoalChange[]), soft(goal("down"), [] as GoalChange[])]);
    /*
     * **빈 값이 좋은 값을 덮으면 안 된다** (2026-09-16 — 9/15 에 네이버 테마가 그렇게 지워졌다).
     *
     * 이 엔드포인트는 **오늘치만** 준다(날짜 파라미터를 받지 않는다 — writeDate·date·startDate 전부
     * 무시하고 오늘로 답한다). 그래서 아침 8시 반에는 정상적으로 빈 배열이 온다. 실패가 아니라서
     * 캐시가 그대로 받아 적으면 「목표주가를 고친 곳 0건」이 하루의 절반을 차지한다.
     * 마지막으로 채워졌던 것을 들고 있다가 그때 것을 돌려준다 — 줄마다 `date` 가 있어 화면이
     * 「어느 날 것인가」를 적는다.
     */
    const goalUp = up.v.length > 0 ? up.v : lastGoalUp;
    const goalDown = down.v.length > 0 ? down.v : lastGoalDown;
    if (up.v.length > 0) lastGoalUp = up.v;
    if (down.v.length > 0) lastGoalDown = down.v;

    const indR = await soft(
      naver<{ industries?: Record<string, unknown>[] }>("stockSecurity/researches/v2/industry/industries?sortType=researchCount&period=7&size=12", "researchIndustry"),
      { industries: [] } as { industries?: Record<string, unknown>[] },
    );
    const ind = indR.v;
    const industries = (ind.industries ?? []).map((x) => ({
      name: String(x.industryKorName ?? x.industry ?? ""),
      count: num(x.researchCount) ?? 0,
      latest: String(x.mostRecentWriteDate ?? ""),
    }));

    const since = new Date(Date.now() + 9 * 3600_000 - 7 * 86_400_000).toISOString().slice(0, 10);
    const hotR = await soft(
      naver<{ researchList?: Record<string, unknown>[] }>(`stockSecurity/researches/v2/weekly-hot?startDate=${since}&size=15`, "researchHot"),
      { researchList: [] } as { researchList?: Record<string, unknown>[] },
    );
    const hotJ = hotR.v;
    const toItem = (x: Record<string, unknown>, type: string): ResearchItem => {
      const code = x.itemCode ? String(x.itemCode) : null;
      return {
        nid: String(x.nid ?? ""),
        type,
        title: String(x.title ?? ""),
        broker: String(x.brokerName ?? ""),
        date: String(x.writeDate ?? ""),
        reads: num(x.readCount),
        code,
        name: nameOf(code),
        industry: x.industryKoreanName ? String(x.industryKoreanName) : null,
        body: stripHtml(x.content),
      };
    };
    const hot = (hotJ.researchList ?? []).map((x) => toItem(x, String(x.type ?? "company")));

    const latR = await soft(
      naver<Record<string, Record<string, unknown>[]>>("stockSecurity/researches/v2/latestResearch?size=6", "researchLatest"),
      {} as Record<string, Record<string, unknown>[]>,
    );
    const latest: Record<string, ResearchItem[]> = {};
    for (const [type, arr] of Object.entries(latR.v)) if (Array.isArray(arr)) latest[type] = arr.map((x) => toItem(x, type));
    if (![up, down, indR, hotR, latR].some((x) => x.ok)) throw new Error("네이버 리서치를 하나도 못 받았다");
    return { goalUp, goalDown, industries, hot, latest };
  });
  return { ...r.data, at: r.at, stale: r.stale };
}

/* ------------------------------------------------------------------ */
/* 융합 셋 (2026-09-16 — 벤티지: "비슷한 거 있다고 제끼지 말고 융합해서 업그레이드")   */
/* ------------------------------------------------------------------ */

export interface NaverBriefing {
  id: number;
  title: string;
  summary: string;
  /** 「2026-09-16 08시」 */
  when: string;
}

/**
 * **네이버 AI 시황 브리핑** — 한 시간마다 새로 쓴다(04~08시에만 다섯 건). 데일리 리포트 AI 가 「다른 눈」으로
 * 읽고 장전 브리핑룸 카드가 보여 준다. 우리 요약을 대신하지 않는다 — 견줄 거리다.
 */
export async function naverBriefings(): Promise<{ latest: NaverBriefing | null; recent: NaverBriefing[]; at: number; stale: boolean }> {
  const r = await cached("briefing", 10 * 60_000, async () => {
    const j = await naver<{ items?: Record<string, unknown>[] }>("securityAi/v2/marketBriefing", "aiBriefing");
    const recent = (j.items ?? []).map((x) => ({
      id: num(x.id) ?? 0,
      title: String(x.title ?? ""),
      summary: stripHtml(x.summary),
      when: `${String(x.briefingDate ?? "")} ${String(x.briefingHour ?? "").padStart(2, "0")}시`,
    }));
    return { latest: recent[0] ?? null, recent: recent.slice(0, 8) };
  });
  return { ...r.data, at: r.at, stale: r.stale };
}

export interface DiscussionRank {
  code: string;
  name: string | null;
  rank: number;
  prevRank: number | null;
  score: number | null;
  price: number | null;
  rate: number | null;
  /** 요즘 글 제목 몇 개 — 무슨 얘기로 달아올랐나 */
  posts: string[];
}

/**
 * **종목토론 랭킹** — 네이버 종목토론방에서 지금 가장 시끄러운 종목 100(한 시간마다). 개인 투자자의 관심이
 * 몰리는 곳이다. 화제 레이더(뉴스·텔레그램)에 「개미 토론」 갈래로, 종목 상세에 순위 칩으로, 데일리 리포트에
 * 과열 재료로 쓴다. **신호등 점수에는 안 넣는다**(문턱·무게 12월까지 동결).
 */
export async function discussionRanking(): Promise<{ rankTime: string; items: DiscussionRank[]; at: number; stale: boolean }> {
  const r = await cached("discussion", 10 * 60_000, async () => {
    const j = await naver<{ rankTime?: string; contents?: Record<string, unknown>[] }>("community/discussion/rankings?nationType=KOR&page=1&size=100", "discussionRank");
    const items = (j.contents ?? [])
      .filter((c) => String(c.discussionType ?? "domesticStock") === "domesticStock")
      .map((c): DiscussionRank => {
        const sp = (c.stockPrices ?? {}) as Record<string, unknown>;
        const posts = ((c.posts as { title?: string }[] | undefined) ?? []).map((p) => String(p.title ?? "").trim()).filter(Boolean).slice(0, 3);
        return {
          code: String(c.itemCode ?? ""),
          name: sp.stockName ? String(sp.stockName) : null,
          rank: num(c.ranking) ?? 0,
          prevRank: num(c.prevRanking),
          score: num(c.score),
          price: num(sp.closePriceRaw ?? sp.closePrice),
          rate: num(sp.fluctuationsRatioRaw ?? sp.fluctuationsRatio),
          posts,
        };
      })
      .filter((x) => /^\d{6}$/.test(x.code));
    return { rankTime: String(j.rankTime ?? ""), items };
  });
  return { ...r.data, at: r.at, stale: r.stale };
}

export type NpayRankKind = "earningRate" | "assetAmount";
export type NpayAge = "all" | "20" | "30" | "40" | "50" | "60";
export interface NpayRankRow {
  code: string;
  name: string;
  rank: number;
  prevRank: number | null;
  price: number | null;
  rate: number | null;
  /** 네이버가 순위를 매긴 값 — 뜻은 네이버 화면 기준(수익률 순위의 값 · 보유금액) */
  value: number | null;
}

/**
 * **네이버페이 증권 이용자 랭킹** — 수익률 상위 이용자들이 담은 종목 / 이용자 보유금액 상위 종목, 나이대별.
 * 전 영업일 하루 치(`fromRankingAt`~`toRankingAt`). 시황 「수익률 상위 고객」 카드(키움)에 탭으로 붙인다.
 */
export async function npayRanking(kind: NpayRankKind, age: NpayAge, size = 20): Promise<{ day: string; rows: NpayRankRow[]; at: number; stale: boolean }> {
  const r = await cached(`npay:${kind}:${age}:${size}`, 30 * 60_000, async () => {
    const j = await naver<{ fromRankingAt?: string; stocks?: Record<string, unknown>[] }>(
      `domestic/home/ranking/${kind}/${age}?startIdx=0&pageSize=${size}`,
      "npayRank",
    );
    return {
      day: String(j.fromRankingAt ?? "").slice(0, 10),
      rows: (j.stocks ?? []).map((s) => ({
        code: String(s.itemcode ?? ""),
        name: String(s.itemname ?? ""),
        rank: num(s.ranking) ?? 0,
        prevRank: num(s.prevRanking),
        price: num(s.currPrice),
        rate: num(s.prevChangeRate),
        value: num(s.rankingValue),
      })),
    };
  });
  return { ...r.data, at: r.at, stale: r.stale };
}
