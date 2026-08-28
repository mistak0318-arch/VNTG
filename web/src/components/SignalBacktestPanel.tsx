import { useCallback, useEffect, useState } from "react";
import { api, signClass, type SignalConfig } from "../api";

/**
 * 신호등 백테스트 — **기준을 조절해 가며 과거로 다시 매긴다.**
 *
 * ## 왜 이 화면이 필요한가
 *
 * 가중치와 문턱을 감으로 정하고 있었다. 「ETF 뒷배가 2가 맞나 1이 맞나」에 답할
 * 방법이 없었다 — 바꿔 놓고 며칠 써 보는 것뿐이었고, 그 며칠의 장세가 답을 흐렸다.
 *
 * 여기서는 **바꾸고 바로 돌린다.** 설정은 저장하지 않으므로 지금 쓰는 기준은
 * 그대로 있다. 마음에 드는 조합을 찾으면 그때 설정 화면에서 옮기면 된다.
 *
 * ## ⚠️ 절반만 재현된다
 *
 * 일봉으로 되살릴 수 있는 기준만 쓴다. 테마·ETF·수급·재무는 **그때의 구성을
 * 모르므로** 뺀다 — 석 달 전에 어느 종목이 어느 테마였는지, ETF 가 뭘 얼마나
 * 담았는지가 우리에게 없다. 무엇이 빠졌는지 화면에 적는다.
 */

interface Summary {
  n: number;
  d1: { avg: number | null; win: number | null };
  d5: { avg: number | null; win: number | null };
  d20: { avg: number | null; win: number | null };
}

interface Result {
  used: string[];
  skipped: string[];
  days: number;
  codes: number;
  rows: {
    date: string;
    code: string;
    name: string;
    score: number;
    close: number;
    d1: number | null;
    d5: number | null;
    d20: number | null;
  }[];
  green: Summary;
  base: Summary;
  buckets: { label: string; from: number; to: number; s: Summary }[];
  note: string;
}

const AXES: { key: "trend" | "flow" | "value"; label: string }[] = [
  { key: "trend", label: "추세" },
  { key: "flow", label: "수급" },
  { key: "value", label: "실적" },
];

