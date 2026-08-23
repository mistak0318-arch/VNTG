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
}

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

export const FONT_SCALES = [85, 92, 100, 110, 120];

const STORAGE_KEY = "vntg.appearance";

const DEFAULTS: Appearance = { theme: "dark", font: "system", fontScale: 100, navSide: "left" };

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
  // 엑셀 모드는 격자를 진하게 — 차트도 시트 위에 그린 것처럼 보여야 한다
  if (theme === "excel")
    return { text: "#444444", grid: "#d4d4d4", border: "#b1b1b1", volume: "#bfbfbf" };
  return theme === "light"
    ? { text: "#5b6673", grid: "#e8ecf1", border: "#d0d7e0", volume: "#c9d2dc" }
    : { text: "#8b98a5", grid: "#1a232d", border: "#223040", volume: "#3a4553" };
}
