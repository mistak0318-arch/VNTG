import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";
import { hantooUsDayQuotes, hantooUsQuotes } from "./usQuotesHantoo.js";

/**
 * 미국 관심종목.
 *
 * 국내 테마는 키움이 시세를 주지만 미국은 안 준다. 그런데 **밤사이 미국이 오늘 국내를
 * 정한다** — 이미 미국↔국내 테마 연동에서 확인한 것이고, 그래서 미국 쪽도 내가 짠
 * 그룹으로 들고 있어야 한다.
 *
 * 시세는 Yahoo Finance 차트 API 를 쓴다(globalMarket 과 같은 경로). 종목 검색도 Yahoo 가
 * 열려 있어서, **티커를 외우지 않고 이름으로 찾아 담을 수 있다.**
 *
 * 그룹·종목은 전부 사용자가 편집한다. 처음 쓸 때만 비어 있지 않도록 씨앗을 넣어 두되,
 * 지우고 새로 짜는 걸 막지 않는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "usWatchlist.json");

const SEARCH = "https://query1.finance.yahoo.com/v1/finance/search";
const CHART = "https://query1.finance.yahoo.com/v8/finance/chart";

export interface UsStock {
  symbol: string;
  /** 화면에 쓸 이름. 사용자가 한글로 바꿔 적을 수 있다 */
  name: string;
  /** 담은 시점 가격 — 그때 대비 얼마나 움직였나 */
  addedPrice: number | null;
  addedAt: string;
  memo: string;
}

export interface UsGroup {
  id: string;
  name: string;
  memo: string;
  stocks: UsStock[];
}

async function readAll(): Promise<UsGroup[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf-8")) as UsGroup[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: UsGroup[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(rows, null, 2), "utf-8");
}

export async function listGroups(): Promise<UsGroup[]> {
  return readAll();
}

// ---------------------------------------------------------------- 편집

