import type { KiwoomClient } from "./kiwoomClient.js";
import { getMarketSnapshot } from "./marketSnapshot.js";

/**
 * 수익률 상위 고객 매매동향 (`ka04196`).
 *
 * 키움에서 **실제로 잘 벌고 있는 계좌들**이 무엇을 사고 있는지 보여 준다.
 * 외국인·기관 수급은 규모가 커서 방향이 굼뜨고, 개인 수급은 방향이 없다.
 * 이건 그 사이에 있는 값이다 — 개인이되 **결과로 걸러진** 개인이다.
 *
 * **참고 자료로만 쓴다.** 이들이 산다고 따라 사는 건 이 프로젝트가 하려는 일이 아니다.
 * "내가 보는 종목이 여기에도 있나" 정도의 곁눈질이다.
 *
 * 단위 검산: `buy_amt` ÷ `buy_qty` = 79,488 ÷ 848,078 → 주당 0.0937.
 * 백만원으로 보면 93,727원/주 이고 그 종목 현재가가 103,600원이라 맞아떨어진다.
 * **금액은 백만원**이다.
 */

const RKINFO = "/api/dostk/rkinfo";

export interface TopTraderRow {
  rank: number;
  code: string;
  name: string;
  price: number;
  changeRate: number;
  /** 순매수 금액 (억원) */
  netAmount: number;
  netQty: number;
  /** 이 종목을 들고 있는 상위 계좌 수 — 한 계좌의 몰빵인지 여럿이 보는지 가른다 */
  accounts: number;
  /** 그 계좌들의 평균 매입가 */
  avgBuyPrice: number;
  /** 그 계좌들의 수익률(%) */
  profitRate: number;
}

interface Raw {
  rank?: string;
  stk_cd?: string;
  stk_nm?: string;
  cur_pric?: string;
  flu_rt?: string;
  netprps_qty?: string;
  netprps_amt?: string;
  acct_qty?: string;
  avg_pur_pric?: string;
  prft_rt?: string;
}

/** 키움은 부호를 문자열 앞에 붙여 준다 (`+848078`, `-103600`) */
function signed(v: unknown): number {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function abs(v: unknown): number {
  return Math.abs(signed(v));
}

export async function topTraders(client: KiwoomClient): Promise<TopTraderRow[]> {
  const { data } = await client.request<{ result_list?: Raw[] }>(RKINFO, "ka04196", {});
  /*
   * **개장 전엔 등락률이 0 으로 온다** (2026-09-22 — 벤티지: "수익률 상위 고객 부분은 등락률 오지도 않네").
   * 수익률 칸(+459%)은 제 값이 나오는데 등락률만 전부 `0.00%` 였다 — ka04196 도 새 날이 시작되기 전에는
   * 현재가=전일 종가·등락률 0 이다. 시황 스냅샷이 다음 개장까지 어제 값을 들고 있으므로 그것으로 메운다.
   * **정확히 0 일 때만** 바꾼다 — 진짜 보합은 스냅샷도 0 이고, 장중에는 같은 값이다.
   */
  const snap = await getMarketSnapshot(client).catch(() => null);
  return (data.result_list ?? [])
    .map((r) => ({
      rank: abs(r.rank),
      code: String(r.stk_cd ?? "").trim(),
      name: String(r.stk_nm ?? "").trim(),
      // 현재가는 부호가 붙어 오지만 가격에 음수는 없다
      price: abs(r.cur_pric),
      changeRate: signed(r.flu_rt),
      // 백만원 → 억원
      netAmount: signed(r.netprps_amt) / 100,
      netQty: signed(r.netprps_qty),
      accounts: abs(r.acct_qty),
      avgBuyPrice: abs(r.avg_pur_pric),
      profitRate: signed(r.prft_rt),
    }))
    .map((r) => {
      const s = snap?.byCode.get(r.code);
      return s && s.changeRate !== 0 && r.changeRate === 0 ? { ...r, price: Math.abs(s.price), changeRate: s.changeRate } : r;
    })
    .filter((r) => r.code && r.name);
}
