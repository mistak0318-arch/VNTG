import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { removePref, setPref } from "./prefs";

/**
 * 화면 외관 설정 (테마 / 글꼴 / 글자 크기).
 *
 * 값은 localStorage에 저장하고 <html>의 data-* 속성으로 내보낸다.
 * 실제 색·폰트는 CSS가 그 속성을 보고 변수만 바꾸므로, 컴포넌트는 아무것도 몰라도 된다.
 * 서버에 저장하지 않는 이유: 기기마다 다르게 쓰고 싶은 값이라서.
 */

/**
 * 테마.
 *
 * `excel` 은 색만 바꾸는 게 아니라 **엑셀처럼 보이게 하는 모드**다 —
 * 리본·행번호·열문자·시트탭이 함께 붙는다. 자세한 건 `components/ExcelChrome.tsx`.
 */
export type ThemeName = "dark" | "light" | "excel";
export type FontName = "system" | "pretendard" | "noto" | "gothic" | "mono";
/** 메뉴바를 어느 쪽에 둘지 */
export type NavSide = "left" | "right";
/** 본문을 얼마나 넓게 쓸지 */
export type WidthName = "normal" | "wide" | "full";

export interface Appearance {
  theme: ThemeName;
  font: FontName;
  /** 기본 15px 기준 배율(%) */
  fontScale: number;
  /**
   * 메뉴바 위치.
   *
   * 한 손으로 폰을 쥐면 엄지가 닿는 쪽이 정해져 있다 — 왼쪽에 고정해 두면
   * 오른손잡이는 메뉴를 열 때마다 손을 고쳐 쥐어야 한다.
   * PC 에서도 넓은 화면에서는 오른쪽이 편한 사람이 있다.
   */
  navSide: NavSide;
  /**
   * 본문 최대 폭.
   *
   * ⚠️ 1400px 로 못 박혀 있었다. 3440 울트라와이드에서는 **오른쪽 2000px 이 통째로
   * 논다** — 시세분석처럼 표가 넓은 화면은 열이 잘리는데 옆은 비어 있는 꼴이었다.
   * CSS 는 `--main-max` 변수로 빼 뒀는데 **값을 넣어 주는 데가 없어서** 늘 기본값
   * 1400 이었다. 변수만 만들고 손잡이를 안 단 셈이다.
   *
   * 그렇다고 무제한이 늘 옳지도 않다. 가이드·리포트처럼 글이 많은 화면은 한 줄이
   * 화면을 가로지르면 눈이 줄을 놓친다. 그래서 고르게 둔다.
   */
  width: WidthName;
}

export const WIDTHS: { key: WidthName; label: string; css: string; hint: string }[] = [
  { key: "normal", label: "보통", css: "1400px", hint: "글이 많은 화면이 읽기 좋습니다" },
  { key: "wide", label: "넓게", css: "1920px", hint: "표가 넓은 화면에서 열이 더 보입니다" },
  { key: "full", label: "화면 전체", css: "none", hint: "울트라와이드에서 남는 자리가 없습니다" },
];

export const FONTS: { key: FontName; label: string; stack: string }[] = [
  {
    key: "system",
    label: "시스템 기본",
    stack:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", "Apple SD Gothic Neo", "Malgun Gothic", sans-serif',
  },
  { key: "pretendard", label: "Pretendard", stack: 'Pretendard, "Apple SD Gothic Neo", sans-serif' },
  { key: "noto", label: "본고딕", stack: '"Noto Sans KR", "Malgun Gothic", sans-serif' },
  { key: "gothic", label: "맑은 고딕", stack: '"Malgun Gothic", "맑은 고딕", sans-serif' },
  { key: "mono", label: "고정폭", stack: 'ui-monospace, Consolas, "D2Coding", monospace' },
];

/**
 * 글자 크기 배율(%).
 *
 * ⚠️ 위가 **120 에서 막혀 있었다.** 27인치를 멀리 두고 보거나 태블릿을 차 안에 세워
 * 두면 120 도 작다 — 화면이 클수록 눈에서 멀어지는데, 그때 더 키울 방법이 없었다.
 * **200 까지** 연다. 표가 넘치면 가로 스크롤이 받아 준다(`data-table-wrap`).
 *
 * 아래로도 한 칸 더 뒀다 — 엑셀 모드로 종목을 잔뜩 늘어놓을 때 쓴다.
 */