function newId(): string {
  return `ug_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

export async function addGroup(name: string, memo = ""): Promise<UsGroup[]> {
  const rows = await readAll();
  rows.push({ id: newId(), name: name.slice(0, 60), memo: memo.slice(0, 200), stocks: [] });
  await writeAll(rows);
  return rows;
}

export async function updateGroup(id: string, patch: { name?: string; memo?: string }): Promise<UsGroup[]> {
  const rows = await readAll();
  const g = rows.find((x) => x.id === id);
  if (g) {
    if (patch.name !== undefined) g.name = patch.name.slice(0, 60);
    if (patch.memo !== undefined) g.memo = patch.memo.slice(0, 200);
  }
  await writeAll(rows);
  return rows;
}

export async function removeGroup(id: string): Promise<UsGroup[]> {
  const rows = (await readAll()).filter((x) => x.id !== id);
  await writeAll(rows);
  return rows;
}

/** 그룹 순서 바꾸기 — 자주 보는 걸 위로 */
export async function reorderGroups(ids: string[]): Promise<UsGroup[]> {
  const rows = await readAll();
  const rank = new Map(ids.map((id, i) => [id, i]));
  rows.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
  await writeAll(rows);
  return rows;
}

/**
 * 그룹 안 종목 순서 바꾸기.
 *
 * 화면이 등락률로 자동 정렬하던 걸 걷어 냈다 — **매 갱신마다 줄이 뒤바뀌어서** 방금 보던
 * 종목이 어디로 갔는지 알 수 없었다. 이제 여기 적힌 순서가 화면 순서다.
 */
export async function reorderStocks(groupId: string, symbols: string[]): Promise<UsGroup[]> {
  const rows = await readAll();
  const g = rows.find((x) => x.id === groupId);
  if (g) {
    const rank = new Map(symbols.map((sym, i) => [sym, i]));
    // 목록에 없는 종목은 뒤로 밀되 서로의 순서는 지킨다
    g.stocks.sort((a, b) => (rank.get(a.symbol) ?? 999) - (rank.get(b.symbol) ?? 999));
  }
  await writeAll(rows);
  return rows;
}

export async function addStock(
  groupId: string,
  s: { symbol: string; name: string; addedPrice?: number | null; memo?: string },
): Promise<UsGroup[]> {
  const rows = await readAll();
  const g = rows.find((x) => x.id === groupId);
  const symbol = s.symbol.trim().toUpperCase();
  if (g && symbol && !g.stocks.some((x) => x.symbol === symbol)) {
    g.stocks.push({
      symbol,
      name: (s.name || symbol).slice(0, 60),
      addedPrice: s.addedPrice ?? null,
      addedAt: new Date().toISOString(),
      memo: (s.memo ?? "").slice(0, 200),
    });
  }
  await writeAll(rows);
  return rows;
}

export async function updateStock(
  groupId: string,
  symbol: string,
  patch: { name?: string; memo?: string; addedPrice?: number | null },
): Promise<UsGroup[]> {
  const rows = await readAll();
  const st = rows.find((x) => x.id === groupId)?.stocks.find((x) => x.symbol === symbol);
  if (st) {
    if (patch.name !== undefined) st.name = patch.name.slice(0, 60);
    if (patch.memo !== undefined) st.memo = patch.memo.slice(0, 200);
    if (patch.addedPrice !== undefined) st.addedPrice = patch.addedPrice;
  }
  await writeAll(rows);
  return rows;
}

export async function removeStock(groupId: string, symbol: string): Promise<UsGroup[]> {
  const rows = await readAll();
  const g = rows.find((x) => x.id === groupId);
  if (g) g.stocks = g.stocks.filter((x) => x.symbol !== symbol);
  await writeAll(rows);
  return rows;
}

// ---------------------------------------------------------------- 검색·시세

export interface UsSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  /** 국가 (USA/JPN/HKG/CHN…) — 네이버 검색이 준다. 야후 결과는 빈 값 */
  nation?: string;
}

/**
 * 이름으로 종목 찾기.
 *
 * 티커를 외우고 있는 사람은 없다. "로켓랩"을 치면 RKLB 가 나와야 담을 수 있다.
 * 다만 Yahoo 는 같은 회사의 **해외 상장분**(프랑크푸르트·부에노스아이레스 등)까지
 * 섞어 주므로, 미국 거래소 것만 남긴다 — 우리가 보려는 건 미국 시장 시세다.
 */
/*
 * 검색에 걸러 낼 거래소.
 *
 * 처음엔 미국만 뒀는데 **유럽 방산·일본 반도체를 같이 보고 싶다**는 요구가 나왔다.
 * 한투는 미국·일본·홍콩·중국·베트남만 주고 **유럽이 없다** — 유럽은 야후로 받는다.
 * 그래서 검색은 넓게 열고, 시세는 한투가 아는 것만 한투로 간다.
 */
const OK_EXCHANGES = new Set([
  // 미국
  "NMS", "NYQ", "NGM", "NCM", "PCX", "ASE", "BTS", "NYS",
  // 유럽 — 독일(라인메탈)·영국(BAE)·프랑스(탈레스)·이탈리아(레오나르도)·스웨덴(사브)
  "GER", "FRA", "LSE", "PAR", "MIL", "STO", "AMS", "SWX", "EBS", "CPH", "OSL", "MCE",
  // 아시아
  "JPX", "TYO", "HKG", "SHH", "SHZ", "TAI", "KSC", "KOE",
]);

/**
 * 네이버 자동완성 — **한국어 검색**이 여기서 나온다 (2026-08-27).
 *
 * "테슬라"를 야후에 치면 아무것도 안 나온다 — 한글 회사명을 야후가 모른다.
 * 네이버 front-api 자동완성은 한글 이름으로 미국·일본·홍콩·중국 종목을 찾아 주고
 * 인증도 필요 없다. 실측(2026-08-27):
 *   GET m.stock.naver.com/front-api/search/autoComplete?query=…&target=stock
 *   → items[{code, name(한글), typeCode(NASDAQ/TOKYO/HONG_KONG/SHANGHAI…),
 *            reutersCode(TSLA.O·7203.T·0700.HK·600519.SS), nationCode(USA/JPN/HKG/CHN/KOR), isEtf}]
 *
 * **야후 심볼 매핑도 실측으로 확정**: 미국은 code 가 이미 야후 심볼(TSLA·TM·NVDA)이고,
 * 일본(.T)·홍콩(.HK)·상해(.SS)·심천(.SZ)은 reutersCode 가 야후와 같은 접미를 쓴다.
 * 국내(KOR)는 뺀다 — 이 메뉴는 해외다.
 */
async function searchNaver(q: string): Promise<UsSearchResult[]> {
  try {
    const res = await fetch(
      `https://m.stock.naver.com/front-api/search/autoComplete?query=${encodeURIComponent(q)}&target=stock`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) },
    );
    void recordApiCall("naver", "usSearch", res.ok ? "ok" : "failed");
    if (!res.ok) return [];
    const j = (await res.json()) as {
      result?: {
        items?: {
          code?: string;
          name?: string;
          typeCode?: string;
          reutersCode?: string;
          nationCode?: string;
          isEtf?: boolean;
        }[];
      };
    };
    return (j.result?.items ?? [])
      .filter((x) => x.code && x.nationCode && x.nationCode !== "KOR")
      .map((x) => ({
        symbol: x.nationCode === "USA" ? String(x.code) : String(x.reutersCode ?? x.code),
        name: String(x.name ?? x.code),
        exchange: String(x.typeCode ?? ""),
        type: x.isEtf ? "ETF" : "EQUITY",
        nation: String(x.nationCode),
      }))
      .slice(0, 8);
  } catch {
    void recordApiCall("naver", "usSearch", "failed");
    return [];
  }
}

