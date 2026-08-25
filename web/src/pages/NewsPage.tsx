import { useEffect, useState } from "react";
import { api, normalizeStockCode, type NaverNewsCat, type StockSearchResult } from "../api";
import { BreakingNews } from "../components/BreakingNews";
import { MainNewsPanel } from "../components/MainNewsPanel";
import { MineNewsPanel } from "../components/MineNewsPanel";
import { DisclosureList, NewsList } from "../components/NewsDisclosurePanel";
import { NaverFinanceFrame } from "../components/NaverFinanceFrame";
import { SectorNews } from "../components/SectorNews";
import { useDragOrder } from "../useDragOrder";

/*
 * 뉴스 탭 (2026-08-26 확장) — 네이버 증권의 갈래를 그대로 편다.
 * 기본 순서: 주요뉴스 → ⚡속보(그 옆 — 사용자 요청) → 시황·전망 → 기업·종목 →
 * 해외증시 → ⭐관심종목 → 부동산 → 분야별 → 맨 끝 네이버 증권 바로가기.
 * **탭을 끌면 순서가 바뀌고 이 기기에 저장된다** (useDragOrder — 다른 순서 UI 와 동일).
 */
type SrcTab = NaverNewsCat | "mine" | "sector" | "naver";
const TAB_LABEL: Record<SrcTab, string> = {
  main: "🏠 주요뉴스",
  flash: "⚡ 속보",
  market: "시황·전망",
  company: "기업·종목",
  world: "해외증시",
  mine: "⭐ 관심종목",
  estate: "부동산",
  sector: "분야별 뉴스",
  naver: "네이버 증권",
};
const TAB_DEFAULT: SrcTab[] = [
  "main", "flash", "market", "company", "world", "mine", "estate", "sector", "naver",
];
const TAB_ORDER_KEY = "vntg.newsTabOrder.v1";

function loadTabOrder(): SrcTab[] {
  try {
    const saved = JSON.parse(localStorage.getItem(TAB_ORDER_KEY) ?? "[]") as string[];
    // 저장본에 없는 새 탭은 기본 자리 순서대로 뒤에 잇는다 — 탭이 늘어도 안 사라진다
    const known = saved.filter((k): k is SrcTab => (TAB_DEFAULT as string[]).includes(k));
    return [...known, ...TAB_DEFAULT.filter((k) => !known.includes(k))];
  } catch {
    return TAB_DEFAULT;
  }
}

export function NewsPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [picked, setPicked] = useState<{ code: string; name: string } | null>(null);
  /** 종목이 아니라 **키워드**로 검색한 상태 — 「2차전지」「금리 인하」 같은 것 */
  const [keyword, setKeyword] = useState<string | null>(null);
  const [srcTab, setSrcTab] = useState<SrcTab>("main");
  const [tabOrder, setTabOrder] = useState<SrcTab[]>(loadTabOrder);
  /** 폰은 드래그가 안 된다 — ↔ 순서 모드에서 ◀▶ 로 옮긴다(다른 순서 UI 와 같은 병존) */
  const [tabEdit, setTabEdit] = useState(false);
  const commitTabs = (next: string[]) => {
    setTabOrder(next as SrcTab[]);
    try {
      localStorage.setItem(TAB_ORDER_KEY, JSON.stringify(next));
    } catch {
      // 저장이 안 돼도 이번 화면에선 바뀐 순서로 쓴다
    }
  };
  const tabDrag = useDragOrder(tabOrder, commitTabs);
  const moveTab = (k: SrcTab, dir: -1 | 1) => {
    const i = tabOrder.indexOf(k);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= tabOrder.length) return;
    const next = [...tabOrder];
    next.splice(i, 1);
    next.splice(j, 0, k);
    commitTabs(next);
  };

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
            {tabOrder.map((k, i) => (
              <span key={k} className="nt-tab">
                {tabEdit && (
                  <button
                    className="row-del-btn"
                    disabled={i === 0}
                    onClick={() => moveTab(k, -1)}
                    title="앞으로"
                  >
                    ◀
                  </button>
                )}
                <button
                  className={`detail-tab${srcTab === k ? " active" : ""}${tabDrag.cls(k)}`}
                  onClick={() => setSrcTab(k)}
                  title="끌어서(PC) 또는 ↔ 순서 모드(폰)로 탭 순서를 바꿉니다"
                  {...tabDrag.props(k)}
                >
                  {TAB_LABEL[k]}
                </button>
                {tabEdit && (
                  <button
                    className="row-del-btn"
                    disabled={i === tabOrder.length - 1}
                    onClick={() => moveTab(k, 1)}
                    title="뒤로"
                  >
                    ▶
                  </button>
                )}
              </span>
            ))}
            <button
              className={`filter-btn nt-edit${tabEdit ? " active" : ""}`}
              onClick={() => setTabEdit((v) => !v)}
              title="탭 순서 바꾸기 — 폰에서는 이 모드로, PC 는 끌어서도 됩니다"
            >
              {tabEdit ? "✓ 완료" : "↔ 순서"}
            </button>
          </nav>

          {srcTab === "mine" ? (
            <MineNewsPanel />
          ) : srcTab === "flash" ? (
            /*
             * ⚡속보는 **원래의 속보**다 (2026-08-26 — 「찐 속보 올라오는 곳이야
             * 다시 고쳐놔」). 네이버 검색 API 에서 [속보]·[단독]·[긴급] 머리표만
             * 골라낸 것 — 네이버 증권의 flashnews 목록으로 바꿨다가 되돌렸다.
             */
            <BreakingNews />
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
