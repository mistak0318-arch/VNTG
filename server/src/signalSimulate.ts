import type { SignalConfig } from "./signalLight.js";
import { gradeOf, loadSamples, scoreFeat, type Sample } from "./signalSamples.js";

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
 * ⚠️ **표본에 없는 기준은 채점에서 통째로 빠진다** — 수급 4종·영업이익·시가총액·
 * ETF 뒷배. 그 기준들의 문턱은 여기서 정할 수 없다. 결과에 그 목록을 적어 보낸다.
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
      if (gradeOf(S[i], c, cfg.maLines) !== null) {
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
          const g = gradeOf(s, c, cfg.maLines);
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
      if (gradeOf(S[i], c, cfg.maLines) !== null) return true;
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
      const g = gradeOf(S[si], cand[ci], cfg.maLines);
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