async function searchYahoo(q: string): Promise<UsSearchResult[]> {
  try {
    const res = await fetch(
      `${SEARCH}?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0`,
      { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(6000) },
    );
    void recordApiCall("yahoo", "search", res.ok ? "ok" : "failed");
    const j = (await res.json()) as {
      quotes?: { symbol?: string; shortname?: string; longname?: string; exchange?: string; quoteType?: string }[];
    };
    return (j.quotes ?? [])
      .filter((x) => x.symbol && OK_EXCHANGES.has(String(x.exchange)))
      .map((x) => ({
        symbol: String(x.symbol),
        name: String(x.shortname ?? x.longname ?? x.symbol),
        exchange: String(x.exchange),
        type: String(x.quoteType ?? ""),
      }))
      .slice(0, 10);
  } catch {
    void recordApiCall("yahoo", "search", "failed");
    return [];
  }
}

export async function searchUs(query: string): Promise<UsSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  /*
   * 둘 다 물어서 합친다 — 네이버(한글 이름·아시아)가 앞, 야후(영문·유럽)가 뒤.
   * 같은 심볼이 양쪽에서 오면 네이버 것(한글 이름)을 남긴다 — 담을 때 그 이름이
   * 그대로 표시 이름이 된다.
   */
  const [naver, yahoo] = await Promise.all([searchNaver(q), searchYahoo(q)]);
  const seen = new Set<string>();
  const out: UsSearchResult[] = [];
  for (const r of [...naver, ...yahoo]) {
    if (seen.has(r.symbol)) continue;
    seen.add(r.symbol);
    out.push(r);
  }
  return out.slice(0, 12);
}

export interface UsQuoteRow {
  symbol: string;
  name: string;
  price: number | null;
  changeRate: number | null;
  /** 담은 가격 대비 */
  returnRate: number | null;
  addedPrice: number | null;
  memo: string;
  /** 정규장 전/중/후 — Yahoo 가 알려주는 시장 상태 */
  marketState: string | null;
  /** Yahoo 가 알려준 체결 시각(ms) */
  quotedAt: number | null;
  error: string | null;
  // ---- 아래는 한국투자증권만 주는 값이다 (야후엔 없다) ----
  /** 원화 환산가 */
  wonPrice: number | null;
  /** 오늘 거래량 ÷ 전일 거래량 × 100 */
  volumeVsPrev: number | null;
  /** 52주 구간에서 지금 위치 (0=저가, 100=고가) */
  pos52: number | null;
  high52: number | null;
  low52: number | null;
  /** 체결강도 — 100 보다 크면 사는 쪽이 세다 */
  power: number | null;
  /** 시가·고가·저가 */
  open: number | null;
  high: number | null;
  low: number | null;
  /** 한투가 알려준 장 상태 ("장중(실시간)" 등) */
  state: string | null;
  /*
   * 미국 주간거래(오버나이트).
   *
   * **프리마켓이 아니다.** 미 동부 프리마켓(04:00~09:30 ET)은 한국 밤이라 우리가 볼 때는
   * 이미 끝나 있다. 이건 **한국 낮에 열리는 세션**이고, 국내장이 돌아가는 동안 움직이는
   * 미국 가격은 이것뿐이다 — 그래서 "지금 미국이 어디로 가나"를 보려면 이걸 봐야 한다.
   * 미국 종목만 있다(일본·홍콩·유럽은 이런 세션이 없다).
   */
  /**
   * 애프터장(미 동부 16:00~20:00) 체결가.
   *
   * 한투가 정규장 마감 뒤에도 갱신해 주는 그 값이다. 예전엔 이걸 **주 등락률 자리**에
   * 그냥 써서, 화면 숫자가 그날의 정규장 등락률이 아니었다. 이제 자리를 옮겨
   * 괄호에 따로 보여 준다 — 괄호는 **지금 도는 다른 세션**을 뜻한다.
   */
  afterPrice: number | null;
  afterChangeRate: number | null;
  dayPrice: number | null;
  dayChangeRate: number | null;
  /** 주간거래 거래량. 0이면 아직 아무도 안 샀다는 뜻이라 값을 믿으면 안 된다 */
  dayVolume: number | null;
  /** 통화 — 나라가 섞이면 78.89 가 달러인지 엔인지 알 수 없다 */
  currency: string | null;
  country: string | null;
  flag: string | null;
  /** 어디서 받은 값인가 */
  source: "hantoo" | "yahoo";
}

