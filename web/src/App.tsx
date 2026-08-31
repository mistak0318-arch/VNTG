import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { api } from "./api";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { RunningJobsBar } from "./components/RunningJobsBar";
import { QuickStockSearch } from "./components/QuickStockSearch";
import { NotifyBell } from "./components/NotifyBell";
import { TabScroller } from "./components/TabScroller";
import { CustomThemePage } from "./pages/CustomThemePage";
import { ScreenerPage } from "./pages/ScreenerPage";
import { ScreenPage } from "./pages/ScreenPage";
import { PaperTradePage } from "./pages/PaperTradePage";
import { JournalPage } from "./pages/JournalPage";
import { CisPage } from "./pages/CisPage";
import { MemoPage } from "./pages/MemoPage";
import { MiniPage } from "./pages/MiniPage";
import { BuzzSourcePage } from "./pages/BuzzSourcePage";
import { matchesMiniHotkey, onMiniConfigChange, readMiniConfig } from "./miniConfig";
import { TabActiveContext } from "./tabActive";
import { SuperDashboardPage } from "./pages/SuperDashboardPage";
import { ListTrackPage } from "./pages/ListTrackPage";
import { UsWatchPage } from "./pages/UsWatchPage";
import { AskPage } from "./pages/AskPage";
import { MarketFlowPage } from "./pages/MarketFlowPage";
import { StockDetail } from "./components/StockDetail";
import { AccountInfoPage } from "./pages/AccountInfoPage";
import { AlgoPicksPage } from "./pages/AlgoPicksPage";
import { CalendarPage } from "./pages/CalendarPage";
import { ContinuousTradePage } from "./pages/ContinuousTradePage";
import { EtfPage } from "./pages/EtfPage";
import { DailyReportPage } from "./pages/DailyReportPage";
import { KiwoomWatchlistPage } from "./pages/KiwoomWatchlistPage";
import { ManualAccountPage } from "./pages/ManualAccountPage";
import { MapPage } from "./pages/MapPage";
import { ThemeDbPage } from "./pages/ThemeDbPage";
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
import { MorningPage } from "./pages/MorningPage";
import { useDragOrder } from "./useDragOrder";
import { useHashRoute } from "./useHashRoute";
import { useEdgeSwipe } from "./useEdgeSwipe";
import { applyOrder, parseSection, useMenuPrefs } from "./useMenuOrder";
import { useScreenLock } from "./useScreenLock";
import { ScreenLock } from "./components/ScreenLock";
import { ExcelChrome } from "./components/ExcelChrome";
import { useAppearance } from "./useAppearance";
import { BoardPage } from "./pages/BoardPage";
import { CornerToggle } from "./components/CornerToggle";
import { ScrollTopButton } from "./components/ScrollTopButton";
import { AuthExpiredBar } from "./components/AuthExpiredBar";
import { useStockFocus } from "./useStockFocus";
import { TelegramPage } from "./pages/TelegramPage";
import { GuidePage } from "./pages/GuidePage";

