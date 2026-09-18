/**
 * **돈의 흐름 — 「지금」** (2026-09-17, 벤티지: "마켓브리핑·흐름 메뉴를 진짜 돈의 흐름을 추적하는 기능으로.
 * 직장인·단타·스윙·종배 트레이더에게 가장 귀중한 정보를 가장 효율적으로. 개인계좌·ETF 계좌도 참고하게").
 *
 * 한 화면, 위에서 아래로 30초:
 *   ① 판정 띠   — 외인·기관 오늘 방향 · 프로그램 30분 · 레버리지/인버스 심리 · 거래대금 진행률 · 체온 → 들어오는 장/빠지는 장/회전
 *   ② 돈이 가는 곳 — 테마 로테이션(부상·지속) 대표 종목 · 국내 ETF 배수 · 어젯밤 미국 섹터
 *   ③ 지금 사는 손 — 실시간 저장소(175)의 30분 거래대금 급증 × 체결강도, 거래대금 상위 100 은 오늘 배수로
 *   ④ 내 계좌 렌즈 — 키움 잔고 + 수동 계좌(ETF·연금) 보유마다 「돈이 들어옴/빠짐/조용」
 *   ⑤ 시간대 플랜 — 지금 시각의 할 일만
 *
 * **재료는 전부 이미 받는 것**이다 — 섹션 캐시·실시간 저장소·마크 파일·ETF 캐시. 새로 도는 조회는 잔고(kt00018)와
 * 계좌 종목의 한투 잠정치(5분 캐시, ≤20종목)뿐. 결과는 60초 캐시, 있으면 옛 값을 주고 뒤에서 갱신한다(섹션과 같은 방식).
 * 신호등 점수엔 아무것도 안 들어간다 — 보는 자리다.
 */
import type { KiwoomClient } from "./kiwoomClient.js";
import { getSection, getProgramTrades, viTodayMap, type MarketFlow, type ProgramRow, type ViToday } from "./marketOverview.js";
import { marketThermo, themeRotation, type RotationTheme } from "./marketLens.js";
import { themeStrength } from "./themeStrength.js";
import { etfFlow, etfSentiment, type EtfFlowRow } from "./etfFlow.js";
import { usEtfFlow } from "./usMarket.js";
import { peekRealtime } from "./realtimeHub.js";
import { tradeValueTop } from "./signalScreen.js";
import { investorEstimate } from "./hantooSchedule.js";
import { loadStockMarks, type StockMark } from "./stockMarks.js";
import { evaluateAccounts } from "./manualAccounts.js";
import { loadCloseBetScan } from "./closeBetScan.js";
import { indexDetail } from "./indexDetail.js";
import { MIN } from "./marketHours.js";
import { getStockIndex } from "./stockListCache.js";
import { etfAll } from "./routes/etf.js";
import { readFile, writeFile, appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pushNotice, stockLink } from "./notifyCenter.js";
import { sendTelegram } from "./telegram.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");

/* ═══════════════ 모양 ═══════════════ */

export type SlotKey = "night" | "pre" | "open" | "morning" | "lunch" | "afternoon" | "closing" | "auction" | "gap" | "after";
export interface Slot {
  key: SlotKey;
  label: string;
  /** 지금 이 시각에 맞는 한마디 */
  advice: string;
}

export interface VerdictPart {
  key: "flow" | "program" | "sentiment" | "turnover" | "thermo";
  label: string;
  /** +1 들어옴 · −1 빠짐 · 0 중립 · null 모름 */
  sign: 1 | -1 | 0 | null;
  text: string;
}
export interface Verdict {
  kind: "in" | "out" | "rotate" | "unknown";
  line: string;
  parts: VerdictPart[];
}

export interface WhereTheme {
  key: string;
  name: string;
  changeRate: number;
  m1: number | null;
  tradeValue: number;
  /** 대표 종목 둘 — 거래대금 순 */
  stocks: { code: string; name: string; changeRate: number | null }[];
}

export interface BuyerRow {
  code: string;
  name: string;
  price: number;
  rate: number | null;
  /** 최근 30분 거래대금(억) — 실시간 저장소 종목만 */
  value30: number | null;
  /** 30분 거래대금 ÷ 오늘 평균 30분 거래대금 (실시간) — 또는 오늘 거래대금 ÷ (20일 평균 × 진행률) (순위판 종목) */
  boost: number | null;
  boostKind: "30분" | "오늘";
  /** 체결강도 */
  strength: number | null;
  /** 오늘 거래대금(억) */
  todayValue: number | null;
  tags: string[];
  /** 속한 로테이션 테마 (있으면) */
  theme: string | null;
  /** 60일 고가 대비 위치(%) — 마크 파일(어제 마감) */
  high60: number | null;
}

/**
 * 사는 손 세 갈래 (2026-09-17 저녁 — "이미 튄 종목이 1위면 추격 금지 목록이지 매수 목록이 아니다").
 *   quiet    — 🧲 조용히 담는 중: 등락 −1~+3% 인데 배수 1.3↑·체결강도 105↑(모르면 통과 — 순위판 종목은 강도가 없다, 09-18 A13) — 단타·스윙이 볼 자리
 *   breakout — 🚪 돌파 임박: 60일 고가 −3% 안, 아직 +5% 전
 *   hot      — 🔥 이미 튐: +5% 이상이거나 VI — 추격 금지
 */
export interface BuyerBuckets {
  quiet: BuyerRow[];
  breakout: BuyerRow[];
  hot: BuyerRow[];
}

export type FlowVerdict = "in" | "out" | "quiet";
export interface AccountRow {
  code: string;
  name: string;
  /** 어느 계좌 — 키움 / 수동 계좌 이름 */
  account: string;
  isEtf: boolean;
  qty: number;
  price: number;
  rate: number | null;
  /** 보유 수익률(%) */
  pnlRate: number | null;
  /** 평가금액(만원) */
  valueMan: number | null;
  /** 로테이션 위치 */
  rotation: "주도" | "부상" | "휴식" | null;
  theme: string | null;
  /** 한투 잠정 외인·기관 합(주) — 마지막 집계 */
  est: { time: string; fgn: number; orgn: number } | null;
  boost: number | null;
  strength: number | null;
  tags: string[];
  verdict: FlowVerdict;
  why: string;
}

export interface PlanItem {
  code?: string;
  name: string;
  text: string;
}
export interface Plan {
  slot: SlotKey;
  title: string;
  items: PlanItem[];
  note: string;
  /** 14:30 교차 — 종배 후보 ∩ 사는 손 ∩ 마크(슈퍼·쌍끌이·외인3칸). 마감 전에만 */
  cross?: PlanItem[];
}

/** 오늘 판정 추세 한 점 */
export interface VerdictPoint {
  hhmm: string;
  kind: Verdict["kind"];
  score: number;
}
/** 판정 성적표 — 10:00·13:30 판정 vs 그날 코스피 마감 */
export interface VerdictRecord {
  /** 채점한 날 수 */
  days: number;
  hit1000: number;
  hit1330: number;
  n1000: number;
  n1330: number;
  today: { t1000: Verdict["kind"] | null; t1330: Verdict["kind"] | null };
  note: string;
}

