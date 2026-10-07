import { useCallback, useEffect, useState } from "react";
import { removePref, setPref } from "./prefs";

/**
 * 차트 설정.
 *
 * 이동평균을 무엇무엇 그릴지, 볼린저 밴드를 쓸지, 매물대를 띄울지, 봉을 눌렀을 때
 * 무엇을 보여줄지. 전부 **보는 사람마다 다르다** — 13일선을 쓰는 사람이 있고
 * 볼린저를 안 보는 사람이 있다. 코드에 박아 두면 그때마다 나를 불러야 한다.
 *
 * 외관 설정과 같은 자리에 둔다(localStorage, 기기별). 기기마다 화면 크기가 달라
 * 폰에서는 선을 줄이고 PC 에서는 늘리고 싶을 수 있기 때문이다.
 *
 * 값이 바뀌면 같은 탭의 다른 차트도 같이 갈아엎어야 하므로 창 이벤트로 알린다 —
 * 컨텍스트를 새로 파면 차트를 쓰는 모든 화면을 손봐야 한다.
 */

export interface MaLine {
  period: number;
  color: string;
  on: boolean;
}

/** 봉을 눌렀을 때 말풍선에 넣을 것 */
export type TipField = "ohlc" | "change" | "volume" | "ma" | "gap";

export const TIP_FIELDS: { key: TipField; label: string; hint: string }[] = [
  { key: "ohlc", label: "시·고·저·종", hint: "그날의 네 값" },
  { key: "change", label: "등락률", hint: "전일 종가 대비" },
  { key: "volume", label: "거래량", hint: "그날 거래량" },
  { key: "ma", label: "이동평균값", hint: "켜 둔 이평선의 그날 값" },
  { key: "gap", label: "이격도", hint: "종가가 이평선에서 몇 % 떨어져 있나" },
];

export interface ChartPrefs {
  ma: MaLine[];
  /** 볼린저 밴드 */
  bbOn: boolean;
  bbPeriod: number;
  /** 표준편차 배수 */
  bbStdDev: number;
  /**
   * 띠 색 (2026-10-07) — 위·아래·중심을 따로 고른다.
   *
   * 테마에서 한 색을 주고 있었는데, 그러면 「위는 빨강 아래는 파랑」처럼 **방향을 색으로
   * 읽는** 사람이 손댈 자리가 없다. 이평선이 이미 각자 색을 들고 있으니 같은 방식으로 둔다.
   */
  bbUpperColor: string;
  bbLowerColor: string;
  /**
   * 중심선 — 기본은 **꺼 둔다.** 중심선은 `bbPeriod` 일 이동평균과 **같은 선**이라,
   * 이평선을 켜 둔 사람에게는 같은 자리에 두 줄이 겹쳐 그려진다.
   */
  bbMidOn: boolean;
  bbMidColor: string;
  /**
   * **RSI** (2026-10-07 — 벤티지: "차트에 rsi 옵션 키고 끄게 할 수 있어?").
   *
   * 켜면 거래량 아래에 띠가 하나 더 생기고 봉·거래량이 그만큼 위로 눌린다.
   * 기본은 꺼 둔다 — 늘 켜 두면 봉 보는 자리가 좁아진다. 쓰는 사람만 켜면 된다.
   */
  rsiOn: boolean;
  /** 며칠로 잴지. 키움 기본과 같은 14 */
  rsiPeriod: number;
  /**
   * **시그널선** — RSI 를 다시 평균 낸 선 (키움의 「시그널 9」).
   *
   * RSI 하나만 보면 과매수·과매도 두 자리밖에 못 읽는다. 시그널선이 있으면 **둘이
   * 엇갈리는 지점**이 생기고, 그게 키움 차트의 그 화살표다.
   */
  rsiSignalOn: boolean;
  rsiSignal: number;
  /** 과매수·과매도 선 (기본 70·30) */
  rsiHigh: number;
  rsiLow: number;
  /**
   * 엇갈림 화살표 — RSI 가 시그널선을 **뚫은 봉**에 찍는다. 위로 뚫으면 ▲, 아래로 ▼.
   *
   * ⚠️ 이건 **신호이지 매매 지시가 아니다.** 횡보장에서는 하루걸러 엇갈려 화살표가
   * 빽빽해진다 — 추세가 있을 때만 뜻이 있다.
   */
  rsiMarkOn: boolean;
  rsiColor: string;
  rsiSignalColor: string;
  /** 차트 위 판독 줄(이동평균 요약·매물대)을 띄울지 */
  insightsOn: boolean;
  /** 판독 줄 안의 매물대를 띄울지 */
  profileOn: boolean;
  /** 매물대를 몇 거래일치로 볼지 */
  profileDays: number;
  /** 말풍선에 넣을 것 */
  tip: TipField[];
  /**
   * 차트를 열었을 때 **처음 보이는 구간**.
   *
   * 일봉이 2025년부터 통째로 나와서 **열 때마다 손으로 확대**해야 했다.
   * 매번 그러느니 기본을 정해 두는 게 맞다 — 사람마다 보는 폭이 다르고,
   * 같은 사람도 일봉과 분봉에서 보고 싶은 폭이 다르다.
   *
   * 거래일 수로 센다(`0` 이면 받아온 전체). 분봉은 **하루**가 기본이다.
   */
  /** 판독 줄(이동평균·매물대)을 접어 뒀나 */
  insightsFold: boolean;
  spanIntraday: number;
  spanDaily: number;
  spanWeekly: number;
  spanMonthly: number;
}

