import { useCallback, useEffect, useState } from "react";
import {
  api,
  fmtNum,
  signClass,
  type CondJob,
  type CondLine,
  type CondPreset,
  type CondQuery,
  type CondField,
} from "../api";
import { useSignals, SignalDot } from "../components/SignalLight";
/* 접기 — 신호등 분석과 **같은 훅**. 「화면 차지가 꽤 되네」 (2026-09-01) */
import { useFold } from "../useFold";
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
  lines: [],
};

/**
 * 조건마다 쓸 수 있는 비교가 다르다 — 서버 사전(`CondField.ops`)이 정한다.
 *
 * 예전엔 화면이 `NO_VALUE = new Set(["trend"])` 를 들고 있었다. 조건 전용 필드
 * (흑자 전환 등)가 늘 때마다 그 집합을 같이 고쳐야 했고, 안 고치면 **값 칸이
 * 뜻 없이 열려** 사람이 못 쓸 값을 넣게 된다.
 */

const OPS: { key: CondLine["op"]; label: string; hint: string }[] = [
  { key: "gte", label: "≥", hint: "잰 값이 이 값 이상" },
  { key: "lte", label: "≤", hint: "잰 값이 이 값 이하" },
  { key: "pass", label: "통과", hint: "신호등 기준을 통과 — 문턱은 설정을 따릅니다" },
  { key: "fail", label: "미달", hint: "신호등 기준에 미달" },
];

