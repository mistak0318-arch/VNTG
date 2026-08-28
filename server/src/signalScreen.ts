import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cumulativeRank } from "./cumulativeRank.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { COMMON_PARAMS, findSpec } from "./rankSpecs.js";
import { evaluateSignal, type Level, type SignalResult } from "./signalLight.js";
import { getCommonStockCodes } from "./stockListCache.js";
import { stockLens, themeMapNow } from "./stockLens.js";

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
  /** 렌즈 (2026-08-28) — 이 종목의 무리(가장 강한 사업 테마)와 ETF 뒷배. 조회 0회 */
  theme?: { key: string; name: string; changeRate: number; streak: number } | null;
  etfBack?: { rate: number; top: string } | null;
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
  /** 어느 목록에서 찾았나 — SCREEN_UNIVERSES 의 key */
  universe: string;
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

// ---------------------------------------------------------------- 모집단

/**
 * 어디서 찾을 것인가 (2026-08-25).
 *
 * 지금까지 모집단은 거래대금 상위뿐이었다. 그런데 우리는 이미 다른 목록들을 갖고
 * 있다 — 외국인 연속순매매, 동일순매매, 누적등락률… **어느 목록에서 초록이 잘
 * 나오는가** 자체가 물음이다. 등락률 상위의 초록(이미 오른 것)과 연속매매의
 * 초록(수급이 미는 것)은 다른 종류의 후보다.
 *
 * 전부 **이미 있는 조회**를 그대로 쓴다 — 시세분석 명세(rankSpecs)와 각 화면의
 * TR. 새 TR 을 만들지 않는다.
 */
export const SCREEN_UNIVERSES: { key: string; label: string; hint: string }[] = [
  { key: "trade-value", label: "거래대금 상위", hint: "돈이 몰린 곳 — 기본. 최대 500까지 이어받는다" },
  { key: "flu-rate", label: "등락률 상위", hint: "오늘 가장 오른 종목 — 이미 오른 것 중에 더 갈 것을 찾는다" },
  { key: "cum", label: "누적등락률 상위 (5일)", hint: "닷새 누적으로 오른 종목 — 하루 급등보다 흐름" },
  { key: "foreign-cont", label: "외국인 연속순매매", hint: "외국인이 며칠째 사는 종목" },
  { key: "cont", label: "기관·외국인 연속매매", hint: "두 주체가 같이 사는 종목 (ka10131)" },
  { key: "same-net", label: "동일순매매 상위 (7일)", hint: "최근 7일 기관·외국인이 같은 방향으로 순매수" },
  { key: "intraday-investor", label: "장중 기관 매매상위", hint: "지금 장중 기관 순매수 상위 — 장중에만 값이 있다" },
];

