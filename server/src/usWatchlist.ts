import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";
import { hantooUsQuotes } from "./usQuotesHantoo.js";

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

export async function searchUs(query: string): Promise<UsSearchResult[]> {
  const q = query.trim();
  if (!q) return [];
  try {
    const res = await fetch(
      `${SEARCH}?q=${encodeURIComponent(q)}&quotesCount=15&newsCount=0`,
      { headers: { "User-Agent": "Mozilla/5.0" } },
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

  const missing: string[] = [];
  for (const sym of symbols) {
    const h = hantoo.get(sym);
    if (h && h.price !== null) {
      quotes.set(sym, {
        price: h.price,
        changeRate: h.changeRate,
        state: h.state,
        quotedAt: null,
        error: null,
      });
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

/** 지금 가격 하나만 — 담을 때 편입가를 채우려고 */
export async function quoteSymbol(symbol: string): Promise<number | null> {
  return (await quoteOne(symbol)).price;
}