export interface MoneyNow {
  at: number;
  stale: boolean;
  slot: Slot;
  verdict: Verdict;
  trend: VerdictPoint[];
  record: VerdictRecord;
  buckets: BuyerBuckets;
  where: {
    fresh: WhereTheme[];
    lead: WhereTheme[];
    rest: WhereTheme[];
    krEtf: { label: string; name: string; code: string; d1: number | null; volRatio: number | null }[];
    usEtf: { symbol: string; name: string; d1: number | null; volRatio: number | null }[];
    ready: boolean;
  };
  buyers: BuyerRow[];
  account: { rows: AccountRow[]; kiwoomOk: boolean; manualOk: boolean; note: string };
  plan: Plan;
  errors: string[];
}

/* ═══════════════ 시각 ═══════════════ */

function kst(): { date: string; minute: number; day: number; hhmm: string } {
  const d = new Date(Date.now() + 9 * 3600_000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { date: d.toISOString().slice(0, 10), minute, day: d.getUTCDay(), hhmm: d.toISOString().slice(11, 16) };
}

function slotOf(minute: number, weekend: boolean): Slot {
  if (weekend) return { key: "night", label: "휴장", advice: "주말 — 지난 장 복기와 다음 주 일정. 아래 값은 마지막 장 기준입니다" };
  if (minute < 8 * 60) return { key: "night", label: "장 전", advice: "어젯밤 미국 섹터 ETF 와 오늘 일정부터. 국내 값은 어제 마감 기준" };
  if (minute < MIN.nxtPreClose) return { key: "pre", label: "NXT 프리", advice: "프리마켓 갭은 얇은 호가 — 방향만 보고 추격하지 않기. 09:00 시초가 확인" };
  /* 08:50~09:00 은 NXT 프리도 끝나 어느 시장도 안 연다 (2026-09-18 전수검증 A24) — 예전엔 09:00 까지 「프리」였다 */
  if (minute < 9 * 60) return { key: "pre", label: "개장 직전", advice: "NXT 프리도 끝났고 정규장은 09:00 — 지금은 어느 시장도 안 엽니다. 예상 시초가와 갭만 확인" };
  if (minute < 9 * 60 + 30) return { key: "open", label: "개장 30분", advice: "갭·VI 가 쏟아지는 시간. 첫 30분 추격 금지 — 09:30 외인·기관 잠정치가 나온 뒤 판단" };
  if (minute < 11 * 60 + 30) return { key: "morning", label: "오전", advice: "추세가 정해지는 시간. 부상 테마의 대표 종목이 신고가를 지키는지, 사는 손이 이어지는지" };
  if (minute < 13 * 60) return { key: "lunch", label: "점심", advice: "거래가 얇아 값이 흔들린다 — 새 진입보다 오전 포지션 점검. 11:20 잠정치로 방향 재확인" };
  if (minute < 14 * 60 + 30) return { key: "afternoon", label: "오후", advice: "13:20 잠정치와 프로그램 방향이 오후를 정한다. 오전 주도가 이어지면 붙고, 꺾이면 덜기" };
  if (minute < 15 * 60 + 20) return { key: "closing", label: "마감 전", advice: "종가배팅 시간 — 14:30 잠정치·종배 후보 확인. 15:20 동시호가 전에 주문 정리" };
  if (minute <= 15 * 60 + 30) return { key: "auction", label: "동시호가", advice: "15:20~15:30 단일가 — 체결가가 크게 움직일 수 있다. 시장가 주의" };
  if (minute < 16 * 60) return { key: "gap", label: "공백", advice: "KRX 는 쉬고 NXT 만 단일가. 16:00 애프터 개장까지 판정 대기" };
  if (minute <= 20 * 60) return { key: "after", label: "애프터", advice: "정규장 결과가 애프터에서 이어지는지 — 내 계좌 종목의 애프터 반응과 슈퍼신호등 편입" };
  return { key: "night", label: "마감", advice: "오늘 정리 — 마감 뒤 정리 결과·마크 집계·내일 일정" };
}

/** 정규장 거래대금이 시각별로 얼마나 찼나 (앞이 무겁다) */
function turnoverFraction(minute: number): number {
  const pts: [number, number][] = [
    [9 * 60, 0],
    [9 * 60 + 30, 0.14],
    [10 * 60, 0.24],
    [11 * 60, 0.38],
    [12 * 60, 0.48],
    [13 * 60, 0.57],
    [14 * 60, 0.7],
    [15 * 60, 0.86],
    [15 * 60 + 30, 1],
  ];
  if (minute <= pts[0][0]) return 0;
  if (minute >= pts[pts.length - 1][0]) return 1;
  for (let i = 1; i < pts.length; i += 1) {
    if (minute <= pts[i][0]) {
      const [m0, f0] = pts[i - 1];
      const [m1, f1] = pts[i];
      return f0 + ((minute - m0) / (m1 - m0)) * (f1 - f0);
    }
  }
  return 1;
}

function secOf(t: string): number {
  return Number(t.slice(0, 2)) * 3600 + Number(t.slice(2, 4)) * 60 + Number(t.slice(4, 6));
}
function fid(v: Record<string, string> | undefined, id: string): number | null {
  const raw = v?.[id];
  if (raw === undefined) return null;
  const n = Number(String(raw).replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}
function eok(v: number): string {
  return Math.abs(v) >= 10000 ? `${(v / 10000).toFixed(1)}조` : `${Math.round(v).toLocaleString("ko-KR")}억`;
}
function signed(v: number): string {
  return `${v > 0 ? "+" : ""}${eok(v)}`;
}

/* ═══════════════ ① 판정 ═══════════════ */

let lastScore = 0;

/* ── 판정 기록 · 추세 · 성적표 (2026-09-17 저녁 — "판정을 믿을 근거가 없다") ── */
const VERDICT_FILE = join(DATA_DIR, "moneyNowVerdicts.jsonl");
interface VerdictLine {
  day: string;
  hhmm: string;
  kind: Verdict["kind"];
  score: number;
}
let verdictLines: VerdictLine[] | null = null;
let lastRecordedMin = -1;
let lastRecordedDay = ""; // (2026-09-18 전수검증 A5) 날짜 없이 분만 견주면 다음 날 545−930<10 으로 영영 안 적힌다

async function loadVerdictLines(): Promise<VerdictLine[]> {
  if (verdictLines) return verdictLines;
  try {
    verdictLines = (await readFile(VERDICT_FILE, "utf-8"))
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as VerdictLine;
        } catch {
          return null;
        }
      })
      .filter((x): x is VerdictLine => x !== null);
  } catch {
    verdictLines = [];
  }
  return verdictLines;
}

/** 장중 10분에 한 점 — 하루 40점쯤. 판정이 「아까보다 좋아지나」를 그리는 재료 */
async function recordVerdict(day: string, minute: number, hhmm: string, v: Verdict): Promise<void> {
  if (minute < 9 * 60 || minute > 15 * 60 + 30 || v.kind === "unknown") return;
  if (lastRecordedDay === day && lastRecordedMin >= 0 && minute - lastRecordedMin < 10) return;
  const lines = await loadVerdictLines();
  const last = lines[lines.length - 1];
  if (last && last.day === day && minute - (Number(last.hhmm.slice(0, 2)) * 60 + Number(last.hhmm.slice(3, 5))) < 10) return;
  const line: VerdictLine = { day, hhmm, kind: v.kind, score: lastScore };
  lines.push(line);
  lastRecordedMin = minute;
  lastRecordedDay = day;
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await appendFile(VERDICT_FILE, JSON.stringify(line) + "\n", "utf-8");
  } catch {
    /* 못 적어도 화면은 산다 */
  }
}

