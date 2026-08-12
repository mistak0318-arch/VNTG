import type { KiwoomClient } from "./kiwoomClient.js";

export interface StockEntry {
  code: string;
  name: string;
  marketName: string;
  /** 업종명 (ka10099 upName) — 예: "전기/전자" */
  sectorName: string;
  /** 대형주/중형주/소형주 */
  sizeName: string;
  /** 0:코스피 10:코스닥 */
  marketCode: string;
  /** 상장주식수 (ka10099 listCount) — 시가총액 계산용 */
  shares: number;
}

interface StkInfoListResponse {
  list?: Array<Record<string, unknown>>;
}

let cache: StockEntry[] | null = null;
let cacheAt = 0;
const TTL_MS = 24 * 3600 * 1000;

// 0:코스피, 10:코스닥 (ka10099 mrkt_tp)
const MARKET_CODES = ["0", "10"];

async function fetchMarket(client: KiwoomClient, mrktTp: string): Promise<StockEntry[]> {
  const { data } = await client.request<StkInfoListResponse>("/api/dostk/stkinfo", "ka10099", {
    mrkt_tp: mrktTp,
  });
  const list = Array.isArray(data.list) ? data.list : [];
  return list.map((item) => ({
    code: String(item.code ?? ""),
    name: String(item.name ?? ""),
    marketName: String(item.marketName ?? ""),
    sectorName: String(item.upName ?? ""),
    sizeName: String(item.upSizeName ?? ""),
    marketCode: mrktTp,
    // "0000000730492365" 처럼 0으로 패딩되어 온다
    shares: Number(String(item.listCount ?? "").replace(/^0+/, "")) || 0,
  }));
}

async function ensureCache(client: KiwoomClient): Promise<StockEntry[]> {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) {
    return cache;
  }
  const lists = await Promise.all(MARKET_CODES.map((mrktTp) => fetchMarket(client, mrktTp)));
  const merged = new Map<string, StockEntry>();
  for (const item of lists.flat()) {
    if (item.code) merged.set(item.code, item);
  }
  cache = [...merged.values()];
  cacheAt = now;
  return cache;
}

/**
 * 종목코드 → 상장주식수 맵.
 * 시가총액 = 상장주식수 × 현재가 로 계산할 때 쓴다. ka10099를 하루 캐싱해 두므로
 * 종목별로 ka10001을 부르지 않고도 시총을 낼 수 있다.
 */
export async function getSharesMap(client: KiwoomClient): Promise<Map<string, number>> {
  const list = await ensureCache(client);
  const map = new Map<string, number>();
  for (const item of list) {
    if (item.shares > 0) map.set(item.code.replace(/_(AL|NX)$/, ""), item.shares);
  }
  return map;
}

/** 종목코드로 목록 항목(업종명 포함)을 찾는다. 접미사(_AL/_NX)는 무시 */
export async function findStock(client: KiwoomClient, code: string): Promise<StockEntry | undefined> {
  const bare = code.replace(/_(AL|NX)$/, "");
  const list = await ensureCache(client);
  return list.find((item) => item.code.replace(/_(AL|NX)$/, "") === bare);
}

export async function searchStocks(client: KiwoomClient, query: string): Promise<StockEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const list = await ensureCache(client);
  return list
    .filter((item) => item.code.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
    .slice(0, 20);
}
