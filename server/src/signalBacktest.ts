import type { KiwoomClient } from "./kiwoomClient.js";
import { DEFAULT_CONFIG, type CheckConfig, type SignalConfig } from "./signalLight.js";

/**
 * 신호등 백테스트 — **과거의 그날로 돌아가 같은 기준으로 다시 매긴다.**
 *
 * ## 무엇을 답하나
 *
 * 「이 기준으로 초록을 준 종목이 그 뒤 어떻게 됐나」. 기준을 바꿔 가며 돌리면
 * 가중치와 문턱을 감이 아니라 숫자로 정할 수 있다.
 *
 * ## ⚠️ 재현할 수 있는 것과 없는 것
 *
 * 신호등의 모든 기준을 과거로 되돌릴 수는 없다. **일봉만 있으면 되는 것**은 그대로
 * 재현된다 — 정배열·신고가·이격도·매물 부담·거래대금. 어느 날의 일봉은 지금도
 * 그때와 같기 때문이다.
 *
 * 재현 못 하는 것은 **그때의 구성을 모르는 것들**이다:
 *   · 테마 강세 — 석 달 전에 어느 종목이 어느 테마였는지 우리에게 없다
 *   · ETF 뒷배 — 그때의 편입 비중을 모른다
 *   · 수급·재무 — 받아올 수는 있지만 종목마다 조회가 더 나간다
 *
 * 그래서 **이 백테스트는 일봉 기준만 쓴다.** 빠진 기준이 무엇인지 결과에 적어
 * 보낸다 — 「전부 재현했다」고 보이면 그 숫자를 잘못 믿게 된다.
 *
 * 없는 것을 지어내지 않는 대신, 있는 것만으로 답할 수 있는 물음이 있다:
 * **가격이 그린 모양만으로 얼마나 갈 수 있나.**
 */

const CHART = "/api/dostk/chart";

/** 백테스트가 재현할 수 있는 기준 — 나머지는 계산에서 빠진다 */
export const BACKTESTABLE = new Set([
  "trend",
  "newHigh",
  "nearHigh",
  "disparity",
  "ma5Gap",
  "overhead",
  "volume",
]);

export interface BacktestRow {
  /** 신호가 켜진 날 (YYYYMMDD) */
  date: string;
  code: string;
  name: string;
  score: number;
  level: "green" | "yellow" | "red";
  /** 그날 종가 */
  close: number;
  /** N거래일 뒤 수익률(%) — 아직 그만큼 안 지났으면 null */
  d1: number | null;
  d5: number | null;
  d20: number | null;
}

export interface BacktestResult {
  /** 실제로 쓴 기준 */
  used: string[];
  /** 과거를 몰라 뺀 기준 */
  skipped: string[];
  days: number;
  codes: number;
  rows: BacktestRow[];
  /** 초록만 모은 성적 */
  green: Summary;
  /** 견줄 대상 — 같은 기간 **모든 날·모든 종목**의 평균. 이걸 못 이기면 뜻이 없다 */
  base: Summary;
  /**
   * 점수대별 성적 — **이 표가 기준이 맞는지를 스스로 증명한다.**
   *
   * 70점 초록과 95점 초록이 한 칸에 섞여 있으면 「초록이 좋다」까지만 알 수 있다.
   * 점수를 나눠 놓고 **위 칸이 아래 칸보다 잘 갔는지** 보면, 점수라는 것이 실제로
   * 무언가를 재고 있는지가 드러난다. 순서가 뒤집혀 있으면(80점대가 60점대보다 못
   * 가면) 그 기준 조합은 점수를 잘못 매기고 있는 것이다.
   */
  buckets: { label: string; from: number; to: number; s: Summary }[];
  note: string;
}

export interface Summary {
  n: number;
  d1: { avg: number | null; win: number | null };
  d5: { avg: number | null; win: number | null };
  d20: { avg: number | null; win: number | null };
}

