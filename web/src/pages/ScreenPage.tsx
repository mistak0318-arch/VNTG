import { useEffect, useRef, useState } from "react";
import { BacktestPanel } from "../components/BacktestPanel";
import { SignalTrackPanel } from "../components/SignalTrackPanel";
import { api, fmtNum, type ScreenHit, type ScreenJob, type ScreenRunSummary } from "../api";
import { SuperSignalPanel } from "../components/SuperSignalPanel";
import { useWatchedCodes } from "../useWatchedCodes";
import { WatchAddSheet, type WatchAddTarget } from "../components/WatchAddSheet";

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
 *
 * 결과는 **디스크에 남긴다.** 매번 새로 돌려야 하면 어제 뭐가 걸렸는지 볼 수가 없는데,
 * 이 화면의 값어치는 오늘 목록보다 오히려 흐름에 있다 — 사흘째 계속 걸리는 종목과
 * 오늘 처음 뜬 종목은 전혀 다른 얘기다.
 */

const MARKETS = [
  { key: "000", label: "전체" },
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
];

/*
 * 훑을 종목 수. **넓게 볼 수 있어야 발굴이 된다** — 상위 백 개는 이미 다 아는 종목이고,
 * 새로 걸리는 건 그 아래에서 나온다. 대신 종목마다 조회가 나가므로 오래 걸리는 만큼
 * 버튼에 적어 둔다.
 */
const LIMITS = [50, 100, 200, 300, 500];

function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

type ScreenTab = "find" | "track" | "super" | "backtest";

