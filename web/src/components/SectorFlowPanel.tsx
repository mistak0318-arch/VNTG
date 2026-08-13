import { useEffect, useState } from "react";
import { api, fmtNum, type SectorFlowResult } from "../api";

/**
 * 업종별 자금 흐름.
 *
 * 지금까지 화면에 있던 건 "오늘 외국인 +2.3조" 하나였다. 총액은 규모만 말해줄 뿐
 * **어디서 빼서 어디로 넣었는지**를 말해주지 않는다. 같은 +2.3조라도 반도체 한 곳에
 * 몰린 날과 전 업종에 고르게 퍼진 날은 완전히 다른 장이다.
 *
 * 그래서 세 가지를 같이 본다.
 *   누적 순매수 — 하루치는 노이즈라 기본 5일
 *   순위 변화   — 절대 금액보다 순위가 바뀌는 게 로테이션의 신호다
 *   연속 일수   — 며칠째 같은 방향인지
 */

const WINDOWS = [1, 5, 10, 20];

/** 막대 길이는 그 화면에서 가장 큰 값 기준 — 절대 규모는 숫자로 읽고 막대는 비교용이다 */
function bar(value: number, max: number): string {
  if (max <= 0) return "0%";
  return `${Math.min((Math.abs(value) / max) * 100, 100).toFixed(1)}%`;
}