/** 그날 10:00·13:30 직후의 첫 판정 */
function pickAt(lines: VerdictLine[], hhmm: string, until: string): Verdict["kind"] | null {
  const hit = lines.find((l) => l.hhmm >= hhmm && l.hhmm <= until);
  return hit?.kind ?? null;
}

async function buildRecord(client: KiwoomClient, day: string): Promise<{ trend: VerdictPoint[]; record: VerdictRecord }> {
  const lines = await loadVerdictLines();
  const today = lines.filter((l) => l.day === day);
  const trend = today.map((l) => ({ hhmm: l.hhmm, kind: l.kind, score: l.score })).slice(-12);
  const byDay = new Map<string, VerdictLine[]>();
  for (const l of lines) if (l.day !== day) byDay.set(l.day, [...(byDay.get(l.day) ?? []), l]);
  let n1000 = 0;
  let hit1000 = 0;
  let n1330 = 0;
  let hit1330 = 0;
  let days = 0;
  try {
    const c = (await indexDetail(client, "001", "day")).candles;
    const chgOf = new Map<string, number>();
    for (let i = 1; i < c.length; i += 1) if (c[i - 1].close > 0) chgOf.set(c[i].dt, ((c[i].close - c[i - 1].close) / c[i - 1].close) * 100);
    const hit = (k: Verdict["kind"], chg: number) => (k === "in" ? chg >= 0.3 : k === "out" ? chg <= -0.3 : k === "rotate" ? Math.abs(chg) < 0.5 : false);
    for (const [d, ls] of [...byDay.entries()].slice(-20)) {
      const chg = chgOf.get(d.replace(/-/g, ""));
      if (chg === undefined) continue;
      days += 1;
      const a = pickAt(ls, "10:00", "10:40");
      const b = pickAt(ls, "13:30", "14:10");
      if (a && a !== "unknown") {
        n1000 += 1;
        if (hit(a, chg)) hit1000 += 1;
      }
      if (b && b !== "unknown") {
        n1330 += 1;
        if (hit(b, chg)) hit1330 += 1;
      }
    }
  } catch {
    /* 지수 일봉을 못 받으면 성적표는 비운다 */
  }
  return {
    trend,
    record: {
      days,
      hit1000,
      hit1330,
      n1000,
      n1330,
      today: { t1000: pickAt(today, "10:00", "10:40"), t1330: pickAt(today, "13:30", "14:10") },
      note: days === 0 ? "판정을 오늘부터 쌓습니다 — 며칠 지나면 10:00·13:30 판정이 마감과 맞았는지 적중률이 붙습니다" : `최근 ${days}거래일 — 「들어옴」은 코스피 +0.3%↑, 「빠짐」은 −0.3%↓, 「회전」은 ±0.5% 안이면 적중`,
    },
  };
}

async function buildVerdict(client: KiwoomClient, minute: number, errors: string[]): Promise<Verdict> {
  const parts: VerdictPart[] = [];
  const inSession = minute >= 9 * 60 && minute <= 15 * 60 + 30;
  /*
   * (2026-09-18 전수검증 #2) 09:00 전엔 수급·프로그램이 **프리마켓 몇백억**이다 — 정규장 수조 원과 같은 저울에
   * 올리면 08:05 에 「들어옴 +1」이 찍힌다. 장 전엔 값은 보여 주되 판정(sign)엔 안 넣는다. 15:30 뒤는 그날 확정치라 그대로.
   */
  const preOpen = minute < 9 * 60;

  /* 외인·기관 오늘 (섹션 캐시 — 억원) */
  try {
    const flow = (await getSection("flow", client)).data as MarketFlow | null;
    if (flow) {
      const f = flow.kospi.foreign + flow.kosdaq.foreign;
      const i = flow.kospi.institution + flow.kosdaq.institution;
      const sign: 1 | -1 | 0 = f > 0 && i > 0 ? 1 : f < 0 && i < 0 ? -1 : 0;
      parts.push({ key: "flow", label: "외인·기관 오늘", sign: preOpen ? null : sign, text: `외인 ${signed(f)} · 기관 ${signed(i)} (코스피+코스닥)${preOpen ? " · 장 전 값이라 판정엔 안 넣음" : ""}` });
    } else parts.push({ key: "flow", label: "외인·기관 오늘", sign: null, text: "아직 없음" });
  } catch (e) {
    errors.push("수급");
    parts.push({ key: "flow", label: "외인·기관 오늘", sign: null, text: "못 받음" });
  }

  /* 프로그램 30분 (코스피, 시간대별 누적의 차) */
  try {
    /* ka90005 는 최신이 앞이고 매수·매도가 **누적**(백만원)이다. allNet 칸은 0 으로 오니(실측 9/17) 매수−매도로 낸다 */
    const rows = (await getProgramTrades(client, "kospi", "time")).filter((r) => /^\d{6}$/.test(r.time)).sort((a, b) => a.time.localeCompare(b.time));
    const netOf = (r: ProgramRow) => (r.allNet !== 0 ? r.allNet : r.allBuy - r.allSell);
    if (rows.length >= 2) {
      const last = rows[rows.length - 1];
      const target = secOf(last.time) - 1800;
      let base: ProgramRow | null = null;
      for (const r of rows) if (secOf(r.time) <= target) base = r;
      const d30 = base ? netOf(last) - netOf(base) : null;
      const toEok = (v: number) => v / 100; // 백만원 → 억
      if (d30 !== null) {
        parts.push({ key: "program", label: "프로그램 30분", sign: preOpen ? null : d30 > 50 * 100 ? 1 : d30 < -50 * 100 ? -1 : 0, text: `${signed(toEok(d30))} (${base!.time.slice(0, 2)}:${base!.time.slice(2, 4)}~${last.time.slice(0, 2)}:${last.time.slice(2, 4)}) · 오늘 ${signed(toEok(netOf(last)))}` });
      } else parts.push({ key: "program", label: "프로그램 30분", sign: null, text: `오늘 ${signed(toEok(netOf(last)))} · 30분 전 값 없음` });
    } else parts.push({ key: "program", label: "프로그램 30분", sign: null, text: inSession ? "아직 없음" : "장 밖" });
  } catch {
    errors.push("프로그램");
    parts.push({ key: "program", label: "프로그램 30분", sign: null, text: "못 받음" });
  }

  /* 레버리지·인버스 심리 */
  try {
    const s = await etfSentiment(client);
    const k = s.sides.find((x) => x.market === "코스피");
    const cur = k ? (k.today ?? k.days[k.days.length - 1]) : null;
    if (k && cur && cur.ratio !== null && k.avg20 !== null) {
      const x = cur.ratio / k.avg20;
      /* 하락 베팅 과열은 역발상 재료(+), 상승 추격 과열은 (−) */
      const sign: 1 | -1 | 0 = x >= 1.4 ? 1 : x <= 0.65 ? -1 : 0;
      parts.push({ key: "sentiment", label: "인버스÷레버리지", sign, text: `${cur.ratio.toFixed(2)} (20일 ${k.avg20.toFixed(2)}) — ${x >= 1.4 ? "하락 베팅 과열, 역발상 자리" : x <= 0.65 ? "상승 추격 과열" : "평소 범위"}` });
    } else parts.push({ key: "sentiment", label: "인버스÷레버리지", sign: null, text: "값 없음" });
  } catch {
    errors.push("심리");
    parts.push({ key: "sentiment", label: "인버스÷레버리지", sign: null, text: "못 받음" });
  }

  /* 거래대금 진행률 — 오늘 누적 ÷ (20일 평균 × 시각별 진행 비율) */
  try {
    const { date } = kst();
    const c = (await indexDetail(client, "001", "day")).candles;
    const todayKey = date.replace(/-/g, "");
    const last = c[c.length - 1];
    if (last && last.dt === todayKey && inSession) {
      const prev = c.slice(-21, -1).filter((x) => x.tradeValue > 0);
      const avg20 = prev.length > 0 ? prev.reduce((s, x) => s + x.tradeValue, 0) / prev.length : 0;
      const frac = turnoverFraction(minute);
      const ratio = avg20 > 0 && frac > 0.05 ? last.tradeValue / (avg20 * frac) : null;
      parts.push({
        key: "turnover",
        label: "거래대금 진행률",
        sign: ratio === null ? null : ratio >= 1.15 ? 1 : ratio <= 0.8 ? -1 : 0,
        text: ratio === null ? `오늘 ${eok(last.tradeValue)}` : `평소 같은 시각의 ${Math.round(ratio * 100)}% (오늘 ${eok(last.tradeValue)} · 20일 평균 ${eok(avg20)})`,
      });
    } else if (last) {
      parts.push({ key: "turnover", label: "거래대금", sign: null, text: `${last.dt.slice(4, 6)}/${last.dt.slice(6, 8)} ${eok(last.tradeValue)} (장 밖)` });
    }
  } catch {
    errors.push("거래대금");
  }

  /* 체온 — 지금 오른 종목 비율 */
  try {
    const t = await marketThermo();
    const rise = t.riseNow ?? (t.series.rise.length > 0 ? t.series.rise[t.series.rise.length - 1] : null);
    if (rise !== null) parts.push({ key: "thermo", label: "오른 종목 비율", sign: rise >= 55 ? 1 : rise <= 40 ? -1 : 0, text: `${Math.round(rise)}%${t.riseNow === null ? " (어제 마감)" : ""}` });
  } catch {
    errors.push("체온");
  }

  const known = parts.filter((p) => p.sign !== null);
  const score = known.reduce((s, p) => s + (p.sign ?? 0), 0);
  let kind: Verdict["kind"] = "unknown";
  if (known.length >= 2) kind = score >= 2 ? "in" : score <= -2 ? "out" : "rotate";
  lastScore = score;
  const line =
    kind === "in"
      ? "돈이 들어오는 장 — 사는 손이 이어진다. 주도·부상 테마의 대표 종목이 자리"
      : kind === "out"
        ? "돈이 빠지는 장 — 파는 손이 우세. 새 진입보다 현금·포지션 축소"
        : kind === "rotate"
          ? "회전만 도는 장 — 지수는 조용하고 자리만 바뀐다. 부상 테마와 빠지는 테마를 갈라 보기"
          : "판정 재료가 모자란다 — 장이 열리면 채워진다";
  return { kind, line, parts };
}

