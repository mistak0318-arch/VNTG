import { useEffect, useState, type CSSProperties } from "react";
import { CustomThemePage } from "./pages/CustomThemePage";
import { ScreenerPage } from "./pages/ScreenerPage";
import { AskPage } from "./pages/AskPage";
import { MarketFlowPage } from "./pages/MarketFlowPage";
import { StockDetail } from "./components/StockDetail";
import { AccountInfoPage } from "./pages/AccountInfoPage";
import { AlgoPicksPage } from "./pages/AlgoPicksPage";
import { CalendarPage } from "./pages/CalendarPage";
import { ContinuousTradePage } from "./pages/ContinuousTradePage";
import { DailyReportPage } from "./pages/DailyReportPage";
import { KiwoomWatchlistPage } from "./pages/KiwoomWatchlistPage";
import { ManualAccountPage } from "./pages/ManualAccountPage";
import { MapPage } from "./pages/MapPage";
import { MyPage } from "./pages/MyPage";
import { NewsPage } from "./pages/NewsPage";
import { OverviewPage } from "./pages/OverviewPage";
import { ProgramTradePage } from "./pages/ProgramTradePage";
import { SettingsPage } from "./pages/SettingsPage";
import { SameNetTradeRankingPage } from "./pages/SameNetTradeRankingPage";
import { StockAnalysisPage } from "./pages/StockAnalysisPage";
import { VolumeRankingPage } from "./pages/VolumeRankingPage";
import { useHashRoute } from "./useHashRoute";

type Tab =
  | "overview"
  | "report"
  | "map"
  | "program"
  | "news"
  | "watchAi"
  | "watchKiwoom"
  | "calendar"
  | "marketFlow"
  | "customTheme"
  | "ask"
  | "stockAnalysis"
  | "screener"
  | "volume"
  | "sameNet"
  | "continuous"
  | "algo"
  | "account"
  | "manualAccount"
  | "settings";

/**
 * 사이드바 메뉴 구조. 그룹 아래에 항목을 추가하는 식으로 기능을 늘려간다.
 *
 * 메뉴가 스무 개 가까이 되면서 글자만으로는 원하는 걸 못 찾는다.
 * 그래서 그룹마다 색을 주고 항목마다 아이콘을 붙였다 — 글자를 읽기 전에
 * **모양과 색으로 먼저 덩어리를 찾고** 그 안에서 고르게 하려는 것이다.
 */
const MENU: {
  group: string;
  /** 그룹 구분용 강조색. 라벨 앞 막대와 활성 항목에 쓴다 */
  accent: string;
  items: { key: Tab; label: string; icon: string }[];
}[] = [
  {
    group: "시황",
    accent: "#4c8dff",
    items: [
      { key: "overview", label: "시황 대시보드", icon: "📊" },
      { key: "report", label: "데일리 리포트", icon: "📰" },
      { key: "map", label: "테마/업종 MAP", icon: "🗺️" },
      { key: "program", label: "프로그램 매매", icon: "🤖" },
      { key: "news", label: "뉴스·공시", icon: "📢" },
      { key: "ask", label: "시황 질문하기", icon: "💬" },
    ],
  },
  {
    group: "마이페이지",
    accent: "#f5c542",
    items: [
      { key: "watchAi", label: "관심종목 (AI_HTS)", icon: "⭐" },
      { key: "watchKiwoom", label: "관심종목 (키움_HTS)", icon: "🔖" },
      { key: "customTheme", label: "내 테마", icon: "🎯" },
      { key: "marketFlow", label: "시장 흐름 분석", icon: "🌊" },
      { key: "calendar", label: "캘린더", icon: "📅" },
    ],
  },
  {
    group: "종목 분석",
    accent: "#35c46a",
    items: [
      { key: "stockAnalysis", label: "개별종목분석", icon: "🔍" },
      { key: "screener", label: "시세분석", icon: "📡" },
      { key: "volume", label: "거래상위", icon: "🔥" },
      { key: "sameNet", label: "동일순매매순위", icon: "🤝" },
      { key: "continuous", label: "연속매매현황", icon: "📈" },
      { key: "algo", label: "내 알고리즘", icon: "🧮" },
    ],
  },
  {
    group: "계좌",
    accent: "#a97bd6",
    items: [
      { key: "account", label: "연동 계좌 (키움)", icon: "💳" },
      { key: "manualAccount", label: "수동 계좌", icon: "✏️" },
    ],
  },
  {
    group: "설정",
    accent: "#8b98a5",
    items: [{ key: "settings", label: "API 사용량·설정", icon: "⚙️" }],
  },
];

