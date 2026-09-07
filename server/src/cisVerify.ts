/**
 * 항해일지 — 매수·매도 **검증**과 장부 **자가점검** (2026-09-07 밤).
 *
 * 벤티지: "항해일지 오늘 매수했는데 체결 내역도 안 나오고 이상하네. 매수 매도 검증 로직도 손보고."
 * → 시스 프롬프트: 「기록되면 끝」에서 「검증되고 맞춰지는 장부」로.
 *
 * ① 체결 도장 `verifyFill` — 사고 팔 때마다 fill 에 `verify:{ok, notes}` 를 남긴다. 실패해도 **막지는 않는다**
 *    (모의 장부다) — 빨간 도장으로 남겨 복기에서 보이게. 규칙:
 *      가격   그날 고저 안(통합 일봉) · 전일 종가 ±15% 안 · 시가배팅은 통합 시가 ±2% · 종가배팅은 통합 종가 ±2%
 *      수량   같은 날·같은 슬롯·같은 종목 두 번 금지 · 비중 한도(maxPerStock) 안
 *      매도   손절이면 그날 저가가 손절가에 닿았어야 한다(안 닿았는데 손절 처리 금지) · 매도가는 손절가/목표가 근처
 *      시장   신호등 빨강/공포에 매수면 도장 실패
 * ② 자가점검 `auditAccount` — positions 를 fills 로 재구성해 비교(수량·평단·현금·미수·신용), 일지의 「체결 N」과
 *    그날 fills 수, openedAt 이 첫 매수일과 같은지. 어긋나면 계좌 탭에 「장부 점검 N건」, 저녁엔 텔레그램.
 */
import type { KiwoomClient } from "./kiwoomClient.js";
import { dropPhantomToday } from "./candleGuard.js";
import { alCode } from "./alCode.js";
import { FEE_RATE, TAX_RATE, loadAccount, type CisAccount, type Fill, type FillVerify, type Position } from "./cisAccount.js";
import { listDays } from "./cisJournal.js";
import { evaluateMarket } from "./marketSignal.js";
import { profileOf, type AccountId } from "./cisAccounts.js";
import { sendTelegram } from "./telegram.js";

type Row = Record<string, unknown>;
const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
};
const ymd = (iso: string) => iso.replace(/-/g, "");

export type { FillVerify };

/** 그날 일봉 한 줄(KRX+NXT 통합) — 시가·고저·종가·전일 종가. 못 받으면 null (검증은 「못 잼」으로 남긴다) */
async function dayBar(client: KiwoomClient, code: string, date: string): Promise<{ open: number; high: number; low: number; close: number; prevClose: number | null } | null> {
  try {
    const { data } = await client.request<{ stk_dt_pole_chart_qry?: Row[] }>("/api/dostk/chart", "ka10081", { stk_cd: alCode(code), base_dt: ymd(date), upd_stkpc_tp: "1" });
    const rows = dropPhantomToday(Array.isArray(data.stk_dt_pole_chart_qry) ? (data.stk_dt_pole_chart_qry as Row[]) : []);
    const i = rows.findIndex((r) => String(r.dt ?? "") === ymd(date));
    if (i < 0) return null;
    const r = rows[i];
    const prev = rows[i + 1];
    return { open: num(r.open_pric), high: num(r.high_pric), low: num(r.low_pric), close: num(r.cur_prc), prevClose: prev ? num(prev.cur_prc) : null };
  } catch {
    return null;
  }
}

/**
 * 체결 하나에 도장을 찍는다. `mode` 는 시가/장중/종가배팅, `exitKind` 는 매도 규칙(stop·target·time·misu·trail…).
 * 장중에 부르면 고저는 「지금까지」다 — 그래서 고저 밖은 확실한 실패고, 안은 통과다.
 */
