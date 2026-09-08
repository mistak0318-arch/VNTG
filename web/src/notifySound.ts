import { setPref } from "./prefs";

/**
 * **체결되면 소리로 알린다** (2026-09-08).
 *
 * 벤티지: "체결되었을 때에는 토스트 메시지 보여주든지 해야겠다. 지금 되었는지 안 되었는지
 * 모르겠네. 소리로 알려줘도 좋아. … 공짜로 쓸 수 있는 사운드 있으면 추가로 해주고,
 * 핸드폰은 진동 오게 할 수는 … 없겠지?"
 *
 * ## 왜 음원 파일을 안 쓰나
 *
 * 「공짜 사운드」를 받아 넣으면 **출처와 라이선스를 계속 따라다녀야 한다**(CC0 라도 재배포
 * 조건이 붙는 것이 있다). 그리고 파일 하나가 수십 KB 라 앱이 무거워진다.
 * 여기서는 **WebAudio 로 그 자리에서 합성한다** — 파일이 없으니 라이선스도 없고, 용량은
 * 0 이며, 소리를 새로 만들고 싶으면 숫자만 바꾸면 된다.
 *
 * ## 진동은 되나
 *
 * **안드로이드는 된다.** `navigator.vibrate` 는 크롬·삼성인터넷에서 동작하고, 홈 화면에 깐
 * PWA 에서도 그대로 된다. **아이폰은 안 된다** — 사파리가 이 기능을 구현하지 않았다.
 * 그래서 설정에서 켤 수는 있게 두되, 안 되는 기기에서는 「이 기기는 진동을 지원하지 않음」을
 * 화면에 적는다. 되는 척하는 스위치가 제일 나쁘다.
 *
 * ## 브라우저가 소리를 막는 문제
 *
 * 사용자가 페이지를 한 번도 안 건드렸으면 `AudioContext` 가 `suspended` 로 태어난다.
 * 그래서 **아무 클릭이나 한 번** 있으면 그때 깨운다(`armAudio`). 앱을 열자마자 오는 첫 알림은
 * 소리가 안 날 수 있는데, 그건 브라우저 규칙이라 우회할 방법이 없다 — 토스트는 뜬다.
 */

export type SoundKey = "ding" | "dingdong" | "chime" | "tick" | "alarm" | "bell3" | "down" | "coin";

export const SOUNDS: { key: SoundKey; label: string; hint: string }[] = [
  { key: "ding", label: "딩", hint: "종 한 번 — 가장 짧다" },
  { key: "dingdong", label: "딩동", hint: "두 음 — 초인종처럼" },
  { key: "chime", label: "차임", hint: "세 음이 올라간다 — 체결에 어울린다" },
  { key: "tick", label: "틱", hint: "아주 짧은 딱 소리 — 조용한 곳에서" },
  { key: "alarm", label: "경고", hint: "두 번 반복 — 놓치면 안 될 때" },
  { key: "bell3", label: "종 세 번", hint: "같은 높이 세 번 — 또렷하다" },
  { key: "down", label: "하강", hint: "세 음이 내려간다 — 매도 체결에" },
  { key: "coin", label: "동전", hint: "짧고 높은 두 음 — 게임의 그 소리" },
];

/** 한 음 = [주파수(Hz), 시작(초), 길이(초), 세기] */
const SCORE: Record<SoundKey, [number, number, number, number][]> = {
  ding: [[880, 0, 0.45, 0.5]],
  dingdong: [
    [784, 0, 0.22, 0.5],
    [587, 0.18, 0.5, 0.5],
  ],
  chime: [
    [659, 0, 0.18, 0.42],
    [784, 0.12, 0.18, 0.42],
    [1047, 0.24, 0.55, 0.45],
  ],
  tick: [[1400, 0, 0.06, 0.35]],
  alarm: [
    [988, 0, 0.14, 0.5],
    [988, 0.22, 0.14, 0.5],
    [988, 0.44, 0.2, 0.5],
  ],
  bell3: [
    [1319, 0, 0.3, 0.45],
    [1319, 0.35, 0.3, 0.45],
    [1319, 0.7, 0.45, 0.45],
  ],
  down: [
    [1047, 0, 0.18, 0.42],
    [784, 0.14, 0.18, 0.42],
    [659, 0.28, 0.5, 0.45],
  ],
  coin: [
    [1975, 0, 0.08, 0.4],
    [2637, 0.09, 0.3, 0.4],
  ],
};

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
  try {
    if (!ctx) {
      const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!C) return null;
      ctx = new C();
    }
    return ctx;
  } catch {
    return null;
  }
}

