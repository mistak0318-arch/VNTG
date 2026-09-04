import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { listRules, type SimRule } from "./simRules.js";
import { newState, step, summarize, type SimResult, type SimState } from "./simEngine.js";
import { series, stockBars, type Point } from "./simSeries.js";

/**
 * 시뮬레이터 **실전 진행** (2026-09-04).
 *
 * 벤티지: "백테스트해서 돌려보고 실제 시장 흐름에서도 돌려보는 실전 테스트 같은 거야.
 * … 각각의 종목에 조건 걸고 정지·진행 이렇게 할 수 있게."
 *
 * ## 백테스트와 **같은 엔진**을 쓴다
 *
 * 여기서 하는 일은 「어제까지 안 처리한 날들을 하루씩 `step()` 에 넣는다」가 전부다.
 * 판단하는 코드는 한 줄도 없다 — 있으면 그 순간 백테스트와 실전이 갈린다.
 * 갈리면 「과거에 이랬으면 이랬다」가 거짓이 되고, 그게 이 도구의 존재 이유다.
 *
 * ## 왜 종가 확정 뒤에만 도나
 *
 * 조건이 종가로 판정된다. 장중에 돌리면 아직 안 정해진 값으로 사고파는 셈이라,
 * 같은 날을 두 번 돌리면 다른 답이 나온다. 그래서 **일봉 창고에 그날 봉이 들어온 뒤**에만
 * 한 걸음 나간다 — 시각이 아니라 **자료가 왔는가**를 본다(마감 파이프라인이 늦어도 맞는다).
 *
 * ## 정지 중인 규칙
 *
 * 안 돈다. 그리고 **밀린 날을 나중에 몰아서 처리하지도 않는다** — 정지시켜 둔 동안의
 * 시세를 나중에 알고 나서 채우면 그건 미래를 본 성적이다. 다시 켜면 **그날부터** 간다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "simLive.json");

export interface LiveRow extends SimState {
  ruleId: string;
  /** 마지막으로 처리한 거래일 (YYYYMMDD) */
  lastDate: string | null;
  /** 언제부터 굴렸나 */
  startedAt: string | null;
}

interface Store {
  rows: Record<string, LiveRow>;
}

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Partial<Store>;
    cache = { rows: raw.rows ?? {} };
  } catch {
    cache = { rows: {} };
  }
  return cache;
}

async function save(s: Store): Promise<void> {
  cache = s;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s), "utf8");
}

function blank(rule: SimRule): LiveRow {
  return { ruleId: rule.id, lastDate: null, startedAt: null, ...newState(rule.seed) };
}

/** 규칙 하나를 **오늘까지** 따라잡는다. 처리한 날 수를 돌려준다 */
export async function advance(client: KiwoomClient, rule: SimRule): Promise<number> {
  const s = await load();
  const row = s.rows[rule.id] ?? blank(rule);
  const all = await stockBars(rule.code);
  if (all.length === 0) return 0;

  /*
   * 처음 켜는 규칙은 **오늘부터**다. 창고에 있는 500일을 몰아서 처리하면 그건
   * 백테스트지 실전이 아니다 — 그리고 성적이 백테스트와 뒤섞여 무엇을 본 것인지 흐려진다.
   */
  if (row.lastDate === null) {
    row.lastDate = all[all.length - 1].d;
    row.startedAt = new Date().toISOString();
    s.rows[rule.id] = row;
    await save(s);
    return 0;
  }

  const pending = all.filter((b) => b.d > (row.lastDate as string));
  if (pending.length === 0) return 0;

  const keys = [
    ...new Set([...rule.buy, ...rule.sell].filter((c) => c.src === "series").map((c) => c.key ?? "")),
  ].filter(Boolean);
  const ext = new Map<string, Point[]>();
  for (const k of keys) ext.set(k, await series(client, k));
  const stock: Point[] = all.map((b) => ({ d: b.d, c: b.c }));

  for (const b of pending) {
    step(rule, row, b.d, b.c, stock, ext);
    row.lastDate = b.d;
  }
  s.rows[rule.id] = row;
  await save(s);
  return pending.length;
}

/** 진행 중인 규칙 전부를 한 걸음씩 */
export async function advanceAll(client: KiwoomClient): Promise<{ ruleId: string; steps: number }[]> {
  const out: { ruleId: string; steps: number }[] = [];
  for (const rule of await listRules()) {
    if (!rule.enabled) continue;
    try {
      out.push({ ruleId: rule.id, steps: await advance(client, rule) });
    } catch (e) {
      console.error(`[sim] ${rule.name} 진행 실패:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

/** 화면이 보는 실전 성적 — 백테스트와 **같은 요약**을 쓴다 */
export async function liveResult(rule: SimRule): Promise<(SimResult & { startedAt: string | null }) | null> {
  const s = await load();
  const row = s.rows[rule.id];
  if (!row) return null;
  const bars = row.curve.map((p) => ({ d: p.d, c: 0 }));
  const all = await stockBars(rule.code);
  const byDate = new Map(all.map((b) => [b.d, b.c]));
  for (const b of bars) b.c = byDate.get(b.d) ?? 0;
  return { ...summarize(rule, row, bars), startedAt: row.startedAt };
}

/** 규칙을 지우면 장부도 같이 — 남겨 두면 다음에 같은 id 가 나올 때 남의 성적을 물려받는다 */
export async function dropLive(ruleId: string): Promise<void> {
  const s = await load();
  if (s.rows[ruleId]) {
    delete s.rows[ruleId];
    await save(s);
  }
}

/** 처음부터 다시 — 규칙을 고쳤으면 옛 장부는 다른 규칙의 성적이다 */
export async function resetLive(ruleId: string): Promise<void> {
  await dropLive(ruleId);
}

let timer: NodeJS.Timeout | null = null;

/**
 * 30분마다 본다 — **시각이 아니라 자료가 왔는가**를 본다.
 * 일봉이 아직이면 `advance` 가 처리할 날이 없어 아무 일도 안 한다.
 */
export function startSimScheduler(client: KiwoomClient): void {
  if (timer) return;
  const tick = () => void advanceAll(client).catch(() => undefined);
  setTimeout(tick, 60_000);
  timer = setInterval(tick, 30 * 60_000);
}
