import { useEffect, useState } from "react";
import { MarketPulsePanel } from "../components/MarketPulsePanel";
import { BriefingPage } from "./BriefingPage";
import { LeaderScanPanel } from "../components/LeaderScanPanel";
import { EventPlayPanel } from "../components/EventPlayPanel";
import { CloseBetPanel } from "../components/CloseBetPanel";
import { MarketSignalPanel } from "../components/MarketSignalPanel";
import { api, fmtNum, type BreadthPoint, type ChannelReport } from "../api";
import { BreadthPanel } from "../components/BreadthPanel";
import { RotationBoard, ThermoPanel } from "../components/MarketLensPanel";
import { SectorFlowPanel } from "../components/SectorFlowPanel";
import { UsKrPanel } from "../components/UsKrPanel";
import { TradePanel } from "../components/TradePanel";
import { RefreshBar } from "../components/RefreshBar";
import { useCardOrder } from "../useCardOrder";
import { useSwipeTabs, visualOrder } from "../useSwipeTabs";

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

type FlowTab =
  | "briefing"
  | "pulse"
  | "rotation"
  | "leaders"
  | "events"
  | "closebet"
  | "money"
  | "usKr"
  | "trade";

export const FLOW_TABS: { key: FlowTab; label: string }[] = [
  /*
   * 마켓 브리핑과 합쳤다 (2026-08-28 — 「시황분석하는 메뉴가 너무 많아」).
   * 브리핑(훑고 끝내는 결론)이 첫 탭, 나머지(파고드는 근거)가 뒤를 잇는다.
   * 메뉴 하나가 「지금 시장이 어떤가 → 왜 그런가」를 순서대로 답한다.
   */
  { key: "briefing", label: "브리핑" },
  { key: "pulse", label: "맥박" },
  /*
   * 로테이션 (2026-08-28, 테마 DB 개편) — **돈의 자리바꿈**을 본다.
   * 맥박이 「지금 어떤 장인가」면 이건 「돈이 어느 테마에서 어느 테마로 옮겨가는가」다.
   * 이 메뉴의 존재 이유("돈이 어디서 어디로")에 가장 곧게 답하는 탭이라 맥박 바로 뒤다.
   */
  { key: "rotation", label: "테마 로테이션" },
  // 맥박이 「지금 어떤 장인가」면 이건 「그래서 어디를 볼 것인가」다
  { key: "leaders", label: "주도주 탐색" },
  /*
   * 탐색기의 **형제**다.
   * 탐색기가 「지금 무엇이 강한가」면 이건 「다음에 무엇이 강해질 자리인가」다 —
   * 이미 오른 걸 훑어서는 안 나오는 것을 잡는다.
   */
  { key: "events", label: "일정 매매" },
  // 일정 매매의 형제 — 저쪽이 며칠~몇 주라면 이건 하룻밤이다
  { key: "closebet", label: "종가배팅" },
  { key: "money", label: "자금 흐름" },
  /*
   * **「미국↔국내」는 당분간 숨긴다.**
   * 지금 안 쓰는 화면이라 탭만 차지한다. 코드와 서버는 그대로 두었으니
   * 이 줄의 주석만 풀면 바로 돌아온다 — 지우면 되살리는 게 일이 된다.
   */
  // { key: "usKr", label: "미국↔국내" },
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
  /* 브리핑이 기본이다 — 이 메뉴가 홈이고, 열자마자 3초 안에 「오늘 어떤가」가 목적이다 */
  const [tab, setTab] = useState<FlowTab>("briefing");
  const [reloadKey, setReloadKey] = useState(0);
  /* 탭 순서 — 설정 > 서브탭 순서에서 바꾼다(서버 저장) */
  const tabOrder = useCardOrder(
    "marketflow.tabs",
    FLOW_TABS.map((t) => t.key),
  );
  /* 폰 — 본문을 좌우로 밀면 이웃 탭으로 (2026-08-28) */
  const swipe = useSwipeTabs({
    order: visualOrder(FLOW_TABS.map((t) => t.key), tabOrder.orderOf),
    current: tab,
    onChange: (k) => setTab(k as FlowTab),
  });

  return (
    <div {...swipe}>
      {/* 브리핑 탭은 제 새로고침 막대를 갖고 있다 — 겹쳐 그리면 두 줄이 된다 */}
      {tab !== "briefing" && <RefreshBar onRefresh={() => setReloadKey((k) => k + 1)} />}

      {/*
        신호등은 맥박 탭 안에 들어갔다(위험 카드). 여기서 또 띄우면 같은 값이 두 번 보인다.
        브리핑도 제 온도계가 있다. 다른 탭에서는 「지금 시장이 어떤 상태인가」가 먼저다.
      */}
      {tab !== "pulse" && tab !== "briefing" && <MarketSignalPanel />}

      <nav className="detail-tabs">
        {FLOW_TABS.map((t) => (
          <button
            key={t.key}
            className={`detail-tab${tab === t.key ? " active" : ""}`}
            style={{ order: tabOrder.orderOf(t.key) }}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      <div key={`${tab}-${reloadKey}`}>
        {tab === "briefing" && <BriefingPage onSelectStock={onSelectStock ?? (() => {})} />}
        {tab === "pulse" && <MarketPulsePanel onSelectStock={onSelectStock} />}
        {tab === "rotation" && (
          <>
            <h3 className="section-heading">테마 로테이션 — 돈이 어디서 어디로</h3>
            <RotationBoard onSelectStock={onSelectStock} />
            <h3 className="section-heading">시장 체온계 — 지수 말고 종목들</h3>
            <ThermoPanel />
          </>
        )}
        {tab === "leaders" && <LeaderScanPanel onSelectStock={onSelectStock} />}
        {tab === "events" && <EventPlayPanel />}
        {tab === "closebet" && <CloseBetPanel />}
        {tab === "money" && <MoneyFlowTab onSelectStock={onSelectStock} />}
        {tab === "usKr" && <UsKrPanel />}
        {tab === "trade" && <TradePanel onSelectStock={onSelectStock} />}
      </div>
    </div>
  );
}
