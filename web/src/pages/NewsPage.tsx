import { useEffect, useState } from "react";
import { api, normalizeStockCode, type StockSearchResult } from "../api";
import { DisclosureList, NewsList } from "../components/NewsDisclosurePanel";

/** 검색 안 했을 때 보여줄 기본 증권 뉴스 키워드 */
const DEFAULT_QUERY = "증시";

export function NewsPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [picked, setPicked] = useState<{ code: string; name: string } | null>(null);

  // 종목명이 겹칠 수 있으므로 후보를 보여주고 고르게 한다
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchStocks(q)
        .then((res) => setResults(res.results))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  function pick(r: StockSearchResult) {
    setPicked({ code: normalizeStockCode(r.code), name: r.name });
    setQuery("");
    setResults([]);
  }

  return (
    <div>
      <div className="search-box">
        <input
          className="search-input"
          type="text"
          inputMode="search"
          placeholder="종목명 또는 종목코드로 뉴스·공시 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
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

      {picked ? (
        <>
          <div className="page-toolbar" style={{ justifyContent: "space-between" }}>
            <button className="refresh-btn" onClick={() => onSelectStock(picked.code, picked.name)}>
              {picked.name} ({picked.code}) 상세 보기 →
            </button>
            <button className="filter-btn" onClick={() => setPicked(null)}>
              전체 뉴스로
            </button>
          </div>
          <div className="feed-two-col-responsive">
            <section>
              <h3 className="feed-heading">{picked.name} 뉴스</h3>
              <NewsList query={picked.name} />
            </section>
            <section>
              <h3 className="feed-heading">{picked.name} 공시 (DART)</h3>
              <DisclosureList code={picked.code} />
            </section>
          </div>
        </>
      ) : (
        <>
          <h3 className="feed-heading">증권 주요뉴스</h3>
          <NewsList query={DEFAULT_QUERY} />
        </>
      )}

      <div className="table-note">
        뉴스는 네이버 검색 API, 공시는 금융감독원 DART · 제목을 누르면 원문으로 이동합니다
      </div>
    </div>
  );
}
