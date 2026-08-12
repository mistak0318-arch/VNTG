import type { ReactNode } from "react";
import { fmtNum, type RawRecord } from "../api";
import { SortableTh, useSortableTable } from "../useSortableTable";

/**
 * 일자별/시간별 시계열 표 공용 컴포넌트.
 * 프로그램매매·신용·체결강도·일별거래상세가 모두 "첫 칸이 날짜, 나머지는 숫자" 형태라
 * 컬럼 정의만 바꿔서 재사용한다. 정렬(3단계)도 여기서 한 번만 붙인다.
 */

export interface SeriesColumn {
  key: string;
  label: string;
  /** 정렬용 값 */
  get: (row: RawRecord) => number | string;
  /** 화면 표시 (없으면 get 결과를 천단위 콤마로) */
  render?: (row: RawRecord) => ReactNode;
  /** 값의 부호에 따라 빨강/파랑 */
  sign?: boolean;
  sticky?: boolean;
}

/** "+1,234" / "--5" 처럼 부호가 섞여 오는 키움 숫자를 안전하게 변환 */
export function num(v: unknown): number {
  const s = String(v ?? "").replace(/,/g, "");
  // 키움은 음수를 "--123"으로 주는 경우가 있다
  const normalized = s.startsWith("--") ? s.slice(1) : s;
  const n = Number(normalized);
  return Number.isFinite(n) ? n : 0;
}

export function signOf(v: number): string {
  if (v > 0) return "positive";
  if (v < 0) return "negative";
  return "";
}

/** YYYYMMDD → MM/DD */
export function fmtDt(v: unknown): string {
  const s = String(v ?? "");
  return /^\d{8}$/.test(s) ? `${s.slice(4, 6)}/${s.slice(6, 8)}` : s;
}

/** HHMMSS → HH:MM */
export function fmtTm(v: unknown): string {
  const s = String(v ?? "").padStart(6, "0");
  return /^\d{6}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2, 4)}` : String(v ?? "");
}

export function SeriesTable({
  rows,
  columns,
  note,
  empty = "데이터가 없습니다.",
}: {
  rows: RawRecord[];
  columns: SeriesColumn[];
  note?: ReactNode;
  empty?: string;
}) {
  const sort = useSortableTable<RawRecord>(rows);

  if (rows.length === 0) return <div className="empty">{empty}</div>;

  return (
    <div className="data-table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            {columns.map((c) => (
              <SortableTh<RawRecord>
                key={c.key}
                columnKey={c.key}
                label={c.label}
                accessor={c.get}
                sort={sort}
                className={c.sticky ? "sticky-col" : undefined}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {sort.sorted.map((row, i) => (
            <tr key={`${String(row.dt ?? row.cntr_tm ?? i)}-${i}`}>
              {columns.map((c) => {
                const raw = c.get(row);
                const cls = c.sign && typeof raw === "number" ? signOf(raw) : "";
                return (
                  <td key={c.key} className={`${cls}${c.sticky ? " sticky-col" : ""}`}>
                    {c.render ? c.render(row) : typeof raw === "number" ? fmtNum(raw) : raw}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {note && <div className="table-note">{note}</div>}
    </div>
  );
}
