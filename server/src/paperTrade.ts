import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateSignal, type Level } from "./signalLight.js";
import { evaluateMarket } from "./marketSignal.js";
import { peekSnapshot } from "./marketSnapshot.js";
import { listThemes } from "./customThemes.js";
import { listSectorFlow } from "./sectorFlowStore.js";

/**
 * 모의투자 — 내 알고리즘을 증명하는 자리.
 *
 * 잔고 화면처럼 보이지만 목적이 다르다. 증권사 잔고는 "지금 얼마인가"만 말한다.
 * 여기서 답해야 하는 건 **"내 판단이 맞았나, 그리고 무엇을 보고 그렇게 판단했나"** 다.
 *
 * 그래서 살 때의 **근거를 통째로 박제한다.** 신호등 항목 하나하나가 그때 무엇이었는지,
 * 시장 전체는 어떤 상태였는지, 그 종목이 내 어느 테마에 속했는지, 업종에 돈이 들어오고
 * 있었는지. 나중에 결과를 보고 "이 조건일 때 나는 이겼다/졌다"를 셀 수 있어야
 * 알고리즘이 는다. 수익률만 남기면 운과 실력이 구분되지 않는다.
 *
 * 조회 전용 원칙은 그대로다 — 여기서 실제 주문은 절대 나가지 않는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "paperTrades.json");

/** 매수 시점에 박제하는 근거 */
export interface EntryEvidence {
  /** 종목 신호등 */
  level: Level;
  score: number;
  /** 통과/미달 항목을 값까지 남긴다 — 나중에 "무엇이 맞았나"를 세려면 값이 있어야 한다 */
  checks: { key: string; label: string; pass: boolean | null; value: string }[];
  /** 시장 전체 신호등 */
  market: { level: Level; score: number; summary: string } | null;
  /** 이 종목이 속한 내 테마와 그날 테마 등락률 */
  themes: { name: string; changeRate: number | null }[];
  /** 이 종목의 업종과, 그 업종에 최근 5일 외국인·기관이 얼마나 들어왔는지(억원) */
  sector: { name: string; foreign5: number; inst5: number } | null;
  /** 그날 시장 폭 — 시장 신호등 안에도 있지만 따로 뽑아 두면 집계가 쉽다 */
  marketBreadth: string | null;
}

export interface PaperTrade {
  id: string;
  code: string;
  name: string;
  /** 매수 */
  entryAt: string;
  entryPrice: number;
  qty: number;
  /** 왜 샀는가 — 사람이 쓴 한 줄. 이게 없으면 나중에 복기가 안 된다 */
  thesis: string;
  evidence: EntryEvidence;
  /** 매도 (안 팔았으면 null) */
  exitAt?: string | null;
  exitPrice?: number | null;
  /** 왜 팔았는가 */
  exitNote?: string | null;
}

async function readAll(): Promise<PaperTrade[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf-8")) as PaperTrade[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: PaperTrade[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(rows, null, 2), "utf-8");
}

export async function listTrades(): Promise<PaperTrade[]> {
  const rows = await readAll();
  return rows.sort((a, b) => b.entryAt.localeCompare(a.entryAt));
}

/**
 * 매수 시점의 근거를 모은다.
 *
 * 한 조각이라도 실패하면 그 자리만 비우고 나머지는 남긴다 — 근거를 못 모았다고
 * 기록 자체를 막으면, 정작 급할 때 못 담는다.
 */
