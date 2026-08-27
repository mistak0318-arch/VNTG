import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";

/**
 * 네이버 테마 DB — **분류와 편입 사유만 받아 두고, 숫자는 우리가 낸다.**
 *
 * ## 왜 네이버인가 (2026-08-28)
 *
 * 키움 테마는 묶음이 거칠어 「이 종목이 왜 여기 있나」가 안 풀렸고, 거래소 업종은
 * 더 나빠서 판정에서 아예 뺐다(「화학」 한 칸에 화장품·이차전지·정유).
 *
 * 네이버 테마는 **종목마다 편입 사유가 한 줄씩 붙어 있다.** 그게 이 데이터의 값어치다:
 *   가온전선 — "LS그룹 계열사로 전력케이블 및 통신케이블 등을 생산하는 국내 3대 전선 전문 제조업체"
 *
 * 무엇보다 **로그인이 필요 없다.** 그래서 서버가 스스로 갱신할 수 있다 — 사람이
 * 브라우저로 긁어 심어야 하는 데이터는 결국 한 번 쓰고 낡는다.
 *
 * ## 무엇을 저장하지 않나
 *
 * 등락률·상승종목수는 네이버도 주지만 **안 쓴다.** 그건 키움 시세로 우리가 매일 낸다.
 * 여기 저장하는 것은 자주 안 바뀌는 것뿐이다 — 테마명·구성종목·편입 사유.
 * 그래야 이 파일이 며칠 낡아도 화면의 숫자는 늘 오늘 것이다.
 *
 * ## 조회 예의
 *
 * 목록 7장 + 테마마다 1장이다. **HTML 한 장이 요청 하나**다(이미지·JS 는 안 받는다).
 * 테마 사이에 쉬어 간다 — 사람이 페이지를 넘기는 속도보다 느리게 둔다.
 * 구성이 매일 바뀌는 값이 아니므로 **주 1회면 충분하다.**
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data");
const FILE = join(DIR, "naverThemes.json");

const LIST_URL = "https://finance.naver.com/sise/theme.naver";
const DETAIL_URL = "https://finance.naver.com/sise/sise_group_detail.naver?type=theme&no=";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";

/** 페이지 사이 쉬는 시간 — 서둘러야 할 이유가 없는 작업이다 */
const GAP_MS = 2000;

export interface ThemeStock {
  code: string;
  name: string;
  /** 테마 편입 사유 — 네이버가 종목마다 붙여 둔 한 줄 */
  desc: string;
}

export interface NaverTheme {
  /** 네이버 테마 번호 — 원본을 다시 볼 때 쓴다 */
  no: number;
  name: string;
  stocks: ThemeStock[];
}

/**
 * 미국 테마 — **국내와 출처가 다르다.**
 *
 * 국내는 네이버가 「테마」라고 이름 붙여 만든 묶음이고, 미국은 종목마다 붙은
 * 로이터 산업분류(`industryGroupKor`)를 우리가 뒤집어 만든다. 「블록 체인 및
 * 암호화폐」·「생명 공학 및 의학 연구」처럼 꽤 잘게 나뉘어 있어서 업종이라기보다
 * 테마에 가깝다.
 *
 * ⚠️ **편입 사유는 없다.** 국내에만 있는 값이라 미국 테마에는 `desc` 가 빈 문자열이다.
 * 없는 것을 지어내지 않는다.
 */
export interface UsTheme {
  /** 로이터 산업 코드 — 이름이 같아도 코드로 가른다 */
  code: string;
  name: string;
  stocks: {
    symbol: string;
    name: string;
    exchange: string;
    /**
     * 마지막 정규장 등락률(%).
     *
     * ⚠️ 국내와 달리 **여기 시세를 같이 저장한다.** 키움·한투 해외주식은 종목당
     * 1콜이라 6,100종목을 매일 받을 수가 없다 — 국내는 업종 묶음으로 65콜이면
     * 전종목이 되지만 해외엔 그런 묶음 조회가 없다.
     * 그런데 이 분류를 주는 네이버 API 가 **시세를 같은 응답에 담아 준다.**
     * 100종목씩 63장이면 6,100종목이 다 온다 — 그래서 미국만 여기 얹는다.
     * 집계(테마 평균·상승비율·연속성)는 국내와 똑같이 우리가 한다.
     */
    changeRate: number | null;
    /** 시가총액(현지 통화) — 큰 종목부터 보여주려고 */
    marketCap: number | null;
  }[];
}

