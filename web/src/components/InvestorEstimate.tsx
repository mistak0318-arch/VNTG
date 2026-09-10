import { useEffect, useState } from "react";
import { api, type InvestorEstimateRow } from "../api";

/**
 * 장중 외인·기관 **추정** 순매수 (한투 `HHPTJ04160200`, 2026-09-10).
 *
 * 하루 다섯 번(09:30·10:00·11:20·13:20·14:30) 나오는 잠정치. 장 마감 뒤 확정 수급보다 몇 시간
 * 먼저 「오늘 외국인이 사고 있나 팔고 있나」를 말한다. 값이 없으면(장전·장후·주말) 아무것도
 * 안 그린다 — 빈 상자를 종목 상세에 하나 더 두지 않는다.
 */
export function InvestorEstimate({ code }: { code: string }) {
  const [rows, setRows] = useState<InvestorEstimateRow[]>([]);
  useEffect(() => {
    let alive = true;
    setRows([]);
    const load = () =>
      api
        .investorEstimate(code)
        .then((r) => alive && setRows(r.rows ?? []))
        .catch(() => undefined);
    void load();
    const t = setInterval(() => void load(), 5 * 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [code]);
  if (rows.length === 0) return null;
  const last = rows[rows.length - 1];
  /* 만 주 — 「-48.0천」보다 「-4.8만」이 한국 눈에 익다. 10만 위는 소수 없이 */
  const fmt = (n: number) => {
    const m = n / 10000;
    return `${n > 0 ? "+" : ""}${Math.abs(m) >= 10 ? Math.round(m).toLocaleString("ko-KR") : m.toFixed(1)}만`;
  };
  const cls = (n: number) => (n > 0 ? "positive" : n < 0 ? "negative" : "");
  /*
   * 시각을 **줄**로 (2026-09-10 — 벤티지: "표가 옆으로 밀리네"). 시각을 열로 두면 다섯 번째 집계부터
   * 폰 폭을 넘었다. 줄로 세우면 다섯 줄 × 네 칸이라 어느 폭에서든 들어간다. 마지막 줄이 지금.
   */
  return (
    <div className="ie-box">
      <div className="ie-head">
        <b>장중 외인·기관 추정</b>
        <span className="pt-n">한투 잠정치 · 만 주 · {last.time} 기준</span>
      </div>
      <table className="ie-t">
        <thead>
          <tr>
            <th>시각</th>
            <th>외국인</th>
            <th>기관</th>
            <th>합</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.time} className={r === last ? "ie-last" : ""}>
              <td className="ie-k">{r.time}</td>
              <td className={`num ${cls(r.fgn)}`}>{fmt(r.fgn)}</td>
              <td className={`num ${cls(r.orgn)}`}>{fmt(r.orgn)}</td>
              <td className={`num ie-sum ${cls(r.sum)}`}>{fmt(r.sum)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
