import { useEffect, useState } from "react";
import { api, type EtfFlowGroup, type EtfFlowRow } from "../api";

/**
 * **국내 ETF 자금흐름** (2026-09-17 — ETF 분석 묶음). 해외판(ETF 자금흐름(해외))과 같은 모양의 국내판.
 * 지수·테마·미국(국내상장)·자산 대표 ETF 30여 개 — 1·5·20일 등락과 **거래대금 배수**(최근 5일 ÷ 그 앞 20일).
 * 대표는 서버가 이름 규칙으로 그때그때 고른다(코드 박아 두지 않음). 행을 누르면 그 ETF 상세.
 */
function pct(v: number | null): string {
  return v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
function cls(v: number | null): string {
  return v === null || v === 0 ? "" : v > 0 ? "up" : "down";
}
function eok(v: number | null): string {
  return v === null ? "-" : `${v.toLocaleString("ko-KR")}억`;
}

export function EtfFlowPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [rows, setRows] = useState<EtfFlowRow[] | null>(null);
  const [note, setNote] = useState("");
  const [asOf, setAsOf] = useState<"오늘" | "어제">("오늘");
  const [error, setError] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<"d1" | "d5" | "d20" | "volRatio">("d1");

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .etfFlow()
        .then((r) => {
          if (!alive) return;
          setRows(r.rows);
          setNote(r.note);
          setAsOf(r.asOf);
        })
        .catch((e: Error) => alive && setError(e.message));
    void pull();
    const t = window.setInterval(pull, 5 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (error) return <div className="page-note">ETF 자금흐름을 못 받았습니다 — {error}</div>;
  if (!rows) return <div className="page-note">불러오는 중… (처음엔 없는 일봉을 몇 개 받느라 10초쯤)</div>;

  const groups: EtfFlowGroup[] = ["지수", "테마·업종", "미국(국내상장)", "자산·채권"];
  const sorted = (g: EtfFlowGroup) => rows.filter((r) => r.group === g).sort((a, b) => (b[sortKey] ?? -999) - (a[sortKey] ?? -999));
  /* 한 줄 요약 — 배수가 제일 큰 테마와 20일 최고 */
  const hot = [...rows].filter((r) => r.volRatio !== null && r.group === "테마·업종").sort((a, b) => (b.volRatio ?? 0) - (a.volRatio ?? 0))[0];
  const best20 = [...rows].filter((r) => r.d20 !== null && r.group === "테마·업종").sort((a, b) => (b.d20 ?? 0) - (a.d20 ?? 0))[0];

  return (
    <div className="page">
      <p className="page-note">
        <b>돈이 어느 테마로 가나</b> — 대표 ETF 의 등락과 거래대금 배수(최근 5일 ÷ 그 앞 20일). 배수 <b>1.5 이상</b>이면 돈이 몰리는 중.
        {hot && best20 && (
          <>
            {" "}
            지금 돈이 제일 몰린 테마 <b>{hot.label}</b>({hot.volRatio?.toFixed(2)}배) · 20일 최고 <b>{best20.label}</b>({pct(best20.d20)})
          </>
        )}
      </p>
      <div className="ov-seg" style={{ padding: 0, marginBottom: 8, maxWidth: 360 }}>
        {(["d1", "d5", "d20", "volRatio"] as const).map((k) => (
          <button key={k} type="button" className={sortKey === k ? "on" : ""} onClick={() => setSortKey(k)}>
            {k === "d1" ? (asOf === "오늘" ? "1일" : "어제") : k === "d5" ? "5일" : k === "d20" ? "20일" : "거래대금 배수"}
          </button>
        ))}
      </div>
      {groups.map((g) => (
        <section className="card" key={g}>
          <h3>{g}</h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">대표</th>
                  <th>ETF</th>
                  <th>가격</th>
                  <th>{asOf === "오늘" ? "1일" : "어제"}</th>
                  <th>5일</th>
                  <th>20일</th>
                  <th title="최근 5일 평균 거래대금 ÷ 그 앞 20일 평균 (어제까지)">배수</th>
                  <th>5일 평균</th>
                  <th>오늘</th>
                </tr>
              </thead>
              <tbody>
                {sorted(g).map((r) => (
                  <tr key={r.code} className="clickable-row" onClick={() => onSelectStock(r.code, r.name)}>
                    <td className="sticky-col">
                      <b>{r.label}</b>
                    </td>
                    <td>
                      {r.name} <span className="pt-n">{r.code}</span>
                    </td>
                    <td className="num">{r.price.toLocaleString("ko-KR")}</td>
                    <td className={`num ${cls(r.d1)}`}>{pct(r.d1)}</td>
                    <td className={`num ${cls(r.d5)}`}>{pct(r.d5)}</td>
                    <td className={`num ${cls(r.d20)}`}>{pct(r.d20)}</td>
                    <td className={`num ${r.volRatio !== null && r.volRatio >= 1.5 ? "up" : ""}`}>{r.volRatio === null ? "-" : `${r.volRatio.toFixed(2)}배`}</td>
                    <td className="num">{eok(r.value5)}</td>
                    <td className="num">{eok(r.todayValue)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <div className="table-note">{note}</div>
    </div>
  );
}
