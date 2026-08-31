import { useCallback, useEffect, useState } from "react";
import {
  api,
  fmtNum,
  signClass,
  type CondGroup,
  type CondJob,
  type CondPreset,
  type CondQuery,
  type SignalCheckConfig,
} from "../api";
import { useSignals, SignalDot } from "../components/SignalLight";
import { WatchStar } from "../useWatchedCodes";
import { SuperMark } from "../useSuperMarks";

/**
 * 조건 검색 — **증권사 조건검색식처럼.**
 *
 * 벤티지: "조건은 신호등에 있는 조건들 그거를 쓸 수 있도록 하자. 이건 가중치가
 * 아니라 그걸 통과하냐 마느냐. AND 조건, OR 조건 이렇게 해서 아예 필터를 걸어
 * 그 리스트만 볼 수 있게."
 *
 * ## 신호등과 무엇이 다른가
 *
 * 신호등은 **점수**다. 한두 기준이 나빠도 나머지가 좋으면 걸린다 — 좋은 점이지만,
 * 그래서 **「정배열인 것만」을 못 고른다.** 점수 안에 묻힌다.
 *
 * 여기는 **이분법**이다. 「정배열 AND 영업이익 증가」를 그대로 쓴다.
 *
 * ## 점수는 눌러야 매긴다
 *
 * 벤티지: "검색하고 나면 시세분석 메뉴에 있는 것처럼 신호등 점수 매기기 딱 누르면
 * 나온 결과에 대해서 신호등 점수도 볼 수 있게."
 *
 * 필터로 좁힌 다음 **그 목록에만** 점수를 매긴다 — 목록을 여는 것만으로 백 종목을
 * 평가하지 않는다. 시세분석의 「🚦 신호등 켜기」와 같은 문법이다.
 */

const UNIVERSES: { key: string; label: string }[] = [
  { key: "trade-value", label: "거래대금 상위" },
  { key: "flu-rate", label: "등락률 상위" },
  { key: "cum", label: "누적등락률 (5일)" },
  { key: "foreign-cont", label: "외국인 연속순매매" },
  { key: "foreign-period", label: "외국인 순매수 상위" },
  { key: "cont", label: "기관·외국인 연속매매" },
  { key: "same-net", label: "동일순매매 (7일)" },
];

const MARKETS = [
  { key: "000", label: "전체" },
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
];

const EMPTY: CondQuery = {
  universe: "trade-value",
  market: "000",
  limit: 200,
  capMin: null,
  capMax: null,
  groups: [{ join: "and", conds: [] }],
};

