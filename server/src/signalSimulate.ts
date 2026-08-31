import type { SignalConfig } from "./signalLight.js";
import { MA_PERIODS, gradeOf, loadSamples, scoreFeat, type Sample } from "./signalSamples.js";

/**
 * 신호등 시뮬레이터 — **설정을 바꿔 가며 즉시 다시 채점한다.**
 *
 * 표본 창고(`signalSamples`)에 원시값이 있으므로 API 를 한 번도 안 부른다.
 * 6만 관측을 다시 채점하는 데 수십 밀리초라 슬라이더를 움직이는 대로 답이 나온다.
 *
 * ## 세 가지를 낸다
 *
 * 1. **성적** — 초록/노랑/빨강과 점수 구간별 앞으로의 수익률
 * 2. **기준별 단독 성적** — 이 기준 하나만으로 갈리나. 「쓸모없는 기준」을 찾는 자리다
 * 3. **초록선 훑기** — 초록의 커트라인을 50부터 95까지 옮겨 보며 성적을 잰다
 *
 * ⚠️ **표본에 없는 기준은 채점에서 통째로 빠진다** — ETF 뒷배·영업이익·시가총액.
 * 그 기준들의 문턱은 여기서 정할 수 없다. 결과에 그 목록을 적어 보낸다.
 * (수급 3종은 2026-08-31 부터 표본에 들어왔다 — 그전 표본으로 돌리면 여전히 빠진다.)
 */

export interface Stat {
  n: number;
  d1: { avg: number | null; win: number | null };
  d5: { avg: number | null; win: number | null };
  d20: { avg: number | null; win: number | null };
}

const EMPTY: Stat = {
  n: 0,
  d1: { avg: null, win: null },
  d5: { avg: null, win: null },
  d20: { avg: null, win: null },
};

function stat(rows: { d1: number | null; d5: number | null; d20: number | null }[]): Stat {
  if (rows.length === 0) return { ...EMPTY };
  const one = (key: "d1" | "d5" | "d20") => {
    const vs = rows.map((r) => r[key]).filter((v): v is number => v !== null && Number.isFinite(v));
    if (vs.length === 0) return { avg: null, win: null };
    return {
      avg: Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100,
      win: Math.round((vs.filter((v) => v > 0).length / vs.length) * 100),
    };
  };
  return { n: rows.length, d1: one("d1"), d5: one("d5"), d20: one("d20") };
}

export interface CheckStat {
  key: string;
  label: string;
  axis: string;
  weight: number;
  threshold: number;
  strongAt: number;
  /** 표본으로 되짚을 수 있나 — 없으면 아래 성적이 전부 비어 있다 */
  inSamples: boolean;
  /** 이 기준이 만점(100)인 표본들의 성적 */
  hit: Stat;
  /** 절반(50) */
  mid: Stat;
  /** 0점 */
  miss: Stat;
  /**
   * **가르는 힘** — 만점 무리의 d20 에서 0점 무리의 d20 을 뺀 값(%p).
   * 양수면 「이 기준이 높을수록 그 뒤가 좋았다」는 뜻이다. 0 언저리면 그 기준은
   * 아무것도 안 가르고 있다 — 켜 둘 이유가 없다. **음수면 거꾸로 걸려 있다.**
   */
  edge: number | null;
}

export interface CutRow {
  cut: number;
  /** 점수가 이 값 이상인 표본 */
  s: Stat;
  /** 전체 대비 d20 초과분(%p) */
  lift: number | null;
}

export interface SimResult {
  builtAt: string;
  days: number;
  codeCount: number;
  obs: number;
  /** 채점에 실제로 쓰인 기준 이름 */
  used: string[];
  /** 켜져 있으나 표본에 없어 빠진 기준 */
  skipped: string[];
  base: Stat;
  green: Stat;
  yellow: Stat;
  red: Stat;
  buckets: { label: string; s: Stat }[];
  checks: CheckStat[];
  cuts: CutRow[];
}

const BUCKETS: [string, number, number][] = [
  ["90~100", 90, 101],
  ["80~89", 80, 90],
  ["70~79", 70, 80],
  ["60~69", 60, 70],
  ["45~59", 45, 60],
  ["0~44", -1, 45],
];

