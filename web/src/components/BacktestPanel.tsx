import { useEffect, useRef, useState } from "react";
import {
  api,
  type BacktestJob,
  type BacktestRuleDef,
  type BacktestRuleKey,
  type BacktestStat,
} from "../api";

/**
 * 조건 백테스트 — **「이 조건으로 들어갔으면 과거에 어땠나」**.
 *
 * ## 이 화면이 지키는 두 가지
 *
 * **1. 기준선을 반드시 같이 보여준다.**
 * 「평균 +2.0%」만 적으면 좋아 보인다. 그런데 같은 기간에 아무거나 샀어도 +1.9% 였다면
 * 그 조건은 아무것도 아니다. 상승장에서는 어떤 조건이든 좋아 보인다. 그래서 조건 결과
 * 옆에 **조건 없이 잰 같은 숫자**를 나란히 두고, **차이(edge)** 를 제일 크게 적는다.
 *
 * **2. 잘된 사례만 보여주지 않는다.**
 * 상위 다섯 개만 늘어놓으면 그건 검증이 아니라 광고다. **양 끝을 같이** 보여준다.
 *
 * **3. 실행이 기록으로 남는다** (2026-08-25 — 「히스토리가 없으니 통찰이 없다」).
 * 통찰은 실행 하나가 아니라 실행들 사이의 비교에서 나온다 — 「정배열 +0.8%p,
 * 60일 신고가 +3.8%p」. 돌 때마다 서버에 남고, 아래 리더보드가 엣지 순으로 세운다.
 * 조건 요약이 라벨로 붙으므로 어느 실행이 어느 조건이었는지 안 헷갈린다.
 */

const MARKETS = [
  { key: "000", label: "전체" },
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
] as const;

const HOLDS = [1, 3, 5, 10, 20];
const UNIVERSES = [20, 50, 100, 200];

function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** 조건 결과와 기준선을 **같은 모양**으로 — 나란히 놓아야 견줄 수 있다 */
function StatRow({ label, s, dim }: { label: string; s: BacktestStat; dim?: boolean }) {
  return (
    <div className={`cost-row bt-row${dim ? " dim" : ""}`}>
      <span className="cost-name">{label}</span>
      <span className={`num jn-edge-ret ${s.avg >= 0 ? "positive" : "negative"}`}>{pct(s.avg)}</span>
      <span className="num jn-edge-win" title="중앙값 — 한 종목이 +90%면 평균이 혼자 올라간다">
        {pct(s.median)}
      </span>
      <span className="num jn-edge-win">{s.winRate.toFixed(0)}%</span>
      <span className="num cost-usd">{s.count.toLocaleString("ko-KR")}건</span>
    </div>
  );
}

type RunRow = Awaited<ReturnType<typeof api.backtestRuns>>["runs"][number];

