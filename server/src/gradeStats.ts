/**
 * 채점표 한 줄의 **속** — 평균 뒤에 무엇이 있었나 (2026-09-04).
 *
 * 벤티지: "각각의 케이스에 대해 결과별로 알 수 있게 해준 다음에, 조금 더 추가하면
 * 분석에 도움이 되는 지표들도 한번 추가해 볼 수 있겠어."
 *
 * ## 왜 평균만으로는 모자란가
 *
 * 지금 채점표는 구간마다 **평균과 승률** 둘을 준다. 그런데 「20일 지수 대비 +1.8%p,
 * 승률 54%」라는 줄에서 다음 물음에 답할 수 없다:
 *
 *   · 그 +1.8 이 **고르게 번 것**인가, **한둘이 끌어올린 것**인가
 *   · 승률 54% 는 시장이 오른 덕인가, **시장을 이긴** 것인가
 *   · 이길 때 크게 이기고 질 때 작게 지는가 — 추세추종이면 그게 정상이다
 *   · 최악의 한 건은 얼마였나 — 「한 번에 얼마나 다치나」
 *
 * 넷 다 **원자료에 이미 있는데 표가 안 물어봤을 뿐**이다.
 *
 * ## 왜 한 파일인가
 *
 * 이 셈은 신호등 분석(`listTrack`)과 슈퍼신호등(`superSignal`) **두 표가 같이 쓴다.**
 * 두 원장을 나란히 놓고 견주는 것이 이 화면들의 목적이라, 자가 다르면 비교가 거짓이 된다.
 * 이 코드베이스에서 세 번 데인 자리다 — 같은 값이 두 길로 들어오면 언젠가 한쪽이 틀린다.
 * 그래서 **계산은 여기 하나뿐**이고, 두 곳은 값만 넘긴다.
 */

/** 분포 다섯 통 — 지수 대비 몇 %p 였나 */
export interface GradeDist {
  /** −10%p 아래 — 크게 졌다 */
  bad: number;
  /** −10 ~ −3%p */
  down: number;
  /** −3 ~ +3%p — 시장과 사실상 같았다 */
  flat: number;
  /** +3 ~ +10%p */
  up: number;
  /** +10%p 위 — 크게 이겼다 */
  good: number;
}

export interface GradeDetail {
  /**
   * **몇 일 뒤로 잰 것인가** (2026-09-04).
   *
   * 20일이 원칙이다 — 길수록 하루치 소음이 씻긴다. 그런데 원장이 어리면 20일이 지난
   * 편입분이 하나도 없어서 **속이 통째로 빈다.** 그 상태로 두면 이 기능은 몇 주 동안
   * 아무 말도 못 한다. 그래서 **자료가 있는 가장 긴 지평**으로 재고, 몇 일짜리인지를
   * 같이 돌려준다 — 화면이 그걸 적어야 사람이 20일 성적으로 착각하지 않는다.
   */
  horizon: 1 | 5 | 20 | null;
  /** 이 속을 낸 표본 수 — 표의 `n`(편입 수)과 다르다. 아직 안 지난 것은 빠진다 */
  n: number;
  /**
   * **결과별 몇 건인가.** 평균 한 숫자가 못 하는 말을 이게 한다 —
   * 「+1.8%p 평균」이 `flat` 이 대부분이고 `good` 두 건인 모양이면 그건 고른 성적이 아니다.
   */
  dist: GradeDist;
  /**
   * **중앙값**(%p). 평균과 크게 벌어지면 **소수가 끌고 있다**는 뜻이다 —
   * 평균 +1.8 인데 중앙값 −0.4 면 절반 넘는 종목이 시장에 졌다는 말이고,
   * 그 구간을 「좋다」고 읽으면 안 된다.
   */
  median: number | null;
  /**
   * **손익비** — 이긴 것 평균 ÷ 진 것 평균(절대값).
   *
   * 추세추종은 **자주 지고 크게 이기는** 전략이라 승률이 낮은 게 정상이다. 그걸 모르면
   * 승률 40% 를 보고 잘못된 결론을 내린다. 손익비 2 를 넘으면 승률 40% 로도 번다 —
   * 승률과 **짝으로만** 뜻이 서는 값이라 둘을 나란히 둔다.
   */
  payoff: number | null;
  /** **시장을 이긴 비율**(%). 절대 승률과 다르다 — 상승장에서는 아무거나 사도 오른다 */
  exWin: number | null;
  /** 꼬리 — 가장 크게 이긴 한 건과 가장 크게 진 한 건(%p) */
  best: number | null;
  worst: number | null;
  /** 통의 경계(%p) — 지평마다 다르므로 화면이 박아 쓰면 안 된다 */
  bins: { near: number; far: number };
}