/**
 * 시세를 한 번에 받아 온다.
 *
 * 종목마다 따로 부르면 40종목에 40회다. Yahoo 차트 API 는 종목당 한 번이지만,
 * **동시에 6개씩** 묶어 돌려서 전체 대기 시간을 줄인다. 하나 실패해도 나머지는 나온다 —
 * 미국 시세는 없는 종목·상장폐지가 섞이기 쉬워서 전부 아니면 무로 두면 화면이 자주 빈다.
 */
interface Quote {
  price: number | null;
  changeRate: number | null;
  state: string | null;
  /** Yahoo 가 알려주는 **체결 시각**(ms). "이 값이 언제 것인가"의 답 */
  quotedAt: number | null;
  error: string | null;
}

async function quoteOne(symbol: string): Promise<Quote> {
  try {
    const res = await fetch(`${CHART}/${encodeURIComponent(symbol)}?range=1d&interval=1d`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });
    void recordApiCall("yahoo", "chart", res.ok ? "ok" : "failed");
    const j = (await res.json()) as {
      chart?: {
        result?: {
          meta?: {
            regularMarketPrice?: number;
            chartPreviousClose?: number;
            previousClose?: number;
            marketState?: string;
            regularMarketTime?: number;
          };
        }[];
      };
    };
    const m = j.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice) {
      return { price: null, changeRate: null, state: null, quotedAt: null, error: "시세 없음" };
    }
    const prev = m.chartPreviousClose ?? m.previousClose ?? null;
    return {
      price: m.regularMarketPrice,
      changeRate: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : null,
      // marketState 는 안 올 때가 많다. 없으면 없는 대로 두고 시각으로 판단하게 한다
      state: m.marketState ?? null,
      quotedAt: m.regularMarketTime ? m.regularMarketTime * 1000 : null,
      error: null,
    };
  } catch {
    void recordApiCall("yahoo", "chart", "failed");
    return { price: null, changeRate: null, state: null, quotedAt: null, error: "조회 실패" };
  }
}

const cache = new Map<string, { at: number; data: Quote }>();
const TTL_MS = 60_000;

/**
 * 미국 정규장이 열려 있나 (평일 09:30~16:00 ET).
 * 서머타임은 직접 세지 않는다 — 시간대 데이터가 대신 계산해 준다.
 */
function usRegularOpen(now = new Date()): boolean {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(parts.weekday));
  if (day === 0 || day === 6) return false;
  const mins = (Number(parts.hour) % 24) * 60 + Number(parts.minute);
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/*
 * 정규장 종가 캐시.
 *
 * **장이 닫힌 뒤엔 이 값이 안 변한다.** 그런데 일반 시세 캐시(60초)를 쓰면 111종목을
 * 1분마다 다시 받게 된다. 따로 두고 길게 잡는다.
 */
const closeCache = new Map<string, { at: number; price: number; rate: number | null }>();
const CLOSE_TTL_MS = 15 * 60_000;

/**
 * 마지막 **정규장 종가**를 야후에서 받는다.
 *
 * ## 왜 필요한가 (2026-08-20 실측)
 *
 * 한투는 정규장이 끝난 뒤에도 `last` 를 **애프터장 체결가**로 계속 갱신한다.
 * 그 값을 전일 종가와 견주면 화면에 뜨는 등락률이 **그날의 정규장 등락률이 아니다.**
 *
 *   NVDA  전일 219.74 · 정규장 종가 217.56 · 한투 218.70
 *         정규장 등락 −0.99% 인데 화면엔 −0.47% 로 떴다
 *   AMZN  정규장 +2.46% 인데 화면엔 +2.98%
 *
 * 야후 `regularMarketPrice` 는 이름 그대로 정규장 값이라 여기서만 쓴다.
 * **장 중에는 부르지 않는다** — 그때는 한투 값이 곧 정규장 값이다.
 */