const TAB_LABELS = Object.fromEntries(
  MENU.flatMap((g) => g.items).map((i) => [i.key, `${i.icon} ${i.label}`]),
) as Record<Tab, string>;

const VALID_TABS = new Set(MENU.flatMap((g) => g.items).map((i) => i.key));

export default function App() {
  const { route, navigate } = useHashRoute("overview");
  const [navOpen, setNavOpen] = useState(false);

  // 주소창에 이상한 값이 들어와도 화면이 비지 않도록 방어
  const tab = (VALID_TABS.has(route.tab as Tab) ? route.tab : "overview") as Tab;
  const selected = route.stock;

  function onSelectStock(code: string, name: string) {
    navigate({ stock: { code, name } });
  }

  // 종목 상세(모달) → 개별종목분석 페이지로. 종목은 유지한 채 탭만 옮긴다.
  function openAnalysis(code: string, name: string) {
    navigate({ tab: "stockAnalysis", stock: { code, name } });
    setNavOpen(false);
  }

  function go(next: Tab) {
    // 메뉴를 옮기면 열려 있던 종목 상세는 닫는다
    navigate({ tab: next, stock: null });
    setNavOpen(false); // 모바일에서 항목을 고르면 드로어를 닫는다
  }

  // 드로어가 열려 있을 때 배경 스크롤 방지
  useEffect(() => {
    document.body.style.overflow = navOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [navOpen]);

  return (
    <div className="layout">
      <aside className={`sidebar${navOpen ? " open" : ""}`}>
        <div className="sidebar-brand">VNTG HTS</div>
        <nav className="sidebar-nav">
          {MENU.map((g) => (
            <div
              className="nav-group"
              key={g.group}
              style={{ "--accent": g.accent } as CSSProperties}
            >
              <div className="nav-group-label">{g.group}</div>
              {g.items.map((item) => (
                <button
                  key={item.key}
                  className={`nav-item${tab === item.key ? " active" : ""}`}
                  onClick={() => go(item.key)}
                >
                  <span className="nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="nav-label">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </nav>
      </aside>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <div className="main">
        <header className="mobile-header">
          <button className="nav-toggle" onClick={() => setNavOpen(true)} aria-label="메뉴 열기">
            ☰
          </button>
          <span className="mobile-title">{TAB_LABELS[tab]}</span>
        </header>

        <div className="main-inner">
          {tab === "overview" && <OverviewPage onSelectStock={onSelectStock} />}
          {tab === "report" && <DailyReportPage onSelectStock={onSelectStock} />}
          {tab === "map" && <MapPage onSelectStock={onSelectStock} />}
          {tab === "program" && <ProgramTradePage />}
          {tab === "news" && <NewsPage onSelectStock={onSelectStock} />}
          {tab === "watchAi" && <MyPage onSelectStock={onSelectStock} />}
          {tab === "watchKiwoom" && <KiwoomWatchlistPage onSelectStock={onSelectStock} />}
          {tab === "customTheme" && <CustomThemePage onSelectStock={onSelectStock} />}
          {tab === "marketFlow" && <MarketFlowPage onSelectStock={onSelectStock} />}
          {tab === "ask" && <AskPage />}
          {tab === "calendar" && <CalendarPage />}
          {tab === "screener" && <ScreenerPage onSelectStock={onSelectStock} />}
          {tab === "stockAnalysis" && (
            <StockAnalysisPage stock={selected} onSelectStock={openAnalysis} />
          )}
          {tab === "volume" && <VolumeRankingPage onSelectStock={onSelectStock} />}
          {tab === "sameNet" && <SameNetTradeRankingPage onSelectStock={onSelectStock} />}
          {tab === "continuous" && <ContinuousTradePage onSelectStock={onSelectStock} />}
          {tab === "algo" && <AlgoPicksPage onSelectStock={onSelectStock} />}
          {tab === "account" && <AccountInfoPage onSelectStock={onSelectStock} />}
          {tab === "manualAccount" && <ManualAccountPage onSelectStock={onSelectStock} />}
          {tab === "settings" && <SettingsPage />}
        </div>
      </div>

      {/* 개별종목분석 탭은 종목을 페이지 안에서 직접 보여주므로 모달을 띄우지 않는다 */}
      {selected && tab !== "stockAnalysis" && (
        <StockDetail
          code={selected.code}
          name={selected.name}
          onClose={() => navigate({ stock: null })}
          onOpenAnalysis={openAnalysis}
          onSelectStock={onSelectStock}
        />
      )}
    </div>
  );
}
