import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { signalScoreMap } from "./signalHistory.js";
import { tradeValueTop } from "./signalScreen.js";

/**
 * 조건 백테스트 — **「이 조건으로 들어갔으면 과거에 어땠나」**.
 *
 * ## 왜 필요했나
 *
 * 이 앱은 스스로를 「내 매매 논리를 찾는 훈련 도구」라고 부른다. 그런데 정작
 * 「그 논리가 과거에 통했나」를 물을 수단이 없었다. 한 번 해 본 적은 있다 —
 * 국채금리와 종가배팅을 486건으로 검증해 「도움이 안 된다」는 결론을 냈다.
 * **그게 도구가 아니라 일회성 조사였다는 게 문제다.**
 *
 * ## ⚠️ 미래를 안 쓴다
 *
 * 백테스트가 거짓말하는 가장 흔한 방식은 **판정에 쓴 값으로 사는 것**이다.
 * 조건은 그날 **종가**로 판정한다. 그 종가로 사면 장이 끝난 뒤의 값으로 산 것이라
 * 실제로는 불가능하다. 그래서 **다음 날 시가**로 산다. 일봉에 시가가 있으므로
 * 이건 계산할 수 있고, 이 한 줄이 결과를 몇 %p 씩 바꾼다.
 *
 * ## ⚠️ 기준선을 같이 잰다
 *
 * 「평균 +2.1%」만 적으면 좋아 보인다. 그런데 **그 기간에 아무거나 샀어도 +2.0%**
 * 였다면 그 조건은 아무것도 아니다. 상승장에서는 어떤 조건이든 좋아 보인다.
 *
 * 그래서 **같은 종목·같은 날짜 범위에서 조건을 안 걸고 잰 평균**을 같이 낸다.
 * 볼 것은 「평균 수익률」이 아니라 **그 차이(edge)** 다.
 *
 * ## 무엇을 못 하나
 *
 *   · **신호등 점수로는 못 돌린다.** 신호등은 지금 시점만 계산할 수 있고 과거
 *     점수는 저장을 시작한 지 얼마 안 됐다. 여기 조건은 전부 **일봉으로 계산되는 것**뿐이다.
 *   · 수수료·세금·슬리피지를 안 뺀다. 상대 비교용이라 양쪽에 똑같이 빠진다.
 *   · 상장폐지된 종목이 모집단에 없다(생존 편향). 거래대금 상위에서 고르므로
 *     **오늘 살아서 잘 돌고 있는 종목들**이다 — 결과를 그만큼 좋게 본다.
 */

const CHART = "/api/dostk/chart";

export type RuleKey =
  | "maAlign"
  | "aboveMa"
  | "volSurge"
  | "newHigh"
  | "minRate"
  | "nearHigh52"
  | "disparity"
  | "volValue"
  | "gapUp"
  | "minScore";

export interface RuleDef {
  key: RuleKey;
  label: string;
  hint: string;
  /** 기준값이 있는 규칙인가 */
  hasValue: boolean;
  defaultValue: number;
}

export const RULES: RuleDef[] = [
  {
    key: "maAlign",
    label: "정배열",
    hint: "5일선 > 20일선 > 60일선. 추세추종의 기본 전제",
    hasValue: false,
    defaultValue: 0,
  },
  {
    key: "aboveMa",
    label: "이평선 위",
    hint: "종가가 N일선 위에 있다",
    hasValue: true,
    defaultValue: 20,
  },
  {
    key: "volSurge",
    label: "거래량 급증",
    hint: "그날 거래량이 20일 평균의 N배 이상",
    hasValue: true,
    defaultValue: 2,
  },
  {
    key: "newHigh",
    label: "N일 신고가",
    hint: "그날 고가가 지난 N일 중 제일 높다",
    hasValue: true,
    defaultValue: 60,
  },
  {
    key: "minRate",
    label: "당일 등락률",
    hint: "그날 등락률이 N% 이상",
    hasValue: true,
    defaultValue: 3,
  },
  /*
   * ── 2026-08-25 세분화 — 신호등의 축들을 일봉으로 흉내 낸 조건들 ──
   * 신호등을 통째로 못 돌리는 대신(과거 점수가 이제 막 쌓임), 그 구성 요소를
   * 하나씩 조건으로 뒀다 — 어느 축이 일을 하는지 따로 잴 수 있다.
   */
  {
    key: "nearHigh52",
    label: "52주 고점 근접",
    hint: "종가가 지난 240일 고가의 N% 이상 — 신호등 「고점 근접」의 백테스트판",
    hasValue: true,
    defaultValue: 90,
  },
  {
    key: "disparity",
    label: "이격 과열 아님",
    hint: "20일선과의 이격이 N% 이하 — 신호등 위험 축(과열 배제). 추세 조건과 같이 걸어야 뜻이 있다",
    hasValue: true,
    defaultValue: 10,
  },
  {
    key: "volValue",
    label: "거래대금",
    hint: "그날 거래대금(종가×거래량)이 N억원 이상 — 돈이 도는 종목만",
    hasValue: true,
    defaultValue: 300,
  },
  {
    key: "gapUp",
    label: "시가 갭",
    hint: "그날 시가가 전일 종가보다 N% 이상 위 — 갭 출발의 이후를 잰다",
    hasValue: true,
    defaultValue: 2,
  },
  {
    key: "minScore",
    label: "신호등 점수",
    hint: "그날 저장된 신호등 점수가 N점 이상. ⚠️ 점수 축적(2026-08-25~) 이후 날짜만 잡혀 표본이 아직 적다 — 날이 쌓일수록 정확해진다",
    hasValue: true,
    defaultValue: 70,
  },
];

