import { useEffect, useRef } from "react";

/**
 * 화면 **모서리에서 안쪽으로 밀면 메뉴가 열린다** (2026-08-28 요청).
 *
 * 폰에서 메뉴를 열려면 왼쪽 위 ☰ 를 정확히 눌러야 했다. 한 손으로 들고 볼 때
 * 그 자리는 엄지가 제일 안 닿는 구석이다. 모서리 스와이프는 안드로이드·iOS 의
 * 드로어가 다 쓰는 몸짓이라 따로 배울 것도 없다.
 *
 * ## 어느 모서리인가
 *
 * 사이드바가 붙은 쪽이다 — 설정에서 오른쪽으로 옮겼으면 오른쪽 모서리에서 연다.
 * 서랍이 나오는 방향과 미는 방향이 다르면 그건 다른 동작처럼 느껴진다.
 *
 * ## 오작동 안 나게
 *
 * · **모서리 20px 안에서 시작한 것만.** 본문 한가운데서 옆으로 미는 건
 *   서브탭 스와이프(useSwipeTabs)의 몫이라 겹치면 안 된다.
 * · 가로로 60px 이상 + **가로가 세로의 1.5배 이상** — 세로로 훑다가 손가락이
 *   비스듬해진 것을 메뉴 열기로 읽으면 스크롤이 계속 끊긴다.
 * · 시트·팝업이 떠 있으면 안 연다. 그 위에서 미는 건 그 시트의 일이다.
 * · 이미 열려 있으면 아무것도 안 한다(닫기는 배경 탭이 맡는다).
 */
export function useEdgeSwipe({
  side,
  open,
  onOpen,
}: {
  /** 사이드바가 붙은 쪽 */
  side: "left" | "right";
  /** 지금 열려 있나 — 열려 있으면 쉰다 */
  open: boolean;
  onOpen: () => void;
}): void {
  const start = useRef<{ x: number; y: number } | null>(null);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;

  useEffect(() => {
    if (open) return;

    const EDGE = 20;
    const MIN_X = 60;

    const onStart = (e: TouchEvent) => {
      start.current = null;
      if (e.touches.length !== 1) return;
      /* 시트가 떠 있으면 그쪽 몸짓이다 */
      if (document.querySelector(".overlay")) return;
      const t = e.touches[0];
      const fromEdge = side === "left" ? t.clientX <= EDGE : t.clientX >= window.innerWidth - EDGE;
      if (!fromEdge) return;
      start.current = { x: t.clientX, y: t.clientY };
    };

    const onEnd = (e: TouchEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      /* 안쪽으로 — 왼쪽 서랍은 오른쪽으로, 오른쪽 서랍은 왼쪽으로 */
      const inward = side === "left" ? dx : -dx;
      if (inward < MIN_X || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      openRef.current();
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
  }, [side, open]);
}
