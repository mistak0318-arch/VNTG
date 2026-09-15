import { recordApiCall } from "./apiUsage.js";
import { usPopular } from "./naverMarket.js";

/**
 * **시세분석(해외) — 미국 순위판** (2026-09-16).
 *
 * 벤티지: "시세분석 메뉴 있잖아 … 시세분석(해외) 이렇게 해서 해외 쪽도 거래대금·시가총액·실시간 조회 기준
 * 이런 거 만들어서 전광판처럼 … 조사해 보고 만들 수 있으면 만들어 줘. 미국 기준".
 *
 * ## 어디서 받나 — 조사 결과 (2026-09-16 07:3x 실측)
 *
 * **네이버 해외주식 거래소 목록**(`api.stock.naver.com/stock/exchange/{거래소}/{정렬}`). 테마 DB 의 미국 업종을
 * 받던 그 API 다. 정렬 이름을 하나씩 찔러 본 결과:
 *
 *   marketValue 시가총액 · priceTop 거래대금 · top 거래량 · up 상승률 · down 하락률 · dividend 배당
 *   (tradingValue·tradingVolume·newHigh·popular 같은 이름은 400)
 *
 * 줄마다 원값(`…Raw`)이 붙어 있고 `delayTime 0`(실시간)이다. 정규장 밖엔 `overMarketPriceInfo` 에
 * 프리·애프터 가격이 따로 온다. 키가 필요 없고 한 번에 100줄.
 *
 * 한투 해외주식 순위 TR(HHDFS763…)도 있지만 키 조회 몫을 쓰고, 네이버로 다 되니 쓰지 않는다.
 * 국내 시세분석의 「실시간 조회순위」(키움 고객이 들여다보는 종목)는 **미국판이 어디에도 없다** — 대신 거래량 순위.
 *
 * ## 거래소를 합친다
 *
 * 나스닥·뉴욕·아멕스를 각각 받아(상위 100) 한 줄로 합쳐 다시 정렬한다. 상승·하락률은 잡주가 위를 덮어서
 * (+776% 같은 0.5억$ 종목) 거래대금 문턱을 건다 — 기본 $1천만.
 */

const API = "https://api.stock.naver.com/stock/exchange/";
const UA = "Mozilla/5.0";
const EXCHANGES = ["NASDAQ", "NYSE", "AMEX"] as const;
export type UsExchange = (typeof EXCHANGES)[number];
export type UsRankKind = "value" | "volume" | "cap" | "up" | "down" | "popular";

const PATH: Record<Exclude<UsRankKind, "popular">, string> = {
  value: "priceTop",
  volume: "top",
  cap: "marketValue",
  up: "up",
  down: "down",
};

export interface UsRankRow {
  symbol: string;
  /** 네이버 로이터 코드(MU.O) — 상세 링크용 */
  reuters: string;
  name: string;
  nameEng: string;
  exchange: UsExchange;
  /** etf · stock … */
  kind: string;
  price: number | null;
  change: number | null;
  rate: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** 거래대금(달러) */
  value: number | null;
  /** 시가총액(달러) */
  cap: number | null;
  industry: string | null;
  /** 프리·애프터 가격 — 정규장 밖에만. 없으면 null */
  over: { session: "pre" | "after"; price: number | null; rate: number | null } | null;
  /** 마지막 체결 시각(현지 ISO) */
  tradedAt: string | null;
}

export interface UsRankResult {
  kind: UsRankKind;
  at: number;
  /** 네이버가 알려 준 장 상태 — OPEN · CLOSE · PREOPEN … */
  marketStatus: string;
  rows: UsRankRow[];
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
};

function parseRow(s: Record<string, unknown>, ex: UsExchange): UsRankRow | null {
  const symbol = String(s.symbolCode ?? "").trim();
  if (!symbol) return null;
  const ind = s.industryCodeType as { industryGroupKor?: string } | null | undefined;
  const om = s.overMarketPriceInfo as
    | { tradingSessionType?: string; overPrice?: unknown; fluctuationsRatio?: unknown; overMarketStatus?: string }
    | null
    | undefined;
  let over: UsRankRow["over"] = null;
  if (om && om.tradingSessionType && om.overPrice != null) {
    const session = /PRE/i.test(om.tradingSessionType) ? "pre" : /AFTER/i.test(om.tradingSessionType) ? "after" : null;
    if (session) over = { session, price: num(om.overPrice), rate: num(om.fluctuationsRatio) };
  }
  return {
    symbol,
    reuters: String(s.reutersCode ?? symbol),
    name: String(s.stockName ?? symbol).trim(),
    nameEng: String(s.stockNameEng ?? "").trim(),
    exchange: ex,
    kind: String(s.stockEndType ?? "stock"),
    price: num(s.closePriceRaw ?? s.closePrice),
    change: num(s.compareToPreviousClosePriceRaw ?? s.compareToPreviousClosePrice),
    rate: num(s.fluctuationsRatioRaw ?? s.fluctuationsRatio),
    open: num(s.openPriceRaw),
    high: num(s.highPriceRaw),
    low: num(s.lowPriceRaw),
    volume: num(s.accumulatedTradingVolumeRaw),
    value: num(s.accumulatedTradingValueRaw),
    cap: num(s.marketValueRaw),
    industry: ind?.industryGroupKor ?? null,
    over,
    tradedAt: typeof s.localTradedAt === "string" ? s.localTradedAt : null,
  };
}

