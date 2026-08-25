import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";

/**
 * 표 칸 너비를 **내가 정한다** — 공통 모듈.
 *
 * ## 왜 필요했나
 *
 * 시세분석·거래상위처럼 열이 열댓 개인 표에서, 보고 싶은 값이 **화면 밖에** 있는 일이
 * 잦다. 종목명 칸이 넓게 잡혀 있으면 회전율·시가총액이 오른쪽으로 밀려 가로로 한참
 * 스크롤해야 한다. 그런데 **어느 칸이 중요한지는 사람마다, 그날 무엇을 보느냐마다 다르다** —
 * 코드가 정해 줄 수 있는 값이 아니다.
 *
 * ## 조작
 *
 * 머리 칸 오른쪽 가장자리를 **끌면** 폭이 바뀐다. 손잡이는 평소엔 안 보이고,
 * 마우스를 올리면 나타난다 — 늘 보이면 표가 지저분해지고 잘못 잡기도 쉽다.
 *
 * ⚠️ **정렬과 싸우지 않게** 한다. 머리 칸을 누르면 정렬이 걸리는 표가 많은데, 손잡이는
 * `stopPropagation` 으로 그 클릭을 막는다. 안 막으면 폭을 줄일 때마다 정렬이 뒤집힌다.
 *
 * ## 어디에 저장하나
 *
 * **서버다**(`/api/settings/columns`). 카드 배치·탭 순서와 같은 층이다 —
 * 「이 표에서 무엇을 넓게 보나」는 그 사람이 표를 읽는 방식이라 기기가 바뀌어도 따라와야 한다.
 * (글자 크기·테마는 반대로 기기마다 달라야 맞아서 로컬이다)
 *
 * ## 쓰는 법
 *
 * ```tsx
 * const cw = useColumnWidths("rank.trade-value");
 * ...
 * <table>
 *   <colgroup>{cols.map((c) => <col key={c.key} style={cw.styleOf(c.key)} />)}</colgroup>
 *   <thead><tr>{cols.map((c) => <th key={c.key}>{c.label}<ColumnGrip cw={cw} k={c.key} /></th>)}</tr></thead>
 * ```
 */

export interface ColumnWidthsApi {
  /** `<col>` 에 넘길 스타일 — 정한 적 없으면 빈 객체(기본 너비) */
  styleOf: (key: string) => { width?: string };
  /** 끌기 시작 */
  begin: (key: string, startX: number, startWidth: number) => void;
  /** 이 칸만 원래대로 — 손잡이 두 번 누르기 */
  clear: (key: string) => void;
  /** 하나라도 정한 적이 있나 — 「원래대로」를 보여줄지 정한다 */
  customized: boolean;
  reset: () => void;
}

