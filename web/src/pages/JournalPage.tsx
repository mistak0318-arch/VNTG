import { useEffect, useState } from "react";
import {
  api,
  normalizeStockCode,
  type JournalData,
  type JournalEntry,
  type JournalTrade,
  type StockSearchResult,
} from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { TradeTrackPanel } from "../components/TradeTrackPanel";

/**
 * 복기 노트.
 *
 * 자유 서술만 있는 매매일지는 **다시 안 읽는 일기**가 된다. 그러면 반성은 남고
 * 개선은 안 남는다. 그래서 실수와 상태를 태그로 고르게 해서 나중에 셀 수 있게 하고,
 * 그날 시장·테마·거래는 자동으로 채운다 — 손으로 적게 하면 안 적고,
 * 적더라도 기억으로 적게 되어 복기의 근거가 흔들린다.
 *
 * 화면 순서가 곧 복기 순서다.
 *   오늘 적기 → 쌓인 나(트래킹) → 지난 기록
 */

function today(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function JournalPage({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
} = {}) {
  const [data, setData] = useState<JournalData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [date, setDate] = useState(today());

  // 편집 중인 값
  const [form, setForm] = useState<Partial<JournalEntry>>({});
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await api.journal();
      setData(d);
      const hit = d.entries.find((e) => e.date === date);
      setForm(hit ?? { mistakes: [], followedRules: null, mood: "", trades: [] });
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 날짜를 바꾸면 그날 기록을 폼에 올린다
  useEffect(() => {
    if (!data) return;
    const hit = data.entries.find((e) => e.date === date);
    setForm(hit ?? { mistakes: [], followedRules: null, mood: "", trades: [] });
  }, [date, data]);

  async function save() {
    setSaving(true);
    setNote(null);
    try {
      const d = await api.journalSave({ ...form, date });
      setData((prev) => (prev ? { ...prev, entries: d.entries, stats: d.stats } : prev));
      setNote("저장했습니다.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  function addTrade(r: StockSearchResult | null) {
    const t: JournalTrade = {
      id: `jt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      kind: "buy",
      code: r ? normalizeStockCode(r.code) : "",
      name: r ? r.name : "",
      price: 0,
      qty: 0,
      note: "",
    };
    setForm({ ...form, trades: [...(form.trades ?? []), t] });
    setQuery("");
    setResults([]);
  }

  function patchTrade(id: string, patch: Partial<JournalTrade>) {
    setForm({
      ...form,
      trades: (form.trades ?? []).map((t) => (t.id === id ? { ...t, ...patch } : t)),
    });
  }

  function removeTrade(id: string) {
    setForm({ ...form, trades: (form.trades ?? []).filter((t) => t.id !== id) });
  }

  function toggleMistake(key: string) {
    const cur = form.mistakes ?? [];
    setForm({ ...form, mistakes: cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key] });
  }

  if (loading && !data) return <div className="page-note">불러오는 중…</div>;
  if (!data) return <div className="error-banner">{error ?? "복기 노트를 열 수 없습니다."}</div>;

  const s = data.stats;
  const entry = data.entries.find((e) => e.date === date);
  const ctx = entry?.context ?? null;

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} />
      {error && <div className="error-banner">{error}</div>}

      {/* ── 오늘 적기 ── */}
      <section className="jn-editor">
        <div className="jn-head">
          <input
            className="pt-input"
            type="date"
            value={date}
            max={today()}
            onChange={(e) => setDate(e.target.value)}
          />
          <span className="jn-streak">
            연속 <b>{s.streak}</b>일 · 총 <b>{s.days}</b>일 기록
          </span>
          <button className="algo-run-btn" onClick={() => void save()} disabled={saving}>
            {saving ? "저장 중…" : entry ? "수정" : "저장"}
          </button>
          {note && <span className="jn-saved">{note}</span>}
        </div>

        {/* 자동으로 잡힌 그날 맥락 — 사용자가 적을 필요가 없다 */}
        {ctx ? (
          <div className="jn-ctx">
            <span className={`sig-dot ${ctx.marketLevel}`} />
            <span className="jn-ctx-main">{ctx.marketSummary || "시장 기록 없음"}</span>
            {ctx.breadth && <span className="jn-ctx-sub">{ctx.breadth}</span>}
            {ctx.topThemes.length > 0 && (
              <span className="jn-ctx-sub">
                강한 테마 {ctx.topThemes.map((t) => `${t.name} ${pct(t.changeRate)}`).join(", ")}
              </span>
            )}
          </div>
        ) : (
          <div className="page-note">
            저장하면 그날의 <b>시장 신호등·시장 폭·내 테마</b>가 자동으로 함께 박제됩니다.
          </div>
        )}

        {/*
          당일 매매현황 — **직접 적는다.**
          처음엔 모의투자에서 끌어왔는데 그건 시나리오를 짜 보는 자리고, 실제 매매는
          증권사 계좌에서 일어난다. 복기해야 하는 건 후자다.
          종목을 골라 주면 그 순간의 신호등은 기계가 붙인다 — 사람은 "왜"만 적으면 된다.
        */}
        <div className="jn-field">
          <span className="jn-label">
            오늘의 매매 <em className="jn-hint">실제 계좌에서 한 것을 적습니다</em>
          </span>
          <div className="jn-trades">
            {(form.trades ?? []).map((t) => (
              <div className={`jn-trade ${t.kind}`} key={t.id}>
                <button
                  className={`jn-trade-kind ${t.kind}`}
                  onClick={() => patchTrade(t.id, { kind: t.kind === "buy" ? "sell" : "buy" })}
                  title="눌러서 매수/매도 전환"
                >
                  {t.kind === "buy" ? "매수" : "매도"}
                </button>
                <span className="jn-trade-name">{t.name || "종목 미지정"}</span>
                <input
                  className="pt-input short"
                  inputMode="numeric"
                  placeholder="단가"
                  value={t.price || ""}
                  onChange={(e) => patchTrade(t.id, { price: Number(e.target.value.replace(/,/g, "")) || 0 })}
                />
                <input
                  className="pt-input short"
                  inputMode="numeric"
                  placeholder="수량"
                  value={t.qty || ""}
                  onChange={(e) => patchTrade(t.id, { qty: Number(e.target.value.replace(/,/g, "")) || 0 })}
                />
                {t.level && (
                  <span className="jn-trade-sig">
                    <span className={`sig-dot ${t.level}`} /> {t.score}점
                  </span>
                )}
                <button className="row-del-btn" onClick={() => removeTrade(t.id)} title="삭제">
                  ✕
                </button>
                <input
                  className="pt-input wide"
                  placeholder={t.kind === "buy" ? "왜 샀나 — 한 줄" : "왜 팔았나 — 한 줄"}
                  value={t.note}
                  onChange={(e) => patchTrade(t.id, { note: e.target.value })}
                />
                {t.passed && t.passed.length > 0 && (
                  <span className="jn-trade-passed">기록 시점 통과 — {t.passed.join(" · ")}</span>
                )}
              </div>
            ))}
          </div>

          <div className="jn-add">
            <div className="pt-search">
              <input
                className="pt-input"
                placeholder="종목 검색해서 추가"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
              {results.length > 0 && (
                <ul className="pt-results">
                  {results.slice(0, 8).map((r) => (
                    <li key={r.code}>
                      <button onClick={() => addTrade(r)}>
                        {r.name} <span className="pt-n">{normalizeStockCode(r.code)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button className="filter-btn" onClick={() => addTrade(null)}>
              + 직접 입력
            </button>
          </div>
        </div>

        <label className="jn-field">
          <span className="jn-label">오늘 무엇을 했나</span>
          <textarea
            className="jn-text"
            rows={2}
            placeholder="샀다/팔았다/아무것도 안 했다 — 사실만"
            value={form.what ?? ""}
            onChange={(e) => setForm({ ...form, what: e.target.value })}
          />
        </label>

        <label className="jn-field">
          <span className="jn-label">왜 그렇게 판단했나</span>
          <textarea
            className="jn-text"
            rows={2}
            placeholder="그때 무엇을 보고 그렇게 생각했는지 — 나중에 이 문장이 맞았는지 본다"
            value={form.why ?? ""}
            onChange={(e) => setForm({ ...form, why: e.target.value })}
          />
        </label>

        {/*
          결과가 아니라 과정을 묻는다.
          규칙을 어겼는데 번 날이 제일 위험하다 — 그날 배운 게 다음에 크게 잃게 만든다.
        */}
        <div className="jn-field">
          <span className="jn-label">
            내 규칙대로 했나 <em className="jn-hint">벌었는지가 아니라 지켰는지</em>
          </span>
          <div className="filter-row" style={{ margin: 0 }}>
            {[
              { v: true, label: "지켰다" },
              { v: false, label: "어겼다" },
            ].map((o) => (
              <button
                key={String(o.v)}
                className={`filter-btn ${form.followedRules === o.v ? "active" : ""}`}
                onClick={() => setForm({ ...form, followedRules: o.v })}
              >
                {o.label}
              </button>
            ))}
            {form.followedRules === false && (
              <input
                className="pt-input wide"
                placeholder="어떤 규칙을 어겼나"
                value={form.brokenRule ?? ""}
                onChange={(e) => setForm({ ...form, brokenRule: e.target.value })}
              />
            )}
          </div>
        </div>

        <div className="jn-field">
          <span className="jn-label">
            오늘의 실수 <em className="jn-hint">없으면 안 골라도 됩니다</em>
          </span>
          <div className="jn-tags">
            {data.mistakeTags.map((t) => (
              <button
                key={t.key}
                className={`jn-tag ${(form.mistakes ?? []).includes(t.key) ? "on" : ""}`}
                onClick={() => toggleMistake(t.key)}
                title={t.hint}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <div className="jn-field">
          <span className="jn-label">
            오늘의 상태 <em className="jn-hint">나중에 상태별 성적을 봅니다</em>
          </span>
          <div className="jn-tags">
            {data.moodTags.map((t) => (
              <button
                key={t.key}
                className={`jn-tag mood ${form.mood === t.key ? "on" : ""}`}
                onClick={() => setForm({ ...form, mood: form.mood === t.key ? "" : t.key })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>

        <label className="jn-field">
          <span className="jn-label">
            오늘 배운 것 <em className="jn-hint">한 줄. 이게 다음 달의 나를 바꿉니다</em>
          </span>
          <input
            className="pt-input wide"
            placeholder="예: 시장 신호등이 빨간 날엔 정배열이어도 안 밀린 종목이 없었다"
            value={form.lesson ?? ""}
            onChange={(e) => setForm({ ...form, lesson: e.target.value })}
          />
        </label>

        <label className="jn-field">
          <span className="jn-label">내일 할 것</span>
          <input
            className="pt-input wide"
            placeholder="예: 개장 후 외국인이 전기전자 순매수 이어가는지 확인"
            value={form.tomorrow ?? ""}
            onChange={(e) => setForm({ ...form, tomorrow: e.target.value })}
          />
        </label>
      </section>

      {/* ── 쌓인 나 ── */}
      <h3 className="section-heading">쌓인 나 — 노트가 일기와 갈리는 곳</h3>
      {s.days === 0 ? (
        <div className="page-note">
          하루치는 반성이지만 <b>석 달치를 세면 내가 어떤 사람인지</b>가 나옵니다. 제일 자주 하는
          실수, 어떤 상태일 때 규칙을 어기는지, 규칙을 지킨 날과 어긴 날의 성적 차이가 여기
          쌓입니다. 오늘부터 적어 보세요.
        </div>
      ) : (
        <div className="jn-stats">
          <div className="jn-stat-block">
            <div className="cost-sub">규칙 준수율</div>
            <div className="jn-big">{s.ruleRate === null ? "-" : `${s.ruleRate.toFixed(0)}%`}</div>
            <div className="jn-stat-note">
              지킨 날 {s.ruleEdge.keptDays}일 평균{" "}
              <b className={(s.ruleEdge.keptAvgReturn ?? 0) >= 0 ? "positive" : "negative"}>
                {pct(s.ruleEdge.keptAvgReturn)}
              </b>
              {" / "}어긴 날 {s.ruleEdge.brokeDays}일 평균{" "}
              <b className={(s.ruleEdge.brokeAvgReturn ?? 0) >= 0 ? "positive" : "negative"}>
                {pct(s.ruleEdge.brokeAvgReturn)}
              </b>
              <br />
              <span className="jn-warn">
                어긴 날 성적이 더 좋으면 그게 제일 위험한 신호입니다 — 그날 배운 게 다음에 크게
                잃게 만듭니다.
              </span>
            </div>
          </div>

          <div className="jn-stat-block">
            <div className="cost-sub">자주 하는 실수</div>
            {s.mistakes.length === 0 ? (
              <div className="jn-stat-note">아직 고른 실수가 없습니다.</div>
            ) : (
              s.mistakes.slice(0, 6).map((m) => (
                <div className="cost-row" key={m.key}>
                  <span className="cost-name">{m.label}</span>
                  <span className="cost-bar-wrap">
                    <span
                      className="cost-bar"
                      style={{ width: `${(m.count / s.mistakes[0].count) * 100}%` }}
                    />
                  </span>
                  <span className="num cost-usd">{m.count}회</span>
                </div>
              ))
            )}
          </div>

          <div className="jn-stat-block">
            <div className="cost-sub">상태별 규칙 준수율</div>
            {s.moods.length === 0 ? (
              <div className="jn-stat-note">아직 고른 상태가 없습니다.</div>
            ) : (
              s.moods.map((m) => (
                <div className="cost-row" key={m.key}>
                  <span className="cost-name">{m.label}</span>
                  <span className="cost-bar-wrap">
                    <span className="cost-bar alt" style={{ width: `${m.ruleRate ?? 0}%` }} />
                  </span>
                  <span className="num cost-usd">
                    {m.ruleRate === null ? "-" : `${m.ruleRate.toFixed(0)}%`}
                  </span>
                  <span className="num cost-calls">{m.count}일</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {s.lessons.length > 0 && (
        <>
          <h3 className="section-heading">배운 것 다시 읽기</h3>
          <div className="jn-lessons">
            {s.lessons.map((l) => (
              <div className="jn-lesson" key={l.date}>
                <span className="jn-lesson-date">{l.date.slice(5)}</span>
                <span>{l.lesson}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/*
        ── 내 판단 추적 ──
        「쌓인 나」 바로 뒤다. 위 통계가 **번 돈**을 세는 자리라면, 여기는
        **그 판단이 옳았나**를 세는 자리다 — 판 뒤에 오른 종목은 위쪽 어디에도 안 남는다.
      */}
      <TradeTrackPanel onSelectStock={onSelectStock} />

      {/* ── 지난 기록 ── */}
      {data.entries.length > 0 && (
        <>
          <h3 className="section-heading">지난 기록 {data.entries.length}일</h3>
          <div className="filter-row">
            {data.entries.slice(0, 30).map((e) => (
              <button
                key={e.date}
                className={`filter-btn ${date === e.date ? "active" : ""}`}
                onClick={() => setDate(e.date)}
                title={e.lesson || e.what}
              >
                {e.date.slice(5)}
                {e.followedRules === false && " ⚠"}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
