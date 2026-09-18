/**
 * **ETF 분석 묶음 — 국내 ETF 자금흐름 · 레버리지/인버스 심리** (2026-09-17, 벤티지가 고른 넷 중 서버가 필요한 둘).
 *
 * 둘 다 재료는 **저장해 둔 일봉**(`dailyCloses` — 마감 뒤 정리가 ETF 도 채운다)이다. 캐시에 없는 ETF 만
 * ka10081 을 한 번 받아 그날 하루 들고 있는다(대개 대여섯 종목). 오늘 값은 ETF 전체시세(ka40004, 3분 캐시)의
 * 현재가·거래량으로 잇는다 — cumulativeRank 와 같은 원칙(장이 열린 뒤에만, 캐시에 오늘 봉이 없을 때만).
 *
 * 무엇을 고르나 — 코드를 박아 두지 않는다. 상장 폐지·이름 변경이 잦아서, **이름 규칙**으로 전체시세에서 그때그때
 * 거래대금 제일 큰 것을 고른다(레버리지·인버스·커버드콜·혼합은 뺀다). 그래서 「KODEX 반도체」가 「TIGER 반도체TOP10」
 * 으로 바뀌어도 화면은 산다. 신호등 점수에는 안 들어간다 — 보는 자리다.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { isTradingDay } from "./tradingDay.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { loadCloses, type DayBar } from "./dailyCloses.js";
import { etfAll, type EtfListRow } from "./routes/etf.js";
import { dropPhantomToday } from "./candleGuard.js";

const CHART = "/api/dostk/chart";

export type EtfFlowGroup = "지수" | "테마·업종" | "미국(국내상장)" | "자산·채권";

export interface EtfFlowRow {
  code: string;
  name: string;
  /** 무엇을 대표하나 — 「반도체」「금」 */
  label: string;
  group: EtfFlowGroup;
  price: number;
  /** 오늘 등락률(%) — 전체시세의 값 그대로 */
  d1: number | null;
  d5: number | null;
  d20: number | null;
  /** 최근 5일 평균 거래대금 ÷ 그 앞 20일 평균 (어제까지의 일봉) — 1.5 면 돈이 몰리는 중 */
  volRatio: number | null;
  /** 최근 5일 평균 거래대금(억원) */
  value5: number | null;
  /** 오늘 거래대금(억원) — 전체시세 어림 */
  todayValue: number;
}

interface Pick {
  group: EtfFlowGroup;
  label: string;
  re: RegExp;
}

/* 이름 규칙 — 대표 하나씩. 순서는 화면 순서 */
const PICKS: Pick[] = [
  { group: "지수", label: "코스피200", re: /^KODEX 200$|^TIGER 200$/ },
  { group: "지수", label: "코스닥150", re: /^KODEX 코스닥\s?150$|^TIGER 코스닥\s?150$/ },
  { group: "지수", label: "코스피 고배당", re: /고배당|배당성장/ },
  { group: "테마·업종", label: "반도체", re: /반도체/ },
  { group: "테마·업종", label: "소프트웨어·AI", re: /소프트웨어|인공지능|AI테크|AI플랫폼/ },
  { group: "테마·업종", label: "2차전지", re: /2차전지|이차전지/ },
  { group: "테마·업종", label: "자동차", re: /자동차/ },
  { group: "테마·업종", label: "바이오", re: /바이오|헬스케어/ },
  { group: "테마·업종", label: "은행", re: /은행/ },
  { group: "테마·업종", label: "증권", re: /증권/ },
  { group: "테마·업종", label: "조선", re: /조선/ },
  { group: "테마·업종", label: "방산", re: /방산|방위/ },
  { group: "테마·업종", label: "원전·전력", re: /원자력|원전|전력기기|전력/ },
  { group: "테마·업종", label: "게임·엔터", re: /게임|엔터|미디어|K-POP/ },
  { group: "테마·업종", label: "건설", re: /건설/ },
  { group: "테마·업종", label: "철강", re: /철강/ },
  { group: "테마·업종", label: "화학", re: /화학/ },
  { group: "테마·업종", label: "로봇", re: /로봇/ },
  { group: "테마·업종", label: "인터넷", re: /인터넷/ },
  { group: "미국(국내상장)", label: "나스닥100", re: /나스닥\s?100/ },
  { group: "미국(국내상장)", label: "S&P500", re: /S&P\s?500/ },
  { group: "미국(국내상장)", label: "미국 반도체", re: /미국반도체|필라델피아/ },
  { group: "미국(국내상장)", label: "미국 빅테크", re: /빅테크|테크TOP|미국테크/ },
  { group: "자산·채권", label: "금", re: /골드|금현물|KRX금/ },
  { group: "자산·채권", label: "은", re: /은선물|은현물/ },
  { group: "자산·채권", label: "달러", re: /달러선물/ },
  { group: "자산·채권", label: "원유", re: /WTI원유|원유선물/ },
  { group: "자산·채권", label: "구리", re: /구리/ },
  { group: "자산·채권", label: "미국 장기채", re: /미국채\s?30년|미국30년|미국채30/ },
  { group: "자산·채권", label: "미국 10년채", re: /미국채\s?10년|미국10년/ },
  { group: "자산·채권", label: "국고채", re: /국고채\s?10년|국고채10|국고채30/ },
  { group: "자산·채권", label: "리츠", re: /리츠|부동산인프라/ },
  { group: "자산·채권", label: "머니마켓(대기자금)", re: /머니마켓|MMF|CD금리|KOFR/ },
];
/** 대표에서 빼는 것 — 방향·구조가 다른 상품. 환헤지(H)는 구조가 아니라 안 뺀다(원유·은은 전부 (H)다) */
const NOT_PLAIN = /레버리지|인버스|2X|곱|커버드콜|혼합|채권혼합|월배당/;

