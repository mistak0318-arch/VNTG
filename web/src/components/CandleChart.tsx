import {
  createChart,
  ColorType,
  LineStyle,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
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

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * 툴팁 머리글 — 일봉은 `2026/06/11(목)`, 분봉은 `06/11 13:45`.
 * 요일까지 넣는 이유는 월요일 갭이나 금요일 마감 같은 패턴이 눈에 들어오기 때문이다.
 */
function tooltipDate(time: Time, intraday: boolean): string {
  if (typeof time === "object" && "year" in time) {
    const d = new Date(Date.UTC(time.year, time.month - 1, time.day));
    return `${time.year}/${String(time.month).padStart(2, "0")}/${String(time.day).padStart(2, "0")}(${WEEKDAY[d.getUTCDay()]})`;
  }
  if (typeof time === "number") {
    const d = new Date(time * 1000);
    const md = `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}`;
    if (!intraday) return md;
    return `${md} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  }
  return String(time);
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

/**
 * 캔들 차트.
 *
 * **차트 생성과 데이터 갱신을 분리했다.** 장중에 몇 초마다 시세를 새로 받는데,
 * 그때마다 차트를 통째로 다시 만들면 사용자가 확대해 둔 구간과 스크롤 위치가
 * 매번 초기화된다 — 보고 있던 자리가 사라지므로 갱신이 방해가 된다.
 * 그래서 차트는 한 번만 만들고, 새 데이터는 series 에 setData 로 갈아끼운다.
 */
export function CandleChart({
  candles,
  intraday = false,
  showExtremes = true,
  name,
  code,
}: {
  candles: Candle[];
  intraday?: boolean;
  /** HTS처럼 기간 최고/최저를 선과 말풍선으로 표시 */
  showExtremes?: boolean;
  /** 툴팁 머리에 표시할 종목명·코드 (없으면 생략) */
  name?: string;
  code?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const { theme } = useAppearance();

  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const maRefs = useRef<ISeriesApi<"Line">[]>([]);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  /** 최신 캔들 — 크로스헤어 핸들러가 항상 최신 배열을 보게 한다 */
  const dataRef = useRef<Candle[]>(candles);
  dataRef.current = candles;
  /** 첫 데이터에서만 화면을 맞춘다. 갱신 때 fitContent 하면 확대가 풀린다 */
  const fitted = useRef(false);

  // ── 차트 생성 (테마·분봉 여부가 바뀔 때만) ────────────────────────────
  useEffect(() => {
    const c = chartColors(theme);
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: 320,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: c.text },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      rightPriceScale: { borderColor: c.border },
      // 분봉은 시:분까지 보여야 한다
      timeScale: { borderColor: c.border, timeVisible: intraday, secondsVisible: false },
    });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#ff5c5c",
      downColor: "#4c8dff",
      borderVisible: false,
      wickUpColor: "#ff5c5c",
      wickDownColor: "#4c8dff",
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.3 } });
    candleRef.current = candleSeries;

    maRefs.current = MA_LINES.map(({ color }) =>
      chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    );

    const volumeSeries = chart.addHistogramSeries({
      priceScaleId: "volume",
      priceFormat: { type: "volume" },
      color: c.volume,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    volumeSeries.priceScale().applyOptions({ scaleMargins: { top: 0.72, bottom: 0.05 }, visible: false });
    volRef.current = volumeSeries;

    /**
     * 봉 위에 올렸을 때 그 봉의 정보를 띄운다 (키움 차트와 같은 방식).
     *
     * 등락률은 전부 **직전 봉 종가 대비**다 — 키움 툴팁의 수치를 역산해 맞췄다.
     * 이동평균은 값과 함께 `(MA − 종가) / 종가` 이격을 보여준다. 종가가 이평선에서
     * 얼마나 떨어져 있는지가 이평선 값 자체보다 판단에 쓰인다.
     */
    const won = (v: number) => Math.round(v).toLocaleString("ko-KR");
    const rate = (v: number, base: number) => {
      if (!base) return "";
      const r = ((v - base) / base) * 100;
      return `${r > 0 ? "+" : ""}${r.toFixed(2)}%`;
    };
    const rateCls = (v: number, base: number) => (v > base ? "up" : v < base ? "down" : "");

    const onMove = (param: { time?: Time; point?: { x: number; y: number } }) => {
      const tip = tipRef.current;
      if (!tip) return;
      const rows = dataRef.current;
      if (!param.time || !param.point || rows.length === 0) {
        tip.style.display = "none";
        return;
      }
      const i = rows.findIndex((r) => timeValue(r.time) === timeValue(param.time as Time));
      if (i < 0) {
        tip.style.display = "none";
        return;
      }
      const cur = rows[i];
      const prev = rows[i - 1];
      // 첫 봉은 비교 대상이 없다 — 시가를 기준으로 삼는다 (0으로 나누는 것보다 낫다)
      const base = prev ? prev.close : cur.open;

      const row = (label: string, value: number) =>
        `<div class="ct-row"><span>${label}</span><b class="${rateCls(value, base)}">${won(value)}</b>` +
        `<i class="${rateCls(value, base)}">${rate(value, base)}</i></div>`;

      const volRate =
        prev && prev.volume > 0
          ? `${cur.volume >= prev.volume ? "+" : ""}${(((cur.volume - prev.volume) / prev.volume) * 100).toFixed(2)}%`
          : "";

      const maRows = MA_LINES.map((m) => {
        const series = sma(rows, m.period);
        const hit = series.find((p) => timeValue(p.time) === timeValue(cur.time));
        if (!hit) return "";
        const gap = ((hit.value - cur.close) / cur.close) * 100;
        return (
          `<div class="ct-row"><span><i class="ct-dot" style="background:${m.color}"></i>${m.period}</span>` +
          `<b>${won(hit.value)}</b><i>${gap > 0 ? "+" : ""}${gap.toFixed(2)}%</i></div>`
        );
      }).join("");

      tip.innerHTML =
        (name ? `<div class="ct-name">${name}${code ? `(${code})` : ""}</div>` : "") +
        `<div class="ct-date">${tooltipDate(cur.time, intraday)}</div>` +
        row("시가", cur.open) +
        row("고가", cur.high) +
        row("저가", cur.low) +
        row("종가", cur.close) +
        `<div class="ct-row"><span>거래량</span><b>${won(cur.volume)}</b><i>${volRate}</i></div>` +
        (maRows ? `<div class="ct-sub">가격 이동평균</div>${maRows}` : "");

      tip.style.display = "block";
      // 커서 오른쪽에 두되, 오른쪽 끝에서는 왼쪽으로 넘긴다
      const w = tip.offsetWidth;
      const left = param.point.x + 16 + w > el.clientWidth ? param.point.x - w - 16 : param.point.x + 16;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = "8px";
    };
    chart.subscribeCrosshairMove(onMove);

    const resize = () => chart.applyOptions({ width: el.clientWidth });
    window.addEventListener("resize", resize);

    fitted.current = false;
    return () => {
      window.removeEventListener("resize", resize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      maRefs.current = [];
      volRef.current = null;
    };
  }, [intraday, theme, name, code]);

  // ── 데이터 갱신 (차트는 그대로 두고 값만) ─────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleRef.current;
    if (!chart || !candleSeries || candles.length === 0) return;

    candleSeries.setData(
      candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    maRefs.current.forEach((line, i) => line.setData(sma(candles, MA_LINES[i].period)));
    volRef.current?.setData(
      candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? "rgba(255,92,92,0.5)" : "rgba(76,141,255,0.5)",
      })),
    );

    // 처음 한 번만 화면을 맞춘다 — 갱신 때마다 하면 사용자가 확대해 둔 구간이 풀린다
    if (!fitted.current) {
      chart.timeScale().fitContent();
      fitted.current = true;
    }

    /**
     * HTS처럼 최고/최저를 가로선 + 마커로 표시.
     * 전체 기간이 아니라 "지금 화면에 보이는 구간" 기준이라, 확대·이동하면 그 구간의
     * 고점/저점으로 다시 계산된다.
     */
    if (!showExtremes || candles.length < 2) return;

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
        { time: hi.time, position: "aboveBar", color: "#ff5c5c", shape: "arrowDown", text: `최고 ${won(hi.high)}` },
        { time: lo.time, position: "belowBar", color: "#4c8dff", shape: "arrowUp", text: `최저 ${won(lo.low)}` },
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
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refresh);
    };
  }, [candles, showExtremes]);

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
      <div className="candle-host">
        <div ref={containerRef} style={{ width: "100%" }} />
        <div ref={tipRef} className="candle-tip" />
      </div>
    </div>
  );
}
