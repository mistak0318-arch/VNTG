import { useCallback, useEffect, useState } from "react";

/**
 * URL 해시 기반 라우팅.
 *
 * 브라우저를 새로고침해도 보던 화면이 유지되고, 뒤로가기로 이전 화면·이전 종목으로
 * 돌아갈 수 있게 한다. 해시를 쓰는 이유는 정적 서빙만으로 동작해서
 * (dev 서버든 미니PC 배포든) 서버 라우팅 설정이 따로 필요 없기 때문이다.
 *
 * 형식: #/{tab}                       예) #/volume
 *       #/{tab}?code=005930&name=삼성전자   종목 상세가 열린 상태
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

  if (!queryString) return { tab, stock: null };
  const params = new URLSearchParams(queryString);
  const code = params.get("code");
  if (!code) return { tab, stock: null };

  return { tab, stock: { code, name: params.get("name") ?? code } };
}

function buildHash(route: Route): string {
  if (!route.stock) return `#/${route.tab}`;
  const params = new URLSearchParams({ code: route.stock.code, name: route.stock.name });
  return `#/${route.tab}?${params.toString()}`;
}

export function useHashRoute(fallbackTab: string) {
  const [route, setRoute] = useState<Route>(() => parseHash(fallbackTab));

  // 뒤로/앞으로 가기나 주소창 직접 수정에 반응
  useEffect(() => {
    const onChange = () => setRoute(parseHash(fallbackTab));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, [fallbackTab]);

  // 최초 진입 시 해시가 없으면 기본 경로를 채워 넣는다 (새로고침해도 유지되도록)
  useEffect(() => {
    if (!window.location.hash) {
      window.history.replaceState(null, "", buildHash({ tab: fallbackTab, stock: null }));
    }
  }, [fallbackTab]);

  const navigate = useCallback((next: Partial<Route>) => {
    setRoute((prev) => {
      const merged: Route = {
        tab: next.tab ?? prev.tab,
        stock: next.stock === undefined ? prev.stock : next.stock,
      };
      const hash = buildHash(merged);
      if (hash !== window.location.hash) {
        window.history.pushState(null, "", hash);
      }
      return merged;
    });
  }, []);

  return { route, navigate };
}
