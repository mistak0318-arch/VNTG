import { useEffect, useRef, useState } from "react";
import { api, fmtNum, type ScreenHit, type ScreenJob } from "../api";
import { useWatchedCodes } from "../useWatchedCodes";

/**
 * 신호등 스크리너.
 *
 * 지금까지 신호등은 **이미 아는 종목을 확인하는 용도**였다. 정작 필요한 건
 * "내 기준에 맞는 종목이 지금 시장에 뭐가 있나"다.
 *
 * 모집단은 **거래대금 상위**다. 전종목을 돌리면 감당이 안 되고, 무엇보다
 * 거래대금이 없는 종목은 신호가 맞아도 못 산다 — 돈이 몰린 곳에서 고르는 게 맞다.
 *
 * 기준은 「설정 > 신호등 기준」을 그대로 쓴다. 여기서 따로 정하게 하면 두 곳이 어긋난다.
 */

const MARKETS = [
  { key: "000", label: "전체" },
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
];

const LIMITS = [50, 100, 150];

function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function ScreenPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [market, setMarket] = useState("000");
  const [level, setLevel] = useState<"green" | "yellow">("green");
  const [limit, setLimit] = useState(100);
  const [job, setJob] = useState<ScreenJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watched = useWatchedCodes();

  // 화면을 떠나면 폴링을 멈춘다 (작업은 서버에서 계속 돈다)
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  async function start() {
    setError(null);
    setJob(null);
    if (timerRef.current) clearInterval(timerRef.current);
    try {
      const { jobId } = await api.signalScreenStart(market, level, limit);
      timerRef.current = setInterval(async () => {
        try {
          const j = await api.signalScreenStatus(jobId);
          setJob(j);
          if (j.status !== "running" && timerRef.current) clearInterval(timerRef.current);
        } catch {
          /* 한 번 실패해도 다음 폴링에서 다시 시도 */
        }
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "시작 실패");
    }
  }

  /** 찾은 종목을 바로 관심종목에 담는다 — 편입가는 지금 현재가 */
  async function addToWatch(hit: ScreenHit) {
    setAdding(hit.code);
    try {
      await api.watchlistAdd({ code: hit.code, name: hit.name, addedPrice: hit.price });
      watched.markAdded(hit.code); // 전역 집합에 바로 반영 — 다시 조회할 필요 없다
    } catch (e) {
      setError(e instanceof Error ? e.message : "관심종목 추가 실패");
    } finally {
      setAdding(null);
    }
  }

  const running = job?.status === "running";
  const progress = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <div>
      <div className="filter-row">
        {MARKETS.map((m) => (
          <button
            key={m.key}
            className={`filter-btn ${market === m.key ? "active" : ""}`}
            onClick={() => setMarket(m.key)}
            disabled={running}
          >
            {m.label}
          </button>
        ))}
        <span className="news-scope-sep" />
        {([
          { key: "green" as const, label: "초록만" },
          { key: "yellow" as const, label: "노랑 이상" },
        ]).map((l) => (
          <button
            key={l.key}
            className={`filter-btn ${level === l.key ? "active" : ""}`}
            onClick={() => setLevel(l.key)}
            disabled={running}
          >
            {l.label}
          </button>
        ))}
        <span className="news-scope-sep" />
        {LIMITS.map((n) => (
          <button
            key={n}
            className={`filter-btn ${limit === n ? "active" : ""}`}
            onClick={() => setLimit(n)}
            disabled={running}
            title={`거래대금 상위 ${n}종목을 검사합니다`}
          >
            상위 {n}
          </button>
        ))}
        <button className="algo-run-btn" onClick={() => void start()} disabled={running}>
          {running ? `검사 중 ${job?.done}/${job?.total}` : "찾기"}
        </button>
      </div>

      <p className="page-note">
        <b>거래대금 상위</b>에서 「설정 &gt; 신호등 기준」에 맞는 종목을 찾습니다.
        ETF·ETN·리츠·우선주는 빼고 세므로 「상위 100」은 실제 종목 100개입니다. 종목마다
        차트·수급·재무를 조회하므로 100종목이면 <b>1~2분</b> 걸립니다. 신호등 결과는 15분
        캐시를 타므로 두 번째 실행은 훨씬 빠릅니다.
      </p>

      {error && <div className="error-banner">{error}</div>}
      {job?.error && <div className="error-banner">{job.error}</div>}

      {running && (
        <div className="progress-bar" style={{ marginBottom: 10 }}>
          <div className="progress-bar-fill" style={{ width: `${progress}%`, background: "var(--blue)" }} />
        </div>
      )}

      {job && (
        <>
          <div className="filter-row">
            <span className="breadth-count">
              {job.done}/{job.total} 검사 · 조건 통과 <b>{job.results.length}종목</b>
              {job.status === "done" && " · 완료"}
            </span>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">종목명</th>
                  <th>점수</th>
                  <th>현재가</th>
                  <th>등락률</th>
                  <th>거래대금</th>
                  <th>통과 항목</th>
                  <th>담기</th>
                </tr>
              </thead>
              <tbody>
                {job.results.map((r) => (
                  <tr key={r.code}>
                    <td className="sticky-col">
                      <button className="link-btn" onClick={() => onSelectStock(r.code, r.name)}>
                        <span className={`sig-dot ${r.level}`} />
                        {r.name}
                      </button>
                    </td>
                    <td className="num">
                      <b>{r.score}</b>
                    </td>
                    <td className="num">{fmtNum(r.price)}</td>
                    <td className={`num ${r.changeRate > 0 ? "positive" : r.changeRate < 0 ? "negative" : ""}`}>
                      {pct(r.changeRate)}
                    </td>
                    <td className="num">{fmtNum(Math.round(r.tradeValue / 100))}억</td>
                    <td className="scr-passed">{r.passed.join(" · ")}</td>
                    <td>
                      {watched.isWatched(r.code) ? (
                        <span className="scr-added">담김</span>
                      ) : (
                        <button
                          className="row-add-btn"
                          onClick={() => void addToWatch(r)}
                          disabled={adding === r.code}
                        >
                          {adding === r.code ? "…" : "+ 관심"}
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {job.status === "done" && job.results.length === 0 && (
            <div className="empty">
              조건에 맞는 종목이 없습니다. 「노랑 이상」으로 넓히거나 신호등 기준을 조정해 보세요.
            </div>
          )}
        </>
      )}

      {!job && (
        <div className="page-note">
          「찾기」를 누르면 시작합니다. 결과에서 <b>+ 관심</b>을 누르면 바로 관심종목에 담겨
          그때부터 수익률과 수급이 추적됩니다.
        </div>
      )}
    </div>
  );
}
