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
  /* ── 보드 블록 ── */
  | "indexBoard"
  | "marketSignal"
  | "pulse"
  | "breadth"
  | "sectorFlow"
  | "vi"
  | "watchTicker";

export const MINI_SCREENS: { key: MiniScreenKey; label: string; icon: string; hint: string }[] = [
  { key: "stock", label: "종목 검색", icon: "🔎", hint: "종목 검색해서 상세 조회 — 미니창의 원래 용도" },
  { key: "overview", label: "시황", icon: "📊", hint: "시황 대시보드 한 벌" },
  { key: "watch", label: "관심종목", icon: "⭐", hint: "관심종목 (VNTG) — 그룹·편집까지 전체 화면" },
  { key: "news", label: "뉴스", icon: "📢", hint: "뉴스·공시" },
  { key: "superSignal", label: "슈퍼신호등", icon: "🌟", hint: "슈퍼신호등 대시보드" },
  { key: "telegram", label: "텔레그램", icon: "📡", hint: "텔레그램 동향" },
  { key: "memo", label: "메모장", icon: "📝", hint: "메모장 + 일기" },
  { key: "report", label: "리포트", icon: "📰", hint: "데일리 리포트" },
  /* ── 보드 블록 (가볍고 미니창 폭에 맞음) ── */
  { key: "indexBoard", label: "지수판", icon: "🧮", hint: "보드의 지수판 — 국내외 지수·환율·선물 전광판" },
  { key: "marketSignal", label: "시장 신호등", icon: "🚥", hint: "지금이 살 자리인가 — 시장 신호등 판정" },
  { key: "pulse", label: "시장 맥박", icon: "💓", hint: "자금 국면·위험·교차 신호 (시장흐름분석 맥박 탭)" },
  { key: "breadth", label: "상승·하락", icon: "📶", hint: "상승·하락 종목수 — 시장의 폭" },
  { key: "sectorFlow", label: "업종 수급", icon: "🏭", hint: "업종별 자금 흐름 (5일 누적)" },
  { key: "vi", label: "VI 발동", icon: "⚡", hint: "오늘 VI 걸린 종목 실시간 목록" },
  { key: "watchTicker", label: "관심 시세판", icon: "🎯", hint: "관심종목 시세만 콤팩트하게 (보드의 시세판)" },
];

export type MiniHotkey = "off" | "ctrl-m" | "ctrl-shift-m" | "alt-m" | "ctrl-shift-o";

export const MINI_HOTKEYS: { key: MiniHotkey; label: string; hint: string }[] = [
  { key: "ctrl-m", label: "Ctrl+M", hint: "기본값 — 브라우저에서 비어 있는 조합입니다" },
  { key: "ctrl-shift-m", label: "Ctrl+Shift+M", hint: "왼손만으로" },
  { key: "alt-m", label: "Alt+M", hint: "한 손으로" },
  { key: "ctrl-shift-o", label: "Ctrl+Shift+O", hint: "Open — 북마크 관리와 겹칠 수 있습니다" },
  { key: "off", label: "안 씀", hint: "단축키로는 안 엽니다" },
];

/** 버튼 수 — 1~5 (2026-08-26 「이왕 하는 거 다섯으로」) */
export const MINI_SLOT_COUNT = 5;

export interface MiniConfig {
  /** 상단 버튼 1~5 가 여는 화면 */
  slots: MiniScreenKey[];
  hotkey: MiniHotkey;
}

const KEY = "vntg.mini";
const EVENT = "vntg-mini-config";

const DEFAULT: MiniConfig = {
  slots: ["stock", "overview", "watch", "news", "superSignal"],
  hotkey: "ctrl-m",
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

/** 눌린 키가 그 조합인가 — useScreenLock.matches 와 같은 규칙 */
export function matchesMiniHotkey(e: KeyboardEvent, hotkey: MiniHotkey): boolean {
  const k = e.key.toLowerCase();
  switch (hotkey) {
    case "ctrl-m":
      return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && k === "m";
    case "ctrl-shift-m":
      return (e.ctrlKey || e.metaKey) && e.shiftKey && k === "m";
    case "alt-m":
      return e.altKey && !e.ctrlKey && !e.metaKey && k === "m";
    case "ctrl-shift-o":
      return (e.ctrlKey || e.metaKey) && e.shiftKey && k === "o";
    default:
      return false;
  }
}