/**
 * 기본값은 **키움 HTS 와 같은 색**이다 — 5일 빨강, 10일 초록, 20일 파랑, 60일 갈색.
 * 두 화면을 오가며 보는데 색이 다르면 매번 범례를 다시 읽어야 한다.
 * 13·120·240 일선은 꺼 둔 채로 넣어 둔다. 쓰는 사람만 켜면 된다.
 */
export const DEFAULT_PREFS: ChartPrefs = {
  ma: [
    { period: 5, color: "#ff5c5c", on: true },
    { period: 10, color: "#35c46a", on: true },
    { period: 13, color: "#f5c542", on: false },
    { period: 20, color: "#4c8dff", on: true },
    { period: 60, color: "#a97452", on: true },
    { period: 120, color: "#c084fc", on: false },
    { period: 240, color: "#8b98a5", on: false },
  ],
  bbOn: false,
  bbPeriod: 20,
  bbStdDev: 2,
  bbUpperColor: "#4fd1c5",
  bbLowerColor: "#4fd1c5",
  bbMidOn: false,
  bbMidColor: "#8b98a5",
  rsiOn: false,
  rsiPeriod: 14,
  rsiSignalOn: true,
  rsiSignal: 9,
  rsiHigh: 70,
  rsiLow: 30,
  rsiMarkOn: true,
  rsiColor: "#f0a04b",
  rsiSignalColor: "#e879c8",
  insightsOn: true,
  profileOn: true,
  profileDays: 120,
  tip: ["ohlc", "change", "volume", "ma", "gap"],
  /*
   * ⚠️ 단위가 **봉 개수**다(거래일이 아니다). 일봉 120봉≈6개월, 주봉 52봉=1년, 월봉 36봉=3년.
   * 주봉에 250(거래일 감각)을 넣었더니 250주가 되어 **자르기가 아무 일도 안 했다.**
   *
   * 분봉은 하루 — 분봉을 켜는 이유가 오늘 어떻게 흘렀나를 보는 것이다.
   * 일봉은 여섯 달 — 스무 날은 추세가 안 보이고 3년은 최근 캔들이 손톱만 해진다.
   */
  insightsFold: false,
  spanIntraday: 1,
  spanDaily: 120,
  spanWeekly: 52,
  spanMonthly: 36,
};

const STORAGE_KEY = "vntg.chart";
const EVENT = "vntg-chart-prefs";

