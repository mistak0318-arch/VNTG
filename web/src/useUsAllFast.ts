import { useEffect, useState } from "react";
import { api } from "./api";

/**
 * **모든 해외 관심종목의 빠른 시세** (2026-09-09 밤 — 벤티지 "빨간색 친 부분들은 실시간
 * 업데이트 안 되는 거 같은데": 관심종목 MAP·섹터 MAP 타일, 그룹 칩).
 *
 * 표 줄은 3초 빠른 시세(+한투 소켓)를 덮는데, 타일·칩은 `usWatch()`(20초 폴링, 서버 1분
 * 캐시) 값 그대로였다 — 최대 1분 묵은 값. 여기서 **전 종목**을 야후 spark 배치로 받아
 * 타일·칩이 덮어 쓴다. `sub=0` — 소켓 구독은 안 건드린다(한투 41종목 상한은 「지금 보는
 * 그룹」 몫이다). 장중 15초 · 아니면 60초, 탭이 뒤에 있으면 쉰다.
 *
 * 값은 심볼 → { changeRate, price, at }. 없는 심볼은 부르는 쪽이 제 값을 쓴다.
 */
export type FastQuote = { price: number; changeRate: number | null; at: number };

export function useUsAllFast(symbols: string[], openMarket: boolean): Record<string, FastQuote> {
  const [fast, setFast] = useState<Record<string, FastQuote>>({});
  const key = [...new Set(symbols)].sort().join(",");
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const list = key.split(",");
    const period = openMarket ? 15_000 : 60_000;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      /* 서버 상한 200 — 그 이상이면 나눠 묻는다 */
      for (let i = 0; i < list.length; i += 200) {
        api
          .usWatchFast(list.slice(i, i + 200), false)
          .then((r) => alive && setFast((prev) => ({ ...prev, ...r.quotes })))
          .catch(() => undefined);
      }
    };
    tick();
    const t = setInterval(tick, period);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [key, openMarket]);
  return fast;
}

/** 구성종목의 지금 등락률 단순평균 — 빠른 시세가 있으면 그것, 없으면 제 값 */
export function liveMean(
  stocks: { symbol: string; changeRate: number | null }[],
  fast: Record<string, FastQuote>,
): number | null {
  const rates = stocks
    .map((s) => fast[s.symbol]?.changeRate ?? s.changeRate)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  if (rates.length === 0) return null;
  return rates.reduce((a, b) => a + b, 0) / rates.length;
}
