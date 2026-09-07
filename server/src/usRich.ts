/**
 * 해외주식 상세 — **풍부하게** (2026-09-07 밤). 벤티지: "해외주식 눌렀을 때 나오는 정보가 굉장히 적어.
 * 국내주식에 비해서." → 프롬프트 7절대로. 원칙: **없는 걸 있는 척 채우지 않는다.** 조각마다 따로 받고
 * 따로 실패하며, 실패한 조각은 `missing` 에 이유와 함께 적힌다. 칸마다 출처를 적는다.
 *
 * 출처 (2026-09-07 실측 — probe.mjs 로 NVDA 실호출)
 *   키움 usa20100  현재가 종목정보 — usKiwoomDetail 이 안 쓰던 칸: 불확실성·경쟁우위·연중 고저·상하한가·결산월·거래정지
 *   키움 usa23000  업종 기간 수익률(1일·5일·1개월·3개월·6개월·YTD·1년) — 이 종목의 대·소업종 줄
 *   키움 usa23100  업종 등락률 순위(업종코드) — 같은 소업종의 오늘 상위·하위 = 동종. (usa20550 시총 순위는 업종 필터가 안 먹는다 — 실측)
 *   SEC EDGAR      company_tickers.json(티커→CIK) + companyfacts(XBRL) — 분기·연간 매출·영업이익·순이익·EPS·영업현금·자산·부채·자본
 *                  ⚠️ 분기 값에 **누적(6·9개월)** 이 섞여 온다 — `frame` 이 CYyyyyQn 인 것만 분기다. 실측으로 잡았다
 *   야후 quoteSummary (crumb) — financialData(목표가·추천·마진) · defaultKeyStatistics(선행PER·PEG·베타·숏) ·
 *                  recommendationTrend · earnings/earningsHistory(EPS 실적 vs 예상) · calendarEvents(다음 실적일) ·
 *                  majorHoldersBreakdown(기관·내부자 %) · insiderTransactions · summaryProfile(사업 설명·직원)
 *   야후 RSS       뉴스 20건. 한글 5줄 요약은 데일리 리포트 모델로 하루 1회
 *   우리 것        usKrLinks(한국 관련주) · usKrCorrelation
 *
 * 캐시: 시세류 60초 · 야후 요약 10분 · 프로필·뉴스 30분 · 뉴스 한글 요약 24시간 · EDGAR 는 티커별 파일(24시간)
 */
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { usKiwoomDetail } from "./usKiwoomDetail.js";
import { evaluateLinks } from "./usKrLinks.js";
import { loadCorrelations } from "./usKrCorrelation.js";
import { generateText } from "./vision.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data", "usRich");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36";
/** SEC 는 연락처가 든 User-Agent 를 요구한다 */
const SEC_UA = process.env.SEC_USER_AGENT?.trim() || "VNTG-HTS personal-use mistak0318@gmail.com";

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "object" && v !== null && "raw" in (v as Row)) return num((v as Row).raw);
  const n = Number(String(v).replace(/[,+\s%]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const abs = (v: unknown): number | null => {
  const n = num(v);
  return n === null ? null : Math.abs(n);
};
const str = (v: unknown): string => String(v ?? "").trim();

/* ── 작은 캐시 ── */
const mem = new Map<string, { at: number; v: unknown }>();
async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = mem.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.v as T;
  const v = await fn();
  mem.set(key, { at: Date.now(), v });
  return v;
}
async function fileCached<T>(name: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const f = join(DATA_DIR, name);
  try {
    const st = await fs.stat(f);
    if (Date.now() - st.mtimeMs < ttlMs) return JSON.parse(await fs.readFile(f, "utf8")) as T;
  } catch {
    /* 없으면 받는다 */
  }
  const v = await fn();
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(f, JSON.stringify(v), "utf8");
  return v;
}

/* ═══════════════ 키움 추가 필드 ═══════════════ */

export interface UsKiwoomExtra {
  /** 키움(모닝스타 계열) 등급 — 값이 없으면 빈 문자열 */
  uncertainty: string;
  competitiveAdvantage: string;
  yearHigh: number | null;
  yearHighDate: string;
  yearHighGap: number | null;
  yearLow: number | null;
  yearLowDate: string;
  yearLowGap: number | null;
  upperLimit: number | null;
  lowerLimit: number | null;
  settleMonth: string;
  prevOpen: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  suspended: string;
  sectorLg: string;
  sectorSm: string;
  stex: string;
}

async function kiwoomExtra(client: KiwoomClient, sym: string, stex: string): Promise<UsKiwoomExtra> {
  const { data: d } = await client.request<Row>("/api/us/mrkcond", "usa20100", { stex_tp: stex, stk_cd: sym });
  const price = abs(d.cur_prc);
  const yh = abs(d.oyr_hgst);
  const yl = abs(d.oyr_lwst);
  return {
    uncertainty: str(d.uncert_lv),
    competitiveAdvantage: str(d.comp_adv_tp),
    yearHigh: yh,
    yearHighDate: str(d.oyr_hgst_dt),
    yearHighGap: yh && price ? ((price - yh) / yh) * 100 : null,
    yearLow: yl,
    yearLowDate: str(d.oyr_lwst_dt),
    yearLowGap: yl && price ? ((price - yl) / yl) * 100 : null,
    upperLimit: abs(d.upl_pric),
    lowerLimit: abs(d.lst_pric),
    settleMonth: str(d.setl_mm),
    prevOpen: abs(d.pre_open_pric),
    prevHigh: abs(d.pre_high_pric),
    prevLow: abs(d.pre_low_pric),
    open: abs(d.open_pric),
    high: abs(d.high_pric),
    low: abs(d.low_pric),
    suspended: str(d.trd_susp_tp),
    sectorLg: str(d.lg_inds_cd),
    sectorSm: str(d.sm_inds_cd),
    stex,
  };
}

/* ═══════════════ 업종 수익률 · 동종 ═══════════════ */

export interface SectorPerf {
  code: string;
  name: string;
  d1: number | null;
  d5: number | null;
  m1: number | null;
  m3: number | null;
  m6: number | null;
  ytd: number | null;
  y1: number | null;
}
export interface Peer {
  symbol: string;
  name: string;
  price: number | null;
  changeRate: number | null;
  /** 백만 달러 */
  marketCap: number | null;
  volume: number | null;
}

/** usa23000 은 거래소를 숫자로 받는다 — 0 전체·1 NYSE·2 AMEX·3 NASDAQ (실측: "ND" 를 주면 빈 목록) */
async function sectorTable(client: KiwoomClient): Promise<SectorPerf[]> {
  return cached(`sect:all`, 10 * 60_000, async () => {
    const { data } = await client.request<Row>("/api/us/sect", "usa23000", { stex_tp: "0", inds_cd: "0" });
    const rows = Array.isArray(data.result_list) ? (data.result_list as Row[]) : [];
    return rows.map((r) => ({
      code: str(r.inds_cd),
      name: str(r.inds_nm),
      d1: num(r.perf_1d),
      d5: num(r.perf_5d),
      m1: num(r.perf_1m),
      m3: num(r.perf_3m),
      m6: num(r.perf_6m),
      ytd: num(r.perf_ytd),
      y1: num(r.perf_1y),
    }));
  });
}

/** 같은 업종의 오늘 등락 상위 5 + 하위 5 — usa23100 (sort_tp 1 상위 · 2 하위) */
async function peers(client: KiwoomClient, indsCd: string, self: string): Promise<Peer[]> {
  return cached(`peers:${indsCd}`, 5 * 60_000, async () => {
    const pull = async (sort: "1" | "2") => {
      const { data } = await client.request<Row>("/api/us/sect", "usa23100", { stex_tp: "0", sort_tp: sort, inds_cd: indsCd });
      const rows = Array.isArray(data.result_list) ? (data.result_list as Row[]) : [];
      return rows.map((r) => ({
        symbol: str(r.stk_cd),
        name: str(r.stk_nm) || str(r.stk_enm),
        price: abs(r.cur_prc),
        changeRate: num(r.flu_rt),
        marketCap: null,
        volume: abs(r.acc_trde_qty),
      }));
    };
    const [top, bottom] = await Promise.all([pull("1"), pull("2")]);
    const seen = new Set<string>([self]);
    const out: Peer[] = [];
    for (const p of [...top.slice(0, 5), ...bottom.slice(0, 5)]) {
      if (!p.symbol || seen.has(p.symbol)) continue;
      seen.add(p.symbol);
      out.push(p);
    }
    return out;
  });
}

/* ═══════════════ SEC EDGAR ═══════════════ */

export interface FinPeriod {
  /** CY2026Q2 · CY2025 */
  frame: string;
  end: string;
  fy: number;
  fp: string;
  revenue: number | null;
  operatingIncome: number | null;
  netIncome: number | null;
  eps: number | null;
  operatingCashFlow: number | null;
  assets: number | null;
  liabilities: number | null;
  equity: number | null;
}
export interface Financials {
  cik: string;
  entity: string;
  quarterly: FinPeriod[];
  annual: FinPeriod[];
  /** 어느 XBRL 개념을 썼나 — 회사마다 이름이 다르다 */
  concepts: Record<string, string>;
}

const CONCEPTS: Record<string, string[]> = {
  revenue: ["Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax", "TotalRevenuesAndOtherIncome"],
  operatingIncome: ["OperatingIncomeLoss"],
  netIncome: ["NetIncomeLoss", "ProfitLoss", "NetIncomeLossAvailableToCommonStockholdersBasic"],
  eps: ["EarningsPerShareDiluted", "EarningsPerShareBasic"],
  operatingCashFlow: ["NetCashProvidedByUsedInOperatingActivities"],
  assets: ["Assets"],
  liabilities: ["Liabilities"],
  equity: ["StockholdersEquity", "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest"],
};

async function cikOf(sym: string): Promise<{ cik: string; title: string } | null> {
  const map = await fileCached<Record<string, { cik_str: number; ticker: string; title: string }>>("company_tickers.json", 7 * 86400_000, async () => {
    const r = await fetch("https://www.sec.gov/files/company_tickers.json", { headers: { "User-Agent": SEC_UA } });
    if (!r.ok) throw new Error(`SEC tickers HTTP ${r.status}`);
    return (await r.json()) as Record<string, { cik_str: number; ticker: string; title: string }>;
  });
  const row = Object.values(map).find((x) => x.ticker.toUpperCase() === sym.toUpperCase());
  return row ? { cik: String(row.cik_str).padStart(10, "0"), title: row.title } : null;
}

async function edgar(sym: string): Promise<Financials | null> {
  const id = await cikOf(sym);
  if (!id) return null;
  const facts = await fileCached<Row>(`facts-${id.cik}.json`, 86400_000, async () => {
    const r = await fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${id.cik}.json`, { headers: { "User-Agent": SEC_UA } });
    if (!r.ok) throw new Error(`SEC facts HTTP ${r.status}`);
    return (await r.json()) as Row;
  });
  const gaap = ((facts.facts as Row | undefined)?.["us-gaap"] as Row | undefined) ?? {};
  const concepts: Record<string, string> = {};
  /* frame → 기간 값. 같은 frame 이 여러 보고서에 나오면 마지막(가장 최근 제출) 것 */
  const byFrame = new Map<string, FinPeriod>();
  const touch = (frame: string, x: Row): FinPeriod => {
    let p = byFrame.get(frame);
    if (!p) {
      p = { frame, end: str(x.end), fy: Number(x.fy) || 0, fp: str(x.fp), revenue: null, operatingIncome: null, netIncome: null, eps: null, operatingCashFlow: null, assets: null, liabilities: null, equity: null };
      byFrame.set(frame, p);
    }
    return p;
  };
  for (const [field, names] of Object.entries(CONCEPTS)) {
    const name = names.find((n) => gaap[n]);
    if (!name) continue;
    concepts[field] = name;
    const units = ((gaap[name] as Row).units as Row) ?? {};
    const unitKey = field === "eps" ? "USD/shares" : "USD";
    const arr = (units[unitKey] as Row[] | undefined) ?? [];
    for (const x of arr) {
      const frame = str(x.frame);
      if (!frame) continue; // 누적치(6·9개월)는 frame 이 없다 — 버린다
      const isInstant = /I$/.test(frame);
      const key = frame.replace(/I$/, "");
      const period = frame.startsWith("CY") ? key : "";
      if (!period) continue;
      const p = touch(period, x);
      const v = num(x.val);
      if (v === null) continue;
      if (field === "assets" || field === "liabilities" || field === "equity") {
        if (isInstant) (p as unknown as Row)[field] = v;
      } else if (!isInstant) {
        (p as unknown as Row)[field] = v;
      }
    }
  }
  const all = [...byFrame.values()];
  const quarterly = all.filter((p) => /Q\d$/.test(p.frame) && (p.revenue !== null || p.netIncome !== null)).sort((a, b) => a.frame.localeCompare(b.frame)).slice(-8);
  const annual = all.filter((p) => /^CY\d{4}$/.test(p.frame) && (p.revenue !== null || p.netIncome !== null)).sort((a, b) => a.frame.localeCompare(b.frame)).slice(-5);
  return { cik: id.cik, entity: id.title, quarterly, annual, concepts };
}

/* ═══════════════ 야후 quoteSummary ═══════════════ */

let yahooSession: { cookie: string; crumb: string; at: number } | null = null;
async function yahooAuth(): Promise<{ cookie: string; crumb: string }> {
  if (yahooSession && Date.now() - yahooSession.at < 3600_000) return yahooSession;
  const r1 = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA }, redirect: "manual" });
  const cookie = (r1.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, cookie } });
  const crumb = (await r2.text()).trim();
  if (!r2.ok || !crumb || crumb.includes("<")) throw new Error(`야후 crumb 실패 (${r2.status})`);
  yahooSession = { cookie, crumb, at: Date.now() };
  return yahooSession;
}

export interface YahooOpinion {
  currentPrice: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  targetMean: number | null;
  targetMedian: number | null;
  recommendationMean: number | null;
  recommendationKey: string;
  analysts: number | null;
  revenueTtm: number | null;
  revenueGrowth: number | null;
  grossMargin: number | null;
  operatingMargin: number | null;
  profitMargin: number | null;
  returnOnEquity: number | null;
  debtToEquity: number | null;
  freeCashflow: number | null;
  forwardPE: number | null;
  trailingPE: number | null;
  peg: number | null;
  beta: number | null;
  shortRatio: number | null;
  shortPctFloat: number | null;
  floatShares: number | null;
  enterpriseValue: number | null;
  evToEbitda: number | null;
  trend: { period: string; strongBuy: number; buy: number; hold: number; sell: number; strongSell: number }[];
  epsHistory: { quarter: string; actual: number | null; estimate: number | null; surprisePct: number | null }[];
  nextEarnings: string;
  nextEarningsIsEstimate: boolean;
  epsEstimateNext: number | null;
  revenueEstimateNext: number | null;
  holders: { insidersPct: number | null; institutionsPct: number | null; institutionsCount: number | null };
  insiders: { name: string; relation: string; text: string; shares: number | null; value: number | null; date: string }[];
  profile: { sector: string; industry: string; employees: number | null; website: string; summary: string; city: string; country: string };
  pre: { price: number | null; changeRate: number | null } | null;
  post: { price: number | null; changeRate: number | null } | null;
}

async function yahooSummary(sym: string): Promise<YahooOpinion> {
  return cached(`yq:${sym}`, 10 * 60_000, async () => {
    const { cookie, crumb } = await yahooAuth();
    const mods = "price,summaryProfile,financialData,defaultKeyStatistics,recommendationTrend,earnings,calendarEvents,majorHoldersBreakdown,insiderTransactions,earningsHistory";
    const r = await fetch(`https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}?modules=${mods}&crumb=${encodeURIComponent(crumb)}`, {
      headers: { "User-Agent": UA, cookie },
    });
    const j = (await r.json()) as Row;
    const qs = j.quoteSummary as Row | undefined;
    const res = (qs?.result as Row[] | undefined)?.[0];
    if (!res) {
      const err = (qs?.error as Row | undefined)?.description;
      throw new Error(err ? String(err) : `야후 응답 없음 (${r.status})`);
    }
    const fd = (res.financialData as Row) ?? {};
    const ks = (res.defaultKeyStatistics as Row) ?? {};
    const rt = ((res.recommendationTrend as Row)?.trend as Row[]) ?? [];
    const eh = ((res.earningsHistory as Row)?.history as Row[]) ?? [];
    const cal = ((res.calendarEvents as Row)?.earnings as Row) ?? {};
    const hold = (res.majorHoldersBreakdown as Row) ?? {};
    const ins = ((res.insiderTransactions as Row)?.transactions as Row[]) ?? [];
    const prof = (res.summaryProfile as Row) ?? {};
    const price = (res.price as Row) ?? {};
    const earnDates = (cal.earningsDate as Row[] | undefined) ?? [];
    const fmt = (x: unknown): string => str((x as Row | undefined)?.fmt ?? x);
    return {
      currentPrice: num(fd.currentPrice),
      targetHigh: num(fd.targetHighPrice),
      targetLow: num(fd.targetLowPrice),
      targetMean: num(fd.targetMeanPrice),
      targetMedian: num(fd.targetMedianPrice),
      recommendationMean: num(fd.recommendationMean),
      recommendationKey: str(fd.recommendationKey),
      analysts: num(fd.numberOfAnalystOpinions),
      revenueTtm: num(fd.totalRevenue),
      revenueGrowth: num(fd.revenueGrowth),
      grossMargin: num(fd.grossMargins),
      operatingMargin: num(fd.operatingMargins),
      profitMargin: num(fd.profitMargins),
      returnOnEquity: num(fd.returnOnEquity),
      debtToEquity: num(fd.debtToEquity),
      freeCashflow: num(fd.freeCashflow),
      forwardPE: num(ks.forwardPE),
      trailingPE: num(ks.trailingPE) ?? num((res.price as Row)?.trailingPE),
      peg: num(ks.pegRatio),
      beta: num(ks.beta),
      shortRatio: num(ks.shortRatio),
      shortPctFloat: num(ks.shortPercentOfFloat),
      floatShares: num(ks.floatShares),
      enterpriseValue: num(ks.enterpriseValue),
      evToEbitda: num(ks.enterpriseToEbitda),
      trend: rt.map((t) => ({ period: str(t.period), strongBuy: num(t.strongBuy) ?? 0, buy: num(t.buy) ?? 0, hold: num(t.hold) ?? 0, sell: num(t.sell) ?? 0, strongSell: num(t.strongSell) ?? 0 })),
      epsHistory: eh.map((h) => ({ quarter: fmt(h.quarter), actual: num(h.epsActual), estimate: num(h.epsEstimate), surprisePct: num(h.surprisePercent) !== null ? (num(h.surprisePercent) as number) * 100 : null })),
      nextEarnings: earnDates.map(fmt).filter(Boolean).join(" ~ "),
      nextEarningsIsEstimate: Boolean(cal.isEarningsDateEstimate),
      epsEstimateNext: num(cal.earningsAverage),
      revenueEstimateNext: num(cal.revenueAverage),
      holders: { insidersPct: num(hold.insidersPercentHeld), institutionsPct: num(hold.institutionsPercentHeld), institutionsCount: num(hold.institutionsCount) },
      insiders: ins.slice(0, 12).map((t) => ({
        name: str(t.filerName),
        relation: str(t.filerRelation),
        text: str(t.transactionText),
        shares: num(t.shares),
        value: num(t.value),
        date: fmt(t.startDate),
      })),
      profile: {
        sector: str(prof.sector),
        industry: str(prof.industry),
        employees: num(prof.fullTimeEmployees),
        website: str(prof.website),
        summary: str(prof.longBusinessSummary),
        city: str(prof.city),
        country: str(prof.country),
      },
      pre: num(price.preMarketPrice) !== null ? { price: num(price.preMarketPrice), changeRate: num(price.preMarketChangePercent) !== null ? (num(price.preMarketChangePercent) as number) * 100 : null } : null,
      post: num(price.postMarketPrice) !== null ? { price: num(price.postMarketPrice), changeRate: num(price.postMarketChangePercent) !== null ? (num(price.postMarketChangePercent) as number) * 100 : null } : null,
    };
  });
}

/* ═══════════════ 뉴스 ═══════════════ */

export interface NewsItem {
  title: string;
  link: string;
  at: string;
  source: string;
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();
}

async function news(sym: string): Promise<NewsItem[]> {
  return cached(`news:${sym}`, 30 * 60_000, async () => {
    const r = await fetch(`https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(sym)}&region=US&lang=en-US`, { headers: { "User-Agent": UA } });
    if (!r.ok) throw new Error(`야후 RSS HTTP ${r.status}`);
    const xml = await r.text();
    const items: NewsItem[] = [];
    for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
      const body = m[1];
      const pick = (tag: string) => decodeXml((body.match(new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`)) ?? [])[1] ?? "");
      const title = pick("title");
      if (!title) continue;
      const at = pick("pubDate");
      items.push({ title, link: pick("link"), at: at ? new Date(at).toISOString() : "", source: pick("source") || "Yahoo Finance" });
    }
    return items.slice(0, 20);
  });
}

