import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configFingerprint, type SignalConfig } from "./signalLight.js";
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

/**
 * 한 무리의 성적.
 *
 * ## ⚠️ 평균만 보면 속는다 (2026-09-01)
 *
 * 표본에 **20일 +444%**(가온전선)·+310%(인벤티지랩) 같은 것들이 있다. 그런 몇
 * 개가 평균을 통째로 만든다 — 실제로 「초과 +5.63%p」였던 설정이 표본을 8% 바꾸자
 * **+0.19%p** 로 무너졌다. 그렇게 쉽게 뒤집히는 값은 근거가 못 된다.
 *
 * 그래서 넷을 함께 낸다:
 *
 *   avg   평균          — 극단값이 지배한다. 참고용
 *   med   중앙값        — 극단값에 안 흔들린다
 *   trim  절사평균      — 위아래 2% 를 버린 평균. 평균과 중앙값의 중간 성격
 *   win   승률          — 크기를 안 보고 방향만. 극단값과 무관하다
 *
 * **셋(중앙값·절사평균·승률)이 다 같은 방향일 때만 믿는다.**
 */
export interface Stat {
  n: number;
  d1: Cut;
  d5: Cut;
  d20: Cut;
}

export interface Cut {
  avg: number | null;
  /** 중앙값 — 극단값에 안 흔들린다 */
  med: number | null;
  /** 절사평균(위아래 2% 버림) */
  trim: number | null;
  win: number | null;
}

const EMPTY_CUT: Cut = { avg: null, med: null, trim: null, win: null };

const EMPTY: Stat = {
  n: 0,
  d1: { ...EMPTY_CUT },
  d5: { ...EMPTY_CUT },
  d20: { ...EMPTY_CUT },
};

const r2 = (v: number) => Math.round(v * 100) / 100;

