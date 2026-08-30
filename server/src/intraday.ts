import type { KiwoomClient } from "./kiwoomClient.js";
import { dropPhantomToday } from "./candleGuard.js";

/**
 * 장중 기준선 — **데이트레이더가 화면에서 제일 먼저 찾는 선들.**
 *
 * ## 왜 이게 비어 있었나
 *
 * 이 앱은 체결강도 그래프에 100 기준선까지 그려 놓고 **정작 가격 쪽 기준선이 없었다.**
 * 호가·거래원·체결·분봉은 다 있는데, 「지금 값이 어디쯤인가」를 재는 자리가 없었다.
 * 값이 아무리 많아도 견줄 선이 없으면 「비싼가 싼가」를 못 판단한다.
 *
 * ## 다섯 개면 충분하다
 *
 *   **VWAP**        장중 그 종목의 「원가」. 오늘 산 사람들의 평균 매입가다.
 *                   위냐 아래냐로 판이 갈린다 — 위면 산 사람이 이기고 있는 것이다.
 *   **시가 갭**     어제 종가 대비 얼마나 벌리고 시작했나. 그리고 **그 갭을 메웠나.**
 *   **전일 고·저**  돌파 여부. 어제의 싸움이 끝난 자리다.
 *   **장초반 30분** 09:00~09:30 의 고·저. 그날의 1차 지지·저항이다.
 *   **지금 값**     위 넷과 견줄 기준.
 *
 * ## 값의 출처와 한계
 *
 *   · 분봉(`ka10080`, 5분) + 일봉(`ka10081`) 두 번 조회. 종목 하나당이다.
 *   · **정규장(09:00~15:30)만 센다.** 시간외·NXT 가 섞이면 VWAP 이 어긋난다.
 *   · VWAP 은 분봉의 **전형가**(고+저+종)/3 로 낸다. 진짜 VWAP 은 체결 하나하나로
 *     내지만 그건 REST 로 못 받는다 — **어림값이라고 화면에 적는다.**
 *   · 장 시작 전이면 오늘 분봉이 없다. 그때는 아무 값도 안 낸다.
 */

const CHART = "/api/dostk/chart";

export interface IntradayLevels {
  code: string;
  /** 무슨 날짜의 장중인가 (YYYYMMDD) */
  date: string;
  /** 지금(마지막 분봉) 값 */
  price: number;
  open: number;
  high: number;
  low: number;
  /** 거래량 가중 평균가 — **어림값**(분봉 전형가 기준) */
  vwap: number | null;
  /** 지금 값이 VWAP 대비 몇 % */
  vsVwap: number | null;

  prevClose: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  /** 시가 갭(%) — 전일 종가 대비 */
  gapPct: number | null;
  /**
   * 갭을 메웠나.
   *
   * 갭 상승이면 「전일 종가까지 내려왔나」, 갭 하락이면 「올라왔나」.
   * 갭이 없으면(±0.5% 안) `null` — 메울 갭이 없는데 「메웠다」고 하면 안 된다.
   */
  gapFilled: boolean | null;

  /** 09:00~09:30 고·저. 그날의 1차 지지·저항 */
  or30High: number | null;
  or30Low: number | null;

  /** 분봉 개수 — 몇 개로 낸 값인지 알아야 믿을지 판단한다 */
  bars: number;
}

function num(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s-]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

