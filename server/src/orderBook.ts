import type { KiwoomClient } from "./kiwoomClient.js";
import { findStock } from "./stockListCache.js";

/**
 * 호가창 — **지금 어느 쪽이 두터운가.**
 *
 * 종목 상세와 종목분석 **양쪽에서 같은 것을 쓴다.** 두 화면이 각자 호가를 그리면
 * 언젠가 한쪽만 고쳐져서 같은 종목이 다르게 보인다.
 *
 * ## 필드 이름이 1호가만 다르다 (2026-08-20 실측)
 *
 *   1호가      `sel_fpr_bid` / `sel_fpr_req`      ← fpr = first price
 *   2~10호가   `sel_2th_pre_bid` / `sel_2th_pre_req`
 *
 * 이걸 모르고 `sel_1th_pre_bid` 를 찾으면 **첫 줄만 빈다.** 실제로 그렇게 나왔다.
 *
 * ## 체결강도는 이 TR 에 없다
 *
 * `ka10004` 에도 `ka10001` 에도 없다. 순위 TR 에는 `cntr_str` 이 있지만 종목 단건으로
 * 부르는 길을 확인하지 못했다. **추측해서 넣지 않는다.**
 * 대신 **잔량비**(매수잔량÷매도잔량)를 낸다 — 체결강도와 다른 값이지만
 * 「지금 어느 쪽이 두터운가」라는 같은 물음에 답한다. 이름도 그대로 「잔량비」라 적는다.
 */

const MRKCOND = "/api/dostk/mrkcond";
const STKINFO = "/api/dostk/stkinfo";

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

/** 부호를 살려야 하는 값 (등락률 등) */
function signed(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export interface BookLevel {
  /** 1이 최우선호가 */
  step: number;
  price: number;
  qty: number;
}

export interface OrderBook {
  code: string;
  /** 호가 기준시각 HHMMSS */
  at: string;
  /** 매도호가 — **10호가가 위, 1호가가 아래**로 화면에 그린다 */
  asks: BookLevel[];
  /** 매수호가 — 1호가가 위 */
  bids: BookLevel[];
  totalAsk: number;
  totalBid: number;
  /** 시간외 잔량 */
  overtimeAsk: number;
  overtimeBid: number;
  /**
   * 잔량비 = 매수잔량 ÷ 매도잔량.
   * 1 보다 크면 사려는 쪽이 두텁다. **체결강도가 아니다** — 체결이 아니라 대기 물량이다.
   */
  ratio: number | null;

  /* ── 오른쪽 위에 놓을 값들 ── */
  price: number;
  changeRate: number;
  open: number;
  krxHigh: number;
  krxLow: number;
  /** 넥스트레이드 고·저. KRX 와 다를 수 있다 */
  nxtHigh: number | null;
  nxtLow: number | null;
  /** 250일 고·저 — 지금이 어디쯤인지 */
  high250: number;
  low250: number;
  /** 상·하한가 */
  upperLimit: number;
  lowerLimit: number;
  volume: number;
  /** 회전율(%) = 거래량 ÷ 상장주식수. 상장주식수를 모르면 null */
  turnover: number | null;
  error: string | null;
}

/** 매도·매수 10단계를 뽑는다 */
function levels(row: Record<string, unknown>, side: "sel" | "buy"): BookLevel[] {
  const out: BookLevel[] = [];
  // 1호가만 이름이 다르다 — fpr(first price)
  const p1 = num(row[`${side}_fpr_bid`]);
  const q1 = num(row[`${side}_fpr_req`]);
  if (p1 > 0) out.push({ step: 1, price: p1, qty: q1 });
  for (let i = 2; i <= 10; i++) {
    const p = num(row[`${side}_${i}th_pre_bid`]);
    const q = num(row[`${side}_${i}th_pre_req`]);
    if (p > 0) out.push({ step: i, price: p, qty: q });
  }
  return out;
}

export async function orderBook(client: KiwoomClient, code: string): Promise<OrderBook> {
  const bare = code.replace(/_(AL|NX)$/i, "");
  const empty: OrderBook = {
    code: bare,
    at: "",
    asks: [],
    bids: [],
    totalAsk: 0,
    totalBid: 0,
    overtimeAsk: 0,
    overtimeBid: 0,
    ratio: null,
    price: 0,
    changeRate: 0,
    open: 0,
    krxHigh: 0,
    krxLow: 0,
    nxtHigh: null,
    nxtLow: null,
    high250: 0,
    low250: 0,
    upperLimit: 0,
    lowerLimit: 0,
    volume: 0,
    turnover: null,
    error: null,
  };

  try {
    /*
     * 셋을 한 번에 받는다. NXT 는 실패해도 그냥 비워 둔다 —
     * 있으면 좋은 값이지 없으면 호가창을 못 그리는 값이 아니다.
     */
    const [book, info, nxt, common] = await Promise.all([
      client.request<Record<string, unknown>>(MRKCOND, "ka10004", { stk_cd: bare }),
      client.request<Record<string, unknown>>(STKINFO, "ka10001", { stk_cd: bare }),
      client
        .request<Record<string, unknown>>(STKINFO, "ka10001", { stk_cd: `${bare}_NX` })
        .catch(() => null),
      // 상장주식수는 전종목 목록이 들고 있다 — 회전율에 쓴다
      findStock(client, bare).catch(() => undefined),
    ]);

    const b = book.data ?? {};
    const i = info.data ?? {};
    const n = nxt?.data ?? null;

    const asks = levels(b, "sel");
    const bids = levels(b, "buy");
    const totalAsk = num(b.tot_sel_req);
    const totalBid = num(b.tot_buy_req);

    const shares = Number(common?.shares) || null;
    const volume = num(i.trde_qty);

    return {
      ...empty,
      at: String(b.bid_req_base_tm ?? ""),
      // 매도호가는 **높은 값이 위**로 가야 화면이 HTS 와 같아진다
      asks: asks.sort((x, y) => y.step - x.step),
      bids,
      totalAsk,
      totalBid,
      overtimeAsk: num(b.ovt_sel_req),
      overtimeBid: num(b.ovt_buy_req),
      ratio: totalAsk > 0 ? totalBid / totalAsk : null,
      price: num(i.cur_prc),
      changeRate: signed(i.flu_rt),
      open: num(i.open_pric),
      krxHigh: num(i.high_pric),
      krxLow: num(i.low_pric),
      nxtHigh: n ? num(n.high_pric) || null : null,
      nxtLow: n ? num(n.low_pric) || null : null,
      high250: num(i["250hgst"]),
      low250: num(i["250lwst"]),
      upperLimit: num(i.upl_pric),
      lowerLimit: num(i.lst_pric),
      volume,
      turnover: shares && shares > 0 ? (volume / shares) * 100 : null,
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "호가 조회 실패" };
  }
}