export function ScreenPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  /*
   * 두 자리다.
   *   찾기 — 내가 눌러서 지금 훑는다
   *   추적기 — 서버가 장 마감 뒤 알아서 담고 따라간다. **신호등이 맞는지 검증하는 자리**
   *   백테스트 — 「이 조건으로 들어갔으면 과거에 어땠나」. 앞의 둘은 **앞을 보고**,
   *              이건 **뒤를 본다.** 같은 질문의 반대쪽이라 여기 같이 둔다
   */
  const [screenTab, setScreenTab] = useState<ScreenTab>("find");
  const [market, setMarket] = useState("000");
  const [level, setLevel] = useState<"green" | "yellow">("green");
  const [limit, setLimit] = useState(100);
  /*
   * 모집단 — 거래대금 상위만이 아니다 (2026-08-25).
   * 외국인 연속순매매·동일순매매·누적등락률… **어느 목록에서 초록이 잘 나오나**
   * 자체가 물음이라, 목록을 고를 수 있게 했다. 목록은 서버가 정한다.
   */
  const [universes, setUniverses] = useState<{ key: string; label: string; hint: string }[]>([]);
  const [universe, setUniverse] = useState("trade-value");
  useEffect(() => {
    api
      .signalScreenUniverses()
      .then((r) => setUniverses(r.universes))
      .catch(() => setUniverses([{ key: "trade-value", label: "거래대금 상위", hint: "" }]));
  }, []);
  const uniLabel = (k?: string) =>
    universes.find((u) => u.key === (k ?? universe))?.label ?? "거래대금 상위";
  const [job, setJob] = useState<ScreenJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const watched = useWatchedCodes();
  const [addTarget, setAddTarget] = useState<WatchAddTarget | null>(null);

  /** 지난 회차 */
  const [runs, setRuns] = useState<ScreenRunSummary[]>([]);
  const [viewing, setViewing] = useState<string>(""); // "" = 방금 돌린 것
  const [diff, setDiff] = useState<{ added: ScreenHit[]; removed: ScreenHit[] } | null>(null);

  function loadRuns() {
    api
      .signalScreenRuns()
      .then((r) => setRuns(r.runs))
      .catch(() => undefined);
  }

  useEffect(loadRuns, []);

  /** 지난 회차를 불러 화면에 띄운다 (재조회 없음) */
  async function openRun(id: string) {
    setViewing(id);
    setDiff(null);
    if (!id) return;
    try {
      const run = await api.signalScreenRun(id);
      setJob({
        status: "done",
        total: run.total,
        done: run.total,
        results: run.results,
        market: run.market,
        minLevel: run.minLevel,
        universe: run.universe,
        startedAt: run.at,
      });
      // 바로 앞 회차와 견줘서 "새로 들어온 것"을 같이 보여준다
      const idx = runs.findIndex((r) => r.id === id);
      const prev = runs[idx + 1];
      if (prev) {
        const d = await api.signalScreenDiff(prev.id, id).catch(() => null);
        if (d) setDiff({ added: d.added, removed: d.removed });
      }
    } catch {
      /* 못 불러와도 화면은 그대로 둔다 */
    }
  }

  // 화면을 떠나면 폴링을 멈춘다 (작업은 서버에서 계속 돈다)
  useEffect(() => () => {
    if (timerRef.current) clearInterval(timerRef.current);
  }, []);

  /** jobId 에 붙어 끝날 때까지 폴링한다 — 시작할 때도, 돌아와서 이어받을 때도 이 길이다 */
  function attach(jobId: string) {
    if (timerRef.current) clearInterval(timerRef.current);
    const poll = async () => {
      try {
        const j = await api.signalScreenStatus(jobId);
        setJob(j);
        if (j.status !== "running" && timerRef.current) {
          clearInterval(timerRef.current);
          loadRuns(); // 끝나면 기록에 남으므로 목록을 새로 받는다
        }
      } catch {
        /* 한 번 실패해도 다음 폴링에서 다시 시도 */
      }
    };
    void poll();
    timerRef.current = setInterval(() => void poll(), 2000);
  }

  /*
   * 돌아왔을 때 **돌던 찾기를 이어받는다** (2026-08-25 — 채널 검색과 같은 개선).
   * 찾기를 걸고 다른 메뉴로 가면 진행바가 사라지고, 돌아와도 jobId 를 잃어
   * 못 잇던 것을 — 서버의 「지금 도는 작업」을 물어 다시 붙는다.
   * (돌던 게 없으면 아무 일도 없다. 끝난 것은 「지난 기록」에 있다)
   */
  useEffect(() => {
    api
      .signalScreenActive()
      .then((r) => {
        if (r.jobs[0]) attach(r.jobs[0].id);
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function start() {
    setError(null);
    setJob(null);
    setViewing("");
    setDiff(null);
    if (timerRef.current) clearInterval(timerRef.current);
    try {
      const { jobId } = await api.signalScreenStart(market, level, limit, universe);
      attach(jobId);
    } catch (e) {
      setError(e instanceof Error ? e.message : "시작 실패");
    }
  }

  /**
   * 찾은 종목을 관심종목에 담는다 — 편입가는 지금 현재가.
   * 그룹이 있으면 **어디에 넣을지 묻는다.** 없으면 묻지 않고 바로 담는다.
   */
  async function addToWatch(hit: ScreenHit) {
    setAdding(hit.code);
    try {
      const { groups } = await api.watchGroups().catch(() => ({ groups: [] as string[] }));
      if (groups.length === 0) {
        await api.watchlistAdd({ code: hit.code, name: hit.name, addedPrice: hit.price });
        watched.markAdded(hit.code); // 전역 집합에 바로 반영 — 다시 조회할 필요 없다
      } else {
        setAddTarget({ code: hit.code, name: hit.name, addedPrice: hit.price });
      }
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
      <nav className="detail-tabs">
        {([
          { key: "find" as const, label: "신호등 찾기" },
          { key: "track" as const, label: "추적기" },
          /* 추적기의 상위판 — 여러 목록에 동시에 걸린 초록만 따라간다 */
          { key: "super" as const, label: "🌟 슈퍼신호등" },
          { key: "backtest" as const, label: "조건 백테스트" },
        ]).map((t) => (
          <button
            key={t.key}
            className={`detail-tab${screenTab === t.key ? " active" : ""}`}
            onClick={() => setScreenTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {screenTab === "backtest" ? (
        <BacktestPanel />
      ) : screenTab === "super" ? (
        <SuperSignalPanel onSelectStock={onSelectStock} />
      ) : screenTab === "track" ? (
        <SignalTrackPanel onSelectStock={onSelectStock} />
      ) : (
    <div>
      {/*
        **묶음마다 이름을 붙인다.**
        「코스피 / 코스닥」만 덩그러니 있으면 **결과를 시장별로 나눠 보여주는 그룹**으로
        읽힌다. 실제로는 「어디서 찾을까」를 고르는 필터다 — 고른 시장만 훑는다.
        버튼 생김새가 셋 다 같으니 이름이 없으면 무엇을 정하는 건지 알 수가 없다.
      */}
      {/* 폰에서는 한 줄로 세우고 옆으로 넘긴다 — 컨트롤 다이어트 */}
      <div className="filter-row ctl-ribbon">
        <span className="filter-label">찾을 곳</span>
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
        <span className="filter-label">신호등</span>
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
        <button className="algo-run-btn" onClick={() => void start()} disabled={running}>
          {running ? `검사 중 ${job?.done}/${job?.total}` : "찾기"}
        </button>
      </div>

      {/*
        어디서 찾을까 — 모집단. 거래대금 상위의 초록(돈이 몰린 것)과 연속매매의
        초록(수급이 미는 것)은 다른 종류의 후보다. 목록마다 신호등을 돌려 본다.
      */}
      <div className="filter-row ctl-ribbon">
        <span className="filter-label">목록</span>
        {universes.map((u) => (
          <button
            key={u.key}
            className={`filter-btn ${universe === u.key ? "active" : ""}`}
            onClick={() => setUniverse(u.key)}
            disabled={running}
            title={u.hint}
          >
            {u.label}
          </button>
        ))}
      </div>

      <div className="filter-row ctl-ribbon">
        <span className="filter-label">검사 범위</span>
        {LIMITS.map((n) => (
          <button
            key={n}
            className={`filter-btn ${limit === n ? "active" : ""}`}
            onClick={() => setLimit(n)}
            disabled={running}
            title={`상위 ${n}종목을 검사합니다${n >= 300 ? " — 몇 분 걸립니다" : ""}`}
          >
            {n}
          </button>
        ))}
        {/* 자유 입력 — 버튼 다섯 개가 정답일 리 없다. 10~500 사이에서 서버가 자른다 */}
        <input
          className="pt-input short"
          type="number"
          inputMode="numeric"
          min={10}
          max={500}
          value={limit}
          disabled={running}
          onChange={(e) => {
            const n = Math.round(Number(e.target.value));
            if (Number.isFinite(n)) setLimit(Math.min(500, Math.max(10, n)));
          }}
          title="상위 몇 종목까지 검사할지 — 10~500"
        />
        <span className="pt-n">종목</span>
        <span className="breadth-count">
          {uniLabel()}에서 · {limit >= 300 ? "몇 분 걸립니다" : `약 ${Math.ceil((limit * 0.3) / 6) / 10}분`}
        </span>
      </div>

      {/* 처음 한 번 읽으면 되는 설명 — 접어 둔다(컨트롤 다이어트) */}
      <details className="fold-note">
        <summary>어떻게 찾는지 · 얼마나 걸리는지</summary>
        <p className="page-note">
          <b>고른 시장·고른 목록</b>에서 「설정 &gt; 신호등 기준」에 맞는 종목을 찾습니다 —
          「찾을 곳」은 결과를 나누는 게 아니라 <b>훑을 범위를 좁히는 것</b>입니다.
          목록은 후보의 성격을 정합니다 — 거래대금 상위의 초록(돈이 몰린 것)과
          외국인 연속순매매의 초록(수급이 미는 것)은 <b>다른 종류의 후보</b>입니다.
          연속매매·동일순매매 같은 목록은 키움이 100건 안팎만 주므로 검사 범위를 크게
          잡아도 그만큼만 봅니다.
          「전체」로 뽑으면 대개 코스피 대형주가 자리를 채우므로, 코스닥에서 도는 것을 보려면
          따로 좁혀야 걸립니다.
          ETF·ETN·리츠·우선주는 빼고 세므로 「상위 100」은 실제 종목 100개입니다. 종목마다
          차트·수급·재무를 조회하므로 100종목이면 <b>1~2분</b> 걸립니다. 신호등 결과는 15분
          캐시를 타므로 두 번째 실행은 훨씬 빠릅니다.
        </p>
      </details>

      {error && <div className="error-banner">{error}</div>}
      {job?.error && <div className="error-banner">{job.error}</div>}

      {running && (
        <div className="progress-bar" style={{ marginBottom: 10 }}>
          <div className="progress-bar-fill" style={{ width: `${progress}%`, background: "var(--blue)" }} />
        </div>
      )}

      {runs.length > 0 && (
        <div className="filter-row">
          <span className="tg-ctl-label">지난 기록</span>
          <select className="tg-select" value={viewing} onChange={(e) => void openRun(e.target.value)}>
            <option value="">방금 돌린 것</option>
            {runs.map((r) => (
              <option key={r.id} value={r.id}>
                {new Date(new Date(r.at).getTime() + 9 * 3600_000)
                  .toISOString()
                  .slice(5, 16)
                  .replace("T", " ")}{" "}
                · {r.hits}종목 / {r.total}검사 ·{" "}
                {r.market === "001" ? "코스피" : r.market === "101" ? "코스닥" : "전체"} ·{" "}
                {uniLabel(r.universe ?? "trade-value")}
              </option>
            ))}
          </select>
          <span className="tg-ctl-hint">최근 {runs.length}회 보관 · 다시 조회하지 않습니다</span>
        </div>
      )}

      {diff && (
        <div className="page-note">
          <b>직전 회차 대비</b> — 새로 들어옴{" "}
          <b className="positive">
            {diff.added.length > 0 ? diff.added.map((x) => x.name).join(", ") : "없음"}
          </b>
          {" / "}빠짐{" "}
          <b className="negative">
            {diff.removed.length > 0 ? diff.removed.map((x) => x.name).join(", ") : "없음"}
          </b>
        </div>
      )}

      {job && (
        <>
          {/*
            ⚠️ 예전엔 「421/421 검사 · 조건 통과 3종목」뿐이었다. 그러면 **왜 421 인지**
            알 수가 없다 — 상위 500 을 골랐는데 421 이 나오니 고장으로 보인다.
            그리고 결과에 없는 종목이 「점수가 모자라서」인지 「모집단 밖이라서」인지도
            구별이 안 된다. 그 둘은 완전히 다른 이야기다.

            그래서 **고른 수 → 실제 모집단 → 통과/미달**을 한 줄에 다 적는다.
          */}
          <div className="filter-row">
            <span className="breadth-count">
              {uniLabel(job.universe ?? "trade-value")} <b>{limit}</b> 중 보통주{" "}
              <b>{job.total}종목</b>
              {job.total < limit && <i className="scr-stale">ETF·우선주 제외 / 목록이 짧음</i>} · 검사{" "}
              {job.done} · 통과 <b className="positive">{job.results.length}</b> · 미달{" "}
              {Math.max(0, job.done - job.results.length)}
              {job.status === "done" && " · 완료"}
            </span>
          </div>
          {job.status === "done" && (
            <p className="page-note">
              여기 없는 종목은 <b>둘 중 하나</b>입니다 — 검사했는데 문턱에 못 미쳤거나(
              {Math.max(0, job.done - job.results.length)}종목), 애초에{" "}
              <b>{uniLabel(job.universe ?? "trade-value")} {limit} 밖</b>이라 안 봤거나.
              다른 화면과 결과가 다르면 대개 <b>모집단이 다른 것</b>입니다 — 목록이 곧
              후보의 성격입니다.
            </p>
          )}

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
                    {/*
                      개장 전에 돌리면 등락률·거래대금이 0 으로 온다. 그걸 그대로 적으면
                      「0.00% · 0억」이 줄줄이 서서, 안 움직인 것인지 아직 안 열린 것인지
                      구별이 안 된다. 서버가 직전 거래일 값으로 메우면서 `stale` 을 달아
                      주므로 **메운 값이라고 적는다.** 거래대금은 메울 재료가 없어 「-」다.
                    */}
                    <td className={`num ${r.changeRate > 0 ? "positive" : r.changeRate < 0 ? "negative" : ""}`}>
                      {pct(r.changeRate)}
                      {r.stale && <i className="scr-stale" title="개장 전이라 직전 거래일 값입니다">전일</i>}
                    </td>
                    <td className="num">
                      {r.tradeValue > 0 ? (
                        `${fmtNum(Math.round(r.tradeValue / 100))}억`
                      ) : (
                        <span className="pt-n" title="개장 전이라 오늘 거래대금이 없습니다">
                          -
                        </span>
                      )}
                    </td>
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

      {addTarget && <WatchAddSheet target={addTarget} onClose={() => setAddTarget(null)} />}

      {!job && (
        <div className="page-note">
          「찾기」를 누르면 시작합니다. 결과에서 <b>+ 관심</b>을 누르면 바로 관심종목에 담겨
          그때부터 수익률과 수급이 추적됩니다.
        </div>
      )}
    </div>
      )}
    </div>
  );
}