export async function verifyFill(
  client: KiwoomClient,
  a: CisAccount,
  f: Fill,
  ctx: { mode?: "open" | "intra" | "close"; exitKind?: string; position?: Position | null; maxPerStockPct?: number; equity?: number },
): Promise<FillVerify> {
  const notes: string[] = [];
  const bar = await dayBar(client, f.code, f.date);
  const seen = bar ? { open: bar.open, high: bar.high, low: bar.low, close: bar.close, prevClose: bar.prevClose } : undefined;

  /* 가격 — 그날 범위 안인가 */
  if (bar) {
    if (bar.high > 0 && f.price > bar.high * 1.0005) notes.push(`체결가 ${f.price.toLocaleString()} 가 그날 고가 ${bar.high.toLocaleString()} 위`);
    if (bar.low > 0 && f.price < bar.low * 0.9995) notes.push(`체결가 ${f.price.toLocaleString()} 가 그날 저가 ${bar.low.toLocaleString()} 아래`);
    if (bar.prevClose && Math.abs(f.price - bar.prevClose) / bar.prevClose > 0.15) notes.push(`전일 종가 ${bar.prevClose.toLocaleString()} 에서 15% 넘게 벗어남`);
    /*
     * 일봉은 `_AL`(KRX+NXT 통합)이다 — 항해일지가 사는 값(ka10095 `_AL`)과 같은 자리. 그래서 시가는 NXT 08:00 첫 틱,
     * 종가는 NXT 20:00 마지막 틱이고, 아침 08:40·저녁 종배는 그 사이 값이라 1% 로 재면 헛실패가 난다 → 2%.
     */
    if (f.side === "buy" && ctx.mode === "open" && bar.open > 0 && Math.abs(f.price - bar.open) / bar.open > 0.02) notes.push(`시가배팅인데 통합 시가(${bar.open.toLocaleString()})와 2% 넘게 다름`);
    if (f.side === "buy" && ctx.mode === "close" && bar.close > 0 && Math.abs(f.price - bar.close) / bar.close > 0.02) notes.push(`종가배팅인데 통합 종가(${bar.close.toLocaleString()})와 2% 넘게 다름`);
    /* 손절 매도 — 그날 저가가 손절가에 닿았어야 한다 */
    if (f.side === "sell" && ctx.exitKind === "stop" && ctx.position?.stop && bar.low > ctx.position.stop * 1.002) {
      notes.push(`손절 처리인데 그날 저가 ${bar.low.toLocaleString()} 가 손절가 ${ctx.position.stop.toLocaleString()} 에 안 닿음`);
    }
    if (f.side === "sell" && ctx.exitKind === "stop" && ctx.position?.stop && f.price < ctx.position.stop * 0.97) {
      notes.push(`손절가 ${ctx.position.stop.toLocaleString()} 보다 3% 넘게 낮게 팔림 — 슬리피지 과다`);
    }
  } else {
    notes.push("그날 일봉을 못 받아 가격 범위를 못 쟀다");
  }

  /* 수량·중복 */
  const same = a.fills.filter((x) => x.id !== f.id && x.date === f.date && x.slot === f.slot && x.code === f.code && x.side === f.side);
  if (same.length > 0) notes.push(`같은 날·같은 슬롯에 같은 종목 ${f.side === "buy" ? "매수" : "매도"}가 ${same.length + 1}번`);
  if (f.qty <= 0 || f.price <= 0) notes.push("수량·가격이 0");
  if (f.side === "buy" && ctx.maxPerStockPct && ctx.equity && ctx.equity > 0) {
    const pos = a.positions.find((p) => p.code === f.code);
    const value = pos ? pos.avg * pos.qty : f.price * f.qty;
    const pct = (value / ctx.equity) * 100;
    if (pct > ctx.maxPerStockPct * 1.05) notes.push(`종목 비중 ${pct.toFixed(0)}% — 한도 ${ctx.maxPerStockPct}% 초과`);
  }

  /* 시장 문 — 빨강·공포에 산 매수 */
  if (f.side === "buy") {
    try {
      const sig = await evaluateMarket(client);
      if (sig.level === "red" || sig.regime?.key === "fear") notes.push(`시장 신호등 ${sig.level === "red" ? "빨강" : "공포"}인데 매수`);
    } catch {
      /* 신호등을 못 읽으면 도장엔 안 적는다 — 그건 이 체결의 잘못이 아니다 */
    }
  }

  const v: FillVerify = { ok: notes.length === 0 || (notes.length === 1 && notes[0].startsWith("그날 일봉을")), notes, seen, at: new Date().toISOString() };
  f.verify = v;
  return v;
}

