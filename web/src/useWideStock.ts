import { useSyncExternalStore } from "react";

/**
 * **종목상세 모양** — 위아래 두 줄 메뉴(새) ↔ 바닥 시트(옛).
 *
 * 2026-10-12 에 「마음 놓고 써 보라」고 사이드바 「도구」 칸에 스위치를 달았고, 10/14 에
 * 기본을 새 모양으로 뒤집으며 **옛 모양으로 돌아가는 비상구**로 남겨 뒀다. 3주 지나
 * 벤티지가 둘을 짚었다:
 *
 *   "집에서는 화면 구성 이렇게 잘 나오거든? 근데 회사에서는 왜 옛날 화면으로 나오는지
 *    모르겠다" — 값이 기기별(`localStorage`)이라 **회사 기기에서 언젠가 눌린 `"0"` 이
 *    거기에만 박혀** 있었다. 기본이 새 모양이어도 명시적으로 끈 기기는 영영 옛 모양이고,
 *    본인은 누른 기억이 없다.
 *
 *   "이걸 설정안에 집어 넣으라는 얘기야" — 날마다 쓰는 자리(사이드바)에 날마다 안 쓰는
 *    스위치가 나와 있었다.
 *
 * 그래서 스위치는 설정 › 화면으로 가고, 값은 **이번 한 번** 새 구성으로 되돌린다.
 *
 * ## 왜 훅으로 묶었나
 *
 * 설정 화면과 `App` 이 **같은 값을 봐야** 한다. 각자 `localStorage` 를 읽으면, 설정에서
 * 바꿔도 `App` 의 state 는 그대로라 `StockDetail` 에 넘기는 `wide` 가 화면(CSS)과 어긋난다.
 * `wide` 는 모양뿐 아니라 **분봉을 받을지까지** 가르므로(`StockDetail` 131줄) 어긋나면
 * 조용히 빈 차트가 된다.
 *
 * ⚠️ `data-widestock` 속성은 **없애지 않는다.** 이 모양을 만드는 CSS 가 쉰 곳에서
 * `html[data-widestock="1"] …` 로 걸려 있는데, 선택자에서 그걸 떼면 특이도가 낮아져
 * 다른 규칙에 지는 자리가 생긴다. 값을 다루는 쪽만 여기로 모은다.
 */

const KEY = "vntg.wideStock";
/** 이번 한 번만 옛 값을 치웠다는 표시 — 없으면 설정에서 옛 모양을 골라도 새로고침마다 되돌려진다 */
const RESET_KEY = "vntg.wideStock.reset-2026-11-05";

const listeners = new Set<() => void>();

function readInitial(): boolean {
  try {
    if (localStorage.getItem(RESET_KEY) !== "1") {
      localStorage.removeItem(KEY);
      localStorage.setItem(RESET_KEY, "1");
      return true;
    }
    return localStorage.getItem(KEY) !== "0";
  } catch {
    /* 사생활 보호 창 — 이번 세션에만 적용되고 만다 */
    return true;
  }
}

let value = readInitial();

function apply(): void {
  if (typeof document === "undefined") return;
  document.documentElement.setAttribute("data-widestock", value ? "1" : "0");
}

/** 첫 그림이 그려지기 전에 한 번 — 속성이 늦게 붙으면 화면이 한 번 깜빡인다 */
apply();

export function setWideStock(next: boolean): void {
  if (value === next) return;
  value = next;
  apply();
  try {
    localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    /* 못 저장해도 이번 세션에는 바뀐다 */
  }
  for (const l of listeners) l();
}

export function useWideStock(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
    () => value,
    () => true,
  );
}
