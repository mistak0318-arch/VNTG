import { recordApiCall } from "./apiUsage.js";

/**
 * 야후 심볼의 봉 데이터.
 *
 * 전광판의 지수·원자재는 **숫자 한 줄뿐**이라 "지금 얼마"는 알아도 "어디쯤인가"를 모른다.
 * 나스닥이 -0.12% 라는 건 그 자체로는 아무 뜻이 없고, **최근 한 달을 어떻게 왔는지**를
 * 봐야 판단이 선다. 그래서 눌러서 차트를 연다.
 *
 * 야후 응답을 읽는 방식은 `usKrCorrelation` 과 같다 — 같은 응답을 두 군데서 다르게 읽으면
 * 언젠가 값이 어긋난다. 다만 여기는 상관계수가 아니라 **봉을 그대로** 넘긴다.
 */

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

export interface Candle {
  /** 장중은 `YYYY-MM-DD HH:mm`, 일봉 이상은 `YYYY-MM-DD` */
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface YahooChart {
  symbol: string;
  range: string;
  interval: string;
  candles: Candle[];
  /** 전일 종가 — 「오늘」 차트에서 기준선을 그으려면 있어야 한다 */
  prevClose: number | null;
  error: string | null;
}

/**
 * 기간마다 봉 간격이 다르다.
 *
 * 1년치를 1분봉으로 받으면 십만 개가 넘어 화면이 못 그리고, 하루를 일봉으로 받으면
 * 점 하나가 된다. **야후가 주는 조합에도 제한이 있다** — 1분봉은 최근 며칠까지만 준다.
 */
const RANGES: Record<string, { range: string; interval: string }> = {
  "1d": { range: "1d", interval: "5m" },
  "5d": { range: "5d", interval: "30m" },
  "1mo": { range: "1mo", interval: "1d" },
  "6mo": { range: "6mo", interval: "1d" },
  "1y": { range: "1y", interval: "1d" },
  /*
   * **2y 는 일봉이다.** 5y 는 주봉이라 검증에 못 쓴다 —
   * 국내 일봉과 날짜로 맞출 때 주봉은 거의 다 어긋나서 표본이 통째로 사라진다.
   * (250일 검증을 돌렸더니 표본이 230에서 98로 **줄어서** 발견했다)
   */
  "2y": { range: "2y", interval: "1d" },
  "5y": { range: "5y", interval: "1wk" },
  /* 해외종목 「길게 보기」(2026-08-26) — 상장 이후 전체를 월봉으로 */
  "max": { range: "max", interval: "1mo" },
};

export const CHART_RANGES = Object.keys(RANGES);

/*
 * 짧게 캐싱한다.
 *
 * 차트는 열 때마다 새로 받을 값이 아니다. 게다가 야후는 우리가 이미 시세로도 부르는
 * 곳이라 **같은 창을 여닫는 것만으로 호출이 배로 뛴다.**
 */
const cache = new Map<string, { data: YahooChart; at: number }>();
const TTL_MS = 60_000;

export async function yahooChart(symbol: string, key = "6mo"): Promise<YahooChart> {
  const pick = RANGES[key] ?? RANGES["6mo"];
  const cacheKey = `${symbol}|${key}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const empty: YahooChart = {
    symbol,
    range: pick.range,
    interval: pick.interval,
    candles: [],
    prevClose: null,
    error: null,
  };

  try {
    const url = `${BASE}/${encodeURIComponent(symbol)}?range=${pick.range}&interval=${pick.interval}`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      void recordApiCall("yahoo", symbol, res.status === 429 ? "rateLimited" : "failed");
      return { ...empty, error: `야후 응답 ${res.status}` };
    }
    void recordApiCall("yahoo", symbol, "ok");

    const body = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: { chartPreviousClose?: number; previousClose?: number };
          timestamp?: number[];
          indicators?: {
            quote?: Array<{
              open?: (number | null)[];
              high?: (number | null)[];
              low?: (number | null)[];
              close?: (number | null)[];
              volume?: (number | null)[];
            }>;
          };
        }>;
        error?: { description?: string };
      };
    };

    if (body.chart?.error) return { ...empty, error: body.chart.error.description ?? "야후 오류" };
    const r = body.chart?.result?.[0];
    if (!r) return { ...empty, error: "값이 없습니다" };

    const ts = r.timestamp ?? [];
    const q = r.indicators?.quote?.[0] ?? {};
    const intraday = pick.interval.endsWith("m") || pick.interval.endsWith("h");

    const candles: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const c = q.close?.[i];
      // 종가가 없는 칸은 **건너뛴다.** 0 으로 채우면 차트가 바닥까지 떨어진다
      if (typeof c !== "number" || !Number.isFinite(c)) continue;
      const d = new Date(ts[i] * 1000);
      candles.push({
        // 장중은 한국시간으로 적는다 — 미국 현지 시각으로 적으면 언제인지 감이 안 온다
        t: intraday
          ? new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ")
          : d.toISOString().slice(0, 10),
        // 시가·고가·저가가 비면 종가로 메운다. 봉이 사라지는 것보단 낫다
        open: num(q.open?.[i], c),
        high: num(q.high?.[i], c),
        low: num(q.low?.[i], c),
        close: c,
        volume: num(q.volume?.[i], 0),
      });
    }

    const data: YahooChart = {
      ...empty,
      candles,
      prevClose: r.meta?.chartPreviousClose ?? r.meta?.previousClose ?? null,
      error: candles.length === 0 ? "봉이 하나도 없습니다" : null,
    };
    cache.set(cacheKey, { data, at: Date.now() });
    return data;
  } catch (err) {
    void recordApiCall("yahoo", symbol, "failed");
    return { ...empty, error: err instanceof Error ? err.message : "차트 조회 실패" };
  }
}

function num(v: number | null | undefined, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
