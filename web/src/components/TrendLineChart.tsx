import { createChart, ColorType, LineStyle, type BusinessDay } from "lightweight-charts";
import { useEffect, useRef } from "react";
import { chartColors, useAppearance } from "../useAppearance";

export interface TrendSeries {
  label: string;
  color: string;
  /** 오름차순(과거→현재) 정렬된 데이터 */
  data: { time: BusinessDay; value: number }[];
  /** 별도 축을 쓸지 (예: 주가와 지분율처럼 단위가 다를 때) */
  axis?: "left" | "right";
  type?: "line" | "histogram";
}

/**
 * 추이 비교용 라인/히스토그램 차트.
 * 외국인 지분율, 공매도량, 대차잔고처럼 "주가와 함께 보는 보조지표"에 쓴다.
 *
 * **여기는 봉으로 안 바꾼다.** 다른 차트는 전부 봉으로 통일했지만(2026-08-20),
 * 이 값들은 하루에 숫자가 **하나뿐**이다 — 지분율에 시가·고가·저가가 없다.
 * OHLC 가 없는 걸 봉으로 그리려면 없는 값을 지어내야 한다. 확인하고 선으로 남겼다.
 */
export function TrendLineChart({ series, height = 240 }: { series: TrendSeries[]; height?: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const { theme } = useAppearance();

  useEffect(() => {
    const c = chartColors(theme);
    const el = containerRef.current;
    if (!el || series.every((s) => s.data.length === 0)) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      leftPriceScale: { borderColor: c.border, visible: series.some((s) => s.axis === "left") },
      timeScale: { borderColor: c.border },
      crosshair: { horzLine: { style: LineStyle.Dotted }, vertLine: { style: LineStyle.Dotted } },
      // 세로 조작 잠금 — 캔들 차트와 같은 이유다 (CandleChart 주석 참고)
      handleScroll: { vertTouchDrag: false, horzTouchDrag: true, pressedMouseMove: true, mouseWheel: true },
      handleScale: {
        pinch: true,
        mouseWheel: true,
        axisDoubleClickReset: true,
        axisPressedMouseMove: { time: true, price: false },
      },
    });

    for (const s of series) {
      if (s.data.length === 0) continue;
      const options = {
        color: s.color,
        priceScaleId: s.axis === "left" ? "left" : "right",
        lineWidth: 2 as const,
        priceLineVisible: false,
        lastValueVisible: true,
      };
      const line =
        s.type === "histogram"
          ? chart.addHistogramSeries({ color: s.color, priceScaleId: options.priceScaleId, priceLineVisible: false })
          : chart.addLineSeries(options);
      line.setData(s.data);
    }

    chart.timeScale().fitContent();

    const resize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      chart.remove();
    };
  }, [series, height, theme]);

  if (series.every((s) => s.data.length === 0)) {
    return <div className="empty">데이터 없음</div>;
  }

  return (
    <div>
      <div className="chart-legend">
        {series.map((s) => (
          <span className="legend-item" key={s.label}>
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <div ref={containerRef} style={{ width: "100%" }} />
    </div>
  );
}

/** YYYYMMDD -> BusinessDay */
export function toBusinessDay(dt: string): BusinessDay | null {
  if (!/^\d{8}$/.test(dt)) return null;
  return { year: Number(dt.slice(0, 4)), month: Number(dt.slice(4, 6)), day: Number(dt.slice(6, 8)) };
}
