import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dropPhantomToday } from "./candleGuard.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { loadThemes } from "./naverThemes.js";
import { getCommonStockCodes } from "./stockListCache.js";

/**
 * 전종목 일봉 종가 캐시 — **누적 수익률의 바탕.**
 *
 * ## 왜 필요한가
 *
 * 테마의 5일·20일 누적을 내려면 과거 값이 있어야 하는데, 방법이 둘뿐이었다:
 *   ① 오늘부터 하루 한 줄씩 쌓는다 → **닷새를 기다려야** 첫 값이 나온다
 *   ② 종목마다 일봉을 받는다 → 6,430종목이면 그만큼 조회다
 *
 * ②를 **하루 한 번만** 하면 된다는 게 이 파일이다. 종목이 여러 테마에 겹치므로
 * 중복을 빼면 3,000종목 안팎이고, 초당 5건 제한으로 10분이면 한 바퀴다.
 * 한 번 받아 두면 그 뒤로는 **조회 0회**로 5일·20일·60일을 전부 낼 수 있다.
 *
 * 그리고 이 캐시는 테마만 쓰는 게 아니다 — 신호등의 테마 기준도, 시세분석의
 * 누적등락률도 같은 값을 본다. 같은 자로 재야 화면끼리 말이 어긋나지 않는다.
 *
 * ## 언제 받나
 *
 * **장 마감 뒤(16시 이후) 하루 한 번.** 장중에 받으면 그날 종가가 아직 아니라서,
 * 다음 날 다시 받을 때까지 어제와 오늘이 섞인 값을 쓰게 된다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data");
const FILE = join(DIR, "dailyCloses.json");

const CHART = "/api/dostk/chart";
/**
 * 종목 하나가 갖고 있을 **거래일 수**.
 *
 * ## 70 → 400 (2026-09-01 오전) — **조회가 안 늘었다**
 *
 * 70 이던 것은 「60일 누적까지 보니 넉넉히」라는 이유였다. 그런데 이 캐시는
 * **표본 백테스트의 테마 렌즈**도 쓴다. 거기서 되짚는 구간이 400거래일인데
 * 캐시가 70일뿐이라, 테마 강세는 **최근 60여 일로만 채점되고 있었다.**
 *
 * `ka10081` 은 한 번에 400개 넘게 준다. 그러니 70 은 **받아 놓고 잘라 버리던
 * 값**이었다.
 *
 * ## 400 → 설정값 (2026-09-01 오후)
 *
 * 벤티지: "일단 공짜고 용량 문제 없으니 빠짐없이 죄다 수집하자."
 * "최대 5년치 약 100기가 정도로 두고 5년 지나면 앞에것부터 지워나가는 로직."
 *
 * ⚠️ **한 번 받을 때 오는 것은 한 응답분이다.** 이 값을 5년으로 올려도 과거가
 * 저절로 채워지지 않는다 — 응답이 주는 만큼만 있고, 그다음부터 **하루하루
 * 쌓이면서** 늘어난다. 그래서 옛 값을 **버리지 않고 이어 붙이는** 것이 핵심이다
 * (예전에는 매번 새 응답으로 통째로 갈아치웠다).
 */
export const BAR_KEEP_DEFAULT = 500; // 약 2년(거래일)
export const BAR_KEEP_MAX = 1300; // 약 5년

function keepDays(): number {
  const raw = Number(process.env.VNTG_BAR_KEEP);
  if (!Number.isFinite(raw) || raw <= 0) return BAR_KEEP_DEFAULT;
  return Math.min(Math.round(raw), BAR_KEEP_MAX);
}

/**
 * 하루치 봉 — **받아 놓고 버리던 것들이다.**
 *
 * 예전에는 종가만 남겼다. `ka10081` 응답에는 시가·고가·저가·거래량이 **같이
 * 들어 있는데** 그걸 그대로 흘려보내고 있었다. 그래서 「위쪽 매물 부담」을
 * 전종목에 걸 수가 없었고(고가·저가·거래량이 필요하다), 전종목 사전훑기에서는
 * 날짜 비중으로 **근사**할 수밖에 없었다.
 *
 * 조회는 한 톨도 안 는다. 파일만 커진다 — 종가만 400일이 5.2MB 였으니
 * 다섯 값 5년치도 130MB 안팎이다.
 */
export interface DayBar {
  /** YYYYMMDD */
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  /** 거래량(주) */
  v: number;
}

interface Store {
  /** 마지막으로 한 바퀴 돈 시각 (ISO) */
  builtAt: string;
  /** 종목코드 → 종가 배열 (옛날 → 최신). `bars` 에서 파생한다 */
  closes: Record<string, number[]>;
  /** 종목코드 → 일봉 (옛날 → 최신) */
  bars?: Record<string, DayBar[]>;
}

