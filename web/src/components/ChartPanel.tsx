import type { BusinessDay, UTCTimestamp } from "lightweight-charts";
import { useState } from "react";
import { useLive } from "../useLive";
import { api, pickList, type RawRecord } from "../api";
import { CandleChart, type Candle } from "./CandleChart";

/**
 * 기간 전환이 되는 캔들차트 패널.
 * 종목 상세(모달)와 개별종목분석 페이지가 같은 컴포넌트를 쓴다.
 */

export type Period = "m3" | "m5" | "m15" | "m30" | "m60" | "day" | "week" | "month";

const MINUTE_KEYS = ["stk_min_pole_chart_qry"];

const PERIOD_CONFIG: Record<
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
    const candle: Candle = {
      time,
      open: Number(c.open_pric),
      high: Number(c.high_pric),
      low: Number(c.low_pric),
      close: Number(c.cur_prc),
      volume: Math.abs(Number(c.trde_qty)),
    };
    if (![candle.open, candle.high, candle.low, candle.close].every(Number.isFinite)) continue;
    out.push(candle);
  }
  // API는 최신순으로 내려오므로 시간순(오름차순)으로 뒤집기
  return out.reverse();
}

type Venue = "krx" | "nxt" | "all";

const VENUES: { key: Venue; label: string; hint: string }[] = [
  { key: "krx", label: "KRX", hint: "한국거래소 체결만 — 봉이 가장 안정적입니다" },
  { key: "nxt", label: "NXT", hint: "넥스트레이드 체결만" },
  { key: "all", label: "통합", hint: "두 거래소를 합친 체결 — 고가·저가가 벌어질 수 있습니다" },
];

export function ChartPanel({
  code,
  name,
  initialPeriod = "day",
}: {
  code: string;
  /** 툴팁 머리에 쓸 종목명 */
  name?: string;
  initialPeriod?: Period;
}) {
  const [period, setPeriod] = useState<Period>(initialPeriod);
  const [venue, setVenue] = useState<Venue>("krx");
  const isIntraday = PERIOD_CONFIG[period].intraday === true;

  /*
   * 키움은 종목코드 접미사로 거래소를 가른다 — 005930(KRX) / _NX(NXT) / _AL(통합).
   * 통합은 두 거래소 체결을 합친 것이라 봉의 고가·저가가 벌어지고, NXT는 거래가 얕은 종목에서
   * 봉이 튄다. 그래서 **기본은 KRX**로 두고 필요할 때만 바꿔 보게 한다.
   */
  const chartCode = venue === "krx" ? code : `${code}_${venue === "nxt" ? "NX" : "AL"}`;

  /*
   * 장중에는 조용히 갱신된다. 주기는 봉 단위에 맞춘다 —
   * 일봉은 하루에 한 번만 값이 바뀌므로 자주 부를 이유가 없고(마지막 봉의 종가만 움직인다),
   * 분봉은 자주 갱신돼야 의미가 있다. CandleChart 가 차트를 다시 만들지 않고
   * 데이터만 갈아끼우므로 확대해 둔 구간은 그대로 유지된다.
   */
  const { data: chart, loading, error } = useLive<RawRecord>(
    () => PERIOD_CONFIG[period].fetch(chartCode),
    [chartCode, period],
    isIntraday ? 10_000 : 60_000,
  );

  const candles = toCandles(chart, period);

  return (
    <>
      <div className="period-toggle">
        {VENUES.map((v) => (
          <button
            key={v.key}
            className={`period-btn venue ${v.key === venue ? "active" : ""}`}
            onClick={() => setVenue(v.key)}
            title={v.hint}
          >
            {v.label}
          </button>
        ))}
        <span className="period-sep" />
        {(Object.keys(PERIOD_CONFIG) as Period[]).map((p) => (
          <button
            key={p}
            className={`period-btn ${p === period ? "active" : ""}`}
            onClick={() => setPeriod(p)}
          >
            {PERIOD_CONFIG[p].label}
          </button>
        ))}
      </div>
      {loading && <div className="empty">차트 불러오는 중...</div>}
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && (
        <div className="chart-wrap">
          <CandleChart
            candles={candles}
            intraday={isIntraday}
            name={name ? `${name} · ${VENUES.find((v) => v.key === venue)?.label}` : undefined}
            code={code}
          />
        </div>
      )}
    </>
  );
}
