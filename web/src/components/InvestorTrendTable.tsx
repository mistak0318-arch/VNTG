import { useState } from "react";
import { fmtAbsNum, fmtNum, signClass, type RawRecord } from "../api";

const PERIOD_OPTIONS = [5, 10, 20, 30];

// ka10060(종목별투자자기관별차트요청) 공식 문서 기준 확인된 필드명. 단위: 백만원(amt_qty_tp=1)
const COLUMNS: { key: string; label: string }[] = [
  { key: "ind_invsr", label: "개인" },
  { key: "frgnr_invsr", label: "외국인" },
  { key: "orgn", label: "기관계" },
  { key: "fnnc_invt", label: "금융투자" },
  { key: "insrnc", label: "보험" },
  { key: "invtrt", label: "투신" },
  { key: "etc_fnnc", label: "기타금융" },
  { key: "bank", label: "은행" },
  { key: "penfnd_etc", label: "연기금등" },
  { key: "samo_fund", label: "사모펀드" },
  { key: "natn", label: "국가" },
  { key: "etc_corp", label: "기타법인" },
  { key: "natfor", label: "내외국인" },
];

function fmtDt(dt: string): string {
  if (!/^\d{8}$/.test(dt)) return dt || "-";
  return `${dt.slice(2, 4)}/${dt.slice(4, 6)}/${dt.slice(6, 8)}`;
}

/**
 * 그날 등락률. 응답의 flu_rt는 TR마다 배율이 달라서(예: 5.54%가 "554"로 오기도 함)
 * 현재가와 전일대비로 직접 계산한다. 전일종가 = |현재가| - 전일대비.
 */
function changeRate(row: RawRecord): number | null {
  const cur = Math.abs(Number(row.cur_prc));
  const diff = Number(row.pred_pre);
  if (!Number.isFinite(cur) || !Number.isFinite(diff)) return null;
  const base = cur - diff;
  if (base <= 0) return null;
  return (diff / base) * 100;
}

export function InvestorTrendTable({ rows }: { rows: RawRecord[] }) {
  const [period, setPeriod] = useState(20);
  const visible = rows.slice(0, period);

  if (rows.length === 0) {
    return <div className="empty">투자자별 매매동향 데이터 없음</div>;
  }

  const totals: Record<string, number> = {};
  for (const col of COLUMNS) {
    totals[col.key] = visible.reduce((sum, r) => sum + (Number(r[col.key]) || 0), 0);
  }

  return (
    <div>
      <div className="table-toolbar">
        <label htmlFor="investor-period">합계 기간</label>
        <select
          id="investor-period"
          value={period}
          onChange={(e) => setPeriod(Number(e.target.value))}
        >
          {PERIOD_OPTIONS.map((p) => (
            <option key={p} value={p}>
              {p}일
            </option>
          ))}
        </select>
      </div>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="sticky-col">일자</th>
              <th>등락률</th>
              <th>종가</th>
              {COLUMNS.map((c) => (
                <th key={c.key}>{c.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="totals-row">
              <td className="sticky-col">최근 {visible.length}일 합계</td>
              <td>-</td>
              <td>-</td>
              {COLUMNS.map((c) => (
                <td key={c.key} className={signClass(totals[c.key])}>
                  {fmtNum(totals[c.key])}
                </td>
              ))}
            </tr>
            {visible.map((r, i) => {
              const rate = changeRate(r);
              return (
              <tr key={i}>
                <td className="sticky-col">{fmtDt(String(r.dt ?? ""))}</td>
                <td className={signClass(rate)}>
                  {rate === null ? "-" : `${rate > 0 ? "+" : ""}${rate.toFixed(2)}%`}
                </td>
                <td className={signClass(r.pred_pre)}>{fmtAbsNum(r.cur_prc)}</td>
                {COLUMNS.map((c) => (
                  <td key={c.key} className={signClass(r[c.key])}>
                    {fmtNum(r[c.key])}
                  </td>
                ))}
              </tr>
              );
            })}
          </tbody>
        </table>
        <div className="table-note">단위: 백만원 · 순매수(+, 빨강) · 순매도(-, 파랑)</div>
      </div>
    </div>
  );
}
