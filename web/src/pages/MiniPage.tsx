import { useEffect, useState } from "react";
import { api, normalizeStockCode, type StockSearchResult } from "../api";
import { StockDetail } from "../components/StockDetail";

/**
 * 미니창 (2026-08-26) — **보던 페이지를 떠나지 않고 종목을 조회하는 보조창.**
 *
 * 설정 밑 「미니창 열기」가 작은 팝업 창으로 이 화면을 연다(#/mini).
 *
 * 구조는 창 하나에 딱 붙는 모양이다 — 검색창이 **맨 위에 고정**이고,
 * 결과도 종목 상세도 전부 그 아래에 **본문으로** 펼쳐진다. 처음엔 상세를
 * 오버레이 시트(본창의 팝업 그대로)로 띄웠더니 「미니창 안의 미니팝업」이
 * 되어 버렸다 — 그래서 .mini-root 밑에서는 오버레이를 CSS로 눕혀서
 * 그냥 본문이 되게 한다(styles.css의 .mini-root .overlay/.sheet).
 *
 * 해시 라우팅이라 미니창을 새로고침해도 보던 종목이 유지된다.
 */
export function MiniPage({
  stock,
  onSelect,
  onClear,
}: {
  stock: { code: string; name: string } | null;
  onSelect: (code: string, name: string) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const t = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function pick(r: StockSearchResult) {
    onSelect(normalizeStockCode(r.code), r.name);
    setQuery("");
    setResults([]);
  }

  const q = query.trim();

  return (
    <div className="mini-root">
      {/* 검색은 항상 맨 위 — 종목을 보다가도 바로 다음 종목을 찾는다 */}
      <div className="mini-search">
        <span className="mini-search-icon" aria-hidden="true">🪟</span>
        <input
          className="search-input"
          type="text"
          inputMode="search"
          autoFocus
          placeholder="종목명 또는 종목코드 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && results[0]) pick(results[0]);
            if (e.key === "Escape") setQuery("");
          }}
        />
      </div>

      <div className="mini-body">
        {/* 입력 중이면 결과 목록이 본문 — 보던 상세는 입력을 지우면 그대로 다시 나온다 */}
        {q ? (
          results.length > 0 ? (
            <div className="mini-results">
              {results.map((r) => (
                <button key={r.code} className="mini-result-row" onClick={() => pick(r)}>
                  <span className="name">{r.name}</span>
                  <span className="sub">
                    {r.code} · {r.marketName}
                  </span>
                </button>
              ))}
            </div>
          ) : (
            <div className="empty">{searching ? "검색 중..." : "검색 결과가 없습니다"}</div>
          )
        ) : stock ? (
          <StockDetail
            code={stock.code}
            name={stock.name}
            onClose={onClear}
            /* 미니창엔 개별종목분석 페이지가 없다 — 본창에서 열도록 새 탭으로 */
            onOpenAnalysis={(code, name) => {
              window.open(
                `${window.location.pathname}#/stockAnalysis?code=${code}&name=${encodeURIComponent(name)}`,
                "_blank",
              );
            }}
            onSelectStock={(code, name) => onSelect(code, name)}
          />
        ) : (
          <div className="table-note mini-hint">
            본창을 떠나지 않고 종목을 들여다보는 보조창입니다. 위에서 검색해 고르면
            종목 상세가 바로 아래에 펼쳐집니다.
          </div>
        )}
      </div>
    </div>
  );
}
