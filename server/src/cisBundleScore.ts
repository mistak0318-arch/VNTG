import type { Sample } from "./signalSamples.js";

/**
 * **항해일지 꾸러미** (2026-11-17) — 무엇을 보고 살 것인가.
 *
 * 벤티지: "신호등이 신뢰할만한 값이 아닌거 같아. 니가 생각하는 신뢰할만한 데이터 꾸러미
 * 조합을 해서 다시 항해일지의 투자 로직을 재편성 해서 구성해볼래?"
 *
 * ## 무엇이 문제였나 — 실측 (표본 41,131관측 · 130거래일 · 2026-04-07~10-19)
 *
 * 성적은 **시총 중립 20일 초과수익**이다. 날짜마다 같은 시총 5분위의 중앙값을 뺀다 —
 * 안 빼면 크기만 재게 된다(2026-09-02 에 확인한 그것).
 *
 *   신호등 초록           **+0.6 / 승률 52%**   ← 가르는 힘이 없다
 *   신호등 상위 5/일       **+0.6 / 승률 53%**   블록 +0.1 +8.2 +1.0 **-0.6**
 *
 * 성적이 네 블록 중 하나에서만 나왔고 마지막 블록은 마이너스다. 그리고 CIS 의
 * `minScore: 55` 는 **죽은 조건**이었다 — 초록은 전부 55 이상이라 한 종목도 못 거른다.
 *
 * ## 진짜 원인은 「추세」를 끝까지 오른 것으로 읽은 것이었다
 *
 *   20일 상승폭 **상위** 5/일    **-3.5 / 41%**   블록 **0/4** (네 블록 모두 졌다)
 *   섹터 내 상대 **-3~+10%**     **+1.9 / 57%**   블록 **4/4** (네 블록 모두 이겼다)
 *
 * 항해일지는 주도주 스캔(=오늘 제일 뜨거운 것)으로 풀을 만들고 거기에 신호등을 얹었다.
 * **0/4 짜리 재료 위에 0점짜리 재료를 얹고 있었다.**
 *
 * ⚠️ **신조는 그대로다** — ①체 ②추세 ③진입 뒤 추종([[cis-creed-filter-then-trend]]).
 * 바꾼 것은 「추세」의 **정의**뿐이다. 끝까지 오른 것이 아니라 **적당히 오르고 있는 것**이
 * 추세였다는 걸 잰 적이 없었을 뿐이다.
 *
 * ## 꾸러미 (상위 5/일 기준)
 *
 *   체                 거래대금 50억↑ · 시총 1,000억↑ · 안쏠림 · 흑자 · 신호등 빨강 제외
 *   순위 네 재료        섹터상대 적당(-3~+10) · 20일 추세 적당(0~15%) · 저변동 · 20일선 이격 좁음
 *
 *   결과  **+3.2 / 승률 61% / 손절 12% / 블록 4/4** (고유 170종목 · 하루 5개)
 *   지금  +0.6 / 승률 53% / 손절 12% / 블록 3/4 (고유 216종목)
 *
 * ## ⚠️ 이 숫자의 한계 — 반드시 같이 읽을 것
 *
 * **표본 130일이 전부 약세장이다.** 벤티지 확인: "실제로 약세장이 맞았어. 시장이 계속
 * 빠졌었거든". 강세장 표본은 **0일**이라 반대쪽을 잴 길이 없었다.
 *
 * 그래서 **저변동은 약세장에 유리한 쪽으로 치우쳐 있을 수 있다** — 약세장에서 저변동이
 * 이기는 건 교과서에 있는 이야기다. 네 블록을 다 넘긴 것만 골랐고 고유 종목 수도 같이
 * 봤지만(단일 재료 1등이던 분기 이익률은 고유가 **34개**뿐이라 버렸다) 그것으로 한
 * 계절짜리 위험이 없어지진 않는다.
 *
 * 그래서 벤티지가 고른 길이 **「먼저 나란히 재 본다」**다 — 실계좌에 물리지 않고 매일
 * 둘 다 고르게 해서 원장에 남긴다(`cisShadow.ts`).
 */

/** 꾸러미가 고른 한 종목 */
export interface BundlePick {
  code: string;
  name: string;
  /** 0~100 — 네 재료의 평균 */
  score: number;
  /** 재료별 점수 — 왜 골랐는지 화면이 그대로 보여 준다 */
  parts: { k: string; v: number }[];
  /** 그날 종가 */
  price: number;
  /** 거래대금(억) */
  volEok: number;
  /** 시가총액(억) */
  mktCap: number | null;
}

/* ------------------------------------------------------------------ */
/* 체 — 신조 ①. 살 수 있고 살아남을 것만 남긴다                            */
/* ------------------------------------------------------------------ */

