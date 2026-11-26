import { WINDOW_HOTKEYS, type Hotkey } from "./hotkey";
import { setPref } from "./prefs";

/**
 * 미니창 설정 (2026-08-26) — 상단 1·2·3 버튼에 어떤 화면을 물릴지 + 여는 단축키.
 *
 * 화면잠금(useScreenLock)과 같은 방식이다: 단축키는 자유 입력이 아니라 **프리셋**만 —
 * 브라우저·편집 단축키와 부딪히는 조합을 고르는 사고를 목록 단계에서 막는다.
 * 저장은 setPref(vntg.*) 라 서버 동기 = 전역(모든 기기 공용)이다.
 */

/**
 * 미니창에 넣을 수 있는 화면 — 팝업(560px) 폭에서 쓸모 있는 것만 추렸다.
 * 아래쪽 「보드 블록」 묶음(2026-08-26)은 보드의 시장 무관 칸들을 그대로 빌린 것 —
 * 종목이 없어도 그려지는 것들이라 미니창에 딱 맞다.
 */
export type MiniScreenKey =
  | "stock"
  | "overview"
  | "watch"
  | "news"
  | "superSignal"
  | "telegram"
  | "memo"
  | "report"
  /*
   * ── 2026-09-07 추가 — 벤티지: "우리 기능들이 많아졌잖아. 매수직전, 시세분석, 테마MAP 등
   * 한번 추려보고 추가해보자. 주문도 넣어줘." 팝업 폭(560px)에서도 서는 것만 골랐다 —
   * 전부 폰 폭에 맞춰 둔 화면이라 미니창에서도 깨지지 않는다.
   */
  | "scope"
  | "order"
  | "screener"
  | "map"
  | "listTrack"
  | "signalScreen"
  | "volume"
  | "cis"
  | "etf"
  | "marketFlow"
  | "condSearch"
  | "themedb"
  /*
   * ── 2026-11-27 추가 — 벤티지: "미니보드에 들어갈 수 있는 메뉴가 업데이트가 안된듯"
   *
   * 이 목록은 **손으로 적는 목록**이라 메뉴가 늘 때마다 뒤처진다. 9월 이후 새로 생기거나
   * 자리를 옮긴 화면을 한 번에 따라붙인다. 고르는 잣대는 처음과 같다 — 팝업 폭(560px)에서
   * 서는 화면만.
   */
  | "topic"
  | "marketBoard"
  | "morning"
  | "leaders"
  | "themeTrend"
  | "customTheme"
  | "discovery"
  | "watchKiwoom"
  | "journal"
  | "calendar"
  | "usStock"
  /* ── 보드 블록 ── */
  | "indexBoard"
  | "marketSignal"
  | "pulse"
  | "breadth"
  | "sectorFlow"
  | "vi"
  | "watchTicker";

/**
 * **묶음** (2026-11-27). 서른 개가 넘으면 한 줄짜리 목록은 못 읽는다 — 고르는 쪽은
 * 「시황 쪽 어디였는데」로 찾지, 가나다순으로 찾지 않는다. 고를 때 `<optgroup>` 으로 나눈다.
 */
export const MINI_GROUPS = ["종목", "시황·화제", "테마", "내 것", "보드 블록"] as const;
export type MiniGroup = (typeof MINI_GROUPS)[number];