/**
 * ETF — **묶음이 아니라 종목 하나하나가 곧 테마다.**
 *
 * 「KODEX 2차전지산업」은 그 자체로 이차전지 테마다. 그래서 국내 테마처럼 구성종목을
 * 모을 필요가 없고, ETF 목록을 분류별로 늘어놓으면 그게 곧 테마 MAP 이 된다.
 *
 * 네이버 ETF 목록 API 는 **요청 한 번에 1,163개가 통째로** 온다 — 등락률·NAV·
 * 3개월 수익률·시총까지 같이. 그래서 매일 받아도 부담이 없다.
 */
export interface EtfRow {
  code: string;
  name: string;
  /** 분류 — 1 국내지수 · 2 국내업종/테마 · 3 국내파생 · 4 해외주식 · 5 원자재 · 6 채권 · 7 기타 */
  tab: number;
  changeRate: number | null;
  /** 순자산가치. 괴리율을 볼 때 쓴다 */
  nav: number | null;
  price: number | null;
  /** 최근 3개월 수익률(%) — 네이버가 같이 준다 */
  m3: number | null;
  /** 시가총액(억원) */
  marketCap: number | null;
}

export const ETF_TABS: Record<number, string> = {
  1: "국내 시장지수",
  2: "국내 업종/테마",
  3: "국내 파생",
  4: "해외 주식",
  5: "원자재",
  6: "채권",
  7: "기타",
};

export interface NaverThemeStore {
  /** 마지막으로 받은 시각 (ISO) */
  fetchedAt: string;
  themes: NaverTheme[];
  /** 미국 테마 — 따로 받는다(출처가 다르다). 받은 적 없으면 빈 배열 */
  us: UsTheme[];
  /** 미국 쪽 마지막 갱신 */
  usFetchedAt: string;
  /** ETF 목록 — 요청 한 번이라 매일 받는다 */
  etf: EtfRow[];
  etfFetchedAt: string;
}

const EMPTY: NaverThemeStore = {
  fetchedAt: "",
  themes: [],
  us: [],
  usFetchedAt: "",
  etf: [],
  etfFetchedAt: "",
};

let cache: NaverThemeStore | null = null;

/* ------------------------------------------------------------------ */
/* 읽기                                                                */
/* ------------------------------------------------------------------ */

export async function loadThemes(): Promise<NaverThemeStore> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as NaverThemeStore;
    cache = {
      fetchedAt: String(raw.fetchedAt ?? ""),
      themes: Array.isArray(raw.themes) ? raw.themes : [],
      us: Array.isArray(raw.us) ? raw.us : [],
      usFetchedAt: String(raw.usFetchedAt ?? ""),
      etf: Array.isArray(raw.etf) ? raw.etf : [],
      etfFetchedAt: String(raw.etfFetchedAt ?? ""),
    };
  } catch {
    cache = EMPTY;
  }
  return cache;
}

/**
 * 종목 → 그 종목이 든 테마들 (역인덱스).
 * 「이 종목이 어느 묶음에 속하나」는 종목 상세가 늘 묻는 질문이라 미리 뒤집어 둔다.
 */
let reverse: Map<string, { no: number; name: string; desc: string }[]> | null = null;
let reverseAt = "";