export async function simulate(cfg: SignalConfig): Promise<SimResult | null> {
  const file = await loadSamples();
  if (!file) return null;
  const S = file.samples;

  const used: string[] = [];
  const skipped: string[] = [];
  /*
   * 「표본에 있나」는 **한 표본이라도 값을 내면** 있는 것으로 본다. 종목마다
   * 못 내는 날이 있어(테마를 못 맞춘 날 등) 첫 표본만 보고 판단하면 틀린다.
   */
  const has = new Map<string, boolean>();
  for (const c of cfg.checks) {
    if (!c.enabled) continue;
    let ok = false;
    for (let i = 0; i < S.length && i < 4000; i++) {
      if (gradeOf(S[i], c, cfg) !== null) {
        ok = true;
        break;
      }
    }
    has.set(c.key, ok);
    (ok ? used : skipped).push(c.label);
  }

  const scoredRows: { score: number; s: Sample }[] = [];
  const byLevel: Record<string, Sample[]> = { green: [], yellow: [], red: [] };
  for (const s of S) {
    const r = scoreFeat(s, cfg);
    if (!r) continue;
    scoredRows.push({ score: r.score, s });
    byLevel[r.level].push(s);
  }

  const buckets = BUCKETS.map(([label, lo, hi]) => ({
    label,
    s: stat(scoredRows.filter((r) => r.score >= lo && r.score < hi).map((r) => r.s)),
  }));

  /* 기준별 단독 성적 — 「이 기준이 뭘 가르나」 */
  const checks: CheckStat[] = cfg.checks
    .filter((c) => c.enabled)
    .map((c) => {
      const inSamples = has.get(c.key) === true;
      const hit: Sample[] = [];
      const mid: Sample[] = [];
      const miss: Sample[] = [];
      if (inSamples) {
        for (const s of S) {
          const g = gradeOf(s, c, cfg);
          if (g === null) continue;
          (g >= 100 ? hit : g >= 50 ? mid : miss).push(s);
        }
      }
      const h = stat(hit);
      const m = stat(miss);
      return {
        key: c.key,
        label: c.label,
        axis: c.axis,
        weight: c.weight,
        threshold: c.threshold,
        strongAt: c.strongAt,
        inSamples,
        hit: h,
        mid: stat(mid),
        miss: m,
        edge:
          h.d20.avg !== null && m.d20.avg !== null
            ? Math.round((h.d20.avg - m.d20.avg) * 100) / 100
            : null,
      };
    });

  const base = stat(S);
  /* 초록선 훑기 — 커트라인을 옮겨 보며 「어디서 잘라야 하나」에 답한다 */
  const cuts: CutRow[] = [];
  for (let cut = 50; cut <= 95; cut += 5) {
    const s = stat(scoredRows.filter((r) => r.score >= cut).map((r) => r.s));
    cuts.push({
      cut,
      s,
      lift: s.d20.avg !== null && base.d20.avg !== null
        ? Math.round((s.d20.avg - base.d20.avg) * 100) / 100
        : null,
    });
  }

  return {
    builtAt: file.builtAt,
    days: file.days,
    codeCount: file.codeCount,
    obs: S.length,
    used,
    skipped,
    base,
    green: stat(byLevel.green),
    yellow: stat(byLevel.yellow),
    red: stat(byLevel.red),
    buckets,
    checks,
    cuts,
  };
}

/* ------------------------------------------------------------------ */
/* 전수 훑기 (2026-08-31 — "니가할수잇는 최대한의 시뮬레이션 돌려봐")     */
/* ------------------------------------------------------------------ */

