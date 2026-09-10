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
  const fmt = (n: number) => `${n > 0 ? "+" : ""}${(n / 1000).toFixed(n >= 100000 || n <= -100000 ? 0 : 1)}천`;
  const cls = (n: number) => (n > 0 ? "positive" : n < 0 ? "negative" : "");
  return (
    <div className="ie-box">
      <div className="ie-head">
        <b>장중 외인·기관 추정</b>
        <span className="pt-n">한투 잠정치 · 주 · {last.time} 기준</span>
      </div>
      <div className="ie-grid">
        <span className="ie-k" />
        {rows.map((r) => (
          <span className="ie-t" key={r.time}>
            {r.time}
          </span>
        ))}
        <span className="ie-k">외국인</span>
        {rows.map((r) => (
          <span className={`ie-v ${cls(r.fgn)}`} key={`f${r.time}`}>
            {fmt(r.fgn)}
          </span>
        ))}
        <span className="ie-k">기관</span>
        {rows.map((r) => (
          <span className={`ie-v ${cls(r.orgn)}`} key={`o${r.time}`}>
            {fmt(r.orgn)}
          </span>
        ))}
        <span className="ie-k">합</span>
        {rows.map((r) => (
          <span className={`ie-v ie-sum ${cls(r.sum)}`} key={`s${r.time}`}>
            {fmt(r.sum)}
          </span>
        ))}
      </div>
    </div>
  );
}
