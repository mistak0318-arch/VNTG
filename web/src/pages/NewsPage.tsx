import { useEffect, useState } from "react";
import { api, normalizeStockCode, type NaverNewsCat, type StockSearchResult } from "../api";
import { MainNewsPanel } from "../components/MainNewsPanel";
import { MineNewsPanel } from "../components/MineNewsPanel";
import { DisclosureList, NewsList } from "../components/NewsDisclosurePanel";
import { NaverFinanceFrame } from "../components/NaverFinanceFrame";
import { SectorNews } from "../components/SectorNews";

/*
 * 뉴스 탭 (2026-08-26 확장) — 네이버 증권의 갈래를 그대로 편다.
 * 순서는 요청 그대로: 주요뉴스 → 시황·전망 → 기업·종목 → 해외증시 → ⭐관심종목
 * → ⚡속보 → 부동산 → 분야별(우리 검색 수집) → 맨 끝 네이버 증권 바로가기.
 */
type SrcTab = NaverNewsCat | "mine" | "sector" | "naver";
const TABS: { key: SrcTab; label: string }[] = [
  { key: "main", label: "🏠 주요뉴스" },
  { key: "market", label: "시황·전망" },
  { key: "company", label: "기업·종목" },
  { key: "world", label: "해외증시" },
  { key: "mine", label: "⭐ 관심종목" },
  { key: "flash", label: "⚡ 속보" },
  { key: "estate", label: "부동산" },
  { key: "sector", label: "분야별 뉴스" },
  { key: "naver", label: "네이버 증권" },
];

export function NewsPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [picked, setPicked] = useState<{ code: string; name: string } | null>(null);
  /** 종목이 아니라 **키워드**로 검색한 상태 — 「2차전지」「금리 인하」 같은 것 */
  const [keyword, setKeyword] = useState<string | null>(null);
  const [srcTab, setSrcTab] = useState<SrcTab>("main");

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
    setKeyword(null);
    setPicked({ code: normalizeStockCode(r.code), name: r.name });
    setQuery("");
    setResults([]);
  }

  function pickKeyword(q: string) {
    if (!q) return;
    setPicked(null);
    setKeyword(q);
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
          placeholder="종목명·종목코드 또는 아무 키워드로 뉴스 검색"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            // Enter = 키워드 검색. 종목을 고르고 싶으면 아래 후보를 누른다
            if (e.key === "Enter") pickKeyword(query.trim());
          }}
        />
        {query.trim() && (
          <div className="search-dropdown">
            {/*
              키워드 검색 (2026-08-26) — 종목이 아니어도 검색할 수 있게.
              맨 위에 두면 오타 종목명도 일단 키워드로는 찾아진다.
            */}
            <button className="search-result-row" onClick={() => pickKeyword(query.trim())}>
              <span className="name">🔎 “{query.trim()}” 뉴스 검색</span>
              <span className="sub">종목이 아니어도 됩니다 · Enter</span>
            </button>
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
      ) : keyword ? (
        <>
          <div className="page-toolbar" style={{ justifyContent: "space-between" }}>
            <h3 className="feed-heading" style={{ margin: 0 }}>
              “{keyword}” 뉴스
            </h3>
            <button className="filter-btn" onClick={() => setKeyword(null)}>
              전체 뉴스로
            </button>
          </div>
          <NewsList query={keyword} />
        </>
      ) : (
        <>
          <nav className="detail-tabs">
            {TABS.map((t) => (
              <button
                key={t.key}
                className={`detail-tab${srcTab === t.key ? " active" : ""}`}
                onClick={() => setSrcTab(t.key)}
              >
                {t.label}
              </button>
            ))}
          </nav>

          {srcTab === "mine" ? (
            <MineNewsPanel />
          ) : srcTab === "sector" ? (
            <SectorNews perSector={50} defaultSort="recent" />
          ) : srcTab === "naver" ? (
            <NaverFinanceFrame />
          ) : (
            <MainNewsPanel cat={srcTab} />
          )}
        </>
      )}

      <div className="table-note">
        뉴스는 네이버, 공시는 금융감독원 DART · 제목을 누르면 원문으로 이동합니다
      </div>
    </div>
  );
}
