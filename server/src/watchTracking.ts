import type { KiwoomClient } from "./kiwoomClient.js";
import { listWatchlist, type WatchItem } from "./watchlist.js";

/**
 * 관심종목 추적 지표.
 * 종목마다 차트(ka10081)와 투자자 수급(ka10060)을 조회하므로 호출량이 있다.
 * 마이페이지를 열 때마다 다시 부르지 않도록 짧게 캐싱한다.
 */

export interface TrackedStock extends WatchItem {
  price: number; // 현재가
  changeRate: number; // 당일 등락률
  returnRate: number | null; // 편입가 대비 수익률
  // 외국인/기관 순매매 (백만원)
  foreign5: number;
  foreign20: number;
  inst5: number;
  inst20: number;
  // 정배열 여부 (데이터 부족 시 null)
  trendPass: boolean | null;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  error: string | null;
}

type Row = Record<string, unknown>;

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function todayYyyymmdd(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sum(arr: number[], n: number): number {
  return arr.slice(0, n).reduce((a, b) => a + b, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function trackOne(client: KiwoomClient, item: WatchItem): Promise<TrackedStock> {
  const base: TrackedStock = {
    ...item,
    price: 0,
    changeRate: 0,
    returnRate: null,
    foreign5: 0,
    foreign20: 0,
    inst5: 0,
    inst20: 0,
    trendPass: null,
    ma5: null,
    ma20: null,
    ma60: null,
    ma120: null,
    error: null,
  };

  try {
    // 일봉으로 현재가·이동평균·정배열을 계산
    const chart = await client.request<{ stk_dt_pole_chart_qry?: Row[] }>("/api/dostk/chart", "ka10081", {
      stk_cd: item.code,
      base_dt: todayYyyymmdd(),
      upd_stkpc_tp: "1",
    });
    const rows = Array.isArray(chart.data.stk_dt_pole_chart_qry) ? chart.data.stk_dt_pole_chart_qry : [];
    const closes = rows.map((r) => Math.abs(toNum(r.cur_prc))).filter((n) => n > 0);

    if (closes.length > 0) {
      base.price = closes[0];
      if (closes.length > 1) {
        const prev = closes[1];
        base.changeRate = prev ? ((closes[0] - prev) / prev) * 100 : 0;
      }
      if (item.addedPrice > 0) {
        base.returnRate = ((closes[0] - item.addedPrice) / item.addedPrice) * 100;
      }
      if (closes.length >= 120) {
        base.ma5 = avg(closes.slice(0, 5));
        base.ma20 = avg(closes.slice(0, 20));
        base.ma60 = avg(closes.slice(0, 60));
        base.ma120 = avg(closes.slice(0, 120));
        base.trendPass =
          base.price >= base.ma5 && base.ma5 >= base.ma20 && base.ma20 >= base.ma60 && base.ma60 >= base.ma120;
      }
    }

    await sleep(220); // TR당 초당 5회 제한을 여유 있게 지킨다

    // 투자자별 순매매 (금액, 백만원)
    const flow = await client.request<{ stk_invsr_orgn_chart?: Row[] }>("/api/dostk/chart", "ka10060", {
      dt: todayYyyymmdd(),
      stk_cd: item.code,
      amt_qty_tp: "1",
      trde_tp: "0",
      unit_tp: "1000",
    });
    const flowRows = Array.isArray(flow.data.stk_invsr_orgn_chart) ? flow.data.stk_invsr_orgn_chart : [];
    const foreign = flowRows.map((r) => toNum(r.frgnr_invsr));
    const inst = flowRows.map((r) => toNum(r.orgn));
    base.foreign5 = sum(foreign, 5);
    base.foreign20 = sum(foreign, 20);
    base.inst5 = sum(inst, 5);
    base.inst20 = sum(inst, 20);
  } catch (err) {
    base.error = err instanceof Error ? err.message : "조회 실패";
  }

  return base;
}

let cache: { data: TrackedStock[]; at: number } | null = null;
const TTL_MS = 60_000;

export async function getTrackedWatchlist(client: KiwoomClient, force = false): Promise<TrackedStock[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) {
    return cache.data;
  }
  const items = await listWatchlist();
  const results: TrackedStock[] = [];
  for (const item of items) {
    results.push(await trackOne(client, item));
    await sleep(220);
  }
  cache = { data: results, at: Date.now() };
  return results;
}

/** 관심종목이 바뀌면 다음 조회 때 새로 집계하도록 캐시를 비운다 */
export function invalidateTrackingCache(): void {
  cache = null;
}
