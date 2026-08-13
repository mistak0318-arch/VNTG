import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, "..", "data", "manualAccounts.json");

/**
 * 수동 계좌 — 키움 외 증권사 보유 종목을 직접 적어두고 수익률만 확인하는 용도.
 *
 * 설계 원칙: **평가금액·손익은 저장하지 않는다.** 평단가와 수량만 저장하고,
 * 현재가는 조회할 때마다 키움에서 가져와 계산한다. 저장하면 값이 낡는다.
 *
 * 이 앱은 조회 전용이므로 여기서도 주문·이체는 다루지 않는다.
 */

export const BROKERS = [
  "미래에셋증권",
  "삼성증권",
  "NH투자증권",
  "한국투자증권",
  "KB증권",
  "신한투자증권",
  "하나증권",
  "메리츠증권",
  "대신증권",
  "토스증권",
  "카카오페이증권",
  "유안타증권",
  "기타",
];

export interface ManualHolding {
  code: string;
  name: string;
  /** 평균 매입단가 */
  avgPrice: number;
  qty: number;
}

export interface ManualAccount {
  id: string;
  broker: string;
  /** 계좌 별칭 (예: 연금저축, ISA) */
  name: string;
  holdings: ManualHolding[];
}

let cache: ManualAccount[] | null = null;

async function load(): Promise<ManualAccount[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    cache = Array.isArray(parsed) ? (parsed as ManualAccount[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(items: ManualAccount[]): Promise<void> {
  cache = items;
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(items, null, 2), "utf-8");
}

function newId(): string {
  return `ma_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function listAccounts(): Promise<ManualAccount[]> {
  return [...(await load())];
}

export async function addAccount(broker: string, name: string): Promise<ManualAccount[]> {
  if (!broker.trim()) throw new Error("증권사를 선택하세요.");
  const items = await load();
  const next = [...items, { id: newId(), broker: broker.trim(), name: name.trim() || broker.trim(), holdings: [] }];
  await persist(next);
  return next;
}

export async function removeAccount(id: string): Promise<ManualAccount[]> {
  const items = await load();
  const next = items.filter((a) => a.id !== id);
  await persist(next);
  return next;
}

export async function upsertHolding(
  id: string,
  h: ManualHolding,
): Promise<ManualAccount[]> {
  if (!h.code) throw new Error("종목코드가 필요합니다.");
  if (!(h.qty > 0)) throw new Error("수량은 1주 이상이어야 합니다.");
  const items = await load();
  const next = items.map((a) => {
    if (a.id !== id) return a;
    const exists = a.holdings.some((x) => x.code === h.code);
    return {
      ...a,
      // 같은 종목이면 덮어쓴다 (추가 매수 시 평단만 다시 적으면 되도록)
      holdings: exists ? a.holdings.map((x) => (x.code === h.code ? h : x)) : [...a.holdings, h],
    };
  });
  await persist(next);
  return next;
}

export async function removeHolding(id: string, code: string): Promise<ManualAccount[]> {
  const items = await load();
  const next = items.map((a) =>
    a.id === id ? { ...a, holdings: a.holdings.filter((x) => x.code !== code) } : a,
  );
  await persist(next);
  return next;
}

// ---------------------------------------------------------------- 평가

export interface EvaluatedHolding extends ManualHolding {
  price: number;
  changeRate: number;
  /** 평가금액 */
  value: number;
  /** 매입금액 */
  cost: number;
  profit: number;
  returnRate: number | null;
}

export interface EvaluatedAccount extends Omit<ManualAccount, "holdings"> {
  holdings: EvaluatedHolding[];
  totalCost: number;
  totalValue: number;
  totalProfit: number;
  totalReturnRate: number | null;
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 현재가 조회는 TR당 초당 5회 제한이 있어 순차로 돌린다 */
export async function evaluateAccounts(client: KiwoomClient): Promise<EvaluatedAccount[]> {
  const accounts = await load();

  // 여러 계좌에 같은 종목이 있으면 한 번만 조회한다
  const codes = new Set<string>();
  for (const a of accounts) for (const h of a.holdings) codes.add(h.code);

  const priceMap = new Map<string, { price: number; changeRate: number }>();
  for (const code of codes) {
    try {
      const { data } = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10001", {
        stk_cd: code,
      });
      priceMap.set(code, {
        price: Math.abs(toNum(data.cur_prc)),
        changeRate: toNum(data.flu_rt),
      });
    } catch {
      // 한 종목 실패가 전체를 막지 않게 한다
    }
  }

  return accounts.map((a) => {
    const holdings: EvaluatedHolding[] = a.holdings.map((h) => {
      const q = priceMap.get(h.code);
      const price = q?.price ?? 0;
      const value = price * h.qty;
      const cost = h.avgPrice * h.qty;
      const profit = value - cost;
      return {
        ...h,
        price,
        changeRate: q?.changeRate ?? 0,
        value,
        cost,
        profit,
        returnRate: cost > 0 && price > 0 ? (profit / cost) * 100 : null,
      };
    });

    const totalCost = holdings.reduce((s, h) => s + h.cost, 0);
    const totalValue = holdings.reduce((s, h) => s + h.value, 0);
    const totalProfit = totalValue - totalCost;
    return {
      ...a,
      holdings,
      totalCost,
      totalValue,
      totalProfit,
      totalReturnRate: totalCost > 0 ? (totalProfit / totalCost) * 100 : null,
    };
  });
}
