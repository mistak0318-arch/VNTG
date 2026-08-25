import { recordApiCall } from "./apiUsage.js";

/**
 * 해외 시세 **빠른 레이어** (2026-08-25 실측).
 *
 * ## 왜 따로 있나
 *
 * 해외 관심종목의 본 시세(한투+야후)는 종목당 한 번씩 부르는 구조라 60초 캐시가
 * 한계다 — 화면이 5초로 폴링해도 **값의 나이가 최대 1분**이었다(느리다는 지적의
 * 실체). 키움 FE 실시간은 등록만 받고 프레임을 안 준다(같은 날 실측).
 *
 * 야후 **spark 는 배치**다: 한 요청에 심볼 여러 개(실측 5개·2개 통과, 1분봉 마지막
 * 점이 그 순간 값 — 23:46:51 실측). 현재가·전일종가만 필요한 오버레이에는 이걸로
 * 충분하다 — 원화·52주·체결강도 같은 무거운 값은 본 시세가 계속 맡는다.
 *
 *   GET /v8/finance/spark?symbols=A,B,…&range=1d&interval=1m
 *   → { A: { previousClose, close[], timestamp[] }, … }
 *
 * 캐시 4초 — 화면(3초 폴링)이 두 번에 한 번은 새 값을 본다. 요청은 20심볼씩 묶는다.
 */

export interface FastQuote {
  price: number;
  changeRate: number | null;
  /** 마지막 점의 시각(ms) */
  at: number;
}

const SPARK = "https://query1.finance.yahoo.com/v8/finance/spark";
const cache = new Map<string, { at: number; q: FastQuote }>();
const TTL = 4_000;

export async function usFastQuotes(symbols: string[]): Promise<Map<string, FastQuote>> {
  const out = new Map<string, FastQuote>();
  const need: string[] = [];
  for (const sym of symbols) {
    const hit = cache.get(sym);
    if (hit && Date.now() - hit.at < TTL) out.set(sym, hit.q);
    else need.push(sym);
  }

  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    try {
      const qs = new URLSearchParams({ symbols: chunk.join(","), range: "1d", interval: "1m" });
      const res = await fetch(`${SPARK}?${qs}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        void recordApiCall("yahoo", "spark", res.status === 429 ? "rateLimited" : "failed");
        continue;
      }
      void recordApiCall("yahoo", "spark", "ok");
      const body = (await res.json()) as Record<
        string,
        { previousClose?: number; close?: (number | null)[]; timestamp?: number[] }
      >;
      for (const sym of chunk) {
        const d = body[sym];
        if (!d?.close?.length) continue;
        // 마지막 **값이 있는** 점 — 끝 점이 null 로 오는 순간이 있다
        let last: number | null = null;
        let lastIdx = -1;
        for (let k = d.close.length - 1; k >= 0; k--) {
          if (d.close[k] != null) {
            last = d.close[k];
            lastIdx = k;
            break;
          }
        }
        if (last == null || last <= 0) continue;
        const prev = Number(d.previousClose);
        const q: FastQuote = {
          price: last,
          changeRate: Number.isFinite(prev) && prev > 0 ? ((last - prev) / prev) * 100 : null,
          at: (d.timestamp?.[lastIdx] ?? 0) * 1000,
        };
        cache.set(sym, { at: Date.now(), q });
        out.set(sym, q);
      }
    } catch {
      /* 한 묶음 실패는 넘어간다 — 본 시세가 있으니 화면이 비지 않는다 */
    }
  }
  return out;
}