async function regularCloses(symbols: string[]): Promise<Map<string, { price: number; rate: number | null }>> {
  const out = new Map<string, { price: number; rate: number | null }>();
  const need: string[] = [];
  for (const sym of symbols) {
    const hit = closeCache.get(sym);
    if (hit && Date.now() - hit.at < CLOSE_TTL_MS) out.set(sym, { price: hit.price, rate: hit.rate });
    else need.push(sym);
  }
  for (let i = 0; i < need.length; i += 6) {
    const chunk = need.slice(i, i + 6);
    await Promise.all(
      chunk.map(async (sym) => {
        const q = await quoteOne(sym).catch(() => null);
        if (!q || q.price === null) return;
        closeCache.set(sym, { at: Date.now(), price: q.price, rate: q.changeRate });
        out.set(sym, { price: q.price, rate: q.changeRate });
      }),
    );
  }
  return out;
}

export interface UsWatchResult {
  groups: {
    id: string;
    name: string;
    memo: string;
    changeRate: number | null;
    rising: number;
    falling: number;
    stocks: UsQuoteRow[];
  }[];
  /**
   * 이 화면 전체의 기준.
   *
   * "실시간인가"에 답하려면 두 시각이 다 있어야 한다 —
   *   quotedAt  = 거래소에서 마지막으로 체결된 시각 (Yahoo 가 알려준 것)
   *   fetchedAt = 우리가 그걸 받아온 시각
   * 둘이 벌어져 있으면 장이 닫혔거나 지연된 것이다.
   */
  quotedAt: number | null;
  fetchedAt: number;
}

/** 한투가 준 값 중 화면에 쓸 것만 골라 담는다 */
function toExtra(h: {
  wonPrice: number | null;
  volume: number | null;
  prevVolume: number | null;
  pos52: number | null;
  high52: number | null;
  low52: number | null;
  power: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  state: string | null;
  currency: string | null;
  country: string | null;
  flag: string | null;
}) {
  return {
    wonPrice: h.wonPrice,
    // 오늘이 평소보다 붐비는지. 100이면 어제와 같다
    volumeVsPrev:
      h.volume !== null && h.prevVolume !== null && h.prevVolume > 0
        ? (h.volume / h.prevVolume) * 100
        : null,
    pos52: h.pos52,
    high52: h.high52,
    low52: h.low52,
    power: h.power,
    open: h.open,
    high: h.high,
    low: h.low,
    state: h.state,
    currency: h.currency,
    country: h.country,
    flag: h.flag,
    source: "hantoo" as const,
  };
}

const EMPTY_EXTRA = {
  wonPrice: null,
  volumeVsPrev: null,
  pos52: null,
  high52: null,
  low52: null,
  power: null,
  open: null,
  high: null,
  low: null,
  state: null,
  currency: null,
  country: null,
  flag: null,
  source: "yahoo" as const,
};