function pct(v: number | null): string {
  return v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/**
 * 두 기준이 같은가 — 되돌리기 버튼을 죽여 둘지 판단한다.
 * JSON 비교로 충분하다: 서버가 준 뼈대를 그대로 복사해 만지므로 키 순서가 안 흔들린다.
 */
function same(a: SignalConfig | null, b: SignalConfig | null): boolean {
  return a !== null && b !== null && JSON.stringify(a) === JSON.stringify(b);
}

export function SignalBacktestPanel({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [cfg, setCfg] = useState<SignalConfig | null>(null);
  /** 지금 저장돼 있는 기준(=처음 불러온 값)과 코드가 정한 기본값 — 되돌리기용 */
  const [saved, setSavedCfg] = useState<SignalConfig | null>(null);
  const [defaults, setDefaults] = useState<SignalConfig | null>(null);
  const [limit, setLimit] = useState(40);
  const [days, setDays] = useState(120);
  const [res, setRes] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [prog, setProg] = useState<{ done: number; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 눌러서 펼친 점수대 — 그 구간의 종목을 아래에 보여준다 */
  const [pick, setPick] = useState<string | null>(null);

  /* 지금 쓰는 기준을 가져와 **사본으로** 만진다 — 저장은 안 한다 */
  useEffect(() => {
    api
      .signalConfig()
      .then((r) => {
        setCfg(r.config);
        setSavedCfg(r.config);
        setDefaults(r.defaults);
      })
      .catch(() => undefined);
  }, []);

  /*
   * **백그라운드 잡** (2026-08-28) — 전에는 요청 하나가 30초 넘게 붙잡혀 있었고,
   * 다른 메뉴에 갔다 오면 결과가 없었다. 이제 시작만 걸고 진행을 폴링하다가,
   * 끝나면 결과를 받아 온다. **탭에 들어올 때도 같은 폴링을 한 번 돈다** — 돌던 게
   * 있으면 이어받고, 지난 결과가 있으면 그대로 보여 준다 (신호등 찾기와 같은 꼴).
   */
  const pull = useCallback(async () => {
    try {
      const p = await api.signalBacktestProgress();
      if (p.running) {
        setBusy(true);
        setProg(p);
        return;
      }
      setProg(null);
      const r = await api.signalBacktestResult();
      if (r.error) setError(r.error);
      else if (r.result) setRes(r.result);
      setBusy(false);
    } catch {
      /* 다음 폴링에서 다시 */
    }
  }, []);

  useEffect(() => {
    void pull(); // 탭 진입 — 돌던 잡 이어받기 + 지난 결과 복원
  }, [pull]);

  useEffect(() => {
    if (!busy) return;
    const t = setInterval(() => void pull(), 1500);
    return () => clearInterval(t);
  }, [busy, pull]);

  async function run() {
    if (!cfg) return;
    setError(null);
    try {
      setPick(null); // 새로 돌리면 펼쳐 둔 구간은 닫는다 — 옛 결과가 남으면 헷갈린다
      const r = await api.signalBacktest({ limit, days, config: cfg });
      if (!r.started) {
        setError("이미 돌고 있습니다 — 끝나면 결과가 여기 뜹니다.");
      }
      setBusy(true); // 폴링을 켠다 — 이미 돌던 것이든 방금 건 것이든 이어받는다
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패했습니다");
    }
  }

  if (!cfg) return <div className="empty">기준 불러오는 중…</div>;

  /** 백테스트가 재현할 수 있는 것만 추려 보여준다 — 나머지를 만져 봐야 결과가 안 바뀐다 */
  const usable = cfg.checks.filter((c) =>
    ["trend", "newHigh", "nearHigh", "disparity", "ma5Gap", "overhead", "volume"].includes(c.key),
  );
  const patch = (key: string, p: Partial<(typeof cfg.checks)[number]>) =>
    setCfg({ ...cfg, checks: cfg.checks.map((c) => (c.key === key ? { ...c, ...p } : c)) });

  /* 펼친 점수대의 종목 — 서버가 구간마다 골고루 담아 보낸 것에서 고른다 */
  const bucket = res?.buckets.find((b) => b.label === pick);
  const picked = bucket
    ? (res?.rows ?? []).filter((r) => r.score >= bucket.from && r.score < bucket.to)
    : [];

  return (
    <div className="sbt">
      <p className="page-note">
        기준을 바꿔 가며 <b>과거로 다시 매깁니다.</b> 여기서 바꾼 값은{" "}
        <b>저장되지 않습니다</b> — 마음에 드는 조합을 찾으면 <b>설정 &gt; 신호등 기준</b>에
        옮기세요. 일봉으로 되살릴 수 있는 기준만 씁니다(테마·ETF·수급·재무는 그때의 구성을
        몰라 뺍니다).
      </p>

      {/* ── 조절판 ── */}
      <section className="card sbt-panel">
        <div className="sbt-head">
          <b>기준 조절</b>
          <span className="pt-n">바꾸고 「돌리기」를 누르면 바로 반영됩니다</span>
        </div>

        <div className="sbt-axes">
          {AXES.map((a) => (
            <label className="sbt-axis" key={a.key}>
              <span>{a.label} 축</span>
              <input
                type="number"
                step={0.1}
                min={0}
                max={3}
                value={cfg.axisWeights[a.key]}
                onChange={(e) =>
                  setCfg({
                    ...cfg,
                    axisWeights: { ...cfg.axisWeights, [a.key]: Number(e.target.value) },
                  })
                }
              />
            </label>
          ))}
        </div>

        <div className="sbt-checks">
          {usable.map((c) => (
            <div className={`sbt-check${c.enabled ? "" : " off"}`} key={c.key}>
              <label className="sbt-on">
                <input
                  type="checkbox"
                  checked={c.enabled}
                  onChange={(e) => patch(c.key, { enabled: e.target.checked })}
                />
                <span>{c.label}</span>
              </label>
              <label className="sbt-num">
                <span>무게</span>
                <input
                  type="number"
                  min={0}
                  max={5}
                  value={c.weight}
                  onChange={(e) => patch(c.key, { weight: Number(e.target.value) })}
                />
              </label>
              <label className="sbt-num">
                <span>문턱</span>
                <input
                  type="number"
                  value={c.threshold}
                  onChange={(e) => patch(c.key, { threshold: Number(e.target.value) })}
                />
              </label>
              <label className="sbt-num">
                <span>만점</span>
                <input
                  type="number"
                  value={c.strongAt}
                  onChange={(e) => patch(c.key, { strongAt: Number(e.target.value) })}
                />
              </label>
            </div>
          ))}
        </div>

        <div className="sbt-run">
          <label className="sbt-num">
            <span>대상</span>
            <input
              type="number"
              min={5}
              max={150}
              step={5}
              value={limit}
              onChange={(e) => setLimit(Number(e.target.value))}
            />
            <span className="pt-n">거래대금 상위</span>
          </label>
          <label className="sbt-num">
            <span>기간</span>
            <input
              type="number"
              min={20}
              max={400}
              step={20}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            />
            <span className="pt-n">거래일</span>
          </label>
          <button className="filter-btn active" onClick={() => void run()} disabled={busy}>
            {busy ? "돌리는 중…" : "돌리기"}
          </button>
          {busy && (
            <span className="pt-n">
              백그라운드로 돕니다 — 다른 메뉴에 갔다 와도 됩니다
            </span>
          )}
          {/*
            되돌리기 두 가지 (2026-08-28) — **다른 두 곳으로 돌아간다.**
            「지금 설정」은 실제로 저장돼 쓰이는 기준, 「추천 기본값」은 코드가 정한 값.
            둘이 다를 수 있다: 예전에 저장해 둔 설정이 있으면 그게 이깁니다.
          */}
          <button
            className="filter-btn"
            onClick={() => saved && setCfg(saved)}
            disabled={busy || !saved || same(cfg, saved)}
            title="설정 화면에 저장돼 있는 기준으로"
          >
            ↺ 지금 설정
          </button>
          <button
            className="filter-btn"
            onClick={() => defaults && setCfg(defaults)}
            disabled={busy || !defaults || same(cfg, defaults)}
            title="코드가 정한 추천 기본값으로 (저장은 안 됩니다)"
          >
            ↺ 추천 기본값
          </button>
        </div>
        {defaults && !same(cfg, defaults) && (
          <div className="pt-n">
            추천 기본값과 다릅니다 — 축 가중치 기본은{" "}
            <b>
              추세 {defaults.axisWeights.trend} · 수급 {defaults.axisWeights.flow} · 실적{" "}
              {defaults.axisWeights.value}
            </b>
            .
          </div>
        )}
        {/* 진행바 — 신호등 찾기와 같은 문법. 몇 종목째인지가 바로 보인다 */}
        {busy && prog && prog.total > 0 && (
          <div className="sbt-progress">
            <div className="progress-bar">
              <div
                className="progress-bar-fill"
                style={{ width: `${Math.round((prog.done / prog.total) * 100)}%` }}
              />
            </div>
            <span className="pt-n">
              {prog.done}/{prog.total} 종목
            </span>
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
      </section>

      {/* ── 결과 ── */}
      {res && (
        <>
          <section className="card">
            <h2>성적</h2>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sbt-th-l">구분</th>
                    <th>건수</th>
                    <th>1일</th>
                    <th>5일</th>
                    <th>20일</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td className="sbt-th-l">
                      <b>초록</b>
                    </td>
                    <td>{res.green.n}</td>
                    {(["d1", "d5", "d20"] as const).map((k) => (
                      <td key={k} className={`num ${signClass(res.green[k].avg ?? 0)}`}>
                        {pct(res.green[k].avg)}
                        <em className="pt-n"> {res.green[k].win ?? "—"}%</em>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="sbt-th-l">전체 평균</td>
                    <td>{res.base.n}</td>
                    {(["d1", "d5", "d20"] as const).map((k) => (
                      <td key={k} className="num">
                        {pct(res.base[k].avg)}
                        <em className="pt-n"> {res.base[k].win ?? "—"}%</em>
                      </td>
                    ))}
                  </tr>
                  <tr>
                    <td className="sbt-th-l">
                      <b>초과</b>
                    </td>
                    <td />
                    {(["d1", "d5", "d20"] as const).map((k) => {
                      const g = res.green[k].avg;
                      const b = res.base[k].avg;
                      const d = g !== null && b !== null ? g - b : null;
                      return (
                        <td key={k} className={`num ${signClass(d ?? 0)}`}>
                          <b>{d === null ? "—" : `${d > 0 ? "+" : ""}${d.toFixed(2)}%p`}</b>
                        </td>
                      );
                    })}
                  </tr>
                </tbody>
              </table>
            </div>
            <div className="table-note">
              <b>초과</b>가 이 표의 답입니다 — 초록이 「전체 평균」을 얼마나 이겼나.
              강세장이면 아무거나 사도 오르므로, <b>평균을 못 이기는 기준은 쓸모가 없습니다.</b>{" "}
              작은 숫자는 승률입니다. {res.codes}종목 · 최근 {res.days}거래일.
            </div>
          </section>

          <section className="card">
            <h2>이번 계산에 쓴 기준</h2>
            <div className="sbt-tags">
              {res.used.map((u) => (
                <span className="sbt-tag on" key={u}>
                  {u}
                </span>
              ))}
              {res.skipped.map((u) => (
                <span className="sbt-tag off" key={u} title="그때의 구성을 몰라 뺐습니다">
                  {u} ✕
                </span>
              ))}
            </div>
            <div className="table-note">{res.note}</div>
          </section>

          {/* ── 점수대별 ── */}
          <section className="card">
            <h2>점수대별 성적</h2>
            <p className="page-note">
              <b>위 칸이 아래 칸보다 잘 갔는지</b>가 이 표의 답입니다. 순서가 뒤집혀 있으면
              (80점대가 60점대보다 못 가면) 그 조합은 점수를 잘못 매기고 있는 것입니다.
              건수를 누르면 그 구간의 종목이 아래에 나옵니다.
            </p>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sbt-th-l">점수</th>
                    <th>건수</th>
                    <th>1일</th>
                    <th>5일</th>
                    <th>20일</th>
                  </tr>
                </thead>
                <tbody>
                  {res.buckets.map((b) => (
                    <tr
                      key={b.label}
                      className={`sbt-bucket${pick === b.label ? " on" : ""}${b.s.n === 0 ? " empty" : ""}`}
                    >
                      <td className="sbt-th-l">{b.label}</td>
                      <td>
                        {b.s.n === 0 ? (
                          "0"
                        ) : (
                          <button
                            className="sbt-count"
                            onClick={() => setPick(pick === b.label ? null : b.label)}
                          >
                            {b.s.n}
                          </button>
                        )}
                      </td>
                      {(["d1", "d5", "d20"] as const).map((k) => (
                        <td key={k} className={`num ${signClass(b.s[k].avg ?? 0)}`}>
                          {pct(b.s[k].avg)}
                          <em className="pt-n"> {b.s[k].win ?? "—"}%</em>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* ── 고른 점수대의 종목 ── */}
          {pick && (
            <section className="card">
              <h2>
                {pick} — {picked.length}건
                <button className="filter-btn sbt-clear" onClick={() => setPick(null)}>
                  닫기
                </button>
              </h2>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sbt-th-l">날짜</th>
                      <th className="sbt-th-l">종목</th>
                      <th>점수</th>
                      <th>종가</th>
                      <th>1일</th>
                      <th>5일</th>
                      <th>20일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {picked.map((r, i) => (
                      <tr key={`${r.code}${r.date}${i}`}>
                        <td className="sbt-th-l">
                          {r.date.slice(4, 6)}/{r.date.slice(6, 8)}
                        </td>
                        <td className="sbt-th-l">
                          <button className="tlk-chip" onClick={() => onSelectStock(r.code, r.name)}>
                            {r.name}
                          </button>
                        </td>
                        <td>{r.score}</td>
                        <td>{r.close.toLocaleString("ko-KR")}</td>
                        {(["d1", "d5", "d20"] as const).map((k) => (
                          <td key={k} className={`num ${r[k] === null ? "" : signClass(r[k]!)}`}>
                            {pct(r[k])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="table-note">종목을 누르면 상세가 열립니다.</div>
            </section>
          )}

          {!pick && res.rows.filter((r) => r.score >= 70).length > 0 && (
            <section className="card">
              <h2>초록이 켜진 날</h2>
              <div className="data-table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th className="sbt-th-l">날짜</th>
                      <th className="sbt-th-l">종목</th>
                      <th>점수</th>
                      <th>종가</th>
                      <th>1일</th>
                      <th>5일</th>
                      <th>20일</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.rows
                      .filter((r) => r.score >= 70)
                      .slice(0, 100)
                      .map((r, i) => (
                      <tr key={`${r.code}${r.date}${i}`}>
                        <td className="sbt-th-l">
                          {r.date.slice(4, 6)}/{r.date.slice(6, 8)}
                        </td>
                        <td className="sbt-th-l">
                          <button className="tlk-chip" onClick={() => onSelectStock(r.code, r.name)}>
                            {r.name}
                          </button>
                        </td>
                        <td>{r.score}</td>
                        <td>{r.close.toLocaleString("ko-KR")}</td>
                        {(["d1", "d5", "d20"] as const).map((k) => (
                          <td key={k} className={`num ${r[k] === null ? "" : signClass(r[k]!)}`}>
                            {pct(r[k])}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
