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

/* ── 잠긴 동안은 서버로 아무것도 안 나간다 (2026-09-09 재검토) ──────────────
 *
 * `useRealtime`·`useLive`·시계열 폴링에 하나씩 게이트를 달았는데, 실측하니 잠근 뒤에도
 * 20초에 28건이 나갔다 — 알림 종·나가는 작업·신호등 배지·헤더 티커처럼 **저마다 `setInterval`
 * 을 도는 폴러가 열넷**이었다. 하나씩 쫓으면 새 폴러가 생길 때마다 또 샌다(이 앱에서 그런
 * 목록은 늘 샜다). 프록시 로그엔 경로가 뭐든 vntgts.com 한 줄이라, 하나만 남아도 「잠갔는데
 * 접속 중」으로 찍힌다.
 *
 * 그래서 **한 곳에서** 막는다: 잠긴 동안 `/api/` 로 가는 fetch 를 가로채 곧바로 거절한다.
 * 폴러들은 전부 `.catch(() => …)` 로 실패를 삼키므로 화면이 깨지지 않고, 풀리면 다음
 * 주기에 저절로 이어진다. 응답을 안 주고 매달아 두면 약속이 쌓이므로 **거절**이다.
 *
 * 예외 둘.
 *   · `/api/settings/ui` — 잠금 표식 자체를 서버에 올리는 길. 막으면 다른 기기가 잠긴 줄 모른다.
 *   · `/api/auth/` — 로그인 문. ⚠️ 잠긴 채 새로고침하면 `LoginGate` 가 `/api/auth/state` 를
 *     받기 전까지 **아무것도 안 그린다**. 이걸 막으면 잠금 화면조차 못 뜨고 빈 화면에 갇힌다
 *     (교착). 로그인 상태·로그인은 종목 데이터가 아니다.
 * 잠금 해제는 서버 없이 PIN 을 로컬에서 견주므로 그쪽은 예외가 필요 없다.
 */
const LOCK_PASS = ["/api/settings/ui", "/api/auth/"];

export class LockedError extends Error {
  constructor() {
    super("잠겨 있어 서버에 안 보냅니다");
    this.name = "LockedError";
  }
}

if (typeof window !== "undefined" && typeof window.fetch === "function") {
  const realFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (locked) {
      const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
      const path = url.startsWith("http") ? new URL(url).pathname : url.split("?")[0];
      if (path.startsWith("/api/") && !LOCK_PASS.some((p) => path.startsWith(p))) {
        return Promise.reject(new LockedError());
      }
    }
    return realFetch(input, init);
  }) as typeof window.fetch;
}
