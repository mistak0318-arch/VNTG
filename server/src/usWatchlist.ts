import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";

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
const US_EXCHANGES = new Set(["NMS", "NYQ", "NGM", "NCM", "PCX", "ASE", "BTS", "NYS"]);

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
      .filter((x) => x.symbol && US_EXCHANGES.has(String(x.exchange)))
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
  error: string | null;
}

/**
 * 시세를 한 번에 받아 온다.
 *
 * 종목마다 따로 부르면 40종목에 40회다. Yahoo 차트 API 는 종목당 한 번이지만,
 * **동시에 6개씩** 묶어 돌려서 전체 대기 시간을 줄인다. 하나 실패해도 나머지는 나온다 —
 * 미국 시세는 없는 종목·상장폐지가 섞이기 쉬워서 전부 아니면 무로 두면 화면이 자주 빈다.
 */
async function quoteOne(symbol: string): Promise<{ price: number | null; changeRate: number | null; state: string | null; error: string | null }> {
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
          };
        }[];
      };
    };
    const m = j.chart?.result?.[0]?.meta;
    if (!m?.regularMarketPrice) return { price: null, changeRate: null, state: null, error: "시세 없음" };
    const prev = m.chartPreviousClose ?? m.previousClose ?? null;
    return {
      price: m.regularMarketPrice,
      changeRate: prev ? ((m.regularMarketPrice - prev) / prev) * 100 : null,
      state: m.marketState ?? null,
      error: null,
    };
  } catch {
    void recordApiCall("yahoo", "chart", "failed");
    return { price: null, changeRate: null, state: null, error: "조회 실패" };
  }
}

const cache = new Map<string, { at: number; data: Awaited<ReturnType<typeof quoteOne>> }>();
const TTL_MS = 60_000;

export async function evaluateGroups(): Promise<
  { id: string; name: string; memo: string; changeRate: number | null; rising: number; falling: number; stocks: UsQuoteRow[] }[]
> {
  const groups = await readAll();
  const symbols = [...new Set(groups.flatMap((g) => g.stocks.map((s) => s.symbol)))];

  const quotes = new Map<string, Awaited<ReturnType<typeof quoteOne>>>();
  for (let i = 0; i < symbols.length; i += 6) {
    const chunk = symbols.slice(i, i + 6);
    const got = await Promise.all(
      chunk.map(async (sym) => {
        const hit = cache.get(sym);
        if (hit && Date.now() - hit.at < TTL_MS) return [sym, hit.data] as const;
        const q = await quoteOne(sym);
        cache.set(sym, { at: Date.now(), data: q });
        return [sym, q] as const;
      }),
    );
    for (const [sym, q] of got) quotes.set(sym, q);
  }

  return groups.map((g) => {
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
        error: q?.error ?? null,
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
}

/** 지금 가격 하나만 — 담을 때 편입가를 채우려고 */
export async function quoteSymbol(symbol: string): Promise<number | null> {
  return (await quoteOne(symbol)).price;
}
