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

/**
 * ETF·ETN·리츠·우선주를 뺀 **보통주 코드 집합**.
 *
 * 순위 TR(거래대금상위 등)은 ETF를 걸러 주지 않는다 — ka10032 는 다른 순위 TR이 쓰는
 * stk_cnd=16(ETF+ETN 제외)을 받아도 무시한다(실측). 그래서 여기서 직접 거른다.
 *
 * 판별 근거는 ka10099 의 두 필드다:
 *   - marketName 이 "거래소"/"코스닥" 인 것만 남긴다.
 *     (전체 4,296건 중 ETF 1,163 · ETN 370 · 리츠 23 · 뮤추얼펀드/인프라 3 이 여기서 빠진다)
 *   - 코드 끝자리가 0 이 아니면 우선주다. 거래소·코스닥 범위에서 끝자리≠0 인 446건은
 *     전부 우선주였다(끝자리≠0 인데 우선주가 아닌 8건은 모두 ETN이라 위 조건에서 이미 빠진다).
 *
 * 거래대금 상위에는 KODEX 200·TIGER 200·삼성전자우가 늘 올라오는데, 이들은
 * "정배열 + 수급"만으로 신호등 만점이 나온다. 종목을 찾으려고 만든 화면이 지수 ETF로
 * 채워지면 쓸모가 없다.
 */
export async function getCommonStockCodes(client: KiwoomClient): Promise<Set<string>> {
  const list = await ensureCache(client);
  const set = new Set<string>();
  for (const item of list) {
    if (item.marketName !== "거래소" && item.marketName !== "코스닥") continue;
    const bare = item.code.replace(/_(AL|NX)$/, "");
    if (!bare.endsWith("0")) continue;
    set.add(bare);
  }
  return set;
}

/** 종목코드로 목록 항목(업종명 포함)을 찾는다. 접미사(_AL/_NX)는 무시 */
export async function findStock(client: KiwoomClient, code: string): Promise<StockEntry | undefined> {
  const bare = code.replace(/_(AL|NX)$/, "");
  const list = await ensureCache(client);
  return list.find((item) => item.code.replace(/_(AL|NX)$/, "") === bare);
}

/**
 * 한글 초성 19자. 유니코드 한글 음절은 이 순서로 조합된다.
 * (음절 코드 − 0xAC00) ÷ 588 이 초성 번호다.
 */
const CHOSEONG = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";

/** "삼성전자" → "ㅅㅅㅈㅈ". 한글이 아닌 글자는 그대로 둔다 */
function toChoseong(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.charCodeAt(0);
    if (c >= 0xac00 && c <= 0xd7a3) out += CHOSEONG[Math.floor((c - 0xac00) / 588)];
    else out += ch;
  }
  return out;
}

/**
 * 입력이 **초성만**인가.
 *
 * 초성 검색은 입력이 초성뿐일 때만 켠다. "삼ㅅ" 처럼 섞이면 일반 검색이 맞고,
 * 무엇보다 "ㄱ" 한 글자로 초성 검색을 돌리면 수백 종목이 걸려 쓸모가 없다.
 */
function isChoseongQuery(q: string): boolean {
  return q.length > 0 && [...q].every((ch) => CHOSEONG.includes(ch));
}

export async function searchStocks(client: KiwoomClient, query: string): Promise<StockEntry[]> {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const list = await ensureCache(client);

  /*
   * 초성 검색. "ㅅㅅㅈㅈ" 로 삼성전자를 찾는다.
   *
   * 종목명을 외우고 있어도 **타이핑이 길다** — 「한화에어로스페이스」를 다 치느니
   * ㅎㅎㅇㅇㄹㅅㅍㅇㅅ 가 빠르고, 무엇보다 모바일에서 오타가 안 난다.
   *
   * 앞에서부터 맞는 것을 먼저 올린다. "ㅅㅅㅈㅈ" 면 삼성전자가 삼성에스디에스보다 위다.
   */
  if (isChoseongQuery(q)) {
    const hit = list
      .map((item) => ({ item, cho: toChoseong(item.name) }))
      .filter((x) => x.cho.includes(q));
    hit.sort((a, b) => {
      const ai = a.cho.startsWith(q) ? 0 : 1;
      const bi = b.cho.startsWith(q) ? 0 : 1;
      if (ai !== bi) return ai - bi;
      // 같으면 이름이 짧은 쪽 — 「삼성전자」가 「삼성전자우」보다 위다
      return a.item.name.length - b.item.name.length;
    });
    return hit.slice(0, 20).map((x) => x.item);
  }

  return list
    .filter((item) => item.code.toLowerCase().includes(q) || item.name.toLowerCase().includes(q))
    .slice(0, 20);
}