/**
 * 켤 수 있는 기준의 **모든 조합**을 돌려 본다.
 *
 * ## 왜 이게 위험한가, 그래서 무엇을 같이 내는가
 *
 * 256개를 돌려 그중 제일 좋은 것을 고르면 **거의 반드시 과최적화된다.** 표본이
 * 한 장세에 몰려 있고 같은 종목이 여러 날 겹쳐 들어가 있어서, 우연히 이 기간에만
 * 맞는 조합이 하나쯤은 반드시 나온다. 그걸 「최적」이라 부르면 스스로를 속이는 것이다.
 *
 * 그래서 표본을 **날짜로 반 갈라** 앞쪽에서 고르고 뒤쪽에서 채점한다.
 * 앞에서만 좋고 뒤에서 무너지는 조합은 그 기간에 맞춘 것이고, **양쪽에서 다 좋은
 * 조합만** 믿을 만하다. 순위는 그래서 `testLift`(뒤쪽 성적)로 매긴다.
 *
 * ## 왜 빠른가
 *
 * 기준별 점수(0/50/100)는 **조합과 무관**하다. 그래서 기준×표본 격자를 한 번만
 * 만들어 두고, 조합마다 그 격자를 가중평균하기만 한다. 256개를 다 도는 데 몇 초다.
 */
export interface SweepRow {
  /** 켠 기준의 key */
  keys: string[];
  labels: string[];
  /** 초록으로 걸린 표본 수 (전체 구간) */
  n: number;
  /** 전체 평균 대비 20일 초과분(%p) — 전체 구간 */
  lift: number | null;
  win: number | null;
  /** 앞쪽 절반에서의 초과분 */
  trainLift: number | null;
  /** 뒤쪽 절반에서의 초과분 — **순위는 이것으로 매긴다** */
  testLift: number | null;
  testN: number;
}

export interface SweepResult {
  obs: number;
  splitDate: string;
  /** 앞/뒤 각각의 전체 평균 d20 — 초과분의 기준선 */
  trainBase: number | null;
  testBase: number | null;
  combos: number;
  rows: SweepRow[];
  /** 지금 저장된 설정이 이 표에서 어디쯤인가 */
  current: SweepRow | null;
}