export function useColumnWidths(scope: string): ColumnWidthsApi {
  const [all, setAll] = useState<Record<string, Record<string, number>>>({});
  const [mine, setMine] = useState<Record<string, number>>({});
  const drag = useRef<{ key: string; x: number; w: number } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .columnWidths()
      .then((o) => {
        if (!alive) return;
        setAll(o);
        setMine(o[scope] ?? {});
      })
      .catch(() => {
        /* 못 읽으면 기본 너비 — 표가 사라지진 않는다 */
      });
    return () => {
      alive = false;
    };
  }, [scope]);

  /*
   * 끄는 동안에는 **저장하지 않는다.** 1px 마다 서버로 보내면 한 번 끌 때 수백 번이다.
   * 손을 떼는 순간 한 번만 올린다.
   */
  const write = useCallback(
    (next: Record<string, number>, persist: boolean) => {
      setMine(next);
      if (!persist) return;
      const merged = { ...all, [scope]: next };
      setAll(merged);
      void api.columnWidthsSave(merged).catch(() => {
        /* 서버에 못 올려도 이번 화면에는 적용돼 있다 */
      });
    },
    [all, scope],
  );

  const begin = useCallback(
    (key: string, startX: number, startWidth: number) => {
      drag.current = { key, x: startX, w: startWidth };
      /*
       * ⚠️ **시작하는 순간 현재 폭을 박아 넣는다** (2026-08-25, 아이디어노트 4).
       *
       * 「드래그해도 안 바뀐다」는 말이 나왔다. 원인: `table-layout: fixed` 는
       * `customized`(정한 폭이 하나라도 있나)일 때만 붙는데, **처음 끄는 순간에는
       * 아직 아무 폭도 없어서** auto 레이아웃이 `<col>` 폭을 참고만 하고 무시했다 —
       * 손은 움직이는데 표가 그대로였다.
       *
       * 시작할 때 지금 폭을 그대로 넣으면 그 즉시 fixed 로 넘어가고,
       * 첫 픽셀부터 손을 따라온다.
       */
      setMine((prev) => (prev[key] ? prev : { ...prev, [key]: Math.round(startWidth) }));

      const move = (e: PointerEvent) => {
        const d = drag.current;
        if (!d) return;
        // 서버와 같은 한계 — 40 보다 좁으면 글자가 한 자도 안 들어간다
        const w = Math.min(600, Math.max(40, Math.round(d.w + (e.clientX - d.x))));
        setMine((prev) => ({ ...prev, [d.key]: w }));
      };
      const up = () => {
        const d = drag.current;
        drag.current = null;
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        document.body.classList.remove("col-resizing");
        if (!d) return;
        // 마지막 값만 올린다
        setMine((prev) => {
          write(prev, true);
          return prev;
        });
      };

      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      /* 끄는 동안 글자가 선택되면 표가 파랗게 물든다 */
      document.body.classList.add("col-resizing");
    },
    [write],
  );

  const reset = useCallback(() => {
    setMine({});
    const merged = { ...all };
    delete merged[scope];
    setAll(merged);
    void api.columnWidthsSave(merged).catch(() => undefined);
  }, [all, scope]);

  const clear = useCallback(
    (key: string) => {
      setMine((prev) => {
        const next = { ...prev };
        delete next[key];
        write(next, true);
        return next;
      });
    },
    [write],
  );

  return {
    styleOf: (key: string) => (mine[key] ? { width: `${mine[key]}px` } : {}),
    begin,
    clear,
    customized: Object.keys(mine).length > 0,
    reset,
  };
}

/**
 * 머리 칸 오른쪽 가장자리의 손잡이.
 *
 * `<th>` 안에 넣는다 — `position: relative` 인 `<th>` 기준으로 오른쪽 끝에 붙는다.
 * 두 번 누르면 그 칸만 원래대로 돌아간다(한 칸만 잘못 끌었을 때 전부 되돌릴 이유는 없다).
 */
export function ColumnGrip({ cw, k }: { cw: ColumnWidthsApi; k: string }) {
  return (
    <span
      className="col-grip"
      role="separator"
      aria-label="칸 너비 조절"
      title="끌어서 칸 너비 조절"
      onPointerDown={(e) => {
        // 머리 칸을 누르면 정렬이 걸리는 표가 많다 — 손잡이는 그 클릭을 막는다
        e.preventDefault();
        e.stopPropagation();
        /*
         * ⚠️ **포인터를 붙잡는다** (2026-08-25, 아이디어노트 4).
         *
         * 폰에서 드래그가 안 됐다. 표가 가로 스크롤 컨테이너(`data-table-wrap`) 안에
         * 있어서, 손가락을 끌면 **브라우저가 그 제스처를 스크롤로 가져가** pointermove 가
         * 우리한테 안 왔다. `touch-action: none` 만으로는 부족했다 — capture 를 걸어야
         * 이후의 move/up 이 손잡이로 온다.
         *
         * ⚠️ try/catch 다 — `?.` 가 아니라. capture 는 **실패할 수 있는 호출**이고
         * (활성 포인터가 아니면 NotFoundError 를 던진다), 여기서 던지면 아래
         * `begin()` 이 통째로 안 돌아 「드래그가 안 된다」가 됐다. capture 는
         * 스크롤 방지용 보강일 뿐이라, 실패해도 드래그 자체는 시작해야 한다.
         */
        try {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        } catch {
          /* capture 실패 — 데스크톱 마우스는 capture 없이도 잘 끌린다 */
        }
        const th = (e.target as HTMLElement).closest("th");
        cw.begin(k, e.clientX, th?.getBoundingClientRect().width ?? 100);
      }}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        e.stopPropagation();
        cw.clear(k);
      }}
    />
  );
}
