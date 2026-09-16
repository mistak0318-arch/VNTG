import { hantooGet, hantooReady } from "./hantooClient.js";
import { yahooChart } from "./yahooChart.js";
import { yahooAuth } from "./usEtfHoldings.js";
import { discussionRanking, usPopular } from "./naverMarket.js";
import { usFastQuotes } from "./usFastQuotes.js";
import { recordApiCall } from "./apiUsage.js";

/**
 * **종목분석(해외) 묶음의 재료** (2026-09-17 새벽 — 벤티지: "종목분석(해외) 메뉴를 하나 만들고 … 네이버·야후에서
 * 뽑아올 수 있는 거 뽑아서 메뉴 구성해 보자. 이슈나 종목토론 해외 부분도 있으면 좋겠다, 트렌드 읽을 수 있게").
 *
 * 넷을 한 파일에 둔다 — 전부 「이미 있는 통로」로 받는다:
 *
 *   ① 업종 MAP     한투 42업종(`HHDFS76370100`) + 업종별 종목(`HHDFS76370000`) — 9/16 밤 실측한 TR 만 쓴다
 *   ② ETF 자금흐름  야후 차트(SPY·QQQ·IWM·DIA + 섹터 ETF 11) — 키 없음
 *   ③ 인기·화제     네이버 해외 인기 + 야후 trending + **네이버 해외 종목토론**(`nationType=USA`, 9/17 실측)
 *   ④ 실적·일정     야후 quoteSummary calendarEvents (crumb) — 해외 관심종목 심볼별
 *
 * 캐시가 곧 조회 예산이다: ① 15분(한투 400ms 슬롯이라 84콜 = 34초) · ② 5분 · ③ 3분 · ④ 6시간(심볼별).
 * 「모른다」는 null — 0 으로 굳히지 않는다.
 */

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
}

/* ═══════════════ ① 업종 MAP (한투) ═══════════════ */

export interface UsSectorStock {
  symbol: string;
  name: string;
  exchange: string;
  price: number | null;
  rate: number | null;
  /** 거래량 */
  volume: number | null;
}
export interface UsSector {
  code: string;
  name: string;
  /** 거래대금 가중 등락률(%) — 종목 rate 를 (price × volume) 으로 가중 */
  rate: number | null;
  count: number;
  up: number;
  down: number;
  /** 가중치 합(달러) — 칸 크기 */
  turnover: number;
  stocks: UsSectorStock[];
}
export interface UsSectorMap {
  at: number;
  stale: boolean;
  exchanges: string[];
  sectors: UsSector[];
  error?: string;
}

const SECTOR_TTL = 15 * 60_000;
let sectorCache: UsSectorMap | null = null;
let sectorBuilding: Promise<UsSectorMap> | null = null;

async function sectorList(excd: string): Promise<{ code: string; name: string }[]> {
  const r = await hantooGet<{ output2?: Record<string, unknown>[]; output1?: Record<string, unknown>[] }>(
    "/uapi/overseas-price/v1/quotations/industry-price",
    "HHDFS76370100",
    { AUTH: "", EXCD: excd, ICOD: "", VOL_RANG: "0", KEYB: "" },
    "usSectorList",
  );
  const rows = (Array.isArray(r.output2) ? r.output2 : Array.isArray(r.output1) ? r.output1 : []) as Record<string, unknown>[];
  return rows.map((x) => ({ code: String(x.icod ?? "").trim(), name: String(x.name ?? "").trim() })).filter((x) => x.code && x.name);
}

async function sectorStocks(excd: string, icod: string): Promise<UsSectorStock[]> {
  const r = await hantooGet<{ output2?: Record<string, unknown>[] }>(
    "/uapi/overseas-price/v1/quotations/industry-theme",
    "HHDFS76370000",
    { AUTH: "", EXCD: excd, ICOD: icod, VOL_RANG: "0", KEYB: "" },
    "usSectorStocks",
  );
  return ((r.output2 ?? []) as Record<string, unknown>[]).map((x) => ({
    symbol: String(x.symb ?? "").trim(),
    name: String(x.name ?? "").trim(),
    exchange: String(x.excd ?? excd).trim(),
    price: num(x.last),
    rate: num(x.rate),
    volume: num(x.tvol),
  }));
}

/**
 * 42업종 × 거래소(NAS·NYS). 한 업종에 두 거래소 종목이 섞이므로 코드로 합친다.
 * 한투가 없거나 실패하면 옛 값을 `stale` 로 — 처음부터 못 받으면 빈 지도와 이유.
 */