/**
 * 대표 고르기 — 거래대금 제일 큰 것. **장 전엔 오늘 거래대금이 전부 0** 이라 동률이 나서 엉뚱한 게 뽑혔다
 * (9/17 07시: 반도체 → IBK K-AI반도체코어테크). 그래서 오늘·어제 중 큰 쪽으로 잰다 — 어제는 일봉 캐시(c×v).
 */
function pickOne(rows: EtfListRow[], p: Pick, lastValue: (code: string) => number, saved: string | undefined): EtfListRow | null {
  const m = rows.filter((r) => p.re.test(r.name));
  if (m.length === 0) return null;
  const plain = m.filter((r) => !NOT_PLAIN.test(r.name));
  const pool = plain.length > 0 ? plain : m;
  /* 장 전(거래대금 전부 0)이면 **장중에 저장해 둔 어제의 대표**를 그대로 — 일봉 캐시에 없는 ETF 는 어제 값도 모르니까 */
  if (pool.every((r) => r.tradeValue === 0) && saved) {
    const hit = pool.find((r) => r.code === saved);
    if (hit) return hit;
  }
  const size = (r: EtfListRow) => Math.max(r.tradeValue, lastValue(r.code));
  return pool.sort((a, b) => size(b) - size(a))[0];
}

/* 장중에 고른 대표를 파일에 남긴다 — 다음 날 장 전에 쓴다 */
const PICKS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "etfFlowPicks.json");
let savedPicks: Record<string, string> | null = null;
async function loadSavedPicks(): Promise<Record<string, string>> {
  if (savedPicks) return savedPicks;
  try {
    savedPicks = JSON.parse(await readFile(PICKS_FILE, "utf-8")) as Record<string, string>;
  } catch {
    savedPicks = {};
  }
  return savedPicks;
}
async function savePicks(picks: Record<string, string>): Promise<void> {
  savedPicks = picks;
  try {
    await mkdir(dirname(PICKS_FILE), { recursive: true });
    await writeFile(PICKS_FILE, JSON.stringify(picks), "utf-8");
  } catch {
    /* 못 남겨도 화면은 산다 */
  }
}

/* ── 일봉 — 캐시 먼저, 없으면 하루 한 번 받는다 ── */
const fetched = new Map<string, { day: string; bars: DayBar[] }>();

function kstDay(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}
function marketOpened(): boolean {
  const k = new Date(Date.now() + 9 * 3600_000);
  const dow = k.getUTCDay();
  /* 휴장일도 「안 열림」 — 한글날 10시에 asOf=오늘·전 종목 0% 로 나오던 것 (2026-09-18 전수검증 A17) */
  if (!isTradingDay(new Date(`${k.toISOString().slice(0, 10)}T12:00:00+09:00`))) return false;
  return dow !== 0 && dow !== 6 && k.getUTCHours() * 60 + k.getUTCMinutes() >= 9 * 60;
}
function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