const EMPTY: Store = { builtAt: "", closes: {}, bars: {} };
let cache: Store | null = null;

export async function loadCloses(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Store;
    const bars = raw.bars && typeof raw.bars === "object" ? raw.bars : {};
    /*
     * `closes` 는 **파생값**이다 (2026-09-01). 옛 파일에는 `closes` 만 있으므로
     * 그건 그대로 읽고, 새 파일에는 `bars` 에서 만든다 — 두 벌로 저장하면
     * 파일이 두 배가 되고, 무엇보다 **둘이 어긋날 수 있다.**
     */
    const closes: Record<string, number[]> =
      Object.keys(bars).length > 0
        ? Object.fromEntries(Object.entries(bars).map(([k, v]) => [k, v.map((b) => b.c)]))
        : raw.closes && typeof raw.closes === "object"
          ? raw.closes
          : {};
    cache = { builtAt: String(raw.builtAt ?? ""), closes, bars };
  } catch {
    cache = EMPTY;
  }
  return cache;
}

/**
 * 종목 하나의 일봉 — **없으면 빈 배열.**
 *
 * 옛 파일(종가만)로 도는 동안에는 비어 있다. 부르는 쪽은 그때 예전 방식으로
 * 물러설 수 있어야 한다 — 「없다」를 「0」으로 읽으면 안 된다.
 */
export async function loadBars(code: string): Promise<DayBar[]> {
  const { bars } = await loadCloses();
  return bars?.[code] ?? [];
}

/** 캐시가 일봉까지 들고 있나 — 화면이 「아직 종가만 있습니다」를 말할 수 있게 */
export async function hasBars(): Promise<{ codes: number; withBars: number }> {
  const s = await loadCloses();
  return { codes: Object.keys(s.closes).length, withBars: Object.keys(s.bars ?? {}).length };
}

/**
 * 종목 하나의 최근 N일 누적 수익률(%).
 *
 * 종가가 모자라면 `null` — **짧은 걸로 대신 세지 않는다.** 사흘치로 「5일 누적」을
 * 만들면 그건 다른 값이다.
 */
export function cumOf(closes: number[] | undefined, days: number): number | null {
  if (!closes || closes.length < days + 1) return null;
  const from = closes[closes.length - 1 - days];
  const to = closes[closes.length - 1];
  return from > 0 ? ((to - from) / from) * 100 : null;
}

