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