async function buildGroups(force: boolean): Promise<UsWatchResult> {
  const groups = await readAll();
  const symbols = [...new Set(groups.flatMap((g) => g.stocks.map((s) => s.symbol)))];

  /*
   * **한투를 먼저 쓰고, 안 되는 것만 야후로 메운다.**
   *
   * 한투는 한 번에 10종목이라 40종목이 4번이면 끝난다(야후는 40번이었다). 게다가
   * 원화환산가·52주·체결강도처럼 야후가 안 주던 값이 같이 온다.
   *
   * 그래도 야후를 지우진 않는다 — 한투에 없는 티커(신규 상장, ADR 일부)가 있고,
   * 키가 안 꽂힌 상태에서도 화면이 살아 있어야 한다.
   */
  const hantoo = await hantooUsQuotes(symbols).catch(() => new Map());
  const extra = new Map<string, ReturnType<typeof toExtra>>();
  const quotes = new Map<string, Awaited<ReturnType<typeof quoteOne>>>();

  /*
   * 미국 주간거래(오버나이트)를 같이 받는다.
   *
   * 정규장 조회 **뒤에** 부른다 — 티커가 어느 거래소 것인지 그때 채워지고,
   * 주간거래 거래소(BAQ·BAY·BAA)는 그 지도를 보고 정한다.
   * 실패해도 그냥 비워 둔다. 있으면 좋은 값이지 없으면 안 되는 값이 아니다.
   */
  const dayQuotes = await hantooUsDayQuotes(symbols).catch(() => new Map());

  /*
   * 정규장이 닫혀 있으면 **정규장 종가를 따로 받는다.**
   * 한투 `last` 는 그 시간엔 애프터장 체결가라 「오늘 등락률」 자리에 쓸 수 없다.
   */
  const closed = !usRegularOpen();
  const closes = closed ? await regularCloses(symbols).catch(() => new Map()) : new Map();

  const after = new Map<string, { price: number; rate: number | null }>();
  const missing: string[] = [];
  for (const sym of symbols) {
    const h = hantoo.get(sym);
    if (h && h.price !== null) {
      const rc = closes.get(sym);
      if (rc) {
        /*
         * 한투가 준 값은 정규장이 아니라 시간외다 — 자리를 옮겨 따로 보여 준다.
         *
         * ⚠️ 등락률은 **정규장 종가 대비로 다시 센다** (2026-08-26 — 「애프터에서
         * 얼마 빠졌는지가 핵심인데 정규장이랑 합친 값이 보인다」).
         * 한투 h.changeRate 는 **전일 종가 대비**라 정규장 등락과 애프터 등락이
         * 섞인 값이다. 괄호는 「이 세션에서 얼마 움직였나」를 말해야 하므로
         * 기준을 정규장 종가(rc.price)로 바꾼다. 프리장일 때도 rc 는 직전 정규장
         * 종가라 같은 식이 맞다.
         */
        if (Math.abs(h.price - rc.price) > 1e-9) {
          after.set(sym, {
            price: h.price,
            rate: rc.price > 0 ? (h.price / rc.price - 1) * 100 : null,
          });
        }
        quotes.set(sym, {
          price: rc.price,
          changeRate: rc.rate,
          state: h.state,
          quotedAt: null,
          error: null,
        });
      } else {
        quotes.set(sym, {
          price: h.price,
          changeRate: h.changeRate,
          state: h.state,
          quotedAt: null,
          error: null,
        });
      }
      extra.set(sym, toExtra(h));
    } else {
      missing.push(sym);
    }
  }

  for (let i = 0; i < missing.length; i += 6) {
    const chunk = missing.slice(i, i + 6);
    const got = await Promise.all(
      chunk.map(async (sym) => {
        const hit = cache.get(sym);
        if (!force && hit && Date.now() - hit.at < TTL_MS) return [sym, hit.data] as const;
        const q = await quoteOne(sym);
        cache.set(sym, { at: Date.now(), data: q });
        return [sym, q] as const;
      }),
    );
    for (const [sym, q] of got) quotes.set(sym, q);
  }

  const evaluated = groups.map((g) => {
    const stocks: UsQuoteRow[] = g.stocks.map((s) => {
      const q = quotes.get(s.symbol);
      return {
        symbol: s.symbol,
        name: s.name,
        price: q?.price ?? null,
        changeRate: q?.changeRate ?? null,
        returnRate:
          s.addedPrice && q?.price ? ((q.price - s.addedPrice) / s.addedPrice) * 100 : null,
        addedPrice: s.addedPrice,
        memo: s.memo,
        marketState: q?.state ?? null,
        quotedAt: q?.quotedAt ?? null,
        error: q?.error ?? null,
        ...(extra.get(s.symbol) ?? EMPTY_EXTRA),
        afterPrice: after.get(s.symbol)?.price ?? null,
        afterChangeRate: after.get(s.symbol)?.rate ?? null,
        dayPrice: dayQuotes.get(s.symbol)?.price ?? null,
        dayChangeRate: dayQuotes.get(s.symbol)?.changeRate ?? null,
        dayVolume: dayQuotes.get(s.symbol)?.volume ?? null,
      };
    });
    const rates = stocks.map((s) => s.changeRate).filter((x): x is number => x !== null);
    return {
      id: g.id,
      name: g.name,
      memo: g.memo,
      // 그룹 등락률은 단순평균 — 미국은 시총을 안 받아오므로 가중을 못 준다
      changeRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      rising: rates.filter((r) => r > 0).length,
      falling: rates.filter((r) => r < 0).length,
      stocks,
    };
  });

  // 가장 최근 체결 시각을 화면 전체의 기준으로 삼는다
  const times = [...quotes.values()].map((q) => q.quotedAt).filter((x): x is number => x !== null);
  return {
    groups: evaluated,
    quotedAt: times.length > 0 ? Math.max(...times) : null,
    fetchedAt: Date.now(),
  };
}

