import { useEffect, useRef, useState } from "react";
import { api, normalizeStockCode, type StockSearchResult } from "../api";
import { useRecentStocks } from "../useRecentStocks";

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
  /*
   * 최근 본 종목 (2026-08-31 요청 — 「매번 종목명 쳐야 되서 귀찮네」).
   *
   * 저장소는 이미 있었다(`useRecentStocks`) — 개별종목분석 화면만 쓰고 있었다.
   * 여기서도 **쌓고 보여 준다.** 남기는 것은 친 글자가 아니라 **고른 종목**이라,
   * 한 번 누르면 바로 그 종목으로 간다.
   */
  const recent = useRecentStocks();

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

  function go(code: string, name: string) {
    setOpen(false);
    setQuery("");
    setResults([]);
    recent.push(code, name);
    onPick(code, name);
  }

  function pick(r: StockSearchResult) {
    go(normalizeStockCode(r.code), r.name);
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
        {/*
          **아무것도 안 쳤을 때만** 최근 목록을 편다 (사용자 지정). 글자를 치면
          그때부터는 검색 결과가 그 자리를 쓴다 — 두 목록이 같이 뜨면 어느 쪽을
          누르는지 헷갈린다.
        */}
        {!query.trim() && recent.recent.length > 0 && (
          <div className="search-dropdown">
            <div className="qss-recent-head">
              최근 본 종목
              <button onClick={() => recent.clear()} title="목록 비우기">
                비우기
              </button>
            </div>
            {recent.recent.map((r) => (
              <div className="qss-recent-row" key={r.code}>
                <button className="search-result-row" onClick={() => go(r.code, r.name)}>
                  <span className="name">{r.name}</span>
                  <span className="sub">{r.code}</span>
                </button>
                {/* 잘못 눌러 들어간 것을 뺄 길이 없으면 목록이 지저분해진다 */}
                <button
                  className="qss-recent-del"
                  onClick={() => recent.remove(r.code)}
                  title="이 종목만 목록에서 빼기"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}
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
