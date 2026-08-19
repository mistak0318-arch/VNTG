import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateSignal, getConfig, type Axis } from "./signalLight.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "signalTrack.json");

/**
 * 신호등 추적기 — **신호등이 정말 맞는지 스스로 검증하는 자리.**
 *
 * 장이 끝나면 그날 점수가 높았던 종목을 자동으로 담아 두고, 그 뒤 며칠을 따라가며
 * 실제로 올랐는지 본다. 사람이 고르지 않는다 — 사람이 고르면 **맞은 것만 기억하게 된다.**
 *
 * ## 설계에서 정한 것 다섯
 *
 * 1. **편입 조건을 같이 저장한다.** 70/80/90 어느 문턱으로 들어왔는지, 그날 축별 점수가
 *    얼마였는지, 위험 때문에 초록이 막혔었는지까지. 나중에 「어느 축이 잘 맞았나」를
 *    물으려면 그때의 값이 남아 있어야 한다.
 *
 * 2. **그때의 기준(config)도 지문으로 남긴다.** 신호등 기준은 사용자가 언제든 바꾼다.
 *    기준이 바뀐 뒤의 90점과 그 전의 90점은 **다른 것**이다. 지문이 다르면 통계에서
 *    갈라 볼 수 있어야 한다.
 *
 * 3. **거래일로 센다.** 5일 뒤를 달력으로 세면 주말·휴장이 섞여 종목마다 기준이 달라진다.
 *    일봉을 받아 **편입일 이후 몇 번째 봉인지**로 센다.
 *
 * 4. **같은 종목·같은 문턱이 추적 중이면 다시 안 담는다.** 한 종목이 20일 연속 90점이면
 *    스무 건이 쌓여 그 종목 하나가 통계를 지배한다. 신호는 매일 났지만 **검증 표본으로는
 *    한 건**으로 친다.
 *
 * 5. **끝난 것을 지우지 않는다.** 60일이 지나면 닫되 기록은 남긴다 — 지우면 검증이 아니라
 *    그때그때의 인상만 남는다.
 */

/** 문턱 — 이 점수 이상이면 담는다 */
export const TIERS = [70, 80, 90] as const;
export type Tier = (typeof TIERS)[number];

/** 며칠 뒤를 볼지 (거래일) */
export const HORIZONS = [1, 5, 20, 60] as const;
export type Horizon = (typeof HORIZONS)[number];

export interface TrackResult {
  /** 편입일 이후 몇 거래일 뒤인가 */
  days: Horizon;
  price: number;
  /** 편입가 대비 (%) */
  rate: number;
  /** 이 값을 채운 날 */
  at: string;
}

export interface TrackEntry {
  id: string;
  code: string;
  name: string;
  /** 어느 문턱으로 들어왔나 */
  tier: Tier;
  /** 편입일 (YYYY-MM-DD, 장 마감 후 기록) */
  date: string;
  /** 편입 당시 신호등 */
  score: number;
  level: string;
  /** 편입 당시 축별 점수 — 어느 축이 잘 맞았는지 나중에 묻기 위해 */
  axes: Partial<Record<Axis, number | null>>;
  /** 위험 때문에 초록이 막혔었나 */
  riskCapped: boolean;
  /** 편입일 종가 */
  basePrice: number;
  /** 그때의 신호등 기준 지문 — 기준이 바뀌면 같은 90점도 다른 뜻이다 */
  configHash: string;
  results: TrackResult[];
  /** 60일까지 다 봤으면 닫는다. 기록은 남긴다 */
  closed: boolean;
}

interface Store {
  entries: TrackEntry[];
  /** 마지막으로 편입을 돌린 날 — 하루 한 번만 담는다 */
  lastRunDate: string | null;
}

const EMPTY: Store = { entries: [], lastRunDate: null };

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    return {
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      lastRunDate: typeof raw.lastRunDate === "string" ? raw.lastRunDate : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

async function save(s: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s, null, 2), "utf-8");
}

function todayStr(d = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * 신호등 기준의 지문.
 *
 * 켠 기준·가중치·문턱·축 가중치까지 넣는다. 하나라도 바뀌면 다른 지문이 나오고,
 * 통계에서 「기준이 바뀐 뒤 것만」을 갈라 볼 수 있다.
 */
async function configFingerprint(): Promise<string> {
  const c = await getConfig();
  const parts = [
    `g${c.greenAt}y${c.yellowAt}`,
    `r${c.riskYellowAt}-${c.riskRedAt}${c.riskBlocksGreen ? "B" : ""}`,
    `aw${c.axisWeights.trend}${c.axisWeights.flow}${c.axisWeights.value}`,
    `f${c.flowDays}`,
    `ma${c.maLines.join("")}`,
    ...c.checks
      .filter((x) => x.enabled)
      .map((x) => `${x.key}:${x.weight}:${x.threshold}:${x.strongAt}`),
  ];
  // 짧게 줄인다 — 사람이 읽을 값이 아니라 같은지 다른지만 보면 된다
  let h = 0;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `c${(h >>> 0).toString(36)}`;
}

/** 일봉 — 편입일 이후 몇 번째 거래일인지를 세려면 이게 있어야 한다 */
async function dailyCloses(
  client: KiwoomClient,
  code: string,
): Promise<{ date: string; close: number }[]> {
  const d = new Date();
  const base = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = (res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  return rows
    .map((r) => ({
      date: String(r.dt ?? ""),
      close: Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,]/g, ""))),
    }))
    .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
    // 오래된 것부터
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------------------------------------------ */
/* 편입                                                                */
/* ------------------------------------------------------------------ */

