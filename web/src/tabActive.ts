import { createContext, useContext } from "react";

/**
 * 인앱 탭 (2026-08-26) — 지금 이 페이지가 **보이는 탭인가.**
 *
 * 탭 기능은 열린 페이지들을 언마운트하지 않고 숨긴다(상태 보존이 목적이니까).
 * 그런데 숨은 페이지가 실시간 구독을 계속 물고 있으면 소켓 정원(200)을 잡아먹는다 —
 * useRealtime 이 이 컨텍스트를 읽어서, 숨은 탭에서는 구독·폴링을 통째로 놓는다.
 * 탭 기능 밖(단독 창·미니창)에서는 기본값 true 라 아무것도 안 바뀐다.
 */
export const TabActiveContext = createContext(true);

export function useTabActive(): boolean {
  return useContext(TabActiveContext);
}
