/**
 * 잔고·수익률 현황 (2026-09-07 밤) — 벤티지: "잔고 탭을 하나 넣으면 안 되나? 총 잔액과 예수금 이런 것도
 * 한 번에 볼 수 있어야지. 수익률 현황도 — 일별·주별·월별·종목별."
 *
 * 키움 공식 저장소(examples/국내주식/계좌, 2026-09-07 확인)의 필드명 그대로:
 *   kt00003 추정예탁자산            → prsm_dpst_aset_amt                       = **총 잔액**
 *   kt00001 예수금상세현황          → entr · ord_alow_amt · pymn_alow_amt · d1_entra · d2_entra · ch_uncla_tot · loan_sum
 *   kt00002 일별추정예탁자산현황    → daly_prsm_dpst_aset_amt_prst[dt, entr, prsm_dpst_aset_amt]   = 자산 추이
 *   ka10074 일자별실현손익          → dt_rlzt_pl[dt, buy_amt, sell_amt, tdy_sel_pl, tdy_trde_cmsn, tdy_trde_tax] + 요약
 *   ka10073 일자별종목별실현손익_기간 → dt_stk_rlzt_pl[dt, stk_cd, stk_nm, cntr_qty, buy_uv, cntr_pric, tdy_sel_pl, pl_rt, …]
 *   kt00016 일별계좌수익률상세      → tot_amt_fr/to(순자산 초·말) · invt_bsamt · evltv_prft · prft_rt · termin_tot_trns/pymn(입출금)
 *
 * 조각마다 따로 받고 따로 실패한다 — 모의투자가 어느 하나를 안 주더라도 나머지는 보인다. 60초 캐시.
 * 주문 앱키(orderClient)로 부른다 — 이 잔고는 주문 계좌의 것이다.
 */
import type { KiwoomClient } from "./kiwoomClient.js";
import { orderClient, orderAccount } from "./orders.js";

const ACNT = "/api/dostk/acnt";