export async function usSectorMap(): Promise<UsSectorMap> {
  if (sectorCache && Date.now() - sectorCache.at < SECTOR_TTL) return sectorCache;
  if (sectorBuilding) return sectorBuilding;
  sectorBuilding = (async () => {
    if (!hantooReady()) {
      const r: UsSectorMap = { at: Date.now(), stale: false, exchanges: [], sectors: [], error: "한투 키가 없어 업종 지도를 못 받습니다" };
      return sectorCache ? { ...sectorCache, stale: true } : r;
    }
    try {
      const exchanges = ["NAS", "NYS"];
      const byCode = new Map<string, UsSector>();
      for (const excd of exchanges) {
        const list = await sectorList(excd);
        for (const s of list) {
          const stocks = await sectorStocks(excd, s.code).catch(() => [] as UsSectorStock[]);
          const cur = byCode.get(s.code) ?? { code: s.code, name: s.name, rate: null, count: 0, up: 0, down: 0, turnover: 0, stocks: [] };
          cur.stocks.push(...stocks);
          byCode.set(s.code, cur);
        }
      }
      const sectors: UsSector[] = [];
      for (const sec of byCode.values()) {
        let wsum = 0;
        let w = 0;
        for (const st of sec.stocks) {
          if (st.rate === null) continue;
          if (st.rate > 0) sec.up += 1;
          else if (st.rate < 0) sec.down += 1;
          /* 동전주 하나가 +487% 로 열 종목짜리 업종을 삼킨 적 있다(RETO, 9/17) — ±50% 넘는 건 세기만 하고 가중엔 안 넣는다 */
          if (Math.abs(st.rate) > 50) continue;
          const weight = st.price !== null && st.volume !== null ? Math.max(st.price * st.volume, 1) : 1;
          wsum += st.rate * weight;
          w += weight;
        }
        sec.count = sec.stocks.length;
        sec.turnover = Math.round(w);
        sec.rate = w > 0 ? Math.round((wsum / w) * 100) / 100 : null;
        sec.stocks.sort((a, b) => (b.price ?? 0) * (b.volume ?? 0) - (a.price ?? 0) * (a.volume ?? 0));
        sectors.push(sec);
      }
      sectors.sort((a, b) => (b.rate ?? -999) - (a.rate ?? -999));
      sectorCache = { at: Date.now(), stale: false, exchanges, sectors };
      return sectorCache;
    } catch (e) {
      if (sectorCache) return { ...sectorCache, stale: true };
      return { at: Date.now(), stale: false, exchanges: [], sectors: [], error: e instanceof Error ? e.message : String(e) };
    }
  })().finally(() => {
    sectorBuilding = null;
  });
  return sectorBuilding;
}

/* ═══════════════ ② ETF 자금흐름 (야후) ═══════════════ */

export interface UsEtfRow {
  symbol: string;
  name: string;
  group: "지수" | "섹터" | "채권·금·달러";
  price: number | null;
  d1: number | null;
  d5: number | null;
  d20: number | null;
  /** 최근 5일 평균 거래대금 / 그 앞 20일 평균 — 1.5 면 돈이 몰리는 중 */
  volRatio: number | null;
  /** 최근 5일 평균 거래대금($) */
  dollar5: number | null;
}

const ETFS: { symbol: string; name: string; group: UsEtfRow["group"] }[] = [
  { symbol: "SPY", name: "S&P 500", group: "지수" },
  { symbol: "QQQ", name: "나스닥 100", group: "지수" },
  { symbol: "IWM", name: "러셀 2000 (소형)", group: "지수" },
  { symbol: "DIA", name: "다우", group: "지수" },
  { symbol: "XLK", name: "기술", group: "섹터" },
  { symbol: "XLC", name: "통신·미디어", group: "섹터" },
  { symbol: "XLY", name: "경기소비재", group: "섹터" },
  { symbol: "XLP", name: "필수소비재", group: "섹터" },
  { symbol: "XLF", name: "금융", group: "섹터" },
  { symbol: "XLV", name: "헬스케어", group: "섹터" },
  { symbol: "XLI", name: "산업재", group: "섹터" },
  { symbol: "XLE", name: "에너지", group: "섹터" },
  { symbol: "XLB", name: "소재", group: "섹터" },
  { symbol: "XLU", name: "유틸리티", group: "섹터" },
  { symbol: "XLRE", name: "부동산", group: "섹터" },
  { symbol: "SMH", name: "반도체", group: "섹터" },
  { symbol: "TLT", name: "미 장기채 20년+", group: "채권·금·달러" },
  { symbol: "HYG", name: "하이일드 채권", group: "채권·금·달러" },
  { symbol: "GLD", name: "금", group: "채권·금·달러" },
  { symbol: "UUP", name: "달러 인덱스", group: "채권·금·달러" },
];

