import { useCallback, useEffect, useRef, useState } from "react";
import { removePref, setPref } from "../prefs";

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
 * ## 메뉴도 버튼을 따라 열린다
 *
 * 버튼만 오른쪽으로 옮기고 서랍은 왼쪽에서 밀려 나오면 **옮긴 뜻이 없다.**
 * 손을 바꾸려고 옮긴 것인데 정작 메뉴가 반대편에서 열리면 손을 다시 고쳐 쥐어야 한다.
 * 그래서 놓은 쪽을 설정의 「메뉴바 위치」에 그대로 반영한다 —
 * 끌어 옮기는 것이 **설정을 바꾸는 지름길**이 되는 셈이라, 둘이 어긋날 일이 없다.
 *
 * 반대로 설정에서 좌우를 바꾸면 버튼도 그쪽으로 넘어간다. 위아래는 그대로 둔다 —
 * 바꾼 건 좌우지 높이가 아니다.
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

export function CornerToggle({
  onOpen,
  label,
  side,
  onSide,
}: {
  onOpen: () => void;
  label: string;
  /** 설정의 「메뉴바 위치」. 여기가 바뀌면 버튼도 그쪽으로 넘어간다 */
  side: "left" | "right";
  /** 버튼을 놓은 쪽을 알린다 — 서랍이 이쪽에서 열려야 한다 */
  onSide: (s: "left" | "right") => void;
}) {
  /*
   * ⚠️ **처음 뜰 때는 설정(「메뉴바 위치」)이 진실이다** (2026-08-27 수리).
   *
   * 예전엔 마운트하면서 저장된 모서리를 설정에 밀어 넣었다(onSide). 그런데 이
   * 버튼은 엑셀 모드를 켜고 끌 때마다 **다시 마운트**되고, 모서리 저장값은 한때
   * 서버 전역이라 폰에서 왼쪽에 둔 값이 회사 PC 로 내려와 있었다 — 그래서
   * 엑셀 모드를 끌 때마다 오른쪽으로 둔 메뉴바가 왼쪽으로 튕겼다.
   * 저장된 모서리의 좌우가 설정과 다르면 **모서리를 설정에 맞춘다.**
   */
  const [corner, setCorner] = useState<Corner>(() => {
    const c = read();
    const want = side === "right" ? "r" : "l";
    return c[1] === want ? c : (`${c[0]}${want}` as Corner);
  });
  /** 끄는 동안의 손가락 위치. null 이면 안 끌고 있다 */
  const [drag, setDrag] = useState<{ x: number; y: number } | null>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  const moved = useRef(false);
  const btn = useRef<HTMLButtonElement>(null);
  /** onUp 클로저가 옛 side 를 보지 않게 */
  const sideRef = useRef(side);
  sideRef.current = side;

  /*
   * 버튼 → 설정은 **사람이 실제로 끌어다 놓은 순간에만** 일어난다(save).
   * 그래야 마운트·동기화가 설정을 덮는 길이 원천적으로 없다.
   */
  const save = useCallback(
    (c: Corner) => {
      setCorner(c);
      try {
        setPref(KEY, c);
      } catch {
        /* 저장 못 해도 이번 세션에는 옮겨진다 */
      }
      const s: "left" | "right" = c[1] === "r" ? "right" : "left";
      if (s !== sideRef.current) onSide(s);
    },
    [onSide],
  );

  // 설정 → 버튼. 위아래는 그대로 둔다 — 바꾼 건 좌우지 높이가 아니다
  useEffect(() => {
    const want = side === "right" ? "r" : "l";
    setCorner((c) => {
      if (c[1] === want) return c;
      const next = `${c[0]}${want}` as Corner;
      try {
        setPref(KEY, next);
      } catch {
        /* 무시 */
      }
      return next;
    });
  }, [side]);

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