async function fetchOne(ex: UsExchange, kind: Exclude<UsRankKind, "popular">): Promise<{ rows: UsRankRow[]; status: string }> {
  const url = `${API}${ex}/${PATH[kind]}?page=1&pageSize=100`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    void recordApiCall("naver", "usRank", res.status === 429 ? "rateLimited" : "failed");
    throw new Error(`네이버 ${ex} ${res.status}`);
  }
  void recordApiCall("naver", "usRank", "ok");
  const j = (await res.json()) as { stocks?: Record<string, unknown>[]; marketStatus?: string };
  return {
    rows: (j.stocks ?? []).map((s) => parseRow(s, ex)).filter((r): r is UsRankRow => r !== null),
    status: String(j.marketStatus ?? ""),
  };
}

/** 정렬 기준값 — 합친 뒤 다시 줄 세운다 */
function metric(kind: Exclude<UsRankKind, "popular">, r: UsRankRow): number {
  switch (kind) {
    case "value":
      return r.value ?? -Infinity;
    case "volume":
      return r.volume ?? -Infinity;
    case "cap":
      return r.cap ?? -Infinity;
    case "up":
      return r.rate ?? -Infinity;
    case "down":
      return -(r.rate ?? Infinity);
  }
}

/* 장중 15초 · 장 밖 5분 — 거래소마다 따로 들고 있다 */
const cache = new Map<string, { at: number; rows: UsRankRow[]; status: string }>();
const inflight = new Map<string, Promise<{ rows: UsRankRow[]; status: string }>>();

function fresh(status: string, at: number): boolean {
  const ttl = /OPEN/i.test(status) && !/PREOPEN/i.test(status) ? 15_000 : 5 * 60_000;
  return Date.now() - at < ttl;
}

async function getEx(ex: UsExchange, kind: Exclude<UsRankKind, "popular">): Promise<{ rows: UsRankRow[]; status: string }> {
  const key = `${ex}:${kind}`;
  const c = cache.get(key);
  if (c && fresh(c.status, c.at)) return c;
  const running = inflight.get(key);
  if (running) return running;
  const p = fetchOne(ex, kind)
    .then((r) => {
      cache.set(key, { ...r, at: Date.now() });
      return r;
    })
    .catch((e) => {
      /* 못 받으면 옛 값이라도 — 화면이 통째로 비는 것보다 낫다 */
      if (c) return c;
      throw e;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export async function usRank(opts: {
  kind: UsRankKind;
  ex?: UsExchange | "all";
  /** 거래대금 문턱(달러) — 상승·하락률에서 잡주를 거른다 */
  minValue?: number;
  limit?: number;
}): Promise<UsRankResult> {
  /*
   * 「인기」 — 네이버 사용자가 많이 본 미국 종목 (2026-09-16, naverMarket.usPopular). 국내판 「실시간 조회순위」에
   * 가장 가까운 것이다. 거래소를 따로 안 주는 목록이라 거래소 거르기만 한다.
   */
  if (opts.kind === "popular") {
    const p = await usPopular(60);
    const rows: UsRankRow[] = p.rows
      .filter((r) => !opts.ex || opts.ex === "all" || r.exchange === opts.ex)
      .map((r) => ({
        symbol: r.symbol,
        reuters: r.reuters,
        name: r.name,
        nameEng: "",
        exchange: (r.exchange as UsExchange) ?? "NASDAQ",
        kind: r.kind,
        price: r.price,
        change: r.change,
        rate: r.rate,
        open: null,
        high: null,
        low: null,
        volume: r.volume,
        value: r.value,
        cap: r.cap,
        industry: r.industry,
        over: r.over,
        tradedAt: null,
      }))
      .slice(0, Math.min(Math.max(opts.limit ?? 50, 10), 100));
    const st = await getEx("NASDAQ", "value").catch(() => ({ rows: [], status: "" }));
    return { kind: "popular", at: p.at, marketStatus: st.status, rows };
  }
  const kind = opts.kind;
  const exs = !opts.ex || opts.ex === "all" ? [...EXCHANGES] : [opts.ex];
  const got = await Promise.all(exs.map((ex) => getEx(ex, kind).catch(() => ({ rows: [], status: "" }))));
  const minValue = opts.minValue ?? 0;
  const rows = got
    .flatMap((g) => g.rows)
    .filter((r) => minValue <= 0 || (r.value ?? 0) >= minValue)
    .sort((a, b) => metric(kind, b) - metric(kind, a))
    .slice(0, Math.min(Math.max(opts.limit ?? 50, 10), 100));
  return {
    kind,
    at: Date.now(),
    marketStatus: got.find((g) => g.status)?.status ?? "",
    rows,
  };
}
