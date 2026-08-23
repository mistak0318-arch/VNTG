import { useCallback, useEffect, useState } from "react";
import { removePref, setPref } from "./prefs";

/**
 * 최근 본 종목.
 *
 * 종목을 볼 때는 몇 개를 오가며 비교하게 되는데, 그때마다 이름을 다시 치는 게 일이다.
 * 검색 결과에서 고른 것을 기억해 두고 바로 누를 수 있게 한다.
 *
 * 서버에 둘 이유가 없어 localStorage 에만 둔다 — 기기마다 보는 종목이 달라도 자연스럽고,
 * 저장에 실패해도 검색이 막히지는 않는다.
 */

const KEY = "vntg.recent.stocks.v1";
const MAX = 12;

export interface RecentStock {
  code: string;
  name: string;
  /** 마지막으로 본 시각 */
  at: number;
}

function read(): RecentStock[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]") as RecentStock[];
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && typeof r.code === "string" && typeof r.name === "string")
      .slice(0, MAX);
  } catch {
    return [];
  }
}

export function useRecentStocks() {
  const [recent, setRecent] = useState<RecentStock[]>([]);

  useEffect(() => {
    setRecent(read());
    // 다른 화면에서 종목을 보면 이쪽도 따라간다
    const onChange = (e: StorageEvent) => {
      if (e.key === KEY) setRecent(read());
    };
    window.addEventListener("storage", onChange);
    return () => window.removeEventListener("storage", onChange);
  }, []);

  /** 종목을 봤다고 알린다. 같은 종목이면 맨 앞으로 올린다 */
  const push = useCallback((code: string, name: string) => {
    if (!code || !name) return;
    const next = [{ code, name, at: Date.now() }, ...read().filter((r) => r.code !== code)].slice(
      0,
      MAX,
    );
    setRecent(next);
    try {
      setPref(KEY, JSON.stringify(next));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    } catch {
      /* 저장 못 해도 이번 세션에는 남는다 */
    }
  }, []);

  const remove = useCallback((code: string) => {
    const next = read().filter((r) => r.code !== code);
    setRecent(next);
    try {
      setPref(KEY, JSON.stringify(next));
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    } catch {
      /* 무시 */
    }
  }, []);

  const clear = useCallback(() => {
    setRecent([]);
    try {
      removePref(KEY);
      window.dispatchEvent(new StorageEvent("storage", { key: KEY }));
    } catch {
      /* 무시 */
    }
  }, []);

  return { recent, push, remove, clear };
}
