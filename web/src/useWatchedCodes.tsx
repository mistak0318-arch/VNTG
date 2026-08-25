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
}

const WatchedContext = createContext<WatchedContextValue | null>(null);

export function WatchedCodesProvider({ children }: { children: ReactNode }) {
  const [codes, setCodes] = useState<Set<string>>(new Set());

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
      markAdded: (code: string) => setCodes((prev) => new Set(prev).add(code)),
      markRemoved: (code: string) =>
        setCodes((prev) => {
          const next = new Set(prev);
          next.delete(code);
          return next;
        }),
    }),
    [codes, refresh],
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
