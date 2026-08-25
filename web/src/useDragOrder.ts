import { useRef, useState } from "react";

/**
 * 끌어서 순서 바꾸기 — **순서를 다루는 모든 자리의 공용 훅** (2026-08-25).
 *
 * ## 왜 이제야 드래그인가
 *
 * 지금까지는 전부 ◀▶/▲▼ 화살표였다. 이유가 있었다 — 폰에서 터치 드래그는
 * 스크롤과 싸우고, 개발 창에서 드래그 미리보기를 확인할 수 없었다. 그런데
 * PC 에서 여덟 칸을 여덟 번 누르는 건 그것대로 못 할 짓이다(실사용 지적).
 *
 * 그래서 **드래그를 얹고 화살표를 남긴다.** PC 는 끌고, 폰은 화살표.
 * HTML5 drag & drop 은 터치에서 원래 안 되므로 폰에서는 이 훅이 조용히 논다 —
 * 두 조작이 같은 저장(전체 순서 쓰기)으로 떨어지므로 서로 충돌하지 않는다.
 *
 * ## 쓰는 법
 *
 *   const drag = useDragOrder(currentKeys, (next) => save(next));
 *   <button {...drag.props(key)} className={drag.cls(key)}>…</button>
 *
 * 떨어뜨린 자리 계산: 끌던 것을 빼고, **떨어뜨린 대상의 자리**에 넣는다.
 * 앞에서 뒤로 끌면 대상 뒤에, 뒤에서 앞으로 끌면 대상 앞에 — 눈에 보이는
 * 「그 자리에 놓았다」와 일치한다.
 */

export interface DragOrder {
  /** 끌 요소에 스프레드. disabled 항목엔 안 붙이면 된다 */
  props(key: string): {
    draggable: true;
    onDragStart: (e: React.DragEvent) => void;
    onDragOver: (e: React.DragEvent) => void;
    onDragLeave: () => void;
    onDrop: (e: React.DragEvent) => void;
    onDragEnd: () => void;
  };
  /** 상태 클래스 — 끌리는 중이면 drag-src, 놓일 자리면 drag-over */
  cls(key: string): string;
  dragging: string | null;
}

export function useDragOrder(
  current: string[],
  commit: (next: string[]) => void,
): DragOrder {
  /*
   * 끌던 키는 ref 로 — dragover 는 초당 수십 번 오는데 그때마다 상태를 바꾸면
   * 표 전체가 다시 그려진다. 화면용 상태(dragging/over)는 시작·이동·끝에만 바뀐다.
   */
  const src = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);

  const drop = (target: string) => {
    const from = src.current;
    src.current = null;
    setDragging(null);
    setOver(null);
    if (!from || from === target) return;
    const fromIdx = current.indexOf(from);
    const toIdx = current.indexOf(target);
    if (fromIdx < 0 || toIdx < 0) return;
    const next = current.filter((k) => k !== from);
    // 「그 자리에 놓았다」 — 앞→뒤는 대상 뒤에, 뒤→앞은 대상 앞에
    const at = next.indexOf(target) + (fromIdx < toIdx ? 1 : 0);
    next.splice(at, 0, from);
    commit(next);
  };

  return {
    props: (key: string) => ({
      draggable: true as const,
      onDragStart: (e: React.DragEvent) => {
        src.current = key;
        setDragging(key);
        e.dataTransfer.effectAllowed = "move";
        // 파이어폭스는 데이터가 없으면 드래그를 아예 시작 안 한다
        e.dataTransfer.setData("text/plain", key);
      },
      onDragOver: (e: React.DragEvent) => {
        if (!src.current) return;
        e.preventDefault(); // 이게 없으면 drop 이 안 온다
        e.dataTransfer.dropEffect = "move";
        if (over !== key) setOver(key);
      },
      onDragLeave: () => {
        if (over === key) setOver(null);
      },
      onDrop: (e: React.DragEvent) => {
        e.preventDefault();
        e.stopPropagation();
        drop(key);
      },
      onDragEnd: () => {
        src.current = null;
        setDragging(null);
        setOver(null);
      },
    }),
    cls: (key: string) =>
      key === dragging ? " drag-src" : key === over ? " drag-over" : "",
    dragging,
  };
}