interface Bar {
  date: string;
  close: number;
  high: number;
  low: number;
  vol: number;
}

function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

/** 일봉 — 옛날→최신 */
async function bars(client: KiwoomClient, code: string): Promise<Bar[]> {
  const base = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART, "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  return ((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[])
    .map((r) => ({
      date: String(r.dt ?? ""),
      close: Math.abs(n(r.cur_prc)),
      high: Math.abs(n(r.high_pric)),
      low: Math.abs(n(r.low_pric)),
      vol: Math.abs(n(r.trde_qty)),
    }))
    .filter((b) => /^\d{8}$/.test(b.date) && b.close > 0)
    .reverse();
}

const sma = (xs: number[], p: number): number | null =>
  xs.length < p ? null : xs.slice(-p).reduce((a, b) => a + b, 0) / p;

function grade(value: number, c: CheckConfig): number {
  const hi = Math.max(c.threshold, c.strongAt);
  const lo = Math.min(c.threshold, c.strongAt);
  if (value >= hi) return 100;
  if (value >= lo) return 50;
  return 0;
}

/**
 * 어느 하루의 점수 — **그날까지의 봉만 본다.**
 *
 * `at` 이 그날의 인덱스다. 뒤쪽(미래) 봉을 실수로 쓰면 백테스트가 통째로 거짓이
 * 되므로, 자를 때 항상 `slice(0, at + 1)` 로 끊는다.
 */
function scoreAt(all: Bar[], at: number, cfg: SignalConfig): { score: number; level: BacktestRow["level"] } | null {
  const hist = all.slice(0, at + 1);
  if (hist.length < 65) return null; // 60일 지표를 내려면 그만큼은 있어야 한다
  const closes = hist.map((b) => b.close);
  const cur = closes[closes.length - 1];

  const axes: Record<string, { sum: number; w: number }> = {};
  const add = (axis: string, g: number | null, w: number) => {
    if (g === null) return;
    (axes[axis] ??= { sum: 0, w: 0 });
    axes[axis].sum += g * w;
    axes[axis].w += w;
  };

  for (const c of cfg.checks) {
    if (!c.enabled || !BACKTESTABLE.has(c.key)) continue;
    let g: number | null = null;

    if (c.key === "trend") {
      const ma = [...cfg.maLines].sort((a, b) => a - b).map((p) => sma(closes, p));
      if (ma.every((v) => v !== null)) {
        const v = ma as number[];
        const full = cur >= v[0] && v.every((x, i) => i === 0 || v[i - 1] >= x);
        g = full ? 100 : cur >= v[0] ? 50 : 0;
      }
    } else if (c.key === "newHigh" || c.key === "nearHigh") {
      const win = closes.slice(-61, -1);
      const hi = win.length > 0 ? Math.max(...win) : 0;
      if (hi > 0) g = grade((cur / hi) * 100, c);
    } else if (c.key === "disparity") {
      const m = sma(closes, 20);
      if (m) g = grade(Math.max(0, ((cur - m) / m) * 100), c);
    } else if (c.key === "ma5Gap") {
      const m = sma(closes, 5);
      if (m) g = grade(Math.max(0, ((cur - m) / m) * 100), c);
    } else if (c.key === "overhead") {
      const win = hist.slice(-120);
      const hi = Math.max(...win.map((b) => b.high));
      const lo = Math.min(...win.map((b) => b.low));
      if (hi > lo) {
        const above = win.filter((b) => (b.high + b.low) / 2 > cur).reduce((s, b) => s + b.vol, 0);
        const tot = win.reduce((s, b) => s + b.vol, 0);
        if (tot > 0) g = grade((above / tot) * 100, c);
      }
    } else if (c.key === "volume") {
      g = grade((hist[hist.length - 1].vol * cur) / 100_000_000, c);
    }

    add(c.axis, g, c.weight);
  }

  const risk = axes.risk ? axes.risk.sum / axes.risk.w : null;
  const good = (["trend", "flow", "value"] as const)
    .map((k) => ({ k, a: axes[k] }))
    .filter((x) => x.a);
  if (good.length === 0) return null;

  const wSum = good.reduce((s, x) => s + cfg.axisWeights[x.k], 0);
  const score = Math.round(
    good.reduce((s, x) => s + (x.a.sum / x.a.w) * cfg.axisWeights[x.k], 0) / wSum,
  );

  /*
   * 위험은 **섞지 않는다** — 실제 신호등과 같은 규칙이다.
   * 위험 점수가 높으면(=위험하면) 초록을 막는다.
   */
  const level: BacktestRow["level"] =
    risk !== null && risk >= 75 ? "red" : score >= 70 ? "green" : score >= 45 ? "yellow" : "red";
  return { score, level };
}

