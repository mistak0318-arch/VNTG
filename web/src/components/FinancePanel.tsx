import { useEffect, useState } from "react";
import {
  api,
  fmtNum,
  signClass,
  type FinancialPeriod,
  type FinanceResult,
  type EstimateResult,
  type QuarterRow,
} from "../api";

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

/**
 * 한 줄 진단 (2026-08-25) — **표를 읽기 전에 결론부터.**
 *
 * 「영업이익이 좋아지고 있다, 전년 동기 대비 +34%」 — 이 한 문장이 아래 표
 * 전체의 요약이다. 재료는 **최근 분기**가 먼저다(연간은 8월에도 작년 숫자라
 * 「지금 벌고 있나」에 답을 못 한다). 분기가 없으면 연간으로, 그마저 없으면
 * 아무 말도 안 한다 — 없는 판단을 지어내지 않는다.
 *
 * YoY 로 잰다 — 반도체·조선처럼 계절 타는 업종은 QoQ 가 매년 같은 자리에서
 * 꺾여 보인다. YoY 가 없을 때만 QoQ 로 말하되 그렇다고 적는다.
 */
function verdictOf(
  quarters: QuarterRow[],
  periods: FinancialPeriod[],
): { tone: "up" | "down" | "flat" | "loss"; head: string; sub: string } | null {
  /* 894,924억은 못 읽는다 — 조로 끊는다 (엔비디아를 억원으로 적지 않는 것과 같은 규칙) */
  const eokFmt = (v: number) =>
    Math.abs(v) >= 10_000 ? `${(v / 10_000).toFixed(1)}조` : `${fmtNum(Math.round(v))}억`;
  const qs = quarters.filter((q) => q.operatingProfit !== null);
  if (qs.length > 0) {
    const q = qs.reduce((a, b) => (a.period > b.period ? a : b));
    const op = q.operatingProfit as number;
    const amt = eokFmt(op);
    if (op < 0) {
      return {
        tone: "loss",
        head: `영업이익이 적자다 — ${q.label} ${amt}`,
        sub:
          q.qoq !== null && q.qoq > 0
            ? "직전 분기보다 적자 폭은 줄었다"
            : "최근 분기 기준 · 한국투자증권",
      };
    }
    if (q.yoy !== null) {
      const y = `${q.yoy > 0 ? "+" : ""}${q.yoy.toFixed(0)}%`;
      const qq = q.qoq === null ? "" : ` · 직전 분기 대비 ${q.qoq > 0 ? "+" : ""}${q.qoq.toFixed(0)}%`;
      if (q.yoy >= 15)
        return { tone: "up", head: `영업이익이 좋아지고 있다 — ${q.label} ${amt}, 전년 동기 대비 ${y}`, sub: `분기 기준${qq}` };
      if (q.yoy <= -15)
        return { tone: "down", head: `영업이익이 꺾이고 있다 — ${q.label} ${amt}, 전년 동기 대비 ${y}`, sub: `분기 기준${qq}` };
      return { tone: "flat", head: `영업이익이 옆걸음이다 — ${q.label} ${amt}, 전년 동기 대비 ${y}`, sub: `분기 기준${qq}` };
    }
    if (q.qoq !== null) {
      const s = `${q.qoq > 0 ? "+" : ""}${q.qoq.toFixed(0)}%`;
      return {
        tone: q.qoq >= 15 ? "up" : q.qoq <= -15 ? "down" : "flat",
        head: `최근 분기(${q.label}) 영업이익 ${amt} — 직전 분기 대비 ${s}`,
        sub: "전년 동기 비교가 없어 직전 분기와 견줬다 — 계절 타는 업종은 이 수치가 과장된다",
      };
    }
  }
  // 분기가 없으면 연간 — 낡은 값이라는 걸 밝힌다
  if (periods.length >= 2) {
    const cur = toEok(periods[periods.length - 1].operatingProfit);
    const prev = toEok(periods[periods.length - 2].operatingProfit);
    if (cur !== null && prev !== null && prev !== 0) {
      const g = ((cur - prev) / Math.abs(prev)) * 100;
      const y = `${g > 0 ? "+" : ""}${g.toFixed(0)}%`;
      const label = periods[periods.length - 1].label;
      if (cur < 0)
        return { tone: "loss", head: `연간 영업이익이 적자다 — ${label} ${eokFmt(cur)}`, sub: "분기 데이터가 없어 연간(DART)으로 — 최신이 아닐 수 있다" };
      return {
        tone: g >= 15 ? "up" : g <= -15 ? "down" : "flat",
        head: `${label} 영업이익 ${eokFmt(cur)} — 전년 대비 ${y}`,
        sub: "분기 데이터가 없어 연간(DART)으로 — 최신이 아닐 수 있다",
      };
    }
  }
  return null;
}