export async function sweep(cfg: SignalConfig, topN = 25): Promise<SweepResult | null> {
  const file = await loadSamples();
  if (!file) return null;
  const S = file.samples;

  /* 되짚을 수 있고, 설정에 있는 기준만 후보다 */
  const cand = cfg.checks.filter((c) => {
    for (let i = 0; i < S.length && i < 4000; i++) {
      if (gradeOf(S[i], c, cfg) !== null) return true;
    }
    return false;
  });

  /*
   * 기준×표본 격자 — 조합마다 다시 재지 않으려고 한 번만 만든다.
   * -1 은 「낼 수 없음」이다. 0 과 갈라야 하므로 Int8Array 로 둔다.
   */
  const G: Int8Array[] = cand.map(() => new Int8Array(S.length));
  for (let ci = 0; ci < cand.length; ci++) {
    const row = G[ci];
    for (let si = 0; si < S.length; si++) {
      const g = gradeOf(S[si], cand[ci], cfg);
      row[si] = g === null ? -1 : g;
    }
  }

  /* 날짜로 반 가른다 — 앞에서 고르고 뒤에서 채점하기 위해 */
  const dates = [...new Set(S.map((s) => s.date))].sort();
  const splitDate = dates[Math.floor(dates.length / 2)];
  const isTest = S.map((s) => s.date >= splitDate);

  const d20 = S.map((s) => s.d20);
  const meanOf = (idx: number[]): { avg: number | null; win: number | null } => {
    let sum = 0;
    let cnt = 0;
    let wins = 0;
    for (const i of idx) {
      const v = d20[i];
      if (v === null || !Number.isFinite(v)) continue;
      sum += v;
      cnt++;
      if (v > 0) wins++;
    }
    if (cnt === 0) return { avg: null, win: null };
    return { avg: sum / cnt, win: Math.round((wins / cnt) * 100) };
  };
  const allIdx = S.map((_, i) => i);
  const trainIdx = allIdx.filter((i) => !isTest[i]);
  const testIdx = allIdx.filter((i) => isTest[i]);
  const baseAll = meanOf(allIdx).avg;
  const trainBase = meanOf(trainIdx).avg;
  const testBase = meanOf(testIdx).avg;

  const r2 = (v: number | null): number | null =>
    v === null ? null : Math.round(v * 100) / 100;

  /** 이 조합으로 초록이 되는 표본 인덱스 */
  const greenIdx = (mask: number): number[] => {
    const on: number[] = [];
    for (let ci = 0; ci < cand.length; ci++) if (mask & (1 << ci)) on.push(ci);
    if (on.length === 0) return [];
    const out: number[] = [];
    for (let si = 0; si < S.length; si++) {
      let riskSum = 0;
      let riskW = 0;
      const ax: Record<string, { s: number; w: number }> = {};
      for (const ci of on) {
        const g = G[ci][si];
        if (g < 0) continue;
        const c = cand[ci];
        if (c.axis === "risk") {
          riskSum += g * c.weight;
          riskW += c.weight;
        } else {
          (ax[c.axis] ??= { s: 0, w: 0 });
          ax[c.axis].s += g * c.weight;
          ax[c.axis].w += c.weight;
        }
      }
      const risk = riskW > 0 ? riskSum / riskW : null;
      if (risk !== null && risk >= 75) continue; // 위험이 초록을 막는다
      let num = 0;
      let den = 0;
      for (const k of ["trend", "flow", "value"] as const) {
        const a = ax[k];
        if (!a || a.w <= 0) continue;
        num += (a.s / a.w) * cfg.axisWeights[k];
        den += cfg.axisWeights[k];
      }
      if (den <= 0) continue;
      if (num / den >= 70) out.push(si);
    }
    return out;
  };

  const rows: SweepRow[] = [];
  const total = 1 << cand.length;
  for (let mask = 1; mask < total; mask++) {
    const idx = greenIdx(mask);
    /*
     * **너무 좁은 조합은 버린다.** 스무 건으로 낸 평균이 1등으로 올라오면
     * 표가 거짓말을 한다. 뒤쪽 절반에서 100건은 나와야 읽을 값으로 본다.
     */
    const tIdx = idx.filter((i) => isTest[i]);
    if (tIdx.length < 100) continue;
    const a = meanOf(idx);
    const tr = meanOf(idx.filter((i) => !isTest[i]));
    const te = meanOf(tIdx);
    const keys: string[] = [];
    const labels: string[] = [];
    for (let ci = 0; ci < cand.length; ci++) {
      if (mask & (1 << ci)) {
        keys.push(cand[ci].key);
        labels.push(cand[ci].label);
      }
    }
    rows.push({
      keys,
      labels,
      n: idx.length,
      lift: r2(a.avg !== null && baseAll !== null ? a.avg - baseAll : null),
      win: a.win,
      trainLift: r2(tr.avg !== null && trainBase !== null ? tr.avg - trainBase : null),
      testLift: r2(te.avg !== null && testBase !== null ? te.avg - testBase : null),
      testN: tIdx.length,
    });
  }

  /* **뒤쪽 성적**으로 줄 세운다 — 앞쪽에서 고르고 뒤쪽에서 검증하는 순서다 */
  rows.sort((x, y) => (y.testLift ?? -9999) - (x.testLift ?? -9999));

  const curKeys = new Set<string>(cfg.checks.filter((c) => c.enabled).map((c) => c.key));
  const current =
    rows.find(
      (r) =>
        r.keys.length === cand.filter((c) => curKeys.has(c.key)).length &&
        r.keys.every((k) => curKeys.has(k)),
    ) ?? null;

  return {
    obs: S.length,
    splitDate,
    trainBase: r2(trainBase),
    testBase: r2(testBase),
    combos: rows.length,
    rows: rows.slice(0, topN),
    current,
  };
}

/* ------------------------------------------------------------------ */
/* 조건부 성적표 (2026-08-31)                                          */
/* ------------------------------------------------------------------ */