/** 한글 5줄 요약 — 하루 한 번, 뉴스 제목 묶음으로. 모델은 설정의 기본(데일리 리포트와 같은 것) */
async function newsSummaryKo(sym: string, items: NewsItem[]): Promise<string | null> {
  if (items.length === 0) return null;
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  return fileCached<string | null>(`news-${sym}-${day}.json`, 86400_000, async () => {
    const prompt =
      `다음은 미국 주식 ${sym} 의 최근 뉴스 제목들이다. 한국 개인투자자가 밤사이 무슨 일이 있었는지 30초 안에 알 수 있게 ` +
      `한국어로 **정확히 5줄**, 줄마다 한 문장, 숫자·고유명사는 그대로. 추측·과장 없이 제목에 있는 사실만. 머리말·꼬리말 없이 5줄만.\n\n` +
      items.map((n, i) => `${i + 1}. [${n.source}] ${n.title}`).join("\n");
    try {
      const r = await generateText(prompt, 600, undefined, undefined, "other");
      const text = (r as unknown as { text?: string }).text ?? "";
      return text.trim() || null;
    } catch {
      return null;
    }
  });
}

/* ═══════════════ 국내 연동 ═══════════════ */

export interface KrLinkRow {
  label: string;
  krThemes: { name: string; changeRate: number | null }[];
  gap: number | null;
  nextDay: number | null;
  beta: number | null;
  samples: number;
}

