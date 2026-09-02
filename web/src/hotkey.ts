/**
 * 단축키 공통 모듈 — 미니창·보드 새창·화면잠금이 **같이 쓰는** 판정 (2026-09-02).
 *
 * 벤티지: "보드도 새창으로 띄울 수 있게 하자. 미니창처럼. 그것도 단축키 설정하게
 * 만들고" / "빨리 누르기 단축키 세팅도 넣으면 되겠네 어차피 공통 모듈일 테니깐" /
 * "그리고 화면 잠그기도"
 *
 * 원래는 미니창(`miniConfig.ts`)과 화면잠금(`useScreenLock.ts`)이 각자 조합키 판정을
 * 들고 있었다. 보드 새창이 셋째로 붙으면서 여기로 모았고, **연타**(같은 키를 빠르게
 * 세 번)를 더했다.
 *
 * ## 두 종류
 *
 *   조합  Ctrl+M 처럼 보조키를 누른 채 한 번 — 입력창에 커서가 있어도 듣는다.
 *         브라우저·편집기 단축키와 안 겹치는 것만 목록에 뒀다(잠금은 알고도 쓰는
 *         조합을 일부 남겼다 — 그 사연은 `useScreenLock.ts`).
 *   연타  m 을 0.6초 안에 세 번 — 보조키가 없어서 **입력창에서는 안 듣는다.**
 *         검색창에 글자를 치다 우연히 `mmm` 이 되면 창이 튀어나오는 걸 막아야 한다.
 *         잠금도 마찬가지다 — 메모에 "lll" 을 칠 일은 없지만 규칙은 같아야 한다.
 *
 * ## 용도별 목록을 가른다
 *
 * 창 열기(미니창·보드)와 잠금은 **고를 수 있는 조합이 다르다.** 잠금 목록엔 Ctrl+X
 * 처럼 잘라내기와 겹치는 걸 알고도 쓰는 조합이 있는데, 그게 미니창 목록에 뜨면 안
 * 된다. 판정은 하나, 목록은 둘(`WINDOW_HOTKEYS` / `LOCK_HOTKEYS`).
 *
 * ## 물리 키로 잰다 (`e.code`)
 *
 * 한글 입력 상태에서는 `e.key` 가 "ㅡ"(m 자리) 같은 자모로 오거나 "Process" 로 온다.
 * 그러면 Ctrl+M 이 **한글 모드에서 안 먹는다** — 실제로 그랬을 것이다. `e.code` 는
 * 자판 위치라 입력 언어와 무관하다. 둘 중 하나만 맞으면 그 키로 친다.
 *
 * ## 미니창과 보드가 같은 조합을 고르면
 *
 * 둘 다 열린다 — 판정이 각자 따로 돌기 때문이다. 설정 화면이 겹침을 막는다
 * (`MiniConfigPanel`). 여기서는 막지 않는다: 저장된 값이 우연히 같아졌을 때
 * 한쪽을 조용히 죽이는 것보다 둘 다 여는 편이 눈에 띈다.
 */

export type Hotkey =
  | "off"
  /* ── 창 열기 ── */
  | "ctrl-m"
  | "ctrl-shift-m"
  | "alt-m"
  | "ctrl-b"
  | "ctrl-shift-b"
  | "alt-b"
  | "ctrl-shift-o"
  | "tap-m"
  | "tap-b"
  /* ── 잠금 ── */
  | "ctrl-shift-z"
  | "ctrl-shift-x"
  | "ctrl-shift-l"
  | "ctrl-q"
  | "alt-l"
  | "ctrl-x"
  | "tap-l"
  | "tap-q";

export interface HotkeyChoice {
  key: Hotkey;
  label: string;
  hint: string;
}

const ALL: HotkeyChoice[] = [
  { key: "ctrl-m", label: "Ctrl+M", hint: "브라우저에서 비어 있는 조합입니다" },
  { key: "ctrl-shift-m", label: "Ctrl+Shift+M", hint: "왼손만으로" },
  { key: "alt-m", label: "Alt+M", hint: "한 손으로" },
  { key: "ctrl-b", label: "Ctrl+B", hint: "크롬에선 비어 있고, 파이어폭스에선 북마크 사이드바와 겹칩니다" },
  { key: "ctrl-shift-b", label: "Ctrl+Shift+B", hint: "크롬 북마크 바 켜기/끄기와 겹칩니다" },
  { key: "alt-b", label: "Alt+B", hint: "한 손으로" },
  { key: "ctrl-shift-o", label: "Ctrl+Shift+O", hint: "Open — 북마크 관리와 겹칠 수 있습니다" },
  { key: "tap-m", label: "M 세 번 연타", hint: "0.6초 안에 m m m — 입력창에 커서가 있을 땐 안 듣습니다" },
  { key: "tap-b", label: "B 세 번 연타", hint: "0.6초 안에 b b b — 입력창에 커서가 있을 땐 안 듣습니다" },
  {
    key: "ctrl-shift-z",
    label: "Ctrl+Shift+Z",
    hint: "왼손 끝으로 눌러집니다. 「다시 실행」과 겹치지만 이 앱에서는 쓸 일이 없습니다",
  },
  { key: "ctrl-shift-x", label: "Ctrl+Shift+X", hint: "왼손만으로 눌러집니다" },
  { key: "ctrl-shift-l", label: "Ctrl+Shift+L", hint: "Lock — 입력창에서 안 쓰는 조합입니다" },
  { key: "ctrl-q", label: "Ctrl+Q", hint: "가장 빠르지만 브라우저에 따라 종료로 먹힐 수 있습니다" },
  { key: "alt-l", label: "Alt+L", hint: "한 손으로" },
  { key: "ctrl-x", label: "Ctrl+X", hint: "⚠️ 잘라내기와 겹칩니다 — 메모에서 글자를 잘라내려다 화면이 잠깁니다" },
  { key: "tap-l", label: "L 세 번 연타", hint: "0.6초 안에 l l l — 입력창에 커서가 있을 땐 안 듣습니다" },
  { key: "tap-q", label: "Q 세 번 연타", hint: "0.6초 안에 q q q — 입력창에 커서가 있을 땐 안 듣습니다" },
  { key: "off", label: "안 씀", hint: "단축키로는 안 씁니다" },
];

