import { loadCloses } from "./dailyCloses.js";

/**
 * 지금이 강세장인가 약세장인가 — **기준을 갈아 끼우는 스위치.**
 *
 * ## 왜 필요한가
 *
 * 19만 관측을 장세로 갈라 재 보니, **같은 기준이 장세에 따라 부호가 뒤집혔다**
 * (중앙값·절사평균·승률 셋을 다 본 값이다):
 *
 * | 기준 | 강세장 | 약세장 |
 * |---|---|---|
 * | 60일 신고가 | 승률 **+1.4%p** | 승률 **-3.9%p** |
 * | ETF 뒷배 | **+2.1** | **-2.2** |
 * | 시총 3조 이상 | **+2.4** | -0.4 |
 * | 시총대비 수급 | -0.6 | **+1.1** |
 * | 영업이익 증가 | -0.7 | **+2.1** |
 *
 * 신고가는 **강세장 전용**이고 영업이익은 **약세장 전용**이다. 장세를 안 가리고
 * 한꺼번에 켜 두면 절반의 시간 동안 점수를 깎는다 — 무게 3짜리 신고가가 약세장에서
 * 승률을 3.9%p 씩 깎고 있었다.
 *
 * 장세를 **가리지 않고 통하는 것도 있다** — 시총 소형(양쪽 승률 +7.6·+8.1%p)과
 * 수급 지속이 그렇다. 그 둘이 이 도구의 뼈대다.
 *
 * ## 어떻게 재나 — 조회 0회
 *
 * **전종목의 20일선 위 비율.** 표본을 가를 때 쓴 것과 **똑같은 정의**라야
 * 검증과 실전이 어긋나지 않는다.
 *
 * 일봉 캐시(`dailyCloses`, 400일)가 2,400여 종목의 종가를 들고 있으므로
 * 이동평균을 그 자리에서 낼 수 있다 — **키움을 한 번도 안 부른다.**
 *
 * ⚠️ 캐시는 하루 한 번(장 마감 뒤) 갱신된다. 즉 장중에는 **어제 종가 기준**이다.
 * 장세는 하루 만에 뒤집히는 값이 아니므로 그걸로 충분하고, 오히려 장중에 계속
 * 흔들리는 편이 더 나쁘다 — 같은 종목이 오전과 오후에 다른 점수를 받는다.
 */

/**
 * 강세·약세를 가르는 선(%) — **기본값일 뿐, 설정이 이긴다.**
 *
 * 표본 380거래일의 중앙값이 정확히 50 이었다. 근거가 있는 값이지만 「나는 60% 는
 * 돼야 강세장으로 본다」가 얼마든지 가능한 판단이라, `SignalConfig.bullAt` 으로
 * 사람이 바꿀 수 있게 열어 두었다.
 */
const DEFAULT_BULL_AT = 50;

export type Regime = "bull" | "bear";

export interface MarketRegime {
  /** 20일선 위에 있는 종목 비율(%) */
  breadth: number;
  regime: Regime;
  /** 몇 종목으로 쟀나 — 캐시가 얇으면 믿을 값이 아니다 */
  measured: number;
  /** 무슨 선으로 갈랐나(%) — 화면이 근거를 말할 수 있게 */
  bullAt: number;
  /** 캐시를 언제 받았나 */
  builtAt: string;
  at: string;
}

/** 20일 이동평균 — 종가가 모자라면 null */
function ma20(closes: number[]): number | null {
  if (closes.length < 20) return null;
  const win = closes.slice(-20);
  return win.reduce((a, b) => a + b, 0) / 20;
}

let cache: { data: MarketRegime; at: number; bullAt: number } | null = null;
/** 캐시가 하루 한 번 갱신되므로 10분이면 충분하다 */
const TTL_MS = 10 * 60_000;

/**
 * 지금 장세.
 *
 * 캐시가 너무 얇으면(200종목 미만) **판정하지 않고 null** 을 돌려준다 —
 * 모르는 것을 「강세」로 찍으면 그 순간 기준 절반이 잘못 켜진다.
 */
export async function marketRegime(bullAt = DEFAULT_BULL_AT): Promise<MarketRegime | null> {
  /* 문턱이 바뀌면 캐시를 다시 쓸 수 없다 — 같은 폭이라도 다른 답이 나온다 */
  if (cache && cache.bullAt === bullAt && Date.now() - cache.at < TTL_MS) return cache.data;

  const { closes, builtAt } = await loadCloses();
  let above = 0;
  let measured = 0;
  for (const arr of Object.values(closes)) {
    const m = ma20(arr);
    if (m === null || m <= 0) continue;
    measured += 1;
    if (arr[arr.length - 1] >= m) above += 1;
  }
  if (measured < 200) return null;

  const breadth = (above / measured) * 100;
  const data: MarketRegime = {
    breadth: Math.round(breadth * 10) / 10,
    regime: breadth >= bullAt ? "bull" : "bear",
    measured,
    bullAt,
    builtAt,
    at: new Date().toISOString(),
  };
  cache = { data, at: Date.now(), bullAt };
  return data;
}

/** 화면·설명용 이름 */
export const REGIME_LABEL: Record<Regime, string> = {
  bull: "강세장",
  bear: "약세장",
};