export const FONT_SCALES = [75, 85, 92, 100, 110, 120, 135, 150, 175, 200];

const STORAGE_KEY = "vntg.appearance";

const DEFAULTS: Appearance = {
  theme: "dark",
  font: "system",
  fontScale: 100,
  navSide: "left",
  width: "normal",
};

function read(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Appearance>) };
  } catch {
    return DEFAULTS;
  }
}

/** 한국어 윈도우의 엑셀 기본 글꼴 */
const EXCEL_FONT = '"맑은 고딕", "Malgun Gothic", "Segoe UI", sans-serif';

/** <html>에 속성을 찍어두면 CSS가 알아서 변수를 바꾼다 */
function apply(a: Appearance): void {
  const root = document.documentElement;
  root.dataset.theme = a.theme;
  /*
   * 엑셀 모드에서는 **글꼴 선택을 덮어쓴다.**
   *
   * 흘끗 봤을 때 엑셀로 보이게 하는 게 이 모드의 전부인데, 글자가 Pretendard 면
   * 리본을 아무리 잘 그려도 남의 프로그램처럼 보인다. 설정값 자체는 그대로 두므로
   * 다크/라이트로 돌아오면 고르셨던 글꼴이 그대로 살아난다.
   */
  root.style.setProperty(
    "--app-font",
    a.theme === "excel"
      ? EXCEL_FONT
      : (FONTS.find((f) => f.key === a.font)?.stack ?? FONTS[0].stack),
  );
  root.style.setProperty("--app-font-size", `${(15 * a.fontScale) / 100}px`);
  // 차트 라이브러리는 CSS 변수를 못 읽으므로 색상 스키마도 알려준다
  // (`excel` 은 colorScheme 로 쓸 수 없는 값이라 밝은 쪽으로 접어 준다)
  root.style.colorScheme = a.theme === "dark" ? "dark" : "light";
  // 메뉴바 좌우는 CSS 가 이 속성을 보고 방향을 뒤집는다
  root.dataset.nav = a.navSide;
  /* 본문 폭 — 보드는 CSS 에서 따로 풀어 두었으므로 여기서는 신경 안 쓴다 */
  root.style.setProperty("--main-max", WIDTHS.find((w) => w.key === a.width)?.css ?? "1400px");
}

interface AppearanceContext extends Appearance {
  set: (patch: Partial<Appearance>) => void;
}

const Ctx = createContext<AppearanceContext | null>(null);

export function AppearanceProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<Appearance>(() => read());

  useEffect(() => {
    apply(state);
    try {
      setPref(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // 저장 실패해도 화면은 그대로 동작해야 한다
    }
  }, [state]);

  const set = useCallback((patch: Partial<Appearance>) => {
    setState((prev) => ({ ...prev, ...patch }));
  }, []);

  return <Ctx.Provider value={{ ...state, set }}>{children}</Ctx.Provider>;
}

export function useAppearance(): AppearanceContext {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("AppearanceProvider 안에서 써야 합니다.");
  return ctx;
}

/**
 * 차트 라이브러리에 넘길 색상.
 * lightweight-charts는 CSS 변수를 해석하지 못해서 실제 색상값이 필요하다.
 */
