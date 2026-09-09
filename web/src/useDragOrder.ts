import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 끌어서 순서 바꾸기 — **순서를 다루는 모든 자리의 공용 훅** (2026-08-25).
 *
 * ## 폰에서도 끌린다 (2026-09-09)
 *
 * 벤티지: "각 순서 변경하는 것도 지금은 화살표인데 드래그로 할 수 있게 해줘."
 *
 * 예전에는 HTML5 drag & drop 이었다. 그건 **터치에서 아예 안 뜬다** — 그래서 옛 주석이
 * 「PC 는 끌고, 폰은 화살표」라고 적어 두었는데, 벤티지는 폰으로 쓴다. 화살표만 남아
 * 있었던 셈이다.
 *
 * 그래서 **포인터 이벤트 한 벌**로 다시 짰다. 마우스·터치·펜이 같은 길로 온다 —
 * 두 벌을 유지하면 언젠가 한쪽만 고쳐진다.
 *
 * ## 스크롤과 싸우지 않는 법
 *
 * 터치에서 어려운 것은 「끌기」와 「넘기기」를 가르는 일이다. 목록을 넘기려고 손을
 * 댔는데 항목이 끌려 나오면 못 쓴다. 그래서 **길게 누르면 그때부터 끌기**다:
 *
 *   · 누르고 **300ms** 버티면 잡힌다(그때 짧게 진동 — 잡혔다는 신호)
 *   · 그 전에 **8px** 넘게 움직이면 넘기기로 보고 놓아 준다
 *   · 잡힌 뒤에는 `touchmove` 를 막아 화면이 안 밀린다(수동 리스너로 등록해야 막힌다)
 *
 * 마우스는 그 기다림이 필요 없다 — 마우스로는 화면을 밀지 않으므로 **바로** 잡는다.
 *
 * ## 부르는 쪽은 안 바뀐다
 *
 *   const drag = useDragOrder(currentKeys, (next) => save(next));
 *   <button {...drag.props(key)} className={drag.cls(key)}>…</button>
 *
 * 쓰는 법이 예전과 같아서 탭·표 머리·설정 목록이 **한 줄도 안 고치고** 터치 끌기를
 * 같이 얻는다. 화살표는 그대로 둔다 — 한 칸만 옮길 때는 그쪽이 정확하다.
 *
 * 떨어뜨린 자리 계산: 끌던 것을 빼고, **떨어뜨린 대상의 자리**에 넣는다.
 * 앞에서 뒤로 끌면 대상 뒤에, 뒤에서 앞으로 끌면 대상 앞에 — 눈에 보이는
 * 「그 자리에 놓았다」와 일치한다.
 */

/** 길게 누르는 시간 — 넘기기와 갈리는 지점 */
const HOLD_MS = 300;
/** 잡히기 전에 이만큼 움직이면 넘기기로 본다 */
const SLOP_PX = 8;
/** 항목을 찾아내는 표식 — 손가락 밑에 무엇이 있나를 이걸로 안다 */
const ATTR = "data-drag-key";

export interface DragOrder {
  /** 끌 요소에 스프레드. disabled 항목엔 안 붙이면 된다 */
  props(key: string): {
    [ATTR]: string;
    onPointerDown: (e: React.PointerEvent) => void;
  };
  /** 상태 클래스 — 끌리는 중이면 drag-src, 놓일 자리면 drag-over */
  cls(key: string): string;
  dragging: string | null;
}