export function SectorFlowPanel() {
  const [data, setData] = useState<SectorFlowResult | null>(null);
  const [subject, setSubject] = useState("foreign");
  const [window, setWindow] = useState(5);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .sectorFlow(subject, window)
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [subject, window]);

  async function backfill() {
    setBusy(true);
    setNote(null);
    try {
      const r = await api.sectorFlowBackfill(120);
      setNote(`${r.added}일 채움 · 휴장일 ${r.skipped}일 제외 · 보유 ${r.total}일`);
      const fresh = await api.sectorFlow(subject, window);
      setData(fresh);
    } catch (err) {
      setNote(err instanceof Error ? err.message : "실패");
    } finally {
      setBusy(false);
    }
  }

  if (loading && !data) return <div className="empty">자금 흐름 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return null;

  const enough = data.dates.length >= 2;
  const top = data.stats.slice(0, 10);
  const bottom = data.stats.slice(-10).reverse();
  const max = Math.max(...data.stats.map((s) => Math.abs(s.sum)), 1);

  return (
    <>
      <div className="filter-row">
        {data.subjects.map((s) => (
          <button
            key={s.key}
            className={`filter-btn ${subject === s.key ? "active" : ""}`}
            onClick={() => setSubject(s.key)}
          >
            {s.label}
          </button>
        ))}
        <span className="news-scope-sep" />
        {WINDOWS.map((w) => (
          <button
            key={w}
            className={`filter-btn ${window === w ? "active" : ""}`}
            onClick={() => setWindow(w)}
            title={w === 1 ? "하루치는 노이즈가 많습니다" : `${w}거래일 누적`}
          >
            {w}일
          </button>
        ))}
        <span className="breadth-count">
          {data.dates.length > 0 ? `${data.dates[0]} ~ ${data.dates[data.dates.length - 1]}` : ""}
        </span>
        <button className="filter-btn" onClick={() => void backfill()} disabled={busy}>
          {busy ? "채우는 중…" : "과거분 채우기"}
        </button>
      </div>
      {note && <div className="alert-note">{note}</div>}

      {!enough ? (
        <div className="page-note">
          아직 <b>{data.dates.length}일치</b>뿐입니다. 「과거분 채우기」를 누르면 최근 120거래일을
          한 번에 받아옵니다 — 이 데이터는 <b>과거 조회가 되므로</b> 시장 폭과 달리 기다릴 필요가
          없습니다 (2시장 × 120일이라 1분쯤 걸립니다).
        </div>
      ) : (
        <>
          <div className="flow-two-col">
            <section>
              <h4 className="feed-heading">
                {data.subjectLabel}이 담은 업종 ({data.window}일 누적)
              </h4>
              {top.map((s) => (
                <div className="sf-row" key={s.code}>
                  <span className="sf-name">{s.label}</span>
                  <span className="sf-bar">
                    <span className="sf-fill positive" style={{ width: bar(s.sum, max) }} />
                  </span>
                  <span className="sf-val positive">{fmtNum(Math.round(s.sum))}</span>
                  {s.rankChange !== null && s.rankChange !== 0 && (
                    <span className={`sf-rank ${s.rankChange > 0 ? "positive" : "negative"}`}>
                      {s.rankChange > 0 ? "▲" : "▼"}
                      {Math.abs(s.rankChange)}
                    </span>
                  )}
                </div>
              ))}
            </section>

            <section>
              <h4 className="feed-heading">
                {data.subjectLabel}이 던진 업종 ({data.window}일 누적)
              </h4>
              {bottom.map((s) => (
                <div className="sf-row" key={s.code}>
                  <span className="sf-name">{s.label}</span>
                  <span className="sf-bar">
                    <span className="sf-fill negative" style={{ width: bar(s.sum, max) }} />
                  </span>
                  <span className="sf-val negative">{fmtNum(Math.round(s.sum))}</span>
                </div>
              ))}
            </section>
          </div>

          <div className="table-note">
            ▲▼는 <b>직전 같은 기간 대비 순위 변화</b>입니다. 금액보다 순위가 크게 움직인 업종이
            자금이 새로 들어오거나 빠져나가는 곳입니다. 단위는 억원.
          </div>

          {data.sizes.length > 0 && (
            <>
              <h4 className="feed-heading">규모별 (코스피)</h4>
              <div className="filter-row">
                {data.sizes.map((s) => (
                  <span className="breadth-count" key={s.label}>
                    {s.label} 외국인{" "}
                    <b className={s.foreign > 0 ? "positive" : "negative"}>
                      {fmtNum(Math.round(s.foreign))}
                    </b>{" "}
                    / 기관{" "}
                    <b className={s.institution > 0 ? "positive" : "negative"}>
                      {fmtNum(Math.round(s.institution))}
                    </b>
                  </span>
                ))}
              </div>
              <div className="table-note">
                대형주에서 중소형으로 옮겨가는 구간은 장의 성격이 바뀌는 지점입니다.
              </div>
            </>
          )}

          {data.streaks.length > 0 && (
            <>
              <h4 className="feed-heading">연속 {data.subjectLabel} 순매수·순매도</h4>
              <div className="filter-row">
                {data.streaks.map((s) => (
                  <span className="breadth-count" key={s.code}>
                    {s.label}{" "}
                    <b className={s.streak > 0 ? "positive" : "negative"}>
                      {Math.abs(s.streak)}일 {s.streak > 0 ? "매수" : "매도"}
                    </b>
                  </span>
                ))}
              </div>
              <div className="table-note">
                하루치 순매수는 노이즈지만 <b>며칠 연속인지는 신호</b>입니다.
              </div>
            </>
          )}

          {data.splits.length > 0 && (
            <>
              <h4 className="feed-heading">기관 내부 이견 — 연기금 vs 투신</h4>
              <div className="data-table-wrap">
                <table className="data-table num">
                  <thead>
                    <tr>
                      <th className="sticky-col">업종</th>
                      <th>연기금</th>
                      <th>투신</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.splits.map((s) => (
                      <tr key={s.code}>
                        <td className="sticky-col">{s.label}</td>
                        <td className={s.pension > 0 ? "positive" : "negative"}>
                          {fmtNum(Math.round(s.pension))}
                        </td>
                        <td className={s.trust > 0 ? "positive" : "negative"}>
                          {fmtNum(Math.round(s.trust))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-note">
                둘 다 기관이지만 성격이 다릅니다 — 연기금은 길게 보고 담고, 투신은 성과에 쫓겨 짧게
                돕니다. 방향이 갈리는 업종은 <b>변곡 후보로만</b> 보고 단정하지 마세요.
              </div>
            </>
          )}
        </>
      )}
    </>
  );
}