async function krLinks(client: KiwoomClient, sym: string): Promise<KrLinkRow[]> {
  return cached(`krl:${sym}`, 5 * 60_000, async () => {
    const [ev, corr] = await Promise.all([evaluateLinks(client), loadCorrelations().catch(() => null)]);
    return ev.links
      .filter((l) => l.us.map((u) => u.toUpperCase()).includes(sym))
      .map((l) => {
        const pairs = (corr?.pairs ?? []).filter((p) => p.label === l.label && p.us.toUpperCase() === sym);
        const best = pairs.filter((p) => p.nextDay !== null).sort((a, b) => Math.abs(b.nextDay ?? 0) - Math.abs(a.nextDay ?? 0))[0];
        return {
          label: l.label,
          krThemes: l.krThemes.map((t) => ({ name: t.name, changeRate: t.changeRate })),
          gap: l.gap,
          nextDay: best?.nextDay ?? null,
          beta: best?.beta ?? null,
          samples: best?.samples ?? 0,
        };
      });
  });
}

/* ═══════════════ 묶음 ═══════════════ */

export interface UsRich {
  symbol: string;
  at: string;
  extra: UsKiwoomExtra | null;
  sector: { lg: SectorPerf | null; sm: SectorPerf | null; all: SectorPerf[] } | null;
  peers: Peer[] | null;
  financials: Financials | null;
  opinion: YahooOpinion | null;
  news: NewsItem[] | null;
  newsKo: string | null;
  krLinks: KrLinkRow[] | null;
  missing: { part: string; why: string }[];
}

