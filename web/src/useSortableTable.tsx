import { useMemo, useState } from "react";

export type SortDir = "desc" | "asc" | null;

export interface SortState<T> {
  sorted: T[];
  sortKey: string | null;
  sortDir: SortDir;
  toggle: (columnKey: string, accessor: (row: T) => string | number) => void;
}

/**
 * 표 컬럼 정렬 훅.
 * 헤더를 누르면 내림차순 → 오름차순 → 원래 순서로 3단계 순환한다.
 *
 * 정렬 값은 accessor로 뽑되, 숫자면 숫자 비교, 문자열이면 한글 로케일 비교를 쓴다.
 */
export function useSortableTable<T>(rows: T[]): SortState<T> {
  const [key, setKey] = useState<string | null>(null);
  const [dir, setDir] = useState<SortDir>(null);
  // 컬럼 키 -> 정렬값 추출 함수
  const [accessors, setAccessors] = useState<Record<string, (row: T) => string | number>>({});

  function registerAccessor(columnKey: string, accessor: (row: T) => string | number) {
    setAccessors((prev) => (prev[columnKey] ? prev : { ...prev, [columnKey]: accessor }));
  }

  function toggle(columnKey: string, accessor: (row: T) => string | number) {
    registerAccessor(columnKey, accessor);
    if (key !== columnKey) {
      setKey(columnKey);
      setDir("desc");
      return;
    }
    if (dir === "desc") {
      setDir("asc");
    } else if (dir === "asc") {
      // 3번째 클릭 — 원래 순서로 복귀
      setKey(null);
      setDir(null);
    } else {
      setDir("desc");
    }
  }

  const sorted = useMemo(() => {
    if (!key || !dir) return rows;
    const accessor = accessors[key];
    if (!accessor) return rows;

    const factor = dir === "desc" ? -1 : 1;
    return [...rows].sort((a, b) => {
      const va = accessor(a);
      const vb = accessor(b);
      if (typeof va === "number" && typeof vb === "number") {
        return (va - vb) * factor;
      }
      return String(va).localeCompare(String(vb), "ko") * factor;
    });
  }, [rows, key, dir, accessors]);

  return { sorted, sortKey: key, sortDir: dir, toggle };
}

/** 정렬 가능한 표 헤더 셀 */
export function SortableTh<T>({
  columnKey,
  label,
  accessor,
  sort,
  className,
}: {
  columnKey: string;
  label: string;
  accessor: (row: T) => string | number;
  sort: SortState<T>;
  className?: string;
}) {
  const active = sort.sortKey === columnKey && sort.sortDir !== null;
  const arrow = !active ? "" : sort.sortDir === "desc" ? " ▾" : " ▴";
  return (
    <th
      className={`sortable-th${active ? " active" : ""}${className ? ` ${className}` : ""}`}
      onClick={() => sort.toggle(columnKey, accessor)}
      title="클릭: 내림차순 → 오름차순 → 원래대로"
    >
      {label}
      <span className="sort-arrow">{arrow}</span>
    </th>
  );
}