/** 거래대금 50억↑ · 시총 1,000억↑ — 못 사는 종목은 후보가 아니다 */
export function liquid(s: Sample): boolean {
  return (s.volEok ?? 0) >= 50 && (s.mktCap ?? 0) >= 1000;
}

/**
 * 쏠림·과열을 뺀다 — 실전 🔥 와 같은 뜻.
 *
 * 거래량이 평소의 2.5배를 넘거나(`vGrow` 150%↑) 20일선 위로 25% 넘게 떠 있으면 뺀다.
 * 2026-09-02 실측에서 거래량 2.5배↑ 는 시장에 **졌다**(-0.3~-1.1).
 */
export function notBlownOut(s: Sample): boolean {
  return !((s.vGrow ?? 0) >= 150 || (s.gap20 ?? 0) >= 25);
}

/** 적자는 뺀다 — 실전 신호등의 `qMargin` 탈락과 같은 자리. 모르면 통과시킨다 */
export function profitable(s: Sample): boolean {
  return s.qMargin === null || s.qMargin > 0;
}

/** 체 셋을 다 지났나 (신호등 빨강 거르기는 부르는 쪽에서 — 표본에는 등급이 없다) */
export function passesSieve(s: Sample): boolean {
  return liquid(s) && notBlownOut(s) && profitable(s);
}

/* ------------------------------------------------------------------ */
/* 순위 — 신조 ②. 체를 지난 것 안에서만                                   */
/* ------------------------------------------------------------------ */

/**
 * **가운데가 제일 높은 점수** — 「적당히」를 재는 자.
 *
 * 백분위로 줄을 세우면 늘 **끝에 있는 것**이 1등이 된다. 그런데 실측에서 끝까지 오른
 * 것은 네 블록 모두 졌다. 그래서 띠(band) 를 쓴다 — 범위를 벗어나면 0, 가운데면 100.
 */
export function band(v: number | null, lo: number, hi: number): number | null {
  if (v === null || !Number.isFinite(v)) return null;
  if (v < lo || v > hi) return 0;
  const mid = (lo + hi) / 2;
  return 100 * (1 - Math.abs(v - mid) / ((hi - lo) / 2));
}

/** 20일선에서 멀수록 깎는다 — 멀리 뜬 것은 되돌림이 크다 */
export function tightGap(gap20: number | null): number | null {
  return gap20 === null || !Number.isFinite(gap20) ? null : Math.max(0, 100 - Math.abs(gap20) * 4);
}

/**
 * **그날 안에서의 백분위** — 재료마다 단위가 달라 그냥 더하면 큰 단위가 이긴다.
 *
 * `dir: -1` 이면 작을수록 높은 점수(변동성이 그렇다).
 */
export function pctRanks(rows: Sample[], key: keyof Sample, dir: 1 | -1): Map<Sample, number> {
  const out = new Map<Sample, number>();
  const v = rows.filter((r) => {
    const x = r[key];
    return x !== null && x !== undefined && Number.isFinite(x as number);
  });
  v.sort((a, b) => dir * ((a[key] as number) - (b[key] as number)));
  v.forEach((r, i) => out.set(r, v.length > 1 ? (100 * i) / (v.length - 1) : 50));
  return out;
}

/**
 * **그날의 꾸러미 순위** — 체를 지난 것들을 받아 점수를 매긴다.
 *
 * 네 재료의 **평균**이다(못 잰 칸은 분모에서 빠진다). 무게를 안 주는 까닭은, 무게를
 * 주려면 그걸 정할 표본이 또 필요한데 지금 표본이 한 계절뿐이기 때문이다 —
 * 한 계절에 맞춘 무게는 다음 계절에 틀린다. 같은 무게가 가장 정직하다.
 */
export function rankBundle(pool: Sample[]): BundlePick[] {
  const rVol = pctRanks(pool, "volat20", -1);
  const out: BundlePick[] = [];
  for (const s of pool) {
    const parts: { k: string; v: number }[] = [];
    const push = (k: string, v: number | null) => {
      if (v !== null && Number.isFinite(v)) parts.push({ k, v });
    };
    push("섹터상대 적당", band(s.secRel ?? null, -3, 10));
    push("20일추세 적당", band(s.rise20 ?? null, 0, 15));
    push("저변동", rVol.get(s) ?? null);
    push("20일선 이격", tightGap(s.gap20 ?? null));
    if (parts.length === 0) continue;
    const score = parts.reduce((a, b) => a + b.v, 0) / parts.length;
    out.push({
      code: s.code,
      name: s.name,
      score: Math.round(score * 10) / 10,
      parts: parts.map((p) => ({ k: p.k, v: Math.round(p.v * 10) / 10 })),
      price: s.cur ?? 0,
      volEok: Math.round(s.volEok ?? 0),
      mktCap: s.mktCap === null ? null : Math.round(s.mktCap),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}