type Row = Record<string, unknown>;
const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/[,+\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => String(v ?? "").trim();
const list = (d: Row, key: string): Row[] => (Array.isArray(d[key]) ? (d[key] as Row[]) : []);

function kstDate(offsetDays = 0): string {
  const t = new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
  return t.toISOString().slice(0, 10);
}
const ymd = (iso: string) => iso.replace(/-/g, "");
const isoOf = (v: string) => {
  const s = str(v).replace(/\D/g, "");
  return s.length >= 8 ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
};

/** 여러 장을 이어 받는다 — 공식 예제와 같이 cont-yn/next-key 로, 최대 10장 */
async function pages(oc: KiwoomClient, apiId: string, body: Row, key: string): Promise<{ rows: Row[]; head: Row }> {
  let contYn: string | undefined;
  let nextKey: string | undefined;
  const rows: Row[] = [];
  let head: Row = {};
  for (let i = 0; i < 10; i++) {
    const r = await oc.request<Row>(ACNT, apiId, body, { contYn, nextKey });
    if (i === 0) head = r.data;
    rows.push(...list(r.data, key));
    if (r.contYn !== "Y") break;
    contYn = "Y";
    nextKey = r.nextKey;
    await new Promise((ok) => setTimeout(ok, 220));
  }
  return { rows, head };
}

export interface DailyPnl {
  date: string;
  buyAmt: number;
  sellAmt: number;
  pnl: number;
  fee: number;
  tax: number;
}
export interface StockTrade {
  date: string;
  code: string;
  name: string;
  qty: number;
  buyPrice: number;
  sellPrice: number;
  pnl: number;
  pnlRate: number;
  fee: number;
  tax: number;
}
export interface StockPnl {
  code: string;
  name: string;
  trades: number;
  qty: number;
  pnl: number;
  wins: number;
  avgRate: number;
  bestRate: number;
  worstRate: number;
  lastDate: string;
}
export interface AssetPoint {
  date: string;
  asset: number;
  deposit: number;
}
export interface PeriodRow {
  key: string;
  label: string;
  from: string;
  to: string;
  assetEnd: number | null;
  assetChange: number | null;
  assetChangeRate: number | null;
  pnl: number;
  buyAmt: number;
  sellAmt: number;
  cost: number;
  days: number;
}

export interface LedgerView {
  asOf: string;
  range: { from: string; to: string; days: number };
  /** 지금 */
  now: {
    totalAsset: number | null;
    deposit: number;
    orderable: number;
    withdrawable: number | null;
    d1Deposit: number | null;
    d2Deposit: number | null;
    receivable: number;
    loan: number;
    investTotal: number;
    valueTotal: number;
    pnlTotal: number;
    pnlRateTotal: number;
    holdings: number;
  };
  /** 기간 수익률 (kt00016) — 입출금을 뺀 순자산 기준 */
  period: {
    netStart: number;
    netEnd: number;
    deposits: number;
    withdrawals: number;
    evalPnl: number;
    rate: number;
  } | null;
  assets: AssetPoint[];
  daily: DailyPnl[];
  weekly: PeriodRow[];
  monthly: PeriodRow[];
  byStock: StockPnl[];
  trades: StockTrade[];
  realized: { pnl: number; buyAmt: number; sellAmt: number; fee: number; tax: number; wins: number; losses: number; winRate: number };
  missing: string[];
}

const cache = new Map<string, { at: number; p: Promise<LedgerView> }>();

export function ledger(days: number): Promise<LedgerView> {
  const key = String(days);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.p;
  const p = build(days).catch((e) => {
    cache.delete(key);
    throw e;
  });
  cache.set(key, { at: Date.now(), p });
  return p;
}

async function build(days: number): Promise<LedgerView> {
  const oc = orderClient();
  if (!oc) throw new Error("주문 앱키가 없다");
  const to = kstDate(0);
  const from = kstDate(-days);
  const missing: string[] = [];
  const grab = async <T>(what: string, fn: () => Promise<T>): Promise<T | null> => {
    try {
      return await fn();
    } catch {
      missing.push(what);
      return null;
    }
  };

  const [acct, asset, dep, trend, dailyRaw, stockRaw, period] = await Promise.all([
    orderAccount(),
    grab("추정예탁자산", () => oc.request<Row>(ACNT, "kt00003", { qry_tp: "0" })),
    grab("예수금 상세", () => oc.request<Row>(ACNT, "kt00001", { qry_tp: "3" })),
    grab("일별 자산 추이", () => pages(oc, "kt00002", { start_dt: ymd(from), end_dt: ymd(to) }, "daly_prsm_dpst_aset_amt_prst")),
    grab("일자별 실현손익", () => pages(oc, "ka10074", { strt_dt: ymd(from), end_dt: ymd(to) }, "dt_rlzt_pl")),
    grab("종목별 실현손익", () => pages(oc, "ka10073", { strt_dt: ymd(from), end_dt: ymd(to) }, "dt_stk_rlzt_pl")),
    grab("기간 수익률", () => oc.request<Row>(ACNT, "kt00016", { fr_dt: ymd(from), to_dt: ymd(to) })),
  ]);

  const investTotal = acct.holdings.reduce((a, h) => a + h.avg * h.qty, 0);
  const valueTotal = acct.holdings.reduce((a, h) => a + h.cur * h.qty, 0);
  const d = dep?.data ?? {};
  const now: LedgerView["now"] = {
    totalAsset: asset ? num(asset.data.prsm_dpst_aset_amt) || acct.deposit + valueTotal : acct.deposit + valueTotal,
    deposit: num(d.entr) || acct.deposit,
    orderable: num(d.ord_alow_amt) || acct.deposit,
    withdrawable: dep ? num(d.pymn_alow_amt) : null,
    d1Deposit: dep ? num(d.d1_entra) : null,
    d2Deposit: dep ? num(d.d2_entra) : null,
    receivable: num(d.ch_uncla_tot),
    loan: num(d.loan_sum) || acct.creditLoan,
    investTotal,
    valueTotal,
    pnlTotal: valueTotal - investTotal,
    pnlRateTotal: investTotal > 0 ? ((valueTotal - investTotal) / investTotal) * 100 : 0,
    holdings: acct.holdings.length,
  };

  const assets: AssetPoint[] = (trend?.rows ?? [])
    .map((r) => ({ date: isoOf(str(r.dt)), asset: num(r.prsm_dpst_aset_amt), deposit: num(r.entr) }))
    .filter((r) => r.date.length === 10 && r.asset > 0)
    .sort((a, b) => a.date.localeCompare(b.date));

  const daily: DailyPnl[] = (dailyRaw?.rows ?? [])
    .map((r) => ({
      date: isoOf(str(r.dt)),
      buyAmt: num(r.buy_amt),
      sellAmt: num(r.sell_amt),
      pnl: num(r.tdy_sel_pl),
      fee: num(r.tdy_trde_cmsn),
      tax: num(r.tdy_trde_tax),
    }))
    .filter((r) => r.date.length === 10)
    .sort((a, b) => a.date.localeCompare(b.date));

  const trades: StockTrade[] = (stockRaw?.rows ?? [])
    .map((r) => ({
      date: isoOf(str(r.dt)),
      code: str(r.stk_cd).replace(/^A/, "").replace(/_.*$/, ""),
      name: str(r.stk_nm),
      qty: num(r.cntr_qty),
      buyPrice: num(r.buy_uv),
      sellPrice: num(r.cntr_pric),
      pnl: num(r.tdy_sel_pl),
      pnlRate: num(r.pl_rt),
      fee: num(r.tdy_trde_cmsn),
      tax: num(r.tdy_trde_tax),
    }))
    .filter((r) => r.date.length === 10 && r.code)
    .sort((a, b) => b.date.localeCompare(a.date));

  const byStockMap = new Map<string, StockPnl>();
  for (const t of trades) {
    const s = byStockMap.get(t.code) ?? { code: t.code, name: t.name, trades: 0, qty: 0, pnl: 0, wins: 0, avgRate: 0, bestRate: -Infinity, worstRate: Infinity, lastDate: "" };
    s.trades += 1;
    s.qty += t.qty;
    s.pnl += t.pnl;
    if (t.pnl > 0) s.wins += 1;
    s.avgRate += t.pnlRate;
    s.bestRate = Math.max(s.bestRate, t.pnlRate);
    s.worstRate = Math.min(s.worstRate, t.pnlRate);
    if (t.date > s.lastDate) s.lastDate = t.date;
    byStockMap.set(t.code, s);
  }
  const byStock = [...byStockMap.values()]
    .map((s) => ({ ...s, avgRate: s.trades > 0 ? s.avgRate / s.trades : 0, bestRate: Number.isFinite(s.bestRate) ? s.bestRate : 0, worstRate: Number.isFinite(s.worstRate) ? s.worstRate : 0 }))
    .sort((a, b) => b.pnl - a.pnl);

  const wins = trades.filter((t) => t.pnl > 0).length;
  const losses = trades.filter((t) => t.pnl < 0).length;
  const head = dailyRaw?.head ?? {};
  const realized = {
    pnl: num(head.rlzt_pl) || daily.reduce((a, r) => a + r.pnl, 0),
    buyAmt: num(head.tot_buy_amt) || daily.reduce((a, r) => a + r.buyAmt, 0),
    sellAmt: num(head.tot_sell_amt) || daily.reduce((a, r) => a + r.sellAmt, 0),
    fee: num(head.trde_cmsn) || daily.reduce((a, r) => a + r.fee, 0),
    tax: num(head.trde_tax) || daily.reduce((a, r) => a + r.tax, 0),
    wins,
    losses,
    winRate: wins + losses > 0 ? (wins / (wins + losses)) * 100 : 0,
  };

  const pd = period?.data ?? null;
  const periodOut = pd
    ? {
        netStart: num(pd.tot_amt_fr),
        netEnd: num(pd.tot_amt_to),
        deposits: num(pd.termin_tot_trns),
        withdrawals: num(pd.termin_tot_pymn),
        evalPnl: num(pd.evltv_prft),
        rate: num(pd.prft_rt),
      }
    : null;

  return {
    asOf: new Date().toISOString(),
    range: { from, to, days },
    now,
    period: periodOut,
    assets,
    daily,
    weekly: bucket(daily, assets, "week"),
    monthly: bucket(daily, assets, "month"),
    byStock,
    trades: trades.slice(0, 300),
    realized,
    missing,
  };
}

/** 월요일 날짜를 주의 열쇠로 */
function weekKey(date: string): { key: string; from: string; to: string } {
  const d = new Date(date + "T00:00:00Z");
  const wd = (d.getUTCDay() + 6) % 7; // 월=0
  const mon = new Date(d.getTime() - wd * 86400_000);
  const sun = new Date(mon.getTime() + 6 * 86400_000);
  const f = mon.toISOString().slice(0, 10);
  return { key: f, from: f, to: sun.toISOString().slice(0, 10) };
}

function bucket(daily: DailyPnl[], assets: AssetPoint[], unit: "week" | "month"): PeriodRow[] {
  const keyOf = (date: string) => (unit === "week" ? weekKey(date) : { key: date.slice(0, 7), from: date.slice(0, 7) + "-01", to: date.slice(0, 7) + "-31" });
  const m = new Map<string, PeriodRow>();
  const touch = (date: string): PeriodRow => {
    const k = keyOf(date);
    let row = m.get(k.key);
    if (!row) {
      row = {
        key: k.key,
        label: unit === "week" ? `${k.from.slice(5).replace("-", "/")}주` : `${k.key.slice(0, 4)}년 ${Number(k.key.slice(5))}월`,
        from: k.from,
        to: k.to,
        assetEnd: null,
        assetChange: null,
        assetChangeRate: null,
        pnl: 0,
        buyAmt: 0,
        sellAmt: 0,
        cost: 0,
        days: 0,
      };
      m.set(k.key, row);
    }
    return row;
  };
  for (const d of daily) {
    const r = touch(d.date);
    r.pnl += d.pnl;
    r.buyAmt += d.buyAmt;
    r.sellAmt += d.sellAmt;
    r.cost += d.fee + d.tax;
    r.days += 1;
  }
  /* 자산은 그 기간의 마지막 값, 증감은 앞 기간의 마지막 값 대비 */
  const lastByKey = new Map<string, AssetPoint>();
  for (const a of assets) {
    const k = keyOf(a.date).key;
    const prev = lastByKey.get(k);
    if (!prev || a.date > prev.date) lastByKey.set(k, a);
  }
  for (const [k, a] of lastByKey) {
    const r = m.get(k) ?? touch(a.date);
    r.assetEnd = a.asset;
  }
  const rows = [...m.values()].sort((a, b) => a.key.localeCompare(b.key));
  let prevAsset: number | null = null;
  for (const r of rows) {
    if (r.assetEnd !== null && prevAsset !== null && prevAsset > 0) {
      r.assetChange = r.assetEnd - prevAsset;
      r.assetChangeRate = (r.assetChange / prevAsset) * 100;
    }
    if (r.assetEnd !== null) prevAsset = r.assetEnd;
  }
  return rows.reverse();
}
