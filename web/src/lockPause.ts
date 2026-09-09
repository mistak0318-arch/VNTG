import { useSyncExternalStore } from "react";

/**
 * **잠그면 실시간을 멈춘다** (2026-09-09).
 *
 * 벤티지: 회사(삼성 SSL 인스펙션)에서는 화면을 안 볼 때 vntgts.com 으로 가는 **상시
 * 연결(SSE)** 이 프록시 로그에 계속 남는다. 자리를 뜰 때 화면만 가리는 게 아니라
 * 트래픽까지 멈추고 싶다 — Ctrl+Q(화면 잠금)에 그 일을 얹는다.
 *
 * ## 왜 `document.hidden` 이 아니라 잠금인가
 *
 * 처음엔 「브라우저 탭이 뒤로 가면 끊자」를 봤는데 벤티지가 막았다 — **집에서는
 * 미니창·본창을 여럿 띄워 놓고 쓴다.** 포커스 안 된 창을 끊으면 곁창이 다 얼어버린다.
 *
 * 그래서 **명시적으로 잠글 때만** 멈춘다. 집에서는 잠글 일이 없으니 여러 창이 그대로
 * 다 살아 있고, 회사에서 자리를 뜰 때 Ctrl+Q 한 번이 화면과 트래픽을 같이 덮는다.
 *
 * ## 어떻게 닿나
 *
 * `useRealtime` 은 화면 곳곳에서 도는 훅이라 잠금 상태를 **모듈 전역**으로 알린다
 * (`TabActiveContext` 와 같은 손). 잠금은 `localStorage` 에 적히므로 **다른 창까지**
 * `storage` 이벤트로 함께 멈춘다 — 미니창을 잠그면 본창의 실시간도 선다. 회사에서는
 * 그게 맞다(한 자리를 뜨는 것이다).
 */

const KEY = "vntg.lock.locked";

let locked = read();
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

/** 화면 잠금 훅이 상태를 바꿀 때 부른다 — 같은 창의 `useRealtime` 들이 즉시 반응한다 */
export function setLockPaused(next: boolean): void {
  if (locked === next) return;
  locked = next;
  emit();
}

/* 다른 창이 잠그면(=`storage` 이벤트) 이 창도 따라 멈춘다 */
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) {
      const next = read();
      if (next !== locked) {
        locked = next;
        emit();
      }
    }
  });
}

/** 지금 잠겨 있나 — 잠겨 있으면 실시간을 놓는다 */
export function useLockPaused(): boolean {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => locked,
    () => false,
  );
}
