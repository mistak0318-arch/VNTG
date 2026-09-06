import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api } from "./api";

/**
 * AI_HTS 관심종목 코드 집합을 앱 전역에서 공유한다.
 * 모든 리스트 화면이 같은 목록을 보고 ★를 표시하며,
 * 어느 화면에서 추가/삭제해도 즉시 전 화면에 반영된다.
 */
interface WatchedContextValue {
  codes: Set<string>;
  isWatched: (code: string) => boolean;
  refresh: () => Promise<void>;
  markAdded: (code: string) => void;
  markRemoved: (code: string) => void;
  /**
   * **관심종목이 바뀔 때마다 1씩** (2026-09-07). 어느 화면에서 담기 시트로 그룹을 바꿨는데
   * 관심종목 화면은 그걸 몰랐다 — 코드 집합(`codes`)은 이미 담긴 종목의 그룹이 바뀌어도
   * 그대로라 아무도 깨어나지 않았다. 벤티지: "다른 그룹 추가했는데 새로고침해야만
   * 보이네?" 목록을 그리는 화면은 이 숫자를 보고 다시 받는다.
   */
  version: number;
}

const WatchedContext = createContext<WatchedContextValue | null>(null);

export function WatchedCodesProvider({ children }: { children: ReactNode }) {
  const [codes, setCodes] = useState<Set<string>>(new Set());
  const [version, setVersion] = useState(0);

  const refresh = useCallback(async () => {
    try {
      const { items } = await api.watchlist();
      setCodes(new Set(items.map((i) => i.code)));
    } catch {
      // 관심종목을 못 불러와도 화면은 정상 동작해야 하므로 조용히 무시
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const value = useMemo<WatchedContextValue>(
    () => ({
      codes,
      isWatched: (code: string) => codes.has(code),
      refresh,
      markAdded: (code: string) => {
        setCodes((prev) => new Set(prev).add(code));
        setVersion((v) => v + 1);
      },
      markRemoved: (code: string) => {
        setCodes((prev) => {
          const next = new Set(prev);
          next.delete(code);
          return next;
        });
        setVersion((v) => v + 1);
      },
      version,
    }),
    [codes, refresh, version],
  );

  return <WatchedContext.Provider value={value}>{children}</WatchedContext.Provider>;
}

export function useWatchedCodes(): WatchedContextValue {
  const ctx = useContext(WatchedContext);
  if (!ctx) throw new Error("useWatchedCodes는 WatchedCodesProvider 안에서만 사용할 수 있습니다.");
  return ctx;
}

/** 관심종목이면 ★를 보여주는 작은 표시 */
export function WatchStar({ code }: { code: string }) {
  const { isWatched } = useWatchedCodes();
  if (!isWatched(code)) return null;
  return (
    <span className="watch-star" title="VNTG 관심종목">
      ★
    </span>
  );
}
