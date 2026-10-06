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

/**
 * **같은 묶음을 동시에 두 번 받지 않는다** (2026-10-07 — 서버가 느려지다 죽던 세 번째 원인).
 *
 * 계측기가 잡은 범인이 이 창구였다: `GET /fast +1013MB 4979ms`. 까닭은 둘이었다 —
 *   · 응답이 쓸데없이 컸다. `interval=1m` 은 종목당 **390 포인트**를 받는데, 여기서 쓰는 것은 **마지막 값과
 *     전일 종가 둘뿐**이다. 200종목이면 78,000 포인트를 받아 파싱하고 바로 버렸다. `5m` 이면 같은 답에 1/5 이다.
 *   · 4초 캐시가 **비어 있는 순간** 들어온 요청들이 저마다 야후를 불렀다. 보드 카드와 관심종목 화면이 3~15초마다
 *     부르고 창을 여러 개 띄우면 그만큼 겹친다 — 캐시가 있어도 **동시에 미스**나면 소용이 없다.
 *
 * 묶음(심볼 20개)마다 진행 중인 약속을 공유한다. 열 번 겹쳐 들어와도 야후는 한 번만 부른다.
 */
const inflight = new Map<string, Promise<void>>();

export async function usFastQuotes(symbols: string[]): Promise<Map<string, FastQuote>> {
  const out = new Map<string, FastQuote>();
  const need: string[] = [];
  for (const sym of symbols) {
    const hit = cache.get(sym);
    if (hit && Date.now() - hit.at < TTL) out.set(sym, hit.q);
    else need.push(sym);
  }

  const jobs: Promise<void>[] = [];
  for (let i = 0; i < need.length; i += 20) {
    const chunk = need.slice(i, i + 20);
    const key = chunk.join(",");
    const going = inflight.get(key);
    if (going) {
      jobs.push(going);
      continue;
    }
    const job = fetchChunk(chunk).finally(() => inflight.delete(key));
    inflight.set(key, job);
    jobs.push(job);
  }
  await Promise.all(jobs);
  /* 받아 온 것은 캐시에 들어갔으므로 거기서 꺼낸다 — 겹친 요청도 같은 값을 본다 */
  for (const sym of need) {
    const hit = cache.get(sym);
    if (hit) out.set(sym, hit.q);
  }
  return out;
}

async function fetchChunk(chunk: string[]): Promise<void> {
  {
    try {
      /* 마지막 값과 전일 종가만 쓰므로 1분봉일 이유가 없다 — 5분봉이면 응답이 1/5 (2026-10-07) */
      const qs = new URLSearchParams({ symbols: chunk.join(","), range: "1d", interval: "5m" });
      const res = await fetch(`${SPARK}?${qs}`, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) {
        void recordApiCall("yahoo", "spark", res.status === 429 ? "rateLimited" : "failed");
        return;
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
      }
    } catch {
      /* 한 묶음 실패는 넘어간다 — 본 시세가 있으니 화면이 비지 않는다 */
    }
  }
}

/*
 * **전일 종가 하나만** — 5일 일봉의 앞 봉이 `null` 로 올 때의 대체 (2026-09-24, globalMarket.ts 참조).
 * spark 의 `previousClose` 는 실측으로 네이버와 소수점까지 같았다(^NDX 30732.396 · ^SOX 12689.82).
 * 5분 캐시 — 전일 종가는 하루에 한 번 바뀐다.
 */
const prevCache = new Map<string, { at: number; v: number | null }>();
export async function sparkPrevClose(symbol: string): Promise<number | null> {
  const hit = prevCache.get(symbol);
  if (hit && Date.now() - hit.at < 5 * 60_000) return hit.v;
  let v: number | null = null;
  try {
    const qs = new URLSearchParams({ symbols: symbol, range: "1d", interval: "5m" });
    const res = await fetch(`${SPARK}?${qs}`, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) });
    void recordApiCall("yahoo", "spark", res.ok ? "ok" : res.status === 429 ? "rateLimited" : "failed");
    if (res.ok) {
      const body = (await res.json()) as Record<string, { previousClose?: number }>;
      const p = Number(body[symbol]?.previousClose);
      if (Number.isFinite(p) && p > 0) v = p;
    }
  } catch {
    /* 없으면 없는 대로 — 부르는 쪽이 다음 후보로 간다 */
  }
  prevCache.set(symbol, { at: Date.now(), v });
  return v;
}