/**
 * 방금 `buy()`/`sell()` 이 밀어 넣은 **마지막 체결**에 도장을 찍는다. 검증이 터져도 매매는 이미 끝난 뒤다 —
 * 여기서 던지면 장부 저장이 막히니 삼킨다(도장 없는 체결 = 「못 잰」으로 남는다).
 */
export async function stampLast(
  client: KiwoomClient,
  a: CisAccount,
  ctx: Parameters<typeof verifyFill>[3],
  expect?: { side: "buy" | "sell"; code: string },
): Promise<FillVerify | null> {
  const f = a.fills[a.fills.length - 1];
  if (!f) return null;
  if (expect && (f.side !== expect.side || f.code !== expect.code)) return null;
  try {
    return await verifyFill(client, a, f, ctx);
  } catch (e) {
    console.warn(`[cis] 체결 도장 실패 ${f.name}: ${(e as Error).message}`);
    return null;
  }
}

/* ═══════════════ 장부 자가점검 ═══════════════ */

export interface AuditItem {
  level: "bad" | "warn";
  what: string;
  detail: string;
}
export interface AuditResult {
  account: AccountId;
  at: string;
  items: AuditItem[];
  /** fills 로 재구성한 장부 */
  rebuilt: { cash: number; misu: number; credit: number; positions: { code: string; name: string; qty: number; avg: number; funding: string; firstBuy: string }[] };
  fillsToday: number;
  badStamps: number;
}

/** fills 만으로 장부를 처음부터 다시 만든다 — 같은 규칙(수수료 0.015%, 세금 0.18%)으로 */
export function rebuildFromFills(a: CisAccount): AuditResult["rebuilt"] {
  const seed = profileOf(a.id).seed;
  let cash = seed;
  let misu = 0;
  let credit = 0;
  const pos = new Map<string, { code: string; name: string; qty: number; cost: number; funding: string; firstBuy: string }>();
  const fills = [...a.fills].sort((x, y) => (x.at ?? x.date).localeCompare(y.at ?? y.date));
  for (const f of fills) {
    const key = `${f.code}|${f.funding}`;
    if (f.side === "buy") {
      const gross = f.price * f.qty;
      const fee = Math.round(gross * FEE_RATE);
      const total = gross + fee;
      if (f.funding === "cash") cash -= total;
      else if (f.funding === "misu") misu += total;
      else credit += total;
      const p = pos.get(key) ?? { code: f.code, name: f.name, qty: 0, cost: 0, funding: f.funding, firstBuy: f.date };
      p.qty += f.qty;
      p.cost += total;
      pos.set(key, p);
    } else {
      const p = pos.get(key);
      const gross = f.price * f.qty;
      const fee = Math.round(gross * FEE_RATE);
      const tax = Math.round(gross * TAX_RATE);
      const net = gross - fee - tax;
      if (p) {
        const unitCost = p.qty > 0 ? p.cost / p.qty : 0;
        p.qty -= f.qty;
        p.cost -= unitCost * f.qty;
        if (p.qty <= 0) pos.delete(key);
        /* 빌린 돈부터 갚는다(cisAccount.sell 과 같은 순서) */
        let left = net;
        if (f.funding === "misu") {
          const pay = Math.min(misu, unitCost * f.qty);
          misu -= pay;
          left -= pay;
        } else if (f.funding === "credit") {
          const pay = Math.min(credit, unitCost * f.qty);
          credit -= pay;
          left -= pay;
        }
        cash += Math.round(left);
      } else {
        cash += net; // 없는 것을 팔았다 — 아래 점검에서 잡힌다
      }
    }
  }
  return {
    cash: Math.round(cash),
    misu: Math.round(misu),
    credit: Math.round(credit),
    positions: [...pos.values()].map((p) => ({ code: p.code, name: p.name, qty: p.qty, avg: p.qty > 0 ? Math.round(p.cost / p.qty) : 0, funding: p.funding, firstBuy: p.firstBuy })),
  };
}