function summarize(rows: { d1: number | null; d5: number | null; d20: number | null }[]): Summary {
  const one = (key: "d1" | "d5" | "d20") => {
    const vs = rows.map((r) => r[key]).filter((v): v is number => v !== null);
    if (vs.length === 0) return { avg: null, win: null };
    return {
      avg: Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100,
      win: Math.round((vs.filter((v) => v > 0).length / vs.length) * 100),
    };
  };
  return { n: rows.length, d1: one("d1"), d5: one("d5"), d20: one("d20") };
}

let running = false;
let progress = { done: 0, total: 0 };
export const backtestProgress = () => ({ ...progress, running });

/**
 * 백그라운드 잡 (2026-08-28) — **요청이 결과를 기다리지 않는다.**
 *
 * 150종목 × 220ms 면 30초가 넘는데, 그동안 요청 하나가 붙잡혀 있었고
 * **페이지를 떠나면 결과를 통째로 잃었다** — 돌아와도 다시 돌려야 한다.
 * 신호등 찾기(signalScreen)와 같은 꼴로 바꾼다: 시작 → 즉시 응답 →
 * 진행 폴링 → 끝나면 결과 조회. 마지막 결과는 메모리에 남아, 탭을 떠났다
 * 돌아와도 그대로 있다 (서버 재시작이면 사라진다 — 백테스트는 다시 돌리면 된다).
 */
let lastResult: { result: BacktestResult; at: string; error?: never } | { result?: never; at: string; error: string } | null = null;

export function backtestResult() {
  return lastResult ?? { result: null, at: "" };
}

export function startBacktestJob(
  client: KiwoomClient,
  opts: { codes: { code: string; name: string }[]; days?: number; config?: Partial<SignalConfig> },
): { started: boolean } {
  if (running) return { started: false }; // 하나면 된다 — 겹치면 키움 한도가 터진다
  void runSignalBacktest(client, opts)
    .then((result) => {
      lastResult = { result, at: new Date().toISOString() };
    })
    .catch((err) => {
      lastResult = { error: err instanceof Error ? err.message : "실패했습니다", at: new Date().toISOString() };
    });
  return { started: true };
}

/**
 * 돌린다.
 *
 * 종목마다 일봉 한 번(600봉 안팎)이라 100종목이면 100콜, 초당 5건 제한으로 20초쯤이다.
 * 설정은 **저장하지 않는다** — 조절해 보는 자리라 지금 쓰는 기준을 건드리면 안 된다.
 */