export interface BacktestConfig {
  market: string;
  /** 거래대금 상위 몇 종목을 대상으로 */
  universe: number;
  /** 며칠 들고 있다 파나 (거래일) */
  holdDays: number;
  /** 켠 규칙과 기준값 */
  rules: { key: RuleKey; value: number }[];
}

export interface BacktestStat {
  count: number;
  avg: number;
  median: number;
  winRate: number;
  best: number;
  worst: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  /** 조건에 걸린 진입들 */
  hit: BacktestStat;
  /** 같은 종목·같은 기간에서 조건 없이 잰 것 — 이게 없으면 위 숫자는 못 읽는다 */
  base: BacktestStat;
  /** 조건이 만든 차이(%p). 이게 진짜 봐야 할 숫자다 */
  edge: number | null;
  /** 실제로 훑은 종목 수 */
  codes: number;
  /** 일봉을 못 받은 종목 수 */
  failed: number;
  /** 훑은 날짜 범위 */
  from: string;
  to: string;
  /** 조건에 제일 잘 맞은 사례 — 눈으로 확인하라고 */
  samples: { code: string; name: string; date: string; rate: number }[];
}

export interface BacktestJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  startedAt: string;
  result: BacktestResult | null;
  error?: string;
}

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function num(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s-]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

