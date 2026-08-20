import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 메뉴 여는 동그란 버튼 — **끌어서 네 모서리로 옮긴다.**
 *
 * ## 왜 끌게 하나
 *
 * 폰을 어느 손으로 쥐느냐에 따라 엄지가 닿는 자리가 다르다. 설정에 「메뉴바 위치」가
 * 있긴 하지만, 손을 바꿀 때마다 설정을 열러 들어가는 사람은 없다.
 * **버튼을 그냥 끌어다 놓는 것**이 이 문제의 자연스러운 크기다.
 *
 * ## 네 모서리로만 붙는다
 *
 * 아무 데나 놓게 하면 본문 한가운데 떠서 글자를 가리고, 다음에 찾을 때 매번
 * 눈으로 뒤져야 한다. 손을 떼면 **가장 가까운 모서리로 붙는다** —
 * 자리가 넷뿐이면 어디 있는지 늘 안다.
 *
 * ## 끄는 것과 누르는 것을 가른다
 *
 * 같은 손가락 동작이라 섞이기 쉽다. **조금이라도 움직였으면 끈 것**으로 보고
 * 메뉴를 열지 않는다 — 옮기려다 메뉴가 열리면 그 다음에 또 닫아야 한다.
 * 반대로 제자리를 살짝 누른 것은 그냥 누른 것이다.
 *
 * ## 포인터 이벤트 하나로 처리한다
 *
 * 마우스와 터치를 따로 붙이면 두 벌을 관리하게 되고, 폰에서는 둘 다 발생해서
 * 같은 동작이 두 번 처리된다. `pointer*` 는 그 셋을 한 갈래로 준다.
 */

export type Corner = "tl" | "tr" | "bl" | "br";

const KEY = "vntg.navcorner";
/** 이만큼 넘게 움직였으면 「끈 것」이다. 손가락은 가만히 있어도 몇 px 씩 떨린다 */
const DRAG_SLOP = 6;

function read(): Corner {
  try {
    const v = localStorage.getItem(KEY);
    return v === "tl" || v === "tr" || v === "bl" || v === "br" ? v : "tl";
  } catch {
    return "tl";
  }
}

export function CornerToggle({ onOpen, label }: { onOpen: () => void; label: string }) {
  const [corner, setCorner] = useState<Corner>(read);
  /** 끄는 동안의 손가락 위치. null 이면 안 끌고 있다 */
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const btn = useRef<HTMLButtonElement>(null);

  const save = useCallback((c: Corner) => {
    setCorner(c);
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* 저장 못 해도 이번 세션에는 옮겨진다 */
    }
  }, []);

  const onDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    start.current = { x: e.clientX, y: e.clientY };
    moved.current = false;
    // 손가락이 버튼 밖으로 나가도 계속 따라오게
    btn.current?.setPointerCapture(e.pointerId);
  };

  const onMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dy = e.clientY - s.y;
    if (!moved.current && Math.hypot(dx, dy) < DRAG_SLOP) return;
    moved.current = true;
    setDrag({ x: e.clientX, y: e.clientY });
  };

  const onUp = (e: React.PointerEvent<HTMLButtonElement>) => {
    const s = start.current;
    start.current = null;
    setDrag(null);
    if (!s) return;
    if (!moved.current) {
      onOpen();
      return;
    }
    /*
     * 손을 뗀 자리에서 **가장 가까운 모서리**로 붙인다.
     * 화면을 넷으로 갈라 어느 칸에서 놨는지 보면 된다 — 실제 거리를 재도
     * 결과가 같으면서 계산만 길어진다.
     */
    const right = e.clientX > window.innerWidth / 2;
    const bottom = e.clientY > window.innerHeight / 2;
    save(`${bottom ? "b" : "t"}${right ? "r" : "l"}` as Corner);
  };

  /* 끌고 있는 동안에는 화면이 같이 스크롤되면 안 된다 */
  useEffect(() => {
    if (!drag) return;
    const prev = document.body.style.touchAction;
    document.body.style.touchAction = "none";
    return () => {
      document.body.style.touchAction = prev;
    };
  }, [drag]);

  return (
    <>
      {/* 끄는 동안 네 모서리를 보여 준다 — 어디에 놓을 수 있는지 모르면 못 옮긴다 */}
      {drag && (
        <div className="corner-hints" aria-hidden="true">
          {(["tl", "tr", "bl", "br"] as Corner[]).map((c) => {
            const right = c[1] === "r";
            const bottom = c[0] === "b";
            const near =
              right === drag.x > window.innerWidth / 2 &&
              bottom === drag.y > window.innerHeight / 2;
            return <span key={c} className={`corner-hint ${c}${near ? " near" : ""}`} />;
          })}
        </div>
      )}

      <button
        ref={btn}
        className={`nav-toggle corner-toggle ${corner}${drag ? " dragging" : ""}`}
        style={
          drag
            ? // 끄는 동안에는 손가락을 따라다닌다
              { left: drag.x, top: drag.y, right: "auto", bottom: "auto" }
            : undefined
        }
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        aria-label={label}
        title="끌어서 모서리로 옮길 수 있습니다"
      >
        ☰
      </button>
    </>
  );
}
