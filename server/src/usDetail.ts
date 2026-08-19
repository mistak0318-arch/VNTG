import { hantooGet, hantooReady } from "./hantooClient.js";
import { excdOf } from "./usQuotesHantoo.js";

/**
 * 해외주식 상세 — **한투가 주는 것으로 꾸린다.**
 *
 * 관심종목(해외)은 표로만 볼 수 있었다. 국내는 종목을 누르면 차트·재무·수급이 열리는데
 * 해외는 눌러도 아무 데도 안 갔다. 밤사이 무엇이 움직였나를 보고 나면 **그다음에 하는 건
 * 그 종목 하나를 들여다보는 것**인데 거기서 끊겼다.
 *
 * 쓰는 TR 은 `docs/한투API_참고.md` 에 적힌 것들이다. 추측한 것이 없다.
 *   현재가상세  `HHDFS76200200` price-detail
 *   기간별시세  `HHDFS76240000` dailyprice   (일/주/월)
 *
 * ## 못 하는 것을 미리 적어 둔다
 *
 * **재무제표가 없다.** 한투 해외주식에는 국내의 DART 같은 자리가 없다 — 매출·영업이익을
 * 넣고 싶어도 출처가 없다. 없는 것을 있는 척 채우느니 화면에서 빼는 게 낫다.
 * **수급도 없다.** 외국인·기관 순매수는 국내 시장의 개념이다.
 */

const DETAIL = "/uapi/overseas-price/v1/quotations/price-detail";
const DETAIL_TR = "HHDFS76200200";
const DAILY = "/uapi/overseas-price/v1/quotations/dailyprice";
const DAILY_TR = "HHDFS76240000";

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : null;
}

export interface UsDetail {
  symbol: string;
  excd: string | null;
  /**
   * 업종. `e_icod` 다 — 「컴퓨터전자장비/기기」처럼 **한글로** 온다.
   *
   * ⚠️ **종목명은 안 온다.** price-detail 의 `etyp_nm` 은 빈 값으로 오고 다른 이름 필드가
   * 없다(2026-08-20 실호출로 확인). 이름은 부르는 쪽이 이미 알고 있으니 거기서 쓴다.
   */
  sector: string;
  price: number | null;
  /** 전일 종가 — 등락을 여기서 계산한다 */
  base: number | null;
  change: number | null;
  changeRate: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** 전일 거래량 — 오늘이 평소보다 붐비는지 보려면 있어야 한다 */
  prevVolume: number | null;
  high52: number | null;
  low52: number | null;
  /** 시가총액 (백만 통화단위) */
  marketCap: number | null;
  per: number | null;
  pbr: number | null;
  eps: number | null;
  bps: number | null;
  /** 상장주식수 */
  shares: number | null;
  currency: string;
  /** 원화 환산가 (`t_xprc`) — 환율까지 얹힌 값이라 실제 체감에 가깝다 */
  wonPrice: number | null;
  /** 적용 환율 (`t_rate`) */
  fxRate: number | null;
  /** 매매 가능 여부 (`e_ordyn`) */
  tradable: string;
  error: string | null;
}

export async function usDetail(symbol: string): Promise<UsDetail> {
  const empty: UsDetail = {
    symbol,
    excd: null,
    sector: "",
    price: null,
    base: null,
    change: null,
    changeRate: null,
    open: null,
    high: null,
    low: null,
    volume: null,
    prevVolume: null,
    high52: null,
    low52: null,
    marketCap: null,
    per: null,
    pbr: null,
    eps: null,
    bps: null,
    shares: null,
    currency: "USD",
    wonPrice: null,
    fxRate: null,
    tradable: "",
    error: null,
  };
  if (!hantooReady()) return { ...empty, error: "한투 API 미설정" };

  const excd = await excdOf(symbol);
  // 거래소를 모르면 조회 자체가 안 된다 — 티커만으론 한투가 못 찾는다
  if (!excd) return { ...empty, error: "거래소를 찾지 못했습니다 (한투가 다루지 않는 종목일 수 있습니다)" };

  try {
    const body = await hantooGet<{ output?: Record<string, unknown> }>(
      DETAIL,
      DETAIL_TR,
      { AUTH: "", EXCD: excd, SYMB: symbol },
      "해외종목 상세",
    );
    const o = body.output ?? {};
    const price = num(o.last);
    const base = num(o.base);
    /*
     * **등락은 계산한다.**
     * price-detail 은 `diff`·`rate` 를 안 준다(실호출로 확인). 대신 전일 종가 `base` 가
     * 오므로 거기서 뺀다. `t_xrat` 는 **원화 기준** 등락률이라 환율이 섞여 있어 못 쓴다.
     */
    const change = price !== null && base !== null ? price - base : null;
    return {
      ...empty,
      excd,
      sector: String(o.e_icod ?? "").trim(),
      price,
      base,
      change,
      changeRate: change !== null && base ? (change / base) * 100 : null,
      open: num(o.open),
      high: num(o.high),
      low: num(o.low),
      volume: num(o.tvol),
      prevVolume: num(o.pvol),
      high52: num(o.h52p),
      low52: num(o.l52p),
      marketCap: num(o.tomv),
      per: num(o.perx),
      pbr: num(o.pbrx),
      eps: num(o.epsx),
      bps: num(o.bpsx),
      shares: num(o.shar),
      currency: String(o.curr ?? "USD"),
      wonPrice: num(o.t_xprc),
      fxRate: num(o.t_rate),
      tradable: String(o.e_ordyn ?? "").trim(),
    };
  } catch (err) {
    return { ...empty, excd, error: err instanceof Error ? err.message : "조회 실패" };
  }
}

export interface UsCandle {
  t: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * 기간별 시세.
 *
 * `GUBN`: 0 일 · 1 주 · 2 월. `BYMD` 를 비우면 오늘까지다.
 * 한투는 **최신순**으로 주므로 뒤집어서 넘긴다 — 차트는 오래된 것부터다.
 */
export async function usCandles(
  symbol: string,
  period: "D" | "W" | "M" = "D",
): Promise<{ candles: UsCandle[]; error: string | null }> {
  if (!hantooReady()) return { candles: [], error: "한투 API 미설정" };
  const excd = await excdOf(symbol);
  if (!excd) return { candles: [], error: "거래소를 찾지 못했습니다" };

  const gubn = period === "W" ? "1" : period === "M" ? "2" : "0";
  try {
    const body = await hantooGet<{ output2?: Record<string, unknown>[] }>(
      DAILY,
      DAILY_TR,
      { AUTH: "", EXCD: excd, SYMB: symbol, GUBN: gubn, BYMD: "", MODP: "1" },
      "해외종목 차트",
    );
    const rows = Array.isArray(body.output2) ? body.output2 : [];
    const candles = rows
      .map((r) => {
        const d = String(r.xymd ?? "");
        const close = num(r.clos) ?? 0;
        return {
          t: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : d,
          // 시·고·저가 비면 종가로 메운다. 봉이 사라지는 것보단 낫다
          open: num(r.open) ?? close,
          high: num(r.high) ?? close,
          low: num(r.low) ?? close,
          close,
          volume: num(r.tvol) ?? 0,
        };
      })
      .filter((c) => c.close > 0 && c.t)
      .sort((a, b) => a.t.localeCompare(b.t));
    return { candles, error: candles.length === 0 ? "봉이 하나도 없습니다" : null };
  } catch (err) {
    return { candles: [], error: err instanceof Error ? err.message : "차트 조회 실패" };
  }
}
