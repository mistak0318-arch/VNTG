import { useEffect, useState } from "react";
import { api, type UsEtfRow } from "../api";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";

/**
 * **ETF 자금흐름(해외)** (2026-09-17). 「돈이 어느 섹터로 가나」를 지수·섹터·채권/금/달러 ETF 스물로 본다.
 * 등락률 셋(1·5·20일)과 **거래대금 배수**(최근 5일 평균 ÷ 그 앞 20일) — 배수가 1.5 를 넘으면 돈이 몰리는 중.
 * 야후 차트라 키 소모가 없다. 5분 캐시.
 */
function pct(v: number | null): string {
  return v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
function cls(v: number | null): string {
  return v === null || v === 0 ? "" : v > 0 ? "up" : "down";
}
function usd(v: number | null): string {
  if (v === null) return "-";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  return `$${Math.round(v).toLocaleString("en-US")}`;
}

export function UsEtfFlowPage() {
  const [rows, setRows] = useState<UsEtfRow[] | null>(null);
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const [sortKey, setSortKey] = useState<"d1" | "d5" | "d20" | "volRatio">("d1");

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .usEtfFlow()
        .then((r) => {
          if (!alive) return;
          setRows(r.rows);
          setStale(r.stale);
        })
        .catch((e: Error) => alive && setError(e.message));
    void pull();
    const t = window.setInterval(pull, 5 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  if (error) return <div className="page-note">야후에서 ETF 를 못 받았습니다 — {error}</div>;
  if (!rows) return <div className="page-note">불러오는 중…</div>;

  const groups: UsEtfRow["group"][] = ["지수", "섹터", "채권·금·달러"];
  const sorted = (g: UsEtfRow["group"]) => rows.filter((r) => r.group === g).sort((a, b) => (b[sortKey] ?? -999) - (a[sortKey] ?? -999));

  return (
    <div className="page">
      <p className="page-note">
        <b>돈이 어느 쪽으로 가나</b> — 섹터 ETF 의 등락과 거래대금 배수(최근 5일 ÷ 그 앞 20일). 배수가 <b>1.5 이상</b>이면 돈이
        몰리는 중, 등락은 플러스인데 배수가 낮으면 조용히 오르는 것. {stale && <b>· 새로 못 받아 옛 값</b>}
      </p>
      <div className="ov-seg" style={{ padding: 0, marginBottom: 8, maxWidth: 360 }}>
        {(["d1", "d5", "d20", "volRatio"] as const).map((k) => (
          <button key={k} type="button" className={sortKey === k ? "on" : ""} onClick={() => setSortKey(k)}>
            {k === "d1" ? "1일" : k === "d5" ? "5일" : k === "d20" ? "20일" : "거래대금 배수"}
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
                  <th className="sticky-col">ETF</th>
                  <th>가격</th>
                  <th>1일</th>
                  <th>5일</th>
                  <th>20일</th>
                  <th title="최근 5일 평균 거래대금 ÷ 그 앞 20일 평균">거래대금 배수</th>
                  <th>5일 평균 거래대금</th>
                </tr>
              </thead>
              <tbody>
                {sorted(g).map((r) => (
                  <tr key={r.symbol} className="clickable-row" onClick={() => setChart({ kind: "yahoo", symbol: r.symbol, label: `${r.name} (${r.symbol})`, digits: 2 })}>
                    <td className="sticky-col">
                      {r.name} <span className="pt-n">{r.symbol}</span>
                    </td>
                    <td className="num">{r.price === null ? "-" : r.price.toFixed(2)}</td>
                    <td className={`num ${cls(r.d1)}`}>{pct(r.d1)}</td>
                    <td className={`num ${cls(r.d5)}`}>{pct(r.d5)}</td>
                    <td className={`num ${cls(r.d20)}`}>{pct(r.d20)}</td>
                    <td className={`num ${r.volRatio !== null && r.volRatio >= 1.5 ? "up" : ""}`}>{r.volRatio === null ? "-" : `${r.volRatio.toFixed(2)}배`}</td>
                    <td className="num">{usd(r.dollar5)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      <div className="table-note">
        섹터 ETF 는 S&P 500 을 열한 섹터로 가른 SPDR(XL…) + 반도체(SMH). 국내 「어젯밤 미국 → 국내 테마」 카드가 이 흐름을 국내 테마로 잇습니다.
      </div>
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
