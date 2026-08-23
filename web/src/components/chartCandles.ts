import type { BusinessDay, UTCTimestamp } from "lightweight-charts";
import { api, pickList, type RawRecord } from "../api";
import type { Candle } from "./CandleChart";

/**
 * 봉 응답을 차트용 배열로 바꾸는 자리.
 *
 * ChartPanel 안에 있던 것을 따로 뺐다. 차트 위 판독 줄(`ChartInsights`)도 일봉을 파싱해야 하는데,
 * 그게 ChartPanel 에서 가져오면 **서로를 부르는 고리**가 된다(ChartPanel 은 판독 줄을 그린다).
 * 파싱을 양쪽 밖에 두면 고리가 없어진다.
 */

export type Period = "m3" | "m5" | "m15" | "m30" | "m60" | "day" | "week" | "month";

const MINUTE_KEYS = ["stk_min_pole_chart_qry"];

export const PERIOD_CONFIG: Record<
  Period,
  { label: string; fetch: (code: string) => Promise<RawRecord>; listKeys: string[]; intraday?: boolean }
> = {
  m3: { label: "3분", fetch: (c) => api.minuteChart(c, "3"), listKeys: MINUTE_KEYS, intraday: true },
  m5: { label: "5분", fetch: (c) => api.minuteChart(c, "5"), listKeys: MINUTE_KEYS, intraday: true },
  m15: { label: "15분", fetch: (c) => api.minuteChart(c, "15"), listKeys: MINUTE_KEYS, intraday: true },
  m30: { label: "30분", fetch: (c) => api.minuteChart(c, "30"), listKeys: MINUTE_KEYS, intraday: true },
  m60: { label: "60분", fetch: (c) => api.minuteChart(c, "60"), listKeys: MINUTE_KEYS, intraday: true },
  day: { label: "일봉", fetch: (code) => api.dailyChart(code), listKeys: ["stk_dt_pole_chart_qry"] },
  week: { label: "주봉", fetch: (code) => api.weeklyChart(code), listKeys: ["stk_stk_pole_chart_qry"] },
  month: { label: "월봉", fetch: (code) => api.monthlyChart(code), listKeys: ["stk_mth_pole_chart_qry"] },
};

function parseDt(dt: string): BusinessDay | null {
  if (!/^\d{8}$/.test(dt)) return null;
  return { year: Number(dt.slice(0, 4)), month: Number(dt.slice(4, 6)), day: Number(dt.slice(6, 8)) };
}

/**
 * 분봉 체결시간(YYYYMMDDHHmmss, 한국시간)을 차트용 타임스탬프로.
 * lightweight-charts는 UTC 기준으로 눈금을 그리므로, 한국시간 값을 그대로
 * UTC로 만들어 넘겨야 화면에 09:00처럼 한국시간이 표시된다.
 */
function parseMinuteTime(cntrTm: string): UTCTimestamp | null {
  if (!/^\d{12,14}$/.test(cntrTm)) return null;
  const y = Number(cntrTm.slice(0, 4));
  const mo = Number(cntrTm.slice(4, 6));
  const d = Number(cntrTm.slice(6, 8));
  const h = Number(cntrTm.slice(8, 10));
  const mi = Number(cntrTm.slice(10, 12));
  return (Date.UTC(y, mo - 1, d, h, mi) / 1000) as UTCTimestamp;
}

