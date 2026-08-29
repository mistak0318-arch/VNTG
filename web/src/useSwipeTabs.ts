import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 서브탭 좌우 스와이프 (2026-08-28 요청 — 「터치로 좌우로 밀었을 때 메뉴들
 * 옮겨다니게」) + **미끄러지는 느낌** (2026-08-29 요청).
 *
 * 폰에서 서브탭이 예닐곱이면 탭 줄 자체가 옆으로 감겨서, 다음 탭으로 가려면
 * 탭 줄을 밀고 → 찾아서 → 눌러야 했다. 본문을 옆으로 밀면 다음/이전 탭이다.
 *
 * ## 움직임을 어떻게 만드나
 *
 * 이웃 탭을 미리 그려 두고 손가락을 그대로 따라가게 하는 방식(캐러셀)은 안 쓴다 —
 * 탭마다 차트·표가 무겁고, 안 볼 화면을 매번 그리면 그게 더 느리다. 대신 둘로 나눈다:
 *
 *   ① **끄는 동안** — 본문을 손가락의 1/4 만큼만 따라 움직인다(최대 40px).
 *      「잡혔다」는 느낌만 준다. 문턱을 넘으면 조금 더 밀려 갈 데가 있음을 알린다.
 *   ② **놓는 순간** — 탭을 바꾸고, 새 본문이 **밀려온 쪽에서** 미끄러져 들어온다.
 *      되돌아갈 때는 제자리로 튕겨 돌아간다.
 *
 * 이러면 이웃을 안 그리고도 방향감이 남는다 — 어디서 와서 어디로 갔는지가 보인다.
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
 *
 * ## ⚠️ transform 은 **움직일 때만** 건다
 *
 * 요소에 transform 이 걸려 있으면 그 안의 `position: fixed` 자식이 화면이 아니라
 * **이 요소**를 기준으로 잡힌다 — 시트가 엉뚱한 자리에 뜬다. 멈춰 있을 때는
 * 반드시 지운다(빈 문자열). 시트가 떠 있으면 제스처 자체를 안 받으므로
 * 둘이 동시에 성립하지도 않는다.
 */

const MIN_X = 60;
/** 손가락을 얼마나 따라갈지 — 1이면 본문이 통째로 딸려와 스크롤처럼 보인다 */
const FOLLOW = 0.25;
const MAX_FOLLOW = 40;

function reduceMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}

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
  ref: (el: HTMLDivElement | null) => void;
  className: string;
  onTouchStart: (e: React.TouchEvent) => void;
  onTouchMove: (e: React.TouchEvent) => void;
  onTouchEnd: (e: React.TouchEvent) => void;
} {
  const start = useRef<{ x: number; y: number; blocked: boolean } | null>(null);
  const el = useRef<HTMLDivElement | null>(null);
  /** 방금 어느 쪽으로 넘어갔나 — 새 본문이 그쪽에서 미끄러져 들어온다 */
  const [slide, setSlide] = useState<"next" | "prev" | null>(null);

  /* 애니메이션이 끝나면 클래스를 뗀다 — 남아 있으면 다음 렌더에 다시 재생된다 */
  useEffect(() => {
    if (!slide) return;
    const t = setTimeout(() => setSlide(null), 220);
    return () => clearTimeout(t);
  }, [slide]);

  const setRef = useCallback((node: HTMLDivElement | null) => {
    el.current = node;
  }, []);

  /** 끄는 동안의 위치 — transition 없이 즉시 따라붙는다 */
  const drag = (dx: number) => {
    const n = el.current;
    if (!n || reduceMotion()) return;
    const damped = Math.max(-MAX_FOLLOW, Math.min(MAX_FOLLOW, dx * FOLLOW));
    n.style.transition = "none";
    n.style.transform = `translateX(${damped.toFixed(1)}px)`;
  };

  /** 제자리로 — 넘어가든 되돌아가든 transform 은 반드시 지운다(fixed 자식 때문) */
  const release = () => {
    const n = el.current;
    if (!n) return;
    n.style.transition = "transform 0.18s ease-out";
    n.style.transform = "translateX(0)";
    window.setTimeout(() => {
      if (el.current === n) {
        n.style.transition = "";
        n.style.transform = "";
      }
    }, 200);
  };

  return {
    ref: setRef,
    className: slide === "next" ? "tab-slide-next" : slide === "prev" ? "tab-slide-prev" : "",
    onTouchStart: (e) => {
      if (e.touches.length !== 1) {
        start.current = null;
        return;
      }
      const t = e.touches[0];
      /* 가로 스크롤 요소나 시트 위면 양보 — 여기서 한 번만 훑는다(끝날 때는 target 이 다를 수 있다) */
      let blocked = false;
      let node = e.target as HTMLElement | null;
      const stop = e.currentTarget as HTMLElement;
      while (node && node !== stop.parentElement) {
        if (node.classList?.contains("overlay") || node.classList?.contains("sheet")) {
          blocked = true;
          break;
        }
        if (node.scrollWidth > node.clientWidth + 4) {
          const ox = getComputedStyle(node).overflowX;
          if (ox === "auto" || ox === "scroll") {
            blocked = true;
            break;
          }
        }
        if (node === stop) break;
        node = node.parentElement;
      }
      start.current = { x: t.clientX, y: t.clientY, blocked };
    },
    onTouchMove: (e) => {
      const s = start.current;
      if (!s || s.blocked || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      /* 아직 가로 몸짓인지 모를 때는 안 움직인다 — 세로 스크롤이 덜컹인다 */
      if (Math.abs(dx) < 16 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
      /* 갈 데가 없으면(끝 탭) 덜 움직인다 — 벽이라는 느낌 */
      const i = order.indexOf(current);
      const wall = dx < 0 ? i >= order.length - 1 : i <= 0;
      drag(wall ? dx * 0.35 : dx);
    },
    onTouchEnd: (e) => {
      const s = start.current;
      start.current = null;
      if (!s || s.blocked) return;
      release();
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      if (Math.abs(dx) < MIN_X || Math.abs(dx) < Math.abs(dy) * 1.8) return;
      const i = order.indexOf(current);
      if (i < 0) return;
      const next = dx < 0 ? order[i + 1] : order[i - 1];
      if (!next) return;
      if (!reduceMotion()) setSlide(dx < 0 ? "next" : "prev");
      onChange(next);
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