export function useDragOrder(current: string[], commit: (next: string[]) => void): DragOrder {
  /*
   * 끌던 키는 ref 로 — 움직임은 초당 수십 번 오는데 그때마다 상태를 바꾸면 표 전체가
   * 다시 그려진다. 화면용 상태(dragging/over)는 잡힐 때·대상이 바뀔 때·끝날 때만 바뀐다.
   */
  const src = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /* 최신 배열을 리스너가 봐야 한다 — 리스너는 한 번 걸리고 오래 산다 */
  const listRef = useRef(current);
  listRef.current = current;
  const commitRef = useRef(commit);
  commitRef.current = commit;

  const drop = useCallback((target: string | null) => {
    const from = src.current;
    src.current = null;
    setDragging(null);
    setOver(null);
    if (!from || !target || from === target) return;
    const list = listRef.current;
    const fromIdx = list.indexOf(from);
    const toIdx = list.indexOf(target);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = list.filter((k) => k !== from);
    // 「그 자리에 놓았다」 — 앞→뒤는 대상 뒤에, 뒤→앞은 대상 앞에
    const at = next.indexOf(target) + (fromIdx < toIdx ? 1 : 0);
    next.splice(at, 0, from);
    commitRef.current(next);
  }, []);

  /** 그 좌표 밑에 있는 항목의 키 — 없으면 null */
  const keyAt = (x: number, y: number): string | null => {
    const el = document.elementFromPoint(x, y);
    const hit = el?.closest(`[${ATTR}]`);
    return hit?.getAttribute(ATTR) ?? null;
  };

  /* 걸어 둔 리스너를 떼는 손잡이 — 화면이 사라질 때도 반드시 떨어져야 한다 */
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanup.current?.(), []);

  const onPointerDown = (key: string) => (e: React.PointerEvent) => {
    /* 왼쪽 단추(또는 터치)만. 오른쪽 단추로 끌지는 않는다 */
    if (e.button !== 0) return;
    const touch = e.pointerType !== "mouse";
    const x0 = e.clientX;
    const y0 = e.clientY;
    let armed = false;
    let holdTimer: ReturnType<typeof setTimeout> | null = null;

    const arm = () => {
      armed = true;
      src.current = key;
      setDragging(key);
      /* 잡혔다는 신호 — 안드로이드에서만 울리고 없는 곳에서는 조용히 지나간다 */
      try {
        if (touch) navigator.vibrate?.(10);
      } catch {
        /* 진동은 있으면 좋은 것이지 있어야 하는 것이 아니다 */
      }
    };

    /*
     * ⚠️ **수동(non-passive) 리스너여야 막힌다.** 크롬은 `touchmove` 를 기본으로
     * passive 로 걸어서 `preventDefault` 가 무시된다 — 그러면 끄는 동안 화면이 같이
     * 밀린다. `{ passive: false }` 로 직접 걸어야 한다.
     */
    const onTouchMove = (ev: TouchEvent) => {
      if (armed) ev.preventDefault();
    };
    const onMove = (ev: PointerEvent) => {
      if (!armed) {
        /* 아직 안 잡혔는데 많이 움직였다 → 넘기기다. 물러난다 */
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > SLOP_PX) end(null);
        return;
      }
      const k = keyAt(ev.clientX, ev.clientY);
      setOver((prev) => (prev === k ? prev : k));
    };
    const onUp = (ev: PointerEvent) => {
      const k = armed ? keyAt(ev.clientX, ev.clientY) : null;
      end(k);
    };
    const onCancel = () => end(null);

    function end(target: string | null) {
      if (holdTimer) clearTimeout(holdTimer);
      holdTimer = null;
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      window.removeEventListener("touchmove", onTouchMove);
      cleanup.current = null;
      if (armed) {
        /*
         * ⚠️ **끌고 나면 클릭이 따라온다.** 표 머리는 누르면 정렬이 바뀌고 탭은 화면이
         * 바뀌는 자리라, 자리를 옮겼을 뿐인데 정렬까지 뒤집힌다. 잡았던 손을 놓는
         * 순간의 클릭 **한 번만** 삼킨다(포착 단계라 아무도 못 받는다).
         */
        const swallow = (ev: MouseEvent) => {
          ev.stopPropagation();
          ev.preventDefault();
        };
        window.addEventListener("click", swallow, { capture: true, once: true });
        /* 클릭이 안 오는 경우도 있다(터치 취소) — 남겨 두면 다음 클릭이 먹힌다 */
        setTimeout(() => window.removeEventListener("click", swallow, { capture: true }), 350);
        drop(target);
      }
      armed = false;
    }

    cleanup.current = () => end(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    window.addEventListener("touchmove", onTouchMove, { passive: false });

    /* 마우스는 기다릴 이유가 없다 — 마우스로는 화면을 밀지 않는다 */
    if (touch) holdTimer = setTimeout(arm, HOLD_MS);
    else arm();
  };

  return {
    props: (key: string) => ({ [ATTR]: key, onPointerDown: onPointerDown(key) }),
    cls: (key: string) => (key === dragging ? " drag-src" : key === over ? " drag-over" : ""),
    dragging,
  };
}
