import { useRef } from "react";

/**
 * 서브탭 좌우 스와이프 (2026-08-28 요청 — 「터치로 좌우로 밀었을 때 메뉴들
 * 옮겨다니게」).
 *
 * 폰에서 서브탭이 예닐곱이면 탭 줄 자체가 옆으로 감겨서, 다음 탭으로 가려면
 * 탭 줄을 밀고 → 찾아서 → 눌러야 했다. 본문을 옆으로 밀면 다음/이전 탭이다.
 *
 * ## 가로 스크롤과 안 싸우는 법
 *
 * 표(`data-table-wrap`)·차트는 저들끼리 가로로 스크롤된다. 그 위에서 시작한
 * 제스처를 탭 전환으로 뺏으면 표를 못 민다. 그래서 **시작점에서 조상을 훑어
 * 가로로 스크롤될 수 있는 요소가 있으면 통째로 양보한다** — 「스크롤 끝에
 * 닿았으면 전환」 같은 절충은 끝에서 표를 밀다가 화면이 홱 넘어가는 사고가 된다.
 * 시트·팝업(.overlay) 위의 제스처도 무시한다 — 뒤에 깔린 탭이 바뀌면 안 된다.
 *
 * ## 판정
 *
 * 60px 이상 + 가로가 세로의 1.8배 이상일 때만. 스크롤하려던 손짓(대각선)을
 * 전환으로 오독하는 것이 이 기능의 최악이라, 애매하면 아무것도 안 한다.
 * 끝 탭에서는 감지 않는다(순환 없음) — 마지막 탭에서 한 번 더 밀었는데 첫
 * 탭으로 돌아가면 어디에 있는지 잃는다.
 */
export function useSwipeTabs({
  order,
  current,
  onChange,
}: {
  /** 화면에 보이는 순서 그대로의 탭 키들 (사용자 정렬 반영) */
  order: string[];
  current: string;
  onChange: (key: string) => void;
}): {
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
} {
  const start = useRef<{ x: number; y: number; blocked: boolean } | null>(null);

  return {
    onTouchStart: (e) => {
      if (e.touches.length !== 1) {
        start.current = null;
        return;
      }
      const t = e.touches[0];
      /* 가로 스크롤 요소나 시트 위면 양보 — 여기서 한 번만 훑는다(끝날 때는 target 이 다를 수 있다) */
      let blocked = false;
      let el = e.target as HTMLElement | null;
      const stop = e.currentTarget as HTMLElement;
      while (el && el !== stop.parentElement) {
        if (el.classList?.contains("overlay") || el.classList?.contains("sheet")) {
          blocked = true;
          break;
        }
        if (el.scrollWidth > el.clientWidth + 4) {
          const ox = getComputedStyle(el).overflowX;
          if (ox === "auto" || ox === "scroll") {
            blocked = true;
            break;
          }
        }
        if (el === stop) break;
        el = el.parentElement;
      }
      start.current = { x: t.clientX, y: t.clientY, blocked };
    },
    onTouchEnd: (e) => {
      const s = start.current;
      start.current = null;
      if (!s || s.blocked) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) < 60 || Math.abs(dx) < Math.abs(dy) * 1.8) return;
      const i = order.indexOf(current);
      if (i < 0) return;
      const next = dx < 0 ? order[i + 1] : order[i - 1];
      if (next) onChange(next);
    },
  };
}

/** 저장된 순서(orderOf)를 반영한 화면 순서 — 스와이프는 눈에 보이는 차례를 따라야 한다 */
export function visualOrder<K extends string>(
  keys: K[],
  orderOf: (key: string) => number,
): K[] {
  return [...keys].sort((a, b) => orderOf(a) - orderOf(b));
}