function pick(keys: Hotkey[]): HotkeyChoice[] {
  return keys.flatMap((k) => ALL.filter((h) => h.key === k));
}

/** 미니창·보드 새창이 고를 수 있는 것 */
export const WINDOW_HOTKEYS: HotkeyChoice[] = pick([
  "ctrl-m",
  "ctrl-shift-m",
  "alt-m",
  "ctrl-b",
  "ctrl-shift-b",
  "alt-b",
  "ctrl-shift-o",
  "tap-m",
  "tap-b",
  "off",
]);

/** 화면잠금이 고를 수 있는 것 */
export const LOCK_HOTKEYS: HotkeyChoice[] = pick([
  "ctrl-shift-z",
  "ctrl-shift-x",
  "ctrl-shift-l",
  "ctrl-q",
  "alt-l",
  "ctrl-x",
  "tap-l",
  "tap-q",
  "off",
]);

export function hotkeyLabel(key: Hotkey): string {
  return ALL.find((h) => h.key === key)?.label ?? key;
}

/** 연타로 치는 시간 창(ms) — 첫 번째부터 세 번째까지 */
const TAP_WINDOW_MS = 600;
const TAP_COUNT = 3;

type Letter = "m" | "b" | "o" | "l" | "z" | "x" | "q";

/** 물리 키 위치로 본다 — 한글 입력 상태에서도 같은 자리면 같은 키다 */
function keyIs(e: KeyboardEvent, letter: Letter): boolean {
  return e.key.toLowerCase() === letter || e.code === `Key${letter.toUpperCase()}`;
}

/** 글자를 받는 곳에 커서가 있나 — 연타는 여기서 안 듣는다 */
export function isEditableTarget(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  const tag = t.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
}

function matchesCombo(e: KeyboardEvent, hotkey: Hotkey): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  switch (hotkey) {
    case "ctrl-m":
      return ctrl && !e.shiftKey && !e.altKey && keyIs(e, "m");
    case "ctrl-shift-m":
      return ctrl && e.shiftKey && keyIs(e, "m");
    case "alt-m":
      return e.altKey && !ctrl && keyIs(e, "m");
    case "ctrl-b":
      return ctrl && !e.shiftKey && !e.altKey && keyIs(e, "b");
    case "ctrl-shift-b":
      return ctrl && e.shiftKey && keyIs(e, "b");
    case "alt-b":
      return e.altKey && !ctrl && keyIs(e, "b");
    case "ctrl-shift-o":
      return ctrl && e.shiftKey && keyIs(e, "o");
    case "ctrl-shift-z":
      return ctrl && e.shiftKey && keyIs(e, "z");
    case "ctrl-shift-x":
      return ctrl && e.shiftKey && keyIs(e, "x");
    case "ctrl-shift-l":
      return ctrl && e.shiftKey && keyIs(e, "l");
    case "ctrl-q":
      return ctrl && !e.shiftKey && keyIs(e, "q");
    case "alt-l":
      return e.altKey && !ctrl && keyIs(e, "l");
    case "ctrl-x":
      // 잘라내기와 겹치는 걸 알고도 고른 사람만 온다
      return ctrl && !e.shiftKey && keyIs(e, "x");
    default:
      return false;
  }
}

function tapLetter(hotkey: Hotkey): Letter | null {
  switch (hotkey) {
    case "tap-m":
      return "m";
    case "tap-b":
      return "b";
    case "tap-l":
      return "l";
    case "tap-q":
      return "q";
    default:
      return null;
  }
}

/**
 * 단축키 판정기를 만든다. 연타는 **누른 시각을 기억**해야 하므로 함수가 상태를 든다 —
 * 그래서 한 번 만들어 리스너 안에서 계속 부른다.
 *
 * `get` 으로 설정을 매번 읽는다 — 설정 화면에서 바꾸면 리스너를 다시 걸지 않아도
 * 다음 키부터 새 조합으로 듣는다.
 */
export function createHotkeyMatcher(get: () => Hotkey): (e: KeyboardEvent) => boolean {
  let taps: number[] = [];
  return (e: KeyboardEvent) => {
    const hotkey = get();
    if (hotkey === "off") return false;
    const letter = tapLetter(hotkey);
    if (!letter) return matchesCombo(e, hotkey);

    /* ── 연타 ── */
    if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isEditableTarget(e)) return false;
    if (!keyIs(e, letter)) {
      taps = []; // 다른 키가 끼면 처음부터
      return false;
    }
    const now = Date.now();
    taps = [...taps.filter((t) => now - t <= TAP_WINDOW_MS), now];
    if (taps.length < TAP_COUNT) return false;
    taps = [];
    return true;
  };
}
