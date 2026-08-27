import { useEffect, useRef, useState } from "react";
import {
  api,
  normalizeStockCode,
  type JournalData,
  type JournalEntry,
  type JournalTrade,
  type StockSearchResult,
  type EdgeRow,
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

/** 1.5R 미만이면 경고한다 — 이기고도 지는 매매의 경계선 */
const MIN_R = 1.5;

/**
 * 손절선·목표가를 적으면 **그 자리에서 R 을 보여준다.**
 *
 * 적고 나서 따로 계산하게 하면 아무도 안 한다. 숫자를 넣는 순간 옆에 떠야
 * **주문을 내기 전에** 「이 매매는 1.2R 이네」를 알고 그만둘 수 있다 — 그게 이 칸의 전부다.
 *
 *   R = (목표가 − 진입가) ÷ (진입가 − 손절가)
 *
 * 손절폭(%)도 같이 적는다. R 이 좋아도 손절폭이 15% 면 그건 **손절이 아니라 방치**다.
 */
function PlanReadout({ trade }: { trade: JournalTrade }) {
  const { price = 0, stop = 0, target = 0 } = trade;
  if (!price || !stop) return null;

  // 손절선이 진입가보다 위면 아직 적다 만 것이다 — 그 값으로 R 을 내면 부호가 뒤집힌다
  if (stop >= price) {
    return <i className="jn-plan-warn">손절선이 진입가보다 높습니다</i>;
  }

  const riskPct = ((price - stop) / price) * 100;
  const r = target > price ? (target - price) / (price - stop) : null;

  return (
    <i className="jn-plan-out">
      손절폭 <b>−{riskPct.toFixed(1)}%</b>
      {r !== null && (
        <>
          {" · "}
          <b className={r < MIN_R ? "negative" : "positive"}>{r.toFixed(1)}R</b>
          {r < MIN_R && (
            <span className="jn-plan-warn" title={`${MIN_R}R 미만이면 승률이 높아도 남지 않습니다`}>
              {" "}
              — {MIN_R}R 미만
            </span>
          )}
        </>
      )}
    </i>
  );
}

/**
 * 성적 한 묶음을 표로 — 근거별·신호등별·국면별이 같은 모양이라 하나로 쓴다.
 *
 * **건수를 반드시 같이 적는다.** 세 건 평균 +8% 와 마흔 건 평균 +2% 는 전혀 다른 말인데
 * 평균만 적어 두면 앞의 것이 더 좋아 보인다.
 */
function EdgeTable({ rows }: { rows: EdgeRow[] }) {
  return (
    <div className="jn-edge">
      {rows.map((r) => (
        <div className="cost-row" key={r.key}>
          <span className="cost-name">{r.label}</span>
          <span className={`num jn-edge-ret ${r.avgReturn >= 0 ? "positive" : "negative"}`}>
            {r.avgReturn > 0 ? "+" : ""}
            {r.avgReturn.toFixed(1)}%
          </span>
          <span className="num jn-edge-win">{r.winRate.toFixed(0)}%</span>
          {/*
            **승률 옆에 R 을 붙인다.** 이 둘은 따로 보면 거짓말을 한다 —
            승률 70% 인데 평균 −0.3R 이면 지는 매매인데, 승률만 보면 잘하고 있는 줄 안다.
            손절선을 안 적은 건은 R 을 못 내므로 「-」다. 0 으로 세지 않는다.
          */}
          <span
            className={`num jn-edge-win ${r.avgR === null ? "" : r.avgR >= 0 ? "positive" : "negative"}`}
            title={
              r.avgR === null
                ? "손절선을 적은 매매가 없어 R 을 못 냅니다"
                : `${r.rCount}건에서 낸 평균 R (손절선을 적은 것만)`
            }
          >
            {r.avgR === null ? "-" : `${r.avgR > 0 ? "+" : ""}${r.avgR.toFixed(2)}R`}
          </span>
          <span className="num cost-usd">{r.count}건</span>
        </div>
      ))}
      <div className="jn-stat-note">
        평균 · 승률 · <b>평균 R</b> · 판 건수 순입니다. R 은 <b>손절선을 적어 둔 매매</b>에서만
        나옵니다 — <b>승률보다 R 이 진짜 성적</b>입니다.
      </div>
    </div>
  );
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

  /*
   * ⚠️ **저장 안 된 편집을 지키는 장치** (2026-08-25).
   *
   * 「관망 누르고 사유까지 골랐는데 날짜를 바꿨다 돌아오니 사라졌다」 — 실제로 났다.
   * 날짜를 바꾸면 그날 저장본을 폼에 올리는데, 그 전에 **지금 폼이 저장됐는지 아무도
   * 안 봤다.** 다른 메뉴로 나가도(언마운트) 똑같이 날아갔다.
   *
   * 마지막으로 불러오거나 저장한 폼의 스냅샷을 들고 있다가, 다르면 「편집 중」이다.
   * 편집 중인 채로 (1) 날짜를 바꾸면 먼저 저장하고 넘어가고 (2) 화면을 떠나면
   * 저장을 쏘고 떠난다. 지우는 게 목적일 수는 없다 — 지우기는 저장으로만 한다.
   */
  const savedSnap = useRef("{}");
  const snap = (f: Partial<JournalEntry>) =>
    JSON.stringify({ ...f, context: undefined, updatedAt: undefined });
  /** 빈 폼을 자동 저장하면 「본 날」이 「기록한 날」이 된다 — 내용이 있어야 저장한다 */
  const meaningful = (f: Partial<JournalEntry>) =>
    Boolean(
      f.stance ||
        (f.trades ?? []).length > 0 ||
        (f.mistakes ?? []).length > 0 ||
        f.followedRules !== null ||
        (f.what ?? "").trim() ||
        (f.why ?? "").trim() ||
        (f.mood ?? "").trim() ||
        (f.lesson ?? "").trim() ||
        (f.tomorrow ?? "").trim() ||
        (f.brokenRule ?? "").trim(),
    );
  const dirty = snap(form) !== savedSnap.current;

  /** 언마운트 자동 저장이 읽을 최신값 — 클로저에 갇힌 옛 폼을 쏘면 안 된다 */
  const live = useRef({ form, date, dirty: false });
  live.current = { form, date, dirty };
  useEffect(
    () => () => {
      const l = live.current;
      if (l.dirty && meaningful(l.form)) {
        // 떠나는 길이라 결과를 기다릴 수 없다 — 실패하면 다음에 열 때 없는 것으로 보인다
        void api.journalSave({ ...l.form, date: l.date }).catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

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

  const EMPTY_FORM: Partial<JournalEntry> = { mistakes: [], followedRules: null, mood: "", trades: [] };

  /** 폼을 올리면서 스냅샷도 같이 — 이 순간이 「저장된 상태」의 기준이 된다 */
  function applyForm(hit: JournalEntry | undefined) {
    const f = hit ?? EMPTY_FORM;
    setForm(f);
    savedSnap.current = snap(f);
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const d = await api.journal();
      setData(d);
      /* 편집 중이면 폼을 안 덮는다 — 새로고침이 지우개가 되면 안 된다 */
      if (!live.current.dirty) applyForm(d.entries.find((e) => e.date === date));
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

  async function save(): Promise<{ entries: JournalEntry[] } | null> {
    setSaving(true);
    setNote(null);
    try {
      const d = await api.journalSave({ ...form, date });
      setData((prev) => (prev ? { ...prev, entries: d.entries, stats: d.stats } : prev));
      savedSnap.current = snap(form);
      setNote("저장했습니다.");
      return d;
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
      return null;
    } finally {
      setSaving(false);
    }
  }

  /**
   * 날짜를 바꾼다 — **편집 중이면 먼저 저장하고** 넘어간다.
   * 예전엔 날짜만 바꾸면 폼을 그날 저장본으로 갈아끼웠다. 저장 안 한 편집은
   * 그 순간 소리 없이 사라졌다 — 실제로 관망 사유를 잃었다.
   */
  async function switchDate(next: string) {
    if (next === date) return;
    let entries = data?.entries ?? [];
    if (dirty && meaningful(form)) {
      const saved = await save();
      if (!saved) return; // 저장이 실패했으면 날짜를 안 바꾼다 — 편집을 버리는 길이 없다
      entries = saved.entries;
    }
    setDate(next);
    setNote(null);
    applyForm(entries.find((e) => e.date === next));
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
            /* 편집 중이면 저장부터 하고 넘어간다 — 날짜 이동이 지우개였던 버그의 답 */
            onChange={(e) => void switchDate(e.target.value)}
          />
          <span className="jn-streak">
            연속 <b>{s.streak}</b>일 · 총 <b>{s.days}</b>일 기록
          </span>
          <button className="algo-run-btn" onClick={() => void save()} disabled={saving}>
            {saving ? "저장 중…" : entry ? "수정" : "저장"}
          </button>
          {/* 저장 안 된 편집이 있다는 표시 — 이게 보이는 동안은 날짜를 바꿔도 안전하다(먼저 저장된다) */}
          {dirty && !saving && <span className="jn-dirty">● 편집 중</span>}
          {note && !dirty && <span className="jn-saved">{note}</span>}
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
        {/*
          관망 — **안 사는 것도 판단이다.**

          노트가 매매를 전제로 짜여 있어서 쉰 날은 기록이 안 남았다. 그러면 나중에
          「위험할 때 쉬었나」를 셀 수가 없다. 시장이 어지러울 때는 쉰 날이 더 많고,
          그 판단이 성적을 가장 크게 가른다.
        */}
        <div className="jn-field">
          <span className="jn-label">오늘</span>
          <div className="filter-row">
            {([
              ["trade", "매매함"],
              ["watch", "관망 — 안 샀다"],
            ] as ["trade" | "watch", string][]).map(([k, label]) => (
              <button
                key={k}
                className={`filter-btn ${form.stance === k ? "active" : ""}`}
                onClick={() => setForm({ ...form, stance: form.stance === k ? null : k })}
              >
                {label}
              </button>
            ))}
          </div>
          {form.stance === "watch" && (
            <>
              <span className="jn-label">
                왜 쉬었나 <em className="jn-hint">이걸 세면 위험을 피한 건지 겁이 난 건지 갈립니다</em>
              </span>
              <div className="jn-tags">
                {(data?.watchTags ?? []).map((tag) => {
                  const on = (form.watchReasons ?? []).includes(tag.key);
                  return (
                    <button
                      key={tag.key}
                      className={`jn-tag ${on ? "on" : ""}`}
                      title={tag.hint}
                      onClick={() =>
                        setForm({
                          ...form,
                          watchReasons: on
                            ? (form.watchReasons ?? []).filter((x) => x !== tag.key)
                            : [...(form.watchReasons ?? []), tag.key],
                        })
                      }
                    >
                      {tag.label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
        </div>

        <div className="jn-field">
          <span className="jn-label">
            오늘의 매매{" "}
            <em className="jn-hint">
              실제 계좌에서 한 것을 적습니다 · 매수에는 <b>손절선</b>을 같이 —{" "}
              <b>R</b>(건 것 대비 얼마를 벌었나)이 거기서 나옵니다
            </em>
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
                {/* 기록 시점 수급 (2026-08-27) — 「누가 사고 있을 때 샀나」 자동 박제 */}
                {t.flow && (
                  <span className="jn-trade-sig" title="기록 시점의 당일 외인·기관 순매수 (억원)">
                    <i className={`num ${t.flow.foreign >= 0 ? "positive" : "negative"}`}>
                      외 {(t.flow.foreign / 100).toFixed(1)}
                    </i>
                    {" · "}
                    <i className={`num ${t.flow.inst >= 0 ? "positive" : "negative"}`}>
                      기 {(t.flow.inst / 100).toFixed(1)}
                    </i>
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
                {/*
                  근거 태그 — **매수에만** 묻는다. 「왜 팔았나」는 결과를 이미 아는 상태의
                  판단이라 성적으로 셀 수가 없다.
                  자유 서술은 위에 그대로 두고, 셀 수 있는 형태를 같이 받는다.
                */}
                {t.kind === "buy" && (
                  <span className="jn-trade-reasons">
                    {(data?.reasonTags ?? []).map((tag) => {
                      const on = (t.reasons ?? []).includes(tag.key);
                      return (
                        <button
                          key={tag.key}
                          className={`jn-tag ${on ? "on" : ""}`}
                          title={tag.hint}
                          onClick={() =>
                            patchTrade(t.id, {
                              reasons: on
                                ? (t.reasons ?? []).filter((x) => x !== tag.key)
                                : [...(t.reasons ?? []), tag.key],
                            })
                          }
                        >
                          {tag.label}
                        </button>
                      );
                    })}
                  </span>
                )}
                {/*
                  ── 포지션 노트 — **매수에만.**

                  이 노트는 「무엇을 볼까」까지는 잘 적어 왔는데 **「얼마나 잃을 각오인가」를
                  적을 자리가 없었다.** 어긴 규칙에 「손절 미이행」 태그만 있었는데, 손절선을
                  **미리** 적는 자리가 없으니 지켰는지 어겼는지도 결국 기억에 기대는 것이다.

                  세 칸이면 R 배수가 따라 나오고, 판 뒤에는 **근거 태그별 평균 R** 까지 나온다.
                  승률 70% 인데 평균 −0.3R 이면 지는 매매다 — 승률만으로는 그게 안 보인다.
                */}
                {t.kind === "buy" && (
                  <span className="jn-trade-plan">
                    <input
                      className="pt-input short"
                      inputMode="numeric"
                      placeholder="손절선"
                      title="이 아래로 가면 판다. R 배수의 분모입니다"
                      value={t.stop || ""}
                      onChange={(e) =>
                        patchTrade(t.id, { stop: Number(e.target.value.replace(/,/g, "")) || 0 })
                      }
                    />
                    <input
                      className="pt-input short"
                      inputMode="numeric"
                      placeholder="목표가"
                      value={t.target || ""}
                      onChange={(e) =>
                        patchTrade(t.id, { target: Number(e.target.value.replace(/,/g, "")) || 0 })
                      }
                    />
                    <input
                      className="pt-input short"
                      inputMode="decimal"
                      placeholder="위험 %"
                      title="이 매매에 건 금액이 계좌의 몇 %인가"
                      value={t.risk || ""}
                      onChange={(e) => patchTrade(t.id, { risk: Number(e.target.value) || 0 })}
                    />
                    <PlanReadout trade={t} />
                  </span>
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
          {/*
            **무엇을 보고 산 것이 통했나.**

            이 표가 이 노트를 쓰는 이유다. 「신호등 보고 산 것」과 「수급 보고 산 것」 중
            어느 쪽이 나한테 통하는지는 몇 달 치를 세 봐야 안다.
            건수가 적으면 평균은 우연이라, 건수를 옆에 같이 적는다.
          */}
          {/*
            **내 매매는 대체로 몇 R 짜리인가.**

            승률·평균 수익률만 보면 「건 것 대비」가 안 보인다. 8% 를 걸고 번 3% 와
            1% 를 걸고 번 3% 는 전혀 다른 매매인데 둘 다 「+3%」로 적힌다.

            `count` 가 적으면 그건 성적이 나쁜 게 아니라 **손절선을 잘 안 적는다**는 뜻이다.
            그것도 알아야 하는 정보라 건수를 앞에 둔다.
          */}
          <div className="jn-stat-block wide">
            <div className="cost-sub">내 R — 건 것 대비 얼마를 벌었나</div>
            {s.rStat.count === 0 ? (
              <div className="jn-stat-note">
                아직 없습니다. 매수를 적을 때 <b>손절선</b>을 같이 적으면, 그 종목을 팔 때
                실현 R 이 여기 쌓입니다. <b>승률보다 R 이 진짜 성적</b>입니다 — 승률 70% 인데
                평균 −0.3R 이면 지는 매매입니다.
              </div>
            ) : (
              <div className="jn-edge">
                <div className="cost-row">
                  <span className="cost-name">평균 R</span>
                  <span
                    className={`num jn-edge-ret ${(s.rStat.avg ?? 0) >= 0 ? "positive" : "negative"}`}
                  >
                    {s.rStat.avg === null
                      ? "-"
                      : `${s.rStat.avg > 0 ? "+" : ""}${s.rStat.avg.toFixed(2)}R`}
                  </span>
                  {/* 아래 성적표들과 칸을 맞춘다 — 승률 자리는 여기 해당 값이 없다 */}
                  <span />
                  <span className="num jn-edge-win" title="가장 잘된 한 건">
                    {s.rStat.best === null ? "-" : `↑${s.rStat.best.toFixed(1)}R`}
                  </span>
                  <span className="num cost-usd">{s.rStat.count}건</span>
                </div>
                <div className="jn-stat-note">
                  최악 <b className="negative">{s.rStat.worst?.toFixed(1) ?? "-"}R</b> — 여기가
                  <b> −1R 보다 아래</b>면 손절선을 적어 놓고 안 지킨 것입니다.
                  손절선을 적은 매매만 셉니다.
                </div>
              </div>
            )}
          </div>

          <div className="jn-stat-block wide">
            <div className="cost-sub">무엇을 보고 산 것이 통했나</div>
            {s.reasonEdge.length === 0 ? (
              <div className="jn-stat-note">
                아직 셀 게 없습니다. 매수를 적을 때 <b>근거 태그</b>를 고르고, 그 종목을 팔면
                여기에 성적이 붙습니다 — <b>판 것만</b> 셉니다(물려 있는 걸 실패로 세면 안 됩니다).
              </div>
            ) : (
              <EdgeTable rows={s.reasonEdge} />
            )}
          </div>

          <div className="jn-stat-block">
            <div className="cost-sub">살 때 신호등 색별</div>
            {s.signalEdge.length === 0 ? (
              <div className="jn-stat-note">아직 셀 게 없습니다.</div>
            ) : (
              <EdgeTable rows={s.signalEdge} />
            )}
          </div>

          <div className="jn-stat-block">
            <div className="cost-sub">시장 국면별</div>
            {s.marketEdge.length === 0 ? (
              <div className="jn-stat-note">아직 셀 게 없습니다.</div>
            ) : (
              <EdgeTable rows={s.marketEdge} />
            )}
          </div>

          {/*
            관망 — 쉰 날의 국면과 산 날의 국면을 견준다.
            쉰 날이 빨강에 몰려 있으면 위험을 피한 것이고, 초록에 몰려 있으면 겁이 난 것이다.
          */}
          <div className="jn-stat-block wide">
            <div className="cost-sub">
              관망 {s.watch.days}일 / 매매 {s.watch.tradeDays}일
            </div>
            <div className="jn-edge-two">
              <div>
                <div className="jn-stat-note">쉰 날의 시장</div>
                {s.watch.byMarket.length === 0 ? (
                  <div className="jn-stat-note">-</div>
                ) : (
                  s.watch.byMarket.map((m) => (
                    <div className="cost-row" key={m.key}>
                      <span className="cost-name">
                        <span className={`sig-dot ${m.key}`} /> {m.key}
                      </span>
                      <span className="num cost-usd">{m.count}일</span>
                    </div>
                  ))
                )}
              </div>
              <div>
                <div className="jn-stat-note">산 날의 시장</div>
                {s.watch.tradeByMarket.length === 0 ? (
                  <div className="jn-stat-note">-</div>
                ) : (
                  s.watch.tradeByMarket.map((m) => (
                    <div className="cost-row" key={m.key}>
                      <span className="cost-name">
                        <span className={`sig-dot ${m.key}`} /> {m.key}
                      </span>
                      <span className="num cost-usd">{m.count}일</span>
                    </div>
                  ))
                )}
              </div>
            </div>
            {s.watch.reasons.length > 0 && (
              <div className="jn-stat-note">
                쉰 이유 — {s.watch.reasons.slice(0, 5).map((r) => `${r.label} ${r.count}`).join(" · ")}
              </div>
            )}
            <div className="jn-stat-note">
              쉰 날이 <b>빨강·노랑</b>에 몰려 있으면 위험을 피한 것이고, <b>초록</b>에 몰려
              있으면 겁이 나서 못 산 것입니다 — 둘은 고쳐야 할 방향이 반대입니다.
            </div>
          </div>

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
