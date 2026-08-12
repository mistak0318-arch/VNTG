import { randomUUID } from "node:crypto";
import type { KiwoomClient } from "./kiwoomClient.js";

/** 수급 주체 구분 */
export type FlowSubject = "foreign" | "inst" | "mainInst" | "combined" | "foreignMain";

export const FLOW_SUBJECTS: { key: FlowSubject; label: string }[] = [
  { key: "combined", label: "합산(외국인+기관)" },
  { key: "foreign", label: "외국인" },
  { key: "inst", label: "기관계" },
  { key: "mainInst", label: "메인기관(투신+연기금+사모)" },
  { key: "foreignMain", label: "외국인+메인기관" },
];

export interface AlgoResult {
  code: string;
  name: string;
  market: "코스피" | "코스닥";
  curPrc: number;
  fluRt: number;
  /** 주체별·기간별 순매매 합계 (백만원). 키는 기간 일수 문자열 */
  net: Record<FlowSubject, Record<string, number>>;
  /** 주체별 통과 여부 — 설정된 모든 기간에서 매수우위인지 */
  pass: Record<FlowSubject, boolean>;
  /** 정배열 여부 (데이터 부족 시 null) */
  trendPass: boolean | null;
  /** 이동평균값. 키는 이평 기간 문자열 */
  ma: Record<string, number> | null;
}

/** 화면에서 조정할 수 있는 스캔 조건 */
export interface AlgoConfig {
  /** 후보 종목 선정 기준 — 3:거래대금, 1:거래량, 2:거래회전율 (ka10030 sort_tp) */
  candidateSort: "1" | "2" | "3";
  /** 시장별 후보 개수 (코스피/코스닥 각각) */
  topN: number;
  /** 수급 판정에 쓸 기간들. 지정한 기간이 "모두" 매수우위여야 통과 */
  periods: number[];
  /** 정배열에 사용할 이동평균선 */
  maPeriods: number[];
  /** 정배열 판정 시 현재가가 첫 이평선 위에 있어야 하는지 */
  requirePriceAboveMa: boolean;
  /** 등락률 하한/상한 (%) */
  minChangeRate: number | null;
  maxChangeRate: number | null;
  /** 주가 하한/상한 (원) */
  minPrice: number | null;
  maxPrice: number | null;
}

export const DEFAULT_ALGO_CONFIG: AlgoConfig = {
  candidateSort: "3",
  topN: 100,
  periods: [5, 10, 20],
  maPeriods: [5, 20, 60, 120],
  requirePriceAboveMa: true,
  minChangeRate: null,
  maxChangeRate: null,
  minPrice: null,
  maxPrice: null,
};

export interface AlgoJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  results: AlgoResult[];
  error?: string;
  startedAt: number;
  config: AlgoConfig;
  /** 장 시작 전 등으로 당일 순위가 비어 전일 순위를 사용했는지 */
  usedPreviousDay: boolean;
}

const jobs = new Map<string, AlgoJob>();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 동시 호출 수를 제한해서 키움 API 레이트리밋을 피한다
async function runWithConcurrency<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let idx = 0;
  async function runner() {
    while (idx < items.length) {
      const current = items[idx];
      idx += 1;
      await worker(current);
      await sleep(250);
    }
  }
  await Promise.all(Array.from({ length: limit }, () => runner()));
}

