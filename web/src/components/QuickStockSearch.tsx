import { useEffect, useRef, useState } from "react";
import { api, normalizeStockCode, type StockSearchResult } from "../api";

/**
 * 최상단 종목 바로가기 (2026-08-25 — 사용자 요청).
 *
 * 어느 화면에 있든 종목 하나가 궁금해지는 순간이 있다 — 그때마다 개별종목분석
 * 메뉴로 가서 검색하는 건 길이 멀다. **접었다 펴는 검색줄**을 모든 화면 위에 둔다.
 *
 * 접혀 있을 때는 🔍 한 줄이다 — 자리를 거의 안 먹는다. 펴면 입력창에 바로
 * 포커스가 가고, 고르면 **개별종목분석으로 바로 이동**하고 도로 접힌다.
 */
export function QuickStockSearch({
  onPick,
}: {
  /** 고르면 어디로 — App 이 개별종목분석 이동을 넣는다 */
  onPick: (code: string, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const t = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setResults(r.results.slice(0, 8)))
        .catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  function pick(r: StockSearchResult) {
    setOpen(false);
    setQuery("");
    setResults([]);
    onPick(normalizeStockCode(r.code), r.name);
  }

  if (!open) {
    return (
      <button
        className="qss-toggle"
        onClick={() => setOpen(true)}
        title="종목 이름·코드로 바로 이동"
      >
        🔍 종목 바로가기
      </button>
    );
  }

  return (
    <div className="qss">
      <div className="search-box qss-box">
        <input
          ref={inputRef}
          className="search-input"
          type="text"
          inputMode="search"
          placeholder="종목명·코드 — 고르면 개별종목분석으로 갑니다"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            if (e.key === "Enter" && results[0]) pick(results[0]);
          }}
        />
        <button className="qss-close" onClick={() => setOpen(false)} title="접기">
          ✕
        </button>
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
    </div>
  );
}
