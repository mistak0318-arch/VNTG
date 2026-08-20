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
 * ## 비밀번호는 해시로만 남긴다
 *
 * 원문을 저장하면 localStorage 를 열어보는 것만으로 드러난다. SHA-256 을 저장하고
 * 비교만 한다 — 되돌릴 수 없으니 잊으면 설정에서 새로 정해야 한다.
 * (`crypto.subtle` 은 https 나 localhost 에서만 된다. 둘 다 우리 경우다)
 */

const KEY = "vntg.lock.v1";

export interface LockConfig {
  enabled: boolean;
  /** 몇 분 동안 아무 동작이 없으면 잠글지 */
  minutes: number;
  /** SHA-256 해시. 비어 있으면 잠금이 안 걸린다 */
  hash: string;
}

const DEFAULT: LockConfig = { enabled: false, minutes: 5, hash: "" };

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
      hash: typeof raw.hash === "string" ? raw.hash : "",
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
    if (!config.enabled || !config.hash || locked) return;

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
  }, [config.enabled, config.hash, config.minutes, locked, lock]);

  return { config, save, locked, lock, unlock };
}
