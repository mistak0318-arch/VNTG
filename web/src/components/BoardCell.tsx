import { useEffect, useRef, useState } from "react";

/**
 * 보드의 칸 하나 — **사람이 크기를 정한다.**
 *
 * ## 왜 브라우저 기본 손잡이를 쓰나
 *
 * `resize: both` 한 줄이면 오른쪽 아래에 손잡이가 생기고, 끄는 동안의 처리는
 * 브라우저가 다 한다. 직접 만들면 포인터 캡처·경계값·터치까지 전부 우리 몫인데,
 * 그렇게 만들어도 결과는 **똑같다.** 사람들이 이미 아는 손잡이이기도 하다.
 *
 * ## 크기를 왜 재서 내려주나
 *
 * 표는 칸이 커지면 알아서 늘어나지만 **차트는 캔버스라 그렇지 않다.**
 * 칸만 키우면 그림은 그대로 있고 여백만 생긴다. 그래서 칸이 자기 크기를 재서
 * 안쪽에 알려 준다 — 받는 쪽은 그 숫자로 다시 그리기만 하면 된다.
 *
 * ## 재는 방법을 둘로 둔다
 *
 * `ResizeObserver` 가 맞는 도구지만, 이 프로젝트에서는 **그리지 않는 창에서 굶는** 걸
 * 이미 겪었다(차트가 까맣게 남았던 그 건). 그래서 타이머로도 같은 값을 확인한다.
 * 크기가 그대로면 `setState` 가 아무 일도 하지 않으므로 가만히 있을 때 비용은 없다.
 *
 * ## 저장은 기기마다
 *
 * 「이 칸을 얼마나 크게 볼지」는 **모니터 사정**이다. 27인치와 노트북이 같을 수 없으니
 * 서버에 두면 한쪽에 맞춘 크기가 다른 쪽을 망친다. localStorage 에 남긴다.
 */

export interface CellSize {
  w: number;
  h: number;
}

/** 머리글(제목 줄)이 먹는 높이. 안쪽에 알려 줄 높이에서 빼야 한다 */
const HEAD_PX = 34;
const MIN_W = 240;
const MIN_H = 160;