export const MINI_SCREENS: {
  key: MiniScreenKey;
  label: string;
  icon: string;
  hint: string;
  group: MiniGroup;
}[] = [
  /* ── 종목 ── */
  { key: "stock", label: "종목 검색", icon: "🔎", hint: "종목 검색해서 상세 조회 — 미니창의 원래 용도", group: "종목" },
  { key: "screener", label: "시세분석", icon: "🔬", hint: "시세분석 — 조건으로 종목을 좁힌다", group: "종목" },
  { key: "condSearch", label: "조건 검색", icon: "🧾", hint: "조건 검색", group: "종목" },
  { key: "volume", label: "거래상위", icon: "🔥", hint: "거래대금·시가총액·등락률 상위", group: "종목" },
  { key: "discovery", label: "종목발굴", icon: "⛏️", hint: "종목발굴 — 조건을 걸어 캐낸다", group: "종목" },
  { key: "scope", label: "매수직전", icon: "🧨", hint: "현미경 그룹 — 매수 직전 종목을 같은 잣대로 나란히", group: "종목" },
  { key: "signalScreen", label: "신호등 찾기", icon: "🚦", hint: "신호등 찾기 — 오늘 초록", group: "종목" },
  { key: "superSignal", label: "슈퍼신호등", icon: "🌟", hint: "슈퍼신호등 대시보드", group: "종목" },
  { key: "listTrack", label: "신호등 분석", icon: "🔬", hint: "목록별 신호등 추적", group: "종목" },
  { key: "etf", label: "ETF (퇴직연금 판)", icon: "🧺", hint: "ETF 화면", group: "종목" },
  { key: "usStock", label: "개별종목분석(해외)", icon: "🌎", hint: "해외 개별종목 분석", group: "종목" },
  /* ── 시황·화제 ── */
  { key: "overview", label: "시황 대시보드", icon: "📊", hint: "시황 대시보드 한 벌 (요약·MAP·레이더·시황·미국)", group: "시황·화제" },
  { key: "marketBoard", label: "전광판", icon: "🟢", hint: "전광판 — 지수·업종·수급을 한 화면에", group: "시황·화제" },
  { key: "marketFlow", label: "돈의 흐름", icon: "🌊", hint: "돈의 흐름 — 「지금」 다섯 칸과 자금 이동", group: "시황·화제" },
  { key: "topic", label: "지금의 화제", icon: "📣", hint: "지금의 화제 + 뉴스·텔레그램을 시각 하나로 섞은 「지금」", group: "시황·화제" },
  { key: "news", label: "뉴스·공시", icon: "📢", hint: "뉴스·공시만 따로 (「지금의 화제」 안에도 탭으로 있습니다)", group: "시황·화제" },
  { key: "telegram", label: "텔레그램 동향", icon: "📡", hint: "텔레그램 동향만 따로 (「지금의 화제」 안에도 탭으로 있습니다)", group: "시황·화제" },
  { key: "leaders", label: "주도주", icon: "🏁", hint: "오늘 시장을 끄는 종목", group: "시황·화제" },
  { key: "morning", label: "장전 브리핑룸", icon: "🌅", hint: "장 열기 전에 훑는 자리", group: "시황·화제" },
  { key: "report", label: "데일리 리포트", icon: "📰", hint: "데일리 리포트", group: "시황·화제" },
  /* ── 테마 ── */
  { key: "map", label: "테마 MAP", icon: "🗺️", hint: "테마/업종 MAP (시황 대시보드의 MAP 과 같은 화면)", group: "테마" },
  { key: "themeTrend", label: "대세 테마 분석", icon: "🌊", hint: "어떤 테마가 대세로 올라오나", group: "테마" },
  { key: "themedb", label: "테마 DB", icon: "🧭", hint: "테마 DB", group: "테마" },
  { key: "customTheme", label: "내 태그", icon: "🎯", hint: "내가 묶은 테마", group: "테마" },
  /* ── 내 것 ── */
  { key: "watch", label: "관심종목 (VNTG)", icon: "⭐", hint: "관심종목 (VNTG) — 그룹·편집까지 전체 화면", group: "내 것" },
  { key: "watchKiwoom", label: "관심종목 (키움연동)", icon: "🔖", hint: "키움에서 끌어온 관심종목", group: "내 것" },
  { key: "order", label: "주문", icon: "🛒", hint: "주문 화면 — 기기 등록·PIN·주문 비밀번호는 본창과 같습니다", group: "내 것" },
  { key: "cis", label: "항해일지", icon: "🧭", hint: "시스가 굴리는 모의 계좌 넷 + 시뮬레이터", group: "내 것" },
  { key: "journal", label: "복기 노트", icon: "📓", hint: "그날의 매매와 시장을 한 장에 — 복기 노트", group: "내 것" },
  { key: "memo", label: "메모장", icon: "📝", hint: "메모장 + 일기", group: "내 것" },
  { key: "calendar", label: "캘린더", icon: "📅", hint: "일정 — 실적·공모·이벤트", group: "내 것" },
  /* ── 보드 블록 (가볍고 미니창 폭에 맞음) ── */
  { key: "indexBoard", label: "지수판", icon: "🧮", hint: "보드의 지수판 — 국내외 지수·환율·선물 전광판", group: "보드 블록" },
  { key: "marketSignal", label: "시장 신호등", icon: "🚥", hint: "지금이 살 자리인가 — 시장 신호등 판정", group: "보드 블록" },
  { key: "pulse", label: "시장 맥박", icon: "💓", hint: "자금 국면·위험·교차 신호 (시장흐름분석 맥박 탭)", group: "보드 블록" },
  { key: "breadth", label: "상승·하락", icon: "📶", hint: "상승·하락 종목수 — 시장의 폭", group: "보드 블록" },
  { key: "sectorFlow", label: "업종 수급", icon: "🏭", hint: "업종별 자금 흐름 (5일 누적)", group: "보드 블록" },
  { key: "vi", label: "VI 발동", icon: "⚡", hint: "오늘 VI 걸린 종목 실시간 목록", group: "보드 블록" },
  { key: "watchTicker", label: "관심 시세판", icon: "🎯", hint: "관심종목 시세만 콤팩트하게 (보드의 시세판)", group: "보드 블록" },
];