/*
 * ─────────────────────────────────────────────────────────────────────────
 * 캐시 — 이게 없어서 화면이 17초·71초·37초씩 걸렸다.
 *
 * 원인이 둘 겹쳤다.
 *
 *   1) **캐시가 아예 없었다.** 메뉴에 들어갈 때마다 163종목을 처음부터 다 받았다.
 *      한투는 초당 2.5건이라 10종목씩 14묶음이면 그것만 6초, 야후 32종목이 더 붙는다.
 *   2) **그게 겹쳐서 쌓였다.** 5초마다 자동 갱신이 도는데 한 바퀴가 6초 넘게 걸리니,
 *      끝나기 전에 다음 것이 또 들어와 유량 대기줄에 줄줄이 밀렸다. 두 번째 요청이
 *      71초가 된 이유다 — 앞의 것들이 다 빠질 때까지 기다린 것이다.
 *
 * 그래서 관심종목 표(watchTracking)와 같은 방식으로 바꾼다.
 *
 *   · **낡은 값이라도 먼저 준다** — 화면은 기다리지 않는다
 *   · **한 번에 한 바퀴만 돈다** — 이미 돌고 있으면 새로 시작하지 않는다
 *   · **디스크에 남긴다** — 서버를 재시작해도 처음부터 다시 받지 않는다
 */

const CACHE_FILE = join(DATA_DIR, "usWatchCache.json");
/*
 * 이보다 오래되면 뒤에서 새로 받는다.
 *
 * 163종목이면 한 바퀴가 6~8초다(한투 초당 2.5건이 한계). 그보다 짧게 잡아 봐야
 * 한 번에 한 바퀴만 도니 의미가 없고, 길게 잡으면 장중에 값이 늙는다. 딱 그 언저리로 둔다.
 */
const FRESH_MS = 8_000;

/**
 * 캐시에 **원본 파일의 수정시각**을 같이 적어 둔다.
 *
 * 처음엔 화면에서 종목을 담고 뺄 때만 캐시를 버렸는데, 그게 모자랐다 —
 * **파일이 밖에서 바뀌는 경우**를 빠뜨렸다. 미니PC 에 새 목록을 파일로 깔았더니
 * 디스크에 남은 옛 캐시가 계속 나왔고, 서버를 재시작해도 그대로였다(디스크에 남으니까).
 *
 * 이제 파일의 mtime 이 캐시가 만들어질 때와 다르면 낡은 것으로 본다.
 */
let shot: { at: number; mtime: number; data: UsWatchResult } | null = null;

async function watchlistMtime(): Promise<number> {
  try {
    return (await stat(FILE)).mtimeMs;
  } catch {
    return 0;
  }
}
let building: Promise<UsWatchResult> | null = null;

async function loadCache(): Promise<void> {
  if (shot) return;
  try {
    const raw = JSON.parse(await readFile(CACHE_FILE, "utf-8")) as {
      at: number;
      mtime: number;
      data: UsWatchResult;
    };
    if (raw?.data?.groups) shot = raw;
  } catch {
    /* 없으면 처음부터 받는다 */
  }
}

function rebuild(force: boolean): Promise<UsWatchResult> {
  if (building) return building;
  building = buildGroups(force)
    .then(async (data) => {
      shot = { at: Date.now(), mtime: await watchlistMtime(), data };
      await mkdir(DATA_DIR, { recursive: true }).catch(() => undefined);
      await writeFile(CACHE_FILE, JSON.stringify(shot), "utf-8").catch(() => undefined);
      return data;
    })
    .finally(() => {
      building = null;
    });
  return building;
}

export async function evaluateGroups(force = false): Promise<UsWatchResult> {
  await loadCache();

  // 새로고침 버튼을 누른 건 기다려 줘야 한다 — 사용자가 방금 시킨 일이다
  if (force) return rebuild(true);

  if (shot) {
    // 파일이 밖에서 바뀌었으면 캐시를 믿을 수 없다 — 기다려서라도 새로 받는다
    if ((await watchlistMtime()) !== shot.mtime) return rebuild(false);
    // 낡았으면 뒤에서 새로 받되, **기다리지 않고** 지금 있는 걸 준다
    if (Date.now() - shot.at > FRESH_MS) void rebuild(false).catch(() => undefined);
    return shot.data;
  }
  // 처음 한 번은 어쩔 수 없이 기다린다
  return rebuild(false);
}

/**
 * 종목을 넣거나 뺀 뒤에는 캐시를 버려야 한다 —
 * 안 그러면 방금 담은 종목이 20초 동안 화면에 안 뜬다.
 */
export function invalidateUsCache(): void {
  shot = null;
}