export function readChartPrefs(): ChartPrefs {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_PREFS;
    const saved = JSON.parse(raw) as Partial<ChartPrefs>;
    /*
     * 선 목록은 통째로 덮어쓰지 않는다. 나중에 기본 선을 하나 더 넣으면
     * 예전 저장본에는 그게 없어서 영영 안 보이게 된다.
     * 기본 목록을 뼈대로 두고 **저장된 켬/끔·색만** 얹는다.
     */
    const savedMa = new Map((saved.ma ?? []).map((m) => [m.period, m]));
    const ma = DEFAULT_PREFS.ma.map((d) => {
      const s = savedMa.get(d.period);
      return s ? { ...d, on: s.on ?? d.on, color: s.color || d.color } : d;
    });
    // 사용자가 직접 넣은 기간(기본 목록에 없는 것)도 살린다
    for (const [period, m] of savedMa) {
      if (!ma.some((x) => x.period === period)) {
        ma.push({ period, color: m.color || "#8b98a5", on: m.on ?? true });
      }
    }
    ma.sort((a, b) => a.period - b.period);
    return { ...DEFAULT_PREFS, ...saved, ma };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveChartPrefs(next: ChartPrefs): void {
  setPref(STORAGE_KEY, JSON.stringify(next));
  // 같은 탭에 떠 있는 다른 차트도 바로 갈아끼우게 한다
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useChartPrefs(): {
  prefs: ChartPrefs;
  set: (next: ChartPrefs) => void;
  reset: () => void;
} {
  const [prefs, setPrefs] = useState<ChartPrefs>(readChartPrefs);

  useEffect(() => {
    const sync = () => setPrefs(readChartPrefs());
    window.addEventListener(EVENT, sync);
    // 다른 탭에서 바꿨을 때도 따라간다
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const set = useCallback((next: ChartPrefs) => {
    saveChartPrefs(next);
    setPrefs(next);
  }, []);

  const reset = useCallback(() => {
    saveChartPrefs(DEFAULT_PREFS);
    setPrefs(DEFAULT_PREFS);
  }, []);

  return { prefs, set, reset };
}

/* ───────── 지표 켜고 끄기는 **차트마다 따로** (2026-10-07) ───────── */

/**
 * 벤티지: "RSI 볼린저 설정 하면 열려있는 모든 차트에 적용된다. 독립적으로 적용되게 해줘."
 *
 * 보드에는 차트 카드를 여러 장 띄운다. 한 장에서 RSI 를 켜려고 눌렀더니 **띄워 둔 전부가
 * 같이 켜졌다** — 비교하려고 여러 장을 띄운 사람에게는 그게 고장이다.
 *
 * 자물쇠(`lockScope`)가 이미 같은 문제를 같은 방식으로 풀고 있다: **그 차트만의 값이
 * 있으면 그걸 쓰고, 없으면 공통 설정을 따른다.** 같은 수법을 쓴다 — 두 벌로 만들면
 * 언젠가 한쪽만 고치게 된다.
 *
 * ⚠️ 여기 담는 건 **켜고 끄기뿐**이다. 기간·색·시그널 같은 세부는 공통(`ChartPrefs`)에
 * 그대로 둔다 (벤티지: "세부설정은 옵션에서 하더라고") — 차트마다 다른 기간을 쓰면
 * 같은 지표를 보면서 서로 다른 숫자를 읽게 된다.
 */
export type IndKey = "bb" | "rsi";

const indKeyOf = (scope: string, k: IndKey) => `vntg.chart.ind.${k}.${scope}`;

/** 이 차트에서 켜져 있나 — 제 값이 없으면 공통 설정(`fallback`)을 따른다 */
export function indOn(k: IndKey, scope: string | undefined, fallback: boolean): boolean {
  try {
    if (scope) {
      const own = localStorage.getItem(indKeyOf(scope, k));
      if (own !== null) return own === "1";
    }
  } catch {
    /* 저장소를 못 읽어도 공통 설정으로 뜬다 */
  }
  return fallback;
}

/**
 * 이 차트의 값을 적는다. `scope` 가 없는 차트(개별종목분석처럼 한 장뿐인 자리)는
 * 공통 설정을 직접 고친다 — 거기서 켠 것이 다음에 열 때도 켜져 있어야 한다.
 */
export function setIndOn(k: IndKey, scope: string | undefined, on: boolean): void {
  if (!scope) return;
  try {
    localStorage.setItem(indKeyOf(scope, k), on ? "1" : "0");
  } catch {
    /* 못 적어도 이번 화면에는 적용된다 */
  }
}