/**
 * **이 신호등이 어디서 먹히고 어디서 안 먹히나.**
 *
 * ## 왜 이게 제일 큰 물음인가
 *
 * 지금 신호등은 **모든 종목·모든 장세에 같은 문턱**을 쓴다. 그게 가장 큰 구조적
 * 한계다. 같은 「60일 신고가」도 추세장과 눌림장에서 다르게 작동하고, 대형주와
 * 중소형주에서 다르게 작동한다.
 *
 * 그 차이를 오늘 직접 봤다 — 같은 기준이 120일 표본 뒤쪽에서 **-19%p**, 400일에서
 * **+3.39%p** 였다. 기준이 변한 게 아니라 **장세가** 변한 것이다. 그러면 물어야 할
 * 것은 「어느 기준이 최고인가」가 아니라 **「언제 이 기준을 믿나」**다.
 *
 * ## 조회가 0회다
 *
 * 표본이 이미 **500 종목 × 400 거래일**이다. 날짜로 묶으면 **그날 시장이 어땠는지**가
 * 표본 안에서 나온다 — 몇 %가 20일선 위였나, 몇 %가 신고가 근처였나. 종목 크기는
 * 거래대금이 대신한다. 밖에서 받아올 것이 없다.
 *
 * ## 세 축
 *
 *   ① 그날 신고가 밀도 — 추세장인가. 이 신호등의 밥줄이 마른 날인가
 *   ② 그날 시장의 폭   — 20일선 위 비율. 장세의 방향 그 자체
 *   ③ 종목 거래대금    — 큰 종목인가. 「대형주 편향」을 정면으로 본다
 *
 * 각 축을 **삼등분**한다. 다섯으로 자르면 칸마다 표본이 얇아져 숫자가 튄다.
 * 그리고 칸마다 **앞/뒤로 갈라** 잰다 — 한 칸이 우연히 좋아 보이는 것을 거른다.
 */
export interface CondCell {
  label: string;
  /** 이 칸의 전체 표본 */
  total: number;
  /** 이 칸에서 초록이던 표본 */
  n: number;
  /** 이 칸 전체의 20일 평균 — 초록을 여기에 대고 읽는다 */
  base: number | null;
  green: number | null;
  /** 초과분(%p) */
  lift: number | null;
  win: number | null;
  trainLift: number | null;
  testLift: number | null;
  testN: number;
}

export interface CondAxis {
  key: string;
  title: string;
  hint: string;
  cells: CondCell[];
}

export interface CondResult {
  obs: number;
  splitDate: string;
  axes: CondAxis[];
}

/** 삼등분 경계 — 값 배열에서 33%·67% 자리 */
function tertiles(vals: number[]): [number, number] {
  const a = [...vals].sort((x, y) => x - y);
  if (a.length === 0) return [0, 0];
  return [a[Math.floor(a.length / 3)], a[Math.floor((a.length * 2) / 3)]];
}

