/**
 * 복기 노트 11번 「오늘의 주문·체결」 — 주문 메뉴에서 오간 것을 **자동으로** 적는다 (2026-09-10).
 *
 * 벤티지: "복기 노트 11번에 오늘의 매매 적어두고 주문 메뉴에서 주문 오간 거 추적하고 기록하는
 * 거 하나 만들자."
 *
 * 재료는 이미 있다 — `orderLog.jsonl` 에 주문·정정·취소·체결·거절이 시도 단위로 남고
 * (orders.ts `appendLog`), 그날 체결은 키움 ka10076 이 준다. 여기서는 그 둘을 **그날짜로
 * 모아** 한 벌로 만든다. 로그는 우리가 낸 것만 있고, 키움 체결은 HTS 에서 직접 낸 것까지
 * 있다 — 둘을 겹쳐 주문번호로 중복을 거른다.
 *
 * 저널 저장 때마다 다시 잡는다(매매 내역과 같은 원칙 — 아침에 노트를 쓰고 오후에 사고파니까).
 */
import { fills, orderIsMock, readLog, type OrderLogRow } from "./orders.js";

export interface JournalOrder {
  at: string; // ISO
  /** 주문·정정·취소·체결·거절 */
  kind: "order" | "modify" | "cancel" | "fill" | "reject";
  side: "buy" | "sell" | null;
  code: string;
  name: string;
  qty: number | null;
  price: number | null;
  /** 주문 금액(원) — 있을 때만 */
  amount: number | null;
  ordNo: string | null;
  msg: string;
  /** 모의투자였나 */
  mock: boolean;
  /** 어디서 왔나 — 우리 로그 / 키움 체결 조회 */
  src: "log" | "kiwoom";
}

function kstDateOf(iso: string): string {
  return new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

function sideOf(s: string | undefined): "buy" | "sell" | null {
  if (!s) return null;
  if (/buy|매수/.test(s)) return "buy";
  if (/sell|매도/.test(s)) return "sell";
  return null;
}

/** 그날(KST) 우리 주문 로그 — 시도 단위 */
async function fromLog(date: string): Promise<JournalOrder[]> {
  const rows = await readLog(8000);
  const KINDS: OrderLogRow["kind"][] = ["order", "modify", "cancel", "fill", "reject"];
  return rows
    .filter((r) => KINDS.includes(r.kind) && kstDateOf(r.at) === date && r.code)
    .map((r) => ({
      at: r.at,
      kind: r.kind as JournalOrder["kind"],
      side: sideOf(r.side),
      code: String(r.code),
      name: r.name ?? "",
      qty: r.qty ?? null,
      price: r.price ?? null,
      amount: r.amount ?? (r.qty && r.price ? r.qty * r.price : null),
      ordNo: r.ordNo ?? null,
      msg: r.msg ?? "",
      mock: r.mock,
      src: "log" as const,
    }))
    .reverse(); // readLog 는 최신순 — 여기서는 시간순
}

/** 오늘 체결(키움) — 오늘 날짜일 때만 뜻이 있다. 로그에 같은 주문번호가 있으면 뺀다 */
async function fromKiwoom(date: string, have: Set<string>): Promise<JournalOrder[]> {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  if (date !== today) return [];
  const rows = await fills().catch(() => []);
  const out: JournalOrder[] = [];
  for (const f of rows) {
    if (!f.filled || f.filled <= 0) continue;
    if (f.ordNo && have.has(f.ordNo)) continue;
    const hhmm = /^(\d{2})(\d{2})/.exec(f.time.replace(/:/g, ""));
    const at = hhmm
      ? new Date(`${date}T${hhmm[1]}:${hhmm[2]}:00+09:00`).toISOString()
      : new Date().toISOString();
    out.push({
      at,
      kind: "fill",
      side: sideOf(f.side),
      code: f.code,
      name: f.name,
      qty: f.filled,
      price: f.price || null,
      amount: f.price ? f.filled * f.price : null,
      ordNo: f.ordNo || null,
      msg: `키움 체결 조회 — ${f.status || "체결"}`,
      mock: orderIsMock(),
      src: "kiwoom",
    });
  }
  return out;
}

/** 그날의 주문·체결 한 벌 — 시간순 */
export async function ordersOfDay(date: string): Promise<JournalOrder[]> {
  const log = await fromLog(date);
  const have = new Set(log.filter((r) => r.kind === "fill" && r.ordNo).map((r) => r.ordNo as string));
  const kw = await fromKiwoom(date, have);
  return [...log, ...kw].sort((a, b) => a.at.localeCompare(b.at));
}

export interface OrderSummary {
  buyCount: number;
  buyAmount: number;
  sellCount: number;
  sellAmount: number;
  fillCount: number;
  rejectCount: number;
  cancelCount: number;
}

/** 11번 머리의 한 줄 — 매수 N건 X원 · 매도 … · 체결 · 거절 · 취소 */
export function summarize(rows: JournalOrder[]): OrderSummary {
  const s: OrderSummary = { buyCount: 0, buyAmount: 0, sellCount: 0, sellAmount: 0, fillCount: 0, rejectCount: 0, cancelCount: 0 };
  for (const r of rows) {
    if (r.kind === "order") {
      if (r.side === "buy") {
        s.buyCount += 1;
        s.buyAmount += r.amount ?? 0;
      } else if (r.side === "sell") {
        s.sellCount += 1;
        s.sellAmount += r.amount ?? 0;
      }
    } else if (r.kind === "fill") s.fillCount += 1;
    else if (r.kind === "reject") s.rejectCount += 1;
    else if (r.kind === "cancel") s.cancelCount += 1;
  }
  return s;
}
