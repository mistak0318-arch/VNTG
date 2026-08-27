import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/**
 * 가로 탭 줄을 **PC 에서도 넘길 수 있게** 감싼다.
 *
 * ## 왜 필요했나
 *
 * 탭 줄은 `overflow-x: auto` 인데 스크롤바를 숨겨 놨다(`scrollbar-width: none`).
 * 폰에서는 손가락으로 밀면 되니까 그게 맞다. 그런데 **PC 에는 밀 손가락이 없다.**
 * 마우스 휠은 세로라 가로 줄에서는 아무 일도 안 일어나고, 스크롤바는 숨겼고,
 * 드래그는 버튼을 누르는 것으로 잡힌다. 결국 **탭을 눌러 포커스를 준 뒤 방향키**
 * 말고는 뒤쪽 탭에 갈 방법이 없었다. 열한 개 탭 중 뒤 서넛이 사실상 없는 셈이었다.
 *
 * 세 가지를 같이 준다. 하나만으로는 모자란다.
 *
 *   1. **휠을 가로로** — PC 에서 제일 자연스럽다. 손이 이미 휠에 있다
 *   2. **좌우 버튼** — 휠이 되는 줄 모르는 사람에게 보이는 단서가 된다
 *   3. **고른 탭을 화면 안으로** — 순서를 바꾸거나 다시 열었을 때 뒤쪽 탭이 골라져
 *      있으면 화면 밖이라 「아무것도 안 골라진 줄」 알게 된다
 *
 * 넘치지 않으면 버튼을 안 그린다 — 늘 떠 있으면 누를 게 없는데도 눈이 간다.
 */

export function TabScroller({
  children,
  className = "",
  /** 이 값이 바뀌면 고른 탭을 화면 안으로 끌어온다 */
  activeKey,
}: {
  children: ReactNode;
  className?: string;
  activeKey?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  /** 지금 양옆에 더 있나 — 버튼을 그릴지 정한다 */
  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // 1px 여유 — 소수점 폭 때문에 끝에 닿아도 0.5 쯤 남는 일이 있다
    const left = el.scrollLeft > 1;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    // 값이 그대로면 이전 상태를 돌려준다 — 매 렌더마다 재는데 매번 새 객체면 무한 렌더
    setEdge((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  /*
   * 렌더마다 다시 잰다 (2026-08-27) — ResizeObserver 는 **컨테이너 크기**만 본다.
   * 인앱 탭바처럼 탭이 하나씩 늘어나는 줄은 컨테이너는 그대로인 채 내용만 넘쳐서,
   * 끝까지 갔는데도 버튼이 안 나타났다. 자식이 바뀌면 부모가 다시 그리니 여기서 잡힌다.
   */
  useEffect(measure);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();

    /*
     * 휠을 가로로 돌린다.
     *
     * `passive: false` 라야 `preventDefault` 가 먹는다 — 안 막으면 탭 줄을 굴리는
     * 동시에 뒤의 시트까지 같이 내려가서 화면이 통째로 튄다.
     *
     * 가로 휠(deltaX)이 있는 기기는 그대로 둔다. 트랙패드에서 옆으로 쓸었는데
     * 우리가 세로를 또 더하면 두 배로 움직인다.
     */
    const onWheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
      if (el.scrollWidth <= el.clientWidth) return;
      e.preventDefault();
      el.scrollLeft += e.deltaY;
      measure(); // scroll 이벤트를 안 기다린다 — 환경에 따라 늦거나 안 오는 일이 있다
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("scroll", measure, { passive: true });

    /* 창을 줄이면 넘치기 시작한다 — 그때 버튼이 나타나야 한다 */
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("scroll", measure);
      ro.disconnect();
    };
  }, [measure]);

  /* 고른 탭이 화면 밖이면 끌어온다 */
  useEffect(() => {
    const el = ref.current;
    if (!el || !activeKey) return;
    const on = el.querySelector<HTMLElement>(".active");
    on?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [activeKey]);

  /** 한 번에 화면 폭의 3/4 만큼 — 다 넘기면 어디까지 봤는지 놓친다 */
  const nudge = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.75, behavior: "smooth" });
    /*
     * 버튼을 눌렀으면 **여기서도 재 본다.**
     *
     * 평소엔 scroll 이벤트가 알아서 알려 준다. 그런데 그 이벤트는 화면 갱신에 맞춰
     * 오는 것이라 창이 뒤에 있으면(`visibilityState: "hidden"`) 아예 안 온다.
     * 그러면 끝까지 갔는데도 버튼이 남아 있게 된다. 스크롤이 부드럽게 흐르는 중이라
     * 지금 잰 값은 아직 도착 전이지만, 뒤이어 오는 scroll 이벤트가 마저 맞춰 준다.
     */
    requestAnimationFrame(measure);
    setTimeout(measure, 400);
  };

  return (
    <div className="tabscroll">
      {edge.left && (
        <button className="tabscroll-btn left" onClick={() => nudge(-1)} title="앞쪽 탭" aria-label="앞쪽 탭">
          ‹
        </button>
      )}
      <div className={className} ref={ref}>
        {children}
      </div>
      {edge.right && (
        <button className="tabscroll-btn right" onClick={() => nudge(1)} title="뒤쪽 탭" aria-label="뒤쪽 탭">
          ›
        </button>
      )}
    </div>
  );
}
