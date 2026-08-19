import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateSignal, type Level, type SignalResult } from "./signalLight.js";
import { getCommonStockCodes } from "./stockListCache.js";

/**
 * 신호등 스크리너 — 거래대금 상위에서 내 기준에 맞는 종목을 찾는다.
 *
 * 지금까지 신호등은 **이미 아는 종목을 확인하는 용도**였다. 그런데 정작 필요한 건
 * "내 기준에 맞는 종목이 지금 시장에 뭐가 있나"다.
 *
 * 모집단은 **거래대금 상위**로 잡았다. 전종목을 돌리면 종목당 3~4회 조회라 감당이 안 되고,
 * 무엇보다 거래대금이 없는 종목은 신호가 맞아도 못 산다. 돈이 몰린 곳에서 고르는 게 맞다.
 *
 * 종목당 여러 번 조회하므로 **무겁다.** 그래서:
 *   - 진행 상황을 볼 수 있게 job 방식으로 돌린다 (algoScan 과 같은 구조)
 *   - 신호등 자체 캐시(15분)를 그대로 타므로 두 번째 실행은 훨씬 빠르다
 */

const RKINFO = "/api/dostk/rkinfo";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const HISTORY_FILE = join(DATA_DIR, "screenHistory.json");

export interface ScreenHit {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  /** 거래대금(백만원) */
  tradeValue: number;
  level: Level;
  score: number;
  /** 통과한 항목 이름 */
  passed: string[];
  /** 미달한 항목 이름 */
  failed: string[];
}

export interface ScreenJob {
  status: "running" | "done" | "error";
  /** 검사 대상 수 */
  total: number;
  done: number;
  /** 지금까지 나온 결과 (점수 높은 순) */
  results: ScreenHit[];
  market: string;
  minLevel: Level;
  startedAt: string;
  error?: string;
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function bare(code: unknown): string {
  return String(code ?? "").replace(/_AL$/, "").trim();
}

export interface Candidate {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  tradeValue: number;
}

/**
 * 거래대금 상위 — ka10032.
 *
 * 한 번에 100건씩 오므로 필요하면 이어받는다. **ETF·ETN·우선주를 빼고 나서** 세므로
 * "상위 100종목"은 실제 종목 100개를 뜻한다. (거래대금 상위 100건 중 30~40건이 ETF다)
 */
/**
 * 거래대금 상위 **실제 종목**.
 *
 * 추적기도 같은 것을 쓴다 — 「신호등 찾기」와 모집단이 다르면 같은 종목을 두고
 * 한쪽은 담고 한쪽은 안 담는다. 그러면 추적기가 검증하는 게 신호등이 아니라
 * **두 모집단의 차이**가 된다.
 */
export async function tradeValueTop(
  client: KiwoomClient,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  const common = await getCommonStockCodes(client);
  const out: Candidate[] = [];
  let contYn = "N";
  let nextKey = "";

  // 최대 4페이지(400건)까지만 — 그 아래는 거래대금이 얇아 어차피 못 산다
  for (let page = 0; page < 4 && out.length < limit; page += 1) {
    const res = await client.request<Record<string, unknown>>(
      RKINFO,
      "ka10032",
      {
        mrkt_tp: market,
        mang_stk_incls: "0", // 관리종목 제외 — 신호가 맞아도 들어갈 자리가 아니다
        stex_tp: "3",
      },
      page === 0 ? {} : { contYn, nextKey },
    );
    const rows = Array.isArray(res.data.trde_prica_upper)
      ? (res.data.trde_prica_upper as Record<string, unknown>[])
      : [];
    if (rows.length === 0) break;

    for (const r of rows) {
      const code = bare(r.stk_cd);
      if (!common.has(code)) continue; // ETF·ETN·리츠·우선주
      out.push({
        code,
        name: String(r.stk_nm ?? "").trim(),
        price: toNum(r.cur_prc),
        changeRate: Number(String(r.flu_rt ?? "").replace(/[+,\s]/g, "")) || 0,
        tradeValue: toNum(r.trde_prica),
      });
      if (out.length >= limit) break;
    }

    if (res.contYn !== "Y" || !res.nextKey) break;
    contYn = "Y";
    nextKey = res.nextKey;
    await new Promise((r) => setTimeout(r, 260));
  }
  return out;
}

const LEVEL_RANK: Record<Level, number> = { green: 3, yellow: 2, red: 1, unknown: 0 };

const jobs = new Map<string, ScreenJob>();

/** 오래된 작업은 치운다 — 메모리에만 두므로 서버를 재시작하면 사라진다 */
function prune(): void {
  if (jobs.size < 20) return;
  const old = [...jobs.entries()]
    .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt))
    .slice(0, 10);
  for (const [id] of old) jobs.delete(id);
}

export function getScreenJob(id: string): ScreenJob | undefined {
  return jobs.get(id);
}