async function captureEvidence(client: KiwoomClient, code: string): Promise<EntryEvidence> {
  const [sig, market, themes, flowDays] = await Promise.all([
    evaluateSignal(client, code).catch(() => null),
    evaluateMarket(client).catch(() => null),
    listThemes().catch(() => []),
    listSectorFlow(10).catch(() => []),
  ]);

  const snap = peekSnapshot();
  const stock = snap?.byCode.get(code) ?? null;

  /*
   * 내 테마 등락률은 스냅샷으로 그 자리에서 낸다.
   * evaluateThemes 를 부르면 전종목 스냅샷 재조회가 걸릴 수 있는데, 매수 버튼을 누른
   * 사람을 15초 기다리게 할 수는 없다.
   */
  const mine: { name: string; changeRate: number | null }[] = [];
  for (const t of themes) {
    if (!t.codes.includes(code)) continue;
    const rates = t.codes
      .map((c) => snap?.byCode.get(c)?.changeRate)
      .filter((x): x is number => typeof x === "number");
    mine.push({
      name: t.name,
      changeRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
    });
  }

  // 업종 수급 — 5일 누적. 이름으로 맞춘다 (스냅샷의 업종명과 ka10051 의 업종명이 같다)
  let sector: EntryEvidence["sector"] = null;
  if (stock?.sector) {
    let foreign5 = 0;
    let inst5 = 0;
    let hit = false;
    for (const day of flowDays.slice(-5)) {
      for (const row of [...day.kospi, ...day.kosdaq]) {
        if (row.name !== stock.sector) continue;
        hit = true;
        foreign5 += row.v[0] ?? 0;
        inst5 += row.v[1] ?? 0;
      }
    }
    sector = hit ? { name: stock.sector, foreign5, inst5 } : { name: stock.sector, foreign5: 0, inst5: 0 };
  }

  return {
    level: sig?.level ?? "unknown",
    score: sig?.score ?? 0,
    checks:
      sig?.checks.map((c) => ({ key: c.key, label: c.label, pass: c.pass, value: c.value })) ?? [],
    market: market ? { level: market.level, score: market.score, summary: market.summary } : null,
    themes: mine,
    sector,
    marketBreadth: market?.checks.find((c) => c.key === "breadth")?.value ?? null,
  };
}

export async function addTrade(
  client: KiwoomClient,
  input: { code: string; name: string; entryPrice: number; qty: number; thesis?: string },
): Promise<PaperTrade[]> {
  const rows = await readAll();
  const trade: PaperTrade = {
    id: `pt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`,
    code: input.code,
    name: input.name,
    entryAt: new Date().toISOString(),
    entryPrice: input.entryPrice,
    qty: Math.max(1, Math.round(input.qty)),
    thesis: (input.thesis ?? "").slice(0, 300),
    evidence: await captureEvidence(client, input.code),
  };
  rows.push(trade);
  await writeAll(rows);
  return listTrades();
}

export async function closeTrade(
  id: string,
  exitPrice: number,
  exitNote?: string,
): Promise<PaperTrade[]> {
  const rows = await readAll();
  const t = rows.find((x) => x.id === id);
  if (t) {
    t.exitAt = new Date().toISOString();
    t.exitPrice = exitPrice;
    t.exitNote = (exitNote ?? "").slice(0, 300);
  }
  await writeAll(rows);
  return listTrades();
}

export async function removeTrade(id: string): Promise<PaperTrade[]> {
  await writeAll((await readAll()).filter((x) => x.id !== id));
  return listTrades();
}

// ---------------------------------------------------------------- 평가

export interface EvaluatedTrade extends PaperTrade {
  /** 현재가 (청산했으면 청산가) */
  price: number;
  /** 평가손익(원) */
  pnl: number;
  returnRate: number;
  open: boolean;
  holdingDays: number;
}

export interface PaperStats {
  /** 총 투자원금 (열린 것 + 닫힌 것) */
  invested: number;
  /** 현재 평가액 */
  value: number;
  pnl: number;
  returnRate: number;
  openCount: number;
  closedCount: number;
  /** 청산분 승률 */
  winRate: number | null;
  /** 청산분 평균 수익률 */
  avgReturn: number | null;
}

/**
 * "이 조건일 때 나는 이겼나" — 근거별 성적.
 *
 * **이게 이 화면의 존재 이유다.** 수익률만 남기면 운과 실력이 구분되지 않는다.
 * 매수 시점에 박제해 둔 신호등 항목별로 승률을 갈라 보면, 내가 실제로 무엇을 보고
 * 이겼는지가 나온다 — 그리고 **믿고 있었지만 아무 상관 없던 조건**도 같이 드러난다.
 * 그게 알고리즘이 느는 유일한 길이다.
 */
