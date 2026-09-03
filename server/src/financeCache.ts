import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getFinance } from "./dartFinance.js";
import { quarterFinance, type QuarterRow } from "./quarterFinance.js";
import { hantooReady } from "./hantooClient.js";

/**
 * **실적 캐시** (2026-09-02) — 표본에 실적 칸을 채우려고.
 *
 * ## 왜
 *
 * 원장으로 표본을 만들면서(`samplesFromLedger`) 실적 네 칸(연간 YoY · 분기 연속
 * 증가 · 분기 YoY · 분기 이익률)을 **상수 null** 로 박아 뒀다. 그러자
 *
 *   · 약세 전용 `profitGrowth`(w2)가 늘 결손 → 커버리지 0.857 → **약세장 관측이
 *     전부 채점 밖**으로 나갔다 (Opus 감사 1-4). 시뮬레이터 숫자가 강세 30일치였다.
 *   · 벤티지가 콕 집은 「영업이익이 좋아지고 있나」를 잴 수 없었다.
 *
 * 2026-09-02 재검토에서 손으로 받아 붙여 보니(1,314종목) 분기 YoY 0~20% 가 시총
 * 중립 +2.3~+4.1%p, 적자 분기가 -2.6%p 로 **살아 있는 기준**이었다. 그래서 매일
 * 붙인다.
 *
 * ## 얼마나 자주
 *
 * 분기 실적은 분기에 한 번 바뀐다. 종목당 한투 1콜(400ms) + DART 1콜이라 1,300종목이면
 * 15~20분 — 매일 할 일은 아니다. **7일 지난 것만** 다시 받는다. 처음엔 전부 받으므로
 * 첫 회차만 길다.
 *
 * ## look-ahead
 *
 * 받아 둔 8분기를 과거 날짜에 그대로 붙이면 미래를 보는 것이다. `quarterAt()` 은
 * **그 날짜에 이미 공시된 분기만** 쓴다 — 분기말+45일, 사업보고서(4분기)+90일. 실제
 * 공시일이 아니라 **법정 기한**이라 빠른 회사는 그만큼 늦게 반영된다. 늦게 잡는 쪽이
 * 안전하다. (`signalBacktest.quarterIndex` 와 같은 규칙)
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "financeCache.json");

export interface FinanceRec {
  /** 최근이 앞 (quarterFinance 그대로) */
  quarters: QuarterRow[];
  /** DART 연간 — 오래된 것부터 */
  annual: { label: string; op: number | null }[];
  /** 받은 시각 ISO */
  at: string;
}

export type FinanceCache = Record<string, FinanceRec>;

let cache: FinanceCache | null = null;

export async function loadFinanceCache(): Promise<FinanceCache> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, "utf-8")) as FinanceCache;
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(dirname(FILE), { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(cache), "utf-8");
}

export interface EnsureProgress {
  total: number;
  fetched: number;
  failed: number;
  /** 한투가 준비 안 돼 분기를 못 받은 종목 수 */
  noQuarter: number;
  ms: number;
}

/**
 * 없거나 `maxAgeDays` 지난 종목만 받는다. **한 줄로** — 한투는 초당 2.5건이 한계다.
 *
 * @param budgetMs 이 시간이 지나면 멈춘다(다음 회차가 이어서 받는다). 0 이면 끝까지
 */
export async function ensureFinance(
  codes: string[],
  opts: { maxAgeDays?: number; budgetMs?: number } = {},
): Promise<EnsureProgress> {
  const db = await loadFinanceCache();
  const maxAge = (opts.maxAgeDays ?? 7) * 86_400_000;
  const budget = opts.budgetMs ?? 0;
  const t0 = Date.now();
  const stale = codes.filter((c) => {
    const r = db[c];
    return !r || Date.now() - new Date(r.at).getTime() > maxAge;
  });
  const p: EnsureProgress = { total: stale.length, fetched: 0, failed: 0, noQuarter: 0, ms: 0 };
  const hantoo = hantooReady();
  let sinceSave = 0;
  for (const code of stale) {
    if (budget > 0 && Date.now() - t0 > budget) break;
    const rec: FinanceRec = { quarters: [], annual: [], at: new Date().toISOString() };
    let ok = false;
    if (hantoo) {
      try {
        rec.quarters = await quarterFinance(code, 8);
        ok = true;
      } catch {
        /* 실패는 아래에서 센다 */
      }
    } else p.noQuarter += 1;
    try {
      const fin = await getFinance(code);
      rec.annual = (fin.periods ?? []).map((x) => ({ label: String(x.label), op: x.operatingProfit }));
      ok = true;
    } catch {
      /* DART 키가 없거나 막힘 */
    }
    if (ok) {
      db[code] = rec;
      p.fetched += 1;
    } else p.failed += 1;
    if (++sinceSave >= 50) {
      await persist();
      sinceSave = 0;
    }
  }
  await persist();
  p.ms = Date.now() - t0;
  return p;
}

