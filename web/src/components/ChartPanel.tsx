import type { BusinessDay, UTCTimestamp } from "lightweight-charts";
import { useEffect, useState } from "react";
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
  const [chart, setChart] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    PERIOD_CONFIG[period]
      .fetch(code)
      .then((res) => {
        if (!cancelled) setChart(res);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code, period]);

  const isIntraday = PERIOD_CONFIG[period].intraday === true;
  const candles = toCandles(chart, period);

  return (
    <>
      <div className="period-toggle">
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
          <CandleChart candles={candles} intraday={isIntraday} name={name} code={code} />
        </div>
      )}
    </>
  );
}
