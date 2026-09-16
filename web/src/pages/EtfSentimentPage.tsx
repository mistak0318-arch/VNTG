import { useEffect, useState } from "react";
import { api, type EtfSentimentSide } from "../api";

/**
 * **레버리지·인버스 심리** (2026-09-17 — ETF 분석 묶음). 개인이 방향에 거는 돈의 비율.
 * 인버스(+곱버스) 거래대금 ÷ 레버리지 거래대금, 20일. 비율이 평균을 크게 넘으면 하락 베팅이 몰린 것 —
 * 역발상 재료. 반대로 레버리지만 뜨거우면 상승 추격 과열. 신호등 점수에는 안 들어간다.
 */
function fmtDay(d: string): string {
  return `${d.slice(4, 6)}/${d.slice(6, 8)}`;
}
function eok(v: number): string {
  return `${v.toLocaleString("ko-KR")}억`;
}

function Side({ s }: { s: EtfSentimentSide }) {
  const all = [...s.days, ...(s.today ? [s.today] : [])];
  const maxV = Math.max(1, ...all.map((d) => Math.max(d.lev, d.inv)));
  const cur = s.today ?? s.days[s.days.length - 1];
  const verdict = (() => {
    if (!cur || cur.ratio === null || s.avg20 === null) return null;
    const x = cur.ratio / s.avg20;
    if (x >= 1.4) return { t: "하락 베팅 과열 — 인버스 돈이 평소의 " + x.toFixed(1) + "배. 역발상으로 볼 자리", c: "up" };
    if (x <= 0.65) return { t: "상승 추격 과열 — 레버리지 쪽으로 쏠림(비율이 평소의 " + x.toFixed(1) + "배). 추격은 조심", c: "down" };
    return { t: "평소 범위 — 방향 베팅이 한쪽으로 쏠리지 않음", c: "" };
  })();
  return (
    <section className="card">
      <h3>
        {s.market} <span className="usm-sub">{s.names.lev} vs {s.names.inv.join(" + ")}</span>
      </h3>
      {cur && (
        <div className="ets-now">
          <div>
            <span className="pt-n">{s.today ? "오늘(어림)" : `마지막 ${fmtDay(cur.d)}`}</span>
            <b className="ets-big">{cur.ratio === null ? "-" : cur.ratio.toFixed(2)}</b>
            <span className="pt-n">20일 평균 {s.avg20 === null ? "-" : s.avg20.toFixed(2)}</span>
          </div>
          {verdict && <div className={`ets-verdict ${verdict.c}`}>{verdict.t}</div>}
        </div>
      )}
      <div className="ets-bars">
        {all.map((d) => (
          <div key={d.d} className={`ets-day${d === s.today ? " today" : ""}`} title={`${fmtDay(d.d)} 레버리지 ${eok(d.lev)} · 인버스 ${eok(d.inv)} · 비율 ${d.ratio ?? "-"}`}>
            <div className="ets-col">
              <i className="lev" style={{ height: `${Math.round((d.lev / maxV) * 100)}%` }} />
              <i className="inv" style={{ height: `${Math.round((d.inv / maxV) * 100)}%` }} />
            </div>
            <em className={s.avg20 !== null && d.ratio !== null && d.ratio >= s.avg20 * 1.4 ? "up" : ""}>{d.ratio === null ? "-" : d.ratio.toFixed(2)}</em>
            <span>{fmtDay(d.d)}</span>
          </div>
        ))}
      </div>
      <div className="ets-legend">
        <i className="lev" /> 레버리지 거래대금 <i className="inv" /> 인버스(+곱버스) 거래대금 · 숫자는 인버스 ÷ 레버리지
      </div>
    </section>
  );
}

export function EtfSentimentPage() {
  const [sides, setSides] = useState<EtfSentimentSide[] | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .etfSentiment()
        .then((r) => {
          if (!alive) return;
          setSides(r.sides);
          setNote(r.note);
        })
        .catch((e: Error) => alive && setError(e.message));
    void pull();
    const t = window.setInterval(pull, 5 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (error) return <div className="page-note">못 받았습니다 — {error}</div>;
  if (!sides) return <div className="page-note">불러오는 중…</div>;

  return (
    <div className="page">
      <p className="page-note">
        <b>개인이 방향에 거는 돈</b> — 인버스·곱버스 거래대금을 레버리지 거래대금으로 나눈 값. 비율이 20일 평균의 <b>1.4배</b>를 넘으면
        하락 베팅 과열(역발상 재료), <b>0.65배</b> 아래면 상승 추격 과열.
      </p>
      {sides.length === 0 && <div className="empty">레버리지·인버스 ETF 를 전체시세에서 못 찾았습니다.</div>}
      {sides.map((s) => (
        <Side key={s.market} s={s} />
      ))}
      <div className="table-note">{note}</div>
    </div>
  );
}
