import { useEffect, useMemo, useState } from "react";
import { useSheetBack } from "../../useSheetBack";
import type { UTCTimestamp } from "lightweight-charts";
import {
  api,
  fmtNum,
  type UsDetail,
  type UsEtfHoldings,
  type UsKiwoomDetailData,
  type YahooChart,
} from "../../api";
import { CandleChart } from "../CandleChart";
import { IntradayFlowChart } from "./IntradayFlowChart";

/**
 * 지수·원자재 차트.
 *
 * 전광판은 숫자 한 줄뿐이라 "지금 얼마"는 알아도 **"어디쯤인가"**를 모른다.
 * 나스닥 -0.12% 는 그 자체로 아무 뜻이 없고, 최근 한 달을 어떻게 왔는지를 봐야
 * 판단이 선다. 그래서 상자를 누르면 이게 열린다.
 *
 * ## 왜 캔버스 차트 라이브러리를 안 쓰나
 *
 * 종목 차트는 `lightweight-charts` 를 쓴다. 여기서는 **SVG 로 직접 그린다.**
 * 이건 선 하나짜리 그림이라 라이브러리가 필요 없고, 무엇보다 캔버스는 컨테이너 폭을
 * 재서 비트맵 크기를 맞춰야 하는데 그 과정이 개발 창에서 어긋난 적이 있다.
 * SVG 는 `viewBox` 라 폭에 상관없이 같은 그림이 나온다.
 */

/**
 * 야후 봉을 **차트 모듈이 받는 모양**으로 바꾼다.
 *
 * ## ⚠️ 중복 시각을 반드시 걸러야 한다
 *
 * `lightweight-charts` 는 시각이 오름차순이 **아니면 단언으로 죽는다**
 * (`data must be asc ordered by time`). 실제로 죽었다 — 선물(NQ=F) 1일 분봉에
 * 같은 분이 두 번 들어 있었다. 예전 SVG 는 그냥 겹쳐 그려서 아무도 몰랐다.
 *
 * 그래서 **같은 시각은 뒤엣것만 남긴다.** 야후가 같은 분을 두 번 줄 때 뒤엣것이
 * 갱신본이다. 지어내거나 시각을 밀어 옮기지 않는다 — 그러면 축이 조용히 거짓이 된다.
 *
 * 분봉(1d·5d)은 **초 단위 시각**으로 넘긴다. 날짜로만 바꾸면 하루치 분봉이 전부
 * 같은 날짜가 되어 같은 단언에 걸린다.
 *
 * ## ⚠️ 시각은 「한국시간 값을 그대로 UTC 로」 만든다
 *
 * `lightweight-charts` 는 눈금을 **UTC 로 그린다.** 그래서 진짜 epoch 를 넘기면
 * 축에 UTC 가 찍힌다 — 13:00~20:48 인 봉이 축에는 04:00~11:48 로 나왔다.
 * 아래 「시각은 한국시간입니다」와 어긋나는 조용한 거짓이다.
 *
 * 국내 분봉(`chartCandles.parseMinuteTime`)이 처음부터 쓰던 규약을 그대로 쓴다 —
 * **한국시간의 벽시계 값을 UTC 로 만들어** 넘기면 화면에 그 시각이 그대로 나온다.
 *
 * `t` 는 서버가 한국시간으로 적은 "YYYY-MM-DD HH:mm" 이다.
 */
function toChartCandles(
  raw: { t: string | number; open: number; high: number; low: number; close: number; volume?: number }[],
) {
  const out: {
    key: number;
    time: UTCTimestamp | { year: number; month: number; day: number };
    open: number;
    high: number;
    low: number;
    close: number;
    /* 차트 모듈이 필수로 받는다 — 없는 봉은 0 (거래량 칸이 비는 것과 같다) */
    volume: number;
  }[] = [];

  for (const c of raw) {
    if (!(c.open > 0) || !(c.close > 0)) continue;
    const t = String(c.t);
    const intraday = t.length > 10;
    const ms = intraday
      ? Date.UTC(
          Number(t.slice(0, 4)),
          Number(t.slice(5, 7)) - 1,
          Number(t.slice(8, 10)),
          Number(t.slice(11, 13)),
          Number(t.slice(14, 16)),
        )
      : Date.UTC(Number(t.slice(0, 4)), Number(t.slice(5, 7)) - 1, Number(t.slice(8, 10)));
    if (!Number.isFinite(ms)) continue;
    out.push({
      key: ms,
      time: intraday
        ? ((ms / 1000) as UTCTimestamp)
        : {
            year: Number(t.slice(0, 4)),
            month: Number(t.slice(5, 7)),
            day: Number(t.slice(8, 10)),
          },
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
    });
  }

  /* 시각순으로 세우고 **같은 시각은 뒤엣것만** 남긴다 */
  out.sort((a, b) => a.key - b.key);
  const dedup = out.filter((x, i) => i === out.length - 1 || x.key !== out[i + 1].key);
  return dedup.map(({ key: _key, ...rest }) => rest);
}

const YAHOO_RANGES: { key: string; label: string }[] = [
  { key: "1d", label: "1일" },
  { key: "5d", label: "5일" },
  { key: "1mo", label: "1개월" },
  { key: "6mo", label: "6개월" },
  { key: "1y", label: "1년" },
  { key: "5y", label: "5년" },
];

/*
 * 선물은 기간 선택지가 다르다.
 *
 * 한투 기간별시세는 「몇 일치를 일/주/월봉으로」다. 야후처럼 `1d`·`5d` 같은 장중 구간이
 * 없다.
 *
 * ## **당일이 생겼다** (2026-09-01)
 *
 * 벤티지: "코스피 야간선물 그래프도 당일 그래프 좀 그려줘 일봉 주봉 월봉 이렇게 하고."
 *
 * 여기 「야간선물 분봉은 다른 TR 이고 아직 확인 안 했다」고 적어 뒀는데, 확인해 보니
 * **그 TR 을 이미 쓰고 있었다** — 전광판 카드의 스파크라인이 그것으로 그려진다
 * (`inquire-time-fuopchartprice`). 낮 선물(`F`)에만 쓰고 있었을 뿐이라 시장만
 * `CM` 으로 갈아 끼우면 됐다.
 *
 * 야간선물은 「오늘 개장가의 예고편」이라 **정작 보고 싶은 게 당일 흐름**이다.
 * 일봉 한 칸으로는 밤사이 어디서 꺾였는지가 안 보인다.
 *
 * 탭 이름도 기간(3개월·1년·3년)에서 **봉 단위**로 바꿨다. 「3년」이라고 적혀
 * 있는데 실제로는 주봉이 나오면 사람이 그걸 알 방법이 없다.
 */
const FUTURES_RANGES: { key: string; label: string }[] = [
  { key: "I", label: "당일" },
  { key: "3mo", label: "일봉" },
  { key: "1y", label: "주봉" },
  { key: "3y", label: "월봉" },
];

/**
 * 해외종목 — 한투 기간별시세는 일/주/월이고 분봉이 없다.
 * 분봉(2026-08-26 요청)은 **야후 차트**로 받는다 — 지수·원자재와 같은 엔드포인트가
 * 개별 종목 심볼도 그대로 받아 준다(1d=5분봉·5d=30분봉, 실측).
 */
