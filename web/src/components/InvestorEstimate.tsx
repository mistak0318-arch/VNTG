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
   * 시각을 **줄**로 (2026-09-10 — 벤티지: "표가 옆으로 밀리네"). 그리고 **줄은 구간별 증감, 맨 아래가 합계**
   * (같은 날 저녁 — "저 밑에 합계를 표시해줘야 오늘 하루 외국인·기관이 팔아냈는지 알 수 있겠지? 외국인+기관
   * 합계는 중요해 보이진 않아. 각각의 주체별 합계가 중요한 거지"). 한투 값은 그 시각까지의 **누적**이라
   * 그대로 더하면 두 번 세는 셈이다 — 앞 줄과의 차이를 줄에 적고, 마지막 누적을 합계로 둔다.
   */
  const deltas = rows.map((r, i) => ({
    time: r.time,
    fgn: i === 0 ? r.fgn : r.fgn - rows[i - 1].fgn,
    orgn: i === 0 ? r.orgn : r.orgn - rows[i - 1].orgn,
  }));
  return (
    <div className="ie-box">
      <div className="ie-head">
        <b>장중 외인·기관 추정</b>
        <span className="pt-n">한투 잠정치 · 만 주 · 구간별 · {last.time} 기준</span>
      </div>
      <table className="ie-t">
        <thead>
          <tr>
            <th>구간</th>
            <th>외국인</th>
            <th>기관</th>
          </tr>
        </thead>
        <tbody>
          {deltas.map((d, i) => (
            <tr key={d.time}>
              <td className="ie-k">{i === 0 ? `~${d.time}` : `${deltas[i - 1].time}~${d.time}`}</td>
              <td className={`num ${cls(d.fgn)}`}>{fmt(d.fgn)}</td>
              <td className={`num ${cls(d.orgn)}`}>{fmt(d.orgn)}</td>
            </tr>
          ))}
          <tr className="ie-last">
            <td className="ie-k">합계 (누적)</td>
            <td className={`num ie-sum ${cls(last.fgn)}`}>{fmt(last.fgn)}</td>
            <td className={`num ie-sum ${cls(last.orgn)}`}>{fmt(last.orgn)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