/** 며칠 전 대비 올랐나 — 하루하루의 등락을 세려고 */
export function dailyRates(closes: number[] | undefined, days: number): number[] {
  if (!closes || closes.length < 2) return [];
  const win = closes.slice(-(days + 1));
  const out: number[] = [];
  for (let i = 1; i < win.length; i++) {
    if (win[i - 1] > 0) out.push(((win[i] - win[i - 1]) / win[i - 1]) * 100);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 받아오기                                                            */
/* ------------------------------------------------------------------ */

/**
 * 캐시에 담을 ETF 코드들 — `etfHolders` 가 이미 들고 있는 것을 재사용한다.
 *
 * 「어느 종목을 어느 ETF 가 담았나」를 뒤집어 ETF 쪽 코드만 모은다. 파일에서
 * 읽으므로 조회가 0회다. 파일이 없으면 빈 배열이라 캐시가 예전처럼 돈다.
 */
async function etfCodeList(): Promise<string[]> {
  try {
    const { readFile: rf } = await import("node:fs/promises");
    const raw = JSON.parse(await rf(join(DIR, "etfHolders.json"), "utf-8")) as {
      byStock?: Record<string, { code?: string }[]>;
    };
    const out = new Set<string>();
    for (const list of Object.values(raw.byStock ?? {})) {
      for (const h of list) if (h.code) out.add(h.code);
    }
    return [...out];
  } catch {
    return [];
  }
}

let running: Promise<Store> | null = null;
let progress = { done: 0, total: 0 };

export function closesProgress() {
  return { ...progress, running: running !== null };
}

function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

async function fetchOne(client: KiwoomClient, code: string): Promise<DayBar[]> {
  const base = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART, "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = dropPhantomToday((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]);
  /*
   * **다섯 값을 다 담는다** (2026-09-01). 예전에는 종가만 뽑고 나머지를 버렸다 —
   * 같은 응답에 들어 있는데도. 그 탓에 「위쪽 매물 부담」을 전종목에 걸 수 없어
   * 사전훑기에서 날짜 비중으로 근사할 수밖에 없었다. 조회는 한 톨도 안 는다.
   */
  return rows
    .map((r) => ({
      d: String(r.dt ?? ""),
      o: Math.abs(n(r.open_pric)),
      h: Math.abs(n(r.high_pric)),
      l: Math.abs(n(r.low_pric)),
      c: Math.abs(n(r.cur_prc)),
      v: Math.abs(n(r.trde_qty)),
    }))
    .filter((b) => /^\d{8}$/.test(b.d) && b.c > 0)
    /* 응답은 최신 → 옛날 순이다. 뒤집어 옛날 → 최신으로 둔다 */
    .reverse();
}

/**
 * 받은 것과 갖고 있던 것을 **이어 붙인다** — 이 함수가 「5년치」의 핵심이다.
 *
 * ⚠️ 예전에는 새 응답으로 **통째로 갈아치웠다.** 그래서 보관 일수를 아무리 늘려도
 * 한 응답이 주는 만큼(400봉 남짓)에서 멈춘다 — 과거가 저절로 생기지 않기 때문이다.
 * 옛 값을 남기고 겹치는 날짜만 새 값으로 덮으면, 하루하루 지날수록 **뒤로 자란다.**
 *
 * 겹치는 날은 **새 값이 이긴다.** 수정주가(`upd_stkpc_tp:"1"`)라 액면분할·유상증자가
 * 있으면 과거 값이 통째로 다시 계산돼 온다 — 옛 값을 남기면 그 종목만 눈금이
 * 어긋난 채로 남는다.
 *
 * ⚠️ 다만 **분할 전후가 섞인 구간**은 남는다. 응답이 닿지 않는 오래된 날은 옛
 * 눈금 그대로다. 그 종목의 아주 오래된 값은 그만큼 못 믿는다 — 5년을 쌓기로 한
 * 이상 피할 수 없는 대가이고, 숨기지 않는다.
 */
export function mergeBars(oldBars: DayBar[], got: DayBar[], keep: number): DayBar[] {
  if (got.length === 0) return oldBars.slice(-keep);
  const by = new Map<string, DayBar>();
  for (const b of oldBars) by.set(b.d, b);
  for (const b of got) by.set(b.d, b); // 새 값이 이긴다
  return [...by.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0)).slice(-keep);
}

/**
 * 테마에 든 **모든 국내 종목**의 일봉을 받아 저장한다.
 *
 * 실패한 종목은 건너뛰고 계속한다 — 하나 때문에 열 분짜리 작업이 없던 일이 되면
 * 그게 더 나쁘다. 이미 받아 둔 종목의 값은 실패해도 지우지 않는다.
 */
export async function buildCloses(client: KiwoomClient): Promise<Store> {
  if (running) return running;
  running = (async () => {
    const themes = await loadThemes();
    /*
     * **ETF 도 받는다** (2026-09-01).
     *
     * 「ETF 뒷배」 기준이 표본에서 채점 밖이던 이유가 이것이다 — 캐시에 ETF 가
     * 아예 없어서 과거 등락률을 낼 수 없었다(069500·102110·229200 확인).
     *
     * ⚠️ ETF 코드는 **숫자가 아니다** — `0091P0` 처럼 영문이 섞인다. 그래서
     * 예전 필터(`^\d{6}$`)가 통째로 걸러내고 있었다. 여섯 자리 영숫자로 넓힌다.
     *
     * ⚠️ 이걸로 **look-ahead 가 풀리지는 않는다.** 「이 종목을 담은 ETF」 구성이
     * 오늘 것이라, 그 이름표로 과거를 채점하면 테마 강세가 -5.76%p 로 실패한
     * 그 병이 그대로다. 다만 **재볼 수는 있게** 된다 — 테마 강세도 그렇게 재서
     * 결론을 얻었다. 숫자를 그 한계와 함께 읽으면 된다.
     */
    const etfCodes = await etfCodeList();
    /*
     * ## **전종목이다** (2026-09-01 오후) — 예전에는 아니었다
     *
     * 벤티지: "빠짐없이 죄다 수집하자."
     *
     * 예전 목록은 **「테마에 든 종목 + ETF」**였다. 네이버 테마 커버리지가 넓어서
     * 2,400여 개가 나왔고 그래서 전종목처럼 보였지만, **테마에 안 잡힌 종목은
     * 통째로 빠져 있었다.** 그리고 그건 조용한 구멍이다 — 빠진 종목은 화면
     * 어디에도 안 나오니 없는 줄도 모른다.
     *
     * 이제 보통주 전체(`getCommonStockCodes`)를 바탕으로 하고, 거기에 테마·ETF 를
     * 더한다. 보통주 집합은 ETF·ETN·리츠·우선주를 빼므로 ETF 는 따로 넣어야 한다.
     */
    const common = await getCommonStockCodes(client).catch(() => new Set<string>());
    const codes = [
      ...new Set([
        ...common,
        ...themes.themes.flatMap((t) => t.stocks.map((s) => s.code)),
        ...etfCodes,
      ]),
    ].filter((c) => /^[0-9A-Z]{6}$/i.test(c));

    const prev = await loadCloses();
    const bars: Record<string, DayBar[]> = { ...(prev.bars ?? {}) };
    /*
     * 옛 파일에는 종가만 있다. 그건 **버리지 않고** 봉으로 감싸 둔다 — 날짜를
     * 모르니 이어 붙일 수는 없지만, 새로 받기 전까지 화면이 빈 값을 보면 안 된다.
     * 첫 한 바퀴가 끝나면 전부 진짜 봉으로 바뀐다.
     */
    const closes: Record<string, number[]> = { ...prev.closes };
    const keep = keepDays();
    progress = { done: 0, total: codes.length };

    /*
     * **중간에 끊겨도 이어서 받는다.**
     *
     * 열 분짜리 작업이라 그 사이에 서버가 재시작되면(배포·코드 수정) 통째로 날아갔다 —
     * 실제로 세 번 그랬다. 이제 진행분을 **50종목마다 저장**하고, 다시 시작하면
     * 오늘 이미 받은 종목은 건너뛴다.
     */
    const todayKey = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const doneToday = new Set(
      prev.builtAt.slice(0, 10) === todayKey ? Object.keys(prev.bars ?? {}) : [],
    );

    const flush = async () => {
      /*
       * `closes` 는 봉에서 파생한다 — 두 벌로 저장하면 파일이 두 배가 되고,
       * 무엇보다 둘이 어긋날 수 있다. 아직 봉이 없는 종목만 옛 종가를 남긴다.
       */
      const derived: Record<string, number[]> = { ...closes };
      for (const [k, v] of Object.entries(bars)) derived[k] = v.map((b) => b.c);
      const s: Store = { builtAt: new Date().toISOString(), closes: {}, bars };
      await mkdir(DIR, { recursive: true });
      await writeFile(FILE, JSON.stringify(s), "utf-8");
      cache = { ...s, closes: derived };
    };

    let since = 0;
    for (const code of codes) {
      progress = { done: progress.done + 1, total: codes.length };
      if (doneToday.has(code)) continue;
      try {
        const got = await fetchOne(client, code);
        /* **이어 붙인다.** 갈아치우면 보관 일수를 늘려도 과거가 안 자란다 */
        if (got.length > 0) bars[code] = mergeBars(bars[code] ?? [], got, keep);
      } catch {
        /* 이 종목만 건너뛴다 — 지난번 값이 있으면 그대로 남는다 */
      }
      if (++since >= 50) {
        since = 0;
        await flush();
      }
      /* 초당 5건 제한 — 한 건에 220ms 면 안전하다 */
      await new Promise((r) => setTimeout(r, 220));
    }

    await flush();
    return cache!;
  })().finally(() => {
    running = null;
  });
  return running;
}

/* ------------------------------------------------------------------ */
/* 하루 1회 스케줄                                                      */
/* ------------------------------------------------------------------ */

let timer: NodeJS.Timeout | null = null;

/**
 * 장 마감 뒤 하루 한 번.
 *
 * 16시 이후에만 돈다 — 장중에 받으면 그날 종가가 아직 아니다.
 * 테마 분류가 아직 없으면 아무것도 안 한다(받을 대상이 없다).
 */
export function startClosesScheduler(client: KiwoomClient): void {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    const store = await loadCloses();
    const kst = new Date(Date.now() + 9 * 3600_000);
    const today = kst.toISOString().slice(0, 10);
    if (store.builtAt.slice(0, 10) === today) return;
    /*
     * ⚠️ **캐시가 아예 없으면 시각을 안 따진다** (2026-08-28).
     *
     * 16시 이후에만 돌게 해 놨더니, 새벽에 처음 배포한 날은 조건에 안 걸려서
     * **하루 종일 시작조차 안 했다.** 화면에는 5일·20일이 계속 「—」로 남았고,
     * 원인이 「아직 안 받았다」인지 「받았는데 값이 없다」인지 구분도 안 됐다.
     * 첫 한 바퀴는 언제든 돈다 — 빈 화면으로 두는 것보다 낫다.
     * (그날 종가가 아직 아닐 수는 있지만, 다음 마감 뒤에 어차피 다시 받는다)
     */
    if (kst.getUTCHours() < 16 && Object.keys(store.closes).length > 0) return;
    const themes = await loadThemes();
    if (themes.themes.length === 0) return;
    try {
      const r = await buildCloses(client);
      console.log(`[dailyCloses] 일봉 캐시 — 종목 ${Object.keys(r.closes).length}개`);
    } catch (err) {
      console.error("[dailyCloses] 실패:", err instanceof Error ? err.message : err);
    }
  };
  setTimeout(() => void tick(), 150_000); // 기동 직후는 다른 초기화에 자리를 내준다
  timer = setInterval(() => void tick(), 30 * 60_000);
  console.log("[dailyCloses] 일봉 캐시 스케줄러 시작 (하루 1회, 16시 이후)");
}