/** 일봉 (오래된 것 → 최근) */
async function bars(client: KiwoomClient, code: string): Promise<Bar[]> {
  const d = new Date(Date.now() + 9 * 3600_000);
  const base = d.toISOString().slice(0, 10).replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART, "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = (res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  return rows
    .map((r) => ({
      date: String(r.dt ?? ""),
      open: num(r.open_pric),
      high: num(r.high_pric),
      low: num(r.low_pric),
      close: num(r.cur_prc),
      volume: num(r.trde_qty),
    }))
    .filter((b) => /^\d{8}$/.test(b.date) && b.close > 0 && b.open > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function ma(bs: Bar[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  return mean(bs.slice(i + 1 - n, i + 1).map((b) => b.close));
}

/**
 * `i` 번째 날의 **종가 기준**으로 조건을 보나.
 *
 * 여기서 쓰는 값은 전부 `i` 날까지의 것이다 — 뒤를 보면 안 된다.
 */
function passes(
  bs: Bar[],
  i: number,
  rules: { key: RuleKey; value: number }[],
  /** 신호등 점수 조건용 — 날짜(YYYYMMDD)→종목→점수. 그 조건이 없으면 안 온다 */
  scores?: Map<string, Map<string, number>>,
  code?: string,
): boolean {
  const b = bs[i];
  for (const r of rules) {
    switch (r.key) {
      case "nearHigh52": {
        /* 240봉이 안 쌓인 새내기는 있는 만큼으로 잰다 — 최소 60봉은 요구한다 */
        if (i < 60) return false;
        const win = bs.slice(Math.max(0, i - 239), i + 1);
        const high = Math.max(...win.map((x) => x.high));
        if (high <= 0 || (b.close / high) * 100 < r.value) return false;
        break;
      }
      case "disparity": {
        const m = ma(bs, i, 20);
        if (m === null || m <= 0) return false;
        if (((b.close - m) / m) * 100 > r.value) return false;
        break;
      }
      case "volValue": {
        // 종가 × 거래량 — 어림이지만 양쪽(조건·기준선)에 같은 잣대다
        if (b.close * b.volume < r.value * 1e8) return false;
        break;
      }
      case "gapUp": {
        if (i < 1) return false;
        const prev = bs[i - 1].close;
        if (prev <= 0) return false;
        if (((b.open - prev) / prev) * 100 < r.value) return false;
        break;
      }
      case "minScore": {
        const s = code ? scores?.get(b.date)?.get(code) : undefined;
        if (s === undefined || s < r.value) return false;
        break;
      }
      case "maAlign": {
        const m5 = ma(bs, i, 5);
        const m20 = ma(bs, i, 20);
        const m60 = ma(bs, i, 60);
        if (m5 === null || m20 === null || m60 === null) return false;
        if (!(m5 > m20 && m20 > m60)) return false;
        break;
      }
      case "aboveMa": {
        const m = ma(bs, i, Math.max(2, Math.round(r.value)));
        if (m === null || b.close <= m) return false;
        break;
      }
      case "volSurge": {
        if (i < 20) return false;
        const avg = mean(bs.slice(i - 20, i).map((x) => x.volume));
        if (avg <= 0 || b.volume < avg * r.value) return false;
        break;
      }
      case "newHigh": {
        const n = Math.max(2, Math.round(r.value));
        if (i < n) return false;
        const prevHigh = Math.max(...bs.slice(i - n, i).map((x) => x.high));
        if (!(b.high > prevHigh)) return false;
        break;
      }
      case "minRate": {
        if (i < 1) return false;
        const prev = bs[i - 1].close;
        if (prev <= 0) return false;
        if (((b.close - prev) / prev) * 100 < r.value) return false;
        break;
      }
    }
  }
  return true;
}

function stat(xs: number[]): BacktestStat {
  if (xs.length === 0) {
    return { count: 0, avg: 0, median: 0, winRate: 0, best: 0, worst: 0 };
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    count: xs.length,
    avg: mean(xs),
    // 중앙값을 같이 둔다 — 한 종목이 +90% 면 평균이 혼자 올라간다
    median: sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    winRate: (xs.filter((x) => x > 0).length / xs.length) * 100,
    best: sorted[sorted.length - 1],
    worst: sorted[0],
  };
}

/* ------------------------------------------------------------------ */
/* 실행 기록 — 통찰은 실행 하나가 아니라 실행들 사이의 비교에서 나온다      */
/* ------------------------------------------------------------------ */

const here = dirname(fileURLToPath(import.meta.url));
const RUNS_FILE = join(here, "..", "data", "backtestRuns.json");

/**
 * 저장하는 건 **조건과 요약**이다 (2026-08-25 — 「히스토리가 안 남으니 통찰이 없다」).
 *
 * 예전엔 돌린 결과가 메모리에만 있어 서버가 다시 뜨면 사라졌다. 그러면 이 도구는
 * 「어제 뭘 실험했더라」에 답을 못 하고, 무엇보다 **조건끼리 견줄 수가 없다** —
 * 「정배열 +0.8%p, 60일 신고가 +3.8%p」 같은 비교가 이 화면의 존재 이유인데.
 * 돌 때마다 여기 쌓이고, 화면이 엣지 순으로 세워 보여준다.
 */
export interface BacktestRun {
  id: string;
  at: string;
  config: BacktestConfig;
  /** 조건을 사람 말로 — "정배열 · 60일 신고가 · 5일 보유" */
  label: string;
  hit: BacktestStat;
  base: BacktestStat;
  edge: number | null;
  from: string;
  to: string;
  codes: number;
  /** 밤 그리드가 돌린 것 — 같은 라벨의 어제 그리드를 밀어내고 들어온다 */
  auto?: boolean;
}

const KEEP_RUNS = 60;

async function readRuns(): Promise<BacktestRun[]> {
  try {
    const parsed = JSON.parse(await readFile(RUNS_FILE, "utf-8")) as BacktestRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveRunRecord(run: BacktestRun): Promise<void> {
  const rows = await readRuns();
  rows.push(run);
  await mkdir(dirname(RUNS_FILE), { recursive: true });
  await writeFile(RUNS_FILE, JSON.stringify(rows.slice(-KEEP_RUNS), null, 2), "utf-8");
}

export async function listBacktestRuns(): Promise<BacktestRun[]> {
  return (await readRuns()).sort((a, b) => b.at.localeCompare(a.at));
}

function labelOf(cfg: BacktestConfig): string {
  const parts = cfg.rules.map((r) => {
    const d = RULES.find((x) => x.key === r.key);
    if (!d) return r.key;
    return d.hasValue ? `${d.label}=${r.value}` : d.label;
  });
  const mkt = cfg.market === "001" ? "코스피" : cfg.market === "101" ? "코스닥" : "전체";
  return `${parts.join(" · ") || "조건 없음"} → ${cfg.holdDays}일 보유 (${mkt} ${cfg.universe})`;
}

/**
 * 결과를 한 줄로 읽어 준다 — 숫자만 두면 통찰이 사람 몫으로 남는다.
 * 규칙은 단순하고 화면에도 그대로 적는다: 표본이 적으면 우연일 수 있고,
 * 엣지가 작으면 수수료에 먹힌다.
 */
export function verdictOf(edge: number | null, count: number): { tone: "good" | "weak" | "thin" | "bad"; text: string } {
  if (edge === null || count === 0) return { tone: "thin", text: "걸린 진입이 없다 — 조건이 너무 좁거나 데이터가 모자라다" };
  if (count < 30) return { tone: "thin", text: `표본 ${count}건 — 우연일 수 있다. 모집단이나 기간을 넓혀 다시 재 볼 것` };
  if (edge >= 1.5) return { tone: "good", text: `기준선보다 +${edge.toFixed(1)}%p — 표본 ${count}건이면 진짜 엣지에 가깝다` };
  if (edge >= 0.5) return { tone: "weak", text: `+${edge.toFixed(1)}%p — 있긴 한데 얇다. 수수료·슬리피지를 빼면 남는 게 줄어든다` };
  if (edge > -0.5) return { tone: "weak", text: "기준선과 사실상 같다 — 이 조건은 일을 안 한다" };
  return { tone: "bad", text: `기준선보다 ${edge.toFixed(1)}%p 나쁘다 — 피해야 할 자리를 찾았다는 뜻이기도 하다` };
}

/* ------------------------------------------------------------------ */
/* 자동 그리드 — 밤마다 조건 조합을 돌려 아침 리더보드를 채운다            */
/* ------------------------------------------------------------------ */

const GRID_FILE = join(here, "..", "data", "backtestGrid.json");

/**
 * 밤 그리드 (2026-08-25) — 리더보드가 생기니 다음 문제가 보였다: **채우는 게 손 노동**이다.
 * 조건을 하나 골라 돌리고, 기다리고, 또 하나 돌리고. 그 손이 며칠이면 게을러진다.
 *
 * 그래서 밤에 서버가 정해진 조합 ~18개를 알아서 돌린다. 요령은 **일봉을 한 번만 받는 것** —
 * 종목당 봉을 받아 두면 조합 평가는 전부 메모리 계산이라, 18개 조합이 조회로는
 * 종목 50개 + 순위 1번이면 끝난다 (조합마다 새로 돌면 900번이 될 일이다).
 *
 * 어제의 그리드 기록은 지우고 새로 쓴다 — 같은 조합을 매일 쌓으면 60칸이 그리드로만
 * 차서 손으로 돌린 실험이 밀려난다. 리더보드에서 자동은 「자동」 배지로 구분된다.
 */
const GRID_UNIVERSE = 50;

/** 돌릴 조합 — 단일 조건 전부 + 붙여 볼 만한 짝 몇 개 */
function gridCombos(): { rules: { key: RuleKey; value: number }[]; holdDays: number }[] {
  const v = (key: RuleKey) => RULES.find((r) => r.key === key)?.defaultValue ?? 0;
  const singles: { key: RuleKey; value: number }[][] = RULES
    // minScore 는 점수 축적이 며칠치라 그리드에선 뺀다 — 표본이 차면 넣는다
    .filter((r) => r.key !== "minScore")
    .map((r) => [{ key: r.key, value: r.defaultValue }]);
  const pairs: { key: RuleKey; value: number }[][] = [
    [{ key: "newHigh", value: 60 }, { key: "volValue", value: v("volValue") }],
    [{ key: "newHigh", value: 60 }, { key: "disparity", value: v("disparity") }],
    [{ key: "maAlign", value: 0 }, { key: "volSurge", value: v("volSurge") }],
    [{ key: "gapUp", value: v("gapUp") }, { key: "volValue", value: v("volValue") }],
    [{ key: "nearHigh52", value: v("nearHigh52") }, { key: "volValue", value: v("volValue") }],
  ];
  const five = [...singles, ...pairs].map((rules) => ({ rules, holdDays: 5 }));
  // 잘 나오던 축은 20일 보유도 같이 — 지평이 다르면 다른 조건이 이긴다
  const twenty: { key: RuleKey; value: number }[][] = [
    [{ key: "newHigh", value: 60 }],
    [{ key: "maAlign", value: 0 }],
    [{ key: "nearHigh52", value: v("nearHigh52") }],
  ];
  return [...five, ...twenty.map((rules) => ({ rules, holdDays: 20 }))];
}

let gridRunning = false;

export async function runBacktestGrid(client: KiwoomClient, force = false): Promise<{ ran: boolean; combos?: number }> {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  let last: { lastRunDate?: string } = {};
  try {
    last = JSON.parse(await readFile(GRID_FILE, "utf-8")) as { lastRunDate?: string };
  } catch {
    /* 첫 실행 */
  }
  if (!force && last.lastRunDate === today) return { ran: false };
  if (gridRunning) return { ran: false };
  gridRunning = true;

  try {
    const universe = await tradeValueTop(client, "000", GRID_UNIVERSE);
    // 일봉을 한 번만 받는다 — 그리드의 존재 이유
    const barsByCode = new Map<string, Bar[]>();
    for (const u of universe) {
      try {
        const bs = await bars(client, u.code);
        if (bs.length >= 60 + 22) barsByCode.set(u.code, bs);
      } catch {
        /* 한 종목 실패는 넘어간다 */
      }
      await new Promise((r) => setTimeout(r, 260));
    }

    const combos = gridCombos();
    const at = new Date().toISOString();
    const newRuns: BacktestRun[] = [];

    for (const combo of combos) {
      const hits: number[] = [];
      const baseRates: number[] = [];
      let from = "";
      let to = "";
      for (const [code, bs] of barsByCode) {
        if (bs.length < 60 + combo.holdDays + 2) continue;
        if (!from || bs[0].date < from) from = bs[0].date;
        if (!to || bs[bs.length - 1].date > to) to = bs[bs.length - 1].date;
        for (let i = 60; i + combo.holdDays + 1 < bs.length; i += 1) {
          const entry = bs[i + 1].open;
          const exit = bs[i + 1 + combo.holdDays].close;
          if (entry <= 0 || exit <= 0) continue;
          const rate = ((exit - entry) / entry) * 100;
          baseRates.push(rate);
          if (passes(bs, i, combo.rules, undefined, code)) hits.push(rate);
        }
      }
      const hit = stat(hits);
      const base = stat(baseRates);
      const cfg: BacktestConfig = {
        market: "000",
        universe: GRID_UNIVERSE,
        holdDays: combo.holdDays,
        rules: combo.rules,
      };
      newRuns.push({
        id: `btg_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
        at,
        config: cfg,
        label: labelOf(cfg),
        hit,
        base,
        edge: hit.count > 0 && base.count > 0 ? hit.avg - base.avg : null,
        from,
        to,
        codes: barsByCode.size,
        auto: true,
      });
    }

    // 어제 그리드는 지우고 오늘 것으로 — 손으로 돌린 실험은 그대로 남는다
    const kept = (await readRuns()).filter((r) => !r.auto);
    await mkdir(dirname(RUNS_FILE), { recursive: true });
    await writeFile(RUNS_FILE, JSON.stringify([...kept, ...newRuns].slice(-KEEP_RUNS), null, 2), "utf-8");
    await writeFile(GRID_FILE, JSON.stringify({ lastRunDate: today }), "utf-8");
    console.log(`[backtest] 밤 그리드 완료 — 조합 ${combos.length}개, 종목 ${barsByCode.size}`);
    return { ran: true, combos: combos.length };
  } finally {
    gridRunning = false;
  }
}

/** 평일 17:10 — 장 마감 뒤 조회가 한가한 시간. 그 시각을 지나 켠 날도 하루 한 번 돈다 */
export function startBacktestGridScheduler(client: KiwoomClient): void {
  const tick = async () => {
    const k = new Date(Date.now() + 9 * 3600_000);
    const day = k.getUTCDay();
    if (day === 0 || day === 6) return;
    const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
    if (mins < 17 * 60 + 10 || mins > 23 * 60) return;
    await runBacktestGrid(client).catch((e) => console.error("[backtest] 그리드 실패", e));
  };
  void tick();
  setInterval(() => void tick(), 60_000);
  console.log("[backtest] 밤 그리드 시작 — 평일 17:10 조건 조합 자동 실행");
}

const jobs = new Map<string, BacktestJob>();

export function getBacktestJob(id: string): BacktestJob | null {
  return jobs.get(id) ?? null;
}

export function startBacktest(client: KiwoomClient, input: Partial<BacktestConfig>): { id: string } {
  const cfg: BacktestConfig = {
    market: (["000", "001", "101"] as const).includes(input.market as "000")
      ? (input.market as string)
      : "000",
    universe: Math.min(Math.max(Math.round(input.universe ?? 100) || 100, 10), 300),
    holdDays: Math.min(Math.max(Math.round(input.holdDays ?? 5) || 5, 1), 60),
    rules: (input.rules ?? [])
      .filter((r) => RULES.some((d) => d.key === r.key))
      .map((r) => ({ key: r.key, value: Number(r.value) || 0 })),
  };

  const id = `bt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job: BacktestJob = {
    status: "running",
    total: 0,
    done: 0,
    startedAt: new Date().toISOString(),
    result: null,
  };
  jobs.set(id, job);
  // 오래된 것부터 지운다 — 메모리에만 두므로 몇 개만 남긴다
  if (jobs.size > 8) jobs.delete([...jobs.keys()][0]);

  void (async () => {
    try {
      const universe = await tradeValueTop(client, cfg.market, cfg.universe);
      job.total = universe.length;

      /* 신호등 점수 조건이 켜져 있을 때만 읽는다 — 파일이 며칠치라 싸다 */
      const scores = cfg.rules.some((r) => r.key === "minScore")
        ? await signalScoreMap().catch(() => undefined)
        : undefined;

      const hits: number[] = [];
      const baseRates: number[] = [];
      const samples: BacktestResult["samples"] = [];
      let failed = 0;
      let from = "";
      let to = "";

      for (const u of universe) {
        try {
          const bs = await bars(client, u.code);
          /*
           * 조건에 60일선이 들어갈 수 있고, 판 날까지 봐야 하므로
           * 최소한 그만큼은 있어야 한 건도 나온다.
           */
          if (bs.length >= 60 + cfg.holdDays + 2) {
            if (!from || bs[0].date < from) from = bs[0].date;
            if (!to || bs[bs.length - 1].date > to) to = bs[bs.length - 1].date;

            for (let i = 60; i + cfg.holdDays + 1 < bs.length; i += 1) {
              /*
               * **다음 날 시가에 사고, 거기서 holdDays 뒤 종가에 판다.**
               * 조건은 `i` 날 종가로 봤으므로 `i` 날 종가로 사면 미래를 쓴 것이다.
               */
              const entry = bs[i + 1].open;
              const exit = bs[i + 1 + cfg.holdDays].close;
              if (entry <= 0 || exit <= 0) continue;
              const rate = ((exit - entry) / entry) * 100;

              // 기준선 — 조건을 안 걸고 같은 날 같은 방식으로 산 것
              baseRates.push(rate);

              if (cfg.rules.length > 0 && passes(bs, i, cfg.rules, scores, u.code)) {
                hits.push(rate);
                samples.push({ code: u.code, name: u.name, date: bs[i].date, rate });
              }
            }
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
        job.done += 1;
        await new Promise((r) => setTimeout(r, 260));
      }

      const hit = stat(hits);
      const base = stat(baseRates);
      job.result = {
        config: cfg,
        hit,
        base,
        edge: hit.count > 0 && base.count > 0 ? hit.avg - base.avg : null,
        codes: universe.length - failed,
        failed,
        from,
        to,
        // 잘된 것만 보여주면 자기 기만이라 **양 끝을 같이** 보여준다
        samples: [...samples]
          .sort((a, b) => b.rate - a.rate)
          .filter((_, idx, arr) => idx < 5 || idx >= arr.length - 5),
      };
      job.status = "done";
      // 기록으로 남긴다 — 조건끼리 견주는 게 이 도구의 존재 이유다
      await saveRunRecord({
        id,
        at: job.startedAt,
        config: cfg,
        label: labelOf(cfg),
        hit,
        base,
        edge: job.result.edge,
        from,
        to,
        codes: job.result.codes,
      }).catch(() => undefined);
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : "백테스트 실패";
    }
  })();

  return { id };
}
