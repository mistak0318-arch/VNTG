import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { loadThemes } from "./naverThemes.js";

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
/** 종목 하나가 갖고 있을 종가 개수 — 60일 누적까지 보니 넉넉히 */
const KEEP = 70;

interface Store {
  /** 마지막으로 한 바퀴 돈 시각 (ISO) */
  builtAt: string;
  /** 종목코드 → 종가 배열 (옛날 → 최신) */
  closes: Record<string, number[]>;
}

const EMPTY: Store = { builtAt: "", closes: {} };
let cache: Store | null = null;

export async function loadCloses(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Store;
    cache = {
      builtAt: String(raw.builtAt ?? ""),
      closes: raw.closes && typeof raw.closes === "object" ? raw.closes : {},
    };
  } catch {
    cache = EMPTY;
  }
  return cache;
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

let running: Promise<Store> | null = null;
let progress = { done: 0, total: 0 };

export function closesProgress() {
  return { ...progress, running: running !== null };
}

function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

async function fetchOne(client: KiwoomClient, code: string): Promise<number[]> {
  const base = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART, "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = (res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  /* 응답은 최신 → 옛날 순이다. 뒤집어서 옛날 → 최신으로 두고 최근 것만 남긴다 */
  return rows
    .map((r) => Math.abs(n(r.cur_prc)))
    .filter((v) => v > 0)
    .reverse()
    .slice(-KEEP);
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
    const codes = [
      ...new Set(themes.themes.flatMap((t) => t.stocks.map((s) => s.code))),
    ].filter((c) => /^\d{6}$/.test(c));

    const prev = await loadCloses();
    const closes: Record<string, number[]> = { ...prev.closes };
    progress = { done: 0, total: codes.length };

    /*
     * **중간에 끊겨도 이어서 받는다.**
     *
     * 열 분짜리 작업이라 그 사이에 서버가 재시작되면(배포·코드 수정) 통째로 날아갔다 —
     * 실제로 세 번 그랬다. 이제 진행분을 **50종목마다 저장**하고, 다시 시작하면
     * 오늘 이미 받은 종목은 건너뛴다.
     */
    const todayKey = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const doneToday = new Set(prev.builtAt.slice(0, 10) === todayKey ? Object.keys(prev.closes) : []);

    const flush = async () => {
      const s: Store = { builtAt: new Date().toISOString(), closes };
      await mkdir(DIR, { recursive: true });
      await writeFile(FILE, JSON.stringify(s), "utf-8");
      cache = s;
    };

    let since = 0;
    for (const code of codes) {
      progress = { done: progress.done + 1, total: codes.length };
      if (doneToday.has(code)) continue;
      try {
        const got = await fetchOne(client, code);
        if (got.length > 0) closes[code] = got;
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
