import { useEffect, useRef, useState } from "react";
import { api, normalizeStockCode, type StockSearchResult } from "../api";
import { useStockFocus } from "../useStockFocus";
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
/* 2026-09-07 추가 — 기능이 늘어 미니창에도 (벤티지: "매수직전, 시세분석, 테마MAP 등… 주문도") */
import { ScopePage } from "./ScopePage";
import { OrderPage } from "./OrderPage";
import { ScreenerPage } from "./ScreenerPage";
import { MapPage } from "./MapPage";
import { ListTrackPage } from "./ListTrackPage";
import { ScreenPage } from "./ScreenPage";
import { VolumeRankingPage } from "./VolumeRankingPage";
import { CisPage } from "./CisPage";
import { EtfPage } from "./EtfPage";
import { MarketFlowPage } from "./MarketFlowPage";
import { CondSearchPage } from "./CondSearchPage";
import { ThemeDbPage } from "./ThemeDbPage";
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
  /*
   * **바로 열기** (2026-09-07) — `#/mini?screen=order` 로 열리면 그 화면부터.
   * 주문 단축키(o 연타)가 이 길로 온다. 버튼에 배정돼 있지 않아도 뜬다 — 단추를 누르면
   * 그때부터 배정된 화면으로 돌아간다. 라우터가 해시를 `{tab, stock}` 으로만 다시 쓰기
   * 전, 처음 뜰 때 한 번만 읽는다(`useState` 초기값).
   */
  const readForced = (): MiniScreenKey | null => {
    const q = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
    const k = q.get("screen");
    return k && MINI_SCREENS.some((s) => s.key === k) ? (k as MiniScreenKey) : null;
  };
  const [forced, setForced] = useState<MiniScreenKey | null>(readForced);
  /*
   * 미니창이 **이미 떠 있을 때** 단축키를 누르면 같은 이름의 창이라 새로 뜨지 않고
   * 주소만 바뀐다(해시만 다르면 새로고침도 없다). 그때도 주문으로 넘어가야 하므로
   * `hashchange` 를 듣는다 — 안 들으면 창은 안 뜨고 아무 일도 안 일어난 것처럼 보인다.
   */
  useEffect(() => {
    const onHash = () => {
      const k = readForced();
      if (k) setForced(k);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  /* 종목검색이 아닌 화면에서 종목을 눌렀을 때 — 보통 오버레이 시트로 */
  const [popupStock, setPopupStock] = useState<{ code: string; name: string } | null>(null);

  useEffect(() => onMiniConfigChange(() => setCfg(readMiniConfig())), []);

  const screenKey: MiniScreenKey = forced ?? cfg.slots[slot] ?? "stock";
  /*
   * ⚠️ **미니창도 창이다** (2026-09-08 — 벤티지: "미니창에서 종목 클릭하면 다른 창이랑
   * 종목 연동이 안 된다").
   *
   * 본창은 `onSelectStock` 한 곳에서 `focus.publish` 를 부르는데(App.tsx), 미니창은
   * 제 라우팅을 따로 써서 그 자리를 안 지났다. 그래서 미니창에서 고른 종목은 저 혼자만
   * 바뀌었다. 종목을 고르는 길이 둘로 갈렸으면 **양쪽 다 알려야** 한다.
   */
  const { focus, publish } = useStockFocus();
  const openPopup = (code: string, name: string) => {
    setPopupStock({ code, name });
    publish(code, name);
  };
  /* 종목검색 화면에서 고른 것도 같이 알린다 — 미니창의 본업이 이쪽이다 */
  const selectAndPublish = (code: string, name: string) => {
    onSelect(code, name);
    publish(code, name);
  };
  /*
   * 반대 방향도 — **다른 창이 고른 종목을 미니창이 따라간다.**
   * 연동은 한쪽으로만 흐르면 반쪽이다. 본창에서 종목을 누르면 옆에 띄워 둔 미니창이
   * 같이 바뀌어야 「한 프로그램」이 된다. 내가 보낸 메아리는 useStockFocus 가 거른다.
   */
  const seenFocusAt = useRef(focus?.at);
  useEffect(() => {
    if (!focus || seenFocusAt.current === focus.at) return;
    seenFocusAt.current = focus.at;
    onSelect(focus.code, focus.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.at]);

  return (
    <div className="mini-root">
      {/* 상단 버튼 — 1·2·3. 어떤 화면인지는 아이콘+이름이 말한다 */}
      <div className="mini-tabs">
        {cfg.slots.map((key, i) => {
          const def = MINI_SCREENS.find((s) => s.key === key);
          return (
            <button
              key={i}
              className={`mini-tab${!forced && slot === i ? " active" : ""}`}
              onClick={() => {
                setForced(null);
                setSlot(i);
              }}
              title={def?.hint}
            >
              <i>{i + 1}</i> {def?.icon} {def?.label}
            </button>
          );
        })}
        {forced && !cfg.slots.includes(forced) && (
          <button className="mini-tab active" title="단축키로 연 화면 — 다른 단추를 누르면 사라집니다">
            {MINI_SCREENS.find((s) => s.key === forced)?.icon} {MINI_SCREENS.find((s) => s.key === forced)?.label}
          </button>
        )}
        <button
          className="mini-tab mini-tab-cfg"
          title="버튼 배정·단축키는 본창 설정 > 화면 > 미니창에서 — 새 탭으로 엽니다"
          onClick={() => window.open(`${window.location.pathname}#/settings`, "_blank")}
        >
          ⚙
        </button>
      </div>

      <div className="mini-body">
        {screenKey === "stock" && <StockSearchScreen stock={stock} onSelect={selectAndPublish} onClear={onClear} />}
        {screenKey === "overview" && <OverviewPage onSelectStock={openPopup} />}
        {screenKey === "watch" && <MyPage onSelectStock={openPopup} />}
        {screenKey === "news" && <NewsPage onSelectStock={openPopup} />}
        {screenKey === "superSignal" && <SuperDashboardPage onSelectStock={openPopup} />}
        {screenKey === "telegram" && <TelegramPage onSelectStock={openPopup} />}
        {screenKey === "memo" && <MemoPage />}
        {screenKey === "report" && <DailyReportPage onSelectStock={openPopup} />}
        {screenKey === "scope" && <ScopePage onSelectStock={openPopup} />}
        {/* 주문 — 겹(기기 등록·PIN·비밀번호)은 페이지 안에 있다. 미니창이라고 건너뛰는 건 없다 */}
        {screenKey === "order" && <OrderPage onSelectStock={openPopup} />}
        {screenKey === "screener" && <ScreenerPage onSelectStock={openPopup} />}
        {screenKey === "map" && <MapPage onSelectStock={openPopup} />}
        {screenKey === "listTrack" && <ListTrackPage onSelectStock={openPopup} />}
        {screenKey === "signalScreen" && <ScreenPage onSelectStock={openPopup} />}
        {screenKey === "volume" && <VolumeRankingPage onSelectStock={openPopup} />}
        {screenKey === "cis" && <CisPage onSelectStock={openPopup} />}
        {screenKey === "etf" && <EtfPage onSelectStock={openPopup} />}
        {screenKey === "marketFlow" && <MarketFlowPage onSelectStock={openPopup} />}
        {screenKey === "condSearch" && <CondSearchPage onSelectStock={openPopup} />}
        {screenKey === "themedb" && <ThemeDbPage onSelectStock={openPopup} />}
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