export interface EvidenceEdge {
  key: string;
  label: string
  /** 이 조건을 통과한 상태에서 산 거래 */
  withCount: number;
  withWinRate: number | null;
  withAvgReturn: number | null;
  /** 통과 못 한 상태에서 산 거래 */
  withoutCount: number;
  withoutWinRate: number | null;
  withoutAvgReturn: number | null;
  /** 차이(%p) — 클수록 이 조건이 실제로 값어치를 했다는 뜻 */
  edge: number | null;
}

function evaluate(t: PaperTrade, priceOf: (code: string) => number | null): EvaluatedTrade {
  const closed = typeof t.exitPrice === "number";
  const price = closed ? (t.exitPrice as number) : priceOf(t.code) ?? t.entryPrice;
  const pnl = (price - t.entryPrice) * t.qty;
  const end = closed && t.exitAt ? new Date(t.exitAt).getTime() : Date.now();
  return {
    ...t,
    price,
    pnl,
    returnRate: t.entryPrice > 0 ? ((price - t.entryPrice) / t.entryPrice) * 100 : 0,
    open: !closed,
    holdingDays: Math.max(0, Math.floor((end - new Date(t.entryAt).getTime()) / 86400_000)),
  };
}

const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const winRate = (xs: number[]) =>
  xs.length > 0 ? (xs.filter((r) => r > 0).length / xs.length) * 100 : null;

export function edgeOf(trades: EvaluatedTrade[]): EvidenceEdge[] {
  /*
   * 청산한 거래만 센다. 아직 들고 있는 건 결과가 안 나온 것이라, 섞으면
   * "지금 물려 있는 것"이 실패로 잡히거나 반대로 평가익이 성공으로 잡힌다.
   */
  const done = trades.filter((t) => !t.open);
  if (done.length === 0) return [];

  const keys = new Map<string, string>();
  for (const t of done) for (const c of t.evidence.checks) keys.set(c.key, c.label);

  const rows: EvidenceEdge[] = [];
  for (const [key, label] of keys) {
    const withR: number[] = [];
    const withoutR: number[] = [];
    for (const t of done) {
      const c = t.evidence.checks.find((x) => x.key === key);
      if (!c || c.pass === null) continue; // 판단 못 한 건 어느 쪽에도 안 넣는다
      (c.pass ? withR : withoutR).push(t.returnRate);
    }
    const wWin = winRate(withR);
    const oWin = winRate(withoutR);
    rows.push({
      key,
      label,
      withCount: withR.length,
      withWinRate: wWin,
      withAvgReturn: avg(withR),
      withoutCount: withoutR.length,
      withoutWinRate: oWin,
      withoutAvgReturn: avg(withoutR),
      // 양쪽 다 있어야 비교가 된다. 한쪽뿐이면 차이를 낼 수 없다
      edge: wWin !== null && oWin !== null ? wWin - oWin : null,
    });
  }
  // 값어치가 큰 조건부터
  return rows.sort((a, b) => (b.edge ?? -999) - (a.edge ?? -999));
}

export async function evaluateTrades(
  client: KiwoomClient,
): Promise<{ trades: EvaluatedTrade[]; stats: PaperStats; edges: EvidenceEdge[] }> {
  const rows = await listTrades();
  // 현재가는 스냅샷에서 — 종목마다 조회하면 보유 20종목에 20회다
  const snap = peekSnapshot();
  const priceOf = (code: string) => snap?.byCode.get(code)?.price ?? null;
  const trades = rows.map((t) => evaluate(t, priceOf));

  const invested = trades.reduce((s, t) => s + t.entryPrice * t.qty, 0);
  const value = trades.reduce((s, t) => s + t.price * t.qty, 0);
  const closedReturns = trades.filter((t) => !t.open).map((t) => t.returnRate);

  return {
    trades,
    stats: {
      invested,
      value,
      pnl: value - invested,
      returnRate: invested > 0 ? ((value - invested) / invested) * 100 : 0,
      openCount: trades.filter((t) => t.open).length,
      closedCount: closedReturns.length,
      winRate: winRate(closedReturns),
      avgReturn: avg(closedReturns),
    },
    edges: edgeOf(trades),
  };
}