export async function runSignalBacktest(
  client: KiwoomClient,
  opts: { codes: { code: string; name: string }[]; days?: number; config?: Partial<SignalConfig> },
): Promise<BacktestResult> {
  const cfg: SignalConfig = {
    ...DEFAULT_CONFIG,
    ...opts.config,
    axisWeights: { ...DEFAULT_CONFIG.axisWeights, ...(opts.config?.axisWeights ?? {}) },
    checks: opts.config?.checks ?? DEFAULT_CONFIG.checks,
    maLines: opts.config?.maLines ?? DEFAULT_CONFIG.maLines,
  };
  const days = Math.min(Math.max(opts.days ?? 120, 20), 400);

  running = true;
  progress = { done: 0, total: opts.codes.length };
  const rows: BacktestRow[] = [];
  const all: { d1: number | null; d5: number | null; d20: number | null }[] = [];
  /* 점수대별로 나누려면 **초록이 아닌 것까지** 점수를 들고 있어야 한다 */
  const scored: { score: number; d1: number | null; d5: number | null; d20: number | null }[] = [];

  try {
    for (const { code, name } of opts.codes) {
      try {
        const bs = await bars(client, code);
        // 마지막 봉은 오늘(미완성)일 수 있으나 종가 기준이라 그대로 쓴다
        const from = Math.max(65, bs.length - days);
        for (let i = from; i < bs.length; i++) {
          const fwd = (k: number): number | null => {
            const j = i + k;
            return j < bs.length && bs[i].close > 0
              ? ((bs[j].close - bs[i].close) / bs[i].close) * 100
              : null;
          };
          const f = { d1: fwd(1), d5: fwd(5), d20: fwd(20) };
          all.push(f);

          const s = scoreAt(bs, i, cfg);
          if (!s) continue;
          scored.push({ score: s.score, ...f });
          /*
           * **전부 담는다** — 화면에서 점수대를 눌러 그 구간의 종목을 보기 때문이다.
           * 초록만 담았을 때는 「60점대는 무엇이었나」에 답할 수가 없었다.
           * 아래에서 점수 높은 순으로 잘라 보내므로 응답이 무한정 커지지는 않는다.
           */
          rows.push({ date: bs[i].date, code, name, close: bs[i].close, ...s, ...f });
        }
      } catch {
        /* 이 종목만 건너뛴다 */
      }
      progress = { done: progress.done + 1, total: opts.codes.length };
      await new Promise((r) => setTimeout(r, 220));
    }
  } finally {
    running = false;
  }

  const used = cfg.checks.filter((c) => c.enabled && BACKTESTABLE.has(c.key)).map((c) => c.label);
  const skipped = cfg.checks.filter((c) => c.enabled && !BACKTESTABLE.has(c.key)).map((c) => c.label);

  /*
   * 점수대 — 신호등의 경계(45·70)에 맞춰 나눈다. 그래야 「노랑 안에서도 위쪽이
   * 나은가」·「초록 안에서 90점이 70점보다 나은가」를 각각 볼 수 있다.
   */
  const CUTS: { label: string; from: number; to: number }[] = [
    { label: "90~100 (초록)", from: 90, to: 101 },
    { label: "80~89 (초록)", from: 80, to: 90 },
    { label: "70~79 (초록)", from: 70, to: 80 },
    { label: "60~69 (노랑)", from: 60, to: 70 },
    { label: "45~59 (노랑)", from: 45, to: 60 },
    { label: "0~44 (빨강)", from: 0, to: 45 },
  ];
  const buckets = CUTS.map((c) => ({
    ...c,
    s: summarize(scored.filter((x) => x.score >= c.from && x.score < c.to)),
  }));

  return {
    used,
    skipped,
    days,
    codes: opts.codes.length,
    /*
     * 점수대마다 **골고루** 남긴다. 날짜순으로 300개를 자르면 최근 며칠이 다 먹어
     * 「60점대 목록」이 통째로 비는 일이 생긴다.
     */
    rows: CUTS.flatMap((c) =>
      rows
        .filter((r) => r.score >= c.from && r.score < c.to)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 60),
    ),
    green: summarize(rows.filter((r) => r.level === "green")),
    base: summarize(all),
    buckets,
    note:
      "일봉으로 되살릴 수 있는 기준만 씁니다 — 테마·ETF·수급·재무는 **그때의 구성을 모르므로** 뺐습니다. " +
      "「전체」는 같은 기간 모든 날·모든 종목의 평균입니다. 초록이 이걸 못 이기면 그 기준은 쓸모가 없습니다.",
  };
}