export async function conditional(cfg: SignalConfig): Promise<CondResult | null> {
  const file = await loadSamples();
  if (!file) return null;
  const S = file.samples;
  if (S.length === 0) return null;

  /* 초록 판정은 한 번만 — 아래 세 축이 같은 판정을 나눠 쓴다 */
  const isGreen = S.map((s) => scoreFeat(s, cfg)?.level === "green");

  /*
   * **그날 시장** — 표본을 날짜로 묶어 낸다. 표본이 그날 거래대금 상위 500 이므로
   * 「시장 전체」는 아니지만, 신호등이 실제로 고르는 모집단이 그것이라 오히려 맞다.
   */
  const byDate = new Map<string, number[]>();
  S.forEach((s, i) => {
    const list = byDate.get(s.date);
    if (list) list.push(i);
    else byDate.set(s.date, [i]);
  });
  const dayNewHigh = new Map<string, number>();
  const dayBreadth = new Map<string, number>();
  const MA20 = MA_PERIODS.indexOf(20);
  for (const [date, idx] of byDate) {
    let nh = 0;
    let nhN = 0;
    let ab = 0;
    let abN = 0;
    for (const i of idx) {
      const s = S[i];
      if (s.hiPct !== null) {
        nhN += 1;
        if (s.hiPct >= 97) nh += 1;
      }
      const m20 = s.ma[MA20];
      if (m20 !== null && m20 !== undefined && s.cur > 0) {
        abN += 1;
        if (s.cur >= m20) ab += 1;
      }
    }
    dayNewHigh.set(date, nhN > 0 ? (nh / nhN) * 100 : 0);
    dayBreadth.set(date, abN > 0 ? (ab / abN) * 100 : 0);
  }

  /* 앞/뒤 — 전수 훑기와 같은 자리에서 가른다 */
  const dates = [...byDate.keys()].sort();
  const splitDate = dates[Math.floor(dates.length / 2)];

  const d20 = S.map((s) => s.d20);
  const stat2 = (idx: number[]) => {
    let sum = 0;
    let cnt = 0;
    let win = 0;
    for (const i of idx) {
      const v = d20[i];
      if (v === null || !Number.isFinite(v)) continue;
      sum += v;
      cnt++;
      if (v > 0) win++;
    }
    return cnt === 0
      ? { avg: null as number | null, win: null as number | null, n: 0 }
      : { avg: sum / cnt, win: Math.round((win / cnt) * 100), n: cnt };
  };
  const r2 = (v: number | null): number | null => (v === null ? null : Math.round(v * 100) / 100);

  /** 한 칸을 잰다 — 그 칸 안에서 「초록이 그 칸 평균을 이겼나」 */
  const cell = (label: string, idx: number[]): CondCell => {
    const all = stat2(idx);
    const g = idx.filter((i) => isGreen[i]);
    const gs = stat2(g);
    const tr = g.filter((i) => S[i].date < splitDate);
    const te = g.filter((i) => S[i].date >= splitDate);
    const baseTr = stat2(idx.filter((i) => S[i].date < splitDate));
    const baseTe = stat2(idx.filter((i) => S[i].date >= splitDate));
    const gTr = stat2(tr);
    const gTe = stat2(te);
    const sub = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null);
    return {
      label,
      total: idx.length,
      n: g.length,
      base: r2(all.avg),
      green: r2(gs.avg),
      lift: r2(sub(gs.avg, all.avg)),
      win: gs.win,
      trainLift: r2(sub(gTr.avg, baseTr.avg)),
      testLift: r2(sub(gTe.avg, baseTe.avg)),
      testN: gTe.n,
    };
  };

  /** 값으로 삼등분해 축 하나를 만든다 */
  const axisOf = (
    key: string,
    title: string,
    hint: string,
    labels: [string, string, string],
    valueOf: (i: number) => number | null,
  ): CondAxis => {
    const vals: number[] = [];
    for (let i = 0; i < S.length; i++) {
      const v = valueOf(i);
      if (v !== null && Number.isFinite(v)) vals.push(v);
    }
    const [lo, hi] = tertiles(vals);
    const buckets: number[][] = [[], [], []];
    for (let i = 0; i < S.length; i++) {
      const v = valueOf(i);
      if (v === null || !Number.isFinite(v)) continue;
      buckets[v < lo ? 0 : v < hi ? 1 : 2].push(i);
    }
    return {
      key,
      title,
      hint,
      cells: [
        cell(`${labels[0]} (~${Math.round(lo * 10) / 10})`, buckets[0]),
        cell(`${labels[1]} (${Math.round(lo * 10) / 10}~${Math.round(hi * 10) / 10})`, buckets[1]),
        cell(`${labels[2]} (${Math.round(hi * 10) / 10}~)`, buckets[2]),
      ],
    };
  };

  const axes: CondAxis[] = [
    axisOf(
      "newHighDensity",
      "그날 신고가 밀도 — 추세장인가",
      "표본 중 60일 신고가 근처(97%↑)인 종목 비율(%). 이 신호등의 추세 축이 「60일 신고가」 하나뿐이라, 이게 마른 날은 초록 자체가 드물다",
      ["마른 날", "보통", "무성한 날"],
      (i) => dayNewHigh.get(S[i].date) ?? null,
    ),
    axisOf(
      "breadth",
      "그날 시장의 폭 — 20일선 위 비율",
      "표본 중 20일선 위에 있는 종목 비율(%). 장세의 방향 그 자체다",
      ["좁은 날", "보통", "넓은 날"],
      (i) => dayBreadth.get(S[i].date) ?? null,
    ),
    axisOf(
      "size",
      "종목 크기 — 그날 거래대금",
      "그날 거래대금(억). 시가총액 대신 쓴다 — 「대형주 편향」을 정면으로 본다. 표본이 이미 거래대금 상위라 셋 다 큰 편이지만 그 안에서도 갈린다",
      ["작은 쪽", "중간", "큰 쪽"],
      (i) => S[i].volEok,
    ),
  ];

  return { obs: S.length, splitDate, axes };
}
