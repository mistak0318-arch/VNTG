import { useEffect, useState } from "react";

/**
 * 목록을 **쪽으로 나눠 보는** 공통 도구.
 *
 * ## 왜 공통인가
 *
 * 시세분석 안에도 목록이 여럿이다 — 거래대금 상위, 누적등락률, 동일 순매매, 연속매매…
 * 그런데 쪽 넘기기를 거래대금 상위에만 넣어 뒀더니, **같은 자리에서 탭만 바꿨는데 어떤
 * 탭은 되고 어떤 탭은 안 되는** 화면이 됐다. 화면마다 다르게 동작하면 그때마다 다시
 * 배워야 한다.
 *
 * 훅과 줄을 같이 둔다. 부르는 쪽은 두 줄이면 된다 —
 *
 * ```
 * const pager = usePager(sorted.length, "vntg.cum.pageSize");
 * ...
 * {pager.slice(sorted).map(...)}
 * <Pager pager={pager} total={sorted.length} />
 * ```
 */

export interface PagerState {
  size: number;
  setSize: (n: number) => void;
  page: number;
  setPage: (n: number) => void;
  pageCount: number;
  /** 지금 쪽에 해당하는 부분만 자른다 */
  slice: <T>(rows: T[]) => T[];
  from: number;
  to: number;
}

/**
 * @param total 거르고 정렬한 **뒤**의 개수
 * @param storeKey 한 쪽 개수를 기억할 자리. 목록마다 보기 좋은 양이 달라 따로 둔다
 * @param resetKey 이 값이 바뀌면 첫 장으로 — 조회를 바꿨는데 3쪽이면 빈 화면이 뜬다
 */
export function usePager(total: number, storeKey: string, resetKey?: unknown): PagerState {
  const [size, setSizeRaw] = useState<number>(() => Number(localStorage.getItem(storeKey)) || 50);
  const [page, setPage] = useState(0);

  useEffect(() => {
    setPage(0);
  }, [resetKey, size]);

  const setSize = (n: number) => {
    setSizeRaw(n);
    try {
      localStorage.setItem(storeKey, String(n));
    } catch {
      /* 저장 못 해도 이번 세션에는 바뀐다 */
    }
  };

  const pageCount = Math.max(1, Math.ceil(total / size));
  const at = Math.min(page, pageCount - 1);

  return {
    size,
    setSize,
    page: at,
    setPage,
    pageCount,
    slice: <T,>(rows: T[]) => rows.slice(at * size, (at + 1) * size),
    from: at * size + 1,
    to: Math.min((at + 1) * size, total),
  };
}

/** 쪽 넘기는 줄. 한 쪽에 다 들어가면 앞뒤 버튼은 안 그린다 */
export function Pager({
  pager,
  total,
  sizes = [50, 100],
  unit = "위",
}: {
  pager: PagerState;
  total: number;
  sizes?: number[];
  /** 「1~50위」의 그 글자 — 순위가 아닌 목록도 있다 */
  unit?: string;
}) {
  if (total === 0) return null;
  return (
    <div className="filter-row scr-pager">
      <span className="scr-page-k">한 쪽에</span>
      {sizes.map((n) => (
        <button
          key={n}
          className={`filter-btn ${pager.size === n ? "active" : ""}`}
          onClick={() => pager.setSize(n)}
        >
          {n}
        </button>
      ))}
      {pager.pageCount > 1 && (
        <>
          <span className="news-scope-sep" />
          <button
            className="filter-btn"
            onClick={() => pager.setPage(pager.page - 1)}
            disabled={pager.page === 0}
          >
            ‹ 앞
          </button>
          <span className="breadth-count">
            {pager.page + 1} / {pager.pageCount}쪽
            <b className="pt-n">
              {" "}
              ({pager.from}~{pager.to}
              {unit})
            </b>
          </span>
          <button
            className="filter-btn"
            onClick={() => pager.setPage(pager.page + 1)}
            disabled={pager.page >= pager.pageCount - 1}
          >
            뒤 ›
          </button>
        </>
      )}
    </div>
  );
}
