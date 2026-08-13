import { useEffect, useState } from "react";
import { api, normalizeStockCode, type EvaluatedTheme, type StockSearchResult } from "../api";

/**
 * 내 테마.
 *
 * 키움 테마 분류는 시장의 현재 관심사를 못 따라간다. 새로 뜨는 주제가 늦게 들어오고,
 * 분류가 너무 넓거나 좁고, 무엇보다 **내가 보는 관점과 다르다.**
 *
 * 등락률은 시가총액 가중평균이다. 단순평균을 쓰면 소형주 한 종목이 테마 전체를 흔들어서
 * "이 테마가 오늘 강했나"를 잘못 말하게 된다. 둘 다 보여줘서 차이를 확인할 수 있게 했다.
 */

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function cls(n: number | null): string {
  if (n === null) return "";
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

export function CustomThemePage({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [themes, setThemes] = useState<EvaluatedTheme[]>([]);
  const [coverage, setCoverage] = useState("");
  const [snapshotAt, setSnapshotAt] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  // 새 테마
  const [newName, setNewName] = useState("");
  const [newMemo, setNewMemo] = useState("");
  const [creating, setCreating] = useState(false);

  // 종목 검색 (테마에 추가할 때)
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);

  // 인포스탁에서 옮겨온 테마가 수십 개라, 내가 만든 것만 보고 싶을 때가 있다
  const [srcFilter, setSrcFilter] = useState<"all" | "manual" | "infostock">("all");

  function load(force = false) {
    setLoading(true);
    api
      .customThemes(force)
      .then((r) => {
        setThemes(r.themes);
        setCoverage(r.coverage);
        setSnapshotAt(r.snapshotAt);
        setError(null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => load(), []);

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

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "실패");
    }
  }

  async function create() {
    if (!newName.trim()) return;
    setCreating(true);
    await run(async () => {
      await api.customThemeCreate({ name: newName.trim(), memo: newMemo.trim() });
      setNewName("");
      setNewMemo("");
    });
    setCreating(false);
  }

  return (
    <div>
      <section className="card">
        <h2>새 테마 만들기</h2>
        <p className="page-note">
          키움 분류에 없는 주제를 직접 만듭니다 (온디바이스AI, 전력설비, 로봇 등). 만든 테마는{" "}
          <b>데일리 리포트와 AI 요약에 키움 테마보다 먼저</b> 들어갑니다 — 내 관점으로 시장을 보는
          것이 이 기능의 목적입니다.
        </p>
        <div className="ct-create">
          <input
            className="search-input"
            placeholder="테마 이름 (예: AI 전력인프라)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <input
            className="search-input"
            placeholder="메모 (예: 데이터센터 전력 수요 수혜)"
            value={newMemo}
            onChange={(e) => setNewMemo(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void create()}
          />
          <button className="primary-btn" onClick={() => void create()} disabled={creating}>
            만들기
          </button>
        </div>
      </section>

      <div className="filter-row">
        <button className="filter-btn" onClick={() => load(true)} disabled={loading}>
          {loading ? "계산 중…" : "↻ 새로고침"}
        </button>
        <span className="news-scope-sep" />
        {(
          [
            ["all", `전체 (${themes.length})`],
            ["manual", `내가 만든 것 (${themes.filter((t) => (t.source ?? "manual") === "manual").length})`],
            ["infostock", `인포스탁 (${themes.filter((t) => t.source === "infostock").length})`],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={`filter-btn ${srcFilter === key ? "active" : ""}`}
            onClick={() => setSrcFilter(key)}
          >
            {label}
          </button>
        ))}
        {coverage && <span className="breadth-count">{coverage}</span>}
        {snapshotAt > 0 && (
          <span className="breadth-count">
            {new Date(snapshotAt).toLocaleTimeString("ko-KR", { hour12: false })} 시세
          </span>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && themes.length === 0 && (
        <div className="empty">전종목 시세를 모으는 중… (첫 조회는 20초쯤 걸립니다)</div>
      )}

      {!loading && themes.length === 0 && !error && (
        <div className="page-note">
          아직 만든 테마가 없습니다. 위에서 이름을 정해 만들고, 종목을 검색해 담으세요.
        </div>
      )}

      {themes
        .filter((t) => srcFilter === "all" || (t.source ?? "manual") === srcFilter)
        .map((t) => (
        <section className="card ct-card" key={t.id} style={{ borderLeftColor: t.color }}>
          <div className="ct-head" onClick={() => setOpen(open === t.id ? null : t.id)}>
            <span className="ct-dot" style={{ background: t.color }} />
            <span className="ct-name">{t.name}</span>
            {t.source === "infostock" && <span className="news-tag">인포스탁</span>}
            <span className={`ct-rate ${cls(t.changeRate)}`}>{pct(t.changeRate)}</span>
            <span className="ct-meta">
              ▲{t.risingCount} ▼{t.fallingCount} · {t.stocks.length}종목
            </span>
          </div>

          {t.memo && <div className="ct-memo">{t.memo}</div>}

          {/* 가중과 단순이 크게 다르면 대형주가 끌고 있다는 뜻이라 같이 보여준다 */}
          {t.changeRate !== null && t.simpleRate !== null && (
            <div className="ct-compare">
              시총가중 <b className={cls(t.changeRate)}>{pct(t.changeRate)}</b> · 단순평균{" "}
              <b className={cls(t.simpleRate)}>{pct(t.simpleRate)}</b>
              {Math.abs(t.changeRate - t.simpleRate) >= 1 && (
                <span className="ct-hint">
                  {" "}
                  차이가 큽니다 — {t.changeRate > t.simpleRate ? "대형주" : "소형주"}가 끌고 있습니다
                </span>
              )}
            </div>
          )}

          {t.missing > 0 && (
            <div className="ct-warn">
              {t.missing}개 종목을 시세에서 못 찾았습니다 (상장폐지·코드 오류일 수 있습니다)
            </div>
          )}

          {open === t.id && (
            <>
              <div className="ct-stocks">
                {t.stocks.map((s) => (
                  <div className={`ct-stock${s.found ? "" : " missing"}`} key={s.code}>
                    <button
                      className="ct-stock-name"
                      onClick={() => onSelectStock?.(normalizeStockCode(s.code), s.name)}
                    >
                      {s.name}
                    </button>
                    <span className={`num ${cls(s.changeRate)}`}>
                      {s.found ? pct(s.changeRate) : "시세 없음"}
                    </span>
                    <span className="ct-weight">
                      {s.weight !== null ? `${s.weight.toFixed(1)}%` : "-"}
                    </span>
                    <button
                      className="ct-remove"
                      title="테마에서 빼기"
                      onClick={() => void run(() => api.customThemeToggleStock(t.id, s.code))}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>

              <div className="ct-add">
                <div className="search-box" style={{ flex: 1 }}>
                  <input
                    className="search-input"
                    placeholder="종목 검색해서 추가"
                    value={editing === t.id ? query : ""}
                    onFocus={() => setEditing(t.id)}
                    onChange={(e) => {
                      setEditing(t.id);
                      setQuery(e.target.value);
                    }}
                  />
                  {editing === t.id && query.trim() && results.length > 0 && (
                    <div className="search-dropdown">
                      {results.map((r) => (
                        <button
                          key={r.code}
                          className="search-result-row"
                          onClick={() =>
                            void run(async () => {
                              await api.customThemeToggleStock(t.id, normalizeStockCode(r.code));
                              setQuery("");
                            })
                          }
                        >
                          <span className="name">{r.name}</span>
                          <span className="sub">
                            {r.code} · {r.marketName}
                          </span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <button
                  className="filter-btn"
                  onClick={() => {
                    if (window.confirm(`"${t.name}" 테마를 삭제할까요?`)) {
                      void run(() => api.customThemeRemove(t.id));
                    }
                  }}
                >
                  테마 삭제
                </button>
              </div>
            </>
          )}
        </section>
      ))}

      <div className="table-note">
        등락률은 <b>시가총액 가중평균</b>입니다 — 단순평균은 소형주 한 종목이 테마 전체를 흔들어서
        판단을 그르칩니다. 시세는 전종목 스냅샷(업종 구성종목 65회 조회)에서 가져오며 5분 캐시를
        둡니다. 시총을 모르는 종목은 가중치에서 빠지지만 구성종목 수에는 남습니다.
      </div>
    </div>
  );
}