/* ═══════════════ ② 돈이 가는 곳 ═══════════════ */

async function buildWhere(client: KiwoomClient, errors: string[]): Promise<{ where: MoneyNow["where"]; themeOf: Map<string, { name: string; pos: "주도" | "부상" | "휴식" }> }> {
  const themeOf = new Map<string, { name: string; pos: "주도" | "부상" | "휴식" }>();
  let fresh: WhereTheme[] = [];
  let lead: WhereTheme[] = [];
  let rest: WhereTheme[] = [];
  let ready = false;
  try {
    const [rot, ts] = await Promise.all([themeRotation(), themeStrength("kr")]);
    ready = rot.ready;
    const byKey = new Map(ts.themes.map((t) => [t.key, t]));
    const enrich = (r: RotationTheme, pos: "주도" | "부상" | "휴식"): WhereTheme => {
      const t = byKey.get(r.key);
      const stocks = [...(t?.stocks ?? [])]
        .sort((a, b) => (b.tradeValue ?? 0) - (a.tradeValue ?? 0))
        .slice(0, 2)
        .map((s) => ({ code: s.code, name: s.name, changeRate: s.changeRate }));
      for (const s of t?.stocks ?? []) if (!themeOf.has(s.code)) themeOf.set(s.code, { name: r.name, pos });
      return { key: r.key, name: r.name, changeRate: r.changeRate, m1: r.m1, tradeValue: r.tradeValue, stocks };
    };
    fresh = rot.fresh.slice(0, 4).map((r) => enrich(r, "부상"));
    lead = rot.lead.slice(0, 4).map((r) => enrich(r, "주도"));
    rest = rot.rest.slice(0, 3).map((r) => enrich(r, "휴식"));
  } catch {
    errors.push("로테이션");
  }
  let krEtf: MoneyNow["where"]["krEtf"] = [];
  try {
    const f = await etfFlow(client);
    krEtf = f.rows
      .filter((r) => r.group === "테마·업종" && r.d1 !== null)
      .sort((a, b) => (b.d1 ?? 0) - (a.d1 ?? 0))
      .slice(0, 3)
      .map((r: EtfFlowRow) => ({ label: r.label, name: r.name, code: r.code, d1: r.d1, volRatio: r.volRatio }));
  } catch {
    errors.push("국내 ETF");
  }
  let usEtf: MoneyNow["where"]["usEtf"] = [];
  try {
    const u = await usEtfFlow();
    const sec = u.rows.filter((r) => r.group === "섹터" && r.d1 !== null).sort((a, b) => (b.d1 ?? 0) - (a.d1 ?? 0));
    usEtf = [...sec.slice(0, 2), ...sec.slice(-2)].map((r) => ({ symbol: r.symbol, name: r.name, d1: r.d1, volRatio: r.volRatio }));
  } catch {
    errors.push("미국 ETF");
  }
  return { where: { fresh, lead, rest, krEtf, usEtf, ready }, themeOf };
}

/* ═══════════════ ③ 지금 사는 손 ═══════════════ */

interface LiveStat {
  price: number;
  rate: number | null;
  strength: number | null;
  value30: number | null;
  boost: number | null;
  todayValue: number | null;
}

/** 실시간 저장소의 하루치 30초 샘플에서 「최근 30분에 돈이 얼마나 몰렸나」 */
function liveStatOf(series: { t: string; v: Record<string, string> }[], minute: number): LiveStat | null {
  const pts = series.filter((p) => String(p.v["9081"] ?? "").toUpperCase() !== "NXT" && /^\d{6}$/.test(p.t));
  if (pts.length < 2) return null;
  const last = pts[pts.length - 1];
  const price = Math.abs(fid(last.v, "10") ?? 0);
  const cum = fid(last.v, "13");
  if (!price || cum === null) return null;
  const nowSec = secOf(last.t);
  const target = nowSec - 1800;
  let base: (typeof pts)[number] | null = null;
  for (const p of pts) if (secOf(p.t) <= target) base = p;
  const cum30 = base ? fid(base.v, "13") : pts[0] && nowSec - secOf(pts[0].t) > 600 ? fid(pts[0].v, "13") : null;
  const vol30 = cum30 !== null ? Math.max(0, cum - cum30) : null;
  const elapsedMin = Math.max(5, Math.min(390, (Math.min(nowSec, 15 * 3600 + 30 * 60) - 9 * 3600) / 60));
  const avgPer30 = cum / (elapsedMin / 30);
  const value30 = vol30 !== null ? (vol30 * price) / 1e8 : null;
  const boost = vol30 !== null && avgPer30 > 0 ? vol30 / avgPer30 : null;
  return {
    price,
    rate: fid(last.v, "12"),
    strength: fid(last.v, "228"),
    value30: value30 === null ? null : Math.round(value30 * 10) / 10,
    boost: boost === null ? null : Math.round(boost * 100) / 100,
    todayValue: Math.round((cum * price) / 1e8),
  };
}

