import { recordApiCall } from "./apiUsage.js";

/**
 * 글로벌 시황 (환율·원자재·미국지수·금리·암호화폐).
 * 키움 REST API는 국내 시장 중심이라 이 항목들을 제공하지 않아 Yahoo Finance를 쓴다.
 *
 * v7 quote 엔드포인트는 인증이 걸려 401이 나므로 v8 chart 엔드포인트를 사용한다.
 * (meta에 현재가와 전일종가가 함께 들어있어 등락 계산이 가능)
 */

export interface GlobalQuote {
  key: string;
  label: string;
  group: string;
  symbol: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  /** 금리는 %p 표기라 등락률보다 절대 변화가 의미 있음 */
  isRate: boolean;
  error: string | null;
}

const TARGETS: { key: string; label: string; group: string; symbol: string; isRate?: boolean }[] = [
  { key: "usdkrw", label: "달러/원", group: "환율", symbol: "KRW=X" },
  { key: "wti", label: "WTI유", group: "원자재", symbol: "CL=F" },
  { key: "gold", label: "금", group: "원자재", symbol: "GC=F" },
  { key: "dji", label: "다우 (US30)", group: "미국지수", symbol: "^DJI" },
  { key: "gspc", label: "S&P500 (US500)", group: "미국지수", symbol: "^GSPC" },
  { key: "ixic", label: "나스닥 (Tech100)", group: "미국지수", symbol: "^IXIC" },
  { key: "rut", label: "러셀2000 (US2000)", group: "미국지수", symbol: "^RUT" },
  { key: "vix", label: "S&P500 VIX", group: "변동성", symbol: "^VIX" },
  { key: "tnx", label: "미국 10년물", group: "금리", symbol: "^TNX", isRate: true },
  { key: "tyx", label: "미국 30년물", group: "금리", symbol: "^TYX", isRate: true },
  { key: "btc", label: "비트코인", group: "암호화폐", symbol: "BTC-USD" },
  { key: "n225", label: "닛케이225", group: "아시아", symbol: "^N225" },
  { key: "hsi", label: "항셍", group: "아시아", symbol: "^HSI" },
];

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

let cache: { data: GlobalQuote[]; at: number } | null = null;
const TTL_MS = 60_000; // 외부 API 호출 제한을 고려해 1분 캐싱

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchOne(target: (typeof TARGETS)[number]): Promise<GlobalQuote> {
  const base: GlobalQuote = {
    key: target.key,
    label: target.label,
    group: target.group,
    symbol: target.symbol,
    price: null,
    change: null,
    changeRate: null,
    isRate: target.isRate ?? false,
    error: null,
  };

  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(target.symbol)}?range=1d&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      void recordApiCall("yahoo", target.symbol, res.status === 429 ? "rateLimited" : "failed");
      base.error = `HTTP ${res.status}`;
      return base;
    }
    void recordApiCall("yahoo", target.symbol, "ok");

    const body = (await res.json()) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    };
    const meta = body.chart?.result?.[0]?.meta;
    if (!meta) {
      base.error = "응답 형식 오류";
      return base;
    }

    const price = Number(meta.regularMarketPrice);
    const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
    if (Number.isFinite(price)) base.price = price;
    if (Number.isFinite(price) && Number.isFinite(prev) && prev !== 0) {
      base.change = price - prev;
      base.changeRate = ((price - prev) / prev) * 100;
    }
  } catch (err) {
    base.error = err instanceof Error ? err.message : "조회 실패";
  }
  return base;
}

export async function getGlobalMarket(force = false): Promise<GlobalQuote[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const results: GlobalQuote[] = [];
  // 한 종목이 실패해도 나머지는 정상 표시되도록 개별 처리한다
  for (const t of TARGETS) {
    results.push(await fetchOne(t));
    await sleep(120);
  }

  cache = { data: results, at: Date.now() };
  return results;
}