type Tab =
  | "cis"
  | "morning"
  | "briefing"
  | "overview"
  | "report"
  | "map"
  | "themedb"
  | "program"
  | "news"
  | "discovery"
  | "watchAi"
  | "watchKiwoom"
  | "calendar"
  | "marketFlow"
  | "customTheme"
  | "signalScreen"
  | "superSignal"
  | "listTrack"
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
  | "etf"
  | "algo"
  | "account"
  | "manualAccount"
  | "paper"
  | "settings"
  | "board"
  | "guide"
  | "mini";

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
      /* 장전 브리핑룸 (2026-08-27) — 아침 루틴(일정·조간·미국 마감·슈퍼 변동·주요 채널)을 한 화면에 */
      { key: "morning", label: "장전 브리핑룸", icon: "🌅" },
      /*
       * 마켓 브리핑 + 시장 흐름 분석 = 한 메뉴 (2026-08-28 — 「시황분석 메뉴가 너무 많아」).
       * 브리핑이 첫 탭(홈), 맥박·로테이션·주도주·자금 흐름이 그 뒤 탭이다.
       * key 는 "briefing" 을 남겼다 — 홈 라우트·탭 복원·즐겨찾기가 이 키를 기억한다.
       */
      { key: "briefing", label: "마켓 브리핑·흐름", icon: "🌊" },
      { key: "overview", label: "시황 대시보드", icon: "📊" },
      { key: "report", label: "데일리 리포트", icon: "📰" },
      { key: "map", label: "테마/업종 MAP", icon: "🗺️" },
      /* 테마 DB (2026-08-28) — 네이버 분류를 우리 눈금(등락률·상승비율·연속성)으로 다시 그린다 */
      { key: "themedb", label: "테마 DB", icon: "🧭" },
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
      /* ETF (2026-08-27) — 퇴직연금 판. 시세·NAV·괴리율 + ETF 만 골라낸 수급·연속 */
      { key: "etf", label: "ETF", icon: "🧺" },
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
      /* 슈퍼신호등 검증 대시보드 (2026-08-26) — 걸린 것들이 그 뒤로 어떻게 됐나 */
      { key: "superSignal", label: "슈퍼신호등", icon: "🌟" },
      /*
       * 신호등 분석 (2026-08-31) — 목록별 단독 추적. 슈퍼신호등 바로 아래에 둔다:
       * 두 원장을 견주는 것이 이 화면의 목적이라 나란히 있어야 한다.
       */
      { key: "listTrack", label: "신호등 분석", icon: "🔬" },
      /* CIS 일지 — 시스가 굴리는 모의 계좌 (2026-08-31). 복기 노트 바로 위에 둔다:
         둘 다 「돌아보는 자리」이고, 사람의 복기와 시스의 복기가 나란히 있어야 비교가 된다 */
      { key: "cis", label: "CIS 일지", icon: "🧠" },
      { key: "journal", label: "복기 노트", icon: "📓" },
      { key: "memo", label: "메모장", icon: "📝" },
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
      /*
       * 미니창 (2026-08-26) — 보던 페이지를 떠나지 않고 종목을 들여다보는 보조 팝업.
       * 이 항목만 탭 전환이 아니라 **새 작은 창**을 연다(#/mini).
       */
      { key: "mini", label: "미니창 열기", icon: "🪟" },
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
  /*
   * 모서리에서 안쪽으로 밀면 메뉴 (2026-08-28) — **민 쪽에서 나온다** (2026-08-29).
   * ☰ 는 한 손으로 들었을 때 엄지가 제일 안 닿는 구석이라, 폰에서는 이쪽이 본길이다.
   *
   * 연 방향은 **이번 열기에만** 쓴다 — 설정값(navSide)을 건드리면 PC 배치까지
   * 따라 움직인다. ☰ 로 열 때는 설정값 그대로다.
   */
  const [navFrom, setNavFrom] = useState<"left" | "right" | null>(null);
  useEdgeSwipe({
    open: navOpen,
    onOpen: (side) => {
      setNavFrom(side);
      setNavOpen(true);
    },
  });
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
    .filter((key) => !key.startsWith("#")) // 섹션 구분은 항목이 아니다
    .map((key) => flat.find((i) => i.key === key))
    .filter((i): i is (typeof flat)[number] => Boolean(i))
    .map((i) => ({ ...i, label: label(i.key, i.label) }));

  /*
   * 자주 쓰는 메뉴의 렌더 순서 — 섹션 구분(`#이름`) 포함 (2026-08-27).
   * 즐겨찾기가 열 개를 넘으면서 "어디에 뭐가 있는지"가 안 보였다 — 설정에서
   * 구분을 끼워 넣으면 사이드바에 작은 소제목으로 나뉜다.
   */
  const favEntries = prefs.favorites
    .map((key) => {
      if (key.startsWith("#")) {
        const s = parseSection(key)!;
        return { type: "sec" as const, key, name: s.name, color: s.color };
      }
      const it = flat.find((i) => i.key === key);
      return it
        ? { type: "item" as const, key, item: { ...it, label: label(it.key, it.label) } }
        : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);

  // 주소창에 이상한 값이 들어와도 화면이 비지 않도록 방어
  /* 옛 키 구조조정 — 시장 흐름 분석은 마켓 브리핑과 합쳤다 (2026-08-28) */
  const routedTab = route.tab === "marketFlow" ? "briefing" : route.tab;
  const tab = (VALID_TABS.has(routedTab as Tab) ? routedTab : "overview") as Tab;

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
    /*
     * 새 종목은 **맨 위부터** (2026-08-27 — "포커스가 중간에 잡혀 있네").
     * 인앱 탭이 생기면서 창 스크롤이 탭끼리 공유돼, 스크롤 내린 채 종목을
     * 누르면 분석 화면이 중간부터 보였다. 기억해 둔 자리도 0으로 지운다.
     */
    scrollMemo.current.stockAnalysis = 0;
    navigate({ tab: "stockAnalysis", stock: { code, name } });
    window.scrollTo(0, 0);
    focus.publish(code, name);
    setNavOpen(false);
    setNavFrom(null);
  }

  function go(next: Tab) {
    // 메뉴를 옮기면 열려 있던 종목 상세는 닫는다
    navigate({ tab: next, stock: null });
    setNavOpen(false); // 모바일에서 항목을 고르면 드로어를 닫는다
    setNavFrom(null);
  }

  /*
   * 인앱 탭 (2026-08-26 — 「브라우저 탭처럼, 메뉴 옮겨도 보던 게 안 날아가게」).
   *
   * 연 페이지들을 **언마운트하지 않고 숨긴다** — 스크롤·필터·입력이 그대로 산다.
   * 활성 탭은 여전히 해시가 정한다(새로고침·뒤로가기 그대로). 숨은 탭의 실시간
   * 구독은 useRealtime 이 TabActiveContext 를 보고 놓는다(소켓 정원 보호).
   * 폴링 fetch 는 계속 돌지만 대부분 서버 캐시를 읽는 것이라 키움 호출은 안 는다.
   *
   * 탭 목록은 sessionStorage — **창마다 따로**다(보드용 창이 본창 탭을 물려받으면 안 된다).
   */
  const [openTabs, setOpenTabs] = useState<Tab[]>(() => {
    try {
      const raw = sessionStorage.getItem("vntg.openTabs");
      const saved = raw ? (JSON.parse(raw) as string[]) : [];
      const valid = saved.filter((t): t is Tab => VALID_TABS.has(t as Tab));
      return valid.length > 0 ? valid : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      sessionStorage.setItem("vntg.openTabs", JSON.stringify(openTabs));
    } catch {
      /* 무시 */
    }
  }, [openTabs]);
  /*
   * 활성 탭은 늘 목록에 있게 — 없으면 뒤에 붙인다. 상한은 없다(2026-08-27 —
   * 「이것저것 누르다 보니 이전 탭이 사라져서 히스토리가 날아가네」). 비활성 탭은
   * 실시간 구독을 놓고(TabActiveContext) 폴링도 서버 캐시 위주라, 자연 상한
   * (= 메뉴 개수)까지는 열려 있어도 부담이 없다.
   */
  useEffect(() => {
    if (tab === "mini") return;
    setOpenTabs((prev) => (prev.includes(tab) ? prev : [...prev, tab]));
  }, [tab]);

  /* 사이드바 그룹 접기 — 기기별(localStorage). 27인치와 폰의 메뉴 사정은 다르다 */
  const [navFold, setNavFold] = useState<Record<string, boolean>>(() => {
    try {
      return JSON.parse(localStorage.getItem("vntg.nav.fold") ?? "{}") as Record<string, boolean>;
    } catch {
      return {};
    }
  });
  function toggleNavFold(group: string) {
    setNavFold((prev) => {
      const next = { ...prev, [group]: !prev[group] };
      try {
        localStorage.setItem("vntg.nav.fold", JSON.stringify(next));
      } catch {
        /* 저장 못 해도 이번 세션에는 접힌다 */
      }
      return next;
    });
  }

  /* 탭 순서 끌어서 바꾸기 (2026-08-27) — 순서 자리마다 쓰는 공용 훅 그대로.
     저장은 openTabs 가 이미 하고 있다(sessionStorage) — 순서만 바꿔 주면 끝. */
  const tabDrag = useDragOrder(openTabs, (next) => setOpenTabs(next as Tab[]));

  /*
   * 사이드바 N 배지 (2026-08-27 — 「신규 메시지 왔다는 걸 알 수 있게」).
   *   텔레그램 동향: 받은 방에 안 읽은 메시지가 있으면 N (로그 방은 운영 소음이라 제외)
   *   슈퍼신호등: 당일 수집이 끝났는데 아직 안 들어가 봤으면 N
   *              + 추적 종목의 당일 상승/하락 수(▲▼)는 N 과 별개로 상시
   *   데일리 리포트: 새 판이 발행됐는데 아직 안 읽었으면 N
   * 확인(그 메뉴에 들어가면)한 것은 기기별(localStorage)로 적어 배지를 끈다.
   * 1분 폴링(가벼운 라우트만 — 파일 읽기 수준) + 방을 읽으면 즉시(vntg:tg-read).
   */
  const [navN, setNavN] = useState({ telegram: false, superSignal: false, report: false });
  const [superUD, setSuperUD] = useState<{ up: number; down: number } | null>(null);
  const superRunRef = useRef<string | null>(null);
  const reportRef = useRef<string | null>(null);
  const refreshNavN = useCallback(() => {
    /* 보고 있는 화면의 새 소식은 이미 확인한 것 — 배지를 켜는 대신 본 것으로 적는다 */
    const seeing = (key: string, val: string): boolean => {
      if (location.hash.slice(1) !== key) return false;
      try {
        localStorage.setItem(`vntg.seen.${key}`, val);
      } catch {
        /* 못 적으면 다음에 또 켜질 뿐 */
      }
      return true;
    };
    void api
      .tgRooms()
      .then((r) => {
        const on = r.rooms.some((x) => x.channel !== "log" && x.unread > 0);
        setNavN((p) => (p.telegram === on ? p : { ...p, telegram: on }));
      })
      .catch(() => undefined);
    void api
      .signalSuperStatus()
      .then((r) => {
        superRunRef.current = r.lastRunDate;
        const on =
          !!r.lastRunDate &&
          !seeing("superSignal", r.lastRunDate) &&
          r.lastRunDate !== localStorage.getItem("vntg.seen.superSignal");
        setNavN((p) => (p.superSignal === on ? p : { ...p, superSignal: on }));
        setSuperUD(r.up !== null && r.down !== null ? { up: r.up, down: r.down } : null);
      })
      .catch(() => undefined);
    void api
      .reportStatus()
      .then((r) => {
        reportRef.current = r.latest;
        const on =
          !!r.latest &&
          !seeing("report", r.latest) &&
          r.latest !== localStorage.getItem("vntg.seen.report");
        setNavN((p) => (p.report === on ? p : { ...p, report: on }));
      })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    refreshNavN();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") refreshNavN();
    }, 60_000);
    window.addEventListener("vntg:tg-read", refreshNavN);
    return () => {
      clearInterval(t);
      window.removeEventListener("vntg:tg-read", refreshNavN);
    };
  }, [refreshNavN]);
  /* 그 메뉴에 들어가면 확인 — 최신분을 본 것으로 적고 배지를 끈다 */
  useEffect(() => {
    const seenVal = tab === "superSignal" ? superRunRef.current : tab === "report" ? reportRef.current : null;
    if (tab !== "superSignal" && tab !== "report") return;
    if (seenVal) {
      try {
        localStorage.setItem(`vntg.seen.${tab}`, seenVal);
      } catch {
        /* 무시 */
      }
    }
    setNavN((p) => (p[tab] ? { ...p, [tab]: false } : p));
  }, [tab]);
  /** 메뉴 항목에 N 을 달지 — 자주 쓰는 메뉴 줄에도 같이 단다 */
  const navNOf = (key: Tab) =>
    key === "telegram"
      ? navN.telegram
      : key === "superSignal"
        ? navN.superSignal
        : key === "report"
          ? navN.report
          : false;

  /*
   * 탭별 스크롤 기억 (2026-08-27) — 창 스크롤은 하나뿐이라 탭을 갈아타면
   * **남의 스크롤 자리**에서 시작했다(종목 눌렀더니 분석 화면이 중간부터).
   * 브라우저 탭처럼: 보던 자리를 탭마다 적어 두고, 돌아오면 그 자리로,
   * 처음 여는 탭은 맨 위로.
   */
  const scrollMemo = useRef<Record<string, number>>({});
  useEffect(() => {
    const onScroll = () => {
      scrollMemo.current[tab] = window.scrollY;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [tab]);
  useEffect(() => {
    window.scrollTo(0, scrollMemo.current[tab] ?? 0);
  }, [tab]);

  function closeTab(t: Tab) {
    setOpenTabs((prev) => {
      const next = prev.filter((x) => x !== t);
      if (t === tab) {
        // 활성 탭을 닫으면 옆 탭으로 — 브라우저와 같은 감각
        const fallback = next[next.length - 1] ?? "briefing";
        navigate({ tab: fallback, stock: null });
      }
      return next;
    });
  }

  /** 탭 모두 닫기 — 지금 보고 있는 탭 하나만 남긴다(보던 화면까지 날리면 그게 또 사고) */
  function closeAllTabs() {
    if (!window.confirm("열려 있는 모든 탭을 닫을까요?\n지금 보고 있는 화면만 남습니다.")) return;
    setOpenTabs(tab === "mini" ? [] : [tab]);
  }

  /** 탭 키 → 페이지. 인앱 탭이 열린 것들을 전부 이걸로 그린다 */
  function renderPage(t: Tab) {
    switch (t) {
      case "briefing": return <MarketFlowPage onSelectStock={onSelectStock} />;
      case "morning": return <MorningPage />;
      case "overview": return <OverviewPage onSelectStock={onSelectStock} />;
      case "report": return <DailyReportPage onSelectStock={onSelectStock} />;
      case "map": return <MapPage onSelectStock={onSelectStock} />;
      case "themedb": return <ThemeDbPage onSelectStock={onSelectStock} />;
      case "program": return <ProgramTradePage />;
      case "news": return <NewsPage onSelectStock={onSelectStock} />;
      case "discovery": return <StockDiscoveryPage onSelectStock={onSelectStock} />;
      case "watchAi": return <MyPage onSelectStock={onSelectStock} />;
      case "watchKiwoom": return <KiwoomWatchlistPage onSelectStock={onSelectStock} />;
      case "customTheme": return <CustomThemePage onSelectStock={onSelectStock} />;
      case "signalScreen": return <ScreenPage onSelectStock={onSelectStock} />;
      case "superSignal": return <SuperDashboardPage onSelectStock={onSelectStock} />;
      case "listTrack": return <ListTrackPage onSelectStock={onSelectStock} />;
      case "cis": return <CisPage onSelectStock={onSelectStock} />;
      case "journal": return <JournalPage onSelectStock={onSelectStock} />;
      case "memo": return <MemoPage onSelectStock={onSelectStock} />;
      case "usWatch": return <UsWatchPage />;
      /* 옛 키 — 합치기 전 즐겨찾기·링크가 남아 있어도 같은 화면이 뜬다 */
      case "marketFlow": return <MarketFlowPage onSelectStock={onSelectStock} />;
      case "ask": return <AskPage />;
      case "calendar": return <CalendarPage />;
      case "telegram": return <TelegramPage onSelectStock={onSelectStock} />;
      case "screener": return <ScreenerPage onSelectStock={onSelectStock} />;
      case "stockAnalysis": return <StockAnalysisPage stock={selected} onSelectStock={openAnalysis} />;
      case "volume": return <VolumeRankingPage onSelectStock={onSelectStock} />;
      case "sameNet": return <SameNetTradeRankingPage onSelectStock={onSelectStock} />;
      case "etf": return <EtfPage onSelectStock={onSelectStock} />;
      case "continuous": return <ContinuousTradePage onSelectStock={onSelectStock} />;
      case "algo": return <AlgoPicksPage onSelectStock={onSelectStock} />;
      case "paper": return <PaperTradePage onSelectStock={onSelectStock} />;
      case "account": return <AccountInfoPage onSelectStock={onSelectStock} />;
      case "manualAccount": return <ManualAccountPage onSelectStock={onSelectStock} />;
      case "board": return <BoardPage onSelectStock={onSelectStock} />;
      case "settings": return <SettingsPage />;
      case "guide": return <GuidePage />;
      default: return null;
    }
  }

  /**
   * 메뉴를 **새 브라우저 탭**으로 (2026-08-26 — 「메뉴 옮기면 보던 게 초기화된다」).
   * Ctrl(⌘)+클릭 또는 휠 클릭. 해시 라우팅이라 새 탭이 그 메뉴로 바로 열리고,
   * 원래 탭의 화면·상태는 그대로 남는다 — 탭마다 세션이 산다.
   */
  function openInNewTab(key: Tab) {
    window.open(`${window.location.pathname}#/${key}`, "_blank");
  }

  /** 미니창 — 작은 팝업으로 보조 화면(#/mini)을 연다. 같은 이름이라 하나만 뜬다 */
  function openMini() {
    window.open(
      `${window.location.pathname}#/mini`,
      "vntg-mini",
      "width=560,height=880,resizable=yes,scrollbars=yes",
    );
    setNavOpen(false);
    setNavFrom(null);
  }

  /*
   * 미니창 단축키 (2026-08-26) — 화면잠금 단축키와 같은 방식.
   * 설정 > 화면 > 미니창에서 조합을 고른다(기본 Ctrl+M). 미니창 자신(#/mini)에서는
   * 안 듣는다 — 이미 미니창인데 또 열 이유가 없다.
   */
  useEffect(() => {
    if (route.tab === "mini") return;
    let hotkey = readMiniConfig().hotkey;
    const off = onMiniConfigChange(() => {
      hotkey = readMiniConfig().hotkey;
    });
    const onKey = (e: KeyboardEvent) => {
      if (!matchesMiniHotkey(e, hotkey)) return;
      e.preventDefault();
      openMini();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
    // openMini 는 안정적(참조만 씀) — route.tab 이 mini 로/에서 바뀔 때만 다시 건다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [route.tab]);

  /** 메뉴 클릭 공통 — 미니창은 팝업, Ctrl/휠 클릭은 새 브라우저 탭, 나머지는 전환 */
  function navClick(e: React.MouseEvent, key: Tab) {
    if (key === "mini") {
      openMini();
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      openInNewTab(key);
      return;
    }
    go(key);
  }

  // 드로어가 열려 있을 때 배경 스크롤 방지
  useEffect(() => {
    document.body.style.overflow = navOpen ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [navOpen]);

  /*
   * 미니창(#/mini) — 사이드바 없이 종목 조회 전용 화면만 그린다.
   * 훅은 전부 위에서 이미 돌았으므로 여기서 갈라져도 순서가 안 흔들린다.
   */
  /*
   * 버즈 원문 창(#/buzzSource?term=…) — 사이드바 없이 **글만** 그린다 (2026-08-31).
   * 미니창과 같은 자리에서 갈라진다. 훅은 위에서 다 돌았으니 순서가 안 흔들린다.
   */
  if (route.tab === "buzzSource") {
    return (
      <div className="mini-root">
        <BuzzSourcePage />
      </div>
    );
  }

  if (route.tab === "mini") {
    return (
      <MiniPage
        stock={route.stock}
        onSelect={(code, name) => navigate({ stock: { code, name } })}
        onClear={() => navigate({ stock: null })}
      />
    );
  }

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
      <aside className={`sidebar${navOpen ? " open" : ""}${navOpen && navFrom ? ` from-${navFrom}` : ""}`}>
        {/* 회사에서도 열기 때문에 이름을 중립적으로 둔다 */}
        <div className="sidebar-brand">VNTG</div>
        <nav className="sidebar-nav">
          {favorites.length > 0 && (
            <div className="nav-group nav-fav">
              <div className="nav-group-label">자주 쓰는 메뉴</div>
              {favEntries.map((e) =>
                e.type === "sec" ? (
                  /*
                   * 섹션 구분 — 설정에서 끼워 넣은 소제목.
                   * 색을 정했으면 글자와 밑줄에 같이 입힌다. 색이 없으면 메뉴 항목과
                   * 구분이 안 돼서 그냥 또 하나의 메뉴처럼 보였다 (2026-08-28).
                   */
                  <div
                    className={`nav-fav-sec${e.color ? " tinted" : ""}`}
                    key={e.key}
                    style={e.color ? { color: e.color, borderColor: e.color } : undefined}
                  >
                    {e.name}
                  </div>
                ) : (
                  <button
                    key={`fav-${e.key}`}
                    className={`nav-item${tab === e.key ? " active" : ""}`}
                    onClick={(ev) => navClick(ev, e.item.key)}
                    onAuxClick={(ev) => {
                      if (ev.button === 1) openInNewTab(e.item.key);
                    }}
                    title="Ctrl+클릭 또는 휠 클릭: 새 브라우저 탭으로 — 보던 화면이 유지됩니다"
                  >
                    <span className="nav-icon" aria-hidden="true">{e.item.icon}</span>
                    {/* nav-label 로 감싼다 — 맨 텍스트면 말줄임·정렬이 본 메뉴와 달라진다 */}
                    <span className="nav-label">{e.item.label}</span>
                    {e.key === "superSignal" && superUD && (
                      <em className="nav-ud" title="추적 중 종목의 당일 상승/하락">
                        <span className="positive">▲{superUD.up}</span>
                        <span className="negative">▼{superUD.down}</span>
                      </em>
                    )}
                    {navNOf(e.item.key) && <em className="nav-n">N</em>}
                  </button>
                ),
              )}
            </div>
          )}
          {menu.map((g) => (
            <div
              className={`nav-group${navFold[g.group] ? " folded" : ""}`}
              key={g.group}
              style={{ "--accent": g.accent } as CSSProperties}
            >
              {/*
                그룹 접기 (2026-08-27 — "메뉴가 너무 많아졌으니 접었다 펼 수 있게").
                라벨을 누르면 접힌다. 접힌 채로도 **지금 활성인 항목은 보인다** —
                내가 어디 있는지까지 숨기면 길을 잃는다. 상태는 기기별(localStorage).
              */}
              <button
                type="button"
                className="nav-group-label nav-group-toggle"
                onClick={() => toggleNavFold(g.group)}
                title={navFold[g.group] ? "펼치기" : "접기"}
              >
                {g.label}
                <span className="nav-fold-caret">{navFold[g.group] ? "▸" : "▾"}</span>
              </button>
              {g.items
                .filter((item) => !navFold[g.group] || tab === item.key)
                .map((item) => (
                <button
                  key={item.key}
                  className={`nav-item${tab === item.key ? " active" : ""}`}
                  onClick={(e) => navClick(e, item.key)}
                  onAuxClick={(e) => {
                    if (e.button === 1 && item.key !== "mini") openInNewTab(item.key);
                  }}
                  title={
                    item.key === "mini"
                      ? "작은 팝업 창으로 종목을 조회합니다 — 보던 페이지는 그대로"
                      : "Ctrl+클릭 또는 휠 클릭: 새 브라우저 탭으로 — 보던 화면이 유지됩니다"
                  }
                >
                  <span className="nav-icon" aria-hidden="true">
                    {item.icon}
                  </span>
                  <span className="nav-label">{item.label}</span>
                  {item.key === "superSignal" && superUD && (
                    <em className="nav-ud" title="추적 중 종목의 당일 상승/하락">
                      <span className="positive">▲{superUD.up}</span>
                      <span className="negative">▼{superUD.down}</span>
                    </em>
                  )}
                  {navNOf(item.key) && <em className="nav-n">N</em>}
                </button>
              ))}
            </div>
          ))}

          {/*
            도구 버튼들 — 원래 사이드바 맨 바닥(margin-top: auto)에 붙여 뒀는데,
            PC처럼 세로가 긴 화면에선 메뉴와 뚝 떨어져 손이 안 갔다(2026-08-26).
            설정 그룹 바로 아래로 올려 메뉴 흐름 안에서 같이 스크롤되게 한다.
          */}
          <div className="nav-group">
            <div className="nav-group-label">도구</div>
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
        </nav>
      </aside>

      {/* 맨 위로 — 길게 내려간 화면에서만 뜬다. 어느 메뉴에서든 같은 자리 (2026-08-29) */}
      <ScrollTopButton />

      {navOpen && (
        <div
          className="nav-backdrop"
          onClick={() => {
            setNavOpen(false);
    setNavFrom(null);
            setNavFrom(null); // 다음에 ☰ 로 열면 설정값 자리로 돌아간다
          }}
        />
      )}

      <div className="main">
        <header className="mobile-header">
          <span className="mobile-title">{TAB_LABELS[tab]}</span>
        </header>

        <div className="main-inner">
          {/* 인증이 끊기면 앱 전체가 값을 못 받는다 — 화면을 옮겨도 계속 보여야 한다 */}
          <AuthExpiredBar />

          {/* 어느 화면에서든 종목으로 바로 — 접혀 있으면 한 줄이다.
              우측엔 탭 모두 닫기(탭이 쌓였을 때만) — 상한을 없애면서 치우는 손도 같이 준다 */}
          <div className="qss-row">
            <QuickStockSearch onPick={openAnalysis} />
            {/*
              알림 종 (2026-08-31) — 검색창과 **같은 줄**에 둔다. 벤티지가
              「검색하면 밑에 나오는 창처럼」이라고 한 그 모양을 그대로 쓰려는 것이라,
              두 드롭다운이 나란히 있는 편이 읽기도 낫다.
            */}
            <NotifyBell />
            {openTabs.length > 1 && (
              <button
                className="qss-close-tabs"
                onClick={closeAllTabs}
                title="열려 있는 탭을 모두 닫습니다 — 지금 화면만 남아요"
              >
                🧹 탭 모두 닫기 ({openTabs.length})
              </button>
            )}
          </div>

          {/* 돌고 있는 작업 — 어느 화면에 있든 뜬다 */}
          <RunningJobsBar />

          {/*
            인앱 탭바 (2026-08-26) — 연 메뉴들이 브라우저 탭처럼 쌓인다.
            탭이 하나면 안 그린다 — 기능을 안 쓰는 사람에게는 예전 화면 그대로다.
            상한이 없어지며 넘칠 수 있게 됐다(2026-08-27) — 종목상세와 같은
            TabScroller 로 휠 가로 스크롤·좌우 버튼·활성 탭 끌어오기를 준다.
          */}
          {openTabs.length > 1 && (
            <TabScroller className="app-tabs" activeKey={tab}>
              {openTabs.map((t) => (
                <span
                  key={t}
                  className={`app-tab${t === tab ? " active" : ""}${tabDrag.cls(t)}`}
                  {...tabDrag.props(t)}
                >
                  <button className="app-tab-go" onClick={() => go(t)} title={TAB_LABELS[t] ?? t}>
                    {TAB_LABELS[t] ?? t}
                  </button>
                  <button
                    className="app-tab-x"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeTab(t);
                    }}
                    title="탭 닫기"
                  >
                    ×
                  </button>
                </span>
              ))}
            </TabScroller>
          )}

          {/*
            열린 탭들을 **전부 마운트한 채** 활성만 보인다 — 상태(스크롤·필터·입력)가 산다.
            화면 하나가 터져도 앱이 통째로 내려앉지 않게 탭마다 ErrorBoundary 로 감싼다.
            숨은 탭의 실시간은 TabActiveContext=false 를 본 useRealtime 이 놓는다.
          */}
          {(openTabs.includes(tab) ? openTabs : [...openTabs, tab]).map((t) => (
            <div key={t} className="app-tabpane" hidden={t !== tab}>
              <TabActiveContext.Provider value={t === tab}>
                <ErrorBoundary where={TAB_LABELS[t] ?? t} resetKey={t}>
                  {renderPage(t)}
                </ErrorBoundary>
              </TabActiveContext.Provider>
            </div>
          ))}
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
