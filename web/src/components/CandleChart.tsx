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
import { useEffect, useRef, useState } from "react";
import { chartColors, useAppearance } from "../useAppearance";
import { useChartPrefs } from "../useChartPrefs";

export interface Candle {
  /** 일/주/월봉은 BusinessDay, 분봉은 UTCTimestamp(초) */
  time: Time;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/*
 * 이동평균은 이제 **설정에서 정한다**(설정 > 화면 > 차트). 무엇을 볼지는 사람마다 달라
 * 13일선을 쓰는 사람도 있고 볼린저만 보는 사람도 있다 — 코드에 박아 두면 그때마다 나를 불러야 한다.
 * 기본값과 색은 `useChartPrefs` 에 있고 키움 HTS 와 같은 색으로 맞춰 뒀다.
 */

/*
 * 차트 자물쇠 (2026-08-25, PDF #4) — **스크롤하다 차트가 움직이는 것**을 잠근다.
 *
 * 페이지를 내리려고 휠을 굴렸는데 커서가 차트 위에 있으면 차트가 확대된다 —
 * 매번 당한다. 잠그면 이동·확대가 전부 죽고, **십자선·클릭 정보(툴팁)는 그대로**다.
 * 전역으로 기억한다 — 차트마다 따로 잠그게 하면 화면 옮길 때마다 또 잠가야 한다.
 */
const LOCK_KEY = "vntg.chart.lock";

function lockedPref(): boolean {
  try {
    return localStorage.getItem(LOCK_KEY) === "1";
  } catch {
    return false;
  }
}

function scrollOptions(locked: boolean) {
  if (locked) {
    return {
      handleScroll: {
        vertTouchDrag: false,
        horzTouchDrag: false,
        pressedMouseMove: false,
        mouseWheel: false,
      },
      handleScale: {
        pinch: false,
        mouseWheel: false,
        axisDoubleClickReset: false,
        axisPressedMouseMove: { time: false, price: false },
      },
    };
  }
  return {
    /*
     * 세로로 움직여서 얻는 건 없다 — 가격 범위는 autoScale 이 알아서 맞춘다.
     * 남기는 건 **가로 이동**과 **확대·축소**뿐이다.
     */
    handleScroll: {
      vertTouchDrag: false, // 손가락 세로 드래그 (이게 오동작의 원인)
      horzTouchDrag: true, // 가로로 넘기기는 남긴다
      pressedMouseMove: true, // 마우스로 끌기 — 가로만 먹는다
      mouseWheel: true,
    },
    handleScale: {
      pinch: true, // 두 손가락 확대·축소
      mouseWheel: true,
      axisDoubleClickReset: true, // 축을 두 번 누르면 처음 배율로
      // 가격축을 끌어 세로로 늘이는 것도 막는다. 시간축 배율은 남긴다
      axisPressedMouseMove: { time: true, price: false },
    },
  };
}

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

/**
 * 볼린저 밴드 — 이동평균 ± 표준편차×배수.
 *
 * 가운데 선은 이동평균과 같으므로 **그리지 않는다.** 이평선을 이미 켜 두는 사람이 많아
 * 겹쳐 그리면 차트만 지저분해진다. 위·아래 띠만 그린다.
 */
function bollinger(
  rows: Candle[],
  period: number,
  mult: number,
): { upper: { time: Time; value: number }[]; lower: { time: Time; value: number }[] } {
  const upper: { time: Time; value: number }[] = [];
  const lower: { time: Time; value: number }[] = [];
  if (period < 2) return { upper, lower };
  for (let i = period - 1; i < rows.length; i++) {
    let sum = 0;
    for (let k = i - period + 1; k <= i; k++) sum += rows[k].close;
    const mean = sum / period;
    let sq = 0;
    for (let k = i - period + 1; k <= i; k++) sq += (rows[k].close - mean) ** 2;
    const sd = Math.sqrt(sq / period);
    upper.push({ time: rows[i].time, value: mean + sd * mult });
    lower.push({ time: rows[i].time, value: mean - sd * mult });
  }
  return { upper, lower };
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
  height = 320,
  sizeTick = 0,
  fitKey = "",
}: {
  candles: Candle[];
  intraday?: boolean;
  /** 차트 높이(px). 전체화면에서 화면 높이만큼 키운다 */
  height?: number;
  /**
   * 크기가 바뀌었다는 **신호**. 값이 달라지면 폭을 다시 잰다.
   *
   * 폭은 `clientWidth` 로 읽으므로 **가로만 바뀐 경우**에는 높이가 그대로라
   * 다시 잴 계기가 없다(창 크기가 바뀐 것도 아니라 resize 도 안 온다).
   * 보드에서 칸을 옆으로만 늘리면 차트가 옛 폭 그대로 남는 자리가 그것이다.
   * 크기를 아는 쪽이 이 숫자를 올려 주면 여기서는 다시 재기만 하면 된다.
   */
  sizeTick?: number;
  /**
   * **무엇을 그리고 있는지**를 알려주는 표. 이 값이 바뀌면 화면을 다시 맞춘다.
   *
   * 갱신 때마다 맞추면 확대해 둔 구간이 풀리고, 한 번만 맞추면 **봉을 바꿔도 시간축이
   * 예전 자리에 남는다** — 일봉(몇 달치)을 보다가 3분봉(하루치)으로 가면 봉이 구석에
   * 뭉쳐서 아무것도 안 보였다. 실제로 그래서 「분봉이 이상하다」가 나왔다.
   *
   * 「같은 것의 갱신」과 「다른 것으로 갈아탐」은 다른 일이라, 부르는 쪽이 알려 준다.
   */
  fitKey?: string;
  /** HTS처럼 기간 최고/최저를 선과 말풍선으로 표시 */
  showExtremes?: boolean;
  /** 툴팁 머리에 표시할 종목명·코드 (없으면 생략) */
  name?: string;
  code?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const { theme } = useAppearance();
  const { prefs } = useChartPrefs();
  /** 켜 둔 이평선만. 설정이 바뀌면 이 배열이 바뀌고 차트를 다시 만든다 */
  const maLines = prefs.ma.filter((m) => m.on);
  /** effect 의존성으로 쓸 지문 — 배열은 매 렌더 새 객체라 그대로는 못 쓴다 */
  const maKey = maLines.map((m) => `${m.period}:${m.color}`).join(",");

  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const maRefs = useRef<ISeriesApi<"Line">[]>([]);
  const bbRefs = useRef<ISeriesApi<"Line">[]>([]);
  /** 크로스헤어 핸들러가 늘 최신 설정을 보게 한다 */
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  /** 최신 캔들 — 크로스헤어 핸들러가 항상 최신 배열을 보게 한다 */
  const dataRef = useRef<Candle[]>(candles);
  dataRef.current = candles;
  /** 첫 데이터에서만 화면을 맞춘다. 갱신 때 fitContent 하면 확대가 풀린다 */
  const fitted = useRef(false);
  /** 마지막으로 화면을 맞췄을 때 무엇을 그리고 있었나 */
  const fittedKey = useRef("");
  /**
   * 최고/최저 가로선.
   *
   * effect 안의 지역변수로 두면 폴링으로 effect 가 다시 돌 때마다 새 클로저가 생겨
   * **이전에 그린 선을 못 지운다.** 그래서 갱신할 때마다 라벨이 하나씩 쌓였다.
   * 컴포넌트 수명 동안 유지되는 ref 에 담아 항상 직전 것을 지우고 다시 그린다.
   */
  const hiLineRef = useRef<IPriceLine | null>(null);
  const loLineRef = useRef<IPriceLine | null>(null);

  /**
   * **지금 값이 고점에서 얼마나 내려왔고 저점에서 얼마나 올라왔나.**
   *
   * 고·저 점선과 「고」·「저」 화살표는 이미 그리고 있었다. 그런데 **어느 자리인지만
   * 보여주고 얼마나 떨어졌는지는 안 말해 준다** — 497,500 과 362,000 을 눈으로 보고
   * 머릿속에서 나눠야 −27.2% 가 나온다. 매매에서 쓰는 건 그 퍼센트다.
   *
   * 차트 위에 겹쳐 쓰지 않는다(예전에 말풍선이 캔들을 가려서 뺐다). 범례 옆 한 줄이다.
   * **보이는 구간 기준**이라 확대·이동하면 그 구간의 고·저로 다시 계산된다 — 점선과
   * 화살표가 이미 그 규칙이므로 셋이 늘 같은 말을 한다.
   */
  const [gap, setGap] = useState<{ hi: number; lo: number; hiPct: number; loPct: number } | null>(
    null,
  );

  /* 자물쇠 — 전역 기억. ref 는 차트 생성 시점(위 effect)에서 최신값을 읽기 위한 것 */
  const [locked, setLocked] = useState(lockedPref);
  const lockRef = useRef(locked);
  lockRef.current = locked;
  function toggleLock() {
    const next = !locked;
    setLocked(next);
    try {
      localStorage.setItem(LOCK_KEY, next ? "1" : "0");
    } catch {
      /* 저장 못 해도 이번 화면에는 적용된다 */
    }
    chartRef.current?.applyOptions(scrollOptions(next));
    // 같은 화면의 다른 차트에도 그 자리에서 — 「전역」이라 해 놓고 새로고침해야 먹으면 거짓말이다
    window.dispatchEvent(new CustomEvent("vntg-chart-lock", { detail: next }));
  }

  /*
   * 자물쇠 동기화 (2026-08-26 — 「보드 차트가 자꾸 드래그된다」).
   *
   * 저장은 전역(localStorage)이었지만 **이미 떠 있는 다른 차트**는 제 상태를 그대로
   * 들고 있었다 — 특히 보드는 따로 띄운 창이라, 본창에서 잠가도 보드 차트는 계속
   * 끌렸다. 같은 창은 커스텀 이벤트로, 다른 창(보드)은 storage 이벤트로 받아서
   * 잠금이 **모든 창의 모든 차트에 그 자리에서** 걸리게 한다.
   */
  useEffect(() => {
    const apply = (v: boolean) => {
      setLocked(v);
      chartRef.current?.applyOptions(scrollOptions(v));
    };
    const onLocal = (e: Event) => apply(Boolean((e as CustomEvent).detail));
    const onStorage = (e: StorageEvent) => {
      if (e.key === LOCK_KEY) apply(e.newValue === "1");
    };
    window.addEventListener("vntg-chart-lock", onLocal);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("vntg-chart-lock", onLocal);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  /*
   * 키보드 조작 (2026-08-26 요청) — **+/− 확대·축소, ←/→ 좌우 이동.**
   *
   * 공통 모듈이라 여기 한 번이면 종목상세·보드·해외 시트 전부에 걸린다.
   * 차트가 여럿인 화면(보드)에서는 **마우스를 올려 둔 차트**가 대상이다 —
   * 입력창에 커서가 있으면 건드리지 않는다. 자물쇠가 잠겨 있어도 키는 듣는다:
   * 자물쇠는 「스크롤하다 실수로 움직이는 것」을 막는 것이지 조작 금지가 아니다.
   */
  const hoverRef = useRef(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!hoverRef.current) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      const ts = chartRef.current?.timeScale();
      const range = ts?.getVisibleLogicalRange();
      if (!ts || !range) return;
      const span = range.to - range.from;
      if (e.key === "+" || e.key === "=" || e.key === "-" || e.key === "_") {
        const zoomIn = e.key === "+" || e.key === "=";
        // 오른쪽(최근 봉)을 붙들고 조인다 — 확대하면 보고 있던 최근이 남아야 한다
        const next = Math.min(Math.max(zoomIn ? span * 0.75 : span * 1.33, 5), 3000);
        ts.setVisibleLogicalRange({ from: range.to - next, to: range.to });
        e.preventDefault();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const step = span * 0.15 * (e.key === "ArrowLeft" ? -1 : 1);
        ts.setVisibleLogicalRange({ from: range.from + step, to: range.to + step });
        e.preventDefault();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── 차트 생성 (테마·분봉 여부가 바뀔 때만) ────────────────────────────
  useEffect(() => {
    const c = chartColors(theme);
    const el = containerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: c.text },
      /*
       * 축 가격 표기 (2026-08-26) — 기본값은 「3002000.00」처럼 콤마 없이 소수점까지
       * 붙는다. 원화 종목엔 소수점이 뜻이 없고 축만 넓어져 폰에서 차트를 밀어냈다.
       * 1,000 이상은 콤마 정수로, 그 밑(미국 주식·저가)은 소수점 둘째 자리까지.
       */
      localization: {
        priceFormatter: (p: number) =>
          Math.abs(p) >= 1000
            ? Math.round(p).toLocaleString("ko-KR")
            : p.toLocaleString("ko-KR", { maximumFractionDigits: 2 }),
      },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
      // autoScale 을 켜 두면 보이는 구간에 맞춰 세로 범위가 늘 스스로 맞는다.
      // 세로 조작을 막았으므로 이게 없으면 봉이 화면 밖으로 나가도 되돌릴 방법이 없다
      rightPriceScale: { borderColor: c.border, autoScale: true },
      // 분봉은 시:분까지 보여야 한다
      timeScale: { borderColor: c.border, timeVisible: intraday, secondsVisible: false },
      /*
       * **세로 조작을 잠근다.**
       *
       * 손가락으로 훑으면 가로로 넘길 생각이었는데 조금만 비스듬해도 차트가 위아래로
       * 끌려갔다. 터치는 정확히 수평으로 긋기가 어려워서 만질 때마다 어긋난다.
       *
       * 세로로 움직여서 얻는 건 없다 — 가격 범위는 autoScale 이 알아서 맞춘다.
       * 남기는 건 **가로 이동**과 **확대·축소**뿐이다.
       */
      ...scrollOptions(lockRef.current),
    });
    chartRef.current = chart;

    const candleSeries = chart.addCandlestickSeries({
      // 봉 색은 테마가 준다 — 엑셀 모드에서는 회색조라야 시트 위 차트로 보인다
      upColor: c.up,
      downColor: c.down,
      borderVisible: false,
      wickUpColor: c.up,
      wickDownColor: c.down,
    });
    candleSeries.priceScale().applyOptions({ scaleMargins: { top: 0.05, bottom: 0.3 } });
    candleRef.current = candleSeries;

    maRefs.current = maLines.map(({ color }) =>
      chart.addLineSeries({ color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false }),
    );

    // 볼린저는 위·아래 두 줄. 점선으로 둬야 이평선과 구분된다
    bbRefs.current = prefs.bbOn
      ? [0, 1].map(() =>
          chart.addLineSeries({
            color: c.border,
            lineWidth: 1,
            lineStyle: LineStyle.Dashed,
            priceLineVisible: false,
            lastValueVisible: false,
          }),
        )
      : [];

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

      const pf = prefsRef.current;
      const maRows = (pf.tip.includes("ma") ? pf.ma.filter((m) => m.on) : []).map((m) => {
        const series = sma(rows, m.period);
        const hit = series.find((p) => timeValue(p.time) === timeValue(cur.time));
        if (!hit) return "";
        const gap = ((hit.value - cur.close) / cur.close) * 100;
        return (
          `<div class="ct-row"><span><i class="ct-dot" style="background:${m.color}"></i>${m.period}</span>` +
          `<b>${won(hit.value)}</b>` +
          // 이격도는 따로 끌 수 있다 — 값만 보고 싶은 사람이 있다
          (pf.tip.includes("gap") ? `<i>${gap > 0 ? "+" : ""}${gap.toFixed(2)}%</i>` : "") +
          `</div>`
        );
      }).join("");

      /*
       * 말풍선에 무엇을 넣을지는 설정에서 고른다.
       * 다 켜면 열 줄이 넘어 봉을 가린다 — 필요한 것만 남기는 게 낫다.
       */
      tip.innerHTML =
        (name ? `<div class="ct-name">${name}${code ? `(${code})` : ""}</div>` : "") +
        `<div class="ct-date">${tooltipDate(cur.time, intraday)}</div>` +
        (pf.tip.includes("ohlc")
          ? row("시가", cur.open) + row("고가", cur.high) + row("저가", cur.low)
          : "") +
        // 종가는 늘 보인다. 이것까지 끄면 말풍선을 띄울 이유가 없다
        row("종가", cur.close) +
        (pf.tip.includes("volume")
          ? `<div class="ct-row"><span>거래량</span><b>${won(cur.volume)}</b><i>${volRate}</i></div>`
          : "") +
        (maRows ? `<div class="ct-sub">가격 이동평균</div>${maRows}` : "");

      tip.style.display = "block";
      /*
       * ⚠️ **커서를 따라다니지 않는다.**
       *
       * 예전엔 커서 오른쪽 16px 에 붙였다. 그런데 말풍선을 띄우는 이유가 **그 봉을
       * 보려고** 인데, 바로 그 자리에 상자가 뜨니 봉과 그 옆 몇 개가 통째로 가려졌다.
       * 이동평균까지 켜면 열 줄이 넘어 차트 절반을 덮었다.
       *
       * 커서가 있는 **반대쪽 구석**에 붙박이로 둔다. 왼쪽 봉을 보면 오른쪽에, 오른쪽
       * 봉을 보면 왼쪽에 뜨므로 보려는 자리는 언제나 비어 있다. 상자가 안 움직이니
       * 눈이 따라다니지 않아도 되는 것도 덤이다.
       */
      const w = tip.offsetWidth;
      const left = param.point.x < el.clientWidth / 2 ? el.clientWidth - w - 8 : 8;
      tip.style.left = `${Math.max(4, left)}px`;
      tip.style.top = "8px";
    };
    chart.subscribeCrosshairMove(onMove);

    const resize = () => chart.applyOptions({ width: el.clientWidth, height });
    window.addEventListener("resize", resize);

    fitted.current = false;
    hiLineRef.current = null;
    loLineRef.current = null;
    return () => {
      window.removeEventListener("resize", resize);
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      maRefs.current = [];
      volRef.current = null;
    };
    // maKey·볼린저 설정이 바뀌면 시리즈 구성이 달라지므로 차트를 다시 만든다
  }, [intraday, theme, name, code, maKey, prefs.bbOn]);