const EMPTY: GradeDetail = {
  horizon: null,
  n: 0,
  dist: { bad: 0, down: 0, flat: 0, up: 0, good: 0 },
  median: null,
  payoff: null,
  exWin: null,
  best: null,
  worst: null,
  bins: { near: 3, far: 10 },
};

const r2 = (n: number) => Math.round(n * 100) / 100;

/** 셋 중 **자료가 있는 가장 긴 지평**을 고른다 — 20 → 5 → 1 */
export function pickHorizon(
  ex1: (number | null | undefined)[],
  ex5: (number | null | undefined)[],
  ex20: (number | null | undefined)[],
): { horizon: 1 | 5 | 20 | null; values: number[] } {
  const clean = (a: (number | null | undefined)[]) =>
    a.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const c20 = clean(ex20);
  if (c20.length > 0) return { horizon: 20, values: c20 };
  const c5 = clean(ex5);
  if (c5.length > 0) return { horizon: 5, values: c5 };
  const c1 = clean(ex1);
  if (c1.length > 0) return { horizon: 1, values: c1 };
  return { horizon: null, values: [] };
}

/**
 * 한 구간의 속을 낸다.
 *
 * @param values 그 구간 종목들의 **지수 대비** 성적(%p)
 * @param horizon 몇 일 뒤로 잰 것인가 — 화면이 적어야 20일로 착각하지 않는다
 *
 * ⚠️ **지수 대비로만 잰다.** 절대 수익으로 분포를 그리면 상승장에서는 전부 오른쪽으로
 * 쏠려 구간끼리 안 갈린다. 이 표의 물음은 「이 구간이 남들보다 나았나」다.
 */
export function gradeDetail(
  values: (number | null | undefined)[],
  horizon: 1 | 5 | 20 | null = 20,
): GradeDetail {
  const vs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (vs.length === 0) return { ...EMPTY, dist: { ...EMPTY.dist } };

  /*
   * 통의 폭은 **지평에 맞춘다.** 20일 기준(±3 / ±10)을 하루짜리에 그대로 쓰면 거의
   * 전부 `flat` 으로 떨어져 분포가 아무 말도 못 한다 — 하루에 시장을 3%p 이기는 일은
   * 드물다. 뿌리를 쓴다: 5일은 20일의 절반, 1일은 그 절반쯤이 자연스러운 폭이다.
   */
  const k = horizon === 1 ? 0.25 : horizon === 5 ? 0.5 : 1;
  const near = 3 * k;
  const far = 10 * k;
  const dist: GradeDist = { bad: 0, down: 0, flat: 0, up: 0, good: 0 };
  for (const v of vs) {
    if (v <= -far) dist.bad += 1;
    else if (v < -near) dist.down += 1;
    else if (v <= near) dist.flat += 1;
    else if (v <= far) dist.up += 1;
    else dist.good += 1;
  }

  const sorted = [...vs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  const wins = vs.filter((v) => v > 0);
  const losses = vs.filter((v) => v < 0);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
  /*
   * 진 것이 하나도 없으면 손익비는 **못 낸다.** 0 으로 나눈 무한대를 「엄청 좋다」로
   * 적으면 표본 셋짜리 구간이 표를 지배한다 — 모르는 것은 모른다고 둔다.
   */
  const payoff =
    wins.length > 0 && losses.length > 0 ? r2(avg(wins) / Math.abs(avg(losses))) : null;

  return {
    horizon,
    n: vs.length,
    dist,
    median: r2(median),
    payoff,
    exWin: Math.round((wins.length / vs.length) * 100),
    best: r2(sorted[sorted.length - 1]),
    worst: r2(sorted[0]),
    bins: { near: r2(near), far: r2(far) },
  };
}
