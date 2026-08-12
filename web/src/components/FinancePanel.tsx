import { useEffect, useState } from "react";
import { api, fmtNum, signClass, type FinancialPeriod, type FinanceResult } from "../api";

/** 원 단위 금액을 억원으로 */
function toEok(v: number | null): number | null {
  return v === null ? null : Math.round(v / 100_000_000);
}

function fmtEok(v: number | null): string {
  const e = toEok(v);
  return e === null ? "-" : fmtNum(e);
}

/** 전기 대비 증감률 */
function growth(cur: number | null, prev: number | null): number | null {
  if (cur === null || prev === null || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}

type Metric = "revenue" | "operatingProfit" | "netIncome";

const METRICS: { key: Metric; label: string; color: string }[] = [
  { key: "revenue", label: "매출액", color: "#4c8dff" },
  { key: "operatingProfit", label: "영업이익", color: "#f5c542" },
  { key: "netIncome", label: "당기순이익", color: "#4ade80" },
];

/**
 * 연도별 막대그래프. 값이 음수(적자)일 수도 있어 0을 기준선으로 잡고
 * 위/아래로 그린다.
 */
function BarChart({ periods, metric }: { periods: FinancialPeriod[]; metric: Metric }) {
  const meta = METRICS.find((m) => m.key === metric)!;
  const values = periods.map((p) => toEok(p[metric]) ?? 0);
  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  // 0선의 세로 위치 (위에서부터의 비율)
  const zeroRatio = max / span;

  return (
    <div className="fin-chart">
      <div className="fin-bars" style={{ ["--zero" as string]: `${zeroRatio * 100}%` }}>
        {periods.map((p, i) => {
          const v = values[i];
          const heightPct = (Math.abs(v) / span) * 100;
          const positive = v >= 0;
          return (
            <div className="fin-bar-col" key={p.label}>
              <div className="fin-bar-area">
                <div
                  className="fin-bar"
                  style={{
                    height: `${heightPct}%`,
                    background: positive ? meta.color : "var(--blue)",
                    ...(positive
                      ? { bottom: `${(1 - zeroRatio) * 100}%` }
                      : { top: `${zeroRatio * 100}%` }),
                  }}
                />
                <span className={`fin-bar-val ${v < 0 ? "negative" : ""}`} style={{ bottom: positive ? `calc(${(1 - zeroRatio) * 100}% + ${heightPct}%)` : undefined, top: positive ? undefined : `calc(${zeroRatio * 100}% + ${heightPct}%)` }}>
                  {fmtNum(v)}
                </span>
              </div>
              <div className="fin-bar-label">{p.label}</div>
            </div>
          );
        })}
      </div>
      <div className="table-note">단위: 억원 · {meta.label}</div>
    </div>
  );
}

export function FinancePanel({ code }: { code: string }) {
  const [data, setData] = useState<FinanceResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [metric, setMetric] = useState<Metric>("operatingProfit");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .finance(code)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (loading) return <div className="empty">재무 정보 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;
  if (data.note || data.periods.length === 0) {
    return <div className="page-note">{data.note ?? "재무 데이터가 없습니다."}</div>;
  }

  const periods = data.periods;
  const latest = periods[periods.length - 1];
  const prev = periods[periods.length - 2] ?? null;
  const d = data.dividend;

  return (
    <div>
      <section className="card">
        <h2>
          최근 실적 ({latest.label}) · {data.basis}기준
        </h2>
        <div className="summary-grid">
          {METRICS.map((m) => {
            const g = prev ? growth(latest[m.key], prev[m.key]) : null;
            return (
              <div className="summary-item" key={m.key}>
                <div className="label">{m.label}</div>
                <div className="value">{fmtEok(latest[m.key])}억</div>
                {g !== null && (
                  <div className={`fin-growth ${signClass(g)}`}>
                    전년 대비 {g > 0 ? "+" : ""}
                    {g.toFixed(1)}%
                  </div>
                )}
              </div>
            );
          })}
          {d?.yieldRate !== null && d?.yieldRate !== undefined && (
            <div className="summary-item">
              <div className="label">배당수익률</div>
              <div className="value">{d.yieldRate.toFixed(2)}%</div>
              {d.perShare !== null && <div className="fin-growth">주당 {fmtNum(d.perShare)}원</div>}
            </div>
          )}
        </div>
      </section>

      <div className="filter-row">
        {METRICS.map((m) => (
          <button
            key={m.key}
            className={`filter-btn ${metric === m.key ? "active" : ""}`}
            onClick={() => setMetric(m.key)}
          >
            {m.label}
          </button>
        ))}
      </div>

      <BarChart periods={periods} metric={metric} />

      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="sticky-col">항목 (억원)</th>
              {periods.map((p) => (
                <th key={p.label}>{p.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { label: "매출액", key: "revenue" as const },
              { label: "영업이익", key: "operatingProfit" as const },
              { label: "당기순이익", key: "netIncome" as const },
              { label: "자산총계", key: "assets" as const },
              { label: "부채총계", key: "liabilities" as const },
              { label: "자본총계", key: "equity" as const },
            ].map((row) => (
              <tr key={row.key}>
                <td className="sticky-col">{row.label}</td>
                {periods.map((p) => (
                  <td key={p.label} className={signClass(p[row.key])}>
                    {fmtEok(p[row.key])}
                  </td>
                ))}
              </tr>
            ))}
            {periods.some((p) => p.revenue && p.operatingProfit) && (
              <tr>
                <td className="sticky-col">영업이익률(%)</td>
                {periods.map((p) => (
                  <td key={p.label}>
                    {p.revenue && p.operatingProfit
                      ? ((p.operatingProfit / p.revenue) * 100).toFixed(1)
                      : "-"}
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
        <div className="table-note">
          출처: 금융감독원 DART 사업보고서 ({data.basis}재무제표)
          {d?.payoutRatio ? ` · 배당성향 ${d.payoutRatio}%` : ""}
          {d?.eps ? ` · EPS ${fmtNum(d.eps)}원` : ""}
        </div>
      </div>
    </div>
  );
}