/*
 * 단축키 목록과 판정은 2026-09-02 에 `hotkey.ts` 로 옮겼다 — 보드 새창·화면잠금과
 * 같이 쓰고, 연타(m 세 번)가 거기서 판정된다. 여기 이름은 옛 호출부를 위해 남긴다.
 */
export type MiniHotkey = Hotkey;
export const MINI_HOTKEYS = WINDOW_HOTKEYS;

/** 버튼 수 — 1~7 (2026-08-27 「7개까지」. 저장된 5슬롯 구성은 기본값으로 늘려 읽힌다) */
export const MINI_SLOT_COUNT = 7;

export interface MiniConfig {
  /** 상단 버튼 1~7 이 여는 화면 */
  slots: MiniScreenKey[];
  hotkey: MiniHotkey;
  /**
   * 보드 새창을 여는 단축키 (2026-09-02). 미니창과 같은 목록에서 고른다 —
   * 설정 파일 하나에 같이 두는 이유는 「새창 단축키」가 한 화면에서 보이게 하려는 것.
   */
  boardHotkey: Hotkey;
  /**
   * **주문 미니창** 단축키 (2026-09-07) — 벤티지: "o 빠르게 세 번 누르면 주문 메뉴 뜨도록.
   * 미니창 모드로 해서 빠르게 주문 넣을 수 있게." 미니창을 **주문 화면으로** 연다
   * (`#/mini?screen=order`). 같은 창 이름이라 미니창이 이미 떠 있으면 그 창이 주문으로 바뀐다.
   */
  orderHotkey: Hotkey;
  /**
   * **창 연동** (2026-10-22 — 벤티지: "미니창에서 종목검색할때 연동모드 키고 끌 수
   * 있는 옵션 넣을 수 있게 설정에 넣어줄래?").
   *
   * 켜면 미니창에서 고른 종목이 다른 창에도 퍼지고, 다른 창이 고른 종목을 미니창이
   * 따라간다(`useStockFocus`). 끄면 **미니창이 저 혼자 본다.**
   *
   * 왜 끄고 싶은가 — 미니창의 쓸모는 「본창을 안 떠나고 곁눈질」인데, 연동이 켜져
   * 있으면 미니창에서 뭘 하나 찾아볼 때마다 **본창까지 끌려간다.** 보던 자리를 잃지
   * 않으려고 연 창이 보던 자리를 뺏는 셈이다.
   *
   * 기본은 **켬** — 9/8 에 「종목 연동이 안 된다」고 해서 붙인 기능이고, 평소에는
   * 그쪽이 맞다.
   */
  link: boolean;
}

const KEY = "vntg.mini";
const EVENT = "vntg-mini-config";

const DEFAULT: MiniConfig = {
  slots: ["stock", "overview", "watch", "news", "superSignal", "pulse", "indexBoard"],
  hotkey: "ctrl-m",
  boardHotkey: "ctrl-b",
  orderHotkey: "tap-o",
  link: true,
};

export function readMiniConfig(): MiniConfig {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT;
    const saved = JSON.parse(raw) as Partial<MiniConfig>;
    const valid = (k: unknown): k is MiniScreenKey => MINI_SCREENS.some((s) => s.key === k);
    const slots = Array.isArray(saved.slots) ? saved.slots : [];
    return {
      slots: Array.from({ length: MINI_SLOT_COUNT }, (_, i) =>
        valid(slots[i]) ? (slots[i] as MiniScreenKey) : DEFAULT.slots[i],
      ),
      hotkey: MINI_HOTKEYS.some((h) => h.key === saved.hotkey)
        ? (saved.hotkey as MiniHotkey)
        : DEFAULT.hotkey,
      boardHotkey: MINI_HOTKEYS.some((h) => h.key === saved.boardHotkey)
        ? (saved.boardHotkey as Hotkey)
        : DEFAULT.boardHotkey,
      orderHotkey: MINI_HOTKEYS.some((h) => h.key === saved.orderHotkey)
        ? (saved.orderHotkey as Hotkey)
        : DEFAULT.orderHotkey,
      /* 저장된 적 없으면 켬 — 옛 설정을 읽어도 하던 대로 동작해야 한다 */
      link: saved.link !== false,
    };
  } catch {
    return DEFAULT;
  }
}

export function saveMiniConfig(cfg: MiniConfig): void {
  setPref(KEY, JSON.stringify(cfg));
  // 열려 있는 미니창·본창(단축키 리스너)이 그 자리에서 따라오게
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** 설정 변경 구독 — 같은 창의 CustomEvent + 다른 창의 storage 이벤트 둘 다 */
export function onMiniConfigChange(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === KEY) fn();
  };
  window.addEventListener(EVENT, fn);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(EVENT, fn);
    window.removeEventListener("storage", onStorage);
  };
}

/* 판정(`matchesMiniHotkey`)은 `hotkey.ts` 의 `createHotkeyMatcher` 로 옮겼다 — 연타 때문에 상태가 필요하다 */
