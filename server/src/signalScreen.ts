import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
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
  /**
   * **오늘 거래가 아직 없어 직전 거래일 값으로 메운 줄인가.**
   *
   * 개장 전에 돌리면 `ka10032` 가 등락률도 거래대금도 0 으로 준다. 그걸 그대로
   * 보여주면 화면에 **「0.00% · 0억」이 늘어서고**, 시세분석은 같은 종목을 두고
   * 전일 값을 말하니 두 화면이 다른 소리를 한다. 실제로 07:26 에 그 일이 났다.
   *
   * 0 은 「안 움직였다」가 아니라 **「아직 안 열렸다」**다. 그 둘은 다른 말이므로
   * 같은 0 으로 적으면 안 된다. 직전 거래일 값으로 메우고 **메웠다고 표시한다.**
   */
  stale?: boolean;
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

  /*
   * 페이지를 넘기며 채운다.
   *
   * ⚠️ 4페이지(400건)로 막혀 있었다. 그런데 **보통주만 남기므로** 400건을 받아도
   * 손에 남는 건 그보다 훨씬 적다 — 거래대금 상위에는 KODEX·TIGER 같은 ETF 와 우선주가
   * 잔뜩 섞여 있다. 실시간 구독을 500 종목으로 올리면서 여기가 병목이 됐다.
   *
   * ⚠️ 그다음 여덟 페이지로 늘렸는데 **그것도 모자랐다.** 「상위 500」을 골랐더니
   * 화면에 「421/421 검사」가 떴다 — 800건에서 ETF·우선주를 빼면 421개뿐이었다.
   * 500을 고른 사람은 500을 봤다고 믿는데 실제로는 421을 본 것이다.
   *
   * 그래서 **요청한 수를 채울 때까지** 넘긴다. 넉넉히 스무 쪽까지 두되, 채우면
   * 그 자리에서 멈추므로 적게 부르면 예전처럼 한두 페이지에서 끝난다.
   */
  for (let page = 0; page < 20 && out.length < limit; page += 1) {
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
        // 키움은 하락 종목의 현재가를 음수로 준다 — 부호를 떼야 「−52,300원」이 안 뜬다
        price: Math.abs(toNum(r.cur_prc) ?? 0),
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

  await fillStale(client, out);
  return out;
}

/**
 * 개장 전이라 0 으로 온 줄을 **직전 거래일 값**으로 메운다.
 *
 * 전종목 스냅샷은 「거래가 반영된 것」만 저장하도록 이미 막아 뒀다(`traded`). 그래서
 * 개장 전에 읽으면 **직전 거래일 종가와 등락률**이 들어 있다 — 우리가 필요한 게 그것이다.
 *
 * 거래대금은 스냅샷에 없다. 지어내지 않고 0 으로 두면 화면이 「-」로 적는다 —
 * **못 내는 값을 어림해서 채우지 않는다.**
 *
 * 스냅샷도 0 이면 아무것도 안 한다. 그때는 정말 값이 없는 것이고, `stale` 도 안 붙여
 * **거짓 표시를 만들지 않는다.**
 */
async function fillStale(client: KiwoomClient, rows: Candidate[]): Promise<void> {
  // 오늘 거래가 하나라도 잡혔으면 개장 전이 아니다 — 스냅샷을 부를 이유가 없다
  if (rows.length === 0 || rows.some((r) => r.tradeValue > 0)) return;

  const snap = await getMarketSnapshot(client).catch(() => null);
  if (!snap) return;

  for (const r of rows) {
    const s = snap.byCode.get(r.code);
    if (!s || (s.changeRate === 0 && s.price === 0)) continue;
    if (s.price > 0) r.price = s.price;
    r.changeRate = s.changeRate;
    r.stale = true;
  }
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
  /*
   * 상한을 200 에서 500 으로 올렸다. 상위 백 개는 이미 다 아는 종목이라 **새로 걸리는 건
   * 그 아래**에서 나온다. 종목마다 조회가 나가므로 오백이면 한참 걸리지만, 그건 화면이
   * 진행바로 알려 주고 사람이 고른 값이다.
   */
  const limit = Math.min(Math.max(opts.limit ?? 100, 10), 500);

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
