import { useState } from "react";
import { useLive } from "../useLive";
import type { RawRecord } from "../api";
import { CandleChart } from "./CandleChart";
import { useChartPrefs } from "../useChartPrefs";
import { ChartInsights } from "./ChartInsights";
import { PERIOD_CONFIG, toCandles, type Period } from "./chartCandles";

/**
 * 기간 전환이 되는 캔들차트 패널.
 * 종목 상세(모달)와 개별종목분석 페이지, 종목발굴이 같은 컴포넌트를 쓴다.
 */

export type { Period } from "./chartCandles";

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
  insights = true,
}: {
  code: string;
  /** 툴팁 머리에 쓸 종목명 */
  name?: string;
  initialPeriod?: Period;
  /** 차트 위 판독 줄(이동평균·매물대)을 붙일지 */
  insights?: boolean;
}) {
  const { prefs } = useChartPrefs();
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
      {/*
        판독 줄은 **일봉 기준**이다. 「5일선」은 5거래일이므로 주봉으로 재면 5주선이 된다.
        지금 보고 있는 게 KRX 일봉이면 받아 둔 배열을 그대로 넘기고(같은 걸 두 번 받지 않는다),
        다른 봉이나 다른 거래소를 보고 있으면 넘기지 않아 판독 줄이 일봉을 따로 받는다.
      */}
      {insights && prefs.insightsOn && (
        <ChartInsights
          code={code}
          candles={period === "day" && venue === "krx" && !loading ? candles : undefined}
        />
      )}
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