/**
 * 순서만 바꿨을 때 — **시세를 다시 받지 않는다.**
 *
 * 예전엔 순서 변경도 캐시를 버렸다. 그러면 164종목 시세를 처음부터 다시 받느라
 * **▲ 한 번 누를 때마다 6~8초**를 기다려야 했다. 그런데 순서를 바꾼다고 가격이
 * 변하지는 않는다 — 손에 있는 값을 그대로 두고 **줄 순서만** 고쳐 주면 된다.
 *
 * 캐시가 없으면 아무것도 안 한다. 다음 조회가 어차피 새로 받는다.
 */
export async function reorderCachedGroup(groupId: string, symbols: string[]): Promise<void> {
  if (!shot) return;
  const g = shot.data.groups.find((x) => x.id === groupId);
  if (!g) return;
  const rank = new Map(symbols.map((sym, i) => [sym, i]));
  g.stocks = [...g.stocks].sort(
    (a, b) => (rank.get(a.symbol) ?? 999) - (rank.get(b.symbol) ?? 999),
  );

  /*
   * **파일 수정시각을 캐시에 다시 새긴다.**
   *
   * 이게 없으면 순서 변경이 여전히 느리다. 순서를 바꾸면 `usWatchlist.json` 을 쓰는데,
   * 「파일이 밖에서 바뀌면 캐시를 버린다」는 규칙이 그걸 **외부 변경으로 오해**해
   * 164종목을 다시 받는다 — 실측 18초였다.
   *
   * 방금 바꾼 건 우리 자신이고 그 결과를 이미 캐시에 반영했으므로, 새 mtime 을
   * 인정해 주면 된다. (그 규칙은 미니PC 에 새 목록을 파일로 깔았을 때를 위한 것이다)
   */
  shot.mtime = await watchlistMtime();
}

/**
 * 그룹·종목 **구성**만 바뀌었을 때의 캐시 수술 (2026-08-27 — "그룹 추가·삭제가
 * 왜 이렇게 딜레이?"). 이 라우트들이 캐시를 통째로 버리고 evaluateGroups 를
 * 기다렸다 — 그룹 하나 만드는데 **전 종목 시세 한 바퀴(6~8초)**를 다시 받은 것이다.
 * reorderCachedGroup 과 같은 원리: 그룹을 넣고 빼고 이름을 바꾼다고 다른 종목
 * 가격이 변하지 않는다. 캐시를 그 자리에서 고치고 mtime 만 다시 새긴다.
 * 캐시가 없으면 false — 다음 조회가 어차피 새로 받는다.
 */
export async function patchCachedGroups(
  mutate: (groups: UsWatchResult["groups"]) => void,
): Promise<boolean> {
  // 재시작 직후엔 메모리가 비어 있다 — 디스크 캐시부터 읽는다. 안 그러면 첫
  // 수술이 불발돼 전 종목 재수집(20초)으로 떨어진다 (실측 21.7초 → 이 줄로 해결)
  await loadCache();
  if (!shot) return false;
  mutate(shot.data.groups);
  shot.mtime = await watchlistMtime();
  /* 디스크 캐시도 맞춰 둔다 — 재시작 직후 옛 구성이 돌아오면 유령 그룹이 보인다 */
  await writeFile(CACHE_FILE, JSON.stringify(shot), "utf-8").catch(() => undefined);
  return true;
}

/**
 * 방금 담은 종목의 임시 줄 — 캐시 수술로 **즉시 보이게**. 시세 상세(52주·원화·강도)는
 * null 로 두고, 다음 배경 갱신(FRESH_MS 뒤 폴링)이 채운다. 가격은 편입가로 시작한다.
 */
export function stubQuoteRow(symbol: string, name: string, addedPrice: number | null): UsQuoteRow {
  return {
    symbol,
    name,
    price: addedPrice,
    changeRate: null,
    returnRate: addedPrice !== null ? 0 : null,
    addedPrice,
    memo: "",
    marketState: null,
    quotedAt: null,
    error: null,
    wonPrice: null,
    volumeVsPrev: null,
    pos52: null,
    high52: null,
    low52: null,
    power: null,
    open: null,
    high: null,
    low: null,
    state: null,
    afterPrice: null,
    afterChangeRate: null,
    dayPrice: null,
    dayChangeRate: null,
    dayVolume: null,
    currency: null,
    country: null,
    flag: null,
    source: "yahoo",
  };
}

/** 지금 가격 하나만 — 담을 때 편입가를 채우려고 */
export async function quoteSymbol(symbol: string): Promise<number | null> {
  return (await quoteOne(symbol)).price;
}