export function BacktestPanel() {
  const [defs, setDefs] = useState<BacktestRuleDef[]>([]);
  const [on, setOn] = useState<Partial<Record<BacktestRuleKey, number>>>({ maAlign: 0 });
  const [market, setMarket] = useState("000");
  const [universe, setUniverse] = useState(50);
  const [holdDays, setHoldDays] = useState(5);
  const [job, setJob] = useState<BacktestJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [gridBusy, setGridBusy] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadRuns = () => {
    api
      .backtestRuns()
      .then((r) => setRuns(r.runs))
      .catch(() => undefined);
  };

  useEffect(() => {
    api
      .backtestRules()
      .then((r) => setDefs(r.rules))
      .catch((e: Error) => setError(e.message));
    loadRuns();
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
  }, []);

  async function run() {
    setError(null);
    try {
      const rules = (Object.keys(on) as BacktestRuleKey[]).map((k) => ({
        key: k,
        value: on[k] ?? 0,
      }));
      const { id } = await api.backtestRun({ market, universe, holdDays, rules });
      setJob({ status: "running", total: 0, done: 0, startedAt: "", result: null });
      if (poll.current) clearInterval(poll.current);
      poll.current = setInterval(() => {
        void api
          .backtestJob(id)
          .then((j) => {
            setJob(j);
            if (j.status !== "running" && poll.current) {
              clearInterval(poll.current);
              loadRuns(); // 끝나면 기록에 남았으니 리더보드를 새로 받는다
            }
          })
          .catch(() => undefined);
      }, 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : "시작 실패");
    }
  }

  const running = job?.status === "running";
  const r = job?.result;
  const ruleCount = Object.keys(on).length;

  return (
    <div>
      <p className="page-note">
        고른 <b>거래대금 상위</b> 종목의 <b>일봉</b>으로, 조건에 맞는 날마다{" "}
        <b>다음 날 시가에 사서 {holdDays}거래일 뒤 종가에 판</b> 결과를 셉니다.
        <br />
        ⚠️ 조건은 그날 <b>종가</b>로 판정하므로 그 종가로 사면 미래를 쓴 것이 됩니다. 그래서{" "}
        <b>다음 날 시가</b>에 삽니다 — 이 한 줄이 결과를 몇 %p 씩 바꿉니다.
      </p>

      <div className="filter-row">
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
        <span className="filter-label">종목 수</span>
        {UNIVERSES.map((u) => (
          <button
            key={u}
            className={`filter-btn ${universe === u ? "active" : ""}`}
            onClick={() => setUniverse(u)}
            disabled={running}
            title={`일봉 ${u}회 — 대략 ${Math.max(1, Math.round((u * 0.3) / 6) * 6)}초`}
          >
            {u}
          </button>
        ))}
        <span className="news-scope-sep" />
        <span className="filter-label">보유</span>
        {HOLDS.map((h) => (
          <button
            key={h}
            className={`filter-btn ${holdDays === h ? "active" : ""}`}
            onClick={() => setHoldDays(h)}
            disabled={running}
          >
            {h}일
          </button>
        ))}
      </div>

      <div className="filter-row">
        <span className="filter-label">조건</span>
        {defs.map((d) => {
          const active = d.key in on;
          return (
            <span key={d.key} className="bt-rule">
              <button
                className={`filter-btn ${active ? "active" : ""}`}
                title={d.hint}
                disabled={running}
                onClick={() => {
                  const next = { ...on };
                  if (active) delete next[d.key];
                  else next[d.key] = d.defaultValue;
                  setOn(next);
                }}
              >
                {d.label}
              </button>
              {active && d.hasValue && (
                <input
                  className="pt-input short"
                  inputMode="decimal"
                  value={on[d.key] ?? d.defaultValue}
                  disabled={running}
                  onChange={(e) => setOn({ ...on, [d.key]: Number(e.target.value) || 0 })}
                />
              )}
            </span>
          );
        })}
        <button className="algo-run-btn" onClick={() => void run()} disabled={running || ruleCount === 0}>
          {running ? `검사 중 ${job?.done}/${job?.total || "…"}` : "돌리기"}
        </button>
      </div>
      {ruleCount === 0 && (
        <p className="page-note">조건을 하나 이상 고르세요 — 조건이 없으면 기준선과 같은 값입니다.</p>
      )}

      {error && <div className="error-banner">{error}</div>}
      {job?.status === "error" && <div className="error-banner">{job.error}</div>}

      {r && (
        <>
          <div className="filter-row">
            <span className="breadth-count">
              {r.codes}종목 · {r.from.slice(0, 4)}-{r.from.slice(4, 6)} ~ {r.to.slice(0, 4)}-
              {r.to.slice(4, 6)}
              {r.failed > 0 && <i className="scr-stale">{r.failed}종목은 일봉이 짧아 제외</i>}
            </span>
          </div>

          {/*
            **차이를 제일 크게 적는다.** 「평균 +2.0%」는 혼자서는 아무 말도 못 한다 —
            같은 기간에 아무거나 샀어도 +1.9% 였다면 그 조건은 아무것도 아니다.
          */}
          <div className="bt-edge">
            <span className="bt-edge-k">조건이 만든 차이</span>
            {r.edge === null ? (
              <b className="bt-edge-v">—</b>
            ) : (
              <b className={`bt-edge-v ${r.edge > 0 ? "positive" : "negative"}`}>
                {r.edge > 0 ? "+" : ""}
                {r.edge.toFixed(2)}%p
              </b>
            )}
            <small>
              같은 종목·같은 기간에 <b>조건 없이</b> 산 것과 견준 값입니다.
              {r.hit.count < 100 && (
                <>
                  {" "}
                  ⚠️ <b>{r.hit.count}건은 적습니다</b> — 표본이 수백 건은 돼야 우연이 아닙니다.
                </>
              )}
            </small>
          </div>

          <div className="jn-edge">
            <StatRow label="조건에 걸린 날" s={r.hit} />
            <StatRow label="아무 날이나 (기준선)" s={r.base} dim />
            <div className="jn-stat-note">평균 · 중앙값 · 승률 · 건수 순입니다.</div>
          </div>

          {/*
            잘된 것만 보여주면 검증이 아니라 광고다. 위 다섯과 아래 다섯을 같이 놓는다 —
            **최악이 얼마나 나쁜지**가 실제로는 더 중요한 정보다.
          */}
          {r.samples.length > 0 && (
            <div className="jn-stat-block wide">
              <div className="cost-sub">양 끝 사례 — 제일 잘된 것과 제일 나빴던 것</div>
              <div className="jn-edge">
                {r.samples.map((s, i) => (
                  <div className="cost-row bt-row" key={`${s.code}${s.date}${i}`}>
                    <span className="cost-name">
                      {s.name}{" "}
                      <i className="scr-stale">
                        {s.date.slice(0, 4)}-{s.date.slice(4, 6)}-{s.date.slice(6, 8)}
                      </i>
                    </span>
                    <span className={`num jn-edge-ret ${s.rate >= 0 ? "positive" : "negative"}`}>
                      {pct(s.rate)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <p className="page-note">
            ⚠️ <b>수수료·세금·슬리피지를 안 뺐습니다.</b> 조건과 기준선 양쪽에 똑같이 빠지므로{" "}
            <b>차이</b>는 그대로지만 절대 수익률은 이보다 낮습니다.
            <br />⚠️ <b>상장폐지된 종목이 모집단에 없습니다.</b> 오늘 거래대금 상위에 있는
            종목들이니 <b>살아남은 것만</b> 본 셈입니다 — 결과를 그만큼 좋게 봅니다.
            <br />⚠️ 「신호등 점수」 조건은 <b>점수 축적(2026-08-25~) 이후 날짜만</b> 잡습니다 —
            날이 쌓일수록 표본이 늘어 정확해집니다. 나머지 조건은 전부 일봉으로 계산됩니다.
          </p>
        </>
      )}

      {/*
        리더보드 — **이 화면의 진짜 산출물.**
        실행 하나의 숫자는 반쪽이고, 조건끼리 견줘야 「무엇이 일을 하나」가 나온다.
        엣지 순으로 세우고 판정 한 줄을 붙인다 — 표본이 적은 것은 판정이 그렇게 말한다.
      */}
      {runs.length > 0 && (
        <div className="bt-board">
          <h3 className="section-heading">
            돌려 본 조건들 — 엣지 순 <i className="pt-n">{runs.length}회 저장됨</i>
            <button
              className="filter-btn bt-grid-btn"
              disabled={gridBusy}
              title="정해진 조합 ~18개를 한 번에 — 일봉은 한 번만 받아 조합은 메모리로 계산합니다"
              onClick={() => {
                setGridBusy(true);
                api
                  .backtestGrid()
                  .then(() => loadRuns())
                  .catch((e: Error) => setError(e.message))
                  .finally(() => setGridBusy(false));
              }}
            >
              {gridBusy ? "그리드 도는 중…" : "그리드 지금 돌리기"}
            </button>
          </h3>
          <div className="data-table-wrap">
            <table className="data-table num">
              <thead>
                <tr>
                  <th className="sticky-col">조건</th>
                  <th title="조건 평균 − 기준선 평균 (%p) — 이게 진짜 성적">엣지</th>
                  <th>조건 평균</th>
                  <th>기준선</th>
                  <th>승률</th>
                  <th>표본</th>
                  <th>돌린 날</th>
                </tr>
              </thead>
              <tbody>
                {[...runs]
                  .sort((a, b) => (b.edge ?? -999) - (a.edge ?? -999))
                  .map((x) => (
                    <tr key={x.id}>
                      <td className="sticky-col bt-board-label">
                        {x.auto && <i className="bt-auto" title="밤 그리드가 자동으로 돌린 실행">자동</i>}
                        {x.label}
                        <div className={`bt-verdict ${x.verdict.tone}`}>{x.verdict.text}</div>
                      </td>
                      <td className={x.edge !== null && x.edge >= 0 ? "positive" : "negative"}>
                        <b>
                          {x.edge === null ? "-" : `${x.edge > 0 ? "+" : ""}${x.edge.toFixed(2)}%p`}
                        </b>
                      </td>
                      <td className={x.hit.avg >= 0 ? "positive" : "negative"}>{pct(x.hit.avg)}</td>
                      <td className="pt-n">{pct(x.base.avg)}</td>
                      <td>{x.hit.winRate.toFixed(0)}%</td>
                      <td>{x.hit.count.toLocaleString("ko-KR")}</td>
                      <td className="pt-n">{x.at.slice(5, 10)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="table-note">
            같은 조건도 <b>기간·모집단이 다르면 다른 실행</b>입니다 — 라벨 끝 괄호가 그것입니다.
            표본이 적은 줄은 판정이 「우연일 수 있다」고 말합니다. 최근 60회까지 남습니다.
            <b>「자동」</b>은 평일 17:10 밤 그리드가 돌린 것 — 어제 그리드는 오늘 것으로
            바뀌고, 손으로 돌린 실행은 그대로 남습니다.
          </div>
        </div>
      )}
    </div>
  );
}