let etfCache: { at: number; rows: UsEtfRow[] } | null = null;
const ETF_TTL = 5 * 60_000;

export async function usEtfFlow(): Promise<{ at: number; rows: UsEtfRow[]; stale: boolean }> {
  if (etfCache && Date.now() - etfCache.at < ETF_TTL) return { ...etfCache, stale: false };
  try {
    const rows: UsEtfRow[] = [];
    for (const e of ETFS) {
      const ch = await yahooChart(e.symbol, "3mo").catch(() => null);
      const c = (ch?.candles ?? []).filter((x) => x.close > 0);
      const last = c[c.length - 1];
      const at = (k: number) => c[c.length - 1 - k]?.close ?? null;
      const pct = (from: number | null) => (last && from && from > 0 ? Math.round(((last.close - from) / from) * 10000) / 100 : null);
      const dollars = c.map((x) => x.close * x.volume);
      const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
      const d5 = avg(dollars.slice(-5));
      const d20b = avg(dollars.slice(-25, -5));
      rows.push({
        symbol: e.symbol,
        name: e.name,
        group: e.group,
        price: last?.close ?? null,
        d1: pct(at(1)),
        d5: pct(at(5)),
        d20: pct(at(20)),
        volRatio: d5 !== null && d20b !== null && d20b > 0 ? Math.round((d5 / d20b) * 100) / 100 : null,
        dollar5: d5 !== null ? Math.round(d5) : null,
      });
    }
    etfCache = { at: Date.now(), rows };
    return { ...etfCache, stale: false };
  } catch {
    if (etfCache) return { ...etfCache, stale: true };
    throw new Error("야후에서 ETF 시세를 못 받았습니다");
  }
}

/* ═══════════════ ③ 인기·화제 ═══════════════ */

export interface UsTrending {
  symbol: string;
  name: string | null;
  price: number | null;
  rate: number | null;
}
export interface UsDiscussionRow {
  rank: number;
  prevRank: number | null;
  /** 네이버 코드(ZTG.O) → 심볼(ZTG)·거래소(.O 나스닥 · .K 뉴욕 · .A 아멕스) */
  symbol: string;
  reuters: string;
  name: string | null;
  price: number | null;
  rate: number | null;
  /** 요즘 글 제목 몇 개 — 트렌드는 여기서 읽는다 */
  posts: string[];
}
export interface UsBuzz {
  at: number;
  popular: { rows: Awaited<ReturnType<typeof usPopular>>["rows"]; stale: boolean } | null;
  trending: UsTrending[] | null;
  discussion: { rankTime: string; items: UsDiscussionRow[]; stale: boolean } | null;
}

let trendingCache: { at: number; rows: UsTrending[] } | null = null;