export function CondSearchPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [checks, setChecks] = useState<SignalCheckConfig[]>([]);
  const [q, setQ] = useState<CondQuery>(EMPTY);
  const [job, setJob] = useState<CondJob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [presets, setPresets] = useState<CondPreset[]>([]);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  /* 점수는 **켤 때만** — 목록을 여는 것만으로 백 종목을 평가하면 안 된다 */
  const [sigOn, setSigOn] = useState(false);

  useEffect(() => {
    void api
      .signalConfig()
      .then((r) => setChecks(r.defaults.checks))
      .catch(() => undefined);
    void api
      .condPresets()
      .then((r) => setPresets(r.presets))
      .catch(() => undefined);
  }, []);

  /* 도는 동안 진행률을 본다 — 끝나면 멈춘다 */
  useEffect(() => {
    if (!jobId) return;
    let alive = true;
    const tick = () => {
      void api
        .condJob(jobId)
        .then((j) => {
          if (!alive) return;
          setJob(j);
          if (j.status === "running") window.setTimeout(tick, 1200);
        })
        .catch(() => undefined);
    };
    tick();
    return () => {
      alive = false;
    };
  }, [jobId]);

  const codes = (job?.results ?? []).map((r) => r.code);
  const signals = useSignals(sigOn ? codes : []);

  const run = useCallback(async () => {
    setErr(null);
    try {
      const r = await api.condStart(q);
      setJobId(r.jobId);
      setJob(null);
      setSigOn(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "실행에 실패했습니다");
    }
  }, [q]);

  const totalConds = q.groups.reduce((a, g) => a + g.conds.length, 0);

  /** 조건에 쓰인 기준이 종목당 조회를 몇 번 더 부르나 — 미리 알려 준다 */
  const cost = (() => {
    const used = new Set(q.groups.flatMap((g) => g.conds.map((c) => c.key)));
    const groups = new Set<string>();
    let n = 0;
    for (const c of checks) {
      if (!used.has(c.key) || c.cost <= 0) continue;
      if (c.costGroup) {
        if (groups.has(c.costGroup)) continue;
        groups.add(c.costGroup);
      }
      n += c.cost;
    }
    return n;
  })();

  const patchGroup = (i: number, next: Partial<CondGroup>) =>
    setQ((p) => ({ ...p, groups: p.groups.map((g, k) => (k === i ? { ...g, ...next } : g)) }));

  const toggleCond = (i: number, key: string) =>
    setQ((p) => ({
      ...p,
      groups: p.groups.map((g, k) => {
        if (k !== i) return g;
        const at = g.conds.findIndex((c) => c.key === key);
        if (at < 0) return { ...g, conds: [...g.conds, { key, want: true }] };
        /* 통과 → 미달 → 뺀다 — 세 번 누르면 원래대로 */
        if (g.conds[at].want) {
          const conds = [...g.conds];
          conds[at] = { key, want: false };
          return { ...g, conds };
        }
        return { ...g, conds: g.conds.filter((c) => c.key !== key) };
      }),
    }));

  const stateOf = (i: number, key: string): "off" | "pass" | "fail" => {
    const c = q.groups[i]?.conds.find((x) => x.key === key);
    return !c ? "off" : c.want ? "pass" : "fail";
  };

  return (
    <div className="cond">
      <p className="page-note">
        <b>신호등의 기준을 통과/미달 필터로 씁니다</b> — 점수가 아니라 이분법입니다.
        점수는 한두 기준이 나빠도 나머지가 좋으면 걸리는데, 그래서 「정배열인 것만」을
        못 고릅니다. 여기서는 <b>그룹 안은 AND 또는 OR, 그룹끼리는 항상 AND</b> 입니다.
      </p>

      {/* ── 저장한 조건식 ── */}
      {presets.length > 0 && (
        <div className="filter-row cond-presets">
          <span className="pt-n">저장한 식</span>
          {presets.map((p) => (
            <span key={p.id} className="cond-preset">
              <button
                className="filter-btn"
                onClick={() => setQ(p.query)}
                title={
                  `${new Date(p.savedAt).toLocaleDateString("ko-KR")} 저장` +
                  (p.lastRunAt
                    ? ` · 마지막 실행 ${new Date(p.lastRunAt).toLocaleDateString("ko-KR")}에 ${p.lastHits ?? 0}개`
                    : " · 아직 안 돌림")
                }
              >
                {p.name}
                {typeof p.lastHits === "number" && <i className="cond-hits">{p.lastHits}</i>}
              </button>
              <button
                className="cond-x"
                onClick={() => {
                  if (!window.confirm(`「${p.name}」을 지울까요?`)) return;
                  void api.condPresetRemove(p.id).then((r) => setPresets(r.presets));
                }}
                title="이 식을 지웁니다"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
      )}

      {/* ── 어디서 찾나 ── */}
      <section className="card">
        <h2>어디서 찾나</h2>
        <div className="filter-row">
          {UNIVERSES.map((u) => (
            <button
              key={u.key}
              className={`filter-btn ${q.universe === u.key ? "active" : ""}`}
              onClick={() => setQ((p) => ({ ...p, universe: u.key }))}
            >
              {u.label}
            </button>
          ))}
        </div>
        <div className="filter-row">
          {MARKETS.map((m) => (
            <button
              key={m.key}
              className={`filter-btn ${q.market === m.key ? "active" : ""}`}
              onClick={() => setQ((p) => ({ ...p, market: m.key }))}
            >
              {m.label}
            </button>
          ))}
          <span className="pt-n">상위</span>
          {[100, 200, 500].map((n) => (
            <button
              key={n}
              className={`filter-btn ${q.limit === n ? "active" : ""}`}
              onClick={() => setQ((p) => ({ ...p, limit: n }))}
            >
              {n}
            </button>
          ))}
        </div>
        {/*
          시가총액은 **조회 0회**로 걸러진다 — 상장주식수(하루 캐시) × 현재가다.
          여기서 좁히면 아래 조건 평가가 그만큼 안 나간다.
        */}
        <div className="filter-row cond-cap">
          <span className="pt-n">시가총액(억)</span>
          <input
            type="number"
            placeholder="하한"
            value={q.capMin ?? ""}
            onChange={(e) =>
              setQ((p) => ({ ...p, capMin: e.target.value === "" ? null : Number(e.target.value) }))
            }
          />
          <span className="pt-n">~</span>
          <input
            type="number"
            placeholder="상한"
            value={q.capMax ?? ""}
            onChange={(e) =>
              setQ((p) => ({ ...p, capMax: e.target.value === "" ? null : Number(e.target.value) }))
            }
          />
          <span className="table-note">시총은 조회 없이 걸러집니다 — 여기서 좁힐수록 빨라집니다</span>
        </div>
      </section>

      {/* ── 조건 ── */}
      {q.groups.map((g, i) => (
        <section className="card cond-group" key={i}>
          <div className="cond-group-head">
            <b>조건 {i + 1}</b>
            <div className="filter-row">
              {(["and", "or"] as const).map((j) => (
                <button
                  key={j}
                  className={`filter-btn ${g.join === j ? "active" : ""}`}
                  onClick={() => patchGroup(i, { join: j })}
                  title={j === "and" ? "이 그룹의 조건을 모두 만족해야 합니다" : "하나만 만족해도 됩니다"}
                >
                  {j === "and" ? "모두 (AND)" : "하나라도 (OR)"}
                </button>
              ))}
              {q.groups.length > 1 && (
                <button
                  className="filter-btn"
                  onClick={() => setQ((p) => ({ ...p, groups: p.groups.filter((_, k) => k !== i) }))}
                >
                  그룹 빼기
                </button>
              )}
            </div>
          </div>
          <div className="mg-picker">
            {checks.map((c) => {
              const st = stateOf(i, c.key);
              return (
                <button
                  key={c.key}
                  className={`mg-chip cond-chip ${st}`}
                  onClick={() => toggleCond(i, c.key)}
                  title={`${c.hint}\n\n한 번 누르면 「통과」, 두 번이면 「미달」, 세 번이면 뺍니다${c.cost > 0 ? `\n⚠️ 종목당 조회 ${c.cost}회 추가` : ""}`}
                >
                  {st === "off" ? "☐" : st === "pass" ? "☑" : "✕"} {c.label}
                  {st === "fail" && <i className="cond-not"> 미달</i>}
                  {c.cost > 0 && <i className="cond-cost">+{c.cost}</i>}
                </button>
              );
            })}
          </div>
        </section>
      ))}

      <div className="filter-row">
        <button
          className="filter-btn"
          onClick={() => setQ((p) => ({ ...p, groups: [...p.groups, { join: "and", conds: [] }] }))}
        >
          + 조건 그룹 (AND 로 이어집니다)
        </button>
      </div>

      {/* ── 실행·저장 ── */}
      <div className="filter-row cond-run">
        <button
          className="filter-btn primary"
          onClick={() => void run()}
          disabled={totalConds === 0 || job?.status === "running"}
        >
          {job?.status === "running" ? `찾는 중… ${job.done}/${job.total}` : "🔎 검색"}
        </button>
        <input
          className="search-input cond-name"
          placeholder="이 조건식 이름 (저장용)"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <button
          className="filter-btn"
          disabled={!name.trim() || totalConds === 0}
          onClick={() => {
            void api
              .condPresetSave(name, q)
              .then((r) => {
                setPresets(r.presets);
                setName("");
              })
              .catch((e: Error) => setErr(e.message));
          }}
          title="같은 이름이면 덮어씁니다"
        >
          💾 저장
        </button>
        <span className="pt-n">
          조건 {totalConds}개
          {cost > 0 && ` · 종목당 조회 +${cost}회`}
        </span>
      </div>

      {err && <div className="error-banner">{err}</div>}

      {/* ── 결과 ── */}
      {job && (
        <section className="card">
          <div className="cond-result-head">
            <b>
              {job.status === "running" ? "찾는 중" : "결과"} — {job.results.length}종목
            </b>
            <span className="pt-n">
              {job.query.limit}개 중 {job.prefiltered}개를 검사
              {job.prefiltered < job.query.limit && " (시총·시장으로 미리 걸렀습니다)"}
            </span>
            {job.results.length > 0 && (
              <button
                className={`filter-btn ${sigOn ? "active" : ""}`}
                onClick={() => setSigOn((v) => !v)}
                title="이 목록에만 신호등을 매깁니다 — 처음엔 좀 걸립니다"
              >
                🚦 신호등 점수 {sigOn ? "끄기" : "매기기"}
              </button>
            )}
          </div>

          {job.status === "error" && <div className="error-banner">{job.error}</div>}

          {job.results.length === 0 && job.status === "done" ? (
            <div className="empty">
              걸린 종목이 없습니다. 조건을 줄이거나 모집단을 넓혀 보세요.
            </div>
          ) : (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th />
                    <th>종목</th>
                    <th className="num">현재가</th>
                    <th className="num">등락률</th>
                    <th className="num">시가총액</th>
                    {sigOn && <th className="num">신호등</th>}
                    <th>걸린 조건</th>
                  </tr>
                </thead>
                <tbody>
                  {job.results.map((r) => {
                    const sig = signals[r.code];
                    return (
                      <tr key={r.code} onClick={() => onSelectStock(r.code, r.name)}>
                        <td>
                          <WatchStar code={r.code} />
                          <SuperMark code={r.code} />
                        </td>
                        <td>{r.name}</td>
                        <td className="num">{fmtNum(r.price)}</td>
                        <td className={`num ${signClass(r.changeRate)}`}>
                          {r.changeRate > 0 ? "+" : ""}
                          {r.changeRate.toFixed(2)}%
                          {r.stale && <i className="scr-stale">전일</i>}
                        </td>
                        <td className="num">
                          {r.marketCap === null
                            ? "-"
                            : r.marketCap >= 10000
                              ? `${(r.marketCap / 10000).toFixed(1)}조`
                              : `${fmtNum(r.marketCap)}억`}
                        </td>
                        {sigOn && (
                          <td className="num">
                            {sig ? (
                              <>
                                <SignalDot signal={sig} /> {sig.score}
                              </>
                            ) : (
                              <span className="pt-n">…</span>
                            )}
                          </td>
                        )}
                        <td className="pt-n">{r.matched.join(" · ")}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
