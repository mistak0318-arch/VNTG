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
}

const KEY = "vntg.mini";
const EVENT = "vntg-mini-config";

const DEFAULT: MiniConfig = {
  slots: ["stock", "overview", "watch", "news", "superSignal", "pulse", "indexBoard"],
  hotkey: "ctrl-m",
  boardHotkey: "ctrl-b",
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
