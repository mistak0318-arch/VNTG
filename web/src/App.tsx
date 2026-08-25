import { useEffect, useRef, useState, type CSSProperties } from "react";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RunningJobsBar } from "./components/RunningJobsBar";
import { QuickStockSearch } from "./components/QuickStockSearch";
import { CustomThemePage } from "./pages/CustomThemePage";
import { ScreenerPage } from "./pages/ScreenerPage";
import { ScreenPage } from "./pages/ScreenPage";
import { PaperTradePage } from "./pages/PaperTradePage";
import { JournalPage } from "./pages/JournalPage";
import { MemoPage } from "./pages/MemoPage";
import { UsWatchPage } from "./pages/UsWatchPage";
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
import { StockDiscoveryPage } from "./pages/StockDiscoveryPage";
import { VolumeRankingPage } from "./pages/VolumeRankingPage";
import { BriefingPage } from "./pages/BriefingPage";
import { useHashRoute } from "./useHashRoute";
import { applyOrder, useMenuPrefs } from "./useMenuOrder";
import { useScreenLock } from "./useScreenLock";
import { ScreenLock } from "./components/ScreenLock";
import { ExcelChrome } from "./components/ExcelChrome";
import { useAppearance } from "./useAppearance";
import { BoardPage } from "./pages/BoardPage";
import { CornerToggle } from "./components/CornerToggle";
import { AuthExpiredBar } from "./components/AuthExpiredBar";
import { useStockFocus } from "./useStockFocus";
import { TelegramPage } from "./pages/TelegramPage";
import { GuidePage } from "./pages/GuidePage";

type Tab =
  | "briefing"
  | "overview"
  | "report"
  | "map"
  | "program"
  | "news"
  | "discovery"
  | "watchAi"
  | "watchKiwoom"
  | "calendar"
  | "marketFlow"
  | "customTheme"
  | "signalScreen"
  | "journal"
  | "memo"
  | "usWatch"
  | "ask"
  | "telegram"
  | "stockAnalysis"
  | "screener"
  | "volume"
  | "sameNet"
  | "continuous"
  | "algo"
  | "account"
  | "manualAccount"
  | "paper"
  | "settings"
  | "board"
  | "guide";

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
      /*
        브리핑이 맨 앞이자 홈이다 — 요약(브리핑) → 상세(대시보드)의 순서.
        대시보드는 카드 13장을 파고드는 자리라 「열자마자 3초」용이 아니다.
      */
      { key: "briefing", label: "마켓 브리핑", icon: "🌡️" },
      { key: "overview", label: "시황 대시보드", icon: "📊" },
      { key: "report", label: "데일리 리포트", icon: "📰" },
      { key: "map", label: "테마/업종 MAP", icon: "🗺️" },
      { key: "program", label: "프로그램 매매", icon: "🤖" },
      { key: "news", label: "뉴스·공시", icon: "📢" },
      { key: "ask", label: "시황 질문하기", icon: "💬" },
    ],
  },
  {
    group: "종목 분석",
    accent: "#35c46a",
    items: [
      { key: "stockAnalysis", label: "개별종목분석", icon: "🔍" },
      // 다른 창에서 고른 종목을 따라 그리는 자리 — 모니터를 여러 대 쓸 때
      { key: "board", label: "보드 (창 연동)", icon: "🖥️" },
      { key: "screener", label: "시세분석", icon: "🔬" },
      { key: "volume", label: "거래상위", icon: "🔥" },
      { key: "sameNet", label: "동일순매매순위", icon: "🤝" },
      { key: "continuous", label: "연속매매현황", icon: "📈" },
      { key: "algo", label: "내 알고리즘", icon: "🧮" },
    ],
  },
  {
    group: "마이페이지",
    accent: "#f5c542",
    items: [
      // 발굴을 맨 위에 — 관심종목은 이미 고른 것이고, 이건 고르는 자리다
      { key: "discovery", label: "종목발굴", icon: "⛏️" },
      { key: "watchAi", label: "관심종목 (VNTG)", icon: "⭐" },
      { key: "watchKiwoom", label: "관심종목 (키움연동)", icon: "🔖" },
      { key: "usWatch", label: "관심종목 (해외)", icon: "🌏" },
      { key: "customTheme", label: "내 테마", icon: "🎯" },
      { key: "signalScreen", label: "신호등 찾기", icon: "🚦" },
      { key: "journal", label: "복기 노트", icon: "📓" },
      { key: "memo", label: "메모장", icon: "📝" },
      { key: "marketFlow", label: "시장 흐름 분석", icon: "🌊" },
      { key: "telegram", label: "텔레그램 동향", icon: "📡" },
      { key: "calendar", label: "캘린더", icon: "📅" },
    ],
  },
  {
    group: "계좌",
    accent: "#a97bd6",
    items: [
      // 모의투자를 맨 위에 — 실제 잔고보다 이쪽이 알고리즘을 증명하는 자리다
      { key: "paper", label: "모의투자", icon: "🧪" },
      { key: "account", label: "연동 계좌 (키움)", icon: "💳" },
      { key: "manualAccount", label: "수동 계좌", icon: "✏️" },
    ],
  },
  {
    group: "설정",
    accent: "#8b98a5",
    items: [
      { key: "settings", label: "API 사용량·설정", icon: "⚙️" },
      // 기능 설명서가 아니라 **순서와 이유**를 적는 자리다
      { key: "guide", label: "도움말", icon: "📖" },
    ],
  },
];