function yyyymmdd(daysAgo = 0): string {
  const d = new Date(Date.now() + 9 * 3600_000 - daysAgo * 86400_000);
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

/** 가격·등락률이 빈 줄(연속매매·장중투자자 TR 은 현재가를 안 준다)을 스냅샷으로 메운다 */
async function fillMissing(client: KiwoomClient, rows: Candidate[]): Promise<void> {
  if (!rows.some((r) => r.price === 0)) return;
  const snap = await getMarketSnapshot(client).catch(() => null);
  if (!snap) return;
  for (const r of rows) {
    if (r.price > 0) continue;
    const s = snap.byCode.get(r.code);
    if (!s) continue;
    r.price = s.price;
    r.changeRate = s.changeRate;
  }
}

/** 시세분석 명세(rankSpecs)에 있는 조회를 모집단으로 — 연속조회로 limit 까지 */
async function rankSpecUniverse(
  client: KiwoomClient,
  specKey: string,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  const spec = findSpec(specKey);
  if (!spec) throw new Error(`없는 조회입니다: ${specKey}`);
  const common = await getCommonStockCodes(client);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  let contYn = "N";
  let nextKey = "";
  for (let page = 0; page < 6 && out.length < limit; page += 1) {
    const res = await client.request<Record<string, unknown>>(
      `/api/dostk/${spec.uri}`,
      spec.apiId,
      {
        ...COMMON_PARAMS,
        ...(spec.params ?? {}),
        mrkt_tp: market,
        // ⚠️ 항상 보낸다 — 시세분석 라우트도 그렇다. ka10035 는 exchange 표시가
        // 없는데도 stex_tp 가 필수라(1511), 조건부로 보내면 그 조회가 통째로 죽는다
        stex_tp: "3",
      },
      page === 0 ? {} : { contYn, nextKey },
    );
    const rows = Array.isArray(res.data[spec.listKey])
      ? (res.data[spec.listKey] as Record<string, unknown>[])
      : [];
    if (rows.length === 0) break;
    for (const r of rows) {
      const code = bare(r.stk_cd);
      if (!code || !common.has(code) || seen.has(code)) continue;
      seen.add(code);
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
  await fillMissing(client, out);
  return out;
}

/** 동일순매매 (ka10062) — 화면과 같은 조건: 최근 7일 · 순매수 · 금액순 */
async function sameNetUniverse(
  client: KiwoomClient,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  const common = await getCommonStockCodes(client);
  const { data } = await client.request<Record<string, unknown>>(RKINFO, "ka10062", {
    strt_dt: yyyymmdd(7),
    end_dt: yyyymmdd(0),
    mrkt_tp: market,
    trde_tp: "1",
    sort_cnd: "2",
    unit_tp: "1",
    stex_tp: "1",
  });
  const rows = Array.isArray(data.eql_nettrde_rank)
    ? (data.eql_nettrde_rank as Record<string, unknown>[])
    : [];
  const out: Candidate[] = [];
  for (const r of rows) {
    const code = bare(r.stk_cd);
    if (!code || !common.has(code)) continue;
    out.push({
      code,
      name: String(r.stk_nm ?? "").trim(),
      price: toNum(r.cur_prc),
      changeRate: Number(String(r.flu_rt ?? "").replace(/[+,\s]/g, "")) || 0,
      tradeValue: 0,
    });
    if (out.length >= limit) break;
  }
  await fillMissing(client, out);
  return out;
}

/**
 * 기관·외국인 연속매매 (ka10131) — 화면과 같은 조건.
 * ⚠️ 이 TR 은 전체(000)가 없다 — 000 이면 코스피·코스닥을 받아 합친다.
 * 현재가를 안 주므로 스냅샷으로 메운다.
 */
async function contUniverse(
  client: KiwoomClient,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  const common = await getCommonStockCodes(client);
  const markets = market === "000" ? ["001", "101"] : [market];
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const m of markets) {
    const { data } = await client
      .request<Record<string, unknown>>("/api/dostk/frgnistt", "ka10131", {
        dt: "1",
        strt_dt: "",
        end_dt: "",
        mrkt_tp: m,
        netslmt_tp: "2",
        stk_inds_tp: "0",
        amt_qty_tp: "0",
        stex_tp: "1",
      })
      .catch(() => ({ data: {} as Record<string, unknown> }));
    const rows = Array.isArray(data.orgn_frgnr_cont_trde_prst)
      ? (data.orgn_frgnr_cont_trde_prst as Record<string, unknown>[])
      : [];
    for (const r of rows) {
      const code = bare(r.stk_cd);
      if (!code || !common.has(code) || seen.has(code)) continue;
      seen.add(code);
      out.push({
        code,
        name: String(r.stk_nm ?? "").trim(),
        price: 0, // 이 TR 은 현재가를 안 준다 — 아래 스냅샷이 메운다
        changeRate: 0,
        tradeValue: 0,
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  await fillMissing(client, out);
  return out;
}

/** 모집단 하나를 받아 온다 — 어느 키든 Candidate[] 로 통일. 슈퍼신호등도 이걸 쓴다 */
export async function fetchUniverse(
  client: KiwoomClient,
  key: string,
  market: string,
  limit: number,
): Promise<Candidate[]> {
  if (key === "trade-value") return tradeValueTop(client, market, limit);
  if (key === "cum") {
    const r = await cumulativeRank(client, market, 5, Math.min(200, Math.max(limit, 100)));
    return r.rows.slice(0, limit).map((c) => ({
      code: c.code,
      name: c.name,
      price: c.price,
      changeRate: c.todayRate,
      tradeValue: c.tradeValue,
    }));
  }
  if (key === "same-net") return sameNetUniverse(client, market, limit);
  if (key === "cont") return contUniverse(client, market, limit);
  return rankSpecUniverse(client, key, market, limit);
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
 * 지금 돌고 있는 찾기 — **전역 작업 띠와 화면 복귀용** (2026-08-25).
 *
 * 채널 검색과 같은 문제였다: 찾기를 걸고 다른 메뉴로 가면 진행을 볼 방법이 없고,
 * 돌아와도 jobId 를 잃어 이어받지 못했다. 서버가 어차피 작업을 들고 있으니
 * 「지금 도는 것」을 물어볼 수 있게 한다 — 화면 상태를 어디 저장할 필요가 없다.
 */
export function activeScreenJobs(): {
  id: string;
  done: number;
  total: number;
  market: string;
  universe: string;
  universeLabel: string;
  hits: number;
}[] {
  return [...jobs.entries()]
    .filter(([, j]) => j.status === "running")
    .map(([id, j]) => ({
      id,
      done: j.done,
      total: j.total,
      market: j.market,
      universe: j.universe,
      universeLabel: SCREEN_UNIVERSES.find((u) => u.key === j.universe)?.label ?? j.universe,
      hits: j.results.length,
    }));
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
  /** 어느 목록에서 찾았나 — 예전 기록에는 없다(거래대금 상위였다) */
  universe?: string;
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
  { id: string; at: string; market: string; minLevel: Level; universe?: string; total: number; hits: number }[]
> {
  const rows = await readHistory();
  return rows
    .map((r) => ({
      id: r.id,
      at: r.at,
      market: r.market,
      minLevel: r.minLevel,
      universe: r.universe,
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
  opts: { market?: string; minLevel?: Level; limit?: number; universe?: string } = {},
): string {
  const market = ["000", "001", "101"].includes(String(opts.market)) ? String(opts.market) : "000";
  const minLevel = opts.minLevel ?? "green";
  /*
   * 상한을 200 에서 500 으로 올렸다. 상위 백 개는 이미 다 아는 종목이라 **새로 걸리는 건
   * 그 아래**에서 나온다. 종목마다 조회가 나가므로 오백이면 한참 걸리지만, 그건 화면이
   * 진행바로 알려 주고 사람이 고른 값이다. 숫자는 이제 화면에서 자유 입력이다.
   */
  const limit = Math.min(Math.max(opts.limit ?? 100, 10), 500);
  const uniKey = SCREEN_UNIVERSES.some((u) => u.key === opts.universe)
    ? String(opts.universe)
    : "trade-value";

  const id = `scr_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job: ScreenJob = {
    status: "running",
    total: 0,
    done: 0,
    results: [],
    market,
    minLevel,
    universe: uniKey,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  prune();

  void (async () => {
    try {
      const universe = await fetchUniverse(client, uniKey, market, limit);
      job.total = universe.length;
      /* 렌즈 — 테마 강도 한 벌을 잡 시작에 받아 두고(수십 ms) 걸린 종목마다 붙인다 */
      const themeMap = await themeMapNow().catch(() => new Map() as Awaited<ReturnType<typeof themeMapNow>>);

      for (const u of universe) {
        try {
          const sig: SignalResult = await evaluateSignal(client, u.code);
          if (LEVEL_RANK[sig.level] >= LEVEL_RANK[minLevel]) {
            const lens = await stockLens(u.code, themeMap).catch(() => ({ theme: null, etfBack: null }));
            job.results.push({
              ...u,
              level: sig.level,
              score: sig.score,
              passed: sig.checks.filter((c) => c.pass === true).map((c) => c.label),
              failed: sig.checks.filter((c) => c.pass === false).map((c) => c.label),
              ...lens,
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
        universe: uniKey,
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