interface MinuteBar {
  /** YYYYMMDD */
  date: string;
  /** HHMM */
  hm: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export async function intradayLevels(
  client: KiwoomClient,
  code: string,
): Promise<IntradayLevels | null> {
  const min = await client.request<Record<string, unknown>>(CHART, "ka10080", {
    stk_cd: code,
    tic_scope: "5",
    upd_stkpc_tp: "1",
  });
  const rows = (min.data?.stk_min_pole_chart_qry ?? []) as Record<string, unknown>[];

  const bars: MinuteBar[] = rows
    .map((r) => {
      const t = String(r.cntr_tm ?? "");
      return {
        date: t.slice(0, 8),
        hm: Number(t.slice(8, 12)),
        open: num(r.open_pric),
        high: num(r.high_pric),
        low: num(r.low_pric),
        close: num(r.cur_prc),
        volume: num(r.trde_qty),
      };
    })
    .filter((b) => /^\d{8}$/.test(b.date) && Number.isFinite(b.hm) && b.close > 0)
    /*
     * **정규장만.** 시간외·NXT 봉이 섞이면 VWAP 도 시가도 어긋난다.
     * 09:00 개장이므로 첫 봉은 0900~0905 다.
     */
    .filter((b) => b.hm >= 900 && b.hm <= 1530)
    .sort((a, b) => (a.date === b.date ? a.hm - b.hm : a.date.localeCompare(b.date)));

  if (bars.length === 0) return null;

  const date = bars[bars.length - 1].date;
  const today = bars.filter((b) => b.date === date);
  if (today.length === 0) return null;

  let pv = 0;
  let vol = 0;
  let high = today[0].high;
  let low = today[0].low;
  let or30High: number | null = null;
  let or30Low: number | null = null;

  for (const b of today) {
    // 전형가 — 진짜 VWAP 은 체결 단위로 내지만 REST 로는 못 받는다
    pv += ((b.high + b.low + b.close) / 3) * b.volume;
    vol += b.volume;
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
    if (b.hm < 930) {
      or30High = or30High === null ? b.high : Math.max(or30High, b.high);
      or30Low = or30Low === null ? b.low : Math.min(or30Low, b.low);
    }
  }

  const price = today[today.length - 1].close;
  const open = today[0].open;
  const vwap = vol > 0 ? pv / vol : null;

  /* 전일 — 일봉에서 가져온다. 분봉으로 되짚으면 시간외가 섞인다 */
  let prevClose: number | null = null;
  let prevHigh: number | null = null;
  let prevLow: number | null = null;
  try {
    const d = new Date(Date.now() + 9 * 3600_000);
    const day = await client.request<Record<string, unknown>>(CHART, "ka10081", {
      stk_cd: code,
      base_dt: d.toISOString().slice(0, 10).replace(/-/g, ""),
      upd_stkpc_tp: "1",
    });
    const dRows = dropPhantomToday((day.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]);
    const prev = dRows
      .map((r) => ({
        dt: String(r.dt ?? ""),
        close: num(r.cur_prc),
        high: num(r.high_pric),
        low: num(r.low_pric),
      }))
      .filter((r) => /^\d{8}$/.test(r.dt) && r.dt < date && r.close > 0)
      .sort((a, b) => b.dt.localeCompare(a.dt))[0];
    if (prev) {
      prevClose = prev.close;
      prevHigh = prev.high;
      prevLow = prev.low;
    }
  } catch {
    /* 전일이 없어도 나머지는 낸다 — 하나가 없다고 전부를 안 주면 안 된다 */
  }

  const gapPct = prevClose && prevClose > 0 ? ((open - prevClose) / prevClose) * 100 : null;
  /*
   * ±0.5% 안이면 「갭이 아니다」로 본다. 1원 차이를 갭이라 부르고 「메웠다」고 하면
   * 그 말이 아무 뜻도 없어진다.
   */
  const gapFilled =
    gapPct === null || Math.abs(gapPct) < 0.5 || prevClose === null
      ? null
      : gapPct > 0
        ? low <= prevClose
        : high >= prevClose;

  return {
    code,
    date,
    price,
    open,
    high,
    low,
    vwap,
    vsVwap: vwap && vwap > 0 ? ((price - vwap) / vwap) * 100 : null,
    prevClose,
    prevHigh,
    prevLow,
    gapPct,
    gapFilled,
    or30High,
    or30Low,
    bars: today.length,
  };
}
