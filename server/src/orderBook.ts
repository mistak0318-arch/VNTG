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
 * ## 세 TR 을 합친다
 *
 *   `ka10004` 호가·잔량
 *   `ka10001` 현재가·시고저·기준가·상하한·250일
 *   `ka10003` **체결 목록** — 체결강도·누적거래대금·최근 체결 틱
 *
 * 체결강도는 한동안 「없다」고 적혀 있었다. `ka10004`·`ka10001` 에 없어서 잔량비로
 * 대신했는데 **`ka10003` 안에 있었다.** 누적거래대금도 거기 있다 —
 * HTS 호가 화면 오른쪽에 늘 붙어 있는 그 값이 `ka10001` 에는 없다.
 *
 * 잔량비(매수잔량÷매도잔량)는 그대로 둔다. 체결강도와 **다른 값**이라서다 —
 * 하나는 체결된 것이고 하나는 대기 물량이다.
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
  /** 어느 시장의 호가인가 — KRX 가 비는 프리·애프터엔 NXT 호가로 폴백한다 */
  venue?: "KRX" | "NXT";
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
  /**
   * 체결강도(%). `ka10003`(체결정보)이 준다.
   * 100 보다 크면 **매수 체결이 매도 체결보다 많았다**는 뜻이다.
   * 잔량비와 다르다 — 이건 **실제 체결**이고 잔량비는 대기 물량이다.
   */
  strength: number | null;
  /** 기준가(전일 종가). 호가마다 등락률을 붙이는 기준 */
  basePrice: number;
  /**
   * 누적거래대금(원).
   *
   * `ka10001`(기본정보)에는 **없고** `ka10003`(체결정보)의 `acc_trde_prica` 에 있다.
   * HTS 호가 화면 오른쪽에 늘 붙어 있는 값이라 없으면 화면이 비어 보인다.
   */
  tradeValue: number;
  /**
   * 최근 체결 몇 건 — HTS 호가 화면 **왼쪽 아래에 흐르는 그 목록**이다.
   *
   * 수량 부호가 방향이다(`-` 매도 체결, `+` 매수 체결). 키움이 그렇게 준다.
   */
  ticks: { t: string; price: number; qty: number }[];
  error: string | null;
}

interface Tick {
  /** HHmmss */
  t: string;
  price: number;
  /** 부호가 방향 — 음수면 매도 체결 */
  qty: number;
  /** 그 시점 누적거래대금(원) */
  accValue: number;
  strength: number;
}

/** `ka10003` 응답에서 체결 목록을 뽑는다 (첫 행이 가장 최근) */
function ticksOf(data: Record<string, unknown> | null | undefined): Tick[] {
  const rows = (data as Record<string, unknown>)?.cntr_infr;
  if (!Array.isArray(rows)) return [];
  return (rows as Record<string, unknown>[])
    .map((r) => ({
      t: String(r.tm ?? "").trim(),
      price: Math.abs(num(r.cur_prc)),
      // ⚠️ `num` 은 부호를 살려야 한다 — 이 부호가 매수·매도 방향이다
      qty: signedInt(r.cntr_trde_qty),
      accValue: num(r.acc_trde_prica),
      strength: Number(String(r.cntr_str ?? "").replace(/[+,\s]/g, "")) || 0,
    }))
    .filter((r) => r.t.length >= 6 && r.price > 0);
}

function strengthOf(ticks: Tick[]): number | null {
  const v = ticks.length > 0 ? ticks[0].strength : 0;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** 부호를 살린 정수 — `-5` 는 매도 체결 5주다 */
function signedInt(v: unknown): number {
  const raw = String(v ?? "").replace(/[,\s]/g, "");
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
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
    strength: null,
    basePrice: 0,
    tradeValue: 0,
    ticks: [],
    error: null,
  };

  try {
    /*
     * 셋을 한 번에 받는다. NXT 는 실패해도 그냥 비워 둔다 —
     * 있으면 좋은 값이지 없으면 호가창을 못 그리는 값이 아니다.
     */
    const [book, info, nxt, common, tick] = await Promise.all([
      client.request<Record<string, unknown>>(MRKCOND, "ka10004", { stk_cd: bare }),
      client.request<Record<string, unknown>>(STKINFO, "ka10001", { stk_cd: bare }),
      client
        .request<Record<string, unknown>>(STKINFO, "ka10001", { stk_cd: `${bare}_NX` })
        .catch(() => null),
      // 상장주식수는 전종목 목록이 들고 있다 — 회전율에 쓴다
      findStock(client, bare).catch(() => undefined),
      /*
       * 체결강도는 **`ka10003`(체결정보)에 있다.**
       * `ka10004`(호가)·`ka10001`(기본정보)에는 없어서 한동안 잔량비로 대신했는데,
       * 찾고 보니 키움 안에 있었다 — 한투를 뒤질 필요가 없었다.
       * 첫 행이 가장 최근 체결이다.
       */
      client
        // 체결은 통합(_AL) — NXT 체결도 최근 체결·체결강도에 들어와야 한다 (2026-08-26)
        .request<Record<string, unknown>>(STKINFO, "ka10003", { stk_cd: `${bare}_AL` })
        .catch(() => null),
    ]);
    let b = book.data ?? {};
    const i = info.data ?? {};
    const n = nxt?.data ?? null;

    /*
     * NXT 호가 폴백 (2026-08-26 — 「NXT 에서 호가창이 왜 안 나와」).
     * KRX 호가가 통째로 비면(프리 08:00~08:50 · 애프터 15:30~20:00) `_NX` 로
     * 다시 받는다 — 실측: 프리장 ka10004 `000660_NX` 가 살아 있는 10단계를 줬다
     * (매수1 1,696,000 · 총잔량 27,617). venue 로 어느 시장 호가인지 밝힌다.
     */
    let venue: "KRX" | "NXT" = "KRX";
    if (num(b.tot_sel_req) === 0 && num(b.tot_buy_req) === 0) {
      const nx = await client
        .request<Record<string, unknown>>(MRKCOND, "ka10004", { stk_cd: `${bare}_NX` })
        .catch(() => null);
      const nb = nx?.data ?? null;
      if (nb && (num(nb.tot_sel_req) > 0 || num(nb.tot_buy_req) > 0)) {
        b = nb;
        venue = "NXT";
      }
    }

    const ticks = ticksOf(tick?.data as Record<string, unknown> | null);

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
      /** 기준가(전일 종가) — 호가마다 등락률을 붙이려면 이게 있어야 한다 */
      basePrice: num(i.base_pric),
      strength: strengthOf(ticks),
      /** 누적거래대금(원). `ka10003` 이 준다 — `ka10001` 에는 없다 */
      tradeValue: ticks.length > 0 ? ticks[0].accValue : 0,
      ticks: ticks.slice(0, 20).map((t) => ({ t: t.t, price: t.price, qty: t.qty })),
      venue,
    };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : "호가 조회 실패" };
  }
}
