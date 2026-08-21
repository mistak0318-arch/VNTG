import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 화면 잠금 — **자리를 비울 때 눈에서 가린다.**
 *
 * ## 이건 보안 경계가 아니다
 *
 * 개발자도구를 열거나 API 를 직접 부르면 우회된다. **지나가는 사람 눈에서 가리는 것**이
 * 목적이고, 회사에서 잠깐 자리를 뜰 때가 그 자리다.
 *
 * 진짜 경계는 두 겹이 따로 있다 — Cloudflare 이메일 인증(6시간)과 OS 화면 잠금.
 * 이건 그 사이의 **빈 몇 분**을 메운다.
 *
 * ## 기기마다 따로 둔다
 *
 * 메뉴 순서나 카드 배치는 서버에 저장하지만 이건 **localStorage** 다.
 * 잠금은 「그 자리의 물리적 상황」에 딸린 값이라, **회사 PC 는 잠그고 집은 안 잠그는** 게
 * 자연스럽다. 서버에 두면 집에서도 5분마다 비밀번호를 넣게 된다.
 *
 * ## 비밀번호는 **네 자리 숫자로 고정**이다
 *
 * 정하는 화면을 없앴다. 자리를 뜰 때 한 번 누르고 돌아와서 한 번 치는 것이 전부인데,
 * 그 앞에 「비밀번호를 먼저 정하세요」가 있으면 정작 급할 때 못 쓴다.
 *
 * **해시로 감싸지 않는다.** 네 자리는 경우의 수가 만 개뿐이라 전부 대입해 보는 데
 * 1초도 안 걸린다 — 해시를 씌워도 실제로 막아 주는 건 없으면서 「안전하다」는
 * 착각만 남는다. 있으나 마나 한 것을 붙여 두느니 평문으로 두고 **무엇이 아닌지를
 * 분명히 적는 쪽**이 낫다.
 *
 * ⚠️ 그러므로 다시 적어 둔다 — **이건 화면 가리개지 보안 경계가 아니다.**
 * 지나가는 사람 눈에서 가리는 것이 전부이고, 진짜 방어는 Cloudflare 이메일 인증과
 * OS 화면 잠금이다. 이건 그 사이의 빈 몇 분을 메운다.
 */

const KEY = "vntg.lock.v1";

/** 고정 PIN. 숨기는 값이 아니다 — 위 주석 참고 */
export const PIN = "0523";

export interface LockConfig {
  enabled: boolean;
  /** 몇 분 동안 아무 동작이 없으면 잠글지 */
  minutes: number;
  /**
   * 바로 잠그는 단축키.
   *
   * 회사에서 누가 다가올 때 **버튼을 찾아 누를 새가 없다.** 손이 이미 키보드에 있으므로
   * 키 하나가 훨씬 빠르다.
   *
   * ⚠️ 편집 단축키와 겹치는 걸 조심한다. `Ctrl+Z`(실행취소)와 `Ctrl+X`(잘라내기)는
   * 메모를 적다가 누르면 **화면이 잠기고 되돌리려던 글자는 그대로 남아** 두 번 손해다.
   * 기본은 `Ctrl+Shift+Z` 다 — 「다시 실행」과 겹치지만 이 앱에서 실행취소를 되돌릴 일이
   * 사실상 없어서 실제로 부딪히지 않는다. 굳이 겹치는 걸 쓰겠다면 목록에 남겨는 뒀다.
   */
  hotkey: Hotkey;
}

/** 「끄기」를 포함해 고를 수 있는 조합 */
export type Hotkey =
  | "off"
  | "ctrl-shift-z"
  | "ctrl-shift-x"
  | "ctrl-shift-l"
  | "ctrl-q"
  | "alt-l"
  | "ctrl-x";

export const HOTKEYS: { key: Hotkey; label: string; hint: string }[] = [
  {
    key: "ctrl-shift-z",
    label: "Ctrl+Shift+Z",
    hint: "기본값 — 왼손 끝으로 눌러집니다. 「다시 실행」과 겹치지만 이 앱에서는 쓸 일이 없습니다",
  },
  { key: "ctrl-shift-x", label: "Ctrl+Shift+X", hint: "왼손만으로 눌러집니다" },
  { key: "ctrl-shift-l", label: "Ctrl+Shift+L", hint: "Lock — 입력창에서 안 쓰는 조합입니다" },
  { key: "ctrl-q", label: "Ctrl+Q", hint: "가장 빠르지만 브라우저에 따라 종료로 먹힐 수 있습니다" },
  { key: "alt-l", label: "Alt+L", hint: "한 손으로" },
  {
    key: "ctrl-x",
    label: "Ctrl+X",
    hint: "⚠️ 잘라내기와 겹칩니다 — 메모에서 글자를 잘라내려다 화면이 잠깁니다",
  },
  { key: "off", label: "안 씀", hint: "단축키로는 안 잠급니다" },
];