function markTags(m: StockMark | null | undefined, vi: ViToday | undefined): string[] {
  const tags: string[] = [];
  if (!m && !vi) return tags;
  if (m?.twin) tags.push("🧲🧲 쌍끌이");
  else if (m?.fgn3) tags.push("🧲 외인3칸");
  if (m?.newHigh250) tags.push("250일 신고가");
  else if (m?.high60 !== null && m?.high60 !== undefined && m.high60 >= 99) tags.push("60일 신고가");
  if (m?.trend) tags.push("정배열");
  if (vi) tags.push(`VI ${vi.count}회`);
  return tags;
}

let topCache: { at: number; rows: Awaited<ReturnType<typeof tradeValueTop>> } | null = null;

async function buildBuyers(
  client: KiwoomClient,
  minute: number,
  themeOf: Map<string, { name: string; pos: "주도" | "부상" | "휴식" }>,
  marks: Record<string, StockMark> | null,
  vi: Map<string, ViToday> | null,
  errors: string[],
): Promise<{ buyers: BuyerRow[]; buckets: BuyerBuckets; pool: BuyerRow[]; liveOf: Map<string, LiveStat> }> {
  const liveOf = new Map<string, LiveStat>();
  const store = peekRealtime().store;
  const names = await getStockIndex(client).catch(() => new Map<string, { name: string }>());
  const rows: BuyerRow[] = [];
  const seen = new Set<string>();
  const inSession = minute >= 9 * 60 && minute <= 15 * 60 + 30;

  if (store) {
    for (const { key } of store.summary) {
      if (!key.startsWith("0B:")) continue;
      const item = key.slice(3);
      const code = item.replace(/_(AL|NX)$/i, "");
      if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
      const st = liveStatOf(store.getSeries("0B", item), minute);
      if (!st) continue;
      liveOf.set(code, st);
      seen.add(code);
      if (st.boost === null) continue;
      rows.push({
        code,
        name: names.get(code)?.name ?? code,
        price: st.price,
        rate: st.rate,
        value30: st.value30,
        boost: st.boost,
        boostKind: "30분",
        strength: st.strength,
        todayValue: st.todayValue,
        tags: markTags(marks?.[code], vi?.get(code)),
        theme: themeOf.get(code)?.name ?? null,
        high60: marks?.[code]?.high60 ?? null,
      });
    }
  }

  /* 거래대금 상위 100 — 실시간에 없는 종목은 오늘 거래대금 ÷ (20일 평균 × 진행률) */
  try {
    if (!topCache || Date.now() - topCache.at > 120_000) topCache = { at: Date.now(), rows: await tradeValueTop(client, "000", 100) };
    const frac = Math.max(0.05, turnoverFraction(minute));
    for (const c of topCache.rows) {
      if (seen.has(c.code)) continue;
      seen.add(c.code);
      const m = marks?.[c.code];
      /* ka10032 거래대금은 **백만원** — 억으로 (실측: 비츠로테크 72,055 → 720억) */
      const todayEok = c.tradeValue / 100;
      const avg20 = m && m.volEok && m.volRatio && m.volRatio > 0 ? m.volEok / m.volRatio : null;
      const boost = inSession && avg20 && avg20 > 0 && todayEok > 0 ? Math.round((todayEok / (avg20 * frac)) * 100) / 100 : null;
      if (boost === null) continue;
      rows.push({
        code: c.code,
        name: c.name,
        price: c.price,
        rate: c.changeRate,
        value30: null,
        boost,
        boostKind: "오늘",
        strength: null,
        todayValue: Math.round(todayEok),
        tags: markTags(m, vi?.get(c.code)),
        theme: themeOf.get(c.code)?.name ?? null,
        high60: m?.high60 ?? null,
      });
    }
  } catch {
    errors.push("거래대금 상위");
  }

  /* 점수 — 배수가 첫째, 체결강도·오늘 거래대금이 보조. 얇은 것(오늘 30억 미만)은 뺀다 */
  const score = (r: BuyerRow) => (r.boost ?? 0) * (r.strength !== null && r.strength >= 120 ? 1.2 : r.strength !== null && r.strength < 80 ? 0.8 : 1) * (r.boostKind === "30분" ? 1 : 0.9);
  const pool = rows.filter((r) => (r.todayValue ?? 0) >= 30 && (r.boost ?? 0) >= 1.2).sort((a, b) => score(b) - score(a));
  const buyers = pool.filter((r) => (r.boost ?? 0) >= 1.3).slice(0, 10);
  const isHot = (r: BuyerRow) => (r.rate ?? 0) >= 5 || r.tags.some((t) => t.startsWith("VI"));
  const buckets: BuyerBuckets = {
    quiet: pool.filter((r) => !isHot(r) && r.rate !== null && r.rate >= -1 && r.rate <= 3 && (r.boost ?? 0) >= 1.3 && (r.strength === null || r.strength >= 105)).slice(0, 8),
    breakout: pool.filter((r) => !isHot(r) && r.high60 !== null && r.high60 >= 97).slice(0, 8),
    hot: pool.filter(isHot).slice(0, 8),
  };
  return { buyers, buckets, pool, liveOf };
}

/* ═══════════════ ④ 내 계좌 ═══════════════ */

