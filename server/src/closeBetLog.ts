import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { marketGauge, type GaugeDay } from "./closeBet.js";
import { indexDetail } from "./indexDetail.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "closeBetLog.json");

/**
 * 종가배팅 실전 추적 — **매일 자동으로 찍어 두고 다음날 채점한다.**
 *
 * ## 왜 필요한가
 *
 * 과거 검증(`closeBet.ts`)으로 「선물 양봉 + 반도체 대형주」가 코스피 대비 +0.92%p 라는
 * 결과를 얻었다. 그런데 그건 **과거**다. 두 가지를 더 봐야 한다.
 *
 * 1. **앞으로도 그런가** — 과거 성적은 과거의 것이다.
 * 2. **시장이 바뀌면 어떻게 되나** — 그래서 통계를 **구간별로** 갈라 볼 수 있게 한다.
 *    최근 20일과 그 이전이 다르면 시장 성격이 바뀐 것이고, 그때는 조건을 다시 봐야 한다.
 *
 * ## 실전에서 볼 수 있는 것만으로 판단해야 한다
 *
 * ⚠️ **이게 이 모듈에서 제일 중요한 지점이다.**
 *
 * 과거 검증은 「매수일과 **같은 날짜**의 미국 선물」을 봤다. 그런데 실전에서 15:35 에는
 * **그 밤의 미국장이 아직 안 끝났다.** 그때 보이는 선물은 진행 중인 값이다.
 *
 * 그래서 **둘 다 찍어 둔다.**
 *   atClose  — 15:35 에 보이던 값 (진행 중). **실전에서 쓸 수 있는 건 이것뿐이다**
 *   settled  — 다음날 확정된 값
 *
 * 둘의 성적이 크게 다르면, 과거 검증의 +0.92%p 는 **결과를 알고 본 숫자**였다는 뜻이다.
 */

export interface LoggedStock {
  code: string;
  name: string;
  /** 매수일 KRX 종가 (15:30) */
  close: number;
  /**
   * 같은 날 NXT 종가 (20:00).
   *
   * **어디서 샀느냐가 값을 바꾼다.** 실측(삼성전자 10일)에서 두 종가가 8일이나 달랐고
   * 하루는 10,000원(약 4%) 벌어졌다. 과거 검증에서는 KRX 가 나았지만
   * (초과 +0.92%p vs +0.52%p) NXT 는 아직 거래가 두터워지는 중이라 답이 바뀔 수 있다.
   * 그래서 **둘 다 찍어 두고 계속 견준다.**
   */
  nxtClose: number | null;
  /** 다음 거래일 */
  nextOpen: number | null;
  nextClose: number | null;
  /** 종가 대비(%) */
  openRate: number | null;
  closeRate: number | null;
  /** 같은 날 코스피 대비(%p) */
  openExcess: number | null;
  closeExcess: number | null;
  /** NXT 종가로 샀다면 — 매도는 똑같이 다음날 KRX 시가다 */
  nxtOpenRate: number | null;
  nxtOpenExcess: number | null;
}

export interface LoggedDay {
  /** 매수일 (기록한 날) */
  date: string;
  /** 15:35 에 보이던 시장 조건 — 실전에서 판단에 쓸 수 있는 값 */
  atClose: GaugeDay | null;
  /** 다음날 확정된 시장 조건 */
  settled: GaugeDay | null;
  stocks: LoggedStock[];
  /** 채점이 끝났나 */
  scored: boolean;
}

interface Store {
  /** 추적할 종목 — 검증에서 「반도체 대형주」가 갈렸으므로 기본은 둘이다 */
  watch: { code: string; name: string }[];
  days: LoggedDay[];
}

const DEFAULT_WATCH = [
  { code: "005930", name: "삼성전자" },
  { code: "000660", name: "SK하이닉스" },
];

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    return {
      watch: Array.isArray(raw.watch) && raw.watch.length > 0 ? raw.watch : DEFAULT_WATCH,
      days: Array.isArray(raw.days) ? raw.days : [],
    };
  } catch {
    return { watch: [...DEFAULT_WATCH], days: [] };
  }
}

async function save(s: Store): Promise<void> {
  // 500일이면 충분하고, 안 자르면 파일이 계속 자란다
  s.days = s.days.slice(-500);
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s, null, 2), "utf-8");
}