function FinVerdict({ quarters, periods }: { quarters: QuarterRow[]; periods: FinancialPeriod[] }) {
  const v = verdictOf(quarters, periods);
  if (!v) return null;
  return (
    <div className={`fin-verdict ${v.tone}`}>
      <b className="fin-verdict-head">{v.head}</b>
      <span className="fin-verdict-sub">{v.sub}</span>
    </div>
  );
}

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

export function FinancePanel({
  code,
  afterVerdict,
}: {
  code: string;
  /** 진단 한 줄 바로 아래 끼울 것 — 기업·재무 통합 화면이 핵심 지표 칩을 넣는다 */
  afterVerdict?: React.ReactNode;
}) {
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
  // 연간이 없어도 분기가 있으면 그건 보여 준다 — 요즘 벌고 있나가 더 급한 정보다
  if (
    (data.note || data.periods.length === 0) &&
    (data.quarters ?? []).length === 0 &&
    !data.estimate
  ) {
    return <div className="page-note">{data.note ?? "재무 데이터가 없습니다."}</div>;
  }

  const quarters = data.quarters ?? [];
  const periods = data.periods;
  if (periods.length === 0) {
    return (
      <div>
        <FinVerdict quarters={quarters} periods={periods} />
        {afterVerdict}
        <EstimateTable est={data.estimate} />
        <QuarterTable quarters={quarters} />
      </div>
    );
  }
  const latest = periods[periods.length - 1];
  const prev = periods[periods.length - 2] ?? null;
  const d = data.dividend;

  return (
    <div>
      {/* 결론부터 — 표는 그 근거다 */}
      <FinVerdict quarters={quarters} periods={periods} />
      {afterVerdict}
      {/*
        분기를 **연간보다 먼저** 둔다. DART 사업보고서는 8월에도 마지막 줄이 작년이라
        "지금 벌고 있나"에 답을 못 한다. 판단에 쓰이는 건 최근 분기다.
      */}
      {/*
        추정을 **맨 위**에 둔다. 지나간 실적보다 앞으로가 먼저다 —
        1분기 숫자를 8월에 보고 있으면 이미 늦다.
      */}
      <EstimateTable est={data.estimate} />
      <QuarterTable quarters={quarters} />

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

/**
 * 분기 손익.
 *
 * 한투가 주는 값은 **연단위 누적**이라 서버에서 직전 분기를 빼 단일 분기로 되돌린다.
 * 되돌리지 않으면 실적이 반토막 난 회사도 매 분기 우상향하는 그래프가 된다.
 *
 * 단위가 **억원**이다 — 위 연간 표(DART, 원 단위)와 다르니 섞어 읽으면 안 된다.
 */
function QuarterTable({ quarters }: { quarters: QuarterRow[] }) {
  if (quarters.length === 0) return null;
  const max = Math.max(...quarters.map((q) => Math.abs(q.operatingProfit ?? 0)), 1);

  return (
    <section className="card">
      <h2>분기 실적 (최근 {quarters.length}분기)</h2>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>분기</th>
              <th>매출</th>
              <th>영업이익</th>
              <th title="영업이익 ÷ 매출">이익률</th>
              <th title="직전 분기 대비 영업이익">QoQ</th>
              <th title="1년 전 같은 분기 대비 영업이익 — 계절성이 있는 업종은 이쪽을 봐야 한다">YoY</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {quarters.map((q) => (
              <tr key={q.period}>
                <td>{q.label}</td>
                <td className="num">{q.revenue === null ? "-" : fmtNum(Math.round(q.revenue))}</td>
                <td className={`num ${signClass(q.operatingProfit ?? 0)}`}>
                  {q.operatingProfit === null ? "-" : fmtNum(Math.round(q.operatingProfit))}
                </td>
                <td className="num">{q.margin === null ? "-" : `${q.margin.toFixed(1)}%`}</td>
                <td className={`num ${q.qoq === null ? "" : signClass(q.qoq)}`}>
                  {q.qoq === null ? "-" : `${q.qoq > 0 ? "+" : ""}${q.qoq.toFixed(0)}%`}
                </td>
                <td className={`num ${q.yoy === null ? "" : signClass(q.yoy)}`}>
                  {q.yoy === null ? "-" : `${q.yoy > 0 ? "+" : ""}${q.yoy.toFixed(0)}%`}
                </td>
                {/* 막대는 눈으로 훑기 위한 것 — 숫자를 세 줄 읽는 것보다 빠르다 */}
                <td className="qf-bar-cell">
                  <span className="qf-bar">
                    <span
                      className={`qf-fill ${(q.operatingProfit ?? 0) < 0 ? "neg" : ""}`}
                      style={{ width: `${(Math.abs(q.operatingProfit ?? 0) / max) * 100}%` }}
                    />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-note">
        단위 <b>억원</b> · 한국투자증권. 한투는 분기를 <b>연초부터 누적</b>해서 주므로
        직전 분기를 빼 <b>그 분기만의 값</b>으로 되돌렸습니다 — 되돌리지 않으면 실적이 꺾인
        회사도 매 분기 오르는 그래프가 됩니다.
      </div>
    </section>
  );
}

/**
 * 애널리스트 추정 실적.
 *
 * **지나간 실적보다 이게 먼저다.** 실적은 이미 주가에 들어가 있고, 사람들이 사고파는 건
 * 앞으로의 숫자다. `2026.12E` 처럼 **E** 가 붙은 열이 추정이다.
 *
 * 160여 개 대형주만 있다(한투 리서치가 다루는 범위). 없으면 아무것도 그리지 않는다 —
 * 「추정 없음」을 띄우면 화면만 시끄럽고 알려 주는 게 없다.
 */
function EstimateTable({ est }: { est: EstimateResult | null }) {
  if (!est || est.columns.length === 0) return null;

  const rows: { label: string; get: (c: EstimateResult["columns"][number]) => string; cls?: (c: EstimateResult["columns"][number]) => string }[] = [
    { label: "매출", get: (c) => (c.revenue === null ? "-" : fmtNum(Math.round(c.revenue))) },
    {
      label: "매출 증감",
      get: (c) => (c.revenueGrowth === null ? "-" : `${c.revenueGrowth > 0 ? "+" : ""}${c.revenueGrowth.toFixed(1)}%`),
      cls: (c) => (c.revenueGrowth === null ? "" : signClass(c.revenueGrowth)),
    },
    { label: "영업이익", get: (c) => (c.operatingProfit === null ? "-" : fmtNum(Math.round(c.operatingProfit))) },
    {
      label: "영익 증감",
      get: (c) => (c.operatingGrowth === null ? "-" : `${c.operatingGrowth > 0 ? "+" : ""}${c.operatingGrowth.toFixed(1)}%`),
      cls: (c) => (c.operatingGrowth === null ? "" : signClass(c.operatingGrowth)),
    },
    { label: "ROE", get: (c) => (c.roe === null ? "-" : `${c.roe.toFixed(1)}%`) },
    { label: "부채비율", get: (c) => (c.debtRatio === null ? "-" : `${c.debtRatio.toFixed(1)}%`) },
    { label: "PER", get: (c) => (c.per === null ? "-" : `${c.per.toFixed(1)}배`) },
  ];

  return (
    <section className="card">
      <h2>
        실적 추정 {est.opinion && <span className="est-op">애널리스트 의견 {est.opinion}</span>}
      </h2>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th></th>
              {est.columns.map((c) => (
                /* E 가 붙은 열은 추정이다. 확정 실적과 섞여 보이면 안 된다 */
                <th key={c.period} className={/E$/.test(c.period) ? "est-col" : ""}>
                  {c.period}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <td>{r.label}</td>
                {est.columns.map((c) => (
                  <td
                    key={c.period}
                    className={`num ${r.cls?.(c) ?? ""} ${/E$/.test(c.period) ? "est-col" : ""}`}
                  >
                    {r.get(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-note">
        단위 <b>억원</b> · 한국투자증권 리서치. <b>E</b> 가 붙은 열이 추정입니다.
        {est.estimatedAt && ` 추정 기준 ${est.estimatedAt.slice(0, 4)}-${est.estimatedAt.slice(4, 6)}-${est.estimatedAt.slice(6, 8)}.`}{" "}
        추정은 <b>당월 초 기준</b>이라 이달 나온 소식은 아직 안 들어가 있을 수 있고,
        리서치가 다루는 <b>160여 개 종목</b>에만 있습니다.
      </div>
    </section>
  );
}