export async function auditAccount(id: AccountId, date?: string): Promise<AuditResult> {
  const a = await loadAccount(id);
  const rebuilt = rebuildFromFills(a);
  const items: AuditItem[] = [];
  const today = date ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  /* ① 포지션 ↔ 재구성 */
  for (const p of a.positions) {
    const r = rebuilt.positions.find((x) => x.code === p.code && x.funding === p.funding);
    if (!r) {
      items.push({ level: "bad", what: `${p.name} 보유 ${p.qty}주`, detail: "체결 원장에 이 종목의 매수가 없다 — 장부에만 있는 포지션" });
      continue;
    }
    if (r.qty !== p.qty) items.push({ level: "bad", what: `${p.name} 수량`, detail: `장부 ${p.qty}주 ≠ 원장 재구성 ${r.qty}주` });
    if (Math.abs(r.avg - p.avg) / Math.max(1, p.avg) > 0.005) items.push({ level: "warn", what: `${p.name} 평단`, detail: `장부 ${p.avg.toLocaleString()} ≠ 재구성 ${r.avg.toLocaleString()}` });
    if (r.firstBuy !== p.openedAt) items.push({ level: "warn", what: `${p.name} 산 날`, detail: `장부 ${p.openedAt} ≠ 첫 매수 체결 ${r.firstBuy}` });
  }
  for (const r of rebuilt.positions) {
    if (!a.positions.some((p) => p.code === r.code && p.funding === r.funding)) {
      items.push({ level: "bad", what: `${r.name} ${r.qty}주`, detail: "원장엔 산 기록이 남아 있는데 장부에 포지션이 없다" });
    }
  }
  /* ② 현금·빚 */
  const tol = Math.max(1000, Math.round(profileOf(id).seed * 0.0005));
  if (Math.abs(rebuilt.cash - a.cash) > tol) items.push({ level: "bad", what: "예수금", detail: `장부 ${a.cash.toLocaleString()} ≠ 재구성 ${rebuilt.cash.toLocaleString()} (차이 ${(a.cash - rebuilt.cash).toLocaleString()})` });
  if (Math.abs(rebuilt.misu - a.misu) > tol) items.push({ level: "warn", what: "미수", detail: `장부 ${a.misu.toLocaleString()} ≠ 재구성 ${rebuilt.misu.toLocaleString()}` });
  if (Math.abs(rebuilt.credit - a.credit) > tol) items.push({ level: "warn", what: "신용", detail: `장부 ${a.credit.toLocaleString()} ≠ 재구성 ${rebuilt.credit.toLocaleString()}` });

  /* ③ 일지 ↔ 원장 — 그날 「체결 N」과 fills 수 */
  const days = await listDays(10, id).catch(() => []);
  for (const d of days) {
    const n = a.fills.filter((f) => f.date === d.date).length;
    const said = d.review?.executed;
    if (typeof said === "number" && said !== n) items.push({ level: "warn", what: `${d.date} 일지`, detail: `일지는 체결 ${said}건, 원장엔 ${n}건` });
  }

  /* ④ 도장 실패 */
  const badStamps = a.fills.filter((f) => (f as Fill & { verify?: FillVerify }).verify && !(f as Fill & { verify?: FillVerify }).verify!.ok).length;
  if (badStamps > 0) items.push({ level: "warn", what: "검증 도장", detail: `실패 도장이 찍힌 체결 ${badStamps}건 — 매매일지에서 빨간 줄` });

  return { account: id, at: new Date().toISOString(), items, rebuilt, fillsToday: a.fills.filter((f) => f.date === today).length, badStamps };
}

/** 저녁에 한 번 — 어긋나면 텔레그램. 하루 한 번만 운다 */
const told = new Set<string>();
export async function auditAndTell(id: AccountId): Promise<AuditResult> {
  const r = await auditAccount(id);
  const key = `${id}:${r.at.slice(0, 10)}`;
  if (r.items.some((i) => i.level === "bad") && !told.has(key)) {
    told.add(key);
    const lines = r.items.slice(0, 5).map((i) => `• ${i.what}: ${i.detail}`);
    void sendTelegram(`🧭 항해일지 장부 점검 — ${profileOf(id).name}\n${lines.join("\n")}\n항해일지 › 계좌 탭 「장부 점검」`, "log").catch(() => undefined);
  }
  return r;
}