export function BoardCell({
  title,
  sub,
  size,
  onSize,
  wide,
  pinned,
  onPin,
  onDragStart,
  dragging,
  cellKey,
  children,
}: {
  title: string;
  /** 제목 옆에 작게 — 지금 보고 있는 종목 */
  sub?: string;
  size: CellSize | null;
  onSize: (s: CellSize) => void;
  wide?: boolean;
  /**
   * 고정된 칸.
   *
   * 다 맞춰 놓고 나면 그다음부터는 **건드리는 게 사고**다 — 표를 훑다가 모서리를
   * 스쳐서 크기가 바뀌거나, 제목을 짚었다가 칸이 딸려 나온다.
   * 고정하면 크기 조절과 옮기기가 둘 다 멈춘다.
   */
  pinned?: boolean;
  onPin: () => void;
  onDragStart: (e: React.PointerEvent) => void;
  dragging?: boolean;
  cellKey: string;
  /** 안쪽 높이와 「크기 바뀜」 신호를 받아 그린다 */
  children: (inner: { height: number; tick: number }) => React.ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const [box, setBox] = useState<CellSize>(size ?? { w: 0, h: wide ? 420 : 300 });
  /** 크기가 바뀔 때마다 오른다 — 가로만 바뀐 경우를 안쪽에 알리는 유일한 방법 */
  const [tick, setTick] = useState(0);
  const last = useRef<CellSize>({ w: 0, h: 0 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    /*
     * ⚠️ **`offsetWidth` 로 잰다. `clientWidth` 를 쓰면 칸이 저절로 줄어든다.**
     *
     * 이 앱은 `box-sizing: border-box` 라 `width` 로 넣는 값에 테두리가 포함된다.
     * 그런데 `clientWidth` 는 **테두리를 뺀** 값이다. 그래서 재서(698 → 696)
     * 저장하고 그걸 다시 `width` 로 넣으면 실제 폭이 696 이 되고, 다음에 재면 694 가
     * 나온다 — 250ms 마다 **2px 씩 영원히 쪼그라든다.** 크기를 늘렸는데 혼자
     * 줄어들던 게 이것이다.
     *
     * `offsetWidth/offsetHeight` 는 테두리를 포함하므로 넣은 값과 잰 값이 같다.
     */
    const check = () => {
      const w = Math.round(el.offsetWidth);
      const h = Math.round(el.offsetHeight);
      if (w === last.current.w && h === last.current.h) return;
      last.current = { w, h };
      // 안쪽에 알려 줄 높이는 테두리·안여백을 뺀 실제 자리다
      setBox({ w, h: el.clientHeight });
      setTick((n) => n + 1);
    };

    /*
     * 저장은 **사람이 끌어서 바꾼 것만** 한다.
     *
     * ⚠️ 여기서 한 번 데였다. 처음엔 재는 족족 저장했는데, 그러면 **레이아웃이 잠깐
     * 어긋난 순간의 크기까지 남는다.** 실제로 기본 높이를 안 준 판이 있었고, 칸이
     * 내용만큼 5천 px 까지 자란 상태가 그대로 저장돼서 고친 뒤에도 그 크기로 되살아났다.
     * 저장된 값은 CSS 를 이기므로, 한 번 잘못 들어가면 코드를 고쳐도 안 없어진다.
     *
     * 가려내는 방법은 간단하다 — 사람이 모서리를 끌면 브라우저가 요소에 **인라인
     * 크기**를 직접 써넣는다. 그게 비어 있으면 CSS 가 정한 크기이지 사람이 정한 게 아니다.
     * (한 번 저장된 뒤에는 React 가 인라인으로 넣으므로 계속 차 있고, 그다음 끌기도 잡힌다)
     *
     * 끄는 동안 크기는 수십 번 바뀐다. 그때마다 쓰면 localStorage 를 두들기게 되니
     * 손이 멈추고 나서 한 번 쓴다.
     */
    let save: ReturnType<typeof setTimeout> | null = null;
    const queueSave = () => {
      if (!el.style.width && !el.style.height) return;
      if (save) clearTimeout(save);
      save = setTimeout(() => {
        if (last.current.w > 0) onSize({ ...last.current });
      }, 400);
    };

    const ro =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            check();
            queueSave();
          });
    ro?.observe(el);

    // 그리지 않는 창에서는 위가 굶는다 — 타이머로도 같은 값을 본다
    const t = setInterval(() => {
      const before = last.current;
      check();
      if (before.w !== last.current.w || before.h !== last.current.h) queueSave();
    }, 250);

    check();
    return () => {
      ro?.disconnect();
      clearInterval(t);
      if (save) clearTimeout(save);
    };
  }, [onSize]);

  return (
    <section
      ref={ref}
      data-cell={cellKey}
      className={`card board-cell${wide ? " wide" : ""}${pinned ? " pinned" : ""}${dragging ? " dragging" : ""}`}
      style={{
        width: size?.w ? `${size.w}px` : undefined,
        height: size?.h ? `${size.h}px` : undefined,
        minWidth: MIN_W,
        minHeight: MIN_H,
      }}
    >
      <h2 className="board-cell-h">
        {/*
          손잡이를 **따로 둔다.** 제목 아무 데나 끌리게 하면 글자를 긁어 복사하려다
          칸이 딸려 나온다. 고정된 칸에는 손잡이가 아예 없다 — 못 옮긴다는 걸
          「눌러도 반응이 없다」가 아니라 **눈으로** 알려 주는 편이 낫다.
        */}
        {!pinned && (
          <span className="board-grip" onPointerDown={onDragStart} title="끌어서 자리 바꾸기">
            ⠿
          </span>
        )}
        <span className="board-cell-t">{title}</span>
        {/*
          **칸마다 종목명을 적는다.**
          맨 위에 한 번만 적어 두면 아래로 내려갈수록 무엇을 보고 있는지 잊는다 —
          칸을 여럿 띄우고 종목만 바꿔 가며 보는 화면이라 특히 그렇다.
        */}
        {sub && <span className="board-cell-sub">{sub}</span>}
        <button
          className={`board-pin${pinned ? " on" : ""}`}
          onClick={onPin}
          title={pinned ? "고정 풀기" : "이 자리에 고정"}
        >
          {pinned ? "📌" : "📍"}
        </button>
      </h2>
      <div className="board-cell-b">
        {children({ height: Math.max(120, box.h - HEAD_PX), tick })}
      </div>
    </section>
  );
}
