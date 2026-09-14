import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EvaluatedAccount } from "./manualAccounts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "manualAccountHistory.json");

/**
 * 수동 계좌의 **총 잔액 흐름** (2026-09-14 — 벤티지: "수동계좌에 계좌 총 잔액 흐름 볼 수 있게
 * 그래프로 표현해 줄 수 있나? 펼쳤을 때 말야. 일별·주별·월별로 수익률 현황 볼 수 있게").
 *
 * ## 왜 따로 쌓아야 하나
 *
 * 연동 계좌는 키움이 일별 추정예탁자산(`kt00002`)을 준다. **수동 계좌는 줄 사람이 없다** —
 * 우리가 들고 있는 건 평단과 수량뿐이고, 어제 이 계좌가 얼마였는지는 아무 데도 없다.
 *
 * ## 지어내지 않는다
 *
 * 지금 보유 종목에 과거 주가를 곱해서 「그때도 이만큼이었다」를 그릴 수는 있다. **안 한다.**
 * 그건 그때 그 종목을 그만큼 들고 있었다는 가정인데 사실이 아니고, 사고판 것과 입출금이
 * 전부 지워진 그림이라 보고 판단하면 틀린다. 그래서 **오늘부터 하루 한 점씩 쌓는다.**
 * 처음엔 점이 하나뿐이라 그래프가 비어 보이는 것이 맞다 — 화면이 그렇게 말한다.
 *
 * ## 무엇을 남기나
 *
 * 하루 한 점, 계좌마다. 같은 날 여러 번 부르면 **마지막 값으로 덮는다** — 장중에 계속
 * 갱신되다가 그날 마지막으로 본 값이 남는다.
 */
export interface ManualPoint {
  /** YYYY-MM-DD (KST) */
  date: string;
  /** 총자산 = 주식 평가금액 + 예수금 */
  total: number;
  /** 주식 평가금액 */
  stock: number;
  /** 예수금 */
  cash: number;
  /** 매입금액 합 — 누적 수익률의 분모 */
  cost: number;
}

type Store = Record<string, ManualPoint[]>;

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = await readFile(FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    cache = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Store) : {};
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(next: Store): Promise<void> {
  cache = next;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
}

function kstToday(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 오늘 한 점을 남긴다. 같은 날이면 덮는다.
 *
 * **빈 계좌는 안 남긴다** — 계좌를 막 만들었거나 종목을 다 지운 상태의 0 이 흐름에 섞이면
 * 그래프가 바닥을 찍었다가 돌아온 것처럼 보인다. 실제로는 아무 일도 없었다.
 */
export async function recordSnapshot(accounts: EvaluatedAccount[]): Promise<void> {
  const date = kstToday();
  const store = await load();
  let changed = false;
  for (const a of accounts) {
    if (a.totalAssets <= 0) continue;
    const point: ManualPoint = {
      date,
      total: Math.round(a.totalAssets),
      stock: Math.round(a.totalValue),
      cash: Math.round(a.cash),
      cost: Math.round(a.totalCost),
    };
    const rows = store[a.id] ?? [];
    const at = rows.findIndex((r) => r.date === date);
    if (at >= 0) {
      const old = rows[at];
      if (old.total === point.total && old.stock === point.stock && old.cash === point.cash && old.cost === point.cost) continue;
      rows[at] = point;
    } else {
      rows.push(point);
      rows.sort((x, y) => x.date.localeCompare(y.date));
    }
    store[a.id] = rows;
    changed = true;
  }
  if (changed) await persist(store);
}

/** 계좌 하나의 점들 — 날짜 오름차순 */
export async function historyOf(id: string): Promise<ManualPoint[]> {
  const store = await load();
  return [...(store[id] ?? [])];
}

/** 전부 — 화면이 계좌마다 따로 그린다 */
export async function allHistory(): Promise<Store> {
  const store = await load();
  const out: Store = {};
  for (const [k, v] of Object.entries(store)) out[k] = [...v];
  return out;
}

/** 계좌를 지우면 흐름도 지운다 — 남겨 두면 다음에 만든 계좌가 옛 흐름을 물려받을 수 있다 */
export async function dropHistory(id: string): Promise<void> {
  const store = await load();
  if (!(id in store)) return;
  delete store[id];
  await persist(store);
}
