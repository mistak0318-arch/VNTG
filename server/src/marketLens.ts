import { peekSnapshot } from "./marketSnapshot.js";
import { loadCloses } from "./dailyCloses.js";
import { themeStrength } from "./themeStrength.js";

/**
 * 시장 렌즈 — **체온계와 로테이션.** (2026-08-28, 테마 DB·일봉 캐시 개편의 마무리)
 *
 * 테마 DB 를 들이고 나니 재료는 다 있는데 **읽는 자리가 없었다.** 266개 테마 표를
 * 훑는 건 데이터를 보는 것이지 흐름을 읽는 게 아니다. 흐름은 두 물음으로 줄어든다:
 *
 *   ① **시장의 체온** — 지수 말고, 종목들이 실제로 어떤가.
 *      지수는 대형주 몇이 끌면 올라 보인다. 2,300종목 중 몇 %가 20일선 위인가,
 *      60일 신고가는 몇 종목인가 — 이게 장의 진짜 체온이다.
 *   ② **돈의 자리바꿈** — 오늘 강한 테마가 「이어달리는 중」인가 「새로 부상」인가.
 *      같은 +3% 라도 한 달을 이어 온 테마와 오늘 처음 튄 테마는 다음 날이 다르다.
 *
 * ## 왜 일봉 캐시인가
 *
 * 기존 「시장 폭」(breadth.ts)은 하루 한 줄씩 쌓는 방식이라 **소급이 안 됐다** —
 * 서버를 새로 켜면 그래프가 빈다. 일봉 캐시는 2,300여 종목 × 70일을 이미 들고
 * 있으므로 **과거 40일치 체온을 오늘 바로** 계산할 수 있다. 조회 0회다.
 *
 * ## 무엇을 일부러 뺐나
 *
 * 소외 테마 목록(오늘도 월간도 하락)은 안 준다 — 흐름을 읽는 데 필요한 건
 * 「어디로 들어오나」와 「어디서 빠지나」지, 아무 일도 없는 곳의 명단이 아니다.
 */

/* ------------------------------------------------------------------ */
/* 체온계                                                              */
/* ------------------------------------------------------------------ */

export interface ThermoSeries {
  /** 하루하루 상승 종목 비율(%) — 옛날 → 최신(어제 마감) */
  rise: number[];
  /** 20일선 위 종목 비율(%) */
  above20: number[];
  /** 60일 신고가 종목 수 (캐시가 70일이라 최근 ~10일만 나온다) */
  high60: number[];
  /** 60일 신저가 종목 수 */
  low60: number[];
}

export interface Thermo {
  /** 계산에 쓴 종목 수. 0 이면 일봉 캐시가 아직 없다 */
  stocks: number;
  builtAt: string;
  series: ThermoSeries;
  /** 장중이면 스냅샷 기준 지금 상승 비율(%) — 캐시(어제 마감)와 우주가 달라 따로 준다 */
  riseNow: number | null;
}

/** 체온 시계열을 며칠치 그릴까 — 그 이상은 화면에서 안 읽힌다 */
const THERMO_DAYS = 40;

export async function marketThermo(): Promise<Thermo> {
  const store = await loadCloses();
  const lists = Object.values(store.closes).filter((a) => a.length >= 21);

  const rise: number[] = [];
  const above20: number[] = [];
  const high60: number[] = [];
  const low60: number[] = [];

  /*
   * d = 「끝에서 며칠 전인가」(0 = 캐시의 마지막 날). 종목마다 길이가 달라서
   * 날짜가 아니라 **끝맞춤**으로 정렬한다 — 캐시는 같은 날 한 바퀴에 받으므로
   * 끝이 곧 같은 날이다. 짧은 종목은 그 날 계산에서 빠질 뿐이다.
   */
  for (let d = THERMO_DAYS - 1; d >= 0; d--) {
    let up = 0;
    let upOf = 0;
    let above = 0;
    let aboveOf = 0;
    let hi = 0;
    let lo = 0;
    let hiOf = 0;
    for (const c of lists) {
      const i = c.length - 1 - d;
      if (i >= 1) {
        upOf += 1;
        if (c[i] > c[i - 1]) up += 1;
      }
      if (i >= 19) {
        let sum = 0;
        for (let k = i - 19; k <= i; k++) sum += c[k];
        aboveOf += 1;
        if (c[i] > sum / 20) above += 1;
      }
      if (i >= 59) {
        hiOf += 1;
        let mx = -Infinity;
        let mn = Infinity;
        for (let k = i - 59; k <= i; k++) {
          if (c[k] > mx) mx = c[k];
          if (c[k] < mn) mn = c[k];
        }
        if (c[i] >= mx) hi += 1;
        if (c[i] <= mn) lo += 1;
      }
    }
    if (upOf > 0) rise.push(Math.round((up / upOf) * 1000) / 10);
    if (aboveOf > 0) above20.push(Math.round((above / aboveOf) * 1000) / 10);
    if (hiOf > lists.length * 0.5) {
      high60.push(hi);
      low60.push(lo);
    }
  }

  /* 장중 실황 — 스냅샷은 전종목이라 캐시(테마 종목)와 우주가 다르다. 섞지 말고 따로 */
  const snap = peekSnapshot();
  const riseNow =
    snap && snap.traded && snap.byCode.size > 0
      ? Math.round(
          ([...snap.byCode.values()].filter((s) => s.changeRate > 0).length / snap.byCode.size) *
            1000,
        ) / 10
      : null;

  return {
    stocks: lists.length,
    builtAt: store.builtAt,
    series: { rise, above20, high60, low60 },
    riseNow,
  };
}

