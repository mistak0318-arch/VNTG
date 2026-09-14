import { createContext, useContext } from "react";

/**
 * 지금 이 화면을 **내가 뭐라고 부르기로 했는가** (2026-09-14).
 *
 * 벤티지: "메뉴명 변경했는데 탭에는 이전 이름 그대로 나오네 현미경하고 매수직전 봐."
 * 설정에서 메뉴 이름을 바꾸면(`vntg.menu.order.v1` 의 `labels`) 사이드바만 따라오고
 * 탭 줄과 **화면 안의 큰 제목**은 코드에 박힌 이름을 그렸다. 한 화면이 자리마다
 * 다른 이름으로 불리면 그게 제일 헷갈린다.
 *
 * 이름만 준다 — **아이콘은 화면이 자기 것을 쓴다.** 매수직전은 메뉴에서 🧨 인데
 * 화면 제목은 🔎 다. 일부러 다르게 둔 자리라 여기서 통일하지 않는다.
 *
 * 탭 밖(미니창·단독 창)에서는 값이 없어 각 화면이 준 원래 이름이 그대로 쓰인다.
 */
export const TabTitleContext = createContext<string | null>(null);

/** 바꾼 이름이 있으면 그것, 없으면 화면이 원래 쓰던 이름 */
export function useTabTitle(fallback: string): string {
  return useContext(TabTitleContext) ?? fallback;
}