const US_RANGES: { key: string; label: string }[] = [
  { key: "1d", label: "1일·분봉" },
  { key: "5d", label: "5일" },
  { key: "D", label: "일봉" },
  { key: "W", label: "주봉" },
  { key: "M", label: "월봉" },
];

/*
 * 탭 열쇠 → 「며칠치를 무슨 봉으로」.
 *
 * ⚠️ 열쇠는 옛 이름(`3mo`·`1y`·`3y`)을 그대로 둔다. 화면에 뜨는 이름만 봉 단위로
 * 바꿨다 — 열쇠를 바꾸면 화면이 기억하던 마지막 탭이 어긋난다.
 *
 * `1y` 가 예전엔 일봉 400일이었는데 주봉으로 옮겼다. 일봉과 주봉이 둘 다 있어야
 * 「최근 흐름」과 「큰 그림」이 갈린다 — 예전 셋은 일·일·주라 앞 둘이 겹쳤다.
 */
const FUTURES_SPEC: Record<string, { days: number; period: "I" | "D" | "W" | "M" }> = {
  /* 당일은 날짜를 서버가 정한다 — days 는 안 쓴다 */
  I: { days: 1, period: "I" },
  "3mo": { days: 120, period: "D" },
  "1y": { days: 800, period: "W" },
  /* 월봉은 길어야 뜻이 있다 — 10년이면 24칸 넘게 나온다 */
  "3y": { days: 3650, period: "M" },
};

/**
 * **봉 단위마다 고를 수 있는 기간** (2026-09-01) — 벤티지: "기간도 정할 수 있게
 * 해줘야지?"
 *
 * 봉 단위와 기간은 다른 이야기인데 예전 탭은 둘을 묶어 놨다(「3개월」이 곧 일봉,
 * 「3년」이 곧 주봉). 그래서 **일봉을 2년 보는 것**이 아예 불가능했다.
 *
 * 서버 상한이 4,000일이라 그 안에서 고른다. 첫 번째가 기본값이다.
 */
const FUT_SPANS: Record<string, { days: number; label: string }[]> = {
  "3mo": [
    { days: 120, label: "3개월" },
    { days: 240, label: "6개월" },
    { days: 400, label: "1년" },
    { days: 800, label: "2년" },
  ],
  "1y": [
    { days: 400, label: "1년" },
    { days: 1200, label: "3년" },
    { days: 2000, label: "5년" },
  ],
  "3y": [
    { days: 1200, label: "3년" },
    { days: 2000, label: "5년" },
    { days: 4000, label: "10년" },
  ],
};

export interface ChartTarget {
  /**
   * 어디서 받아오나.
   *   yahoo   미국 지수·원자재 (`^NDX`, `CL=F`)
   *   futures 야간선물 — 한투 기간별시세(`FHKIF03020100`, 시장 `CM`)
   *   usStock 해외종목 — 한투 price-detail + dailyprice
   */
  kind?: "yahoo" | "futures" | "usStock";
  /** 야후 심볼 또는 선물 월물코드 */
  symbol: string;
  label: string;
  /** 소수점 자릿수. 지수는 2, 금리는 3 */
  digits?: number;
  /**
   * **목록이 보여 준 등락률.** 있으면 그걸 그대로 쓴다.
   *
   * ⚠️ 시트는 일봉 마지막 두 봉으로 전일 대비를 냈다. 그런데 무엇이 「전일」인지는
   * 종목마다 다르다 — **코스피 야간선물**은 정규장 선물 종가를 이어받아 시작하므로
   * 전일 대비도 그 기준인데, 일봉으로 세면 **어제 야간 종가**가 기준이 된다.
   * 실제로 카드가 −1.55%, 눌러서 연 시트가 −3.68% 로 갈렸다(기준이 1051.7 과 1074.9).
   *
   * 목록이 이미 옳은 값을 들고 있으면 그걸 넘겨받는 게 맞다. **같은 값을 두 번 계산하면
   * 언젠가 갈라진다** — 그때마다 어느 쪽이 맞는지 사람이 판정해야 한다.
   */
  hintRate?: number | null;
  /**
   * **목록이 보여 준 현재가** (2026-08-25 — 「선물 값 반영이 안 된다」).
   *
   * hintRate 와 같은 원칙이다. 야간선물은 리스트가 야간 현재가(CM, 1,068.65)를
   * 보여 주는데 시트의 큰 숫자는 **주간 일봉 마지막 종가**(1,063.3)였다 — 등락률은
   * hintRate 로 넘겨받아 놓고 가격은 제 것을 쓰니 짝이 안 맞았다. 야후 지수도
   * 마찬가지다(목록은 지금 시세, 차트는 마지막 봉). 목록이 준 값이 있으면 그게 먼저다.
   */
  hintPrice?: number | null;
  /**
   * 선물 전용 — 베이시스·미결제 (2026-08-26 「차트 하단에 나오게」).
   * 타일에 있던 걸 시트 하단으로 옮겼다. 값은 지수 섹션이 이미 들고 있어
   * 넘겨받는다 — 시트가 따로 계산하면 언젠가 갈라진다(hintPrice 와 같은 원칙).
   */
  futInfo?: { basis: number | null; openInterest: number | null } | null;
  /** 선물 시장 — 주간 F · 야간 CM(기본). 같은 TR 에 시장만 갈아 끼운다 */
  futMarket?: "F" | "CM";
}

const W = 720;
const H = 260;
const PAD = { l: 8, r: 58, t: 12, b: 22 };