/**
 * 첫 클릭에 소리 장치를 깨운다. App 이 한 번 부른다.
 * 자동재생 정책 때문에 **사용자 몸짓 안에서** 깨워야 한다.
 */
export function armAudio(): () => void {
  const wake = () => {
    const a = audio();
    if (a && a.state === "suspended") void a.resume().catch(() => undefined);
  };
  window.addEventListener("pointerdown", wake, { once: false, passive: true });
  window.addEventListener("keydown", wake, { once: false, passive: true });
  return () => {
    window.removeEventListener("pointerdown", wake);
    window.removeEventListener("keydown", wake);
  };
}

/** 소리 하나 — 사인파에 부드러운 감쇠. 딱딱한 시작/끝은 「틱」 잡음이 된다 */
export function playSound(key: SoundKey, volume = 0.6): void {
  const a = audio();
  if (!a) return;
  if (a.state === "suspended") void a.resume().catch(() => undefined);
  const notes = SCORE[key] ?? SCORE.ding;
  const t0 = a.currentTime + 0.01;
  for (const [hz, at, dur, amp] of notes) {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = key === "tick" ? "square" : "sine";
    osc.frequency.value = hz;
    const start = t0 + at;
    const peak = Math.max(0, Math.min(1, amp * volume));
    gain.gain.setValueAtTime(0, start);
    gain.gain.linearRampToValueAtTime(peak, start + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    osc.connect(gain).connect(a.destination);
    osc.start(start);
    osc.stop(start + dur + 0.05);
  }
}

/** 이 기기가 진동을 할 수 있나 — 아이폰은 false */
export function canVibrate(): boolean {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

export function vibrate(pattern: number | number[] = [90, 60, 90]): void {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 지원 안 하면 조용히 넘어간다 */
  }
}

/* ------------------------------------------------------------------ */
/* 설정 — 이 기기의 사정이라 로컬에 둔다                                  */
/* ------------------------------------------------------------------ */

export interface NotifyPrefs {
  /** 화면 구석에 알림 띄우기 */
  toast: boolean;
  /** 소리 */
  sound: boolean;
  soundKey: SoundKey;
  /** 0~1 */
  volume: number;
  /** 진동 (안드로이드만) */
  vibrate: boolean;
  /** 무엇에 울릴지 — 체결만 / 주문·감시까지 / 전부 */
  scope: "fill" | "order" | "all";
}

export const NOTIFY_DEFAULT: NotifyPrefs = {
  toast: true,
  sound: true,
  soundKey: "chime",
  volume: 0.6,
  vibrate: true,
  scope: "order",
};

const KEY = "vntg.notify.local";

export function readNotifyPrefs(): NotifyPrefs {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return NOTIFY_DEFAULT;
    const j = JSON.parse(raw) as Partial<NotifyPrefs>;
    return { ...NOTIFY_DEFAULT, ...j };
  } catch {
    return NOTIFY_DEFAULT;
  }
}

const subs = new Set<(p: NotifyPrefs) => void>();

export function saveNotifyPrefs(patch: Partial<NotifyPrefs>): NotifyPrefs {
  const next = { ...readNotifyPrefs(), ...patch };
  setPref(KEY, JSON.stringify(next));
  for (const fn of subs) fn(next);
  return next;
}

export function onNotifyPrefs(fn: (p: NotifyPrefs) => void): () => void {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

/** 설정 화면의 「들어보기」 — 소리와 진동을 한 번에 */
export function preview(p: NotifyPrefs): void {
  if (p.sound) playSound(p.soundKey, p.volume);
  if (p.vibrate) vibrate();
}