const ACNT_RESOURCE = "/api/dostk/acnt";
function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
/** (2026-09-18 전수검증 A22) 「모른다」는 null — 빈 칸·비숫자를 0 으로 읽으면 수익률 0.00% 가 사실처럼 보인다 */
function numOrNull(v: unknown): number | null {
  const s = String(v ?? "").replace(/[+,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

async function buildAccount(
  client: KiwoomClient,
  minute: number,
  themeOf: Map<string, { name: string; pos: "주도" | "부상" | "휴식" }>,
  marks: Record<string, StockMark> | null,
  vi: Map<string, ViToday> | null,
  liveOf: Map<string, LiveStat>,
  errors: string[],
): Promise<MoneyNow["account"]> {
  const rows: AccountRow[] = [];
  let kiwoomOk = false;
  let manualOk = false;
  const inSession = minute >= 9 * 60 && minute <= 15 * 60 + 30;

  /* 키움 잔고 */
  try {
    const { data } = await client.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00018", { qry_tp: "1", dmst_stex_tp: "KRX" });
    const list = Array.isArray(data.acnt_evlt_remn_indv_tot) ? (data.acnt_evlt_remn_indv_tot as Record<string, unknown>[]) : [];
    for (const r of list) {
      const code = String(r.stk_cd ?? "").replace(/^A/, "").replace(/_.*$/, "");
      const qty = num(r.rmnd_qty);
      if (!code || qty <= 0) continue;
      rows.push({
        code,
        name: String(r.stk_nm ?? code),
        account: "키움",
        isEtf: false,
        qty,
        price: Math.abs(num(r.cur_prc)),
        rate: null,
        pnlRate: numOrNull(r.prft_rt),
        /* (A22) 5천 원 미만은 0만원이지 「모름」이 아니다 — 값이 있으면 0 도 그대로 */
        valueMan: numOrNull(r.evlt_amt) === null ? null : Math.round(num(r.evlt_amt) / 10000),
        rotation: null,
        theme: null,
        est: null,
        boost: null,
        strength: null,
        tags: [],
        verdict: "quiet",
        why: "",
      });
    }
    kiwoomOk = true;
  } catch {
    errors.push("키움 잔고");
  }

  /* 수동 계좌 (ETF·연금) */
  try {
    const accounts = await evaluateAccounts(client);
    for (const a of accounts) {
      for (const h of a.holdings) {
        if (!h.code || h.qty <= 0) continue;
        rows.push({
          code: h.code,
          name: h.name,
          account: a.name || a.broker,
          isEtf: false,
          qty: h.qty,
          price: h.price,
          rate: h.changeRate,
          pnlRate: h.returnRate,
          valueMan: Number.isFinite(h.value) ? Math.round(h.value / 10000) : null, // (A22) 5천 원 미만도 0만원, 모름 아님
          rotation: null,
          theme: null,
          est: null,
          boost: null,
          strength: null,
          tags: [],
          verdict: "quiet",
          why: "",
        });
      }
    }
    manualOk = true;
  } catch {
    errors.push("수동 계좌");
  }

  if (rows.length === 0) return { rows, kiwoomOk, manualOk, note: "보유 종목이 없거나 잔고를 못 받았습니다" };

  /* ETF 판별 + 국내 ETF 자금흐름 배수 */
  let etfSet = new Set<string>();
  let etfRows = new Map<string, EtfFlowRow>();
  try {
    const all = await etfAll(client);
    etfSet = new Set(all.map((r) => r.code));
    const f = await etfFlow(client);
    etfRows = new Map(f.rows.map((r) => [r.code, r]));
  } catch {
    /* ETF 목록 못 받으면 전부 주식으로 본다 */
  }

  /* 한투 잠정 — 주식만, 20종목까지 (5분 캐시) */
  const codes = [...new Set(rows.filter((r) => !etfSet.has(r.code)).map((r) => r.code))].slice(0, 20);
  const estOf = new Map<string, { time: string; fgn: number; orgn: number }>();
  if (inSession || minute > 15 * 60 + 30) {
    for (const code of codes) {
      const est = await investorEstimate(code).catch(() => []);
      const last = est[est.length - 1];
      if (last) estOf.set(code, { time: last.time, fgn: last.fgn, orgn: last.orgn });
    }
  }

  for (const r of rows) {
    r.isEtf = etfSet.has(r.code);
    const live = liveOf.get(r.code);
    if (live) {
      r.price = live.price || r.price;
      r.rate = live.rate ?? r.rate;
      r.boost = live.boost;
      r.strength = live.strength;
    }
    const m = marks?.[r.code];
    if (r.rate === null && m) r.rate = null;
    const t = themeOf.get(r.code);
    r.rotation = t?.pos ?? null;
    r.theme = t?.name ?? null;
    r.est = estOf.get(r.code) ?? null;
    r.tags = markTags(m, vi?.get(r.code));
    if (r.isEtf) {
      const ef = etfRows.get(r.code);
      if (ef) {
        r.boost = ef.volRatio;
        r.rate = r.rate ?? ef.d1;
        r.tags = [`${ef.label} 대표`, ...(ef.volRatio !== null && ef.volRatio >= 1.5 ? ["돈 몰림"] : [])];
      }
    }
    /* 판정 — 들어옴: 잠정 순매수이거나 30분 배수 1.3↑에 등락 플러스 · 빠짐: 잠정 순매도에 등락 마이너스 */
    const estSum = r.est ? r.est.fgn + r.est.orgn : null;
    const why: string[] = [];
    if (r.est) why.push(`${r.est.time} 외인 ${r.est.fgn > 0 ? "+" : ""}${r.est.fgn.toLocaleString("ko-KR")}주 · 기관 ${r.est.orgn > 0 ? "+" : ""}${r.est.orgn.toLocaleString("ko-KR")}주`);
    if (r.boost !== null) why.push(`${r.isEtf ? "거래대금 배수" : "30분 배수"} ${r.boost.toFixed(2)}`);
    if (r.strength !== null) why.push(`체결강도 ${Math.round(r.strength)}`);
    if (r.rotation) why.push(`테마 ${r.rotation}(${r.theme})`);
    if ((estSum !== null && estSum > 0 && (r.rate ?? 0) >= 0) || ((r.boost ?? 0) >= 1.3 && (r.rate ?? 0) > 0 && (r.strength === null || r.strength >= 100))) r.verdict = "in";
    else if ((estSum !== null && estSum < 0 && (r.rate ?? 0) < 0) || ((r.boost ?? 0) >= 1.3 && (r.rate ?? 0) < 0)) r.verdict = "out";
    else r.verdict = "quiet";
    r.why = why.join(" · ");
  }

  rows.sort((a, b) => (b.valueMan ?? 0) - (a.valueMan ?? 0));
  if (inSession) await flipAlerts(rows).catch(() => undefined);
  return {
    rows,
    kiwoomOk,
    manualOk,
    note: `키움 ${kiwoomOk ? "잔고" : "못 받음"} · 수동 계좌 ${manualOk ? "보유" : "못 받음"} · 잠정치는 한투 5회 집계(09:30·10:00·11:20·13:20·14:30), 배수는 실시간 저장소 종목만`,
  };
}

/* ── 뒤집힘 알림 (2026-09-17 저녁 — "폰을 열어야만 안다") ── */
const FLIP_FILE = join(DATA_DIR, "moneyNowFlip.json");
interface FlipState {
  day: string;
  last: Record<string, FlowVerdict>;
  count: Record<string, number>;
}
let flip: FlipState | null = null;

async function loadFlip(day: string): Promise<FlipState> {
  if (flip && flip.day === day) return flip;
  try {
    const f = JSON.parse(await readFile(FLIP_FILE, "utf-8")) as FlipState;
    flip = f.day === day ? f : { day, last: {}, count: {} };
  } catch {
    flip = { day, last: {}, count: {} };
  }
  return flip;
}

/**
 * 보유 종목의 판정이 **바뀐 순간만** — 알림종 + 시그널 방. 종목당 하루 2번, 조용→들어옴/빠짐 또는 서로 뒤집힘.
 * 첫 판정(이전 값 없음)은 안 보낸다 — 아침에 열 종목이 한꺼번에 울리면 소음이다. ETF 는 배수 1.5↑ 일 때만.
 */
async function flipAlerts(rows: AccountRow[]): Promise<void> {
  const { date, hhmm } = kst();
  const st = await loadFlip(date);
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.code)) continue;
    seen.add(r.code);
    const prev = st.last[r.code];
    st.last[r.code] = r.verdict;
    if (prev === undefined || prev === r.verdict || r.verdict === "quiet") continue;
    if (r.isEtf && (r.boost ?? 0) < 1.5) continue;
    const n = st.count[r.code] ?? 0;
    if (n >= 2) continue;
    const label = r.verdict === "in" ? "돈 들어옴" : "돈 빠짐";
    const title = `💧 ${r.name} ${label} (${r.account})`;
    const body = `${hhmm} · ${r.rate === null ? "" : `${r.rate > 0 ? "+" : ""}${r.rate.toFixed(2)}% · `}${r.why || (prev === "quiet" ? "조용하다가 바뀜" : "반대로 뒤집힘")}`;
    /* (2026-09-18 전수검증 A21) 카운트는 **알림종에 실제로 들어간 뒤** 올린다 — 실패한 회차가 하루 2번을 갉아먹지 않게 */
    let sent = false;
    await pushNotice({
      source: "moneyFlow",
      kind: "stock",
      level: r.verdict === "out" ? "warn" : "info",
      title,
      body,
      code: r.code,
      name: r.name,
      link: stockLink(r.code, r.name),
      dedupeKey: `moneyFlow:${r.code}:${r.verdict}:${date}`,
      dedupeHours: 3,
    })
      .then(() => {
        sent = true;
      })
      .catch(() => undefined);
    await sendTelegram(`<b>${title}</b>\n${body.replace(/&/g, "&amp;").replace(/</g, "&lt;")}`, "signal").catch(() => undefined);
    if (sent) st.count[r.code] = n + 1;
  }
  try {
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(FLIP_FILE, JSON.stringify(st), "utf-8");
  } catch {
    /* 못 남겨도 다음 5분에 다시 잰다 */
  }
}