  /*
   * 높이만 바뀌었을 때.
   *
   * 차트를 다시 만들면 확대해 둔 구간과 스크롤 자리가 풀린다 — 전체화면으로 들어갔다
   * 나올 때마다 보던 자리를 잃으면 전체화면이 방해가 된다. 옵션만 갈아끼운다.
   */
  useEffect(() => {
    const el = containerRef.current;
    if (!chartRef.current || !el) return;
    chartRef.current.applyOptions({ width: el.clientWidth, height });

    /*
     * 폭이 0 이면 아무것도 안 그려진다 — **까만 화면이 된다.**
     *
     * 전체화면으로 들어가는 순간처럼 자리가 아직 안 잡힌 때가 있다. 그때 한 번 더 잰다.
     * 타이머를 쓴다 — ResizeObserver 나 rAF 는 그리지 않는 탭에서 굶는다(겪었다).
     */
    const t = window.setTimeout(() => {
      const w = containerRef.current?.clientWidth ?? 0;
      if (w > 0) chartRef.current?.applyOptions({ width: w, height });
    }, 80);
    return () => clearTimeout(t);
  }, [height, sizeTick]);

  // ── 데이터 갱신 (차트는 그대로 두고 값만) ─────────────────────────────
  useEffect(() => {
    const chart = chartRef.current;
    const candleSeries = candleRef.current;
    if (!chart || !candleSeries || candles.length === 0) return;

    candleSeries.setData(
      candles.map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close })),
    );
    maRefs.current.forEach((line, i) => {
      const m = maLines[i];
      if (m) line.setData(sma(candles, m.period));
    });
    if (prefs.bbOn && bbRefs.current.length === 2) {
      const bb = bollinger(candles, prefs.bbPeriod, prefs.bbStdDev);
      bbRefs.current[0].setData(bb.upper);
      bbRefs.current[1].setData(bb.lower);
    }
    volRef.current?.setData(
      candles.map((c) => ({
        time: c.time,
        value: c.volume,
        color: c.close >= c.open ? "rgba(255,92,92,0.5)" : "rgba(76,141,255,0.5)",
      })),
    );

    /*
     * 처음 한 번과 **그리는 대상이 바뀐 때** 화면을 맞춘다.
     * 갱신 때마다 하면 확대해 둔 구간이 풀리고, 안 하면 봉을 바꿔도 시간축이 안 따라온다.
     */
    if (!fitted.current || fittedKey.current !== fitKey) {
      chart.timeScale().fitContent();
      fitted.current = true;
      fittedKey.current = fitKey;
    }

    /**
     * HTS처럼 최고/최저를 가로선 + 마커로 표시.
     * 전체 기간이 아니라 "지금 화면에 보이는 구간" 기준이라, 확대·이동하면 그 구간의
     * 고점/저점으로 다시 계산된다.
     */
    if (!showExtremes || candles.length < 2) {
      setGap(null); // 껐거나 봉이 모자라면 판독 줄도 지운다 — 옛 값이 남으면 거짓말이다
      return;
    }

    /* 괴리의 기준은 **지금 값**이다 — 보이는 구간이 어디든 「현재가가 얼마나 왔나」다 */
    const last = candles[candles.length - 1].close;

    const refresh = () => {
      const range = chart.timeScale().getVisibleLogicalRange();
      if (!range) return;
      // 논리 범위는 소수·범위 밖 값이 올 수 있어 배열 인덱스로 잘라 쓴다
      const from = Math.max(0, Math.ceil(range.from));
      const to = Math.min(candles.length - 1, Math.floor(range.to));
      if (to <= from) return;

      const { hi, lo } = extremes(candles.slice(from, to + 1));
      /* 고·저 선과 화살표도 봉과 같은 색이라야 한다 — 엑셀 모드에서는 회색조다 */
      const c = chartColors(theme);
      if (hiLineRef.current) candleSeries.removePriceLine(hiLineRef.current);
      if (loLineRef.current) candleSeries.removePriceLine(loLineRef.current);

      /*
       * ⚠️ **제목을 안 붙인다.**
       *
       * 예전엔 가격선에 「최고 1,412,000 (-3.26%, 08/20)」을 통째로 달았다. 그 상자가
       * 차트 한복판에 떠서 **캔들을 가렸다** — 정작 보려던 것을 덮은 것이다.
       * 게다가 화살표에도 같은 값을 또 적어서 한 정보가 두 겹이었다.
       *
       * 값은 **오른쪽 축**에 뜬다(`axisLabelVisible`). 어느 봉인지는 화살표가 알려 준다.
       * 괴리율은 **범례 줄 오른쪽 끝**(`.chart-gap`)에 있다 — 차트 위에 겹쳐 쓸 값이 아니다.
       */
      hiLineRef.current = candleSeries.createPriceLine({
        price: hi.high,
        color: c.up,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      });
      loLineRef.current = candleSeries.createPriceLine({
        price: lo.low,
        color: c.down,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "",
      });

      /* 화살표에도 값을 안 적는다 — 값은 축에 있고 여기선 「어느 봉인가」만 필요하다 */
      const markers: SeriesMarker<Time>[] = [
        { time: hi.time, position: "aboveBar", color: c.up, shape: "arrowDown", text: "고" },
        { time: lo.time, position: "belowBar", color: c.down, shape: "arrowUp", text: "저" },
      ];
      // setMarkers는 시간 오름차순을 요구한다. 같은 봉이면 겹치므로 하나만.
      candleSeries.setMarkers(
        timeValue(hi.time) === timeValue(lo.time)
          ? [markers[0]]
          : [...markers].sort((a, b) => timeValue(a.time) - timeValue(b.time)),
      );

      /* 판독 줄에 쓸 값 — 점선·화살표와 **같은 구간, 같은 고저**에서 낸다 */
      setGap(
        hi.high > 0 && lo.low > 0
          ? {
              hi: hi.high,
              lo: lo.low,
              hiPct: ((last - hi.high) / hi.high) * 100,
              loPct: ((last - lo.low) / lo.low) * 100,
            }
          : null,
      );
    };

    chart.timeScale().subscribeVisibleLogicalRangeChange(refresh);
    refresh();
    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(refresh);
    };
    /*
     * 설정이 바뀌면 위 effect 가 차트를 **새로 만든다.** 그때 이 effect 가 다시 돌지 않으면
     * 새로 만든 이평선·볼린저 시리즈가 빈 채로 남아 선이 사라진 것처럼 보인다.
     * 그래서 차트를 다시 만드는 조건을 여기에도 그대로 적는다.
     */
  }, [candles, fitKey, showExtremes, maKey, prefs.bbOn, prefs.bbPeriod, prefs.bbStdDev]);

  if (candles.length === 0) {
    return <div className="empty">차트 데이터 없음</div>;
  }

  return (
    <div
      onMouseEnter={() => {
        hoverRef.current = true;
      }}
      onMouseLeave={() => {
        hoverRef.current = false;
      }}
    >
      <div className="chart-legend">
        {/*
          고·저 괴리 — 범례 **맨 앞**이다 (2026-08-25).
          오른쪽 끝에 뒀더니 그 위에 붙박이인 「⤢ 크게」 버튼(absolute, 우상단)과
          겹쳐 가려졌다. 왼쪽 맨 앞이면 겹칠 게 없고, MA 이름표보다 매매에 먼저
          쓰는 값이라 앞에 오는 게 순서로도 맞다.
        */}
        {gap && (
          <span className="chart-gap">
            <b title={`구간 최고 ${gap.hi.toLocaleString("ko-KR")}`}>
              고점 <i className="negative">{gap.hiPct.toFixed(1)}%</i>
            </b>
            <b title={`구간 최저 ${gap.lo.toLocaleString("ko-KR")}`}>
              저점 <i className="positive">+{gap.loPct.toFixed(1)}%</i>
            </b>
          </span>
        )}
        {maLines.map((m) => (
          <span className="legend-item" key={m.period}>
            <i style={{ background: m.color }} />
            MA{m.period}
          </span>
        ))}
        {/* 자물쇠 — 잠그면 휠·드래그에 차트가 안 움직인다. 십자선·클릭 정보는 그대로 */}
        <button
          className={`chart-lock${locked ? " on" : ""}`}
          onClick={toggleLock}
          title={
            locked
              ? "차트 잠김 — 휠·드래그가 차트를 안 움직입니다 (십자선·키보드 +/−·←/→ 는 그대로). 눌러서 풀기"
              : "차트 잠그기 — 페이지 스크롤에 차트가 움직이는 걸 막습니다. 마우스를 올리고 +/− 확대·축소, ←/→ 이동"
          }
        >
          {locked ? "🔒" : "🔓"}
        </button>
      </div>
      <div className="candle-host">
        <div ref={containerRef} style={{ width: "100%" }} />
        <div ref={tipRef} className="candle-tip" />
      </div>
    </div>
  );
}
