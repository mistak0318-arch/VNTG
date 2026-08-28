import { useEffect, useRef } from "react";

/**
 * 화면 **모서리에서 안쪽으로 밀면 메뉴가 열린다** (2026-08-28 요청).
 *
 * 폰에서 메뉴를 열려면 왼쪽 위 ☰ 를 정확히 눌러야 했다. 한 손으로 들고 볼 때
 * 그 자리는 엄지가 제일 안 닿는 구석이다. 모서리 스와이프는 안드로이드·iOS 의
 * 드로어가 다 쓰는 몸짓이라 따로 배울 것도 없다.
 *
 * ## 어느 모서리든 — **민 쪽에서 나온다** (2026-08-29)
 *
 * 처음엔 사이드바가 붙은 쪽(설정값) 한 곳에서만 열었다. 그런데 한 손으로 들면
 * 엄지가 닿는 모서리는 그때그때 다르다 — 오른손이면 오른쪽이 가깝다.
 * **양쪽 다 받고, 민 쪽에서 서랍이 나온다.** 미는 방향과 나오는 방향이 같아야
 * 손이 서랍을 끌어낸 것처럼 느껴진다.
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
  open,
  onOpen,
}: {
  /** 지금 열려 있나 — 열려 있으면 쉰다 */
  open: boolean;
  /** 어느 모서리에서 밀었나 — 그쪽에서 서랍이 나와야 한다 */
  onOpen: (side: "left" | "right") => void;
}): void {
  const start = useRef<{ x: number; y: number; side: "left" | "right" } | null>(null);
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
      const side =
        t.clientX <= EDGE ? "left" : t.clientX >= window.innerWidth - EDGE ? "right" : null;
      if (!side) return;
      start.current = { x: t.clientX, y: t.clientY, side };
    };

    const onEnd = (e: TouchEvent) => {
      const s = start.current;
      start.current = null;
      if (!s) return;
      const t = e.changedTouches[0];
      if (!t) return;
      const dx = t.clientX - s.x;
      const dy = t.clientY - s.y;
      /* 안쪽으로 — 왼쪽 모서리면 오른쪽으로, 오른쪽 모서리면 왼쪽으로 */
      const inward = s.side === "left" ? dx : -dx;
      if (inward < MIN_X || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      openRef.current(s.side);
    };

    window.addEventListener("touchstart", onStart, { passive: true });
    window.addEventListener("touchend", onEnd, { passive: true });
    return () => {
      window.removeEventListener("touchstart", onStart);
      window.removeEventListener("touchend", onEnd);
    };
  }, [open]);
}
