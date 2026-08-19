import { useCallback, useEffect, useState } from "react";
import { api } from "./api";

/**
 * 사이드바 메뉴 순서·표시 여부.
 *
 * 메뉴가 스무 개를 넘으면서 **자주 쓰는 것이 사람마다 다르다**. 어떤 날은 시장 흐름만 보고,
 * 어떤 날은 시세분석만 파는데 매번 같은 자리에서 찾아 내려가는 건 낭비다.
 *
 * **서버에 저장한다.** 예전엔 localStorage 뿐이었고 "기기마다 다른 게 자연스럽다"고 적어 뒀는데
 * 써 보니 아니었다 — 미니PC 에서 즐겨찾기를 정해 놓고 폰으로 열면 처음부터 다시 정해야 했다.
 * 한 사람이 여러 기기로 같은 서버를 보는 구조라 설정도 서버에 있는 게 맞다.
 *
 * localStorage 는 **첫 화면을 즉시 그리기 위한 사본**으로만 남긴다. 서버 응답을 기다리는
 * 동안 메뉴가 기본 순서로 번쩍였다가 바뀌면 그게 더 나쁘다.
 * (화면 외관 — 테마·글꼴·글자 크기 — 은 그대로 기기별이다. 그건 화면 크기에 딸린 값이다)
 *
 * **저장된 순서는 절대 기준이 아니다.** 코드에 메뉴가 새로 추가되면 저장분에 없으므로,
 * 저장된 것을 먼저 놓고 **모르는 항목은 원래 자리 순서대로 뒤에 붙인다.** 그래야 기능을
 * 추가했는데 화면에서 사라지는 일이 없다.
 */

const KEY = "vntg.menu.order.v1";

export interface MenuPrefs {
  /** 항목 키를 원하는 순서대로 (그룹 이름도 같은 배열에 섞여 들어간다) */
  order: string[];
  /** 숨긴 항목 키 */
  hidden: string[];
  /**
   * 이름 바꾸기. 키(또는 그룹 이름) → 내가 쓸 이름.
   * 코드가 붙인 이름이 내 머릿속 이름과 다를 수 있다 — "시세분석"을 "스크리너"라고
   * 부르는 사람에게는 그게 맞는 이름이다.
   */
  labels: Record<string, string>;
  /** 항목을 다른 그룹으로 옮긴다. 항목 키 → 그룹 이름 */
  groupOf: Record<string, string>;
  /** 내가 만든 그룹 이름들 — 기본 그룹 외에 더 만들 수 있다 */
  extraGroups: string[];
  /**
   * 자주 쓰는 메뉴.
   *
   * 메뉴가 스물다섯을 넘으면서 매번 목록을 훑게 됐다. 순서를 바꿔 봐야 자주 쓰는 게
   * 대여섯인데 그것들이 그룹마다 흩어져 있어 소용이 없었다.
   * **그룹을 무시하고 맨 위에 따로** 세운다. 순서는 여기 적힌 순서다.
   */
  favorites: string[];
}

const EMPTY: MenuPrefs = { order: [], hidden: [], labels: {}, groupOf: {}, extraGroups: [], favorites: [] };

function read(): MenuPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as MenuPrefs | null;
    if (!raw) return EMPTY;
    // 필드가 늘기 전에 저장된 것도 그대로 읽힌다
    return {
      order: Array.isArray(raw.order) ? raw.order.map(String) : [],
      hidden: Array.isArray(raw.hidden) ? raw.hidden.map(String) : [],
      labels: raw.labels && typeof raw.labels === "object" ? raw.labels : {},
      groupOf: raw.groupOf && typeof raw.groupOf === "object" ? raw.groupOf : {},
      extraGroups: Array.isArray(raw.extraGroups) ? raw.extraGroups.map(String) : [],
      favorites: Array.isArray(raw.favorites) ? raw.favorites.map(String) : [],
    };
  } catch {
    return EMPTY;
  }
}

/** 사본에 적어 둔다 — 다음에 열 때 첫 화면을 곧바로 그리려는 것이다 */
function cache(p: MenuPrefs): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p));
  } catch {
    /* 사본을 못 남겨도 서버에 있으면 된다 */
  }
}

export function useMenuPrefs() {
  // 사본을 먼저 그린다. 서버를 기다리며 기본 순서로 번쩍이면 그게 더 나쁘다
  const [prefs, setPrefs] = useState<MenuPrefs>(read);

  useEffect(() => {
    let alive = true;
    api
      .menuPrefs()
      .then((server) => {
        if (!alive) return;
        /*
         * **처음 한 번의 이사.**
         *
         * 예전 설정은 이 기기의 localStorage 에만 있었다. 서버가 아직 한 번도 저장된 적이
         * 없는데 빈 값을 받아 덮어쓰면 쓰던 즐겨찾기가 그 자리에서 사라진다.
         * 그럴 때는 반대로 **내 것을 서버로 올린다.**
         */
        if (!server.saved) {
          const mine = read();
          if (mine.favorites.length > 0 || mine.order.length > 0 || mine.hidden.length > 0) {
            void api.menuPrefsSave(mine).catch(() => {});
            return;
          }
        }
        setPrefs(server);
        cache(server);
      })
      .catch(() => {
        /* 서버를 못 읽으면 사본으로 계속 쓴다 — 메뉴가 사라지면 안 된다 */
      });

    // 같은 창의 다른 컴포넌트(사이드바)도 즉시 반영되도록
    const onStorage = (e: StorageEvent) => {
      if (e.key === KEY) setPrefs(read());
    };
    window.addEventListener("storage", onStorage);
    return () => {
      alive = false;
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const save = useCallback((next: MenuPrefs) => {
    // 화면을 먼저 바꾼다 — 서버 왕복을 기다리면 누른 느낌이 늦다
    setPrefs(next);
    cache(next);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    void api.menuPrefsSave(next).catch(() => {
      /* 서버에 못 올려도 이번 기기에는 적용돼 있다. 다음에 켤 때 다시 올라간다 */
    });
  }, []);

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