function todayYyyymmdd(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}${m}${d}`;
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sum(arr: number[], n: number): number {
  return arr.slice(0, n).reduce((a, b) => a + b, 0);
}

type Row = Record<string, unknown>;

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

interface Candidate {
  code: string;
  name: string;
  market: "코스피" | "코스닥";
  curPrc: number;
  fluRt: number;
}

function mapCandidates(list: Row[], market: "코스피" | "코스닥", topN: number): Candidate[] {
  return list.slice(0, topN).map((item) => ({
    code: String(item.stk_cd ?? ""),
    name: String(item.stk_nm ?? ""),
    market,
    curPrc: Math.abs(toNum(item.cur_prc)),
    fluRt: toNum(item.flu_rt),
  }));
}

/**
 * 후보 종목을 뽑는다.
 * ka10030은 "당일" 순위라 장 시작 전에는 빈 응답이 온다.
 * 그럴 때는 ka10031(전일 순위)로 자동 폴백해서 장전에도 스캔이 되게 한다.
 */
async function fetchCandidates(
  client: KiwoomClient,
  mrktTp: string,
  market: "코스피" | "코스닥",
  config: AlgoConfig,
): Promise<{ candidates: Candidate[]; usedPreviousDay: boolean }> {
  const { data } = await client.request<{ tdy_trde_qty_upper?: Row[] }>("/api/dostk/rkinfo", "ka10030", {
    mrkt_tp: mrktTp,
    sort_tp: config.candidateSort,
    mang_stk_incls: "1", // 관리종목 제외
    crd_tp: "0",
    trde_qty_tp: "0",
    pric_tp: "0",
    trde_prica_tp: "0",
    mrkt_open_tp: "0",
    stex_tp: "3",
  });
  const today = Array.isArray(data.tdy_trde_qty_upper) ? data.tdy_trde_qty_upper : [];
  if (today.length > 0) {
    return { candidates: mapCandidates(today, market, config.topN), usedPreviousDay: false };
  }

  // 전일 순위 — qry_tp 1:거래량, 2:거래대금 (거래회전율은 없어 거래량으로 대체)
  const { data: prev } = await client.request<{ pred_trde_qty_upper?: Row[] }>(
    "/api/dostk/rkinfo",
    "ka10031",
    {
      mrkt_tp: mrktTp,
      qry_tp: config.candidateSort === "3" ? "2" : "1",
      rank_strt: "1",
      rank_end: "100",
      stex_tp: "3",
    },
  );
  const prevList = Array.isArray(prev.pred_trde_qty_upper) ? prev.pred_trde_qty_upper : [];
  return { candidates: mapCandidates(prevList, market, config.topN), usedPreviousDay: true };
}

/** 설정된 이평선들이 큰 값 → 작은 값 순으로 정렬돼 있는지 (정배열) */
async function checkTrendAlignment(
  client: KiwoomClient,
  code: string,
  config: AlgoConfig,
): Promise<{ pass: boolean; ma: Record<string, number> } | null> {
  const maxPeriod = Math.max(...config.maPeriods);
  const { data } = await client.request<{ stk_dt_pole_chart_qry?: Row[] }>("/api/dostk/chart", "ka10081", {
    stk_cd: code,
    base_dt: todayYyyymmdd(),
    upd_stkpc_tp: "1",
  });
  const rows = Array.isArray(data.stk_dt_pole_chart_qry) ? data.stk_dt_pole_chart_qry : [];
  const closes = rows.map((r) => Math.abs(toNum(r.cur_prc))).filter((n) => n > 0);
  if (closes.length < maxPeriod) return null; // 상장 이력이 짧아 계산 불가

  const sortedPeriods = [...config.maPeriods].sort((a, b) => a - b);
  const ma: Record<string, number> = {};
  for (const p of sortedPeriods) ma[String(p)] = avg(closes.slice(0, p));

  // 짧은 이평선이 긴 이평선보다 위에 있어야 정배열
  let pass = true;
  for (let i = 0; i < sortedPeriods.length - 1; i++) {
    if (ma[String(sortedPeriods[i])] < ma[String(sortedPeriods[i + 1])]) {
      pass = false;
      break;
    }
  }
  if (pass && config.requirePriceAboveMa) {
    pass = closes[0] >= ma[String(sortedPeriods[0])];
  }
  return { pass, ma };
}

async function checkFlow(
  client: KiwoomClient,
  code: string,
  config: AlgoConfig,
): Promise<{ net: AlgoResult["net"]; pass: AlgoResult["pass"] } | null> {
  const maxPeriod = Math.max(...config.periods);
  const { data } = await client.request<{ stk_invsr_orgn_chart?: Row[] }>("/api/dostk/chart", "ka10060", {
    dt: todayYyyymmdd(),
    stk_cd: code,
    amt_qty_tp: "1", // 금액(백만원)
    trde_tp: "0", // 순매수
    unit_tp: "1000",
  });
  const rows = Array.isArray(data.stk_invsr_orgn_chart) ? data.stk_invsr_orgn_chart : [];
  if (rows.length < maxPeriod) return null;

  const foreign = rows.map((r) => toNum(r.frgnr_invsr));
  const inst = rows.map((r) => toNum(r.orgn));
  // 기관계 중 투신+연기금등+사모펀드 = 매매를 주도하는 "메인" 기관
  const mainInst = rows.map((r) => toNum(r.invtrt) + toNum(r.penfnd_etc) + toNum(r.samo_fund));

  const series: Record<FlowSubject, number[]> = {
    foreign,
    inst,
    mainInst,
    combined: foreign.map((v, i) => v + inst[i]),
    foreignMain: foreign.map((v, i) => v + mainInst[i]),
  };

  const net = {} as AlgoResult["net"];
  const pass = {} as AlgoResult["pass"];
  for (const subject of Object.keys(series) as FlowSubject[]) {
    const perPeriod: Record<string, number> = {};
    let allPositive = true;
    for (const p of config.periods) {
      const total = sum(series[subject], p);
      perPeriod[String(p)] = total;
      if (total <= 0) allPositive = false;
    }
    net[subject] = perPeriod;
    pass[subject] = allPositive;
  }
  return { net, pass };
}

function passesBasicFilters(candidate: Candidate, config: AlgoConfig): boolean {
  if (config.minChangeRate !== null && candidate.fluRt < config.minChangeRate) return false;
  if (config.maxChangeRate !== null && candidate.fluRt > config.maxChangeRate) return false;
  if (config.minPrice !== null && candidate.curPrc < config.minPrice) return false;
  if (config.maxPrice !== null && candidate.curPrc > config.maxPrice) return false;
  return true;
}

async function runScan(jobId: string, client: KiwoomClient, config: AlgoConfig): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;

  try {
    const [kospi, kosdaq] = await Promise.all([
      fetchCandidates(client, "001", "코스피", config),
      fetchCandidates(client, "101", "코스닥", config),
    ]);
    job.usedPreviousDay = kospi.usedPreviousDay || kosdaq.usedPreviousDay;
    const candidates = [...kospi.candidates, ...kosdaq.candidates].filter((c) =>
      passesBasicFilters(c, config),
    );
    job.total = candidates.length;

    await runWithConcurrency(candidates, 2, async (candidate) => {
      try {
        const flow = await checkFlow(client, candidate.code, config);
        if (!flow) return;
        // 어느 주체도 통과하지 못하면 차트를 추가 조회하지 않는다 (호출 절약)
        if (!Object.values(flow.pass).some(Boolean)) return;

        const trend = await checkTrendAlignment(client, candidate.code, config);

        job.results.push({
          code: candidate.code,
          name: candidate.name,
          market: candidate.market,
          curPrc: candidate.curPrc,
          fluRt: candidate.fluRt,
          net: flow.net,
          pass: flow.pass,
          trendPass: trend ? trend.pass : null,
          ma: trend?.ma ?? null,
        });
      } catch {
        // 개별 종목 실패는 건너뛰고 계속 진행
      } finally {
        job.done += 1;
      }
    });

    job.status = "done";
  } catch (err) {
    job.status = "error";
    job.error = err instanceof Error ? err.message : "알 수 없는 오류";
  }
}

/** 클라이언트가 보낸 설정을 안전한 범위로 정규화한다 */
export function normalizeConfig(input: unknown): AlgoConfig {
  const raw = (input ?? {}) as Partial<AlgoConfig>;
  const nums = (v: unknown, fallback: number[]): number[] => {
    if (!Array.isArray(v)) return fallback;
    const cleaned = v.map(Number).filter((n) => Number.isFinite(n) && n > 0 && n <= 250);
    return cleaned.length > 0 ? [...new Set(cleaned)].sort((a, b) => a - b) : fallback;
  };
  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  return {
    candidateSort: raw.candidateSort === "1" || raw.candidateSort === "2" ? raw.candidateSort : "3",
    topN: Math.min(Math.max(Number(raw.topN) || DEFAULT_ALGO_CONFIG.topN, 10), 200),
    periods: nums(raw.periods, DEFAULT_ALGO_CONFIG.periods),
    maPeriods: nums(raw.maPeriods, DEFAULT_ALGO_CONFIG.maPeriods),
    requirePriceAboveMa: raw.requirePriceAboveMa !== false,
    minChangeRate: numOrNull(raw.minChangeRate),
    maxChangeRate: numOrNull(raw.maxChangeRate),
    minPrice: numOrNull(raw.minPrice),
    maxPrice: numOrNull(raw.maxPrice),
  };
}

export function startAlgoScan(client: KiwoomClient, config: AlgoConfig): string {
  const jobId = randomUUID();
  const job: AlgoJob = {
    status: "running",
    total: 0,
    done: 0,
    results: [],
    startedAt: Date.now(),
    config,
    usedPreviousDay: false,
  };
  jobs.set(jobId, job);
  void runScan(jobId, client, config);
  return jobId;
}

export function getAlgoJob(jobId: string): AlgoJob | undefined {
  return jobs.get(jobId);
}