/**
 * 지난 스크리닝 결과.
 *
 * 매번 새로 돌려야 하면 **어제 뭐가 걸렸는지 볼 수가 없다.** 그런데 이 화면의 값어치는
 * 오늘 목록보다 오히려 흐름에 있다 — 사흘째 계속 걸리는 종목과 오늘 처음 뜬 종목은
 * 전혀 다른 얘기다. 그래서 끝난 작업은 디스크에 남긴다.
 *
 * 결과만 남기고 작업 상태는 버린다. 다시 열 때 필요한 건 "그때 뭐가 걸렸나"뿐이다.
 */
export interface ScreenRun {
  id: string;
  at: string;
  market: string;
  minLevel: Level;
  /** 검사한 종목 수 */
  total: number;
  results: ScreenHit[];
}

const KEEP_RUNS = 40;

async function readHistory(): Promise<ScreenRun[]> {
  try {
    const parsed = JSON.parse(await readFile(HISTORY_FILE, "utf-8")) as ScreenRun[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveRun(run: ScreenRun): Promise<void> {
  const rows = await readHistory();
  rows.push(run);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(rows.slice(-KEEP_RUNS)), "utf-8");
}

/** 최신순 목록. 본문(results)까지 주면 무거우므로 요약만 */
export async function listScreenRuns(): Promise<
  { id: string; at: string; market: string; minLevel: Level; total: number; hits: number }[]
> {
  const rows = await readHistory();
  return rows
    .map((r) => ({
      id: r.id,
      at: r.at,
      market: r.market,
      minLevel: r.minLevel,
      total: r.total,
      hits: r.results.length,
    }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

export async function getScreenRun(id: string): Promise<ScreenRun | null> {
  return (await readHistory()).find((r) => r.id === id) ?? null;
}

/**
 * 두 회차를 견줘 **새로 들어온 종목과 빠진 종목**을 낸다.
 *
 * 목록을 나란히 놓고 사람이 눈으로 맞춰 보는 건 못 할 일이다.
 * 오늘 처음 뜬 종목이 어느 것인지가 이 화면에서 제일 알고 싶은 것이다.
 */
export async function diffScreenRuns(
  fromId: string,
  toId: string,
): Promise<{ added: ScreenHit[]; removed: ScreenHit[]; stayed: ScreenHit[] } | null> {
  const rows = await readHistory();
  const a = rows.find((r) => r.id === fromId);
  const b = rows.find((r) => r.id === toId);
  if (!a || !b) return null;
  const before = new Set(a.results.map((r) => r.code));
  const after = new Set(b.results.map((r) => r.code));
  return {
    added: b.results.filter((r) => !before.has(r.code)),
    removed: a.results.filter((r) => !after.has(r.code)),
    stayed: b.results.filter((r) => before.has(r.code)),
  };
}

/**
 * 스크리닝 시작. 곧바로 jobId 를 돌려주고 뒤에서 계속 돈다.
 *
 * @param market 000 전체 / 001 코스피 / 101 코스닥
 * @param minLevel 이 등급 이상만 결과에 남긴다
 * @param limit 거래대금 상위 몇 개를 검사할지
 */
export function startScreen(
  client: KiwoomClient,
  opts: { market?: string; minLevel?: Level; limit?: number } = {},
): string {
  const market = ["000", "001", "101"].includes(String(opts.market)) ? String(opts.market) : "000";
  const minLevel = opts.minLevel ?? "green";
  const limit = Math.min(Math.max(opts.limit ?? 100, 10), 200);

  const id = `scr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job: ScreenJob = {
    status: "running",
    total: 0,
    done: 0,
    results: [],
    market,
    minLevel,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  prune();

  void (async () => {
    try {
      const universe = await tradeValueTop(client, market, limit);
      job.total = universe.length;

      for (const u of universe) {
        try {
          const sig: SignalResult = await evaluateSignal(client, u.code);
          if (LEVEL_RANK[sig.level] >= LEVEL_RANK[minLevel]) {
            job.results.push({
              ...u,
              level: sig.level,
              score: sig.score,
              passed: sig.checks.filter((c) => c.pass === true).map((c) => c.label),
              failed: sig.checks.filter((c) => c.pass === false).map((c) => c.label),
            });
            // 점수 높은 순 — 진행 중에도 화면에서 바로 볼 수 있게 매번 정렬한다
            job.results.sort((a, b) => b.score - a.score || b.tradeValue - a.tradeValue);
          }
        } catch {
          // 한 종목 실패가 전체를 막지 않게
        }
        job.done += 1;
        // 신호등 하나가 여러 TR을 부르므로 간격을 넉넉히 둔다
        await new Promise((r) => setTimeout(r, 260));
      }
      job.status = "done";
      // 결과가 없어도 남긴다 — "이날은 아무것도 안 걸렸다"도 정보다
      await saveRun({
        id,
        at: job.startedAt,
        market,
        minLevel,
        total: job.total,
        results: job.results,
      }).catch(() => undefined);
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : "스크리닝 실패";
    }
  })();

  return id;
}