/* ═══════════════ ⑤ 시간대 플랜 ═══════════════ */

async function buildPlan(
  slot: Slot,
  where: MoneyNow["where"],
  buyers: BuyerRow[],
  pool: BuyerRow[],
  marks: Record<string, StockMark> | null,
  account: MoneyNow["account"],
  vi: Map<string, ViToday> | null,
  date: string,
): Promise<Plan> {
  const items: PlanItem[] = [];
  const top = (n: number) => buyers.slice(0, n).map((b) => ({ code: b.code, name: b.name, text: `${b.boostKind} 배수 ${b.boost?.toFixed(1)} · ${b.rate === null ? "" : `${b.rate > 0 ? "+" : ""}${b.rate.toFixed(1)}%`}${b.theme ? ` · ${b.theme}` : ""}` }));
  switch (slot.key) {
    case "night":
    case "pre": {
      for (const u of where.usEtf.slice(0, 2)) items.push({ name: `🇺🇸 ${u.name}`, text: `어젯밤 ${u.d1 === null ? "-" : `${u.d1 > 0 ? "+" : ""}${u.d1.toFixed(1)}%`} — 짝 국내 테마 확인` });
      for (const t of where.lead.slice(0, 2)) items.push({ name: t.name, text: `주도 지속 (한 달 ${t.m1 === null ? "-" : `+${t.m1.toFixed(0)}%`}) — 시초가에서 지키는지` });
      return { slot: slot.key, title: "장 전 — 어젯밤과 주도 테마", items, note: "09:00 시초가·09:30 첫 잠정치가 나오면 「지금」이 바뀝니다" };
    }
    case "open": {
      const vis = vi ? [...vi.values()].sort((a, b) => b.count - a.count || Math.abs(b.openChangeRate) - Math.abs(a.openChangeRate)).slice(0, 6) : [];
      for (const v of vis) items.push({ code: v.code, name: v.name, text: `VI ${v.count}회 · 시가대비 ${v.openChangeRate > 0 ? "+" : ""}${v.openChangeRate.toFixed(1)}% — 풀린 뒤 방향 확인, 추격 금지` });
      return { slot: slot.key, title: "개장 30분 — 갭·VI 만 보고, 손은 09:30 뒤", items, note: "첫 30분은 호가가 요동친다. 09:30 잠정치가 나오면 「사는 손」이 채워집니다" };
    }
    case "morning":
    case "afternoon": {
      items.push(...top(5));
      for (const t of where.fresh.slice(0, 2)) items.push({ name: `테마 ${t.name}`, text: `신규 부상 ${t.changeRate > 0 ? "+" : ""}${t.changeRate.toFixed(1)}% — 대표 ${t.stocks.map((s) => s.name).join("·")}` });
      const mine = account.rows.filter((r) => r.verdict !== "quiet").slice(0, 4);
      for (const r of mine) items.push({ code: r.code, name: `내 ${r.name}`, text: `${r.verdict === "in" ? "돈 들어옴" : "돈 빠짐"} — ${r.why}` });
      return { slot: slot.key, title: slot.key === "morning" ? "오전 — 추세와 사는 손" : "오후 — 13:20 잠정치로 방향 재확인", items, note: "사는 손이 이어지는 종목은 붙고, 배수가 식으면 덜기" };
    }
    case "lunch": {
      const mine = account.rows.slice(0, 6);
      for (const r of mine) items.push({ code: r.code, name: r.name, text: `${r.verdict === "in" ? "들어옴" : r.verdict === "out" ? "빠짐" : "조용"}${r.why ? ` — ${r.why}` : ""}` });
      return { slot: slot.key, title: "점심 — 오전 포지션 점검", items, note: "거래가 얇은 시간. 새 진입보다 내 종목이 오전 흐름을 지키는지" };
    }
    case "closing":
    case "auction": {
      const scan = await loadCloseBetScan().catch(() => null);
      /*
       * 교차 — 종배 후보 ∩ 사는 손(배수 1.2↑) ∩ 마크(슈퍼·쌍끌이·외인3칸). 세 눈이 겹치는 것만 (2026-09-17 저녁).
       *
       * ⚠️ **후보는 「오늘 것」일 수 없다** (2026-09-18 전수검증 #9, 벤티지가 「어제 원장으로 내고 어제 기준이라 적기」를 고름).
       * 종배 스캔은 9/16 부터 **18:30 뒤 예비 경로**로 밀렸고(파이프라인 15:55 가 본길), 원장도 16:40 전후에 나온다 —
       * 즉 이 슬롯(14:30~15:30)에 오늘 후보는 존재할 수 없어서 `scan.date === date` 가 늘 거짓이었다. 어제 초록으로 낸다.
       * 종배는 원래 **전날 원장**으로 후보를 줍는 일이라 뜻이 맞는다. 대신 어느 날 기준인지 줄에 적는다.
       * 너무 묵은 것(5거래일 = 달력 8일 넘음)은 안 쓴다 — 그건 「없다」가 정직하다.
       */
      const cross: PlanItem[] = [];
      const scanAge = scan ? Math.round((Date.parse(`${date}T00:00:00+09:00`) - Date.parse(`${scan.date}T00:00:00+09:00`)) / 86_400_000) : null;
      const usable = scan && scanAge !== null && scanAge >= 0 && scanAge <= 8 && scan.green.length > 0;
      if (usable) {
        const md = `${scan.date.slice(5, 7)}/${scan.date.slice(8, 10)}`;
        const basis = scanAge === 0 ? "오늘" : `${md} 기준`;
        const poolOf = new Map(pool.map((b) => [b.code, b]));
        for (const g of scan.green) {
          const b = poolOf.get(g.code);
          const m = marks?.[g.code];
          const markHit = m ? m.super || m.twin || m.fgn3 : false;
          if (b && markHit) cross.push({ code: g.code, name: g.name, text: `종배 ${g.score}점(${basis}) · ${b.boostKind} 배수 ${b.boost?.toFixed(1)}${b.strength !== null ? ` · 강도 ${Math.round(b.strength)}` : ""} · ${m?.super ? "🌟 슈퍼" : m?.twin ? "🧲🧲 쌍끌이" : "🧲 외인3칸"}` });
        }
        if (scanAge > 0) items.push({ name: "종배 후보", text: `${md} 원장 기준 ${scan.green.length}종목 — 오늘 후보는 장 마감 뒤(16:40 전후)에 나온다` });
        for (const g of scan.green.slice(0, 8)) items.push({ code: g.code, name: g.name, text: `종배 점수 ${g.score} · 목록 ${g.lists}개${scanAge > 0 ? ` · ${basis}` : ""}` });
      } else items.push({ name: "종배 후보", text: "쓸 수 있는 원장이 없습니다 — 종가배팅 탭에서 돌리기" });
      items.push(...top(3));
      return {
        slot: slot.key,
        title: "마감 전 — 종가배팅",
        items,
        note: `14:30 잠정치·프로그램이 마지막 30분을 정한다. 15:20 전에 주문 정리${usable && (scanAge ?? 0) > 0 ? " · 종배 후보·교차는 어제 원장 기준(오늘 원장은 마감 뒤)" : ""}`,
        cross,
      };
    }
    case "gap":
    case "after": {
      const mine = account.rows.slice(0, 8);
      for (const r of mine) items.push({ code: r.code, name: r.name, text: `${r.rate === null ? "-" : `${r.rate > 0 ? "+" : ""}${r.rate.toFixed(2)}%`}${r.verdict !== "quiet" ? ` · ${r.verdict === "in" ? "들어옴" : "빠짐"}` : ""}` });
      return { slot: slot.key, title: "애프터 — 내 종목의 반응", items, note: "정규장 결과를 애프터가 잇는지. 15:55 판정·슈퍼신호등 편입은 알림으로" };
    }
  }
  return { slot: slot.key, title: slot.label, items, note: "" };
}

