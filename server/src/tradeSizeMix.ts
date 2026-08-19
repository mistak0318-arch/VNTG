import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 체결금액대별 매매비중 (`ka00196`).
 *
 * 하루 거래를 **체결 한 건의 금액 크기별로** 쪼개 준다. 3백만원 이하 체결이 얼마,
 * 3천만원 이하가 얼마 하는 식이다.
 *
 * 이게 왜 쓸모 있냐면 — **누가 사고 있는지**가 여기서 갈린다. 소액 구간에서 사고
 * 고액 구간에서 팔면 개인이 받고 큰손이 던지는 중이다. 그 반대면 기관이 모으는 중이고.
 * 투자자별 수급은 하루 한 번 집계지만 이건 **체결 단위**라 결이 더 곱다.
 *
 * 종목별이다 — 시장 전체 순위가 아니라 한 종목 안의 분포다.
 */

const RKINFO = "/api/dostk/rkinfo";

export interface TradeSizeRow {
  /** "3백이하", "3천이하" 같은 구간 이름 */
  band: string;
  buyQty: number;
  sellQty: number;
  totalQty: number;
  /** 순매수 수량 (매수 − 매도) */
  netQty: number;
  /** 그 구간이 전체 거래에서 차지하는 비중(%) — 매수/매도 각각 */
  buyRate: number;
  sellRate: number;
  netRate: number;
  buyAvgPrice: number;
  sellAvgPrice: number;
}

interface Raw {
  mont_cntr_amt?: string;
  buy_trde_qty?: string;
  sel_trde_qty?: string;
  tot_trde_qty?: string;
  buy_rt?: string;
  sel_rt?: string;
  tot_net_rt?: string;
  buy_avg_pric?: string;
  sel_avg_pric?: string;
}

/**
 * 키움은 부호를 문자열 앞에 붙인다. `tot_net_rt` 는 **`++1.67` 처럼 두 번** 붙기도 한다 —
 * 앞의 부호는 등락 표시고 뒤가 실제 값의 부호다. 그냥 Number() 에 넣으면 NaN 이 된다.
 */
function num(v: unknown): number {
  const s = String(v ?? "").replace(/,/g, "").trim();
  const m = /^([+-]*)([\d.]+)$/.exec(s);
  if (!m) return 0;
  const n = Number(m[2]);
  if (!Number.isFinite(n)) return 0;
  // 부호가 여러 개면 마지막 것을 쓴다
  return m[1].endsWith("-") ? -n : n;
}

export async function tradeSizeMix(client: KiwoomClient, code: string): Promise<TradeSizeRow[]> {
  const { data } = await client.request<{ result_list?: Raw[] }>(RKINFO, "ka00196", {
    stk_cd: code,
  });
  return (data.result_list ?? [])
    .map((r) => {
      const buyQty = num(r.buy_trde_qty);
      const sellQty = num(r.sel_trde_qty);
      return {
        band: String(r.mont_cntr_amt ?? "").trim(),
        buyQty,
        sellQty,
        totalQty: num(r.tot_trde_qty),
        netQty: buyQty - sellQty,
        buyRate: num(r.buy_rt),
        sellRate: num(r.sel_rt),
        netRate: num(r.tot_net_rt),
        buyAvgPrice: num(r.buy_avg_pric),
        sellAvgPrice: num(r.sel_avg_pric),
      };
    })
    .filter((r) => r.band);
}