/** 그 분기가 **알려진 날**(YYYYMMDD) — 결산월 말일 + 법정 기한 */
function knownAt(period: string): string {
  const y = Number(period.slice(0, 4));
  const m = Number(period.slice(4, 6));
  if (!Number.isFinite(y) || !Number.isFinite(m)) return "99999999";
  const d = new Date(Date.UTC(y, m, 0));
  d.setUTCDate(d.getUTCDate() + (m === 12 ? 90 : 45));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export interface QuarterLens {
  qStreak: number | null;
  qYoY: number | null;
  qQoQ: number | null;
  qMargin: number | null;
}

const EMPTY: QuarterLens = { qStreak: null, qYoY: null, qQoQ: null, qMargin: null };

/**
 * 어느 날짜 `date`(YYYYMMDD)에 **그때 이미 공시돼 있던** 분기 실적.
 * 최근 분기 넷(연속 증가 수 · YoY · QoQ · 이익률). 실전(오늘)은 `date` 를 안 주면 된다.
 */
/**
 * **분기 영업이익률 개선 추세** (2026-09-03, 세대 5 기본조건) — 벤티지: "분기별 영업이익률이
 * 좋아지고 있는 추세여야 해."
 *
 * 값 = max(최근 분기 − 직전 분기, 최근 분기 − 직전 4분기 평균) (%p). 둘 중 하나만 양수면
 * 「개선 중」으로 본다 — 한 분기 튀는 것에 흔들리지 않게 4분기 평균도 같이 본다.
 * `date` 를 주면 그날 알 수 있던 분기만(표본용, look-ahead 없음).
 */
export function marginTrendAt(
  rec: FinanceRec | undefined,
  date?: string,
): { trend: number; m0: number; m1: number | null; avg4: number | null; label: string } | null {
  const rows = (rec?.quarters ?? []).filter((r) => (date ? knownAt(r.period) <= date : true));
  const ms = rows.map((r) => r.margin);
  if (ms.length < 2 || ms[0] === null) return null;
  const m0 = ms[0];
  const m1 = ms[1];
  const prev = ms.slice(1, 5).filter((v): v is number => v !== null);
  const avg4 = prev.length >= 2 ? prev.reduce((a, b) => a + b, 0) / prev.length : null;
  const cands: number[] = [];
  if (m1 !== null) cands.push(m0 - m1);
  if (avg4 !== null) cands.push(m0 - avg4);
  if (cands.length === 0) return null;
  return { trend: Math.max(...cands), m0, m1, avg4, label: rows[0].label };
}

export function quarterAt(rec: FinanceRec | undefined, date?: string): QuarterLens {
  const rows = rec?.quarters ?? [];
  if (rows.length < 2) return EMPTY;
  const seen = date ? rows.filter((r) => knownAt(r.period) <= date) : rows;
  if (seen.length === 0) return EMPTY;
  const last = seen[0];
  const vals = seen.map((r) => r.operatingProfit).filter((v): v is number => v !== null);
  let streak: number | null = null;
  if (vals.length >= 2) {
    streak = 0;
    for (let i = 0; i < vals.length - 1; i++) {
      if (vals[i] > vals[i + 1]) streak += 1;
      else break;
    }
  }
  return { qStreak: streak, qYoY: last.yoy, qQoQ: last.qoq, qMargin: last.margin };
}

/**
 * 그 날짜에 알 수 있었던 **연간** 영업이익 증가율(%). 사업보고서는 3월 말이 원칙이라
 * 4월부터 직전 연도가 보인다. `date` 를 안 주면 오늘 기준.
 */
export function profitAt(rec: FinanceRec | undefined, date?: string): number | null {
  const byYear = new Map<number, number>();
  for (const p of rec?.annual ?? []) {
    const y = Number(String(p.label).replace(/[^0-9]/g, "").slice(0, 4));
    if (Number.isFinite(y) && y > 1990 && p.op !== null) byYear.set(y, p.op);
  }
  if (byYear.size < 2) return null;
  const d = date ?? new Date().toISOString().slice(0, 10).replace(/-/g, "");
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(4, 6));
  const latest = m >= 4 ? y - 1 : y - 2;
  const cur = byYear.get(latest);
  const prev = byYear.get(latest - 1);
  if (cur === undefined || prev === undefined || prev === 0) return null;
  return ((cur - prev) / Math.abs(prev)) * 100;
}