export interface EnrollReport {
  date: string;
  scanned: number;
  added: number;
  skippedDuplicate: number;
  byTier: Record<string, number>;
  note: string;
}

/**
 * 그날 점수가 높았던 종목을 담는다.
 *
 * 모집단은 **거래대금 상위**다. 전 종목을 평가하면 몇 시간이 걸리고, 어차피 거래가 없는
 * 종목의 신호는 검증할 값어치가 없다 — 사고팔 수 없는 것을 맞혔다고 해봐야 소용없다.
 */
export async function enrollToday(
  client: KiwoomClient,
  opts: { limit?: number; force?: boolean } = {},
): Promise<EnrollReport> {
  const limit = Math.min(Math.max(opts.limit ?? 60, 10), 200);
  const store = await load();
  const date = todayStr();

  if (!opts.force && store.lastRunDate === date) {
    return {
      date,
      scanned: 0,
      added: 0,
      skippedDuplicate: 0,
      byTier: {},
      note: "오늘은 이미 담았습니다.",
    };
  }

  const rank = await client.request<Record<string, unknown>>("/api/dostk/rkinfo", "ka10032", {
    mrkt_tp: "000",
    mang_stk_incls: "0",
    stex_tp: "3",
  });
  const rows = (rank.data?.trde_prica_upper ?? []) as Record<string, unknown>[];
  const universe = rows
    .slice(0, limit)
    .map((r) => ({
      code: String(r.stk_cd ?? "").replace(/[^0-9A-Za-z]/g, ""),
      name: String(r.stk_nm ?? ""),
    }))
    .filter((x) => x.code);

  const hash = await configFingerprint();
  const byTier: Record<string, number> = {};
  let added = 0;
  let skippedDuplicate = 0;

  for (const u of universe) {
    const sig = await evaluateSignal(client, u.code).catch(() => null);
    if (!sig) continue;
    // 높은 문턱부터 — 90점이면 90 으로 담는다(70 으로 중복해서 담지 않는다)
    const tier = [...TIERS].reverse().find((t) => sig.score >= t);
    if (!tier) continue;

    /*
     * 같은 종목·같은 문턱이 아직 추적 중이면 건너뛴다.
     * 한 종목이 20일 연속 90점이면 스무 건이 쌓여 그 종목 하나가 통계를 지배한다.
     */
    const open = store.entries.some((e) => e.code === u.code && e.tier === tier && !e.closed);
    if (open) {
      skippedDuplicate += 1;
      continue;
    }

    const price = await lastClose(client, u.code).catch(() => 0);
    if (!(price > 0)) continue;

    const axes: Partial<Record<Axis, number | null>> = {};
    for (const a of sig.axes) axes[a.key] = a.score;

    store.entries.push({
      id: `${date}-${u.code}-${tier}`,
      code: u.code,
      name: u.name,
      tier,
      date,
      score: sig.score,
      level: sig.level,
      axes,
      riskCapped: sig.riskCapped,
      basePrice: price,
      configHash: hash,
      results: [],
      closed: false,
    });
    added += 1;
    byTier[String(tier)] = (byTier[String(tier)] ?? 0) + 1;
  }

  store.lastRunDate = date;
  await save(store);
  return {
    date,
    scanned: universe.length,
    added,
    skippedDuplicate,
    byTier,
    note: `거래대금 상위 ${universe.length}종목을 평가해 ${added}건 담았습니다.`,
  };
}

async function lastClose(client: KiwoomClient, code: string): Promise<number> {
  const rows = await dailyCloses(client, code);
  return rows.length > 0 ? rows[rows.length - 1].close : 0;
}

/* ------------------------------------------------------------------ */
/* 추적                                                                */
/* ------------------------------------------------------------------ */

/**
 * 담아 둔 것들의 결과를 채운다.
 *
 * 편입일 **이후** 몇 번째 거래일인지로 센다 — 달력으로 세면 주말·휴장이 섞여
 * 종목마다 기준이 달라진다.
 */
