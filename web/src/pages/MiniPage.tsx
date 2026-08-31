import { useEffect, useState } from "react";
import { api, normalizeStockCode, type StockSearchResult } from "../api";
import { StockDetail } from "../components/StockDetail";
import {
  MINI_SCREENS,
  onMiniConfigChange,
  readMiniConfig,
  type MiniScreenKey,
} from "../miniConfig";
import { OverviewPage } from "./OverviewPage";
import { MyPage } from "./MyPage";
import { NewsPage } from "./NewsPage";
import { SuperDashboardPage } from "./SuperDashboardPage";
import { TelegramPage } from "./TelegramPage";
import { MemoPage } from "./MemoPage";
import { DailyReportPage } from "./DailyReportPage";
/* 보드의 시장 무관 블록들 — 종목이 없어도 그려져서 미니창에 딱 맞다 (2026-08-26) */
import { IndexBoard } from "../components/IndexBoard";
import { MarketSignalPanel } from "../components/MarketSignalPanel";
import { MarketPulsePanel } from "../components/MarketPulsePanel";
import { BreadthPanel } from "../components/BreadthPanel";
import { SectorFlowPanel } from "../components/SectorFlowPanel";
import { ViPanel } from "../components/ViPanel";
import { WatchTicker } from "../components/WatchTicker";
import { useRecentStocks } from "../useRecentStocks";

/**
 * 미니창 (2026-08-26) — **보던 페이지를 떠나지 않고 곁눈질하는 보조창.**
 *
 * 설정 밑 「미니창 열기」(또는 단축키)가 작은 팝업 창으로 이 화면을 연다(#/mini).
 *
 * 상단에 **버튼 1·2·3** — 각 버튼에 어떤 화면을 물릴지는 설정 > 화면 > 미니창에서
 * 고른다(기본: 종목 검색 · 시황 · 관심종목). 종목 검색 화면은 검색창 고정 + 상세가
 * 본문으로 펼쳐지고(mini-inline 이 오버레이를 눕힌다), 다른 화면들은 본창 페이지를
 * 그대로 빌려 쓴다 — 거기서 종목을 누르면 상세가 보통 팝업으로 뜬다.
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
  const [cfg, setCfg] = useState(readMiniConfig);
  const [slot, setSlot] = useState(0);
  /* 종목검색이 아닌 화면에서 종목을 눌렀을 때 — 보통 오버레이 시트로 */
  const [popupStock, setPopupStock] = useState<{ code: string; name: string } | null>(null);

  useEffect(() => onMiniConfigChange(() => setCfg(readMiniConfig())), []);

  const screenKey: MiniScreenKey = cfg.slots[slot] ?? "stock";
  const openPopup = (code: string, name: string) => setPopupStock({ code, name });

  return (
    <div className="mini-root">
      {/* 상단 버튼 — 1·2·3. 어떤 화면인지는 아이콘+이름이 말한다 */}
      <div className="mini-tabs">
        {cfg.slots.map((key, i) => {
          const def = MINI_SCREENS.find((s) => s.key === key);
          return (
            <button
              key={i}
              className={`mini-tab${slot === i ? " active" : ""}`}
              onClick={() => setSlot(i)}
              title={def?.hint}
            >
              <i>{i + 1}</i> {def?.icon} {def?.label}
            </button>
          );
        })}
        <button
          className="mini-tab mini-tab-cfg"
          title="버튼 배정·단축키는 본창 설정 > 화면 > 미니창에서 — 새 탭으로 엽니다"
          onClick={() => window.open(`${window.location.pathname}#/settings`, "_blank")}
        >
          ⚙
        </button>
      </div>

      <div className="mini-body">
        {screenKey === "stock" && <StockSearchScreen stock={stock} onSelect={onSelect} onClear={onClear} />}
        {screenKey === "overview" && <OverviewPage onSelectStock={openPopup} />}
        {screenKey === "watch" && <MyPage onSelectStock={openPopup} />}
        {screenKey === "news" && <NewsPage onSelectStock={openPopup} />}
        {screenKey === "superSignal" && <SuperDashboardPage onSelectStock={openPopup} />}
        {screenKey === "telegram" && <TelegramPage onSelectStock={openPopup} />}
        {screenKey === "memo" && <MemoPage />}
        {screenKey === "report" && <DailyReportPage onSelectStock={openPopup} />}
        {/* 보드 블록들 */}
        {screenKey === "indexBoard" && <IndexBoard />}
        {screenKey === "marketSignal" && <MarketSignalPanel />}
        {screenKey === "pulse" && <MarketPulsePanel onSelectStock={openPopup} />}
        {screenKey === "breadth" && <BreadthPanel />}
        {screenKey === "sectorFlow" && <SectorFlowPanel onSelectStock={openPopup} />}
        {screenKey === "vi" && <ViPanel onSelectStock={openPopup} />}
        {screenKey === "watchTicker" && <WatchTicker onSelectStock={openPopup} />}
      </div>

      {/* 다른 화면에서 종목을 눌렀을 때 — 여긴 검색창이 없으니 보통 팝업 시트가 맞다 */}
      {popupStock && (
        <StockDetail
          code={popupStock.code}
          name={popupStock.name}
          onClose={() => setPopupStock(null)}
          onOpenAnalysis={(code, name) => {
            window.open(
              `${window.location.pathname}#/stockAnalysis?code=${code}&name=${encodeURIComponent(name)}`,
              "_blank",
            );
          }}
          onSelectStock={(code, name) => setPopupStock({ code, name })}
        />
      )}
    </div>
  );
}

/** 종목 검색 화면 — 검색창 고정 + 결과·상세가 본문으로 (미니창의 원래 용도) */
function StockSearchScreen({
  stock,
  onSelect,
  onClear,
}: {
  stock: { code: string; name: string } | null;
  onSelect: (code: string, name: string) => void;
  onClear: () => void;
}) {
  const recent = useRecentStocks();
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
    /* 최근 본 종목에 쌓는다 — 어느 검색칸에서 골라도 같은 목록에 모여야 쓸모가 있다 */
    recent.push(normalizeStockCode(r.code), r.name);
    onSelect(normalizeStockCode(r.code), r.name);
    setQuery("");
    setResults([]);
  }

  const q = query.trim();

  return (
    <div className="mini-inline">
      {/* 검색은 항상 맨 위 — 종목을 보다가도 바로 다음 종목을 찾는다 */}
      <div className="mini-search">
        <span className="mini-search-icon" aria-hidden="true">🔎</span>
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
          위에서 검색해 고르면 종목 상세가 바로 아래에 펼쳐집니다. 상단 버튼으로 다른
          화면(배정은 설정 &gt; 화면 &gt; 미니창)으로 바꿀 수 있습니다.
        </div>
      )}
    </div>
  );
}
