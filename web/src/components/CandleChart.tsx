import {
  createChart,
  ColorType,
  LineStyle,
  type IPriceLine,
  type SeriesMarker,
  type Time,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import { chartColors, useAppearance } from "../useAppearance";

export interface Candle {
  /** 일/주/월봉은 BusinessDay, 분봉은 UTCTimestamp(초) */
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const MA_LINES: { period: number; color: string }[] = [
  { period: 5, color: "#f5c542" },
  { period: 10, color: "#4ade80" },
  { period: 20, color: "#c084fc" },
  { period: 60, color: "#38bdf8" },
];

function sma(candles: Candle[], period: number): { time: Time; value: number }[] {
  const closes = candles.map((c) => c.close);
  const out: { time: Time; value: number }[] = [];
  for (let i = period - 1; i < candles.length; i++) {
    const slice = closes.slice(i - period + 1, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / period;
    out.push({ time: candles[i].time, value: avg });
  }
  return out;
}

/** 캔들 배열에서 기간 최고/최저를 낸다 (HTS의 최고/최저 표시용) */
function extremes(candles: Candle[]) {
  let hi = candles[0];
  let lo = candles[0];
  for (const c of candles) {
    if (c.high > hi.high) hi = c;
    if (c.low < lo.low) lo = c;
  }
  return { hi, lo };
}

/** 마커 정렬용 — Time을 비교 가능한 숫자로 (BusinessDay는 YYYYMMDD) */
function timeValue(time: Time): number {
  if (typeof time === "object" && "year" in time) {
    return time.year * 10000 + time.month * 100 + time.day;
  }
  return typeof time === "number" ? time : 0;
}

/** BusinessDay 또는 UTCTimestamp를 "05/06" 형태로 */
function labelDate(time: Time): string {
  if (typeof time === "object" && "month" in time) {
    return `${String(time.month).padStart(2, "0")}/${String(time.day).padStart(2, "0")}`;
  }
  if (typeof time === "number") {
    const d = new Date(time * 1000);
    return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
  }
  return String(time);
}

export function CandleChart({
  candles,
  intraday = false,
  showExtremes = true,
}: {
  candles: Candle[];
  intraday?: boolean;
  /** HTS처럼 기간 최고/최저를 선과 말풍선으로 표시 */
  showExtremes?: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useAppearance();

  useEffect(() => {
    const c = chartColors(theme);
    const el = containerRef.current;
    if (!el || candles.length === 0) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 320,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      // 분봉은 시:분까지 보여야 한다
      timeScale: { borderColor: c.border, timeVisible: intraday, secondsVisible: false },
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#ff5c5c",
      downColor: "#4c8dff",
      borderVisible: false,
      wickUpColor: "#ff5c5c",
      wickDownColor: "#4c8dff",
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.3 } });
    candleSeries.setData(
      candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
    );

    for (const { period, color } of MA_LINES) {
      const line = chart.addLineSeries({
        color,
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      line.setData(sma(candles, period));
    }

    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      color: c.volume,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.72, bottom: 0.05 }, visible: false });
    volumeSeries.setData(
      candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? "rgba(255,92,92,0.5)" : "rgba(76,141,255,0.5)",
      })),
    );

    /**
     * HTS처럼 최고/최저를 가로선 + 마커로 표시.
     * 전체 기간이 아니라 "지금 화면에 보이는 구간" 기준이라, 확대·이동하면 그 구간의
     * 고점/저점으로 다시 계산된다.
     */
    if (showExtremes && candles.length > 1) {
      const last = candles[candles.length - 1].close;
      const pct = (v: number) => {
        const r = ((last - v) / v) * 100;
        return `${r > 0 ? "+" : ""}${r.toFixed(2)}%`;
      };
      const won = (v: number) => v.toLocaleString("ko-KR");

      let hiLine: IPriceLine | null = null;
      let loLine: IPriceLine | null = null;

      const refresh = () => {
        const range = chart.timeScale().getVisibleLogicalRange();
        if (!range) return;
        // 논리 범위는 소수·범위 밖 값이 올 수 있어 배열 인덱스로 잘라 쓴다
        const from = Math.max(0, Math.ceil(range.from));
        const to = Math.min(candles.length - 1, Math.floor(range.to));
        if (to <= from) return;

        const { hi, lo } = extremes(candles.slice(from, to + 1));
        if (hiLine) candleSeries.removePriceLine(hiLine);
        if (loLine) candleSeries.removePriceLine(loLine);

        hiLine = candleSeries.createPriceLine({
          price: hi.high,
          color: "#ff5c5c",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `최고 ${won(hi.high)} (${pct(hi.high)}, ${labelDate(hi.time)})`,
        });
        loLine = candleSeries.createPriceLine({
          price: lo.low,
          color: "#4c8dff",
          lineWidth: 1,
          lineStyle: LineStyle.Dashed,
          axisLabelVisible: true,
          title: `최저 ${won(lo.low)} (${pct(lo.low)}, ${labelDate(lo.time)})`,
        });

        const markers: SeriesMarker<Time>[] = [
          {
            time: hi.time,
            position: "aboveBar",
            color: "#ff5c5c",
            shape: "arrowDown",
            text: `최고 ${won(hi.high)}`,
          },
          {
            time: lo.time,
            position: "belowBar",
            color: "#4c8dff",
            shape: "arrowUp",
            text: `최저 ${won(lo.low)}`,
          },
        ];
        // setMarkers는 시간 오름차순을 요구한다. 같은 봉이면 겹치므로 하나만.
        candleSeries.setMarkers(
          timeValue(hi.time) === timeValue(lo.time)
            ? [markers[0]]
            : [...markers].sort((a, b) => timeValue(a.time) - timeValue(b.time)),
        );
      };

      chart.timeScale().subscribeVisibleLogicalRangeChange(refresh);
      refresh();
    }

    chart.timeScale().fitContent();

    const resize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.remove();
    };
  }, [candles, intraday, showExtremes, theme]);

  if (candles.length === 0) {
    return <div className="empty">차트 데이터 없음</div>;
  }

  return (
    <div>
      <div className="chart-legend">
        {MA_LINES.map((m) => (
          <span className="legend-item" key={m.period}>
            <i style={{ background: m.color }} />
            MA{m.period}
          </span>
        ))}
      </div>
      <div ref={containerRef} style={{ width: "100%" }} />
    </div>
  );
}