export async function updateResults(client: KiwoomClient): Promise<{ updated: number; closed: number }> {
  const store = await load();
  const open = store.entries.filter((e) => !e.closed);
  if (open.length === 0) return { updated: 0, closed: 0 };

  // 종목마다 일봉을 한 번만 받는다 — 같은 종목이 여러 건일 수 있다
  const codes = [...new Set(open.map((e) => e.code))];
  const charts = new Map<string, { date: string; close: number }[]>();
  for (const code of codes) {
    const rows = await dailyCloses(client, code).catch(() => []);
    if (rows.length > 0) charts.set(code, rows);
  }

  let updated = 0;
  let closed = 0;
  const today = todayStr();

  for (const e of open) {
    const rows = charts.get(e.code);
    if (!rows) continue;
    const baseKey = e.date.replace(/-/g, "");
    const at = rows.findIndex((r) => r.date === baseKey);
    // 편입일 봉을 못 찾으면(그날 거래가 없었다면) 건드리지 않는다
    if (at < 0) continue;

    for (const h of HORIZONS) {
      if (e.results.some((r) => r.days === h)) continue;
      const row = rows[at + h];
      if (!row) continue;
      e.results.push({
        days: h,
        price: row.close,
        rate: ((row.close - e.basePrice) / e.basePrice) * 100,
        at: today,
      });
      updated += 1;
    }
    if (e.results.some((r) => r.days === 60)) {
      e.closed = true;
      closed += 1;
    }
  }

  await save(store);
  return { updated, closed };
}

/* ------------------------------------------------------------------ */
/* 통계 — 「신호등이 맞았나」                                            */
/* ------------------------------------------------------------------ */

export interface TierStat {
  tier: Tier;
  /** 담은 건수 */
  count: number;
  /** 아직 결과가 없는 것 */
  pending: number;
  byHorizon: {
    days: Horizon;
    n: number;
    /** 오른 비율 (%) */
    winRate: number;
    /** 평균 수익률 (%) */
    avg: number;
    /** 중앙값 — 몇 종목이 크게 튀면 평균이 거짓말을 한다 */
    median: number;
    best: number;
    worst: number;
  }[];
}

export interface TrackSummary {
  entries: TrackEntry[];
  tiers: TierStat[];
  /** 지금 기준의 지문. 이것과 다른 지문으로 담긴 건 기준이 달랐다는 뜻이다*/
  currentConfig: string;
  /** 기준이 섞여 있나 */
  mixedConfig: boolean;
  lastRunDate: string | null;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export async function trackSummary(): Promise<TrackSummary> {
  const store = await load();
  const currentConfig = await configFingerprint();

  const tiers: TierStat[] = TIERS.map((tier) => {
    const mine = store.entries.filter((e) => e.tier === tier);
    return {
      tier,
      count: mine.length,
      pending: mine.filter((e) => e.results.length === 0).length,
      byHorizon: HORIZONS.map((days) => {
        const rates = mine
          .map((e) => e.results.find((r) => r.days === days)?.rate)
          .filter((r): r is number => typeof r === "number");
        return {
          days,
          n: rates.length,
          winRate: rates.length === 0 ? 0 : (rates.filter((r) => r > 0).length / rates.length) * 100,
          avg: rates.length === 0 ? 0 : rates.reduce((a, b) => a + b, 0) / rates.length,
          median: median(rates),
          best: rates.length === 0 ? 0 : Math.max(...rates),
          worst: rates.length === 0 ? 0 : Math.min(...rates),
        };
      }),
    };
  });

  const hashes = new Set(store.entries.map((e) => e.configHash));
  return {
    // 최근 것부터
    entries: [...store.entries].sort((a, b) => b.date.localeCompare(a.date)),
    tiers,
    currentConfig,
    mixedConfig: hashes.size > 1,
    lastRunDate: store.lastRunDate,
  };
}

/* ------------------------------------------------------------------ */
/* 스케줄러                                                            */
/* ------------------------------------------------------------------ */

/**
 * 장 마감 뒤 한 번.
 *
 * 15:40 에 돈다 — 15:30 마감 직후는 종가가 아직 안 굳은 종목이 있다.
 * 평일만, 하루 한 번만. 결과 갱신은 편입 뒤에 이어서 한다(같은 일봉을 쓰므로).
 */
export function startSignalTrackScheduler(client: KiwoomClient): void {
  const CHECK_MS = 5 * 60_000;
  let running = false;

  const tick = async () => {
    if (running) return;
    const now = new Date();
    const weekday = now.getDay() !== 0 && now.getDay() !== 6;
    const mins = now.getHours() * 60 + now.getMinutes();
    // 15:40 ~ 16:10 사이에 한 번 걸리면 된다. 하루 한 번은 lastRunDate 가 막는다
    if (!weekday || mins < 15 * 60 + 40 || mins > 16 * 60 + 10) return;

    running = true;
    try {
      const r = await enrollToday(client);
      if (r.added > 0 || r.scanned > 0) {
        console.log(`[signalTrack] ${r.date} — ${r.note} (중복 건너뜀 ${r.skippedDuplicate})`);
      }
      const u = await updateResults(client);
      if (u.updated > 0) {
        console.log(`[signalTrack] 결과 ${u.updated}건 갱신, ${u.closed}건 종료`);
      }
    } catch (err) {
      console.error("[signalTrack] 실패:", err);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(() => void tick(), CHECK_MS);
  console.log("[signalTrack] 신호등 추적기 시작 — 평일 15:40 편입·갱신");
}
