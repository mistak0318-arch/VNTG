import { useState, type CSSProperties } from "react";

/**
 * 표 글자 크기 가−/가＋ (2026-09-09 밤 — 벤티지 "기본 폰트 크기가 너무 작은 거 같아서 …
 * 표 위에 +/- 넣어서 글자 크기 좀 조절할 수 있게" → 해외 관심종목에도 "얘도 +/- 달아주고").
 *
 * 화면마다 값 하나. 루트 요소에 `style` 을 얹으면 CSS 변수 `--tbl-font` 가 그 안의
 * 모든 `.data-table` 에 걸린다(styles.css `.tbl-font-root`). 기본 0.78rem — 현미경 표와
 * 같고 원래 시세분석(0.7333)보다 한 단 크다. 0.62~1.0, 0.04 걸음. 기기마다 다른 값이라 로컬.
 */
export function useTableFont(storageKey: string, def = 0.78) {
  const [rem, setRem] = useState<number>(() => {
    try {
      const n = Number(localStorage.getItem(storageKey));
      return n >= 0.62 && n <= 1.0 ? n : def;
    } catch {
      return def;
    }
  });
  const bump = (d: number) =>
    setRem((cur) => {
      const next = Math.round(Math.min(1.0, Math.max(0.62, cur + d)) * 100) / 100;
      try {
        localStorage.setItem(storageKey, String(next));
      } catch {
        /* 저장 못 해도 이번 세션에는 바뀐다 */
      }
      return next;
    });
  const style = { "--tbl-font": `${rem}rem` } as CSSProperties;
  return { rem, bump, style, className: "tbl-font-root" };
}

/** 도구줄에 놓는 두 단추 */
export function TableFontButtons({ font }: { font: ReturnType<typeof useTableFont> }) {
  return (
    <span className="scr-font" title={`표 글자 크기 ${font.rem}rem — 이 화면의 모든 표에 같이 걸립니다`}>
      <button className="filter-btn" onClick={() => font.bump(-0.04)} disabled={font.rem <= 0.62} title="글자 작게">
        가−
      </button>
      <button className="filter-btn" onClick={() => font.bump(0.04)} disabled={font.rem >= 1.0} title="글자 크게">
        가＋
      </button>
    </span>
  );
}
