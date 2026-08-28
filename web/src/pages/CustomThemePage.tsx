import { useEffect, useMemo, useState } from "react";
import { useSheetBack } from "../useSheetBack";
import { api, normalizeStockCode, type EvaluatedTheme, type StockSearchResult } from "../api";
import { tileHeat, useAppearance } from "../useAppearance";

/**
 * 내 테마.
 *
 * 키움 테마 분류는 시장의 현재 관심사를 못 따라간다. 새로 뜨는 주제가 늦게 들어오고,
 * 분류가 너무 넓거나 좁고, 무엇보다 **내가 보는 관점과 다르다.**
 *
 * 등락률은 시가총액 가중평균이다. 단순평균을 쓰면 소형주 한 종목이 테마 전체를 흔들어서
 * "이 테마가 오늘 강했나"를 잘못 말하게 된다. 둘 다 보여줘서 차이를 확인할 수 있게 했다.
 *
 * ## 2026-08-27 개편 — "네모만 너무 커서 그룹 찾는 게 어렵다"
 *
 * 테마마다 큰 카드를 세로로 쌓았더니 인포스탁 이관분 수십 개에서 스크롤 지옥이 됐다.
 * 관심종목 히트맵과 같은 문법으로 간다: **콤팩트 타일 격자**(등락률이 색), 이름 검색과
 * 정렬로 찾고, 타일을 누르면 **시트**로 상세가 열린다. 종목 추가 로직(검색해 담기)은
 * 그대로다 — 그건 좋다는 지정.
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
  /** 시트로 연 테마 id */
  const [open, setOpen] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  /** 테마 이름·메모 검색 — 수십 개에서 찾는 길 */
  const [themeQ, setThemeQ] = useState("");
  /** 타일 정렬 — 등락률(기본)·이름·종목수 */
  const [sortBy, setSortBy] = useState<"rate" | "name" | "count">("rate");
  const { theme: uiTheme } = useAppearance();

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

  /* 격자에 뿌릴 목록 — 갈래 필터 → 이름 검색 → 정렬 */
  const visible = useMemo(() => {
    const needle = themeQ.trim().toLowerCase();
    const list = themes
      .filter((t) => srcFilter === "all" || (t.source ?? "manual") === srcFilter)
      .filter(
        (t) =>
          !needle ||
          t.name.toLowerCase().includes(needle) ||
          (t.memo ?? "").toLowerCase().includes(needle),
      );
    const arr = [...list];
    if (sortBy === "rate") arr.sort((a, b) => (b.changeRate ?? -999) - (a.changeRate ?? -999));
    else if (sortBy === "name") arr.sort((a, b) => a.name.localeCompare(b.name, "ko"));
    else arr.sort((a, b) => b.stocks.length - a.stocks.length);
    return arr;
  }, [themes, srcFilter, themeQ, sortBy]);

  const openTheme = themes.find((t) => t.id === open) ?? null;
  /* 뒤로가기로 테마 시트를 닫는다 (2026-08-28) */
  useSheetBack(openTheme !== null, () => setOpen(null));

  return (
    <div>
      {/* 폰 — 칩 열둘이 다섯 줄로 쌓였다(2026-08-28 실측 145px). 한 줄 가로 스크롤로 */}
      <div className="filter-row ctl-ribbon">
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
        <span className="news-scope-sep" />
        {(
          [
            ["rate", "등락률순"],
            ["name", "이름순"],
            ["count", "종목수순"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={`filter-btn ${sortBy === key ? "active" : ""}`}
            onClick={() => setSortBy(key)}
          >
            {label}
          </button>
        ))}
        <input
          className="search-input ct-find"
          placeholder="테마 찾기 (이름·메모)"
          value={themeQ}
          onChange={(e) => setThemeQ(e.target.value)}
        />
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
          아직 만든 테마가 없습니다. 아래 「＋ 새 테마」에서 만들고, 종목을 검색해 담으세요.
        </div>
      )}
      {themeQ.trim() && (
        <div className="page-note">
          「{themeQ.trim()}」 — {visible.length}개 테마
        </div>
      )}

      {/*
        타일 격자 — 관심종목 히트맵과 같은 문법. 등락률이 곧 색이라 어느 테마가
        도는지 훑어서 보이고, 큰 카드 나열보다 화면에 열 배가 들어간다.
      */}
      <div className="ct-grid">
        {visible.map((t) => (
          <button
            key={t.id}
            className="ct-tile"
            style={tileHeat(t.changeRate, uiTheme)}
            onClick={() => setOpen(t.id)}
            title={`${t.name} ${pct(t.changeRate)} · ▲${t.risingCount} ▼${t.fallingCount} · ${t.stocks.length}종목${t.memo ? `\n${t.memo}` : ""}`}
          >
            <span className="ct-tile-top">
              <i className="ct-dot" style={{ background: t.color }} />
              {t.source === "infostock" && <em className="ct-tile-src">인</em>}
            </span>
            <b>{t.name}</b>
            <span className={`num ct-tile-rate ${cls(t.changeRate)}`}>{pct(t.changeRate)}</span>
            <span className="ct-tile-n">{t.stocks.length}종목</span>
          </button>
        ))}
      </div>

      {/* 새 테마 — 매일 쓰는 게 아니라 접어 둔다 */}
      <details className="cal-fold">
        <summary>＋ 새 테마 만들기</summary>
        <p className="page-note">
          키움 분류에 없는 주제를 직접 만듭니다 (온디바이스AI, 전력설비, 로봇 등). 만든 테마는{" "}
          <b>데일리 리포트와 AI 요약에 키움 테마보다 먼저</b> 들어갑니다.
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
      </details>

      <div className="table-note">
        등락률은 <b>시가총액 가중평균</b>입니다 — 단순평균은 소형주 한 종목이 테마 전체를 흔들어서
        판단을 그르칩니다. 타일 색도 그 값입니다. 타일을 누르면 구성종목·종목 추가·삭제가
        열립니다. 시세는 전종목 스냅샷 5분 캐시입니다.
      </div>

      {/* 상세 시트 — 구성종목 + 종목 추가(그대로) + 삭제 */}
      {openTheme && (
        <div className="overlay" onClick={() => setOpen(null)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <h2>
                <span className="ct-dot" style={{ background: openTheme.color }} /> {openTheme.name}{" "}
                {openTheme.source === "infostock" && <span className="news-tag">인포스탁</span>}
                <span className={`ct-rate ${cls(openTheme.changeRate)}`}>{pct(openTheme.changeRate)}</span>
                <span className="ct-meta">
                  ▲{openTheme.risingCount} ▼{openTheme.fallingCount} · {openTheme.stocks.length}종목
                </span>
              </h2>
              <button className="close-btn" onClick={() => setOpen(null)}>
                ✕
              </button>
            </div>

            {openTheme.memo && <div className="ct-memo">{openTheme.memo}</div>}

            {/* 가중과 단순이 크게 다르면 대형주가 끌고 있다는 뜻이라 같이 보여준다 */}
            {openTheme.changeRate !== null && openTheme.simpleRate !== null && (
              <div className="ct-compare">
                시총가중 <b className={cls(openTheme.changeRate)}>{pct(openTheme.changeRate)}</b> · 단순평균{" "}
                <b className={cls(openTheme.simpleRate)}>{pct(openTheme.simpleRate)}</b>
                {Math.abs(openTheme.changeRate - openTheme.simpleRate) >= 1 && (
                  <span className="ct-hint">
                    {" "}
                    차이가 큽니다 — {openTheme.changeRate > openTheme.simpleRate ? "대형주" : "소형주"}가 끌고 있습니다
                  </span>
                )}
              </div>
            )}

            {openTheme.missing > 0 && (
              <div className="ct-warn">
                {openTheme.missing}개 종목을 시세에서 못 찾았습니다 (상장폐지·코드 오류일 수 있습니다)
              </div>
            )}

            <div className="ct-stocks">
              {openTheme.stocks.map((s) => (
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
                    onClick={() => void run(() => api.customThemeToggleStock(openTheme.id, s.code))}
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
                  value={editing === openTheme.id ? query : ""}
                  onFocus={() => setEditing(openTheme.id)}
                  onChange={(e) => {
                    setEditing(openTheme.id);
                    setQuery(e.target.value);
                  }}
                />
                {editing === openTheme.id && query.trim() && results.length > 0 && (
                  <div className="search-dropdown">
                    {results.map((r) => (
                      <button
                        key={r.code}
                        className="search-result-row"
                        onClick={() =>
                          void run(async () => {
                            await api.customThemeToggleStock(openTheme.id, normalizeStockCode(r.code));
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
                  if (window.confirm(`"${openTheme.name}" 테마를 삭제할까요?`)) {
                    setOpen(null);
                    void run(() => api.customThemeRemove(openTheme.id));
                  }
                }}
              >
                테마 삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
