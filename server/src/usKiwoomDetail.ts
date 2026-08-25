import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 키움 미국주식 세부 — **증설이지 교체가 아니다.**
 *
 * 한투가 주는 것(시간외 가격·야간선물·목표주가)은 키움에 없다 — 그건 그대로 둔다.
 * 여기서는 **키움만 주는 것**을 해외 상세에 얹는다: 프리장 시고저·진짜 업종·
 * 52주 고저(날짜 포함)·10호가·회전율. 2026-08-25 NVDA 실측으로 필드를 전부 확인했다.
 *
 * ## 단위 (실측 근거)
 *
 *   `mac`(시총)      **천 달러.** NVDA 5,068,932,000 → 5.07조 달러 ✓
 *   `stk_cnt`        주. 24,200,000,000 = 242억 주 ✓
 *   `trde_prica`     **천 달러.** 28,658,314 → 286.6억 달러 (NVDA 하루치로 맞다)
 *   가격             국내 TR 처럼 **부호가 등락 표시**다 — `-209.4600` 은 하락 중 209.46.
 *                    절댓값을 취해서 내보낸다. 등락은 `flu_rt` 가 말한다.
 *
 * ## 거래소 구분이 필수다
 *
 * `stex_tp` 없이는 조회가 안 된다(ND 나스닥 · NY 뉴욕 · NA 아멕스). 티커→거래소는
 * 한투 쪽이 이미 알아내 `usExchanges.json` 에 쌓아 뒀다(NAS/NYS/AMS 표기) — 같은
 * 파일을 읽어 키움 표기로 바꾼다. **미국이 아닌 거래소(일본·홍콩 등)면 null** —
 * 이 TR 은 미국 전용이라 없는 것을 부르지 않는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const EXCD_FILE = join(here, "..", "data", "usExchanges.json");

const MRKCOND = "/api/us/mrkcond";

/** 한투 거래소 표기 → 키움 stex_tp. 미국이 아니면 없다 */
const STEX: Record<string, string> = { NAS: "ND", NYS: "NY", AMS: "NA" };

/**
 * 티커 → 키움 거래소(ND/NY/NA) 전체 지도.
 * 실시간 FE 스케줄러도 이걸로 「미국 종목만」 거른다 — 일본·홍콩 티커에 FE 를 걸 수 없다.
 */
export async function usStexMap(): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(EXCD_FILE, "utf-8")) as Record<string, string>;
    const out: Record<string, string> = {};
    for (const [sym, excd] of Object.entries(raw)) {
      const stex = STEX[excd];
      if (stex) out[sym.toUpperCase()] = stex;
    }
    return out;
  } catch {
    return {};
  }
}

async function stexOf(symbol: string): Promise<string | null> {
  return (await usStexMap())[symbol.toUpperCase()] ?? null;
}