/** 설정 화면이 메뉴 순서를 편집할 수 있도록 평평하게 내보낸다 */
export const MENU_ITEMS = MENU.flatMap((g) =>
  g.items.map((i) => ({ key: i.key as string, label: i.label, icon: i.icon, group: g.group })),
);

const TAB_LABELS = Object.fromEntries(
  MENU.flatMap((g) => g.items).map((i) => [i.key, `${i.icon} ${i.label}`]),
) as Record<Tab, string>;

const VALID_TABS = new Set(MENU.flatMap((g) => g.items).map((i) => i.key));

export default function App() {
  /* 홈 = 브리핑. 앱을 열면 「오늘 시장이 어떤가」부터 — 파고들기는 대시보드로 */
  const { route, navigate } = useHashRoute("briefing");
  const [navOpen, setNavOpen] = useState(false);
  const { prefs } = useMenuPrefs();
  /* 자리를 비웠을 때 화면을 가린다 — 기기마다 따로 켠다 */
  const lock = useScreenLock();
  const appearance = useAppearance();
  const excel = appearance.theme === "excel";
  /* 창들을 한 프로그램처럼 묶는다 — 꺼져 있으면 아무 일도 안 한다 */
  const focus = useStockFocus();
  /* 엑셀 모드를 끌 때 돌아갈 곳 — 엑셀이 아니었던 마지막 테마 */
  const prevTheme = useRef<"dark" | "light">("dark");
  useEffect(() => {
    if (appearance.theme !== "excel") prevTheme.current = appearance.theme;
  }, [appearance.theme]);

  /*
   * 설정에서 정한 순서·숨김을 입힌다.
   * 숨긴 항목은 사이드바에서만 빠지고 주소로는 여전히 열린다 — 숨겼다고 기능을 막을 이유는 없다.
   */
  const label = (key: string, fallback: string) => prefs.labels[key]?.trim() || fallback;

  /*
   * 항목을 내가 지정한 영역으로 옮기고, 영역·이름도 내가 정한 것으로 갈아끼운다.
   * 새로 만든 영역은 MENU 에 없으므로 여기서 만들어 준다 — 없으면 그리로 옮긴 메뉴가
   * 사이드바에서 통째로 사라진다.
   */
  const flat = MENU.flatMap((g) =>
    g.items.map((i) => ({ ...i, group: prefs.groupOf[i.key] ?? g.group, accent: g.accent })),
  );
  const groupNames = [
    ...new Set([...MENU.map((g) => g.group), ...prefs.extraGroups, ...Object.values(prefs.groupOf)]),
  ];
  const accentOf = new Map(MENU.map((g) => [g.group, g.accent]));

  const menu = applyOrder(
    groupNames.map((g) => ({ key: g })),
    prefs.order,
  )
    .map((g) => ({
      group: g.key,
      label: label(g.key, g.key),
      accent: accentOf.get(g.key) ?? "#8b98a5",
      items: applyOrder(
        flat.filter((i) => i.group === g.key),
        prefs.order,
      )
        .filter((i) => !prefs.hidden.includes(i.key))
        .map((i) => ({ ...i, label: label(i.key, i.label) })),
    }))
    .filter((g) => g.items.length > 0);

  /*
   * 자주 쓰는 메뉴.
   *
   * 메뉴가 스물다섯을 넘으면서 매번 목록을 훑게 됐다. 순서를 바꿔 봐야 자주 쓰는 건
   * 대여섯인데 그것들이 그룹마다 흩어져 있어 소용이 없었다.
   * **그룹을 무시하고 맨 위에** 세운다 — 아래 원래 자리에도 그대로 남는다(찾을 때 헷갈리면 안 된다).
   */
  const favorites = prefs.favorites
    .map((key) => flat.find((i) => i.key === key))
    .filter((i): i is (typeof flat)[number] => Boolean(i))
    .map((i) => ({ ...i, label: label(i.key, i.label) }));

  // 주소창에 이상한 값이 들어와도 화면이 비지 않도록 방어
  const tab = (VALID_TABS.has(route.tab as Tab) ? route.tab : "overview") as Tab;

  /*
   * 엑셀 모드의 시트 탭.
   *
   * 장식으로 「Sheet1 Sheet2」를 적을 수도 있었지만, 그러면 화면 아래 한 줄을
   * 아무 일도 안 하는 데 쓰게 된다. 어차피 엑셀에서도 시트 탭이 하는 일은
   * **화면을 옮기는 것**이라, 자주 쓰는 메뉴를 걸어 두면 모양과 쓸모가 같이 산다.
   * 자주 쓰는 메뉴를 안 정했으면 그룹마다 첫 항목을 세운다 — 탭 줄이 비면 안 된다.
   */
  const sheetSource = favorites.length > 0 ? favorites : menu.map((g) => g.items[0]).filter(Boolean);
  const sheets = sheetSource.slice(0, 8).map((i) => ({ key: i.key as string, label: i.label }));
  if (!sheets.some((s) => s.key === tab)) {
    const here = flat.find((i) => i.key === tab);
    if (here) sheets.unshift({ key: tab, label: label(tab, here.label) });
  }

  const selected = route.stock;

  /*
   * 종목을 고르면 **열려 있는 다른 창에도 알린다.**
   *
   * 화면마다 따로 붙이지 않고 여기 한 곳에 둔다 — 종목을 고르는 길은 전부
   * 이 함수를 지나므로, 새 화면을 만들어도 연동이 저절로 따라온다.
   * 연동이 꺼져 있으면 `publish` 가 스스로 아무 일도 하지 않는다.
   */
  function onSelectStock(code: string, name: string) {
    navigate({ stock: { code, name } });
    focus.publish(code, name);
  }

  // 종목 상세(모달) → 개별종목분석 페이지로. 종목은 유지한 채 탭만 옮긴다.
  function openAnalysis(code: string, name: string) {
    navigate({ tab: "stockAnalysis", stock: { code, name } });
    focus.publish(code, name);
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
      {/*
        잠금은 **맨 앞에** 둔다. 뒤 화면을 완전히 덮어야 가리는 뜻이 있다.
        반투명이면 계좌 잔고가 비친다.
      */}
      {lock.locked && <ScreenLock onUnlock={lock.unlock} />}
      {/* 엑셀 껍데기 — 리본·행번호·시트탭. 잠금보다는 뒤, 본문보다는 앞 */}
      {excel && (
        <ExcelChrome
          sheets={sheets}
          current={tab}
          onGo={(k) => go(k as Tab)}
          onMenu={() => setNavOpen(true)}
        />
      )}

      {/*
        메뉴 여는 동그란 버튼.

        **`.main` 밖에 둔다.** 안에 두면 `.main` 이 만든 쌓임 맥락에 갇혀서,
        버튼의 z-index 를 아무리 올려도 바깥의 엑셀 껍데기 아래로 칠해진다 —
        실제로 그래서 엑셀 모드 왼쪽 위에서 버튼이 사라졌다.

        **엑셀 모드에서는 아예 안 띄운다.** 동그란 플로팅 버튼은 엑셀에 없는 물건이라,
        리본을 아무리 잘 그려도 그것 하나로 위장이 깨진다. 그 모드에서는 리본의
        「파일」 탭이 같은 일을 한다.
      */}
      {!excel && (
        <CornerToggle
          onOpen={() => setNavOpen(true)}
          label="메뉴 열기"
          side={appearance.navSide}
          onSide={(s) => appearance.set({ navSide: s })}
        />
      )}
      <aside className={`sidebar${navOpen ? " open" : ""}`}>
        {/* 회사에서도 열기 때문에 이름을 중립적으로 둔다 */}
        <div className="sidebar-brand">VNTG</div>
        <nav className="sidebar-nav">
          {favorites.length > 0 && (
            <div className="nav-group nav-fav">
              <div className="nav-group-label">자주 쓰는 메뉴</div>
              {favorites.map((item) => (
                <button
                  key={`fav-${item.key}`}
                  className={`nav-item${tab === item.key ? " active" : ""}`}
                  onClick={() => go(item.key)}
                >
                  <span className="nav-icon" aria-hidden="true">{item.icon}</span>
                  {item.label}
                </button>
              ))}
            </div>
          )}
          {menu.map((g) => (
            <div
              className="nav-group"
              key={g.group}
              style={{ "--accent": g.accent } as CSSProperties}
            >
              <div className="nav-group-label">{g.label}</div>
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

        {/*
          자물쇠는 **맨 아래**다. 자리를 뜰 때 한 번 누르는 버튼이라 자주 쓰는 메뉴 사이에
          있으면 안 된다 — 잘못 누르면 비밀번호를 넣어야 다시 들어온다.
          비밀번호를 안 정했으면 잠글 수가 없으므로 설정으로 보낸다.
        */}
        <div className="sidebar-foot">
          {/*
            연동은 **보내는 창에서도 켜야** 한다. 받는 창만 켜 두고 왜 안 되냐고
            하기 쉬운 자리라, 켜져 있을 때 눈에 띄게 표시한다.
          */}
          <button
            className={`nav-item foot-btn${focus.on ? " active" : ""}`}
            onClick={() => focus.toggle(!focus.on)}
            title={focus.on ? "종목 연동 끄기" : "종목 연동 켜기 — 다른 창과 종목을 맞춥니다"}
          >
            <span className="nav-icon">📡</span>
            <span className="nav-label">{focus.on ? "종목 연동 켜짐" : "종목 연동"}</span>
          </button>
          {/*
            엑셀 모드는 **급할 때 눌러야** 뜻이 있다. 설정 화면까지 들어가야 한다면
            정작 필요한 순간에 못 쓴다. 직전 테마를 기억해 두고 되돌린다 —
            껐을 때 늘 다크로 가면 라이트를 쓰던 사람은 매번 다시 고쳐야 한다.
          */}
          <button
            className="nav-item foot-btn"
            onClick={() =>
              appearance.set({ theme: excel ? (prevTheme.current ?? "dark") : "excel" })
            }
            title={excel ? "엑셀 모드 끄기" : "엑셀 모드"}
          >
            <span className="nav-icon">📊</span>
            <span className="nav-label">{excel ? "엑셀 모드 끄기" : "엑셀 모드"}</span>
          </button>
          {/*
            누르면 **바로** 잠긴다. 예전엔 비밀번호를 안 정했으면 설정으로 보냈는데,
            자리를 뜨려고 누른 사람에게 설정 화면을 띄우는 건 아무 도움이 안 된다.
            비밀번호가 네 자리로 고정되면서 그 갈림길 자체가 없어졌다.
          */}
          <button className="nav-item foot-btn lock-btn" onClick={lock.lock} title="화면 잠그기">
            <span className="nav-icon">🔒</span>
            <span className="nav-label">화면 잠그기</span>
          </button>
        </div>
      </aside>

      {navOpen && <div className="nav-backdrop" onClick={() => setNavOpen(false)} />}

      <div className="main">
        <header className="mobile-header">
          <span className="mobile-title">{TAB_LABELS[tab]}</span>
        </header>

        <div className="main-inner">
          {/* 인증이 끊기면 앱 전체가 값을 못 받는다 — 화면을 옮겨도 계속 보여야 한다 */}
          <AuthExpiredBar />

          {/* 어느 화면에서든 종목으로 바로 — 접혀 있으면 한 줄이다 */}
          <QuickStockSearch onPick={openAnalysis} />

          {/* 돌고 있는 작업 — 어느 화면에 있든 뜬다 */}
          <RunningJobsBar />

          {/*
            화면 하나가 터져도 앱이 통째로 내려앉지 않게 감싼다.
            미니PC 에서 종목발굴이 검은 화면이 됐을 때, 원인은 신호등 응답의 필드 하나였는데
            그 예외가 React 트리를 전부 걷어내 body 배경만 남았다.
            서버와 웹은 따로 배포되므로 둘이 어긋나는 창은 배포할 때마다 열린다 —
            그때 보이는 게 검은 화면이면 무엇이 잘못됐는지 알 길이 없다.
            탭을 옮기면 resetKey 가 바뀌어 다시 그려 본다.
          */}
          <ErrorBoundary where={TAB_LABELS[tab] ?? tab} resetKey={tab}>
          {tab === "briefing" && <BriefingPage onSelectStock={onSelectStock} />}
          {tab === "overview" && <OverviewPage onSelectStock={onSelectStock} />}
          {tab === "report" && <DailyReportPage onSelectStock={onSelectStock} />}
          {tab === "map" && <MapPage onSelectStock={onSelectStock} />}
          {tab === "program" && <ProgramTradePage />}
          {tab === "news" && <NewsPage onSelectStock={onSelectStock} />}
          {tab === "discovery" && <StockDiscoveryPage onSelectStock={onSelectStock} />}
          {tab === "watchAi" && <MyPage onSelectStock={onSelectStock} />}
          {tab === "watchKiwoom" && <KiwoomWatchlistPage onSelectStock={onSelectStock} />}
          {tab === "customTheme" && <CustomThemePage onSelectStock={onSelectStock} />}
          {tab === "signalScreen" && <ScreenPage onSelectStock={onSelectStock} />}
          {tab === "journal" && <JournalPage onSelectStock={onSelectStock} />}
          {tab === "memo" && <MemoPage />}
          {tab === "usWatch" && <UsWatchPage />}
          {tab === "marketFlow" && <MarketFlowPage onSelectStock={onSelectStock} />}
          {tab === "ask" && <AskPage />}
          {tab === "calendar" && <CalendarPage />}
          {tab === "telegram" && <TelegramPage />}
          {tab === "screener" && <ScreenerPage onSelectStock={onSelectStock} />}
          {tab === "stockAnalysis" && (
            <StockAnalysisPage stock={selected} onSelectStock={openAnalysis} />
          )}
          {tab === "volume" && <VolumeRankingPage onSelectStock={onSelectStock} />}
          {tab === "sameNet" && <SameNetTradeRankingPage onSelectStock={onSelectStock} />}
          {tab === "continuous" && <ContinuousTradePage onSelectStock={onSelectStock} />}
          {tab === "algo" && <AlgoPicksPage onSelectStock={onSelectStock} />}
          {tab === "paper" && <PaperTradePage onSelectStock={onSelectStock} />}
          {tab === "account" && <AccountInfoPage onSelectStock={onSelectStock} />}
          {tab === "manualAccount" && <ManualAccountPage onSelectStock={onSelectStock} />}
          {tab === "board" && <BoardPage onSelectStock={onSelectStock} />}
          {tab === "settings" && <SettingsPage />}
          {tab === "guide" && <GuidePage />}
          </ErrorBoundary>
        </div>
      </div>

      {/* 개별종목분석 탭은 종목을 페이지 안에서 직접 보여주므로 모달을 띄우지 않는다 */}
      {selected && tab !== "stockAnalysis" && (
        <ErrorBoundary where="종목 상세" resetKey={selected.code}>
        <StockDetail
          code={selected.code}
          name={selected.name}
          onClose={() => navigate({ stock: null })}
          onOpenAnalysis={openAnalysis}
          onSelectStock={onSelectStock}
        />
        </ErrorBoundary>
      )}
    </div>
  );
}