/* ------------------------------------------------------------------ */
/* 테마 로테이션                                                        */
/* ------------------------------------------------------------------ */

/** 로테이션 판의 테마 한 줄 — 구성종목은 안 담는다(시트가 키로 다시 꺼낸다) */
export interface RotationTheme {
  key: string;
  name: string;
  changeRate: number;
  w1: number | null;
  m1: number | null;
  m60: number | null;
  streak: number;
  hit10: { n: number; of: number };
  breadth: number;
  tradeValue: number;
}

export interface Rotation {
  /** 주도 지속 — 한 달을 끌어 왔고 오늘도 오른다 */
  lead: RotationTheme[];
  /** 신규 부상 — 한 달은 조용했는데 오늘 크게 튄다. 자리바꿈의 입구 */
  fresh: RotationTheme[];
  /** 주도 휴식 — 한 달을 끌었는데 오늘 쉰다. 눌림인지 이탈인지 지켜볼 곳 */
  rest: RotationTheme[];
  /** 분류에 들어간 테마 수 (거래대금 문턱 통과분) */
  universe: number;
  /** 월간 누적이 아직 없으면(일봉 캐시 전) 분류가 불가능하다 */
  ready: boolean;
  at: string;
}

/**
 * 문턱의 근거:
 * - 거래대금 300억 — 266개 중 돈이 실제로 도는 테마만. 이 아래는 움직여도 못 탄다.
 * - 주도 m1 ≥ +3% — 한 달에 3%면 지수 위를 걷는 수준. 이걸 「끌어 왔다」로 본다.
 * - 신규 오늘 ≥ +1.5% — 평균이 1.5% 오르려면 무리 전체가 움직여야 한다.
 * - 휴식 오늘 ≤ −0.3% — 보합 흔들림을 「쉰다」로 읽지 않기 위한 완충.
 */
export async function themeRotation(minValue = 300): Promise<Rotation> {
  const { themes, at } = await themeStrength("kr");
  const pool = themes.filter((t) => t.tradeValue >= minValue);
  const ready = pool.some((t) => t.m1 !== null);

  const slim = (t: (typeof pool)[number]): RotationTheme => ({
    key: t.key,
    name: t.name,
    changeRate: t.changeRate,
    w1: t.w1,
    m1: t.m1,
    m60: t.m60,
    streak: t.streak,
    hit10: t.hit10,
    breadth: t.breadth,
    tradeValue: t.tradeValue,
  });

  const lead = pool
    .filter((t) => t.changeRate > 0 && (t.m1 ?? -99) >= 3)
    .sort((a, b) => (b.m1 ?? 0) + b.changeRate - ((a.m1 ?? 0) + a.changeRate))
    .slice(0, 8)
    .map(slim);
  const fresh = pool
    .filter((t) => t.changeRate >= 1.5 && t.m1 !== null && t.m1 < 3)
    .sort((a, b) => b.changeRate - a.changeRate)
    .slice(0, 8)
    .map(slim);
  const rest = pool
    .filter((t) => t.changeRate <= -0.3 && (t.m1 ?? -99) >= 5)
    .sort((a, b) => (b.m1 ?? 0) - (a.m1 ?? 0))
    .slice(0, 8)
    .map(slim);

  return { lead, fresh, rest, universe: pool.length, ready, at };
}

/* ------------------------------------------------------------------ */
/* 미국 테마 밤사이 — 장전 카드용 (구성종목 없이 가볍게)                    */
/* ------------------------------------------------------------------ */

export interface UsOvernight {
  top: { key: string; name: string; changeRate: number; streak: number }[];
  bottom: { key: string; name: string; changeRate: number; streak: number }[];
}

export async function usOvernight(): Promise<UsOvernight> {
  const { themes } = await themeStrength("us");
  /* 시총(원화 환산) 문턱 — 마이크로캡 테마가 ±10% 로 맨 위를 덮는 걸 막는다 */
  const pool = themes.filter((t) => t.tradeValue >= 10_000);
  const slim = (t: (typeof pool)[number]) => ({
    key: t.key,
    name: t.name,
    changeRate: t.changeRate,
    streak: t.streak,
  });
  return {
    top: [...pool].sort((a, b) => b.changeRate - a.changeRate).slice(0, 5).map(slim),
    bottom: [...pool].sort((a, b) => a.changeRate - b.changeRate).slice(0, 5).map(slim),
  };
}