/** 부호를 뗀 숫자 — 가격용. 등락 방향은 flu_rt 몫이다 */
function abs(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[+,\s-]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}
/** 부호가 뜻인 숫자 — 등락률·증감용 */
function signed(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export interface UsKiwoomSummary {
  symbol: string;
  stex: string;
  name: string;
  /** 진짜 업종 — 대분류(IT)와 소분류(반도체 및 반도체장비). 한투·야후엔 없던 값 */
  sectorLg: string;
  sectorSm: string;
  /** 백만 달러 */
  marketCap: number | null;
  shares: number | null;
  price: number | null;
  changeRate: number | null;
  volume: number | null;
  week52: {
    high: number | null;
    highDate: string;
    /** 고점 대비 지금 (%) */
    highGap: number | null;
    low: number | null;
    lowDate: string;
    lowGap: number | null;
  };
  /** 프리장 시·고·저 — 야후·한투가 안 주던 값 */
  pre: { open: number | null; high: number | null; low: number | null };
  /** 정규장 기준 종가(전일) */
  baseClose: number | null;
  /** 한투와 견줄 수 있게 환율도 그대로 넘긴다 */
  exchangeRate: number | null;
}

export interface UsKiwoomBookRow {
  price: number | null;
  qty: number;
}

export interface UsKiwoomBook {
  /** 1호가(제일 싼 매도)부터 — 화면이 뒤집어 그린다(국내 호가창과 같은 규칙) */
  asks: UsKiwoomBookRow[];
  bids: UsKiwoomBookRow[];
  totalAsk: number;
  totalBid: number;
  /** 천 달러 */
  tradeValue: number | null;
  /** 회전율 % */
  turnover: number | null;
  /** 어느 시각의 호가인가 — 마감 후엔 마지막 호가라 이게 있어야 오해가 없다 */
  at: string;
  date: string;
}

export interface UsKiwoomDetail {
  summary: UsKiwoomSummary | null;
  book: UsKiwoomBook | null;
  /** 미국 종목이 아니면 여기 이유가 적힌다 — 화면은 블록을 통째로 숨긴다 */
  unsupported?: string;
}

/**
 * 두 TR 을 병렬로 받아 한 덩어리로 준다.
 * 한쪽이 실패해도 다른 쪽은 낸다 — 호가를 못 받았다고 업종까지 빈칸이 되면 안 된다.
 */
export async function usKiwoomDetail(
  client: KiwoomClient,
  symbol: string,
): Promise<UsKiwoomDetail> {
  const sym = symbol.toUpperCase();
  const stex = await stexOf(sym);
  if (!stex) {
    return { summary: null, book: null, unsupported: "미국(나스닥·뉴욕·아멕스) 종목만 됩니다" };
  }

  const [q, b] = await Promise.all([
    client.request<Record<string, unknown>>(MRKCOND, "usa20100", { stex_tp: stex, stk_cd: sym }).catch(() => null),
    client.request<Record<string, unknown>>(MRKCOND, "usa20101", { stex_tp: stex, stk_cd: sym }).catch(() => null),
  ]);

  let summary: UsKiwoomSummary | null = null;
  if (q?.data) {
    const d = q.data;
    const price = abs(d.cur_prc);
    const hi = abs(d["52wk_hgst_pric"]);
    const lo = abs(d["52wk_lwst_pric"]);
    summary = {
      symbol: sym,
      stex,
      name: String(d.stk_nm ?? sym),
      sectorLg: String(d.lg_inds_cd ?? ""),
      sectorSm: String(d.sm_inds_cd ?? ""),
      // 천 달러 → 백만 달러 (화면은 B/M 로 읽는다)
      marketCap: abs(d.mac) !== null ? Math.round((abs(d.mac) as number) / 1000) : null,
      shares: abs(d.stk_cnt),
      price,
      changeRate: signed(d.flu_rt),
      volume: abs(d.acc_trde_qty),
      week52: {
        high: hi,
        highDate: String(d["52wk_hgst_pric_dt"] ?? ""),
        highGap: hi && price ? ((price - hi) / hi) * 100 : null,
        low: lo,
        lowDate: String(d["52wk_lwst_pric_dt"] ?? ""),
        lowGap: lo && price ? ((price - lo) / lo) * 100 : null,
      },
      pre: { open: abs(d.pre_open_pric), high: abs(d.pre_high_pric), low: abs(d.pre_low_pric) },
      baseClose: abs(d.base_close_pric),
      exchangeRate: abs(d.base_exrt),
    };
  }

  let book: UsKiwoomBook | null = null;
  if (b?.data) {
    const d = b.data;
    const row = (side: "sel" | "buy", i: number): UsKiwoomBookRow => ({
      price: abs(d[`${side}_${i}bid`]),
      qty: abs(d[`${side}_${i}bid_req`]) ?? 0,
    });
    book = {
      asks: Array.from({ length: 10 }, (_, i) => row("sel", i + 1)),
      bids: Array.from({ length: 10 }, (_, i) => row("buy", i + 1)),
      totalAsk: abs(d.tot_sel_req) ?? 0,
      totalBid: abs(d.tot_buy_req) ?? 0,
      tradeValue: abs(d.trde_prica),
      turnover: signed(d.trde_tern_rt),
      at: String(d.bid_tm ?? ""),
      date: String(d.dt ?? ""),
    };
  }

  return { summary, book };
}