export function chartColors(theme: ThemeName) {
  /*
   * 엑셀 모드는 격자를 진하게 — 차트도 시트 위에 그린 것처럼 보여야 한다.
   *
   * ⚠️ 봉 색까지 여기서 준다. 예전엔 `#ff5c5c` / `#4c8dff` 를 CandleChart 안에
   * 박아 뒀는데, 그러면 **엑셀 모드에서도 빨강·파랑 봉**이 남는다. 표는 색을 빼
   * 회계 장부처럼 만들어 놓고 그 옆 차트만 형광색이면 위장이 통째로 깨진다.
   * 캔버스는 CSS 로 못 덮으므로 값을 넘겨 주는 수밖에 없다.
   *
   * 엑셀에서는 오름을 진한 회색, 내림을 옅은 회색으로 둔다. 엑셀 차트가 흑백으로
   * 인쇄될 때 쓰는 방식이고, **명암 차이라 흘끗 봐도 갈린다.**
   */
  if (theme === "excel")
    return {
      text: "#444444",
      grid: "#d4d4d4",
      border: "#b1b1b1",
      volume: "#bfbfbf",
      up: "#4a4a4a",
      down: "#a6a6a6",
    };
  return theme === "light"
    ? { text: "#5b6673", grid: "#e8ecf1", border: "#d0d7e0", volume: "#c9d2dc", up: "#ff5c5c", down: "#4c8dff" }
    : { text: "#8b98a5", grid: "#1a232d", border: "#223040", volume: "#3a4553", up: "#ff5c5c", down: "#4c8dff" };
}

/**
 * MAP 타일 배경색 — **등락률을 색의 진하기로.**
 *
 * ⚠️ 타일마다 각자 계산하고 있었다(시황 전광판·데일리 리포트·테마 MAP 셋).
 * 인라인 `style` 이라 CSS 로는 못 덮으므로 **엑셀 모드에서 빨강·파랑이 그대로 남았다.**
 * 한 곳에서 만들어 셋이 같이 쓴다.
 *
 * 엑셀에서는 색 대신 **명암**만 쓴다. 오름은 짙게, 내림은 옅게 — 조건부 서식의
 * 색조 스케일이 하는 그 일이다. 값은 타일에 숫자로 적혀 있으므로 방향은 안 잃는다.
 */
export function tileHeat(
  rate: number | null,
  theme: ThemeName,
  /*
   * 최대 강도가 되는 등락폭(%). 기본 5 — 개별 종목의 기준이다.
   * ETF 는 ±2% 면 큰 날이라 5% 기준으로 칠하면 전부 흐릿해서 「어디가 셌나」가
   * 안 보인다 — 미국 섹터 MAP 이 2 를 넘겨 쓴다.
   */
  max = 5,
): React.CSSProperties {
  if (rate === null || !Number.isFinite(rate)) {
    return { background: theme === "excel" ? "#f2f2f2" : "rgba(139, 150, 165, .12)" };
  }
  const capped = Math.min(Math.abs(rate), max) / max;
  const alpha = 0.12 + capped * 0.55;
  if (theme === "excel") {
    if (rate === 0) return { background: "#f2f2f2" };
    /*
     * ⚠️ **명암만으로는 방향이 안 갈린다.**
     *
     * 처음엔 오름을 짙게, 내림을 옅게만 했다. 그랬더니 −6.25% 가 rgb(212) 인데
     * +0.35% 가 rgb(216) 으로 **거의 같은 밝기**가 됐다. 크게 빠진 칸과 살짝 오른
     * 칸이 한눈에 같아 보이면 MAP 을 볼 이유가 없다. 회색 한 축에 방향과 세기를
     * 같이 실으려 한 게 잘못이었다.
     *
     * 세기는 명암이 맡고 **방향은 형태**가 맡는다 — 내림 칸에는 왼쪽에 진한 띠를
     * 세운다. 엑셀 조건부 서식이 흑백으로 인쇄될 때 쓰는 방법이고, 색맹이어도,
     * 흑백으로 뽑아도 갈린다.
     */
    if (rate > 0) {
      const lum = 90 - capped * 47;
      return {
        background: `hsl(0 0% ${lum}%)`,
        ...(capped > 0.6 ? { color: "#ffffff" } : {}),
      };
    }
    const lum = 96 - capped * 16;
    return {
      background: `hsl(0 0% ${lum}%)`,
      boxShadow: `inset 3px 0 0 hsl(0 0% ${52 - capped * 22}%)`,
    };
  }
  if (rate > 0) return { background: `rgba(240, 85, 95, ${alpha})` };
  if (rate < 0) return { background: `rgba(74, 139, 245, ${alpha})` };
  return { background: "rgba(139, 150, 165, 0.12)" };
}
