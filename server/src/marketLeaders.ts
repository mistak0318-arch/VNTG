/**
 * **주도주·급소** — 시황 대시보드의 한 카드 (2026-09-10).
 *
 * 벤티지: "시장의 흐름을 더 잘 예측하는 방향으로 개편". 종목등락현황은 「상한가 12개」라는 **수**만
 * 주고, 그게 **누구**인지·며칠째인지는 시세분석까지 가야 했다. 여기서는 증권사 API 전수 조사에서
 * 건진 네 조회를 한 번에 묶어 「지금 시장이 어디로 힘을 쓰는가」를 한 카드로 답한다.
 *
 * - 상한가 `ka10017` — 누가, 며칠째(연속). 상한가 종목의 얼굴이 곧 오늘의 주도 테마다.
 * - 거래량 급증 `ka10023` — 전일 대비 급증률. 조용하던 종목이 터지는 순간.
 * - 거래량 갱신 `ka10024` — 250일 최대 거래. 1년 만의 손바뀜.
 * - 프로그램 순매수 `ka90003` — 외국인·기관 바스켓의 방향(코스피·코스닥 각각).
 *
 * 네 TR 이 한 번에 나가므로 **60초 캐시**로 묶고, 장이 안 열린 시간엔 마지막 값을 그대로 둔다
 * (장 마감 뒤에도 「오늘 상한가가 누구였나」는 볼 만하다). 실패한 조회는 빈 배열 — 카드가 통째로
 * 죽지 않는다.
 */
import type { KiwoomClient } from "./kiwoomClient.js";

export interface PulseStock {
  code: string;
  name: string;
  price: number;
  rate: number;
  /** 상한가: 연속 일수 / 급증: 급증률 % / 갱신: 오늘 거래량 / 프로그램: 순매수 금액(백만) */
  v: number;
  /** 보조 — 급증: 오늘 거래량 / 갱신: 기간 최대 / 프로그램: 거래량 */
  v2?: number;
}

export interface MarketLeaders {
  at: string;
  upper: PulseStock[];
  lower: PulseStock[];
  surge: PulseStock[];
  renew: PulseStock[];
  program: { kospi: PulseStock[]; kosdaq: PulseStock[]; kospiSell: PulseStock[]; kosdaqSell: PulseStock[] };
  errors: string[];
}

const num = (v: unknown): number => {
  const n = Number(String(v ?? "").replace(/[,+]/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const code6 = (v: unknown): string => String(v ?? "").replace(/^A/, "").replace(/_AL$/, "").slice(0, 6);
const base = (r: Record<string, unknown>) => ({
  code: code6(r.stk_cd),
  name: String(r.stk_nm ?? ""),
  price: Math.abs(num(r.cur_prc)),
  rate: num(r.flu_rt),
});

let cache: { at: number; data: MarketLeaders } | null = null;
const TTL = 60_000;
let inflight: Promise<MarketLeaders> | null = null;

async function list(client: KiwoomClient, uri: string, id: string, body: Record<string, string>, key: string): Promise<Record<string, unknown>[]> {
  const r = await client.request<Record<string, unknown>>(`/api/dostk/${uri}`, id, body);
  const arr = r.data[key];
  return Array.isArray(arr) ? (arr as Record<string, unknown>[]) : [];
}

async function build(client: KiwoomClient): Promise<MarketLeaders> {
  const errors: string[] = [];
  const safe = async <T,>(label: string, p: Promise<T>, empty: T): Promise<T> => {
    try {
      return await p;
    } catch (e) {
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
      return empty;
    }
  };
  const updown = (tp: string) =>
    list(client, "stkinfo", "ka10017", { mrkt_tp: "000", updown_tp: tp, sort_tp: "2", stk_cnd: "0", trde_qty_tp: "00000", crd_cnd: "0", trde_gold_tp: "0", stex_tp: "3" }, "updown_pric");
  const program = (upper: string, mkt: string) =>
    list(client, "stkinfo", "ka90003", { trde_upper_tp: upper, amt_qty_tp: "1", mrkt_tp: mkt, stex_tp: "3" }, "prm_netprps_upper_50");

  const [up, low, surge, renew, pK, pQ, sK, sQ] = await Promise.all([
    safe("상한가", updown("1"), []),
    safe("하한가", updown("4"), []),
    safe(
      "거래량급증",
      list(client, "rkinfo", "ka10023", { mrkt_tp: "000", sort_tp: "2", tm_tp: "2", trde_qty_tp: "50", tm: "", stk_cnd: "0", pric_tp: "0", stex_tp: "3" }, "trde_qty_sdnin"),
      [],
    ),
    safe("거래량갱신", list(client, "stkinfo", "ka10024", { mrkt_tp: "000", cycle_tp: "250", trde_qty_tp: "50", stex_tp: "3" }, "trde_qty_updt"), []),
    safe("프로그램 코스피", program("2", "P00101"), []),
    safe("프로그램 코스닥", program("2", "P10102"), []),
    safe("프로그램 코스피 매도", program("1", "P00101"), []),
    safe("프로그램 코스닥 매도", program("1", "P10102"), []),
  ]);

  const toUpdown = (rows: Record<string, unknown>[]) =>
    rows.map((r) => ({ ...base(r), v: num(r.cnt), v2: Math.abs(num(r.trde_qty)) })).sort((a, b) => b.v - a.v || b.rate - a.rate);
  const toSurge = (rows: Record<string, unknown>[]) =>
    rows
      .map((r) => ({ ...base(r), v: num(r.sdnin_rt), v2: Math.abs(num(r.now_trde_qty)) }))
      .filter((x) => x.price > 0)
      .slice(0, 8);
  const toRenew = (rows: Record<string, unknown>[]) =>
    rows
      .map((r) => ({ ...base(r), v: Math.abs(num(r.now_trde_qty)), v2: Math.abs(num(r.prev_trde_qty)) }))
      .sort((a, b) => b.rate - a.rate)
      .slice(0, 8);
  const toProgram = (rows: Record<string, unknown>[]) =>
    rows
      .map((r) => ({
        code: code6(r.stk_cd),
        name: String(r.stk_nm ?? ""),
        price: Math.abs(num(r.cur_prc)),
        rate: num(r.flu_rt),
        v: num(r.prm_netprps_amt),
        v2: Math.abs(num(r.acc_trde_qty)),
      }))
      .filter((x) => x.v !== 0)
      .slice(0, 6);

  return {
    at: new Date().toISOString(),
    upper: toUpdown(up),
    lower: toUpdown(low),
    surge: toSurge(surge),
    renew: toRenew(renew),
    program: { kospi: toProgram(pK), kosdaq: toProgram(pQ), kospiSell: toProgram(sK), kosdaqSell: toProgram(sQ) },
    errors,
  };
}

export async function marketLeaders(client: KiwoomClient): Promise<MarketLeaders> {
  if (cache && Date.now() - cache.at < TTL) return cache.data;
  if (inflight) return inflight;
  inflight = build(client)
    .then((d) => {
      /* 전부 비고 에러만 있으면(장전·키움 장애) 마지막 값을 지킨다 */
      const empty = d.upper.length + d.surge.length + d.renew.length + d.program.kospi.length === 0;
      if (empty && cache && d.errors.length > 0) return cache.data;
      cache = { at: Date.now(), data: d };
      return d;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