function stat(rows: { d1: number | null; d5: number | null; d20: number | null }[]): Stat {
  if (rows.length === 0) return { ...EMPTY };
  const one = (key: "d1" | "d5" | "d20"): Cut => {
    const vs = rows.map((r) => r[key]).filter((v): v is number => v !== null && Number.isFinite(v));
    if (vs.length === 0) return { ...EMPTY_CUT };
    const sorted = [...vs].sort((a, b) => a - b);
    const m = sorted.length >> 1;
    const med = sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
    /* 위아래 2% 를 버린다 — 50개 미만이면 버릴 것이 없어 평균 그대로 */
    const k = sorted.length >= 50 ? Math.floor(sorted.length * 0.02) : 0;
    const inner = k > 0 ? sorted.slice(k, sorted.length - k) : sorted;
    return {
      avg: r2(vs.reduce((a, b) => a + b, 0) / vs.length),
      med: r2(med),
      trim: r2(inner.reduce((a, b) => a + b, 0) / inner.length),
      /*
       * ⚠️ 예전엔 `Math.round(...)` 로 **정수**였다 (2026-09-01 고침).
       *
       * 승률 차이가 소수점 아래에서 갈리는데 정수로 뭉개면 **+0.11%p 가 0 이 되고**,
       * 「셋이 다 양수」 판정이 그것 때문에 거짓으로 떨어진다. 실제로 80·85점
       * 문턱이 그렇게 탈락 표시가 났다 — 눈금이 값을 지우고 있었다.
       */
      win: Math.round((vs.filter((v) => v > 0).length / vs.length) * 10000) / 100,
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

/** 앞/뒤 한쪽의 초과분 */
export interface LiftCut {
  med: number | null;
  trim: number | null;
  win: number | null;
  n: number;
}

/** 문턱 하나의 앞/뒤 성적 — 「몇 점부터 값을 하나」의 답 */
export interface SplitRow {
  cut: number;
  front: LiftCut;
  back: LiftCut;
  /** 앞뒤 여섯 값이 **전부 양수**이고 뒤쪽 표본이 넉넉한가 */
  good: boolean;
}

/**
 * 점수 **구간** 하나의 앞/뒤 성적 — 「이상」이 아니라 구간이다.
 *
 * 누적으로는 「위쪽이 고점신호인가」에 답할 수 없다. 90점 이상이 좋아 보여도
 * 그건 70~89 가 만든 값일 수 있다.
 */
/**
 * walk-forward 한 단계 — **학습 구간만 보고 고른 문턱을, 아직 안 본 구간에서 채점.**
 */
export interface FoldRow {
  /** 학습 구간의 끝(이 날짜 미만까지 학습) */
  trainTo: string;
  testFrom: string;
  testTo: string;
  trainN: number;
  /** 학습 구간이 고른 문턱 — null 이면 「쓸 문턱이 없다」(그 단계는 안 산다) */
  cut: number | null;
  /** 채점 구간 성적. `cut` 이 null 이면 null */
  test: LiftCut | null;
}

export interface WalkSummary {
  /** 문턱을 어떻게 골랐나 — lowest(가장 낮은) · best(초과분 최대) */
  rule: "lowest" | "best";
  folds: FoldRow[];
  /** 실제로 채점된 단계 수 */
  graded: number;
  /** 중앙값·승률이 둘 다 양수였던 단계 */
  won: number;
  wonMed: number;
  wonWin: number;
  /** 쓸 문턱을 못 찾아 건너뛴 단계 */
  skipped: number;
}

export interface BandRow {
  lo: number;
  /** 포함하는 위끝 (95~100 이면 100) */
  hi: number;
  front: LiftCut;
  back: LiftCut;
  good: boolean;
}

export interface SimResult {
  builtAt: string;
  /**
   * **문턱별 앞/뒤 성적** (2026-09-01) — 화면이 「55점 이상이 앞뒤 모두 시장을
   * 이긴 구간」이라고 적을 수 있게. 사람이 신호등을 돌렸을 때 그 점수가 무슨
   * 뜻인지 알아야 쓸 수 있다.
   */
  splits: SplitRow[];
  /**
   * **점수 구간별 성적** (2026-09-01) — 「과한 점수는 고점신호인가」에 답하는 표.
   * 누적이 아니라 구간이라, 위쪽이 정말 나쁜지 여기서만 보인다.
   */
  bands: BandRow[];
  /**
   * **walk-forward** (2026-09-01) — 앞/뒤 2분할보다 엄한 검증.
   * 학습 구간만 보고 문턱을 고른 뒤 아직 안 본 구간에서 채점하는 것을 되풀이한다.
   */
  walk: WalkSummary;
  /** 같은 walk-forward 를 **초과분 최대** 규칙으로 다시 — 어느 규칙이 나은지 비교용 */
  walkBest: WalkSummary;
  /** 앞뒤 모두 통하는 문턱 중 가장 높은 것 — 없으면 null(그런 문턱이 없다는 뜻) */
  bestCut: number | null;
  /** 앞/뒤를 가른 날짜 */
  splitAt: string;
  /**
   * **덜 재서 뺀 관측 수** (2026-09-01).
   *
   * 이 숫자가 크면 표본이 얇은 것이다 — 판정이 그만큼 좁은 데서 나왔다는 뜻이라
   * 화면이 말해 줘야 한다.
   */
  thin: number;
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

/**
 * **날짜별 장세** — 실제 신호등과 같은 정의.
 *
 * 「그날 표본 종목 중 20일선 위인 비율」이 `bullAt` 이상이면 강세장. 그 시점
 * 정보만 쓰므로 되짚어도 거짓이 안 된다.
 *
 * 세 곳(시뮬레이트·조건부·전수훑기)이 **같은 자**를 써야 화면끼리 말이 어긋나지
 * 않는다. 한 번 내서 나눠 쓴다.
 */
export function regimeMap(S: Sample[], cfg: SignalConfig): Map<string, "bull" | "bear"> {
  const out = new Map<string, "bull" | "bear">();
  if (!cfg.regimeSwitch) return out;
  const byDate = new Map<string, { above: number; total: number }>();
  for (const r of S) {
    const m20 = r.ma[MA_PERIODS.indexOf(20)];
    if (m20 === null || m20 === undefined || m20 <= 0) continue;
    const acc = byDate.get(r.date) ?? { above: 0, total: 0 };
    acc.total += 1;
    if (r.cur >= m20) acc.above += 1;
    byDate.set(r.date, acc);
  }
  for (const [d, a] of byDate) {
    /* 그날 표본이 너무 적으면 판정하지 않는다 — 몇 종목으로 장세를 말할 수 없다 */
    if (a.total < 20) continue;
    out.set(d, (a.above / a.total) * 100 >= cfg.bullAt ? "bull" : "bear");
  }
  return out;
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

  /*
   * **날짜별 장세** (2026-09-01) — 실제 신호등과 같은 정의로 낸다.
   *
   * 「그날 표본 종목 중 20일선 위인 비율」이 `bullAt` 이상이면 강세장.
   * 그 시점 정보만 쓰므로 되짚어도 거짓이 안 된다.
   *
   * ⚠️ 이게 없으면 시뮬레이터가 **실제와 다른 것을 잰다.** 신고가는 강세장에서
   * 승률 +1.4%p 인데 약세장에서 -3.9%p 라, 장세를 안 가리고 채점하면 실제 점수와
   * 다른 점수가 나온다. 그 값을 화면에 「근거」로 띄우면 틀린 근거가 된다.
   */
  const regimeOf = regimeMap(S, cfg);

  /*
   * ## **덜 잰 관측은 뺀다** (2026-09-01) — 이 시뮬레이터에서 가장 크게 틀렸던 자리
   *
   * 렌즈가 없는 기준은 채점에서 빠지고 남은 것만으로 평균이 난다. 그래서
   * **덜 잰 관측이 더 쉽게 높은 점수를 받았고**, 그것들이 표본 앞쪽(2025년 초,
   * 영업이익이 80% 비어 있던 구간)에 몰려 있었다.
   *
   * 실측: 커버리지 0.80~0.89 구간의 70점 통과가 중앙 **-1.92**·승률 **-5.04**.
   * 그 12% 가 판정표의 앞쪽을 통째로 마이너스로 만들고 있었다 — 「앞쪽만 뒤집힌다」의
   * 정체가 점수 체계가 아니라 **데이터 결손**이었다.
   *
   * 0.9 문턱을 걸자 55~90점 전 구간이 앞·뒤 여섯 값 모두 양수가 됐고, 「꼭대기가
   * 나쁘다」도 함께 사라졌다(90~100점이 앞 +1.19·뒤 +1.71 로 가장 좋다).
   *
   * 실제 신호등도 같은 규칙으로 초록을 막는다. **두 곳이 같아야** 검증에서 통과한
   * 설정이 실전에서 같은 것을 고른다.
   */
  const scoredRows: { score: number; s: Sample }[] = [];
  const byLevel: Record<string, Sample[]> = { green: [], yellow: [], red: [] };
  let thin = 0;
  for (const s of S) {
    const r = scoreFeat(s, cfg, regimeOf.get(s.date));
    if (!r) continue;
    if (r.lowCoverage) {
      thin += 1;
      continue;
    }
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

  /*
   * 기저는 **채점된 것들**이다 — 덜 재서 뺀 관측을 기저에 넣으면 비교 상대가
   * 달라져 초과분이 부풀거나 꺾인다.
   */
  const base = stat(scoredRows.map((r) => r.s));
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

  /*
   * ## **앞/뒤 분할** — 이게 없으면 숫자가 거짓말을 한다 (2026-09-01)
   *
   * 표본 전체로 낸 성적은 **고른 데서 채점한 것**이라 늘 좋아 보인다. 문턱을
   * 구간별 표를 보고 골랐으면 그 표에 맞춰진 값이기 때문이다.
   *
   * 날짜로 반 갈라 **뒤쪽(아직 안 본 구간)** 에서 다시 잰다. 실제로 이 분할이
   * 「초과 +7.95%p」를 「뒤쪽 -19%p」로 잡아낸 적이 있다.
   *
   * ⚠️ 그리고 **중앙값·절사평균·승률을 같이 본다.** 평균만 보면 20일 +444% 짜리
   * 몇 개가 만든 값에 속는다 — 실제로 「+5.63%p」가 표본 8% 가 바뀌자 +0.19%p 로
   * 무너졌다. 셋이 다 같은 방향일 때만 믿는다.
   */
  const dates = [...new Set(S.map((r) => r.date))].sort();
  const midDate = dates[Math.floor(dates.length / 2)] ?? "";
  const half = (rows: { score: number; s: Sample }[], back: boolean) =>
    rows.filter((r) => (back ? r.s.date >= midDate : r.s.date < midDate));

  const cutRows = (rows: { score: number; s: Sample }[], cut: number) =>
    rows.filter((r) => r.score >= cut).map((r) => r.s);

  /**
   * **문턱별 앞/뒤 성적** — 화면이 「몇 점부터 값을 하나」를 말할 수 있게.
   *
   * 「55점 이상이 앞뒤 모두 시장을 이긴 구간」 같은 한 줄이 여기서 나온다.
   * 사람이 신호등을 돌렸을 때 **그 점수가 무슨 뜻인지** 알아야 쓸 수 있다.
   */
  /** 두 무리의 차이 — 「이 무리가 그 반쪽의 평균을 얼마나 이겼나」 */
  const lift = (a: Stat, base0: Stat) => ({
    med: a.d20.med !== null && base0.d20.med !== null ? r2(a.d20.med - base0.d20.med) : null,
    trim: a.d20.trim !== null && base0.d20.trim !== null ? r2(a.d20.trim - base0.d20.trim) : null,
    win: a.d20.win !== null && base0.d20.win !== null ? r2(a.d20.win - base0.d20.win) : null,
    n: a.n,
  });

  const splits: SplitRow[] = [];
  for (let cut = 40; cut <= 90; cut += 5) {
    const fRows = half(scoredRows, false);
    const bRows = half(scoredRows, true);
    const fBase = stat(fRows.map((r) => r.s));
    const bBase = stat(bRows.map((r) => r.s));
    const f = stat(cutRows(fRows, cut));
    const b = stat(cutRows(bRows, cut));
    const fl = lift(f, fBase);
    const bl = lift(b, bBase);
    splits.push({
      cut,
      front: fl,
      back: bl,
      /* **셋이 다 양수일 때만** 믿는다 — 하나라도 음수면 근거가 못 된다 */
      good:
        [fl.med, fl.trim, fl.win, bl.med, bl.trim, bl.win].every(
          (v) => v !== null && v > 0,
        ) && bl.n >= 200,
    });
  }
  /** 앞뒤 모두 통하는 문턱 중 **가장 높은** 것 — 화면이 「N점부터」라고 적는다 */
  const bestCut = [...splits].reverse().find((x) => x.good)?.cut ?? null;

  /**
   * ## **walk-forward** (2026-09-01) — 2분할로는 못 답하는 물음
   *
   * 앞/뒤 2분할은 **뒤쪽 한 구간**만 본다. 그 구간이 특이했으면 결론이 통째로 거기
   * 좌우된다. 오늘 실제로 봤다 — 구간별 기저 중앙값이 -4.43 에서 +3.33 까지
   * 흔들리고, 어떤 구간은 통과분이 마이너스였다.
   *
   * walk-forward 는 **아직 안 본 구간에서만 채점**하는 것을 여러 번 되풀이한다:
   *
   *   구간 1 2 3 4 5 6
   *   단계1  학습 1,2      → 채점 3
   *   단계2  학습 1,2,3    → 채점 4
   *   단계3  학습 1~4      → 채점 5
   *   단계4  학습 1~5      → 채점 6
   *
   * ⚠️ **학습 구간만 보고 문턱을 고른다.** 여기가 핵심이다. `bestCut` 은 「앞뒤
   * 모두 통하는 문턱」이라 **채점 구간을 이미 본 채로 고른 값**이다. 그렇게 고른
   * 문턱으로 그 구간을 채점하면 당연히 좋게 나온다 — 그게 과적합이고, 오늘
   * 커버리지 건에서 한 번 당했다.
   *
   * 고르는 규칙은 화면의 「N점부터」와 **같다**: 학습 구간에서 중앙값·절사평균·
   * 승률 셋이 다 양수인 **가장 낮은** 문턱. 낮은 쪽인 이유는 표본을 크게 남겨서다.
   *
   * ⚠️ 학습 구간에서 통하는 문턱이 **없으면 그 단계는 건너뛴다.** 실전으로 치면
   * 「오늘은 살 게 없다」이고 그것도 결과의 일부다 — 억지로 아무 문턱이나 고르면
   * 그 단계가 성적을 오염시킨다.
   */
  /**
   * 문턱을 고르는 **두 규칙** — 어느 쪽이 나은지 재서 정한다.
   *
   *   lowest  셋이 다 양수인 **가장 낮은** 문턱. 표본을 크게 남긴다
   *   best    **초과분(중앙값)이 가장 큰** 문턱. 좁지만 진하다
   *
   * 처음엔 `lowest` 하나로 돌렸는데 네 단계가 **전부 40점**을 골랐다. 40점 이상은
   * 표본의 대부분이라 사실상 거르는 게 없는 셈이고, 그러면 초과분이 작게 나오는
   * 것이 당연하다 — 규칙이 문턱을 고른 게 아니라 바닥을 짚은 것이다.
   *
   * 둘 다 재서 나란히 놓는다. 어느 쪽이 나은지는 **숫자가 정하게** 한다.
   */
  const pickCut = (
    train: { score: number; s: Sample }[],
    rule: "lowest" | "best",
  ): number | null => {
    const tBase = stat(train.map((r) => r.s));
    let bestCutV: number | null = null;
    let bestMed = 0;
    for (let cut = 40; cut <= 90; cut += 5) {
      const l = lift(stat(train.filter((r) => r.score >= cut).map((r) => r.s)), tBase);
      if (
        l.med === null ||
        l.trim === null ||
        l.win === null ||
        l.med <= 0 ||
        l.trim <= 0 ||
        l.win <= 0 ||
        l.n < 200
      ) {
        continue;
      }
      if (rule === "lowest") return cut;
      if (l.med > bestMed) {
        bestMed = l.med;
        bestCutV = cut;
      }
    }
    return bestCutV;
  };

  const runWalk = (rule: "lowest" | "best"): WalkSummary => {
    const out: FoldRow[] = [];
    const N = 6; // 여섯 구간 — 400거래일이면 한 구간이 약 66일
    const size = Math.ceil(dates.length / N);
    const edge = (i: number) => dates[Math.min(i * size, dates.length - 1)] ?? "";
    /** 학습은 최소 두 구간부터 — 한 구간으로 문턱을 고르면 그게 곧 과적합이다 */
    for (let i = 2; i < N; i++) {
      const trainTo = edge(i);
      const testTo = i + 1 < N ? edge(i + 1) : "";
      const train = scoredRows.filter((r) => r.s.date < trainTo);
      const test = scoredRows.filter(
        (r) => r.s.date >= trainTo && (testTo === "" || r.s.date < testTo),
      );
      if (train.length < 500 || test.length < 200) continue;

      const picked = pickCut(train, rule);
      const testBase = stat(test.map((r) => r.s));
      const hit =
        picked === null
          ? null
          : lift(stat(test.filter((r) => r.score >= picked).map((r) => r.s)), testBase);
      out.push({
        trainTo,
        testFrom: trainTo,
        testTo: testTo || dates[dates.length - 1],
        trainN: train.length,
        cut: picked,
        test: hit,
      });
    }
    const g = out.filter((f) => f.test !== null);
    return {
      rule,
      folds: out,
      graded: g.length,
      won: g.filter((f) => (f.test?.med ?? 0) > 0 && (f.test?.win ?? 0) > 0).length,
      wonMed: g.filter((f) => (f.test?.med ?? 0) > 0).length,
      wonWin: g.filter((f) => (f.test?.win ?? 0) > 0).length,
      skipped: out.filter((f) => f.cut === null).length,
    };
  };

  const walk = runWalk("lowest");
  const walkBest = runWalk("best");

  /*
   * ## **점수 「구간」별** (2026-09-01) — 「이상」으로는 못 답하는 물음이 있다
   *
   * 벤티지: "너무 과한 점수와 약한 점수는 빼는 방향이 낫겠는데? 과한 건 고점신호가
   * 되고 약한 건 아무도 안 보는 거고."
   *
   * 누적(「N점 이상」)으로는 이 물음에 답할 수 없다 — 90점 이상이 좋아 보여도
   * 그건 70~89 가 만든 값일 수 있다. **구간을 잘라야** 위쪽이 정말 고점인지 보인다.
   *
   * 실측(커버리지 0.9 적용 후)이 답한 것:
   *   0~44점   뒤 중 **-0.70** 승 **-1.92**  ← 표본의 57%. 아래쪽은 확실히 쓰레기통
   *   85~89점  뒤 중 **-2.03** 승 **-3.18**  ← 유일한 함정. 다만 n 1,265 로 얇다
   *   90~100점 뒤 중 **+1.71 / +1.34**       ← 가장 좋다. 고점신호가 **아니다**
   *
   * 「꼭대기가 나쁘다」는 렌즈 결손이 만든 착시였다. 상한을 걸면 가장 좋은 구간을
   * 버린다. 그래서 표만 내주고 **판단은 사람에게 넘긴다** — 표본이 쌓여 85~89 가
   * 계속 음수면 그때 `greenTo` 를 걸면 된다.
   */
  const bands: BandRow[] = [];
  const BAND_EDGES = [0, 45, 55, 60, 65, 70, 75, 80, 85, 90, 95, 101];
  for (let i = 0; i < BAND_EDGES.length - 1; i++) {
    const lo = BAND_EDGES[i];
    const hi = BAND_EDGES[i + 1];
    const fRows = half(scoredRows, false);
    const bRows = half(scoredRows, true);
    const inBand = (rows: typeof scoredRows) =>
      rows.filter((r) => r.score >= lo && r.score < hi).map((r) => r.s);
    const fl = lift(stat(inBand(fRows)), stat(fRows.map((r) => r.s)));
    const bl = lift(stat(inBand(bRows)), stat(bRows.map((r) => r.s)));
    bands.push({
      lo,
      hi: hi - 1,
      front: fl,
      back: bl,
      good:
        [fl.med, fl.trim, fl.win, bl.med, bl.trim, bl.win].every((v) => v !== null && v > 0) &&
        fl.n >= 150 &&
        bl.n >= 150,
    });
  }

  return {
    builtAt: file.builtAt,
    days: file.days,
    splits,
    bands,
    walk,
    walkBest,
    bestCut,
    splitAt: midDate,
    thin,
    codeCount: file.codeCount,
    /* **실제로 채점한 수**다 — 덜 재서 뺀 것을 세면 판정이 실제보다 두꺼워 보인다 */
    obs: scoredRows.length,
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
  const reg = regimeMap(S, cfg);
  const isGreen = S.map((s) => scoreFeat(s, cfg, reg.get(s.date))?.level === "green");

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

  /*
   * **겹쳤을 때** (2026-08-31) — 축마다 따로 보면 「각각 얼마나 가르나」까지만 안다.
   * 실제 매매는 세 조건이 동시에 걸린 자리에서 일어나므로, 겹쳤을 때 더 세지는지
   * 아니면 표본만 얇아지는지를 봐야 한다.
   *
   * 3축 × 3구간 = 27칸으로 펴면 칸마다 표본이 수십 건이 되어 아무 말도 못 한다.
   * 그래서 **「좋은 조건을 몇 개 만족하나」**로 0~3점으로 접는다.
   *
   *   폭이 상위 1/3        +1
   *   신고가 밀도가 상위 1/3 +1
   *   금리 민감도가 중립     +1   ← 양 끝이 아니라 **가운데**가 좋았다
   *
   * 마지막 줄이 다른 둘과 방향이 다르다 — 금리는 「높을수록 좋다」가 아니라
   * 「덜 민감할수록 좋다」였다(실측: 중립 +2.60%p vs 양 끝 -0.09/+1.68).
   */
  const goodOf = (getter: (i: number) => number | null, wantTop: boolean) => {
    const vals: number[] = [];
    for (let i = 0; i < S.length; i++) {
      const v = getter(i);
      if (v !== null && Number.isFinite(v)) vals.push(v);
    }
    const [lo, hi] = tertiles(vals);
    return (i: number): boolean | null => {
      const v = getter(i);
      if (v === null || !Number.isFinite(v)) return null;
      return wantTop ? v >= hi : v >= lo && v < hi;
    };
  };
  const gBreadth = goodOf((i) => dayBreadth.get(S[i].date) ?? null, true);
  const gNewHigh = goodOf((i) => dayNewHigh.get(S[i].date) ?? null, true);
  const gRate = goodOf((i) => S[i].rateBeta, false);

  const stackBuckets: number[][] = [[], [], [], []];
  for (let i = 0; i < S.length; i++) {
    const parts = [gBreadth(i), gNewHigh(i), gRate(i)];
    /* 하나라도 못 재면 이 관측은 겹침 표에서 뺀다 — 모르는 것을 「아니오」로 세면 거짓이다 */
    if (parts.some((x) => x === null)) continue;
    stackBuckets[parts.filter(Boolean).length].push(i);
  }

  const axes: CondAxis[] = [
    {
      key: "stack",
      title: "세 조건이 겹치면 — 좋은 조건 몇 개인가",
      hint:
        "폭 상위 1/3 · 신고가 밀도 상위 1/3 · 금리 민감도 중립. 셋 다 「살 때 이미 알 수 있는 값」이라 실제로 쓸 수 있다. 하나라도 못 잰 관측은 뺐다",
      cells: [0, 1, 2, 3].map((k) => cell(`${k}개 만족`, stackBuckets[k])),
    },
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
      "rateBeta",
      "금리 민감도 — 금리에 웃는 종목인가 우는 종목인가",
      "직전 60거래일 회귀계수: 미 10년물이 1%p 오를 때 이 종목이 몇 % 움직였나. 음수면 「금리인하 기대주」(성장·고밸류), 양수면 「금리인상 수혜」(은행·보험). 이름표가 아니라 실제 움직임으로 잰 것이라 look-ahead 가 없다",
      ["금리인하 기대주 쪽", "중립", "금리인상 수혜 쪽"],
      (i) => S[i].rateBeta,
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

/* ------------------------------------------------------------------ */
/* 슈퍼신호등 재구성 (2026-08-31)                                       */
/* ------------------------------------------------------------------ */

/**
 * **두 겹 문이 각각 값을 하나.**
 *
 * "지금까지 우리는 신호등 얘기만 하고 있었던 거구나. 정작 제대로 봐야할 건
 * 슈퍼신호등이었어."
 *
 * 맞는 지적이다. 19만 관측으로 검증한 것은 **신호등**이고, 실제 매매에 쓰는
 * **슈퍼신호등**은 편입분 29건짜리 표에 기대고 있었다. 검증의 무게가 정반대로
 * 실려 있었다.
 *
 * 그리고 슈퍼신호등의 **두 번째 문이 아예 안 재져 있었다:**
 *
 *   ① 일곱 목록 중 3곳 이상 교집합
 *   ② 그중 신호등이 초록인 것        ← 이 문이 값을 하는지 한 번도 안 쟀다
 *
 * 「교집합만」과 「교집합 + 초록」을 견준 적이 없다. 둘이 같다면 ②는 없는 것과
 * 같은데, 모르고 있었다. 여기서 그것을 잰다.
 *
 * ## 어떻게 되짚나 — 조회 0회
 *
 * 표본에 이미 자료가 다 있다. 일곱 중 여섯을 되살린다:
 *
 *   거래대금 상위      volEok 로 그날 순위          정확
 *   등락률 상위        같은 종목 전날 종가로 계산     정확
 *   누적등락률 (5일)    5일 전 종가 대비             정확
 *   외국인 연속순매매    fgnStreak                  정확
 *   기관·외국인 연속매매  두 수급이 같이 순매수인가     근사 (연속 일수가 없다)
 *   동일순매매 (7일)    5일 합이 같은 방향인가        근사 (7일 합이 없다)
 *   장중 기관 매매상위   —                          **불가** (장중 자료)
 *
 * ⚠️ **순위는 표본 500 안에서 매긴다.** 실제 시장 순위가 아니다 — 그날 시장
 * 전체의 거래대금 100위가 이 표본에서는 20위일 수 있다. 그래서 교집합이 실제보다
 * **후하게** 잡힌다. 절대 개수를 믿지 말고 **줄 사이의 차이**로 읽어야 한다.
 */
export interface SuperSimRow {
  label: string;
  n: number;
  d20: number | null;
  win: number | null;
  /** 전체 대비 초과분(%p) */
  lift: number | null;
  trainLift: number | null;
  testLift: number | null;
  testN: number;
}

export interface SuperSimResult {
  obs: number;
  splitDate: string;
  /** 되살린 목록 수 / 전체 */
  listsUsed: number;
  listsTotal: number;
  rows: SuperSimRow[];
  /** 교집합 몇 곳 이상을 문턱으로 봤나 */
  minLists: number;
}

export async function superSim(cfg: SignalConfig, minLists = 3): Promise<SuperSimResult | null> {
  const file = await loadSamples();
  if (!file) return null;
  const S = file.samples;
  if (S.length === 0) return null;

  /* 종목별로 날짜순 인덱스를 만든다 — 전날 종가가 있어야 등락률이 나온다 */
  const byCode = new Map<string, number[]>();
  S.forEach((s, i) => {
    const l = byCode.get(s.code);
    if (l) l.push(i);
    else byCode.set(s.code, [i]);
  });
  /** i번째 표본의 「n일 전 종가」 — 같은 종목 안에서만 찾는다 */
  const prevClose = new Map<number, { d1: number | null; d5: number | null }>();
  for (const idx of byCode.values()) {
    idx.sort((a, b) => S[a].date.localeCompare(S[b].date));
    for (let k = 0; k < idx.length; k++) {
      prevClose.set(idx[k], {
        d1: k >= 1 ? S[idx[k - 1]].cur : null,
        d5: k >= 5 ? S[idx[k - 5]].cur : null,
      });
    }
  }

  /* 그날 안에서의 순위 — 표본 500 기준(실제 시장 순위가 아니다) */
  const byDate = new Map<string, number[]>();
  S.forEach((s, i) => {
    const l = byDate.get(s.date);
    if (l) l.push(i);
    else byDate.set(s.date, [i]);
  });
  /*
   * **표본 자체가 이미 「거래대금 상위 500」이다** (2026-08-31 정정).
   *
   * 벤티지가 설계를 다시 짚어 줬다: 각 목록은 **시장 전체 기준 상위 500**이다.
   * 그런데 이 표본은 이미 거래대금 상위 500으로 뽑은 것이라, **거래대금 목록은
   * 표본 전원이 통과**한다. 처음엔 표본 안에서 다시 상위 60%를 잘랐는데 그건
   * 「상위 500 중 상위 300」이라 실제와 다른 것을 재고 있었다.
   *
   * 실제 원장이 그 증거다 — 성적표의 「거래대금 상위에 걸림」이 전체와 값이
   * 똑같았다(편입분 전부가 거기 걸린다).
   *
   * ⚠️ 나머지 목록은 **표본 안에서** 순위를 매긴다. 시장 전체 순위가 아니다 —
   * 표본이 거래대금 상위라 실제 등락률 상위와 겹침이 크지만 같지는 않다.
   * 그래서 여기 개수를 절대값으로 믿으면 안 되고 **줄 사이의 차이**로 읽어야 한다.
   */
  /*
   * 등락률·누적등락률은 표본 안에서 **상위 60%** 로 자른다. 시장 전체로는
   * 「거래대금 상위 500 중 등락률 상위 300」쯤이라, 실제 「등락률 상위 500」과
   * 완전히 같지는 않지만 그 근처다. 더 좁히면 실제보다 엄격해진다.
   */
  const TOP = 0.6;
  const inTop = new Set<number>(); // 거래대금 — 표본 전원
  const inRate = new Set<number>(); // 등락률
  const inCum = new Set<number>(); // 누적등락률 5일
  for (const idx of byDate.values()) {
    const rank = (get: (i: number) => number | null) => {
      const ok = idx.filter((i) => get(i) !== null);
      ok.sort((a, b) => (get(b) as number) - (get(a) as number));
      return ok.slice(0, Math.max(1, Math.floor(ok.length * TOP)));
    };
    /* 거래대금 — 표본이 이미 그 목록이므로 전원 통과 */
    for (const i of idx) inTop.add(i);
    for (const i of rank((i) => {
      const p = prevClose.get(i)?.d1;
      return p && p > 0 ? ((S[i].cur - p) / p) * 100 : null;
    })) {
      inRate.add(i);
    }
    for (const i of rank((i) => {
      const p = prevClose.get(i)?.d5;
      return p && p > 0 ? ((S[i].cur - p) / p) * 100 : null;
    })) {
      inCum.add(i);
    }
  }

  /** 그날 이 종목이 걸린 목록 수 — 되살린 여섯 개 기준 */
  const listCount = (i: number): number => {
    const s = S[i];
    let n = 0;
    if (inTop.has(i)) n += 1;
    if (inRate.has(i)) n += 1;
    if (inCum.has(i)) n += 1;
    /* 외국인 연속순매매 — 이틀 이상 이어지면 목록에 든 것으로 본다 */
    if ((s.fgnStreak ?? 0) >= 2) n += 1;
    /* 기관·외국인 연속매매 — 둘 다 5일 순매수 (연속 일수를 못 재 근사한다) */
    if ((s.fgn5 ?? 0) > 0 && (s.inst5 ?? 0) > 0) n += 1;
    /* 동일순매매 7일 — 5일 합이 같은 방향 (7일 합이 없어 근사한다) */
    if ((s.fgn5 ?? 0) > 0 && (s.inst5 ?? 0) > 0 && (s.fgn20 ?? 0) > 0) n += 1;
    return n;
  };

  const reg = regimeMap(S, cfg);
  const isGreen = S.map((s) => scoreFeat(s, cfg, reg.get(s.date))?.level === "green");
  const dates = [...byDate.keys()].sort();
  const splitDate = dates[Math.floor(dates.length / 2)];
  const d20 = S.map((s) => s.d20);

  const stat3 = (idx: number[]) => {
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

  const all = S.map((_, i) => i);
  const baseAll = stat3(all).avg;
  const baseTr = stat3(all.filter((i) => S[i].date < splitDate)).avg;
  const baseTe = stat3(all.filter((i) => S[i].date >= splitDate)).avg;
  const sub = (a: number | null, b: number | null) => (a !== null && b !== null ? a - b : null);

  const row = (label: string, idx: number[]): SuperSimRow => {
    const a = stat3(idx);
    const tr = stat3(idx.filter((i) => S[i].date < splitDate));
    const te = stat3(idx.filter((i) => S[i].date >= splitDate));
    return {
      label,
      n: idx.length,
      d20: r2(a.avg),
      win: a.win,
      lift: r2(sub(a.avg, baseAll)),
      trainLift: r2(sub(tr.avg, baseTr)),
      testLift: r2(sub(te.avg, baseTe)),
      testN: te.n,
    };
  };

  /*
   * **지속성(🌈 무지개)** — 며칠째 이어서 교집합에 걸렸나.
   *
   * 지금까지 슈퍼신호등 원장에서 **유일하게 갈린 축**이다(하루만 -1.74% ↔ 이틀
   * 이상 +2.16% ↔ 사흘 이상 +5.19%). 다만 표본이 29건이었다. 여기서 19만 관측으로
   * 다시 묻는다 — 그 차이가 진짜인지, 그리고 문턱이 이틀인지 사흘인지.
   *
   * 같은 종목의 **날짜가 이어져 있어야** 연속이다. 표본에 빠진 날이 있으면
   * (거래정지 등) 거기서 끊는다 — 건너뛰고 세면 「이어졌다」는 거짓이 된다.
   */
  const streakOf = new Map<number, number>();
  for (const idx of byCode.values()) {
    let run = 0;
    let prevDate = "";
    for (const i of idx) {
      const hit = listCount(i) >= minLists;
      /* 표본에서 하루라도 비면 끊는다 — 이어졌다고 지어내지 않는다 */
      const contiguous = prevDate !== "" && dates.indexOf(S[i].date) === dates.indexOf(prevDate) + 1;
      run = hit ? (contiguous ? run + 1 : 1) : 0;
      streakOf.set(i, run);
      prevDate = S[i].date;
    }
  }

  const inter = all.filter((i) => listCount(i) >= minLists);
  const greenOnly = all.filter((i) => isGreen[i]);
  const both = inter.filter((i) => isGreen[i]);
  const interNotGreen = inter.filter((i) => !isGreen[i]);

  return {
    obs: S.length,
    splitDate,
    listsUsed: 6,
    listsTotal: 7,
    minLists,
    rows: [
      row("전체 (기준선)", all),
      row(`교집합 ${minLists}곳 이상만`, inter),
      row("신호등 초록만", greenOnly),
      row(`교집합 + 초록 = 슈퍼신호등`, both),
      row("교집합인데 초록 아님", interNotGreen),
      /*
       * 🌈 지속성 — **초록까지 통과한 것(슈퍼신호등)** 안에서 며칠째인가로 가른다.
       * 교집합만으로 세면 실제 표식과 다른 것을 재게 된다.
       */
      row("🌟 슈퍼 · 첫날", both.filter((i) => (streakOf.get(i) ?? 0) <= 1)),
      row("🌈 슈퍼 · 이틀 연속", both.filter((i) => (streakOf.get(i) ?? 0) === 2)),
      row("🌈 슈퍼 · 사흘 이상", both.filter((i) => (streakOf.get(i) ?? 0) >= 3)),
      row("🌈 슈퍼 · 닷새 이상", both.filter((i) => (streakOf.get(i) ?? 0) >= 5)),
    ],
  };
}

/* ------------------------------------------------------------------ */
/* 판정 요약 — 화면이 「이 점수가 무슨 뜻인가」를 말할 수 있게            */
/* ------------------------------------------------------------------ */

/**
 * 신호등 화면에 붙일 **한 줄짜리 근거**.
 *
 * 벤티지: "신호등 점수가 55점일 때 점수가 가장 좋았다 이런 것도 느낌표로 딱 해서
 * 어떤 신호등을 돌렸을 때 임팩트가 있게."
 *
 * 지금 신호등을 돌리면 **점수만 나오고 그 점수가 무슨 뜻인지는 안 보인다.**
 * 55점이 왜 초록 문턱인지, 이 종목이 어느 구간인지, 그 구간이 실측에서 어땠는지.
 *
 * ⚠️ **하드코딩하지 않는다.** 값을 코드에 적으면 표본이 바뀌어도 그대로 남아
 * 곧 거짓말이 된다 — 오늘 그 일을 한 번 겪었다(+5.63%p 가 +0.19%p 로 무너졌다).
 * 시뮬레이터가 낸 값을 파일에 남기고 화면은 그걸 읽는다.
 */
export interface SignalVerdict {
  /** 언제 잰 것인가 — 낡았는지 화면이 판단할 수 있어야 한다 */
  at: string;
  /** 무슨 표본으로 */
  builtAt: string;
  obs: number;
  codeCount: number;
  days: number;
  /** 그때 설정의 지문 — 기준이 바뀌었으면 이 판정도 낡은 것이다 */
  configHash?: string;
  /** 그때의 초록 문턱 */
  greenAt: number;
  /** 초록의 상한 — 100 이면 상한 없음 */
  greenTo: number;
  /** 그때의 커버리지 문턱 — 「몇 %나 재야 점수를 믿나」 */
  minCoverage: number;
  /** 덜 재서 채점에서 뺀 관측 수 */
  thin: number;
  splitAt: string;
  splits: SplitRow[];
  /** 점수 구간별 — 「위쪽이 고점신호인가」 */
  bands: BandRow[];
  /**
   * **walk-forward** — 앞/뒤 2분할보다 엄한 검증.
   *
   * 2분할의 `bestCut` 은 채점 구간을 이미 본 채로 고른 값이라 과적합이 섞인다.
   * 이건 학습 구간만 보고 고른 문턱을 아직 안 본 구간에서 채점한다.
   */
  walk: WalkSummary;
  walkBest: WalkSummary;
  bestCut: number | null;
  /** 채점에서 빠진 기준 — 이게 있으면 판정이 반쪽이다 */
  skipped: string[];
}

const here2 = dirname(fileURLToPath(import.meta.url));
const VERDICT_FILE = join(here2, "..", "data", "signalVerdict.json");

let verdictCache: SignalVerdict | null = null;

export async function loadVerdict(): Promise<SignalVerdict | null> {
  if (verdictCache) return verdictCache;
  try {
    verdictCache = JSON.parse(await readFile(VERDICT_FILE, "utf-8")) as SignalVerdict;
  } catch {
    verdictCache = null;
  }
  return verdictCache;
}

/**
 * 지금 설정으로 다시 재서 판정을 남긴다.
 *
 * 표본 재수집이 끝난 뒤와 설정을 저장한 뒤에 부르면 된다 — 파일만 읽고 채점하므로
 * **조회가 0회**이고 수십 밀리초다.
 */
export async function buildVerdict(cfg: SignalConfig): Promise<SignalVerdict | null> {
  const r = await simulate(cfg);
  if (!r) return null;
  const v: SignalVerdict = {
    at: new Date().toISOString(),
    builtAt: r.builtAt,
    obs: r.obs,
    codeCount: r.codeCount,
    days: r.days,
    configHash: await configFingerprint(),
    greenAt: cfg.greenAt,
    greenTo: cfg.greenTo,
    minCoverage: cfg.minCoverage,
    thin: r.thin,
    splitAt: r.splitAt,
    splits: r.splits,
    bands: r.bands,
    walk: r.walk,
    walkBest: r.walkBest,
    bestCut: r.bestCut,
    skipped: r.skipped,
  };
  verdictCache = v;
  await mkdir(dirname(VERDICT_FILE), { recursive: true });
  await writeFile(VERDICT_FILE, JSON.stringify(v, null, 1), "utf-8");
  return v;
}