export async function usRich(client: KiwoomClient, symbol: string, opts: { summary?: boolean } = {}): Promise<UsRich> {
  const sym = symbol.toUpperCase();
  const missing: { part: string; why: string }[] = [];
  const grab = async <T>(part: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch (e) {
      missing.push({ part, why: e instanceof Error ? e.message : String(e) });
      return null;
    }
  };

  const base = await usKiwoomDetail(client, sym).catch(() => null);
  const stex = base?.summary?.stex ?? null;

  const [extra, fin, op, nw, kl] = await Promise.all([
    stex ? grab("키움 추가 필드", () => cached(`extra:${sym}`, 60_000, () => kiwoomExtra(client, sym, stex))) : Promise.resolve(null),
    grab("SEC EDGAR 재무", () => edgar(sym)),
    grab("야후 의견·실적", () => yahooSummary(sym)),
    grab("야후 뉴스", () => news(sym)),
    grab("국내 연동", () => krLinks(client, sym)),
  ]);
  if (!stex) missing.push({ part: "키움 미국 시세", why: base?.unsupported ?? "거래소를 못 찾았다" });
  if (fin === null && !missing.some((m) => m.part === "SEC EDGAR 재무")) missing.push({ part: "SEC EDGAR 재무", why: "SEC 에 등록된 티커가 아니다 (ETF·ADR 등)" });

  let sector: UsRich["sector"] = null;
  let peerList: Peer[] | null = null;
  if (stex && extra) {
    const table = await grab("업종 수익률", () => sectorTable(client));
    if (table) {
      /* usa20100 의 업종명은 「반도체 및 반도체장비」, usa23000 은 「반도체및반도체장비」 — 띄어쓰기를 빼고 맞춘다 */
      const norm = (s: string) => s.replace(/\s+/g, "");
      const find = (name: string) => {
        const n = norm(name);
        if (!n) return null;
        const exact = table.find((s) => norm(s.name) === n);
        if (exact) return exact;
        /* 부분 일치는 세 글자부터 — 「IT」가 「REIT…」에 걸렸다(실측) */
        return n.length >= 3 ? (table.find((s) => n.includes(norm(s.name)) || norm(s.name).includes(n)) ?? null) : null;
      };
      const sm = find(extra.sectorSm);
      const lg = find(extra.sectorLg);
      sector = { lg, sm, all: table };
      if (sm?.code) peerList = await grab("동종(업종 등락 상하위)", () => peers(client, sm.code, sym));
    }
  }

  const newsKo = opts.summary && nw ? await grab("뉴스 한글 요약", () => newsSummaryKo(sym, nw)) : null;

  return { symbol: sym, at: new Date().toISOString(), extra, sector, peers: peerList, financials: fin, opinion: op, news: nw, newsKo, krLinks: kl, missing };
}
