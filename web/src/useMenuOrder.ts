import { useEffect, useState } from "react";

/**
 * 사이드바 메뉴 순서·표시 여부.
 *
 * 메뉴가 스무 개를 넘으면서 **자주 쓰는 것이 사람마다 다르다**. 어떤 날은 시장 흐름만 보고,
 * 어떤 날은 시세분석만 파는데 매번 같은 자리에서 찾아 내려가는 건 낭비다.
 *
 * 서버에 둘 이유가 없어 localStorage 에만 저장한다 — 기기마다 다른 게 오히려 자연스럽고
 * (미니PC는 상시 대시보드, 휴대폰은 관심종목 위주), 저장 실패해도 기본 순서로 돌아가면 그만이다.
 *
 * **저장된 순서는 절대 기준이 아니다.** 코드에 메뉴가 새로 추가되면 저장분에 없으므로,
 * 저장된 것을 먼저 놓고 **모르는 항목은 원래 자리 순서대로 뒤에 붙인다.** 그래야 기능을
 * 추가했는데 화면에서 사라지는 일이 없다.
 */

const KEY = "vntg.menu.order.v1";

export interface MenuPrefs {
  /** 항목 키를 원하는 순서대로 */
  order: string[];
  /** 숨긴 항목 키 */
  hidden: string[];
}

const EMPTY: MenuPrefs = { order: [], hidden: [] };

function read(): MenuPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as MenuPrefs | null;
    if (!raw) return EMPTY;
    return {
      order: Array.isArray(raw.order) ? raw.order.map(String) : [],
      hidden: Array.isArray(raw.hidden) ? raw.hidden.map(String) : [],
    };
  } catch {
    return EMPTY;
  }
}

export function useMenuPrefs() {
  const [prefs, setPrefs] = useState<MenuPrefs>(EMPTY);

  useEffect(() => {
    setPrefs(read());
    // 다른 탭·창에서 바꾸면 따라간다
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setPrefs(read());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  function save(next: MenuPrefs) {
    setPrefs(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* 저장 못 해도 이번 세션에는 적용된다 */
    }
    // 같은 창의 다른 컴포넌트(사이드바)도 즉시 반영되도록
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
  }

  return { prefs, save };
}

/**
 * 저장된 순서를 실제 메뉴 목록에 적용한다.
 * 저장분에 없는 항목(새로 추가된 기능)은 **원래 순서대로 뒤에 붙인다** — 사라지면 안 된다.
 */
export function applyOrder<T extends { key: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((k, i) => [k, i]));
  const known = items.filter((i) => rank.has(i.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!);
  const fresh = items.filter((i) => !rank.has(i.key));
  return [...known, ...fresh];
}
