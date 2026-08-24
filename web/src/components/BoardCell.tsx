import { useEffect, useRef, useState } from "react";
import { api } from "../api";

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
  locked,
  onToggleLock,
  onDuplicate,
  onPopOut,
  onPickStock,
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
  /**
   * 이 칸이 붙들고 있는 종목.
   *
   * 없으면 **연동을 따라간다**(다른 창에서 고른 종목). 있으면 그 종목에 머문다 —
   * HTS 로 치면 한 창에서 삼성전자를 파면서 옆 창은 하이닉스를 띄워 두는 것이다.
   * 보드가 종목 하나만 보던 구조로는 그게 안 됐다.
   */
  locked?: { code: string; name: string } | null;
  onToggleLock?: () => void;
  /**
   * 이 칸을 하나 더 — **같은 칸을 두 번 띄운다.**
   *
   * 차트를 둘 놓고 하나는 일봉, 하나는 3분봉으로 보는 건 HTS 에서 늘 하던 일인데
   * 칸 목록이 블록 키였을 땐 그게 안 됐다. 복제한 칸은 크기·고정·종목이 **따로** 논다.
   */
  onDuplicate?: () => void;
  /** 이 칸만 새 창으로 — 모니터를 여러 대 쓸 때 */
  onPopOut?: () => void;
  /**
   * 이 칸만 다른 종목으로.
   *
   * 연동을 끄고 보면 칸마다 다른 종목을 봐야 하는데, 그러려면 **여기서 찾을 수 있어야**
   * 한다. 지금까지는 연동으로 흘러온 종목을 붙드는 것만 됐다 — 처음부터 다른 종목을
   * 띄우려면 다른 창에서 그 종목을 한 번 눌러야 했다.
   */
  onPickStock?: (code: string, name: string) => void;
  /** 안쪽 높이와 「크기 바뀜」 신호를 받아 그린다 */
  children: (inner: { height: number; tick: number }) => React.ReactNode;
}) {
  /** 종목 찾기 칸이 열려 있나 */
  const [finding, setFinding] = useState(false);
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
        {/*
          연동을 따를지, 이 종목에 머물지.
          자물쇠가 잠겨 있으면 다른 창에서 뭘 눌러도 이 칸은 안 바뀐다.
        */}
        {onToggleLock && (
          <button
            className={`board-lock${locked ? " on" : ""}`}
            onClick={onToggleLock}
            title={locked ? `${locked.name} 에 고정됨 — 눌러서 연동으로` : "이 종목에 고정하기"}
          >
            {locked ? "🔒" : "🔗"}
          </button>
        )}
        {/* 이 칸만 다른 종목으로 — 연동을 끄고 볼 때 쓴다 */}
        {onPickStock && (
          <button
            className={`board-find${finding ? " on" : ""}`}
            onClick={() => setFinding((v) => !v)}
            title="이 칸에 띄울 종목 찾기"
          >
            🔍
          </button>
        )}
        {onDuplicate && (
          <button className="board-dup" onClick={onDuplicate} title="이 칸을 하나 더">
            ⧉
          </button>
        )}
        {/*
          ⧉ 는 **복제**(이 화면에 칸 하나 더)이고 ⇱ 는 **새 창**이다. 둘은 다른 일이라
          아이콘을 따로 둔다 — 하나로 합치면 어느 쪽이 될지 눌러 봐야 안다.
        */}
        {onPopOut && (
          <button className="board-pop" onClick={onPopOut} title="이 칸만 새 창으로">
            ⇱
          </button>
        )}
        <button
          className={`board-pin${pinned ? " on" : ""}`}
          onClick={onPin}
          title={pinned ? "고정 풀기" : "이 자리에 고정"}
        >
          {pinned ? "📌" : "📍"}
        </button>
      </h2>
      {finding && onPickStock && (
        <CellStockFinder
          onPick={(c, n) => {
            onPickStock(c, n);
            setFinding(false);
          }}
          onClose={() => setFinding(false)}
        />
      )}
      <div className="board-cell-b">
        {children({ height: Math.max(120, box.h - HEAD_PX), tick })}
      </div>
    </section>
  );
}

/**
 * 칸 하나에 띄울 종목 찾기.
 *
 * 보드는 원래 **다른 창에서 고른 종목을 따라 그리는** 화면이라 검색이 없었다.
 * 그런데 연동을 끄고 칸마다 다른 종목을 보려면 여기서 찾을 수 있어야 한다 —
 * 지금까지는 다른 창에서 그 종목을 한 번 눌러야만 이 칸에 붙들 수 있었다.
 *
 * 찾은 종목은 **그 칸에 붙든다**(자물쇠가 잠긴다). 연동을 따라가게 하려면 자물쇠를 푼다.
 */
export function CellStockFinder({
  onPick,
  onClose,
}: {
  onPick: (code: string, name: string) => void;
  onClose: () => void;
}) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<{ code: string; name: string }[]>([]);

  /*
   * 고르면 **입력과 결과를 비운다.**
   *
   * 칸 안에서는 고르는 순간 검색창이 닫히니 몰랐는데, 보드 설정처럼 **늘 떠 있는
   * 자리**에서는 고른 뒤에도 목록이 그대로 남아 화면을 덮었다. 고른 것은 위에 이미
   * 「지금 SK하이닉스」로 적히므로 목록이 남을 이유가 없다.
   */
  const pick = (code: string, name: string) => {
    setQ("");
    setHits([]);
    onPick(code, name);
  };

  useEffect(() => {
    const text = q.trim();
    if (text.length < 1) {
      setHits([]);
      return;
    }
    let alive = true;
    // 글자를 칠 때마다 부르지 않는다
    const t = setTimeout(() => {
      void api
        .searchStocks(text)
        .then((r) => alive && setHits(r.results.slice(0, 8)))
        .catch(() => alive && setHits([]));
    }, 250);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q]);

  return (
    <div className="board-find-box">
      <input
        className="search-input"
        autoFocus
        placeholder="종목명 또는 코드"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Enter" && hits[0]) pick(hits[0].code, hits[0].name);
        }}
      />
      {hits.length > 0 && (
        <div className="board-find-hits">
          {hits.map((h) => (
            <button key={h.code} className="board-find-hit" onClick={() => pick(h.code, h.name)}>
              <b>{h.name}</b>
              <span className="pt-n">{h.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
