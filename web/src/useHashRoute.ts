import { useCallback, useEffect, useState } from "react";
import { blankHash, readStock, saveHash, saveStock, scrubHash } from "./urlPrivacy";

/**
 * URL 해시 기반 라우팅.
 *
 * 브라우저를 새로고침해도 보던 화면이 유지되고, 뒤로가기로 이전 화면·이전 종목으로
 * 돌아갈 수 있게 한다. 해시를 쓰는 이유는 정적 서빙만으로 동작해서
 * (dev 서버든 미니PC 배포든) 서버 라우팅 설정이 따로 필요 없기 때문이다.
 *
 * 형식: #/{tab}   예) #/volume
 *
 * ⚠️ **종목은 주소에 안 적는다** (2026-09-09 — 벤티지: "URL 파라미터로 종목명하고...
 * 아 얘가 주식하는구나 유추할 수 있어"). 예전에는 `#/volume?code=005930&name=삼성전자`
 * 였는데, 한글 종목명이 주소창에 그대로 떠서 화면을 무채색으로 감춰도 소용이 없었다.
 *
 * 지금은 **창별 세션**(`urlPrivacy`)에 담는다 — 새로고침해도 보던 종목이 그대로고,
 * 창을 닫으면 같이 사라진다. 들어오는 주소에 `code`·`name` 이 실려 있으면(알림 링크 등)
 * 그것은 읽어서 세션에 옮기고 주소에서는 지운다.
 */

export interface Route {
  tab: string;
  stock: { code: string; name: string } | null;
}

function parseHash(fallbackTab: string): Route {
  const raw = window.location.hash.replace(/^#\/?/, "");
  if (!raw) return { tab: fallbackTab, stock: null };

  const [path, queryString] = raw.split("?");
  const tab = path || fallbackTab;

  /* 주소가 종목을 들고 왔으면 세션으로 옮긴다 — 주소에서는 곧 지워진다(`scrubHash`) */
  if (queryString) {
    const code = new URLSearchParams(queryString).get("code");
    if (code) {
      const stock = { code, name: new URLSearchParams(queryString).get("name") ?? code };
      saveStock(stock);
      return { tab, stock };
    }
  }
  /* 주소에 없으면 세션에 둔 것 — 새로고침해도 보던 종목이 남는 길이다 */
  return { tab, stock: readStock() };
}

/** 주소는 **화면 이름까지만** — 종목은 세션에 있다 */
function buildHash(route: Route): string {
  return `#/${route.tab}`;
}

export function useHashRoute(fallbackTab: string) {
  const [route, setRoute] = useState<Route>(() => parseHash(fallbackTab));

  // 최초 진입 시 해시가 없으면 기본 경로를 채워 넣는다 (새로고침해도 유지되도록)
  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, "", buildHash({ tab: fallbackTab, stock: null }));
    }
  }, [fallbackTab]);

  /*
   * 주소를 **비운다.** 종목은 위 `parseHash` 가 세션으로 옮겼고, 화면 이름은 여기서
   * 세션과 히스토리 상태에 옮긴 뒤 주소에서 지운다.
   *
   * ⚠️ `useEffect` 인 것이 중요하다 — 주문 화면은 주소의 쪽지를 모듈이 불러오는 순간
   * (리액트보다 먼저) 집어 두고, 보드 단독창은 첫 렌더에 읽는다. 그보다 일찍 지우면
   * 알림을 눌러 온 사람이 빈 폼을 만난다.
   */
  useEffect(() => {
    const tidy = () => {
      scrubHash();      // 종목 신원 먼저 — 세션에 남길 주소에도 안 들어가게
      saveHash();       // 남은 것(화면 이름·screen·only…)을 창 세션에
      blankHash();      // 주소창에는 `#/` 만
    };
    tidy();
    /* 링크(`#/order?stk=…`)로 화면이 바뀌는 길 — 읽힌 뒤에 비운다 */
    const onHash = () => {
      setRoute(parseHash(fallbackTab));
      tidy();
    };
    /*
     * 뒤로/앞으로 — 주소가 늘 `#/` 라 `hashchange` 가 안 온다. 칸에 실어 둔
     * 화면 이름을 읽어 돌아간다. 시트가 쌓은 칸(`vntgSheet`)은 시트가 알아서 닫으므로
     * 여기서는 손대지 않는다.
     */
    const onPop = (e: PopStateEvent) => {
      const st = e.state as { vntgTab?: string; vntgSheet?: boolean } | null;
      if (st?.vntgSheet) return;
      if (st?.vntgTab) setRoute((prev) => (prev.tab === st.vntgTab ? prev : { ...prev, tab: st.vntgTab! }));
    };
    window.addEventListener("hashchange", onHash);
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("popstate", onPop);
    };
  }, [fallbackTab]);

  const navigate = useCallback((next: Partial<Route>) => {
    setRoute((prev) => {
      const merged: Route = {
        tab: next.tab ?? prev.tab,
        stock: next.stock === undefined ? prev.stock : next.stock,
      };
      /* 종목이 바뀌면 세션도 따라간다 — 주소가 안 들고 있으므로 여기가 유일한 자리다 */
      if (next.stock !== undefined) saveStock(merged.stock);
      /*
       * 주소는 `#/` 로 두고 **화면 이름은 히스토리 상태에** 싣는다 (2026-09-09).
       * 주소가 같아도 칸은 쌓이므로 뒤로/앞으로가 그대로 돈다 — 뒤로가기가 오면
       * 아래 `popstate` 가 이 상태를 읽어 그 화면으로 돌아간다.
       */
      if (merged.tab !== prev.tab) {
        window.history.pushState({ vntgTab: merged.tab }, "", "#/");
        try {
          sessionStorage.setItem("vntg.route.hash", `#/${merged.tab}`);
        } catch {
          /* 세션이 막혀 있으면 새로고침에서 기본 화면으로 — 지금 화면은 그대로다 */
        }
      }
      return merged;
    });
  }, []);

  return { route, navigate };
}