/** 눌린 키가 그 조합인가 */
function matches(e: KeyboardEvent, hotkey: Hotkey): boolean {
  const k = e.key.toLowerCase();
  switch (hotkey) {
    case "ctrl-shift-l":
      return (e.ctrlKey || e.metaKey) && e.shiftKey && k === "l";
    case "ctrl-shift-z":
      return (e.ctrlKey || e.metaKey) && e.shiftKey && k === "z";
    case "ctrl-shift-x":
      return (e.ctrlKey || e.metaKey) && e.shiftKey && k === "x";
    case "ctrl-q":
      return (e.ctrlKey || e.metaKey) && !e.shiftKey && k === "q";
    case "alt-l":
      return e.altKey && !e.ctrlKey && k === "l";
    case "ctrl-x":
      // 잘라내기와 겹치는 걸 알고도 고른 사람만 온다
      return (e.ctrlKey || e.metaKey) && !e.shiftKey && k === "x";
    default:
      return false;
  }
}

const DEFAULT: LockConfig = { enabled: false, minutes: 5, hotkey: "ctrl-shift-z" };

export async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function read(): LockConfig {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<LockConfig> | null;
    if (!raw) return { ...DEFAULT };
    return {
      enabled: Boolean(raw.enabled),
      minutes: Math.min(Math.max(Number(raw.minutes) || 5, 1), 120),
      hotkey: (HOTKEYS.some((h) => h.key === raw.hotkey) ? raw.hotkey : DEFAULT.hotkey) as Hotkey,
    };
  } catch {
    return { ...DEFAULT };
  }
}

/** 새로고침으로 잠금을 넘기지 못하게 — 잠긴 사실을 남긴다 */
const LOCKED_KEY = "vntg.lock.locked";

export function useScreenLock() {
  const [config, setConfig] = useState<LockConfig>(read);
  const [locked, setLocked] = useState(() => localStorage.getItem(LOCKED_KEY) === "1");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const lock = useCallback(() => {
    setLocked(true);
    try {
      localStorage.setItem(LOCKED_KEY, "1");
    } catch {
      /* 못 적어도 이번 세션에는 잠긴다 */
    }
  }, []);

  const unlock = useCallback(() => {
    setLocked(false);
    try {
      localStorage.removeItem(LOCKED_KEY);
    } catch {
      /* 무시 */
    }
  }, []);

  const save = useCallback((next: LockConfig) => {
    setConfig(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 무시 */
    }
  }, []);

  /*
   * 아무 동작이 없으면 잠근다.
   *
   * 마우스·키보드·스크롤·터치를 다 본다. 하나라도 있으면 시계를 되돌린다.
   * `passive: true` 를 주는 이유는 스크롤을 막지 않기 위해서다.
   */
  useEffect(() => {
    if (!config.enabled || locked) return;

    const reset = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(lock, config.minutes * 60_000);
    };
    const events = ["mousemove", "mousedown", "keydown", "scroll", "touchstart", "wheel"];
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    reset();

    return () => {
      for (const e of events) window.removeEventListener(e, reset);
      if (timer.current) clearTimeout(timer.current);
    };
  }, [config.enabled, config.minutes, locked, lock]);

  /*
   * 단축키로 바로 잠근다.
   *
   * **자동 잠금(`enabled`)과 따로 논다.** 시간이 지나면 잠그는 건 꺼 두고 싶어도
   * 손으로 잠그는 건 쓰고 싶을 수 있다 — 회사에서 자리를 뜰 때가 그렇다.
   *
   * 입력창 안이라고 봐주지 않는다. 누가 다가와서 누르는 것인데 「지금 메모 중이라
   * 안 잠급니다」는 말이 안 된다. 대신 **입력창에서 안 쓰는 조합**만 목록에 뒀다.
   */
  useEffect(() => {
    if (config.hotkey === "off" || locked) return;
    const onKey = (e: KeyboardEvent) => {
      if (!matches(e, config.hotkey)) return;
      // 브라우저 기본 동작(예: Ctrl+Q 종료)보다 먼저 잠근다
      e.preventDefault();
      lock();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [config.hotkey, locked, lock]);

  return { config, save, locked, lock, unlock };
}