/** 응답 원본에서 차트에 그릴 캔들 배열을 만든다 */
export function toCandles(chart: RawRecord | null, period: Period): Candle[] {
  const cfg = PERIOD_CONFIG[period];
  const isIntraday = cfg.intraday === true;

  const out: Candle[] = [];
  for (const c of pickList(chart ?? undefined, cfg.listKeys)) {
    // 분봉은 cntr_tm(체결시간), 일/주/월봉은 dt(일자)를 쓴다
    const time = isIntraday ? parseMinuteTime(String(c.cntr_tm ?? "")) : parseDt(String(c.dt ?? ""));
    if (!time) continue;
    /*
     * ⚠️ **부호를 떼야 한다.**
     *
     * 키움은 값에 방향을 부호로 실어 준다 — 하락한 봉은 `-1396000` 처럼 온다.
     * 그대로 쓰면 **가격이 음수인 봉**이 생겨서 차트가 0 아래로 뻗고, 눈금이
     * -3,000,000 까지 벌어져 캔들이 납작한 선으로 뭉갠다. 「분봉이 이상하다」의 정체가 이것이다.
     *
     * 일봉 쪽은 이미 절댓값을 쓰고 있었는데 분봉만 빠져 있었다. 거래소를 NXT·통합으로
     * 바꾸면 더 심해 보이는 이유도 같다 — 하락 봉이 섞이는 만큼 아래로 벌어진다.
     */
    const candle: Candle = {
      time,
      open: Math.abs(Number(c.open_pric)),
      high: Math.abs(Number(c.high_pric)),
      low: Math.abs(Number(c.low_pric)),
      close: Math.abs(Number(c.cur_prc)),
      volume: Math.abs(Number(c.trde_qty)),
    };
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    out.push(candle);
  }
  // API는 최신순으로 내려오므로 시간순(오름차순)으로 뒤집기
  return out.reverse();
}

/**
 * 분봉을 **최근 며칠치**로 자른다.
 *
 * ## 왜 필요한가
 *
 * 키움 분봉은 며칠치를 한꺼번에 준다. 그걸 통째로 그리면 **하루가 손톱만 해져서
 * 분봉의 흐름이 안 보인다** — 분봉을 켜는 이유가 오늘 어떻게 흘렀나를 보는 것인데
 * 정작 그게 안 보이면 켠 뜻이 없다. 일봉·주봉은 원래 길게 보는 것이라 그대로 둔다.
 *
 * 「최근 N개 봉」이 아니라 **「최근 N일」**로 자른다. 3분봉과 60분봉은 하루에 담기는
 * 봉 개수가 스무 배 차이 나서, 개수로 자르면 60분봉은 며칠치가 남고 3분봉은 반나절만 남는다.
 *
 * 날짜는 타임스탬프를 그대로 나눠 센다 — 분봉 시각을 만들 때 **한국시간을 UTC 인 척**
 * 넣어 두었으므로(`parseMinuteTime`) 86400 으로 나누면 그게 곧 한국 날짜다.
 */
export function lastDays(candles: Candle[], days: number): Candle[] {
  if (days <= 0 || candles.length === 0) return candles;
  /*
   * ⚠️ **시각의 모양이 봉마다 다르다.**
   *
   * 분봉은 초 단위 숫자(`UTCTimestamp`)지만 **일·주·월봉은 `{year, month, day}` 객체**다.
   * 객체를 `Number()` 로 나눴더니 전부 `NaN` 이 되어 **캔들이 통째로 사라졌다** —
   * 일봉이 백스무 개를 넘는 순간 차트가 빈 채로 떴다.
   *
   * 둘 다 「같은 날이면 같은 값」만 나오면 되므로 모양에 맞춰 센다.
   */
  const dayOf = (t: Candle["time"]): number => {
    if (typeof t === "number") return Math.floor(t / 86400);
    if (typeof t === "object" && t && "year" in t) {
      return t.year * 10000 + t.month * 100 + t.day;
    }
    return Number(t);
  };
  const keys: number[] = [];
  for (let i = candles.length - 1; i >= 0; i--) {
    const k = dayOf(candles[i].time);
    if (keys[keys.length - 1] !== k) keys.push(k);
    if (keys.length >= days) {
      // 이 날짜부터 끝까지가 우리가 볼 구간이다
      const from = keys[keys.length - 1];
      return candles.filter((c) => dayOf(c.time) >= from);
    }
  }
  return candles;
}
