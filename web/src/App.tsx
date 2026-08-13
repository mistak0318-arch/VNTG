import { useEffect, useState } from "react";
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
  | "ask"
  | "stockAnalysis"
  | "volume"
  | "sameNet"
  | "continuous"
  | "algo"
  | "account"
  | "manualAccount"
  | "settings";

/** 사이드바 메뉴 구조. 그룹 아래에 항목을 추가하는 식으로 기능을 늘려간다. */
const MENU: { group: string; items: { key: Tab; label: string }[] }[] = [
  {
    group: "시황",
    items: [
      { key: "overview", label: "시황 대시보드" },
      { key: "report", label: "데일리 리포트" },
      { key: "map", label: "테마/업종 MAP" },
      { key: "program", label: "프로그램 매매" },
      { key: "news", label: "뉴스·공시" },
      { key: "ask", label: "시황 질문하기" },
    ],
  },
  {
    group: "마이페이지",
    items: [
      { key: "watchAi", label: "관심종목 (AI_HTS)" },
      { key: "watchKiwoom", label: "관심종목 (키움_HTS)" },
      { key: "marketFlow", label: "시장 흐름 분석" },
      { key: "calendar", label: "캘린더" },
    ],
  },
  {
    group: "종목 분석",
    items: [
      { key: "stockAnalysis", label: "개별종목분석" },
      { key: "volume", label: "거래상위" },
      { key: "sameNet", label: "동일순매매순위" },
      { key: "continuous", label: "연속매매현황" },
      { key: "algo", label: "내 알고리즘" },
    ],
  },
  {
    group: "계좌",
    items: [
      { key: "account", label: "연동 계좌 (키움)" },
      { key: "manualAccount", label: "수동 계좌" },
    ],
  },
  {
    group: "설정",
    items: [{ key: "settings", label: "API 사용량·설정" }],
  },
];

const TAB_LABELS = Object.fromEntries(
  MENU.flatMap((g) => g.items).map((i) => [i.key, i.label]),
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
            <div className="nav-group" key={g.group}>
              <div className="nav-group-label">{g.group}</div>
              {g.items.map((item) => (
                <button
                  key={item.key}
                  className={`nav-item${tab === item.key ? " active" : ""}`}
                  onClick={() => go(item.key)}
                >
                  {item.label}
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
          {tab === "marketFlow" && <MarketFlowPage />}
          {tab === "ask" && <AskPage />}
          {tab === "calendar" && <CalendarPage />}
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
