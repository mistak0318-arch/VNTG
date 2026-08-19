import { useCallback, useEffect, useState } from "react";
import { api, fmtNum, signClass, type TrackEntry, type TrackSummary } from "../api";

/**
 * 신호등 추적기 — **신호등이 정말 맞는지 스스로 검증하는 자리.**
 *
 * 장이 끝나면 서버가 그날 점수가 높았던 종목을 자동으로 담고 며칠을 따라간다.
 * 사람이 고르지 않는다 — 사람이 고르면 **맞은 것만 기억하게 된다.**
 *
 * 화면은 두 층이다.
 *   위: 문턱(70·80·90)별로 **얼마나 맞았나** — 이게 본론이다
 *   아래: 담긴 것들의 목록 — 왜 그런 숫자가 나왔는지 확인하는 자리
 */

function pct(v: number): string {
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function SignalTrackPanel({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [data, setData] = useState<TrackSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [tierFilter, setTierFilter] = useState<number | 0>(0);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api.signalTrack());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오지 못했습니다");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function runNow() {
    setRunning(true);
    setNote(null);
    setError(null);
    try {
      const r = await api.signalTrackRun();
      setNote(`${r.note} 결과 ${r.updated.updated}건 갱신.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "실행 실패");
    } finally {
      setRunning(false);
    }
  }

  if (loading && !data) return <div className="empty">추적 기록 불러오는 중…</div>;

  const entries = (data?.entries ?? []).filter((e) => tierFilter === 0 || e.tier === tierFilter);

  return (
    <div className="st">
      <div className="filter-row">
        <button className="primary-btn" onClick={() => void runNow()} disabled={running}>
          {running ? "담는 중… (몇 분 걸립니다)" : "지금 담기"}
        </button>
        <span className="pt-n">
          평일 <b>15:40</b> 에 자동으로 담습니다
          {data?.lastRunDate && ` · 마지막 ${data.lastRunDate}`}
        </span>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {note && <div className="alert-note">{note}</div>}

      {/*
        기준이 섞였으면 먼저 말한다.
        신호등 기준을 바꾼 뒤의 90점과 그 전의 90점은 **다른 것**이라, 섞어서 평균 내면
        무엇을 검증한 건지 알 수 없어진다.
      */}
      {data?.mixedConfig && (
        <div className="alert-note">
          담긴 것들이 <b>서로 다른 신호등 기준</b>으로 들어왔습니다 — 중간에 기준을 바꾸셨습니다.
          아래 숫자는 그 둘을 섞은 값이라 그대로 믿기 어렵습니다. 목록의 <b>기준</b> 칸에서
          어느 것이 지금 기준(<code>{data.currentConfig}</code>)인지 볼 수 있습니다.
        </div>
      )}

      {/* ---------------- 문턱별 성적 ---------------- */}
      <section className="card">
        <h2>문턱별 성적</h2>
        {(data?.tiers ?? []).every((t) => t.count === 0) ? (
          <div className="page-note">
            아직 담긴 것이 없습니다. <b>지금 담기</b>를 누르거나 평일 15:40 을 기다리세요.
            결과는 <b>다음 거래일부터</b> 채워집니다.
          </div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table num st-tiers">
              <thead>
                <tr>
                  <th className="sticky-col">문턱</th>
                  <th>담김</th>
                  <th>기간</th>
                  <th title="오른 비율">승률</th>
                  <th>평균</th>
                  <th title="몇 종목이 크게 튀면 평균이 거짓말을 한다">중앙값</th>
                  <th>최고</th>
                  <th>최저</th>
                </tr>
              </thead>
              <tbody>
                {(data?.tiers ?? []).map((t) =>
                  t.byHorizon.map((h, i) => (
                    <tr key={`${t.tier}-${h.days}`} className={h.n === 0 ? "st-empty" : ""}>
                      {i === 0 && (
                        <td className="sticky-col" rowSpan={t.byHorizon.length}>
                          <b>{t.tier}점+</b>
                        </td>
                      )}
                      {i === 0 && (
                        <td rowSpan={t.byHorizon.length}>
                          {t.count}
                          {t.pending > 0 && <span className="pt-n"> (대기 {t.pending})</span>}
                        </td>
                      )}
                      <td>{h.days}일</td>
                      <td className={h.n === 0 ? "" : h.winRate >= 50 ? "positive" : "negative"}>
                        {h.n === 0 ? "-" : `${h.winRate.toFixed(0)}%`}
                      </td>
                      <td className={h.n === 0 ? "" : signClass(h.avg)}>
                        {h.n === 0 ? "-" : pct(h.avg)}
                      </td>
                      <td className={h.n === 0 ? "" : signClass(h.median)}>
                        {h.n === 0 ? "-" : pct(h.median)}
                      </td>
                      <td className="positive">{h.n === 0 ? "-" : pct(h.best)}</td>
                      <td className="negative">{h.n === 0 ? "-" : pct(h.worst)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-note">
          <b>승률</b>은 편입가보다 오른 비율입니다. 표본이 적을 때는 숫자가 크게 흔들리므로
          <b> 담김 수</b>를 같이 보세요 — 다섯 건으로 나온 80% 는 우연입니다.
          <b> 중앙값</b>을 둔 이유도 같습니다: 한 종목이 +40% 면 평균이 혼자 올라갑니다.
        </div>
      </section>

      {/* ---------------- 목록 ---------------- */}
      <section className="card">
        <h2>담긴 종목 ({entries.length})</h2>
        <div className="filter-row">
          {[0, 70, 80, 90].map((t) => (
            <button
              key={t}
              className={`filter-btn ${tierFilter === t ? "active" : ""}`}
              onClick={() => setTierFilter(t)}
            >
              {t === 0 ? "전체" : `${t}점+`}
            </button>
          ))}
        </div>
        {entries.length === 0 ? (
          <div className="page-note">해당하는 기록이 없습니다.</div>
        ) : (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">종목</th>
                  <th>편입일</th>
                  <th>문턱</th>
                  <th>점수</th>
                  <th title="편입 당시 축별 점수 — 어느 축이 잘 맞았나">추세/수급/실적/위험</th>
                  <th>편입가</th>
                  {[1, 5, 20, 60].map((d) => (
                    <th key={d}>{d}일</th>
                  ))}
                  <th title="그때의 신호등 기준">기준</th>
                </tr>
              </thead>
              <tbody>
                {entries.slice(0, 200).map((e) => (
                  <Row
                    key={e.id}
                    e={e}
                    current={data?.currentConfig ?? ""}
                    onSelectStock={onSelectStock}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="table-note">
          같은 종목·같은 문턱이 <b>추적 중이면 다시 담지 않습니다</b> — 한 종목이 20일 연속
          90점이면 스무 건이 쌓여 그 종목 하나가 통계를 지배합니다. 60일까지 다 본 것은 닫히되
          <b> 기록은 지우지 않습니다.</b>
        </div>
      </section>
    </div>
  );
}

function Row({
  e,
  current,
  onSelectStock,
}: {
  e: TrackEntry;
  current: string;
  onSelectStock: (code: string, name: string) => void;
}) {
  const at = (d: number) => e.results.find((r) => r.days === d);
  const ax = (k: "trend" | "flow" | "value" | "risk") => {
    const v = e.axes[k];
    return v === null || v === undefined ? "-" : String(v);
  };

  return (
    <tr className={`clickable-row${e.closed ? " st-closed" : ""}`} onClick={() => onSelectStock(e.code, e.name)}>
      <td className="sticky-col">{e.name}</td>
      <td>{e.date.slice(5)}</td>
      <td>
        <b>{e.tier}</b>
      </td>
      <td className="num">
        {e.score}
        {/* 위험으로 초록이 막혔던 건 따로 보여야 한다 — 나중에 그게 옳았는지 묻게 된다 */}
        {e.riskCapped && (
          <span className="pt-n" title="위험 축이 빨강이라 초록이 막혔던 종목">
            {" "}
            ⚠
          </span>
        )}
      </td>
      <td className="num pt-n">
        {ax("trend")}/{ax("flow")}/{ax("value")}/{ax("risk")}
      </td>
      <td className="num">{fmtNum(e.basePrice)}</td>
      {[1, 5, 20, 60].map((d) => {
        const r = at(d);
        return (
          <td className={`num ${r ? signClass(r.rate) : ""}`} key={d}>
            {r ? pct(r.rate) : "-"}
          </td>
        );
      })}
      <td className="pt-n" title={e.configHash === current ? "지금 기준과 같음" : "지금과 다른 기준"}>
        {e.configHash === current ? "지금" : e.configHash}
      </td>
    </tr>
  );
}
