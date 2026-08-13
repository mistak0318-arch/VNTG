import { useEffect, useState } from "react";
import { api, fmtNum, type BreadthPoint, type ChannelReport } from "../api";
import { BreadthPanel } from "../components/BreadthPanel";
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
 *   채널 정리 — 사람들이 무슨 말을 하고 있는가 (구독 채널 AI 정리)
 *
 * 숫자와 이야기를 같은 화면에 두면 "왜 이렇게 움직였나"를 붙여 읽을 수 있다.
 */

type FlowTab = "money" | "trade" | "channel";

const TABS: { key: FlowTab; label: string }[] = [
  { key: "money", label: "자금 흐름" },
  { key: "trade", label: "수출 동향" },
  { key: "channel", label: "채널 정리" },
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

function MoneyFlowTab() {
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

      <h3 className="section-heading">시장 폭</h3>
      <BreadthPanel />
    </>
  );
}

/** 몇 시간치를 훑을지. 채널이 조용한 날엔 넓게 봐야 건질 게 나온다 */
const WINDOWS = [6, 12, 24, 48];

function ChannelTab() {
  const [reports, setReports] = useState<ChannelReport[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [open, setOpen] = useState(0);
  const [hours, setHours] = useState(12);
  /** 방금 실행한 결과 — 저장 안 되는 경우(0건·미리보기)에도 화면에 보여준다 */
  const [fresh, setFresh] = useState<ChannelReport | null>(null);

  function load() {
    api
      .channelReports(10)
      .then((r) => setReports(r.reports))
      .catch(() => undefined);
  }

  useEffect(load, []);

  async function run(kind: "preview" | "ai") {
    setBusy(kind);
    setNote(null);
    setFresh(null);
    try {
      const r = await api.channelsReport({ ai: kind === "ai", hours });
      setFresh(r);
      if (kind === "ai") {
        load();
        setOpen(0);
        setNote(`정리 완료 · 토큰 ${r.inputTokens}/${r.outputTokens}`);
      } else {
        setNote(`원본 ${r.rawCount}건 → 선별 ${r.usedCount}건 (AI 미호출 · 비용 없음)`);
      }
      if (r.error) setNote((n) => `${n ?? ""} · ${r.error}`);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "실패");
    } finally {
      setBusy(null);
    }
  }

  const current = reports[open];

  // 보고 있는 정리본이 오늘 것이 아니면 분명히 알린다.
  // 이걸 안 보여주면 어제 리포트를 오늘 상황으로 착각하게 된다.
  const todayKst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const stale = current ? current.date !== todayKst : false;

  return (
    <>
      <div className="filter-row">
        <button className="primary-btn" disabled={busy !== null} onClick={() => run("ai")}>
          {busy === "ai" ? "정리 중…" : "지금 AI로 정리"}
        </button>
        <button className="filter-btn" disabled={busy !== null} onClick={() => run("preview")}>
          {busy === "preview" ? "수집 중…" : "선별만 보기 (비용 없음)"}
        </button>
        <span className="news-scope-sep" />
        {WINDOWS.map((h) => (
          <button
            key={h}
            className={`filter-btn ${hours === h ? "active" : ""}`}
            onClick={() => setHours(h)}
            disabled={busy !== null}
            title={`최근 ${h}시간에 올라온 메시지만 훑습니다`}
          >
            {h}시간
          </button>
        ))}
      </div>
      {note && <div className="alert-note">{note}</div>}

      {fresh && (
        <div className="page-note">
          방금 실행 — 최근 <b>{fresh.windowHours ?? hours}시간</b> · 채널 {fresh.channels}개 · 원본{" "}
          {fresh.rawCount}건 → 선별 {fresh.usedCount}건
          {fresh.newestAt && (
            <>
              {" "}
              · 가장 최근 메시지 <b>{fresh.newestAt.slice(5, 16).replace("T", " ")}</b>
            </>
          )}
        </div>
      )}

      {stale && (
        <div className="alert-note">
          지금 보고 있는 정리본은 <b>{current.date}</b>에 만든 것입니다. 오늘 것을 보려면 위의
          「지금 AI로 정리」를 누르세요.
        </div>
      )}

      {reports.length === 0 ? (
        <div className="page-note">
          아직 정리된 기록이 없습니다. <b>설정 &gt; 구독 채널 수집</b>에서 읽을 채널을 먼저
          켜주세요. 정기 발행은 07 / 12 / 18시입니다.
        </div>
      ) : (
        <>
          <div className="filter-row">
            {reports.map((r, i) => (
              <button
                key={r.generatedAt}
                className={`filter-btn ${open === i ? "active" : ""}`}
                onClick={() => setOpen(i)}
              >
                {r.generatedAt.slice(5, 16).replace("T", " ")}
              </button>
            ))}
          </div>

          {current && (
            <>
              <div className="chan-report-meta">
                <b>{current.generatedAt.slice(0, 16).replace("T", " ")}</b> 생성 · 채널{" "}
                {current.channels}개 · 원본 {current.rawCount}건 → 선별 {current.usedCount}건 · 토큰{" "}
                {current.inputTokens}/{current.outputTokens}
                {current.skipped.length > 0 && ` · 건너뜀 ${current.skipped.length}개`}
              </div>
              {current.newestAt && (
                <div className="chan-report-meta">
                  정리한 메시지 구간 {current.oldestAt?.slice(5, 16).replace("T", " ")} ~{" "}
                  {current.newestAt.slice(5, 16).replace("T", " ")}
                  {current.windowHours ? ` (최근 ${current.windowHours}시간 훑음)` : ""}
                </div>
              )}

              {current.summary ? (
                <pre className="alert-preview">{current.summary}</pre>
              ) : (
                <div className="page-note">{current.error ?? "요약이 없습니다."}</div>
              )}

              {current.items.length > 0 && (
                <>
                  <h3 className="section-heading">근거 — 선별된 원문 상위 15건</h3>
                  <div className="chan-items">
                    {current.items.slice(0, 15).map((it, i) => (
                      <div className="chan-item" key={i}>
                        <div className="chan-item-head">
                          {it.coverage > 1 && (
                            <span className="news-tag hot">{it.coverage}개 채널</span>
                          )}
                          {it.mentions.length > 0 && (
                            <span className="news-tag watch">★ {it.mentions.join(", ")}</span>
                          )}
                          <span className="chan-item-time">{it.at.slice(11, 16)}</span>
                        </div>
                        <div className="chan-item-text">{it.text}</div>
                        <div className="chan-item-src">{it.channels.join(" · ")}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      <div className="table-note">
        AI 정리는 <b>채널에서 나온 주장</b>이지 확인된 사실이 아닙니다. 아래 원문을 같이 두는 이유가
        그것입니다 — 요약만 믿지 말고 몇 개 채널이 말했는지, 누가 말했는지 보고 판단하세요.
      </div>
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
        {tab === "money" && <MoneyFlowTab />}
        {tab === "trade" && <TradePanel onSelectStock={onSelectStock} />}
        {tab === "channel" && <ChannelTab />}
      </div>
    </div>
  );
}