async function yahooTrending(): Promise<UsTrending[]> {
  if (trendingCache && Date.now() - trendingCache.at < 3 * 60_000) return trendingCache.rows;
  const res = await fetch("https://query1.finance.yahoo.com/v1/finance/trending/US?count=20", {
    headers: { "User-Agent": "Mozilla/5.0" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    void recordApiCall("yahoo", "trending", "failed", undefined, `HTTP ${res.status}`);
    throw new Error(`야후 trending ${res.status}`);
  }
  void recordApiCall("yahoo", "trending", "ok");
  const j = (await res.json()) as { finance?: { result?: { quotes?: { symbol: string }[] }[] } };
  const syms = (j.finance?.result?.[0]?.quotes ?? []).map((q) => q.symbol).filter((s) => /^[A-Z.\-]{1,8}$/.test(s));
  const quotes = await usFastQuotes(syms).catch(() => new Map());
  const rows: UsTrending[] = syms.map((s) => {
    const q = quotes.get(s);
    return { symbol: s, name: null, price: q?.price ?? null, rate: q?.changeRate ?? null };
  });
  trendingCache = { at: Date.now(), rows };
  return rows;
}

export async function usBuzz(): Promise<UsBuzz> {
  const [pop, tr, dis] = await Promise.all([
    usPopular(40).catch(() => null),
    yahooTrending().catch(() => null),
    discussionRanking("USA").catch(() => null),
  ]);
  const discussion = dis
    ? {
        rankTime: dis.rankTime,
        stale: dis.stale,
        items: dis.items.map((it) => {
          const reuters = it.code;
          const symbol = reuters.replace(/\.(O|K|A|N)$/i, "");
          return { rank: it.rank, prevRank: it.prevRank, symbol, reuters, name: it.name ?? null, price: it.price, rate: it.rate, posts: it.posts };
        }),
      }
    : null;
  /* 이름은 인기 목록(네이버)에서 빌린다 — trending 은 심볼뿐이고, 미국 종목토론은 stockPrices 자체가 없다 */
  const nameOf = new Map<string, string>();
  for (const r of pop?.rows ?? []) nameOf.set(r.symbol, r.name);
  if (tr) for (const t of tr) t.name = t.name ?? nameOf.get(t.symbol) ?? null;
  if (discussion) {
    const need = discussion.items.filter((d) => d.price === null).map((d) => d.symbol);
    const quotes = need.length > 0 ? await usFastQuotes(need).catch(() => new Map<string, { price: number | null; changeRate: number | null }>()) : new Map();
    for (const d of discussion.items) {
      d.name = d.name ?? nameOf.get(d.symbol) ?? null;
      const q = quotes.get(d.symbol);
      if (q) {
        d.price = d.price ?? q.price ?? null;
        d.rate = d.rate ?? q.changeRate ?? null;
      }
    }
  }
  return { at: Date.now(), popular: pop ? { rows: pop.rows, stale: pop.stale } : null, trending: tr, discussion };
}

/* ═══════════════ ④ 실적·일정 (야후 calendarEvents) ═══════════════ */

export interface UsEvent {
  symbol: string;
  /** 다음 실적 발표일(들) — 야후는 범위로 줄 때가 있다 */
  earnings: string[];
  epsEstimate: number | null;
  revenueEstimate: number | null;
  exDividend: string | null;
  dividendDate: string | null;
  error?: string;
}

const eventCache = new Map<string, { at: number; ev: UsEvent }>();
const EVENT_TTL = 6 * 3600_000;

function isoDay(v: unknown): string | null {
  const raw = (v && typeof v === "object" && "raw" in (v as Record<string, unknown>) ? (v as { raw?: unknown }).raw : v) as unknown;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date(n * 1000 + 9 * 3600_000).toISOString().slice(0, 10);
}

async function yahooCalendar(sym: string): Promise<UsEvent> {
  const hit = eventCache.get(sym);
  if (hit && Date.now() - hit.at < EVENT_TTL) return hit.ev;
  const a = await yahooAuth();
  if (!a) throw new Error("야후 crumb 을 못 받았다");
  const res = await fetch(
    `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=calendarEvents&crumb=${encodeURIComponent(a.crumb)}`,
    { headers: { "User-Agent": "Mozilla/5.0", cookie: a.cookie }, signal: AbortSignal.timeout(10_000) },
  );
  if (!res.ok) {
    void recordApiCall("yahoo", "calendar", "failed", undefined, `HTTP ${res.status}`);
    throw new Error(`야후 calendar ${res.status}`);
  }
  void recordApiCall("yahoo", "calendar", "ok");
  const j = (await res.json()) as { quoteSummary?: { result?: { calendarEvents?: Record<string, unknown> }[] } };
  const cal = j.quoteSummary?.result?.[0]?.calendarEvents ?? {};
  const earn = (cal.earnings ?? {}) as Record<string, unknown>;
  const dates = Array.isArray(earn.earningsDate) ? (earn.earningsDate as unknown[]).map(isoDay).filter((d): d is string => !!d) : [];
  const raw = (v: unknown) => (v && typeof v === "object" ? num((v as { raw?: unknown }).raw) : num(v));
  const ev: UsEvent = {
    symbol: sym,
    earnings: [...new Set(dates)],
    epsEstimate: raw(earn.earningsAverage),
    revenueEstimate: raw(earn.revenueAverage),
    exDividend: isoDay(cal.exDividendDate),
    dividendDate: isoDay(cal.dividendDate),
  };
  eventCache.set(sym, { at: Date.now(), ev });
  return ev;
}

/** 여러 심볼 — 순서대로, 실패한 심볼은 error 만 달고 나머지는 나온다 */
export async function usEvents(symbols: string[]): Promise<{ at: number; events: UsEvent[] }> {
  const events: UsEvent[] = [];
  /* 앞 100개까지 — 해외 관심종목 전 그룹이 150쯤이라 손으로 넣은 것·관심종목이 먼저 오게 클라이언트가 순서를 맞춘다 */
  for (const s of [...new Set(symbols.map((x) => x.toUpperCase()))].slice(0, 100)) {
    try {
      events.push(await yahooCalendar(s));
    } catch (e) {
      events.push({ symbol: s, earnings: [], epsEstimate: null, revenueEstimate: null, exDividend: null, dividendDate: null, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { at: Date.now(), events };
}