/* ═══════════════ 조립 · 캐시 ═══════════════ */

let cache: MoneyNow | null = null;
let job: Promise<MoneyNow> | null = null;
const TTL = 60_000;
const MAX_AGE = 30 * 60_000;

async function compute(client: KiwoomClient): Promise<MoneyNow> {
  const { date, minute, day, hhmm } = kst();
  const slot = slotOf(minute, day === 0 || day === 6);
  const errors: string[] = [];
  const [marksFile, vi] = await Promise.all([loadStockMarks().catch(() => null), viTodayMap(client).catch(() => null)]);
  const marks = marksFile?.marks ?? null;
  const [verdict, w] = await Promise.all([buildVerdict(client, minute, errors), buildWhere(client, errors)]);
  await recordVerdict(date, minute, hhmm, verdict);
  const { trend, record } = await buildRecord(client, date);
  const { buyers, buckets, pool, liveOf } = await buildBuyers(client, minute, w.themeOf, marks, vi, errors);
  const account = await buildAccount(client, minute, w.themeOf, marks, vi, liveOf, errors);
  const plan = await buildPlan(slot, w.where, buyers, pool, marks, account, vi, date);
  return { at: Date.now(), stale: false, slot, verdict, trend, record, buckets, where: w.where, buyers, account, plan, errors };
}

/** 60초 캐시 — 있으면 옛 값을 바로 주고 뒤에서 갱신한다. `fresh` 는 카드 ↻(10초 지난 값만 다시) */
export async function moneyNow(client: KiwoomClient, opts: { fresh?: boolean } = {}): Promise<MoneyNow> {
  const age = cache ? Date.now() - cache.at : Infinity;
  const wantFresh = Boolean(opts.fresh) && age > 10_000;
  if (cache && age < TTL && !wantFresh) return cache;
  if (!job) {
    job = compute(client)
      .then((r) => {
        cache = r;
        return r;
      })
      .finally(() => {
        job = null;
      });
  }
  /*
   * (2026-09-18 전수검증 A15) 옛 값을 바로 주는 건 30분까지만. 그보다 늙으면 계산을 **기다리고**, 그래도 실패하면
   * 옛 값에 「몇 분 전 값 · 계산 실패」를 달아 준다 — 어제 15시 판정이 stale 표시만 달고 하루 종일 돌던 것.
   */
  if (cache && !wantFresh && age < MAX_AGE) {
    void job.catch(() => undefined);
    return { ...cache, stale: true };
  }
  if (cache) {
    const old = cache;
    return job.catch(() => ({ ...old, stale: true, errors: [...old.errors, `계산 실패 — ${Math.round((Date.now() - old.at) / 60_000)}분 전 값`] }));
  }
  return job;
}

/* ═══════════════ 텔레그램 브리핑 글 ═══════════════ */

export function moneyNowText(m: MoneyNow): string {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const kindLabel = m.verdict.kind === "in" ? "🟢 들어오는 장" : m.verdict.kind === "out" ? "🔴 빠지는 장" : m.verdict.kind === "rotate" ? "🟡 회전장" : "⚪ 판정 보류";
  const lines: string[] = [];
  lines.push(`<b>💧 돈의 흐름 ${m.slot.label}</b> — ${kindLabel}`);
  lines.push(esc(m.verdict.parts.filter((p) => p.sign !== null).map((p) => `${p.label} ${p.sign === 1 ? "▲" : p.sign === -1 ? "▼" : "–"}`).join(" · ")));
  if (m.trend.length >= 2) lines.push(`추세: ${m.trend.slice(-4).map((t) => `${t.hhmm} ${t.kind === "in" ? "들어옴" : t.kind === "out" ? "빠짐" : "회전"}`).join(" → ")}`);
  if (m.where.fresh.length > 0) lines.push(`부상: ${esc(m.where.fresh.map((t) => `${t.name} ${t.changeRate > 0 ? "+" : ""}${t.changeRate.toFixed(1)}%`).join(" · "))}`);
  if (m.buckets.quiet.length > 0) lines.push(`🧲 조용히 담는 중: ${esc(m.buckets.quiet.slice(0, 4).map((b) => `${b.name} ×${b.boost?.toFixed(1)}`).join(" · "))}`);
  if (m.buckets.breakout.length > 0) lines.push(`🚪 돌파 임박: ${esc(m.buckets.breakout.slice(0, 3).map((b) => b.name).join(" · "))}`);
  if (m.buckets.hot.length > 0) lines.push(`🔥 이미 튐(추격 금지): ${esc(m.buckets.hot.slice(0, 3).map((b) => `${b.name} ${b.rate === null ? "" : `${b.rate > 0 ? "+" : ""}${b.rate.toFixed(0)}%`}`).join(" · "))}`);
  if (m.plan.cross && m.plan.cross.length > 0) lines.push(`⚡ 교차(종배∩사는 손∩마크): ${esc(m.plan.cross.map((c) => c.name).join(" · "))}${/기준/.test(m.plan.cross[0]?.text ?? "") ? " (종배는 어제 원장 기준)" : ""}`);
  const mine = m.account.rows.filter((r) => r.verdict !== "quiet").slice(0, 5);
  if (mine.length > 0) lines.push(`내 계좌: ${esc(mine.map((r) => `${r.name} ${r.verdict === "in" ? "들어옴" : "빠짐"}`).join(" · "))}`);
  lines.push(`<i>${esc(m.slot.advice)}</i>`);
  return lines.join("\n");
}