export async function themesOfStock(code: string): Promise<{ no: number; name: string; desc: string }[]> {
  const store = await loadThemes();
  if (!reverse || reverseAt !== store.fetchedAt) {
    reverse = new Map();
    reverseAt = store.fetchedAt;
    for (const t of store.themes) {
      for (const s of t.stocks) {
        const list = reverse.get(s.code) ?? [];
        list.push({ no: t.no, name: t.name, desc: s.desc });
        reverse.set(s.code, list);
      }
    }
  }
  return reverse.get(code) ?? [];
}

/* ------------------------------------------------------------------ */
/* 받아오기                                                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ **EUC-KR 이다.**
 * `res.text()` 를 그대로 쓰면 한글이 통째로 깨진다 — meta 에는 utf-8 이라 적혀 있는데
 * 실제 바이트는 EUC-KR 이라 그 말을 믿으면 안 된다(실측 2026-08-28).
 */
async function getHtml(url: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) {
    void recordApiCall("naver", "theme", res.status === 429 ? "rateLimited" : "failed");
    throw new Error(`네이버 응답 ${res.status}`);
  }
  void recordApiCall("naver", "theme", "ok");
  return new TextDecoder("euc-kr").decode(Buffer.from(await res.arrayBuffer()));
}

function strip(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

/** 목록 한 장에서 테마 번호·이름 */
function parseList(html: string): { no: number; name: string }[] {
  const out = new Map<number, string>();
  for (const m of html.matchAll(/sise_group_detail\.naver\?type=theme&no=(\d+)[^>]*>([^<]+)</g)) {
    const no = Number(m[1]);
    const name = strip(m[2]);
    if (no > 0 && name) out.set(no, name);
  }
  return [...out.entries()].map(([no, name]) => ({ no, name }));
}

/** 목록에 적힌 마지막 페이지 번호 */
function lastPage(html: string): number {
  const pages = [...html.matchAll(/theme\.naver\?[^"']*page=(\d+)/g)].map((m) => Number(m[1]));
  return pages.length > 0 ? Math.max(...pages) : 1;
}

/**
 * 상세 한 장에서 구성종목 + 편입 사유.
 *
 * 편입 사유는 종목명 옆 문서 아이콘에 달린 툴팁이다 — `<p class="info_txt">`.
 * 없는 종목도 있으므로 빈 문자열을 허용한다(없는 것을 지어내지 않는다).
 */
function parseDetail(html: string): ThemeStock[] {
  const out: ThemeStock[] = [];
  for (const r of html.matchAll(/<td class="name">[\s\S]*?<\/tr>/g)) {
    const h = r[0];
    const m = h.match(/item\/main\.naver\?code=(\d{6})"[^>]*>([^<]+)</);
    if (!m) continue;
    const d = h.match(/<p class="info_txt">([\s\S]*?)<\/p>/);
    out.push({ code: m[1], name: strip(m[2]), desc: d ? strip(d[1]) : "" });
  }
  return out;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 지금 받는 중인가 — 두 번 겹쳐 돌면 요청이 배로 나간다 */
let running: Promise<NaverThemeStore> | null = null;
let progress = { done: 0, total: 0, at: "" };

export function themeFetchProgress() {
  return { ...progress, running: running !== null };
}

/**
 * 테마 전체를 새로 받는다.
 *
 * 목록 7장 → 테마마다 1장. 사이사이 쉰다. 실패한 테마는 **건너뛰고 계속한다** —
 * 하나 때문에 전체가 없던 일이 되면 그게 더 나쁘다.
 */
export async function fetchAllThemes(opts: { limit?: number } = {}): Promise<NaverThemeStore> {
  if (running) return running;
  running = (async () => {
    const first = await getHtml(LIST_URL);
    const last = lastPage(first);
    const list = parseList(first);

    for (let p = 2; p <= last; p++) {
      await sleep(GAP_MS);
      try {
        const html = await getHtml(`${LIST_URL}?&page=${p}`);
        for (const t of parseList(html)) if (!list.some((x) => x.no === t.no)) list.push(t);
      } catch {
        /* 목록 한 장을 놓쳐도 나머지는 받는다 */
      }
    }

    const targets = opts.limit ? list.slice(0, opts.limit) : list;
    progress = { done: 0, total: targets.length, at: "" };

    const themes: NaverTheme[] = [];
    for (const t of targets) {
      await sleep(GAP_MS);
      try {
        const html = await getHtml(DETAIL_URL + t.no);
        const stocks = parseDetail(html);
        // 종목이 하나도 없으면 받다 만 것이다 — 빈 테마로 굳히지 않는다
        if (stocks.length > 0) themes.push({ no: t.no, name: t.name, stocks });
      } catch {
        /* 이 테마만 건너뛴다 */
      }
      progress = { done: progress.done + 1, total: targets.length, at: t.name };
    }

    /* 미국 쪽은 **건드리지 않는다** — 국내만 다시 받는 일이 흔하다 */
    const prev = await loadThemes();
    const store: NaverThemeStore = {
      ...prev,
      fetchedAt: new Date().toISOString(),
      themes,
    };
    await mkdir(DIR, { recursive: true });
    await writeFile(FILE, JSON.stringify(store), "utf-8");
    cache = store;
    reverse = null;
    return store;
  })().finally(() => {
    running = null;
  });
  return running;
}

/* ------------------------------------------------------------------ */
/* 미국 테마                                                            */
/* ------------------------------------------------------------------ */

const US_EXCHANGES = ["NASDAQ", "NYSE", "AMEX"] as const;
const US_API = "https://api.stock.naver.com/stock/exchange/";
/** 이 API 의 상한이다 — 넘기면 400 을 준다(실측) */
const US_PAGE = 100;

interface UsRow {
  symbolCode?: string;
  stockName?: string;
  stockExchangeType?: { name?: string };
  industryCodeType?: { code?: string; industryGroupKor?: string };
  /** 등락률 — 문자열로 온다("1.23") */
  fluctuationsRatio?: string;
  marketValueRaw?: number;
}

function toNum(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * 미국 테마 — 종목마다 붙은 산업분류를 **뒤집어서** 만든다.
 *
 * 거래소 셋을 100종목씩 훑는다(총 63장 안팎). 국내 테마 수집(273장)보다 오히려 가볍다.
 * 응답에 시세도 같이 오지만 **안 쓴다** — 등락률은 오늘 값이어야 하고, 이 파일은
 * 주 1회 갱신이라 그 안의 시세는 금방 낡는다.
 */
export async function fetchUsThemes(): Promise<UsTheme[]> {
  const byCode = new Map<string, UsTheme>();

  for (const ex of US_EXCHANGES) {
    let page = 1;
    let total = Infinity;
    while ((page - 1) * US_PAGE < total) {
      const url = `${US_API}${ex}/industry?page=${page}&pageSize=${US_PAGE}`;
      try {
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) {
          void recordApiCall("naver", "usTheme", res.status === 429 ? "rateLimited" : "failed");
          break;
        }
        void recordApiCall("naver", "usTheme", "ok");
        const j = (await res.json()) as { totalCount?: number; stocks?: UsRow[] };
        total = Number(j.totalCount) || 0;
        for (const s of j.stocks ?? []) {
          const g = s.industryCodeType;
          const symbol = String(s.symbolCode ?? "").trim();
          if (!g?.industryGroupKor || !symbol) continue;
          const code = String(g.code ?? g.industryGroupKor);
          const t = byCode.get(code) ?? { code, name: g.industryGroupKor, stocks: [] };
          t.stocks.push({
            symbol,
            name: String(s.stockName ?? symbol).trim(),
            exchange: String(s.stockExchangeType?.name ?? ex),
            changeRate: toNum(s.fluctuationsRatio),
            marketCap: toNum(s.marketValueRaw),
          });
          byCode.set(code, t);
        }
      } catch {
        break; // 한 거래소를 놓쳐도 나머지는 받는다
      }
      page += 1;
      await sleep(1500);
    }
  }

  /* 한 종목짜리 묶음은 테마가 아니다 — MAP 에 타일만 늘린다 */
  return [...byCode.values()]
    .filter((t) => t.stocks.length >= 2)
    .sort((a, b) => b.stocks.length - a.stocks.length);
}

/** 미국 테마만 다시 받아 저장한다 (국내는 건드리지 않는다) */
export async function refreshUsThemes(): Promise<{ themes: number; stocks: number }> {
  const us = await fetchUsThemes();
  const prev = await loadThemes();
  const store: NaverThemeStore = { ...prev, us, usFetchedAt: new Date().toISOString() };
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(store), "utf-8");
  cache = store;
  return { themes: us.length, stocks: us.reduce((n, t) => n + t.stocks.length, 0) };
}

/* ------------------------------------------------------------------ */
/* ETF                                                                 */
/* ------------------------------------------------------------------ */

/**
 * ETF 목록 — **요청 한 번에 전부.**
 *
 * 이 API 는 페이징이 없다. 1,163개가 한 응답에 오고 등락률·NAV·3개월 수익률·시총이
 * 붙어 있다. 그래서 국내 테마(273장)나 미국(63장)과 달리 매일 받아도 티가 안 난다.
 * `Referer` 가 없으면 막힐 수 있어 같이 보낸다.
 */
export async function fetchEtfs(): Promise<EtfRow[]> {
  const res = await fetch("https://finance.naver.com/api/sise/etfItemList.nhn", {
    headers: { "User-Agent": UA, Referer: "https://finance.naver.com/sise/etf.naver" },
  });
  if (!res.ok) {
    void recordApiCall("naver", "etfList", res.status === 429 ? "rateLimited" : "failed");
    throw new Error(`네이버 응답 ${res.status}`);
  }
  void recordApiCall("naver", "etfList", "ok");
  /*
   * ⚠️ **JSON 인데 EUC-KR 이다.**
   * `res.json()` 은 본문을 UTF-8 로 읽으므로 「TIGER 2차전지TOP10」이
   * 「TIGER 2������TOP10」이 된다(실측). HTML 쪽과 같은 함정인데, 응답이
   * JSON 이라 방심하기 쉽다. 바이트로 받아 EUC-KR 로 풀고 나서 파싱한다.
   */
  const body = JSON.parse(
    new TextDecoder("euc-kr").decode(Buffer.from(await res.arrayBuffer())),
  ) as {
    result?: {
      etfItemList?: {
        itemcode?: string;
        itemname?: string;
        etfTabCode?: number;
        changeRate?: number;
        nowVal?: number;
        nav?: number;
        threeMonthEarnRate?: number;
        marketSum?: number;
      }[];
    };
  };
  return (body.result?.etfItemList ?? [])
    .map((r) => ({
      code: String(r.itemcode ?? "").trim(),
      name: String(r.itemname ?? "").trim(),
      tab: Number(r.etfTabCode) || 7,
      changeRate: toNum(r.changeRate),
      nav: toNum(r.nav),
      price: toNum(r.nowVal),
      m3: toNum(r.threeMonthEarnRate),
      marketCap: toNum(r.marketSum),
    }))
    .filter((r) => /^\d{6}$/.test(r.code) && r.name.length > 0);
}

/** ETF 만 다시 받아 저장한다 */
export async function refreshEtfs(): Promise<{ count: number }> {
  const etf = await fetchEtfs();
  const prev = await loadThemes();
  const store: NaverThemeStore = { ...prev, etf, etfFetchedAt: new Date().toISOString() };
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(store), "utf-8");
  cache = store;
  return { count: etf.length };
}

/* ------------------------------------------------------------------ */
/* 주 1회 갱신                                                          */
/* ------------------------------------------------------------------ */

let timer: NodeJS.Timeout | null = null;

/**
 * 자동 갱신 — **국내와 미국의 주기가 다르다.**
 *
 * 국내: **주 1회(일요일 04시).** 받는 것이 분류뿐이라 이 주기로 충분하다. 등락률은
 *   키움 스냅샷으로 매일 새로 내므로 이 파일이 낡아도 화면 숫자는 오늘 것이다.
 *   매일 돌리면 쓰지도 않는 데이터를 273장씩 받는 셈이다.
 *
 * 미국: **매일(07시대).** 여기는 분류와 **시세가 한 응답에 같이 온다** — 키움·한투
 *   해외주식은 종목당 1콜이라 6,100종목을 받을 길이 없고, 이 API 는 63장이면 된다.
 *   그래서 미국만 매일 받아 등락률까지 갱신한다. 한국시간 07시면 미국 정규장이
 *   끝난 뒤라 그날 종가가 들어온다.
 */
export function startThemeScheduler(): void {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    const store = await loadThemes();
    const kst = new Date(Date.now() + 9 * 3600_000);
    const hour = kst.getUTCHours();
    const day = kst.getUTCDay();
    const age = store.fetchedAt ? Date.now() - new Date(store.fetchedAt).getTime() : Infinity;
    const usAge = store.usFetchedAt ? Date.now() - new Date(store.usFetchedAt).getTime() : Infinity;

    /* 국내 — 일요일 04시. 한 번도 받은 적이 없으면 때를 안 가린다(빈 화면으로 두지 않는다) */
    const krDue = age >= 6.5 * 24 * 3600_000 && (day === 0 && hour === 4);
    if (krDue || store.themes.length === 0) {
      try {
        const r = await fetchAllThemes();
        console.log(`[naverThemes] 국내 갱신 — 테마 ${r.themes.length}개`);
      } catch (err) {
        console.error("[naverThemes] 국내 갱신 실패:", err instanceof Error ? err.message : err);
      }
    }

    /* 미국 — 매일 07시대(미국 마감 뒤). 20시간이 안 지났으면 건너뛴다 */
    const usDue = usAge >= 20 * 3600_000 && hour === 7;
    if (usDue || store.us.length === 0) {
      try {
        const r = await refreshUsThemes();
        console.log(`[naverThemes] 미국 갱신 — 테마 ${r.themes}개 · 종목 ${r.stocks}개`);
      } catch (err) {
        console.error("[naverThemes] 미국 갱신 실패:", err instanceof Error ? err.message : err);
      }
    }

    /* ETF — **요청 한 번**이라 장 마감 뒤(16시대) 매일 받는다 */
    const etfAge = store.etfFetchedAt
      ? Date.now() - new Date(store.etfFetchedAt).getTime()
      : Infinity;
    if ((etfAge >= 12 * 3600_000 && hour === 16) || store.etf.length === 0) {
      try {
        const r = await refreshEtfs();
        console.log(`[naverThemes] ETF 갱신 — ${r.count}개`);
      } catch (err) {
        console.error("[naverThemes] ETF 갱신 실패:", err instanceof Error ? err.message : err);
      }
    }
  };
  setTimeout(() => void tick(), 120_000); // 기동 직후는 다른 초기화에 자리를 내준다
  timer = setInterval(() => void tick(), 30 * 60_000);
  console.log("[naverThemes] 테마 갱신 스케줄러 시작 (국내 주 1회 · 미국 매일 07시)");
}

/** 요약 — 화면 머리에 「언제 받은 것인가」를 적기 위해 */
export async function themeSummary(): Promise<{
  fetchedAt: string;
  themes: number;
  stocks: number;
  withDesc: number;
  usFetchedAt: string;
  usThemes: number;
  usStocks: number;
  etfFetchedAt: string;
  etfs: number;
}> {
  const store = await loadThemes();
  const all = store.themes.flatMap((t) => t.stocks);
  return {
    fetchedAt: store.fetchedAt,
    themes: store.themes.length,
    stocks: all.length,
    withDesc: all.filter((s) => s.desc.length > 0).length,
    usFetchedAt: store.usFetchedAt,
    usThemes: store.us.length,
    usStocks: store.us.reduce((n, t) => n + t.stocks.length, 0),
    etfFetchedAt: store.etfFetchedAt,
    etfs: store.etf.length,
  };
}