function kstDate(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,-]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** 종목 일봉 — 시가가 있어야 「다음날 시초에 판다」를 잴 수 있다 */
async function candles(
  client: KiwoomClient,
  code: string,
): Promise<Map<string, { open: number; close: number }>> {
  const d = new Date();
  const base = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = (res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  const out = new Map<string, { open: number; close: number }>();
  for (const r of rows) {
    const dt = String(r.dt ?? "");
    const open = toNum(r.open_pric);
    const close = toNum(r.cur_prc);
    if (/^\d{8}$/.test(dt) && open > 0 && close > 0) out.set(dt, { open, close });
  }
  return out;
}

/**
 * 오늘을 기록하고, 아직 못 매긴 날들을 채점한다.
 *
 * **한 번에 둘 다 한다.** 오늘 15:35 이면 어제 것의 「다음날」이 바로 오늘이라
 * 같은 조회로 둘 다 처리된다 — 종목 일봉 한 번이면 된다.
 */
export async function recordAndScore(client: KiwoomClient): Promise<LoggedDay[]> {
  const store = await load();
  const today = kstDate();
  const todayYmd = today.replace(/-/g, "");

  const gauge = await marketGauge().catch(() => null);

  // 종목마다 일봉 한 번 — 오늘 종가 기록과 지난 날 채점에 같이 쓴다
  const charts = new Map<string, Map<string, { open: number; close: number }>>();
  const nxtCharts = new Map<string, Map<string, { open: number; close: number }>>();
  for (const w of store.watch) {
    const c = await candles(client, w.code).catch(() => new Map());
    if (c.size > 0) charts.set(w.code, c);
    await new Promise((r) => setTimeout(r, 260));
    // NXT 는 `_NX` 접미사다. 같은 날 종가가 달라서 따로 받아야 한다
    const n = await candles(client, `${w.code}_NX`).catch(() => new Map());
    if (n.size > 0) nxtCharts.set(w.code, n);
    await new Promise((r) => setTimeout(r, 260));
  }

  // 코스피 벤치마크 — 「시장이 올라서 번 것」과 「종목을 골라서 번 것」을 가른다
  const kospi = await indexDetail(client, "001", "day").catch(() => null);
  const kc = kospi?.candles ?? [];
  const benchNext = new Map<string, { open: number; close: number }>();
  for (let i = 0; i < kc.length - 1; i++) {
    const buy = kc[i];
    const next = kc[i + 1];
    if (buy.close > 0 && next.open > 0) {
      benchNext.set(buy.dt, {
        open: ((next.open - buy.close) / buy.close) * 100,
        close: ((next.close - buy.close) / buy.close) * 100,
      });
    }
  }

  /* ---------- 아직 못 매긴 날 채점 ---------- */
  for (const day of store.days) {
    if (day.scored) continue;
    const buyYmd = day.date.replace(/-/g, "");
    let allDone = true;
    for (const s of day.stocks) {
      const c = charts.get(s.code);
      if (!c) {
        allDone = false;
        continue;
      }
      // 매수일 **다음** 거래일을 찾는다
      const after = [...c.keys()].filter((k) => k > buyYmd).sort();
      const nextKey = after[0];
      if (!nextKey) {
        allDone = false;
        continue;
      }
      const next = c.get(nextKey)!;
      s.nextOpen = next.open;
      s.nextClose = next.close;
      s.openRate = ((next.open - s.close) / s.close) * 100;
      s.closeRate = ((next.close - s.close) / s.close) * 100;
      const b = benchNext.get(buyYmd);
      s.openExcess = b ? s.openRate - b.open : null;
      s.closeExcess = b ? s.closeRate - b.close : null;
      // NXT 로 샀다면 — 파는 건 똑같이 다음날 KRX 시가다
      if (s.nxtClose && s.nxtClose > 0) {
        s.nxtOpenRate = ((next.open - s.nxtClose) / s.nxtClose) * 100;
        s.nxtOpenExcess = b ? s.nxtOpenRate - b.open : null;
      }
    }
    // 그날의 확정 시장 조건 — 밤이 지났으므로 이제 확정값이다
    if (!day.settled && gauge && gauge.day.date === day.date) day.settled = gauge.day;
    if (allDone) day.scored = true;
  }

  /* ---------- 오늘 기록 ---------- */
  if (!store.days.some((d) => d.date === today)) {
    const stocks: LoggedStock[] = [];
    for (const w of store.watch) {
      const close = charts.get(w.code)?.get(todayYmd)?.close;
      if (!close) continue;
      stocks.push({
        code: w.code,
        name: w.name,
        close,
        nxtClose: nxtCharts.get(w.code)?.get(todayYmd)?.close ?? null,
        nextOpen: null,
        nextClose: null,
        openRate: null,
        closeRate: null,
        openExcess: null,
        closeExcess: null,
        nxtOpenRate: null,
        nxtOpenExcess: null,
      });
    }
    if (stocks.length > 0) {
      store.days.push({
        date: today,
        // 15:35 에 보이던 값. **실전에서 판단에 쓸 수 있는 건 이것뿐이다**
        atClose: gauge?.day ?? null,
        settled: null,
        stocks,
        scored: false,
      });
    }
  }

  await save(store);
  return store.days;
}

/* ------------------------------------------------------------------ */
/* 통계 — 구간을 갈라 본다                                               */
/* ------------------------------------------------------------------ */

export interface LogStat {
  key: string;
  n: number;
  openWin: number;
  openAvg: number;
  openExcess: number;
  excessWin: number;
}

export interface LogSummary {
  days: number;
  scored: number;
  watch: { code: string; name: string }[];
  /** 전체 / 최근 20일 / 그 이전 — **시장이 바뀌었는지** 보려고 가른다 */
  periods: { label: string; matched: LogStat; unmatched: LogStat }[];
  recent: LoggedDay[];
  note: string;
}

function stat(key: string, rows: LoggedStock[], venue: "krx" | "nxt" = "krx"): LogStat {
  const rate = (x: LoggedStock) => (venue === "nxt" ? x.nxtOpenRate : x.openRate);
  const exc = (x: LoggedStock) => (venue === "nxt" ? x.nxtOpenExcess : x.openExcess);
  const r = rows.filter((x) => rate(x) !== null);
  if (r.length === 0) return { key, n: 0, openWin: 0, openAvg: 0, openExcess: 0, excessWin: 0 };
  const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const rates = r.map((x) => rate(x) as number);
  const ex = r.filter((x) => exc(x) !== null).map((x) => exc(x) as number);
  return {
    key,
    n: r.length,
    openWin: (rates.filter((x) => x > 0).length / rates.length) * 100,
    openAvg: avg(rates),
    openExcess: avg(ex),
    excessWin: ex.length > 0 ? (ex.filter((x) => x > 0).length / ex.length) * 100 : 0,
  };
}

/**
 * @param useSettled 확정 선물로 가를지. false 면 **15:35 에 보이던 값**으로 가른다 —
 *   실전에서 쓸 수 있는 건 그쪽이라 기본은 false 다.
 */
export async function logSummary(useSettled = false): Promise<LogSummary> {
  const store = await load();
  const scored = store.days.filter((d) => d.stocks.some((s) => s.openRate !== null));

  const split = (days: LoggedDay[], label: string, venue: "krx" | "nxt" = "krx") => {
    const yes: LoggedStock[] = [];
    const no: LoggedStock[] = [];
    for (const d of days) {
      const g = useSettled ? d.settled : d.atClose;
      const body = g?.futuresBody ?? null;
      if (body === null) continue;
      (body >= 0 ? yes : no).push(...d.stocks);
    }
    return {
      label,
      matched: stat("선물 양봉", yes, venue),
      unmatched: stat("선물 음봉", no, venue),
    };
  };

  const recent20 = scored.slice(-20);
  const before = scored.slice(0, -20);

  return {
    days: store.days.length,
    scored: scored.length,
    watch: store.watch,
    periods: [
      split(scored, "전체 · KRX"),
      // 어디서 샀느냐로 갈라 본다 — 시장이 두터워지면 답이 바뀔 수 있다
      split(scored, "전체 · NXT", "nxt"),
      split(recent20, "최근 20일 · KRX"),
      ...(before.length > 0 ? [split(before, "그 이전 · KRX")] : []),
    ],
    recent: store.days.slice(-30).reverse(),
    note:
      scored.length === 0
        ? "아직 채점된 날이 없습니다. 평일 15:35 에 자동으로 찍고, 다음 거래일에 채점합니다."
        : `${scored.length}일 채점 · ${useSettled ? "확정 선물" : "15:35 시점 선물"} 기준. ` +
          "전체와 최근 20일이 다르면 시장 성격이 바뀐 것입니다.",
  };
}

/* ------------------------------------------------------------------ */
/* 스케줄러                                                             */
/* ------------------------------------------------------------------ */

export function startCloseBetScheduler(client: KiwoomClient): void {
  const CHECK_MS = 5 * 60_000;
  let running = false;

  const tick = async () => {
    if (running) return;
    const now = new Date();
    const weekday = now.getDay() !== 0 && now.getDay() !== 6;
    const mins = now.getHours() * 60 + now.getMinutes();
    // 15:35~16:05. 주도주 탐색기와 같은 창이지만 부르는 TR 이 달라 겹쳐도 된다
    if (!weekday || mins < 15 * 60 + 35 || mins > 16 * 60 + 5) return;

    running = true;
    try {
      const days = await recordAndScore(client);
      const last = days[days.length - 1];
      console.log(
        `[closeBet] ${last?.date ?? "-"} 기록 · 누적 ${days.length}일 (채점 ${days.filter((d) => d.scored).length})`,
      );
    } catch (err) {
      console.error("[closeBet] 실패:", err);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(() => void tick(), CHECK_MS);
  console.log("[closeBet] 종가배팅 추적 시작 — 평일 15:35 기록·채점");
}
