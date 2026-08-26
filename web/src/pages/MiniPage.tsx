import { useEffect, useState } from "react";
import { api, normalizeStockCode, type StockSearchResult } from "../api";
import { StockDetail } from "../components/StockDetail";

/**
 * 미니창 (2026-08-26) — **보던 페이지를 떠나지 않고 종목을 조회하는 보조창.**
 *
 * 설정 밑 「미니창 열기」가 작은 팝업 창으로 이 화면을 연다(#/mini).
 * 검색해서 고르면 종목 상세(시세분석에서 클릭할 때 나오는 그 시트)가 그대로 뜬다.
 * 해시 라우팅이라 미니창을 새로고침해도 보던 종목이 유지된다.
 *
 * 사이드바·다른 메뉴는 없다 — 이 창의 일은 「종목 하나 들여다보기」 하나다.
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

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function pick(r: StockSearchResult) {
    onSelect(normalizeStockCode(r.code), r.name);
    setQuery("");
    setResults([]);
  }

  return (
    <div className="mini-root">
      {!stock && (
        <div className="mini-home">
          <h2 className="mini-title">🪟 미니창</h2>
          <div className="search-box">
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
              }}
            />
            {query.trim() && results.length > 0 && (
              <div className="search-dropdown">
                {results.map((r) => (
                  <button key={r.code} className="search-result-row" onClick={() => pick(r)}>
                    <span className="name">{r.name}</span>
                    <span className="sub">
                      {r.code} · {r.marketName}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="table-note">
            본창을 떠나지 않고 종목을 들여다보는 보조창입니다. 고르면 종목 상세가 뜨고,
            ✕ 를 누르면 다시 검색으로 돌아옵니다.
          </div>
        </div>
      )}

      {stock && (
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
      )}
    </div>
  );
}