export function CondSearchPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  /**
   * **조건 필드 사전** — 서버가 준다.
   *
   * 예전엔 `signalConfig().defaults.checks` 를 그대로 깔았다. 그래서 조건 이름이
   * 「덩치 (클수록 안 움직인다)」였고 단위가 어디에도 없었다. 벤티지: "덩치? 이건
   * 뭐야. 해석을 해야지 넌 AI 잖아."
   */
  const [fields, setFields] = useState<CondField[]>([]);
  const [q, setQ] = useState<CondQuery>(EMPTY);
  const [job, setJob] = useState<CondJob | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [presets, setPresets] = useState<CondPreset[]>([]);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  /* 점수는 **켤 때만** — 목록을 여는 것만으로 백 종목을 평가하면 안 된다 */
  const [sigOn, setSigOn] = useState(false);
  /*
   * 접기 — 「어디서 찾나」는 자주 바꾸니 펴 두고, 「기준 더하기」는 칩이 스물아홉
   * 개라 **접어 둔다.** 조건을 다 넣고 나면 그 목록은 안 봐도 된다.
   */
  const [openWhere, toggleWhere] = useFold("where", true, "cond");
  const [openPick, togglePick] = useFold("pick", false, "cond");
  const [openLines, toggleLines] = useFold("lines", true, "cond");

  useEffect(() => {
    void api
      .condFields()
      .then((r) => setFields(r.fields))
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

  const totalConds = q.lines.length;

  /**
   * 조건에 쓰인 기준이 종목당 조회를 얼마나 부르나 — **미리 말해 준다.**
   *
   * 사전이 사람 말로 적어 두었으므로(「수급 1콜」·「조회 없음」) 같은 응답을
   * 나눠 쓰는 것들은 한 번만 센다. 숫자로 세지 않는 이유: 「수급 1콜」과
   * 「지속과 같은 응답」을 더하면 2가 되는데 실제로는 1이다.
   */
  const costs = (() => {
    const used = new Set(q.lines.map((l) => l.key));
    const set = new Set<string>();
    for (const f of fields) {
      if (!used.has(f.key) || !f.cost || f.cost.startsWith("조회 없음")) continue;
      /* 「수급 1콜 (지속과 같은 응답)」 → 「수급 1콜」로 묶는다 */
      set.add(f.cost.replace(/\s*\(.*$/, ""));
    }
    return [...set];
  })();

  /** 줄 하나 고치기 */
  const patchLine = (i: number, next: Partial<CondLine>) =>
    setQ((p) => ({ ...p, lines: p.lines.map((l, k) => (k === i ? { ...l, ...next } : l)) }));

  const removeLine = (i: number) =>
    setQ((p) => ({ ...p, lines: p.lines.filter((_, k) => k !== i) }));

  /**
   * 줄 더하기 — **기본 부등호는 기준의 성격이 정한다.**
   *
   * 위험 축은 「이하」가 자연스럽다(매물 부담은 낮을수록 좋다). 값이 뜻을 갖지
   * 않는 기준은 「통과」로 연다. 처음 값은 그 기준의 신호등 문턱을 가져온다 —
   * 빈 칸으로 두면 뭘 넣어야 할지 모른다.
   */
  const fieldOf = (key: string) => fields.find((x) => x.key === key);

  const addLine = (key: string) => {
    const f = fieldOf(key);
    /* 첫 비교는 **사전이 정한 순서의 첫 번째**다 — 위험 항목은 `lte` 가 먼저다 */
    const op: CondLine["op"] = f?.ops[0] ?? "gte";
    setQ((p) => ({
      ...p,
      lines: [
        ...p.lines.map((l, i) => (i === p.lines.length - 1 ? { ...l, join: l.join ?? "and" } : l)),
        { key, op, value: op === "pass" || op === "fail" ? undefined : f?.def },
      ],
    }));
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
        {/* 접혀 있어도 **지금 무엇으로 찾는지**는 보인다 — 그게 없으면 접기가 숨기기가 된다 */}
        <button className="gb-head" onClick={toggleWhere}>
          <span className="gb-caret">{openWhere ? "▾" : "▸"}</span>
          <b>어디서 찾나</b>
          <span className="gb-peek">
            {UNIVERSES.find((u) => u.key === q.universe)?.label} ·{" "}
            {MARKETS.find((m) => m.key === q.market)?.label} · 상위 {q.limit}
            {(q.capMin != null || q.capMax != null) && (
              <>
                {" · 시총 "}
                {q.capMin ?? ""}~{q.capMax ?? ""}억
              </>
            )}
          </span>
        </button>
        {openWhere && (
        <>
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
        </>
        )}
      </section>

      {/* ── 조건식 ── */}
      <section className="card cond-editor">
        <button className="gb-head" onClick={toggleLines}>
          <span className="gb-caret">{openLines ? "▾" : "▸"}</span>
          <b>조건식</b>
          <span className="gb-peek">
            {q.lines.length === 0 ? "아직 없음" : `조건 ${q.lines.length}개`}
          </span>
        </button>
        {openLines && (
        <>
        {/*
          **줄마다 기준·부등호·값·연결자** (2026-09-01 개정).

          벤티지: "어느 하나 조건을 선택하고 그 조건에 대한 상세 값을 넣은 다음에
          그 다음 조건을 넣고 그 사이에 AND 냐 OR 이냐 이렇게 할 수 있게끔" ·
          "체크만 하는 건 의미가 없다고 생각하지 않아."

          맞는 말이다. 예전엔 ① 값을 못 넣어 **신호등 설정의 문턱을 그대로 따라갔고**
          ② 그룹 안 모든 조건이 같은 AND/OR 을 공유해 「A AND B OR C」를 못 썼다.
        */}
        {q.lines.length === 0 ? (
          <div className="empty">
            아래에서 기준을 눌러 조건을 더하세요. 위에서부터 차례로 이어집니다.
          </div>
        ) : (
          <div className="cond-lines">
            {q.lines.map((l, i) => {
              const c = fieldOf(l.key);
              const valued = l.op === "gte" || l.op === "lte";
              return (
                <div className="cond-line" key={`${l.key}-${i}`}>
                  <span className="cond-no">{i + 1}</span>
                  <span className="cond-name-cell" title={c?.hint}>
                    {c?.label ?? l.key}
                    {c?.own && (
                      <i className="cond-own" title="신호등 점수에는 안 쓰는 조건 전용 항목입니다">
                        조건 전용
                      </i>
                    )}
                  </span>
                  <span className="filter-row cond-ops">
                    {/* 쓸 수 있는 비교는 **사전이 정한다** — 화면이 짐작하지 않는다 */}
                    {OPS.filter((o) => (c ? c.ops.includes(o.key) : true)).map((o) => (
                      <button
                        key={o.key}
                        className={`filter-btn ${l.op === o.key ? "active" : ""}`}
                        onClick={() =>
                          patchLine(i, {
                            op: o.key,
                            value:
                              o.key === "gte" || o.key === "lte"
                                ? (l.value ?? c?.def ?? 0)
                                : undefined,
                          })
                        }
                        title={o.hint}
                      >
                        {o.label}
                      </button>
                    ))}
                  </span>
                  {valued && (
                    <>
                      <input
                        type="number"
                        className="cond-value"
                        value={l.value ?? ""}
                        onChange={(e) =>
                          patchLine(i, {
                            value: e.target.value === "" ? undefined : Number(e.target.value),
                          })
                        }
                      />
                      <span className="sig-unit">{c?.unit ?? ""}</span>
                      {/*
                        **빠른 값** — 단위를 알아도 「얼마가 보통인가」는 또 다른 물음이다.
                        3천억이 큰 건지 작은 건지 모르면 칸이 비어 있는 것과 같다.
                      */}
                      {c?.presets && (
                        <span className="cond-presets">
                          {c.presets.map((pz: { v: number; label: string }) => (
                            <button
                              key={pz.v}
                              className={`filter-btn ${l.value === pz.v ? "active" : ""}`}
                              onClick={() => patchLine(i, { value: pz.v })}
                            >
                              {pz.label}
                            </button>
                          ))}
                        </span>
                      )}
                    </>
                  )}
                  <button className="cond-x" onClick={() => removeLine(i)} title="이 줄을 뺍니다">
                    ✕
                  </button>

                  {/* 다음 줄과의 연결자 — 마지막 줄에는 없다 */}
                  {i < q.lines.length - 1 && (
                    <span className="cond-join">
                      {(["and", "or"] as const).map((j) => (
                        <button
                          key={j}
                          className={`filter-btn ${(l.join ?? "and") === j ? "active" : ""}`}
                          onClick={() => patchLine(i, { join: j })}
                          title={
                            j === "and"
                              ? "위까지의 결과와 이 아래를 **둘 다** 만족해야 합니다"
                              : "위까지의 결과나 이 아래 **하나만** 만족해도 됩니다"
                          }
                        >
                          {j === "and" ? "그리고 (AND)" : "또는 (OR)"}
                        </button>
                      ))}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {q.lines.length > 1 && (
          <div className="table-note">
            <b>위에서부터 차례로</b> 이어집니다 — <code>A 그리고 B 또는 C</code> 는{" "}
            <code>(A 그리고 B) 또는 C</code> 입니다. 괄호는 아직 없습니다.
          </div>
        )}
        </>
        )}
      </section>

      {/* ── 조건 고르기 ── */}
      <section className="card">
        <button className="gb-head" onClick={togglePick}>
          <span className="gb-caret">{openPick ? "▾" : "▸"}</span>
          <b>조건 더하기</b>
          <span className="pt-n">{fields.length}개</span>
        </button>
        {openPick && (
          <>
            {/*
              **묶음으로 나눈다** (2026-09-01). 예전엔 서른 개 칩이 한 줄로
              쏟아져 원하는 것을 눈으로 찾을 수가 없었다. 그리고 이름이 신호등
              라벨이라 「덩치」·「고점 근접 (신고가와 중복)」 같은 게 섞여 있었다.
            */}
            {(["규모", "가격·추세", "수급", "실적", "위험"] as const).map((g) => {
              const list = fields.filter((f) => f.group === g);
              if (list.length === 0) return null;
              return (
                <div className="cond-group" key={g}>
                  <div className="cond-group-name">{g}</div>
                  <div className="mg-picker">
                    {list.map((f) => (
                      <button
                        key={f.key}
                        className="mg-chip"
                        onClick={() => addLine(f.key)}
                        title={`${f.hint}

단위: ${f.unit || "없음 (통과/미달)"}
${f.cost ?? ""}`}
                      >
                        + {f.label}
                        {f.unit && <i className="cond-unit-chip">{f.unit}</i>}
                      </button>
                    ))}
                  </div>
                </div>
              );
            })}
            <div className="table-note">
              칩 위에 마우스를 올리면 <b>그 숫자가 뭘 뜻하는지</b> 나옵니다. 값 칸
              옆의 빠른 버튼(1천억·3천억·1조…)은 자주 쓰는 값이고, 거기서 고쳐 쓰면
              됩니다 — <b>신호등 문턱이 몇이든 여기서는 내가 정한 값</b>이 기준입니다.
              <br />
              <b>「조건 전용」</b>이 붙은 것은 신호등 점수에는 안 쓰는 항목입니다.
              분기 실적(연속 증가·흑자 전환)이 그렇습니다 — 신호등의 영업이익은
              <b> 연간 DART</b> 라 8월에도 마지막 줄이 작년이라서, 「지금 벌고 있나」는
              분기로만 물을 수 있습니다. 아직 검증이 안 된 값이라 점수에는 안 섞습니다.
            </div>
          </>
        )}
      </section>

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
          {/* 어떤 조회가 나가는지 사람 말로 — 「+3회」보다 「수급 1콜 · 분기실적 1콜」이 낫다 */}
          {costs.length > 0 && ` · 종목당 ${costs.join(" · ")}`}
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
