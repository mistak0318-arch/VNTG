import { useEffect, useState } from "react";
import { api, fmtNum, type BreadthPoint, type ChannelReport } from "../api";
import { BreadthPanel } from "../components/BreadthPanel";
import { SectorFlowPanel } from "../components/SectorFlowPanel";
import { UsKrPanel } from "../components/UsKrPanel";
import { TradePanel } from "../components/TradePanel";
import { RefreshBar } from "../components/RefreshBar";

/**
 * 시장 흐름 분석.
 *
 * 다른 화면들은 "지금 뭐가 오르는가"를 본다. 여기는 **돈이 어디서 어디로 옮겨가는가**를 본다.
 * 그래서 전부 누적 기반이고, 하루치만으로는 아무 말도 할 수 없다.
 *
 * 두 축으로 나눴다.
 *   자금 흐름 — 숫자로 확인되는 것 (투자자별 누적 순매수, 시장 폭)
 *   미국↔국내 — 밤사이 미국이 어느 국내 테마로 이어지는가
 *   수출 동향 — 실물 지표
 *
 * 채널 정리는 「텔레그램 동향」 대메뉴로 옮겼다 — 그건 숫자가 아니라 독립된 정보원이다.
 */

type FlowTab = "money" | "usKr" | "trade";

const TABS: { key: FlowTab; label: string }[] = [
  { key: "money", label: "자금 흐름" },
  { key: "usKr", label: "미국↔국내" },
  { key: "trade", label: "수출 동향" },
];

/** 누적 순매수 3주체를 한 차트에 겹쳐 그린다 */
function CumulativeFlowChart({ points }: { points: BreadthPoint[] }) {
  const W = 640;
  const H = 150;
  if (points.length < 2) return null;

  const series = [
    { key: "foreignCum", label: "외국인", color: "var(--blue)" },
    { key: "instCum", label: "기관", color: "var(--green)" },
    { key: "individualCum", label: "개인", color: "#f5c542" },
  ] as const;

  const all = series.flatMap((s) => points.map((p) => p[s.key]));
  const min = Math.min(...all, 0);
  const max = Math.max(...all, 0);
  const span = max - min || 1;
  const pad = H * 0.1;
  const y = (v: number) => H - pad - ((v - min) / span) * (H - pad * 2);
  const x = (i: number) => (i / (points.length - 1)) * W;

  return (
    <div className="flow-chart">
      <div className="flow-legend">
        {series.map((s) => (
          <span key={s.key} className="flow-legend-item">
            <span className="flow-swatch" style={{ background: s.color }} />
            {s.label}{" "}
            <b style={{ color: s.color }}>{fmtNum(points[points.length - 1][s.key])}</b>
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="flow-svg">
        <line x1={0} y1={y(0)} x2={W} y2={y(0)} className="breadth-zero" />
        {series.map((s) => (
          <path
            key={s.key}
            d={points
              .map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}`)
              .join(" ")}
            fill="none"
            stroke={s.color}
            strokeWidth={1.8}
          />
        ))}
      </svg>
      <div className="flow-axis">
        <span>{points[0].date.slice(5)}</span>
        <span>{points[points.length - 1].date.slice(5)}</span>
      </div>
    </div>
  );
}

function MoneyFlowTab({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [points, setPoints] = useState<BreadthPoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  function load() {
    setLoading(true);
    api
      .breadth(120)
      .then((r) => setPoints(r.points))
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(load, []);

  if (loading) return <div className="empty">불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;

  const last = points[points.length - 1];

  return (
    <>
      <h3 className="section-heading">투자자별 누적 순매수</h3>
      {points.length < 2 ? (
        <div className="page-note">
          아직 <b>{points.length}일치</b>만 쌓였습니다. 누적 순매수는 며칠이 모여야 방향이 보입니다.
          이 데이터는 키움 API가 과거분을 주지 않아 <b>소급이 불가능</b>하므로, 서버가 켜져 있는
          동안 하루씩만 쌓입니다.
        </div>
      ) : (
        <>
          <CumulativeFlowChart points={points} />
          <div className="table-note">
            선이 <b>우상향</b>이면 그 주체가 계속 사들이는 중입니다. 방향이 꺾이는 지점이 자금
            흐름의 변곡점입니다. 외국인과 기관이 같이 사는데 개인만 파는 구간은 대체로 상승,
            반대는 하락 국면에서 자주 나타납니다.
          </div>
        </>
      )}

      {last && (
        <>
          <h3 className="section-heading">최근 순매수 (당일)</h3>
          <div className="data-table-wrap">
            <table className="data-table num">
              <thead>
                <tr>
                  <th className="sticky-col">일자</th>
                  <th>외국인</th>
                  <th>기관</th>
                  <th>개인</th>
                  <th>상승비율</th>
                  <th>신고−신저</th>
                </tr>
              </thead>
              <tbody>
                {[...points].reverse().slice(0, 20).map((p) => (
                  <tr key={p.date}>
                    <td className="sticky-col">{p.date.slice(5)}</td>
                    <td className={p.foreign > 0 ? "positive" : "negative"}>{fmtNum(p.foreign)}</td>
                    <td className={p.institution > 0 ? "positive" : "negative"}>
                      {fmtNum(p.institution)}
                    </td>
                    <td className={p.individual > 0 ? "positive" : "negative"}>
                      {fmtNum(p.individual)}
                    </td>
                    <td>{p.risingPct.toFixed(0)}%</td>
                    <td className={p.highLowDiff > 0 ? "positive" : "negative"}>
                      {p.highLowDiff > 0 ? "+" : ""}
                      {p.highLowDiff}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <h3 className="section-heading">업종별 자금 흐름</h3>
      <SectorFlowPanel onSelectStock={onSelectStock} />

      <h3 className="section-heading">시장 폭</h3>
      <BreadthPanel />
    </>
  );
}

export function MarketFlowPage({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [tab, setTab] = useState<FlowTab>("money");
  const [reloadKey, setReloadKey] = useState(0);

  return (
    <div>
      <RefreshBar onRefresh={() => setReloadKey((k) => k + 1)} />

      <nav className="detail-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`detail-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div key={`${tab}-${reloadKey}`}>
        {tab === "money" && <MoneyFlowTab onSelectStock={onSelectStock} />}
        {tab === "usKr" && <UsKrPanel />}
        {tab === "trade" && <TradePanel onSelectStock={onSelectStock} />}
      </div>
    </div>
  );
}