async function barsOf(client: KiwoomClient, code: string): Promise<DayBar[]> {
  const cached = (await loadCloses()).bars?.[code];
  if (cached && cached.length >= 30) return cached;
  const today = kstDay();
  const hit = fetched.get(code);
  if (hit && hit.day === today) return hit.bars;
  const res = await client.request<Record<string, unknown>>(CHART, "ka10081", { stk_cd: code, base_dt: today, upd_stkpc_tp: "1" });
  const rows = dropPhantomToday((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]);
  const bars: DayBar[] = rows
    .map((r) => ({ d: String(r.dt ?? ""), o: Math.abs(n(r.open_pric)), h: Math.abs(n(r.high_pric)), l: Math.abs(n(r.low_pric)), c: Math.abs(n(r.cur_prc)), v: Math.abs(n(r.trde_qty)) }))
    .filter((b) => /^\d{8}$/.test(b.d) && b.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
  fetched.set(code, { day: today, bars });
  await new Promise((r) => setTimeout(r, 260));
  return bars;
}

/** 오늘을 뺀 어제까지의 일봉 — 거래대금 배수는 완결된 날로만 */
function settled(bars: DayBar[]): DayBar[] {
  const today = kstDay();
  return bars.length > 0 && bars[bars.length - 1].d === today ? bars.slice(0, -1) : bars;
}

function ratePct(last: number, base: number | undefined): number | null {
  return base && base > 0 ? Math.round(((last - base) / base) * 10000) / 100 : null;
}

function valueStats(bars: DayBar[]): { volRatio: number | null; value5: number | null } {
  const b = settled(bars);
  if (b.length < 25) return { volRatio: null, value5: null };
  const val = (x: DayBar) => x.c * x.v;
  const last5 = b.slice(-5).reduce((s, x) => s + val(x), 0) / 5;
  const prev20 = b.slice(-25, -5).reduce((s, x) => s + val(x), 0) / 20;
  return { volRatio: prev20 > 0 ? Math.round((last5 / prev20) * 100) / 100 : null, value5: Math.round(last5 / 1e8) };
}

/* ── ① 자금흐름 ── */
let flowCache: { at: number; rows: EtfFlowRow[] } | null = null;
let flowJob: Promise<{ at: number; rows: EtfFlowRow[] }> | null = null;

export async function etfFlow(client: KiwoomClient, opts: { fresh?: boolean } = {}): Promise<{ at: number; rows: EtfFlowRow[]; note: string; asOf: "오늘" | "어제" }> {
  const NOTE = "대표 ETF 는 이름 규칙으로 그때그때 거래대금 제일 큰 것을 고릅니다(레버리지·인버스·커버드콜 제외). 배수는 어제까지의 일봉, 오늘 등락·거래대금은 전체시세. 장 전에는 어제 등락.";
  /* 장 전(09:00 전·주말)에는 전체시세 등락이 전부 0 이라 「어제」를 보인다 — 0% 스물은 정보가 아니다 */
  const asOf: "오늘" | "어제" = marketOpened() ? "오늘" : "어제";
  /* 카드 ↻ 는 30초 지난 캐시만 버린다 — 연타로 전체시세(15쪽)를 되받지 않게 */
  const fresh = Boolean(opts.fresh) && (!flowCache || Date.now() - flowCache.at > 30_000);
  if (!fresh && flowCache && Date.now() - flowCache.at < 5 * 60_000) return { ...flowCache, note: NOTE, asOf };
  if (flowJob) return { ...(await flowJob), note: NOTE, asOf };
  flowJob = (async () => {
    const all = await etfAll(client, { fresh });
    const barsCache = (await loadCloses()).bars ?? {};
    const lastValue = (code: string): number => {
      const b = barsCache[code];
      const x = b && b.length > 0 ? b[b.length - 1] : null;
      return x ? Math.round((x.c * x.v) / 1e8) : 0;
    };
    const rows: EtfFlowRow[] = [];
    const used = new Set<string>();
    const saved = await loadSavedPicks();
    const picked: Record<string, string> = {};
    for (const p of PICKS) {
      const r = pickOne(all.filter((x) => !used.has(x.code)), p, lastValue, saved[p.label]);
      if (!r) continue;
      used.add(r.code);
      picked[p.label] = r.code;
      let bars: DayBar[] = [];
      try {
        bars = await barsOf(client, r.code);
      } catch {
        /* 못 받으면 오늘 값만 — null 은 「모른다」 */
      }
      const cs = bars.map((b) => b.c);
      if (marketOpened() && bars.length > 0 && bars[bars.length - 1].d !== kstDay() && r.price > 0) cs.push(r.price);
      const last = cs.length > 0 ? cs[cs.length - 1] : r.price;
      const { volRatio, value5 } = valueStats(bars);
      const settledBars = settled(bars);
      const yday = settledBars.length >= 2 ? ratePct(settledBars[settledBars.length - 1].c, settledBars[settledBars.length - 2].c) : null;
      rows.push({
        code: r.code,
        name: r.name,
        label: p.label,
        group: p.group,
        price: r.price,
        d1: asOf === "오늘" ? r.changeRate : yday,
        d5: cs.length >= 6 ? ratePct(last, cs[cs.length - 6]) : null,
        d20: cs.length >= 21 ? ratePct(last, cs[cs.length - 21]) : null,
        volRatio,
        value5,
        todayValue: r.tradeValue,
      });
    }
    /* 장중 거래대금으로 고른 것만 남긴다 — 장 전의 동률 추첨을 저장하면 그게 다음 날 「어제」가 된다 */
    if (asOf === "오늘" && rows.some((r) => r.todayValue > 0)) await savePicks(picked);
    flowCache = { at: Date.now(), rows };
    return flowCache;
  })().finally(() => {
    flowJob = null;
  });
  return { ...(await flowJob), note: NOTE, asOf };
}

/* ── ② 레버리지·인버스 심리 ── */
export interface SentimentDay {
  d: string;
  /** 레버리지 거래대금(억) */
  lev: number;
  /** 인버스 + 곱버스 거래대금(억) */
  inv: number;
  /** inv ÷ lev — 1 을 넘으면 하락 베팅 돈이 더 많다 */
  ratio: number | null;
}
export interface SentimentSide {
  market: "코스피" | "코스닥";
  names: { lev: string; inv: string[] };
  days: SentimentDay[];
  today: SentimentDay | null;
  /** 20일 평균 비율 — 오늘이 이보다 한참 위면 하락 베팅 과열 */
  avg20: number | null;
}

const SENT_PICKS = {
  코스피: { lev: /^KODEX 레버리지$/, inv: [/^KODEX 인버스$/, /^KODEX 200선물인버스2X$/] },
  코스닥: { lev: /^KODEX 코스닥\s?150\s?레버리지$/, inv: [/^KODEX 코스닥\s?150\s?선물인버스$/] },
} as const;

let sentCache: { at: number; sides: SentimentSide[] } | null = null;

/* (2026-09-18 전수검증 A16) 동시 호출이 전체시세 15쪽을 두 번 조회하지 않게 — etfFlow 와 같은 in-flight 잠금 */
let sentJob: Promise<{ at: number; sides: SentimentSide[]; note: string }> | null = null;
export async function etfSentiment(client: KiwoomClient, opts: { fresh?: boolean } = {}): Promise<{ at: number; sides: SentimentSide[]; note: string }> {
  if (sentJob) return sentJob;
  sentJob = etfSentimentCompute(client, opts).finally(() => {
    sentJob = null;
  });
  return sentJob;
}

async function etfSentimentCompute(client: KiwoomClient, opts: { fresh?: boolean } = {}): Promise<{ at: number; sides: SentimentSide[]; note: string }> {
  const NOTE =
    "개인이 방향에 거는 돈 — 인버스·곱버스 거래대금을 레버리지 거래대금으로 나눈 것. 비율이 20일 평균을 크게 넘으면 하락 베팅이 몰린 것이라 역발상 재료, 반대로 레버리지만 뜨거우면 상승 추격 과열. 어제까지는 일봉, 오늘은 전체시세 어림.";
  const fresh = Boolean(opts.fresh) && (!sentCache || Date.now() - sentCache.at > 30_000);
  if (!fresh && sentCache && Date.now() - sentCache.at < 5 * 60_000) return { ...sentCache, note: NOTE };
  const all = await etfAll(client, { fresh });
  const sides: SentimentSide[] = [];
  for (const market of ["코스피", "코스닥"] as const) {
    const p = SENT_PICKS[market];
    const lev = all.find((r) => p.lev.test(r.name)) ?? null;
    const invs = p.inv.map((re) => all.find((r) => re.test(r.name))).filter((r): r is EtfListRow => Boolean(r));
    if (!lev || invs.length === 0) continue;
    const levBars = settled(await barsOf(client, lev.code).catch(() => [] as DayBar[]));
    const invBars = await Promise.all(invs.map((r) => barsOf(client, r.code).catch(() => [] as DayBar[])));
    const byDay = new Map<string, SentimentDay>();
    for (const b of levBars.slice(-20)) byDay.set(b.d, { d: b.d, lev: Math.round((b.c * b.v) / 1e8), inv: 0, ratio: null });
    for (const bars of invBars) for (const b of settled(bars)) {
      const row = byDay.get(b.d);
      if (row) row.inv += Math.round((b.c * b.v) / 1e8);
    }
    const days = [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d));
    for (const d of days) d.ratio = d.lev > 0 ? Math.round((d.inv / d.lev) * 100) / 100 : null;
    const ratios = days.map((d) => d.ratio).filter((x): x is number => x !== null);
    const avg20 = ratios.length > 0 ? Math.round((ratios.reduce((s, x) => s + x, 0) / ratios.length) * 100) / 100 : null;
    const today: SentimentDay | null = marketOpened()
      ? { d: kstDay(), lev: lev.tradeValue, inv: invs.reduce((s, r) => s + r.tradeValue, 0), ratio: lev.tradeValue > 0 ? Math.round((invs.reduce((s, r) => s + r.tradeValue, 0) / lev.tradeValue) * 100) / 100 : null }
      : null;
    sides.push({ market, names: { lev: lev.name, inv: invs.map((r) => r.name) }, days, today, avg20 });
  }
  sentCache = { at: Date.now(), sides };
  return { ...sentCache, note: NOTE };
}