export function YahooChartSheet({
  target,
  onClose,
  onSelectSymbol,
}: {
  target: ChartTarget;
  onClose: () => void;
  /**
   * ETF 구성종목을 눌렀을 때 그 종목으로 갈아타기 (2026-08-27).
   * 안 넘기면 목록은 그대로 보이되 누를 수 없다 — 갈 곳이 없는 버튼은 안 만든다.
   */
  onSelectSymbol?: (symbol: string, label: string) => void;
}) {
  /* 뒤로가기로 닫힌다 — 폰에서 시트를 열고 뒤로 누르면 페이지가 넘어갔다 (2026-08-28) */
  useSheetBack(true, onClose);
  const futures = target.kind === "futures";
  const usStock = target.kind === "usStock";
  const ranges = usStock ? US_RANGES : futures ? FUTURES_RANGES : YAHOO_RANGES;
  // 해외종목은 분봉이 기본 — 지금 어떻게 움직이는지부터 보고 싶어서 여는 창이다
  const [range, setRange] = useState(usStock ? "1d" : futures ? "3mo" : "6mo");
  /** 해외 일/주/월봉 「기간 길게」 — 한투 100봉 대신 야후 2y/5y/전체 */
  const [longRange, setLongRange] = useState(false);
  /**
   * 선물 기간(일). `null` 이면 그 봉 단위의 기본값(첫 칩).
   *
   * 봉 단위를 바꾸면 되돌린다 — 월봉에서 10년을 보다 일봉으로 가면 4,000일치
   * 일봉을 부르게 되는데, 그건 사람이 원한 게 아니고 응답도 무겁다.
   */
  const [futDays, setFutDays] = useState<number | null>(null);
  const futSpans = futures ? (FUT_SPANS[range] ?? []) : [];
  /* 고른 값이 이 봉 단위에 없으면 기본값으로 — 탭을 옮겼다는 뜻이다 */
  const futSpanDays =
    futSpans.find((s) => s.days === futDays)?.days ?? futSpans[0]?.days ?? null;
  const [data, setData] = useState<YahooChart | null>(null);
  const [detail, setDetail] = useState<UsDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // 상세 숫자는 기간을 바꿔도 그대로다 — 한 번만 받는다
  useEffect(() => {
    if (!usStock) return;
    let alive = true;
    api
      .usDetail(target.symbol)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        if (alive) setDetail(null);
      });
    return () => {
      alive = false;
    };
  }, [usStock, target.symbol]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const spec = FUTURES_SPEC[range] ?? FUTURES_SPEC["3mo"];
    const build = () =>
      usStock
        ? range === "1d" || range === "5d"
          ? // 분봉은 한투에 없다 — 야후가 개별 종목도 받아 준다
            api.yahooChart(target.symbol, range)
          : longRange
          ? // 「기간 길게」 — 일봉 2년 · 주봉 5년 · 월봉 전체 (야후)
            api.yahooChart(target.symbol, range === "D" ? "2y" : range === "W" ? "5y" : "max")
          : api.usChart(target.symbol, range as "D" | "W" | "M").then((r) => ({
              symbol: target.symbol,
              range,
              interval: range === "D" ? "일봉" : range === "W" ? "주봉" : "월봉",
              candles: r.candles,
              prevClose: null,
              meta: null,
              error: r.error,
            }))
        : futures
        ? api
            .futuresChart(
              target.symbol,
              spec.period,
              futSpanDays ?? spec.days,
              target.futMarket ?? "CM",
            )
            .then((r) => ({
            symbol: target.symbol,
            range,
            interval:
              spec.period === "I"
                ? "당일 1분봉"
                : spec.period === "D"
                ? "1일봉"
                : spec.period === "W"
                ? "주봉"
                : "월봉",
            candles: r.candles,
            // 선물은 전일 종가를 따로 안 준다 — 기준선 없이 흐름만 본다
            prevClose: null,
            meta: null,
            error: r.error,
          }))
        : api.yahooChart(target.symbol, range);
    const run = (quiet: boolean) =>
      build()
        .then((d) => {
          if (alive) setData(d);
        })
        .catch(() => {
          if (alive && !quiet) setData(null);
        })
        .finally(() => {
          if (alive && !quiet) setLoading(false);
        });
    void run(false);
    /*
     * 시트 자동 갱신 (2026-08-26 — 「시트도 갱신 체크해줘」).
     * 열어 두고 보는 창인데 열 때 값에서 멈춰 있었다. 분봉(1d·5d)은 1분마다 조용히
     * 다시 받는다 — 서버 캐시가 60초라 그보다 조여도 같은 값이다. 일/주/월봉은
     * 하루에 한 번 바뀌는 값이라 그대로 둔다. 탭이 뒤에 있으면 쉰다.
     */
    /* 야간선물 당일(`I`)도 장중 값이다 — 열어 두고 보는 창이라 같이 갱신한다 */
    const wantsLive = range === "1d" || range === "5d" || (futures && range === "I");
    const t = wantsLive
      ? setInterval(() => {
          if (document.visibilityState === "visible") void run(true);
        }, 60_000)
      : null;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [target.symbol, range, futures, usStock, longRange, futSpanDays]);

  /*
   * 헤더 큰 숫자의 빠른 시세 (해외종목·2026-08-26) — 목록과 같은 야후 spark 3초.
   * hintPrice 는 「연 순간」의 목록 값이라 열어 두면 낡는다. 장이 닫혀 있으면
   * spark 값이 안 변할 뿐이니 주기만 늦춘다.
   */
  const [fastQ, setFastQ] = useState<{ price: number; changeRate: number | null } | null>(null);
  useEffect(() => {
    if (!usStock) return;
    let alive = true;
    const tick = () => {
      if (document.visibilityState !== "visible") return;
      api
        .usWatchFast([target.symbol])
        .then((r) => {
          const q = r.quotes[target.symbol];
          if (alive && q) setFastQ({ price: q.price, changeRate: q.changeRate });
        })
        .catch(() => undefined);
    };
    tick();
    const t = setInterval(tick, 3_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [usStock, target.symbol]);

  const digits = target.digits ?? 2;
  const candles = useMemo(() => data?.candles ?? [], [data]);

  const view = useMemo(() => {
    if (candles.length < 2) return null;

    /*
     * 눈금은 **고가·저가**로 잡는다.
     *
     * 선 그래프였을 때는 종가만 봐도 됐지만 봉은 위아래로 꼬리가 뻗는다.
     * 종가 범위로 눈금을 잡으면 꼬리가 차트 밖으로 잘려 나간다.
     */
    let lo = Math.min(...candles.map((c) => c.low));
    let hi = Math.max(...candles.map((c) => c.high));
    /*
     * 「1일」에서는 전일 종가도 눈금 안에 넣는다.
     * 기준선이 화면 밖으로 나가면 **오늘 오른 건지 내린 건지가 안 보인다.**
     */
    const base = range === "1d" ? data?.prevClose ?? null : null;
    if (base !== null) {
      lo = Math.min(lo, base);
      hi = Math.max(hi, base);
    }
    // 위아래가 딱 붙으면 봉이 테두리에 닿는다
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
    lo -= pad;
    hi += pad;

    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const y = (v: number) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;

    /*
     * 봉 하나가 차지하는 칸과 몸통 너비.
     *
     * 기간마다 봉 수가 크게 다르다 — 5분봉 51개, 일봉 126개, 주봉이면 260개다.
     * 260개를 이 폭에 그리면 칸이 2.7px 라, 비율로만 깎으면 몸통이 사라진다.
     * **최소 1px 은 보장한다.** 안 보이는 봉은 없는 봉이다.
     */
    const slot = iw / candles.length;
    const bodyW = Math.max(1, slot * 0.68);
    const cx = (i: number) => PAD.l + slot * (i + 0.5);

    const bars = candles.map((c, i) => {
      const oy = y(c.open);
      const cy = y(c.close);
      return {
        key: c.t,
        x: cx(i),
        // 종가가 시가보다 높으면 양봉이다 (국내 관행: 상승 빨강 · 하락 파랑)
        up: c.close >= c.open,
        highY: y(c.high),
        lowY: y(c.low),
        bodyY: Math.min(oy, cy),
        // 시가와 종가가 같으면 몸통 높이가 0 이라 아무것도 안 그려진다 — 1px 을 준다
        bodyH: Math.max(1, Math.abs(cy - oy)),
      };
    });

    const closes = candles.map((c) => c.close);
    const last = closes[closes.length - 1];
    /*
     * 기간 등락률의 기준.
     * 「1일」은 전일 종가가 기준이다 — 그날 첫 봉과 견주면 **갭이 통째로 빠진다.**
     */
    const from = base ?? candles[0].open;

    /*
     * **전일 대비를 따로 낸다.**
     *
     * 목록에서 종목을 누르면 목록과 같은 숫자가 먼저 보여야 한다. 예전에는 큰 글씨가
     * 늘 **기간 수익률**이었는데(구간 첫 봉 대비), 목록은 전일 대비라 둘이 부호까지
     * 갈렸다 — 실제로 「목록 +4.23, 눌렀더니 −4.26」이 나왔다. 옆에 작게 「언제 이후」를
     * 적어 두긴 했지만, 크고 색 있는 숫자를 두고 그 글씨를 읽는 사람은 없다.
     *
     * 어느 것이 「전일」인지는 **봉의 날짜로** 판단한다. 기간 이름(`1d`·`D`)으로 가르면
     * 받아오는 곳마다 이름이 달라 또 어긋난다 —
     * 마지막 두 봉의 날짜가 다르면 앞 봉이 전일이고, 같으면 장중 봉이라 알 수 없다.
     * 장중 구간에서는 메타의 전일 종가를 쓴다.
     */
    const day = (t: string) => String(t).slice(0, 10);
    const prev = candles.length >= 2 ? candles[candles.length - 2] : null;
    const dayBase =
      base !== null
        ? base
        : prev && day(prev.t) !== day(candles[candles.length - 1].t)
          ? prev.close
          : null;

    return {
      bars,
      bodyW,
      baseY: base === null ? null : y(base),
      last,
      /*
       * **진짜 전일 종가.** 상세 칩이 이걸 쓴다 (2026-08-27).
       *
       * ⚠️ 야후 meta 의 `chartPreviousClose` 를 「전일 종가」로 쓰면 안 된다 —
       * 그건 **차트 구간 직전** 종가라 기간마다 값이 다르다(실측: S&P500 이
       * 1d 7,675.7 / 6mo 6,878.88 / 1y 6,481.4). 그걸 기준으로 삼으니
       * 「당일 고가 +0.5%」가 기간을 바꾸면 「+12%」가 됐다.
       * 여기 dayBase 는 장중이면 meta(1d 한정), 일봉이면 **직전 봉 종가**다.
       */
      dayBase,
      /* 목록이 준 값이 있으면 그게 먼저다 — 두 화면이 갈라지지 않는 유일한 방법이다 */
      dayRate:
        target.hintRate !== undefined && target.hintRate !== null
          ? target.hintRate
          : dayBase !== null && dayBase > 0
            ? ((last - dayBase) / dayBase) * 100
            : null,
      rate: from > 0 ? ((last - from) / from) * 100 : 0,
      loLabel: Math.min(...candles.map((c) => c.low)),
      hiLabel: Math.max(...candles.map((c) => c.high)),
      firstT: candles[0].t,
      lastT: candles[candles.length - 1].t,
    };
  }, [candles, range, data, target.hintRate]);

  const up = (view?.rate ?? 0) >= 0;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet yc" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {target.label}
            <span className="sheet-sub">{target.symbol}</span>
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="filter-row">
          {ranges.map((r) => (
            <button
              key={r.key}
              className={`filter-btn ${range === r.key ? "active" : ""}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
          {/*
            길게 보기 (2026-08-26 — 「국내 차트처럼 기간 설정하게 해줘」).
            한투 기간별시세는 봉 종류당 100봉 안팎이 끝이라, 긴 구간은 야후로 잇는다:
            일봉 2년 · 주봉 5년 · 월봉은 상장 이후 전체.
          */}
          {usStock && ["D", "W", "M"].includes(range) && (
            <>
              <span className="news-scope-sep" />
              <button
                className={`filter-btn ${longRange ? "active" : ""}`}
                onClick={() => setLongRange((v) => !v)}
                title="일봉 2년 · 주봉 5년 · 월봉 전체 (야후)"
              >
                기간 길게
              </button>
            </>
          )}
          {/*
            **선물 기간** (2026-09-01) — 벤티지: "응 그리고 기간도 정할 수 있게
            해줘야지?"

            봉 단위와 기간은 다른 이야기다. 같은 일봉이라도 3개월과 2년은 보는
            것이 다르고, 예전에는 탭 하나에 둘이 묶여 있어(「3개월」=일봉,
            「3년」=주봉) 고를 수가 없었다.

            당일에는 안 보인다 — 하루짜리라 고를 기간이 없다.
          */}
          {futures && futSpans.length > 0 && (
            <>
              <span className="news-scope-sep" />
              {futSpans.map((s) => (
                <button
                  key={s.days}
                  className={`filter-btn ${futSpanDays === s.days ? "active" : ""}`}
                  onClick={() => setFutDays(s.days)}
                >
                  {s.label}
                </button>
              ))}
            </>
          )}
        </div>

        {loading && !view && <div className="empty">차트 불러오는 중…</div>}
        {!loading && data?.error && <div className="error-banner">{data.error}</div>}

        {view && (
          <>
            {/*
              큰 숫자는 **전일 대비**다 — 목록에서 보고 누른 그 숫자와 같아야 한다.
              해외 종목은 compact — 정보가 많아 숫자 하나가 화면을 먹으면 안 된다
              (2026-08-25, 「얘만 글자가 너무 커서 한눈에 안 담긴다」).
            */}
            <div className={`yc-head${usStock ? " compact" : ""}`}>
              {/*
                해외종목은 3초 빠른 시세(fastQ)가 가장 새 값이다 — hintPrice 는
                「연 순간」의 목록 값이라 열어 두면 낡는다. 그다음이 목록, 마지막이 봉.
              */}
              <b className="yc-px">
                {(fastQ?.price ?? target.hintPrice ?? view.last).toLocaleString("ko-KR", {
                  maximumFractionDigits: digits,
                })}
              </b>
              {fastQ?.changeRate != null ? (
                <>
                  <span className={`yc-rate ${fastQ.changeRate >= 0 ? "positive" : "negative"}`}>
                    {fastQ.changeRate >= 0 ? "+" : ""}
                    {fastQ.changeRate.toFixed(2)}%
                  </span>
                  <span className="pt-n">전일 대비 · 3초 갱신</span>
                </>
              ) : view.dayRate !== null ? (
                <>
                  <span className={`yc-rate ${view.dayRate >= 0 ? "positive" : "negative"}`}>
                    {view.dayRate >= 0 ? "+" : ""}
                    {view.dayRate.toFixed(2)}%
                  </span>
                  <span className="pt-n">전일 대비</span>
                </>
              ) : (
                <>
                  <span className={`yc-rate ${up ? "positive" : "negative"}`}>
                    {up ? "+" : ""}
                    {view.rate.toFixed(2)}%
                  </span>
                  <span className="pt-n">{view.firstT} 이후</span>
                </>
              )}
            </div>
            {/*
              구간 등락률은 **안 띄운다.**
              전일 대비 옆에 같이 있으면 두 숫자 중 어느 것을 보는지 매번 헷갈린다 —
              부호가 갈리는 날이 흔해서 특히 그렇다. 알고 싶으면 기간을 바꿔 보면 된다.
            */}

            {/*
              **전부 국내와 같은 캔들차트 모듈**(lightweight-charts)로 그린다.
              이평선·고저 표시·설정 색이 국내와 똑같이 따라온다.

              2026-08-25 에는 해외 **종목**만 이 모듈로 옮기고 지수·원자재·선물은
              SVG 로 두었다. 「선 하나짜리라 모듈이 과하다」는 이유였는데,
              **그 전제가 틀렸다** — 실제로는 지수도 캔들을 그리고 있었다.
              그 결과 지수 창만 축도 툴팁도 없었다 (2026-08-31 —
              "1일 찍으면 밑에 시간도 나오고 해야지 … 얘네들만 이러네. 통일하자").

              이 모듈이 주는 것: 분봉이면 **시간축**, 일봉이면 **날짜축**,
              크로스헤어에 **직전 봉 대비 등락률**, 두 점을 찍는 구간 측정.
              SVG 로는 그걸 다 다시 만들어야 했다.
            */}
            {candles.length > 0 ? (
              <CandleChart
                candles={toChartCandles(candles)}
                /*
                 * **분봉이면 시간축**을 켠다 (2026-08-31 — "1일 찍으면 밑에 시간도
                 * 나오고 해야지"). 안 넘기면 기본이 꺼짐이라, 분봉인데 축에 날짜가
                 * 찍혀 「1일 · 31일 · 31일 · 31일」처럼 같은 날짜가 되풀이됐다.
                 * 판정은 서버가 준 봉의 시각 문자열 길이로 한다 — 「YYYY-MM-DD HH:mm」
                 * 이면 분봉이다. 기간 이름(1d·5d)으로 재면 서버가 간격을 바꿨을 때 어긋난다.
                 */
                intraday={String(candles[0]?.t ?? "").length > 10}
                height={340}
                fitKey={`${target.symbol}:${range}:${longRange ? "L" : "S"}:${futSpanDays ?? ""}`}
                name={target.label}
                code={target.symbol}
              />
            ) : null}

            {/*
              ETF 구성종목 (2026-08-27 요청) — 섹터 MAP 타일을 눌렀을 때 「무엇이 들었나」.
              「소프트웨어 +6%」만 봐서는 무엇이 밀어 올렸는지 모른다. 지수·원자재·금리는
              구성종목이라는 게 없으므로 조용히 안 뜬다.
            */}
            <UsEtfHoldingsBlock symbol={target.symbol} onSelectSymbol={onSelectSymbol} />

            {detail && !detail.error && <UsFigures d={detail} />}
            {/*
              키움 세부 — 한투 상세(위)에 **얹는** 값이다. 업종·프리장·52주 날짜·10호가는
              키움만 준다. 미국(ND/NY/NA) 종목이 아니면 블록이 통째로 안 뜬다.
            */}
            {usStock && <UsKiwoomBlock symbol={target.symbol} />}

            {/*
              지수·원자재·금리 숫자판 (2026-08-27 — 「지수나 원자재는 개별종목처럼 안 나온다」).
              이 셋은 개별종목 상세(한투 해외주식)를 못 받는다 — 심볼 체계가 아예 다르다.
              그런데 **차트 응답의 meta 에 이미** 당일 고저·52주 고저·거래량이 들어 있어서,
              조회를 하나도 안 늘리고 채울 수 있다.
            */}
            {!usStock && data?.meta && (
              <YahooFigures m={data.meta} digits={digits} prevClose={view.dayBase} />
            )}

            <div className="table-note">
              {candles.length}개 봉 ({data?.interval}) · {view.firstT} ~ {view.lastT}
              {range === "1d" && " · 시각은 한국시간입니다"}
            </div>

            {/*
              선물 차트 하단 묶음 (2026-08-26) —
              베이시스·미결제(타일에서 이사) → 장중 수급 변화(네이버 Time 누적)
              → 일별 투자자별 수급 30일. 코스피/코스닥 시트와 같은 구조다.
            */}
            {futures && target.futInfo && (
              <div className="ff-head yc-futinfo num">
                {target.futInfo.basis != null && (
                  <span
                    className={`ov-basis ${target.futInfo.basis < 0 ? "negative" : "positive"}`}
                    title="선물 − 코스피200. 음수(백워데이션)면 선물이 현물보다 싸다 — 약세 심리"
                  >
                    베이시스 {target.futInfo.basis > 0 ? "+" : ""}
                    {target.futInfo.basis.toFixed(2)}
                  </span>
                )}
                {target.futInfo.openInterest != null && (
                  <span className="pt-n">미결제약정 {fmtNum(target.futInfo.openInterest)}계약</span>
                )}
              </div>
            )}
            {futures && <IntradayFlowChart market="03" unit="계약" />}
            {/* 일별 투자자별 수급 — 외국인이 파나 기관이 사나 (PDF #13) */}
            {futures && <FuturesFlowBars />}
            {/* 용어 설명 (2026-08-26 요청) — 볼 때마다 검색하게 만들면 안 본다 */}
            {futures && (
              <div className="table-note">
                <b>베이시스</b> = 선물가격 − 현물(코스피200) 지수. 양수(콘탱고)면 선물이
                비싸다 — 앞날을 좋게 본다는 뜻이고, 프로그램 <b>매수</b>가 붙기 쉽습니다.
                음수(백워데이션)면 선물이 현물보다 싸다 — 약세 심리이고 프로그램{" "}
                <b>매도</b>가 나오기 쉽습니다.
                <br />
                <b>미결제약정</b> = 아직 청산하지 않고 살아 있는 계약 수. 가격이 오르며
                미결제가 <b>늘면</b> 새 돈이 들어오는 상승(추세 신뢰↑), 가격이 오르는데
                미결제가 <b>줄면</b> 숏 청산이 밀어 올린 것이라 힘이 약합니다.
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}


/**
 * 코스피200 선물 **투자자별 수급** (2026-08-25, PDF #13).
 *
 * 키움이 안 주던 값 — 네이버 채널(투자자별 매매동향, sosok=03)을 실측으로 찾아
 * 서버가 파싱해 준다. 하루 세 막대(개인·외국인·기관 순매수 계약), 30거래일.
 * 「외국인이 파나 기관이 사나」의 흐름이 이 그림 하나로 보인다.
 */
function FuturesFlowBars() {
  const [days, setDays] = useState<
    { date: string; individual: number; foreign: number; institution: number }[] | null
  >(null);

  useEffect(() => {
    let alive = true;
    api
      .futuresFlow(30)
      .then((r) => alive && setDays(r.days))
      .catch(() => alive && setDays([]));
    return () => {
      alive = false;
    };
  }, []);

  if (days === null) return <div className="empty">선물 수급 불러오는 중…</div>;
  if (days.length === 0) return null;

  const W = 640;
  const H = 150;
  const PADX = { l: 4, r: 46, t: 8, b: 16 };
  // 국내 관행 색 — 자금 흐름 차트와 같은 배색 (외국인 파랑 · 기관 초록 · 개인 노랑)
  const SERIES = [
    { key: "foreign" as const, label: "외국인", color: "var(--blue)" },
    { key: "institution" as const, label: "기관", color: "#35c46a" },
    { key: "individual" as const, label: "개인", color: "#f5c542" },
  ];
  const max = Math.max(1, ...days.flatMap((d) => SERIES.map((s) => Math.abs(d[s.key]))));
  const zero = PADX.t + (H - PADX.t - PADX.b) / 2;
  const scale = (H - PADX.t - PADX.b) / 2 / max;
  const slot = (W - PADX.l - PADX.r) / days.length;
  const bw = Math.max(1, (slot * 0.7) / SERIES.length);
  const last = days[days.length - 1];

  return (
    <div className="ff-wrap">
      <div className="ff-head">
        <b>선물 투자자별 순매수</b>
        <span className="tct-legend">
          {SERIES.map((s) => (
            <span className="tct-key" key={s.key}>
              <i className="tct-dot" style={{ background: s.color }} />
              {s.label}{" "}
              <b className={last[s.key] > 0 ? "positive" : last[s.key] < 0 ? "negative" : ""}>
                {last[s.key] > 0 ? "+" : ""}
                {last[s.key].toLocaleString("ko-KR")}
              </b>
            </span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        <line className="breadth-zero" x1={PADX.l} x2={W - PADX.r} y1={zero} y2={zero} />
        <text className="tc-tick" x={W - PADX.r + 4} y={PADX.t + 8}>
          +{max.toLocaleString("ko-KR")}
        </text>
        <text className="tc-tick" x={W - PADX.r + 4} y={H - PADX.b}>
          -{max.toLocaleString("ko-KR")}
        </text>
        {days.map((d, i) =>
          SERIES.map((s, k) => {
            const v = d[s.key];
            if (v === 0) return null;
            const h = Math.abs(v) * scale;
            return (
              <rect
                key={`${d.date}${s.key}`}
                x={PADX.l + slot * i + slot * 0.15 + bw * k}
                y={v > 0 ? zero - h : zero}
                width={bw}
                height={Math.max(1, h)}
                fill={s.color}
                opacity={0.9}
              >
                <title>
                  {d.date.slice(5)} {s.label} {v > 0 ? "+" : ""}
                  {v.toLocaleString("ko-KR")}계약
                </title>
              </rect>
            );
          }),
        )}
        {days.map((d, i) =>
          i > 0 && d.date.slice(5, 7) !== days[i - 1].date.slice(5, 7) ? (
            <text key={`m${d.date}`} className="tc-tick" x={PADX.l + slot * i} y={H - 4}>
              {Number(d.date.slice(5, 7))}월
            </text>
          ) : null,
        )}
      </svg>
      <div className="table-note">
        최근 {days.length}거래일 · 단위 <b>계약</b>(코스피200 선물, 일별 순매수) · 범례 숫자는
        마지막 날입니다. 네이버 투자자별 매매동향 — 키움 REST 엔 없는 값이라 여기서 받습니다.
      </div>
    </div>
  );
}

/**
 * 해외종목 숫자판.
 *
 * **없는 것은 안 그린다.** 한투 해외주식에는 재무제표도 수급도 없다 — 국내 상세와
 * 같은 모양으로 맞추겠다고 빈 칸을 늘어놓으면, 값이 없는 건지 0인 건지 알 수 없어진다.
 */
/**
 * 카드 하나 — 국내 상세(`summary-item`)와 같은 뼈대에, 부가 정보(전일比 %, 날짜)를
 * **아랫줄로 뺀다** (2026-08-25). 괄호로 한 줄에 붙이니 「215.53 (+1.2%) / 218.1 (+2.4%)…」
 * 처럼 늘어져서 읽히질 않았다 — 큰 값 하나 + 작은 부가 한 줄이면 눈이 안 걸린다.
 */
interface UsItem {
  k: string;
  v: string;
  sub?: string;
  /** sub 의 색 — positive/negative */
  subCls?: string;
  /**
   * 등락률은 **값 바로 옆 같은 줄에** (2026-08-25 — 「국내 표시하던 대로」).
   * 아랫줄에 「전일비 +2.8%」로 뒀더니 값과 비율이 떨어져 읽혔다. 국내 카드처럼
   * `159.77 +2.8%` 로 붙인다. 범위·환율 같은 진짜 부가정보만 아랫줄로 남는다.
   */
  inline?: boolean;
  hint?: string;
}

function UsCards({ items }: { items: UsItem[] }) {
  if (items.length === 0) return null;
  return (
    <div className="summary-grid usd-cards">
      {items.map((it) => (
        <div className="summary-item" key={it.k} title={it.hint}>
          <div className="label">{it.k}</div>
          <div className="value">
            {it.v}
            {it.sub && it.inline && <em className={`usd-inline ${it.subCls ?? ""}`}>{it.sub}</em>}
          </div>
          {it.sub && !it.inline && <div className={`usd-sub ${it.subCls ?? ""}`}>{it.sub}</div>}
        </div>
      ))}
    </div>
  );
}

/**
 * ETF 구성종목 — **무엇이 이 ETF 를 밀어 올렸나** (2026-08-27 요청).
 *
 * 미국은 섹터가 ETF 로 거래되므로 섹터 MAP 의 타일이 곧 업종이다. 그런데 타일을
 * 눌러도 차트뿐이라, 「소프트웨어 +6%」를 보고도 다음을 못 물었다.
 *
 * **상위 10종목 안팎이다.** 야후가 그만큼만 준다 — 「전체 구성」인 척하면 안 되므로
 * 아래에 그렇게 적는다. ETF 가 아니면(지수·원자재·금리) 블록이 통째로 안 뜬다.
 */
function UsEtfHoldingsBlock({
  symbol,
  onSelectSymbol,
}: {
  symbol: string;
  onSelectSymbol?: (symbol: string, label: string) => void;
}) {
  const [data, setData] = useState<UsEtfHoldings | null>(null);

  useEffect(() => {
    let alive = true;
    setData(null);
    /*
     * 지수·원자재·금리는 애초에 구성종목이 없다 — 심볼 모양으로 먼저 거른다.
     * `^GSPC`(지수)·`CL=F`(선물)를 부르면 야후가 빈 값을 주는데, 그 한 번이 아깝다.
     */
    if (/[\^=]/.test(symbol)) return;
    api
      .usEtfHoldings(symbol)
      .then((d) => alive && setData(d))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [symbol]);

  if (!data || data.error || data.holdings.length === 0) return null;

  const top = data.holdings.reduce((sum, h) => sum + (h.weight ?? 0), 0);

  return (
    <div className="etfh">
      <div className="etfh-head">
        <b>구성종목 상위 {data.holdings.length}</b>
        {top > 0 && <span className="pt-n">합계 비중 {top.toFixed(1)}%</span>}
      </div>
      <div className="etfh-list">
        {data.holdings.map((h) => {
          const inner = (
            <>
              <b>{h.symbol}</b>
              <span className="etfh-name">{h.name}</span>
              {h.weight !== null && <span className="num etfh-w">{h.weight.toFixed(2)}%</span>}
            </>
          );
          return onSelectSymbol ? (
            <button
              key={h.symbol}
              className="etfh-item clickable"
              onClick={() => onSelectSymbol(h.symbol, h.name || h.symbol)}
              title={`${h.name} 차트 보기`}
            >
              {inner}
            </button>
          ) : (
            <div className="etfh-item" key={h.symbol}>
              {inner}
            </div>
          );
        })}
      </div>

      {/* 섹터 쏠림 — 「이 ETF 가 사실은 어디에 걸려 있나」 */}
      {data.sectors.length > 0 && (
        <div className="etfh-secs">
          {data.sectors.slice(0, 6).map((s) => (
            <span className="etfh-sec" key={s.name}>
              {s.name} <b>{s.weight.toFixed(0)}%</b>
            </span>
          ))}
        </div>
      )}

      <div className="table-note">
        야후가 주는 <b>상위 종목만</b>입니다 — 전체 구성이 아닙니다. 하루 한 번 받아 둡니다.
      </div>
    </div>
  );
}

/**
 * 지수·원자재·금리 숫자판 (2026-08-27).
 *
 * **추가 조회가 0회다.** 값은 전부 차트 응답이 같이 준 `meta` 에서 나온다.
 * 없는 칸은 안 그린다 — 지수는 거래량이 0 으로 오는 곳이 있고(금리는 늘 0),
 * 0 을 그대로 적으면 「거래가 없었다」는 **틀린 사실**이 화면에 남는다.
 *
 * ⚠️ 당일 고저·52주 고저·거래량은 **기간을 바꿔도 같은 값**이다(실측 확인).
 * 전일 종가만 meta 를 안 쓰고 봉에서 낸다 — 위 `dayBase` 주석 참고.
 */
function YahooFigures({
  m,
  digits,
  prevClose,
}: {
  m: NonNullable<YahooChart["meta"]>;
  digits: number;
  prevClose: number | null;
}) {
  const fmt = (v: number) => v.toLocaleString("ko-KR", { maximumFractionDigits: digits });
  const pos52 =
    m.price !== null && m.high52 !== null && m.low52 !== null && m.high52 > m.low52
      ? ((m.price - m.low52) / (m.high52 - m.low52)) * 100
      : null;

  /* 기준(전일 종가) 대비 % — 개별종목 카드와 같은 규칙으로 값 옆 같은 줄에 */
  const vsBase = (v: number): { sub?: string; subCls?: string; inline?: boolean } => {
    if (!prevClose) return {};
    const p = ((v - prevClose) / prevClose) * 100;
    return { sub: `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`, subCls: p >= 0 ? "positive" : "negative", inline: true };
  };

  const items: UsItem[] = [];
  if (prevClose !== null) items.push({ k: "전일 종가", v: fmt(prevClose) });
  if (m.dayHigh !== null) items.push({ k: "당일 고가", v: fmt(m.dayHigh), ...vsBase(m.dayHigh) });
  if (m.dayLow !== null) items.push({ k: "당일 저가", v: fmt(m.dayLow), ...vsBase(m.dayLow) });
  if (pos52 !== null)
    items.push({
      k: "52주 자리",
      v: `${pos52.toFixed(0)}%`,
      sub: `${fmt(m.low52!)} ~ ${fmt(m.high52!)}`,
      hint: "0%가 52주 최저, 100%가 최고입니다",
    });
  // 거래량 0 은 「없는 값」이다 — 금리·일부 지수가 그렇게 온다
  if (m.volume !== null && m.volume > 0) items.push({ k: "거래량", v: fmtNum(m.volume) });
  if (m.exchange) items.push({ k: "거래소", v: m.exchange, sub: m.currency || undefined });

  if (items.length === 0) return null;
  return (
    <>
      <UsCards items={items} />
      <div className="table-note">
        {m.name ? `${m.name} · ` : ""}야후 파이낸스입니다. <b>차트와 같이 온 값</b>이라 조회가 더
        들지 않습니다 — 개별 종목처럼 재무·수급은 없습니다(지수·원자재엔 그런 자리가 없습니다).
      </div>
    </>
  );
}

function UsFigures({ d }: { d: UsDetail }) {
  const pos52 =
    d.price !== null && d.high52 !== null && d.low52 !== null && d.high52 > d.low52
      ? ((d.price - d.low52) / (d.high52 - d.low52)) * 100
      : null;
  const volRatio = d.volume !== null && d.prevVolume ? d.volume / d.prevVolume : null;

  /* 전일 종가 대비 % — 국내 카드처럼 값 옆 같은 줄에 색으로 (기준은 title 로) */
  const vsBase = (v: number | null): { sub?: string; subCls?: string; inline?: boolean } => {
    if (v === null || !d.base) return {};
    const p = ((v - d.base) / d.base) * 100;
    return {
      sub: `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`,
      subCls: p >= 0 ? "positive" : "negative",
      inline: true,
    };
  };

  const items: UsItem[] = [];
  if (d.open !== null) items.push({ k: "시가", v: String(d.open), ...vsBase(d.open) });
  if (d.high !== null) items.push({ k: "고가", v: String(d.high), ...vsBase(d.high) });
  if (d.low !== null) items.push({ k: "저가", v: String(d.low), ...vsBase(d.low) });
  if (pos52 !== null)
    items.push({
      k: "52주 자리",
      v: `${pos52.toFixed(0)}%`,
      sub: `${d.low52} ~ ${d.high52}`,
      hint: "0%가 52주 최저, 100%가 최고입니다",
    });
  if (volRatio !== null)
    items.push({
      k: "거래량",
      v: fmtNum(d.volume ?? 0),
      sub: `전일比 ${volRatio.toFixed(2)}배`,
      subCls: volRatio >= 1 ? "positive" : "",
      hint: "1배보다 크면 평소보다 붐빈다는 뜻입니다",
    });
  if (d.marketCap !== null) {
    /*
     * **원화로도 적는다.** 「3,900십억 USD」는 그 자체로는 크기가 안 잡힌다 —
     * 국내 종목을 볼 때 쓰는 자(조원)로 바꿔 놔야 삼성전자와 견줄 수 있다.
     */
    const won = d.fxRate ? (d.marketCap * d.fxRate) / 1e8 : null;
    const wonText =
      won === null
        ? undefined
        : won >= 10_000
          ? `약 ${fmtNum(Math.round(won / 10_000))}조원`
          : `약 ${fmtNum(Math.round(won))}억원`;
    items.push({
      k: "시가총액",
      v: `${(d.marketCap / 1e9).toFixed(1)}B ${d.currency}`,
      sub: wonText,
      hint: "국내 종목과 견주기 쉽게 원화로도 적었습니다",
    });
  }
  if (d.per !== null || d.pbr !== null) items.push({ k: "PER / PBR", v: `${d.per ?? "-"} / ${d.pbr ?? "-"}` });
  if (d.eps !== null || d.bps !== null) items.push({ k: "EPS / BPS", v: `${d.eps ?? "-"} / ${d.bps ?? "-"}` });
  if (d.wonPrice !== null)
    items.push({
      k: "원화 환산",
      v: `${d.wonPrice.toLocaleString("ko-KR")}원`,
      sub: d.fxRate ? `환율 ${d.fxRate}` : undefined,
      hint: "환율까지 얹힌 값이라 실제 체감에 가깝습니다",
    });
  if (d.sector) items.push({ k: "업종", v: d.sector });
  if (d.tradable) items.push({ k: "매매", v: d.tradable });

  return (
    <>
      <UsCards items={items} />
      <div className="table-note">
        한국투자증권 해외주식 시세입니다. <b>재무제표와 수급은 없습니다</b> — 해외 종목에는
        DART 같은 자리가 없고, 외국인·기관 순매수는 국내 시장의 개념입니다.
      </div>
    </>
  );
}

/** yyyymmdd → yy.mm.dd — 52주 고저 날짜용 */
function ymd(s: string): string {
  return /^\d{8}$/.test(s) ? `${s.slice(2, 4)}.${s.slice(4, 6)}.${s.slice(6, 8)}` : s;
}
/** HHmmss → HH:mm — 호가시각용 */
function hms(s: string): string {
  return /^\d{6}$/.test(s) ? `${s.slice(0, 2)}:${s.slice(2, 4)}` : s;
}

/**
 * 키움 세부 — usa20100(업종·프리장·52주 날짜) + usa20101(10호가·회전율).
 *
 * 한투 상세(UsFigures)에 **없는 값만** 여기 있다 — 시총·가격처럼 겹치는 건 위에서
 * 이미 보여 줬으니 다시 적지 않는다. 예외는 52주 고저인데, 키움은 **날짜와 이격(%)**
 * 까지 줘서 정보량이 다르다.
 *
 * 미국(ND/NY/NA) 종목이 아니거나 조회가 실패하면 블록이 통째로 안 뜬다 —
 * 없는 것을 있는 척하지 않는다.
 */
function UsKiwoomBlock({ symbol }: { symbol: string }) {
  const [k, setK] = useState<UsKiwoomDetailData | null>(null);

  useEffect(() => {
    let alive = true;
    setK(null);
    api
      .usKiwoomDetail(symbol)
      .then((d) => {
        if (alive) setK(d);
      })
      .catch(() => {
        if (alive) setK(null);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  if (!k || k.unsupported || (!k.summary && !k.book)) return null;
  const s = k.summary;
  const b = k.book;

  const items: UsItem[] = [];
  if (s) {
    if (s.sectorLg || s.sectorSm)
      items.push({
        k: "업종 (키움)",
        v: s.sectorLg || s.sectorSm || "",
        sub: s.sectorLg && s.sectorSm ? s.sectorSm : undefined,
        hint: "키움 분류 — 야후의 뭉뚱그린 섹터보다 세부까지 있습니다",
      });
    if (s.week52.high !== null)
      items.push({
        k: "52주 고가",
        v: fmtNum(s.week52.high),
        sub: `${ymd(s.week52.highDate)}${s.week52.highGap !== null ? ` · ${s.week52.highGap.toFixed(1)}%` : ""}`,
        subCls: "negative",
        hint: "아랫줄은 그 날짜와, 지금 가격의 이격입니다",
      });
    if (s.week52.low !== null)
      items.push({
        k: "52주 저가",
        v: fmtNum(s.week52.low),
        sub: `${ymd(s.week52.lowDate)}${s.week52.lowGap !== null ? ` · +${s.week52.lowGap.toFixed(1)}%` : ""}`,
        subCls: "positive",
      });
    if (s.pre.open !== null || s.pre.high !== null || s.pre.low !== null) {
      /* 전일(정규장) 종가 대비 — 국내처럼 값 옆 같은 줄에 */
      const vsClose = (v: number | null): { sub?: string; subCls?: string; inline?: boolean } => {
        if (v === null || !s.baseClose) return {};
        const p = ((v - s.baseClose) / s.baseClose) * 100;
        return {
          sub: `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`,
          subCls: p >= 0 ? "positive" : "negative",
          inline: true,
        };
      };
      if (s.pre.open !== null) items.push({ k: "프리장 시가", v: String(s.pre.open), ...vsClose(s.pre.open) });
      if (s.pre.high !== null) items.push({ k: "프리장 고가", v: String(s.pre.high), ...vsClose(s.pre.high) });
      if (s.pre.low !== null) items.push({ k: "프리장 저가", v: String(s.pre.low), ...vsClose(s.pre.low) });
    }
  }
  if (b) {
    if (b.turnover !== null)
      items.push({
        k: "회전율",
        v: `${b.turnover.toFixed(2)}%`,
        hint: "오늘 거래량 ÷ 상장주식수 — 손바뀜이 얼마나 있었나",
      });
    if (b.tradeValue !== null)
      // trde_prica 는 천 달러다 (실측: NVDA 28,658,314 → 286.6억 달러)
      items.push({ k: "거래대금", v: `${fmtNum(Math.round(b.tradeValue / 100000))}억 $` });
  }

  // 잔량 막대의 기준 — 양쪽 통틀어 제일 큰 잔량
  const maxQty = b ? Math.max(1, ...b.asks.map((r) => r.qty), ...b.bids.map((r) => r.qty)) : 1;

  return (
    <>
      <UsCards items={items} />

      {b && b.asks.some((r) => r.price !== null) && (
        <div className="ukb-book">
          <div className="ukb-head">
            <span>10호가</span>
            <span className="ukb-when">
              {ymd(b.date)} {hms(b.at)} 기준
              {/* 마감 후엔 마지막 호가가 그대로 남는다 — 시각이 없으면 지금 호가로 오해한다 */}
            </span>
          </div>
          {/* 국내 호가창과 같은 규칙 — 매도는 위로 갈수록 비싸다(10호가부터 그린다) */}
          {b.asks
            .slice()
            .reverse()
            .map((r, i) =>
              r.price === null ? null : (
                <div className="ukb-row" key={`a${i}`}>
                  <span className="ukb-bar-cell">
                    <span
                      className="ukb-bar ukb-ask"
                      style={{ width: `${Math.min(100, (r.qty / maxQty) * 100)}%` }}
                    />
                    <span className="ukb-qty">{fmtNum(r.qty)}</span>
                  </span>
                  <span className="ukb-price down">{r.price}</span>
                  <span className="ukb-bar-cell" />
                </div>
              ),
            )}
          {b.bids.map((r, i) =>
            r.price === null ? null : (
              <div className="ukb-row" key={`b${i}`}>
                <span className="ukb-bar-cell" />
                <span className="ukb-price up">{r.price}</span>
                <span className="ukb-bar-cell">
                  <span
                    className="ukb-bar ukb-bid"
                    style={{ width: `${Math.min(100, (r.qty / maxQty) * 100)}%` }}
                  />
                  <span className="ukb-qty">{fmtNum(r.qty)}</span>
                </span>
              </div>
            ),
          )}
          <div className="ukb-foot">
            <span>매도잔량 {fmtNum(b.totalAsk)}</span>
            <span>매수잔량 {fmtNum(b.totalBid)}</span>
          </div>
        </div>
      )}

      <div className="table-note">
        키움 세부입니다 — 업종·프리장·10호가는 키움만 줍니다. 위(한투)와 값이 조금 다를 수
        있는데, 서로 다른 시점의 스냅샷이라 그렇습니다.
      </div>
    </>
  );
}
