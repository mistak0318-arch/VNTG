import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "../useLive";
import type { RawRecord } from "../api";
import { api, type TradeFill } from "../api";
import { CandleChart, type Candle } from "./CandleChart";
import { setPref } from "../prefs";
import { useChartPrefs } from "../useChartPrefs";
import { ChartInsights } from "./ChartInsights";
import { PERIOD_CONFIG, lastDays, toCandles, type Period } from "./chartCandles";

/**
 * 기간 전환이 되는 캔들차트 패널.
 * 종목 상세(모달)와 개별종목분석 페이지, 종목발굴이 같은 컴포넌트를 쓴다.
 *
 * ## 크게 보기
 *
 * 폰에서 320px 짜리 차트로는 밑꼬리도 이평선 교차도 안 보인다. **전체화면**을 붙였다.
 *
 * 화면을 덮는 것(오버레이)과 진짜 전체화면(Fullscreen API)을 **둘 다** 쓴다 —
 * 오버레이만으로도 브라우저 안은 꽉 차지만 주소창·탭이 남고, Fullscreen API 는
 * 그걸 없애 준다. 그런데 **iOS 사파리는 video 가 아닌 요소에 이걸 안 준다.**
 * 그래서 오버레이를 본체로 두고 Fullscreen 은 **되면 얹는 것**으로 다룬다.
 * 가로 고정(`orientation.lock`)도 같다 — 안드로이드 크롬에서만 되고 iOS 는 무시한다.
 * 셋 다 실패해도 오버레이는 남으므로 어디서든 크게는 보인다.
 */

export type { Period } from "./chartCandles";

type Venue = "krx" | "nxt" | "all";

const VENUES: { key: Venue; label: string; hint: string }[] = [
  { key: "krx", label: "KRX", hint: "한국거래소 체결만 — 봉이 가장 안정적입니다" },
  { key: "nxt", label: "NXT", hint: "넥스트레이드 체결만" },
  { key: "all", label: "통합", hint: "두 거래소를 합친 체결 — 고가·저가가 벌어질 수 있습니다" },
];

/**
 * 전체화면에서 차트 말고 나머지(머리줄·도구줄·여백)가 먹는 높이.
 *
 * 폰을 가로로 눕히면 화면 높이가 375px 밖에 안 된다 — 거기서 108px 를 떼면
 * 차트가 화면의 60% 도 못 채운다. **낮은 화면에서는 머리줄을 접어** 그만큼을 차트에 준다.
 */
/**
 * 분봉을 며칠치까지 보여줄까.
 *
 * 키움은 분봉을 며칠치 한꺼번에 준다. 통째로 그리면 하루가 손톱만 해져서 **분봉을 켠
 * 뜻이 없어진다** — 오늘 어떻게 흘렀나를 보려고 켜는 것이다. 그래서 **하루가 기본**이고,
 * 어제와 견주고 싶을 때 3일, 다 보고 싶으면 전체를 고른다.
 * 일봉·주봉·월봉은 원래 길게 보는 것이라 이 칸이 안 나온다.
 */
type SpanKind = "intraday" | "daily" | "weekly" | "monthly";

/**
 * 봉 종류마다 **볼 만한 구간이 다르다.**
 *
 * 분봉은 오늘 어떻게 흘렀나를 보려고 켠다. 일봉을 2025년부터 통째로 그리면
 * **열 때마다 손으로 확대**해야 한다 — 최근 캔들이 손톱만 해서 아무것도 안 읽힌다.
 * 주봉·월봉은 반대로 짧게 자르면 사이클이 안 보인다.
 *
 * ⚠️ 숫자는 거래일이 아니라 **그 봉의 개수**다. `lastDays` 가 「서로 다른 날짜」를 세는데
 * 주봉은 캔들 하나가 한 주이므로 250 을 주면 250주(≈5년)가 된다.
 * 주봉에 「1년」을 250 으로 뒀더니 자르기가 아무 일도 안 했다 — 받아온 게 그보다 적었다.
 * 그래서 주봉은 52·156, 월봉은 12·36 으로 **봉 단위에 맞춰** 센다. (0 이면 전체)
 */
const SPAN_SETS: Record<SpanKind, { label: string; days: number }[]> = {
  intraday: [
    { label: "1일", days: 1 },
    { label: "3일", days: 3 },
    { label: "전체", days: 0 },
  ],
  daily: [
    { label: "1개월", days: 20 },
    { label: "3개월", days: 60 },
    { label: "6개월", days: 120 },
    { label: "1년", days: 240 },
    { label: "전체", days: 0 },
  ],
  weekly: [
    { label: "6개월", days: 26 },
    { label: "1년", days: 52 },
    { label: "3년", days: 156 },
    { label: "전체", days: 0 },
  ],
  monthly: [
    { label: "1년", days: 12 },
    { label: "3년", days: 36 },
    { label: "10년", days: 120 },
    { label: "전체", days: 0 },
  ],
};

const CHROME_PX = 108;
const CHROME_PX_COMPACT = 62;
/** 이보다 낮으면 폰을 눕힌 것으로 본다 */
const COMPACT_VH = 500;

export function ChartPanel({
  code,
  name,
  initialPeriod = "day",
  insights = true,
  height,
  sizeTick = 0,
  viewId,
}: {
  code: string;
  /** 툴팁 머리에 쓸 종목명 */
  name?: string;
  initialPeriod?: Period;
  /** 차트 위 판독 줄(이동평균·매물대)을 붙일지 */
  insights?: boolean;
  /**
   * 차트 높이(px). 안 주면 320.
   *
   * 보드처럼 **칸 크기를 사람이 정하는 자리**에서 넘긴다 — 캔버스는 칸이 커져도
   * 스스로 커지지 않아서, 크기를 아는 쪽이 알려 주지 않으면 여백만 늘어난다.
   */
  height?: number;
  /** 크기가 바뀌었다는 신호. 가로만 바뀐 경우를 잡으려고 있다 */
  sizeTick?: number;
  /**
   * **이 차트가 놓인 자리의 이름.** 주면 봉·거래소·구간을 그 이름으로 기억한다.
   *
   * ⚠️ 보드에서 종목을 바꾸면 차트가 죄다 일봉으로 돌아갔다. 칸이 `key={code}` 로
   * 그려져서 **종목이 바뀔 때마다 컴포넌트가 통째로 새로 태어났기** 때문이다.
   * 새로고침해도 마찬가지였다 — 고른 봉을 아무 데도 안 적어 뒀다.
   *
   * 자리 이름으로 적어 두면 다시 태어나도 그대로 돌아온다. 자리마다 따로 적으므로
   * **한 화면에서 칸 하나는 분봉, 다른 칸은 주봉**으로 둘 수도 있다 — 원래 보드를
   * 쓰는 이유가 그것이다. 이름을 안 주면(종목 상세처럼 한 번 보고 마는 자리) 예전처럼
   * 기억하지 않는다.
   */
  viewId?: string;
}) {
  const { prefs, set: savePrefs } = useChartPrefs();

  /*
   * 이 자리에 마지막으로 무엇을 띄워 뒀나.
   *
   * 읽기는 **동기**여야 한다 — useState 초깃값으로 쓰므로 나중에 도착하면 이미 일봉이
   * 한 번 그려진 뒤다. 그래서 localStorage 에서 바로 꺼낸다(서버 값은 부팅 때 여기
   * 채워진다). 쓰기는 `setPref` 라 서버에도 올라간다.
   */
  const viewKey = viewId ? `vntg.chart.view.${viewId}` : "";
  const saved = (): { period?: Period; venue?: Venue; venueDaily?: Venue; span?: number; fold?: boolean } => {
    if (!viewKey) return {};
    try {
      return JSON.parse(localStorage.getItem(viewKey) ?? "{}") as Record<string, never>;
    } catch {
      return {};
    }
  };

  const [period, setPeriod] = useState<Period>(() => {
    const p = saved().period;
    return p && p in PERIOD_CONFIG ? p : initialPeriod;
  });
  /*
   * 기본을 **통합**으로 (2026-08-26 — 「모든 로직은 모든 시장을 반영해야 한다」).
   * 시장이 KRX 만으로 돌지 않는다 — NXT 프리·애프터 체결까지가 오늘의 전부다.
   * KRX/NXT 만 보고 싶으면 셀렉터로 고른다(칸마다 기억).
   */
  const [venue, setVenue] = useState<Venue>(() => saved().venue ?? "all");
  /**
   * **일·주·월봉의 거래소는 따로 기억한다** (2026-09-11 — 벤티지: "NXT로 설정을 넣고 해도
   * NXT 시세가 나타나지 않습니다").
   *
   * 예전엔 일봉이 거래소 선택을 **통째로 무시하고** 늘 KRX 코드로 받았다. 셀렉터는 보이는데
   * 아무 일도 안 일어났고, 08~09시 프리마켓에는 KRX 가 안 열려 **어제 종가로 된 빈 봉**
   * (시=고=저=종, 거래량 0)이 오늘 자리에 붙어 있었다. 실측 09-11 08:07 SK하이닉스 —
   * KRX 코드는 1,853,000·거래량 0, `_NX` 는 시 1,800,000 저 1,769,000 현재 1,793,000·거래량 180,837.
   *
   * 기본은 **통합** (2026-09-11 저녁 — 벤티지: "차트 나올때는 기본 통합으로 나오게 해주고").
   * 하루의 전부는 KRX 정규장 + NXT 프리·애프터다. 9/3 에 KRX 로 고정했던 것은 「통합 종가가
   * 공식 종가와 다르다」는 사정이었는데, 그건 **판독 줄이 KRX 일봉을 따로 받아** 푼다
   * (아래 `curVenue === "krx"` 가드). 보는 눈은 통합이 맞다.
   */
  const [dailyVenue, setDailyVenue] = useState<Venue>(() => saved().venueDaily ?? "all");
  /**
   * 지금 보고 있는 구간(거래일 수).
   *
   * 봉을 바꾸면 **그 봉의 기본값으로 되돌린다** — 일봉에서 「전체」로 보던 사람이
   * 분봉으로 갔을 때도 전체가 나오면 다시 확대해야 한다. 기본값은 설정에서 정한다.
   */
  const kindOf = (p: Period): SpanKind =>
    PERIOD_CONFIG[p].intraday ? "intraday" : p === "day" ? "daily" : p === "week" ? "weekly" : "monthly";
  const defaultSpan = (p: Period): number => {
    const k = kindOf(p);
    if (k === "intraday") return prefs.spanIntraday;
    if (k === "daily") return prefs.spanDaily;
    if (k === "weekly") return prefs.spanWeekly;
    return prefs.spanMonthly;
  };
  const [span, setSpan] = useState<number>(() => {
    const v = saved();
    const p = v.period && v.period in PERIOD_CONFIG ? v.period : initialPeriod;
    return typeof v.span === "number" ? v.span : defaultSpan(p);
  });

  /*
   * 판독 줄을 접어 뒀나 — **이 자리의 사정**이다.
   *
   * ⚠️ 전역 설정에 있었다. 그래서 한 창에서 「이동평균·매물대 접기」를 누르면 **다른
   * 창의 차트까지 같이 접혔다.** 보드를 여러 창으로 띄우는 이유가 창마다 다르게 보려는
   * 것인데 그게 안 됐다.
   *
   * 자리 이름이 있으면 그 자리에 적고, 없으면(종목 상세처럼 한 번 보고 마는 자리)
   * 예전처럼 전역 설정을 쓴다 — 거기서 접은 건 「앞으로도 접어 둬」에 가깝다.
   */
  const [foldOwn, setFoldOwn] = useState<boolean>(() => {
    const v = saved().fold;
    return typeof v === "boolean" ? v : prefs.insightsFold;
  });
  const fold = viewKey ? foldOwn : prefs.insightsFold;
  const toggleFold = () => {
    if (viewKey) setFoldOwn((v) => !v);
    else savePrefs({ ...prefs, insightsFold: !prefs.insightsFold });
  };

  /*
   * 바뀔 때마다 적어 둔다.
   *
   * 셋을 한 덩어리로 적는다 — 봉과 구간은 짝이라서 따로 적으면 「주봉인데 구간은 240일」
   * 같은 어긋난 조합이 남는다.
   */
  useEffect(() => {
    if (!viewKey) return;
    setPref(viewKey, JSON.stringify({ period, venue, venueDaily: dailyVenue, span, fold: foldOwn }));
  }, [viewKey, period, venue, dailyVenue, span, foldOwn]);
  /*
   * **복기** (2026-09-10 — 벤티지: "차트에 복기라는 버튼 … 내가 이 종목을 언제 팔았고 언제 샀고 … 일봉, 주봉,
   * 분봉 이런 데서 모두"). 켜면 체결 창고에서 이 종목의 내 체결을 받아 봉에 매수▲·매도▼ 를 붙인다.
   * 켜 둔 건 기기에 남는다 — 복기하러 들어온 사람은 다음 종목도 복기한다.
   */
  const [review, setReview] = useState<boolean>(() => localStorage.getItem("vntg.chart.review") === "1");
  const [trades, setTrades] = useState<TradeFill[]>([]);
  const [tradeInfo, setTradeInfo] = useState<{ days: number; from: string | null } | null>(null);
  useEffect(() => {
    if (!review) {
      setTrades([]);
      return;
    }
    let alive = true;
    api
      .myTrades(code, 400)
      .then((r) => {
        if (!alive) return;
        setTrades(r.trades);
        setTradeInfo({ days: r.days, from: r.from });
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [review, code]);
  const toggleReview = () => {
    setReview((v) => {
      localStorage.setItem("vntg.chart.review", v ? "0" : "1");
      return !v;
    });
  };
  const tradeSummary = (() => {
    if (!review) return null;
    const buys = trades.filter((t) => t.side === "buy");
    const sells = trades.filter((t) => t.side === "sell");
    const sum = (a: TradeFill[]) => a.reduce((x, t) => x + t.qty, 0);
    return { buys: buys.length, sells: sells.length, buyQty: sum(buys), sellQty: sum(sells) };
  })();
  /* 복기 목록 — 「월일 시각 B/S 수량 @가격」 줄줄이 (2026-09-10 저녁 — 벤티지 "언제 팔고 샀는지도 적어줘 월일시간") */
  const [reviewList, setReviewList] = useState(false);
  const reviewRows = (() => {
    if (!review || !reviewList || trades.length === 0) return null;
    const fmtAt = (iso: string) => {
      const d = new Date(new Date(iso).getTime() + 9 * 3600_000);
      const p = (n: number) => String(n).padStart(2, "0");
      return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
    };
    const rows = [...trades].sort((a, b) => b.at.localeCompare(a.at));
    return (
      <div className="chart-review-list">
        {rows.map((t, i) => (
          <div className="chart-review-row" key={`${t.ordNo}-${i}`}>
            <span className="num">{fmtAt(t.at)}</span>
            <b className={t.side === "buy" ? "rv-b" : "rv-s"}>{t.side === "buy" ? "B 매수" : "S 매도"}</b>
            <span className="num">{t.qty.toLocaleString("ko-KR")}주</span>
            <span className="num">@{t.price.toLocaleString("ko-KR")}</span>
            <i className="pt-n">{t.mock ? "모의" : ""}</i>
          </div>
        ))}
      </div>
    );
  })();
  const [full, setFull] = useState(false);
  /** 전체화면에서는 판독 줄을 접어 둔다 — 크게 보려고 들어온 자리다 */
  const [fullInsights, setFullInsights] = useState(false);
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 800 : window.innerHeight));
  const hostRef = useRef<HTMLDivElement>(null);
  const isIntraday = PERIOD_CONFIG[period].intraday === true;

  /*
   * 키움은 종목코드 접미사로 거래소를 가른다 — 005930(KRX) / _NX(NXT) / _AL(통합).
   * 통합은 두 거래소 체결을 합친 것이라 봉의 고가·저가가 벌어지고, NXT는 거래가 얕은 종목에서
   * 봉이 튄다. 그래서 **기본은 KRX**로 두고 필요할 때만 바꿔 보게 한다.
   */
  /*
   * ⚠️ **일·주·월봉의 기본은 KRX** (2026-09-03 — 벤티지: "통합으로 넣으니깐 종가 기준으로 KRX도 안 맞고
   * NXT에도 안 맞아. 셀트리온"). 통합(_AL) 일봉의 종가는 NXT 애프터마켓(20:00) 마지막 체결이고 시가는
   * 프리마켓(08:00) 첫 체결이라, 공식 종가(KRX 15:30)로 그리는 이동평균·눌림목·신호등과 어긋난다.
   * 실측 셀트리온 9/2: KRX 종가 186,300 · 통합 185,000 · NXT 185,000.
   *
   * (2026-09-11) 그렇다고 **고른 것을 무시하지는 않는다** — 기본만 KRX 고 셀렉터는 일봉에도 먹는다.
   * 위 `dailyVenue` 주석 참고.
   */
  const curVenue = isIntraday ? venue : dailyVenue;
  const chartCode = curVenue === "krx" ? code : `${code}_${curVenue === "nxt" ? "NX" : "AL"}`;

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

  /*
   * **크게 볼 때 종목명·현재가** (2026-09-11 — 벤티지: "차트를 크게 보기 하면 해당 종목에 대한
   * 정보가 아예 보이지 않네요").
   *
   * 전체화면은 시트 머리(종목명·현재가)를 덮어 버린다. 낮은 화면(폰 가로)에서는 머리줄까지
   * 접히니 무슨 종목인지도 안 보였다. **크게 볼 때만** 시세를 따로 받아 도구줄과 머리줄에 적는다 —
   * 평소엔 빈 약속을 돌려주므로 조회가 늘지 않는다(시트 쪽은 이미 제 값을 받고 있다).
   */
  const { data: liveInfo } = useLive<RawRecord>(() => api.stockInfo(code), [code], 5000);
  const livePrice = Math.abs(Number(liveInfo?.cur_prc ?? NaN));
  const liveRate = Number(liveInfo?.flu_rt ?? NaN);
  const priceTag =
    Number.isFinite(livePrice) && livePrice > 0 ? (
      <span className={`chart-full-price num ${liveRate > 0 ? "positive" : liveRate < 0 ? "negative" : ""}`}>
        <b>{livePrice.toLocaleString("ko-KR")}</b>
        {Number.isFinite(liveRate) && (
          <i>
            {liveRate > 0 ? "+" : ""}
            {liveRate.toFixed(2)}%
          </i>
        )}
      </span>
    ) : null;

  /*
   * **마지막 봉은 살아 있어야 한다** (2026-09-11 저녁 — 벤티지: "차트에 표시되는 현재가 가격이
   * 변동이 안되네? 위에는 계속 가격 업데이트 되는데 차트는 고정되어있더라").
   *
   * 일·주·월봉은 600줄짜리 응답이라 60초에 한 번만 받는다. 그래서 오른쪽 가격표가 머리의
   * 현재가보다 최대 1분 늦었다 — 머리가 초마다 뛰는 옆에서 그건 「멈춘 것」으로 보인다.
   * 무거운 봉 조회는 그대로 두고, **가벼운 시세(5초)로 마지막 봉만 고쳐 그린다.** 고가·저가도
   * 지금 값이 넘어서면 같이 넓힌다 — HTS 가 하는 그것이다.
   *
   * **분봉도 같다** (2026-09-11 저녁 — 벤티지: "분봉 이런데도 다 적용되는거지?"). 처음엔 분봉을
   * 뺐다 — 10초마다 받으니 충분하다고 봤는데, 10초도 멈춘 것으로 보이는 건 마찬가지고 무엇보다
   * 「어느 봉은 살아 있고 어느 봉은 아니다」가 사람이 외울 규칙이 아니다.
   *
   * 오늘 봉이 아직 없으면(장 전 KRX) 없는 봉을 만들어 붙이지는 않는다 — 그건 어제 종가를
   * 오늘로 그리는 짓이고, 방금 걷어낸 그 빈 봉이다.
   */
  const all = (() => {
    const rows = toCandles(chart, period);
    const px = Math.abs(Number(liveInfo?.cur_prc ?? NaN));
    const last = rows[rows.length - 1];
    if (!last || !Number.isFinite(px) || px <= 0) return rows;
    const paint = (): Candle => ({ ...last, close: px, high: Math.max(last.high, px), low: Math.min(last.low, px) });
    const t = last.time as { year: number; month: number; day: number } | number;
    if (typeof t === "number") {
      /*
       * 분봉의 시각은 **한국시간을 UTC 인 척** 넣어 둔 초 단위 값이다(`parseMinuteTime`).
       * 마지막 봉이 **지금 구간**일 때만 고친다 — 몇 분째 체결이 없어 봉이 뒤처져 있으면
       * 그 옛 봉에 지금 값을 칠하는 게 된다. 봉 시각이 구간의 시작인지 끝인지가 응답마다
       * 흔들려서 앞뒤 한 구간씩 허용한다.
       */
      const mins = Number(period.slice(1)) || 1;
      const nowSec = (Date.now() + 9 * 3600_000) / 1000;
      const diff = nowSec - t;
      return Math.abs(diff) < mins * 60 ? [...rows.slice(0, -1), paint()] : rows;
    }
    const kst = new Date(Date.now() + 9 * 3600_000);
    const y = kst.getUTCFullYear();
    const mo = kst.getUTCMonth() + 1;
    const d = kst.getUTCDate();
    /*
     * 주봉·월봉의 마지막 봉은 날짜가 오늘이 아니다(그 주·그 달의 시작일이다). 그렇다고 아무
     * 봉이나 고치면 안 된다 — 이번 주 봉이 아직 없을 때(월요일 장 전, 빈 봉을 걷어낸 뒤)
     * **지난주 봉에 오늘 값을 칠하게** 된다. 지금 구간 안에 있는 봉일 때만 고친다.
     */
    const days = Math.round((Date.UTC(y, mo - 1, d) - Date.UTC(t.year, t.month - 1, t.day)) / 86400_000);
    const inNow =
      period === "day"
        ? days === 0
        : period === "week"
          ? days >= 0 && days < 7
          : t.year === y && t.month === mo;
    if (!inNow) return rows;
    return [...rows.slice(0, -1), paint()];
  })();
  /*
   * 분봉만 자른다. 자를 때도 **받은 것을 버리지 않는다** — 구간을 바꾸면 다시 안 받고
   * 바로 넓어진다(같은 응답을 다시 부르면 초당 제한만 먹는다).
   */
  const candles = span > 0 ? lastDays(all, span) : all;

  /* ---------------- 크게 보기 ---------------- */

  const exitFull = useCallback(() => {
    // 실패해도 오버레이는 닫아야 한다 — 안 그러면 빠져나올 방법이 없어진다
    try {
      if (document.fullscreenElement) void document.exitFullscreen();
    } catch {
      /* 되는 데서만 된다 */
    }
    try {
      (screen.orientation as { unlock?: () => void } | undefined)?.unlock?.();
    } catch {
      /* iOS 는 없다 */
    }
    setFull(false);
  }, []);

  /*
   * 전체화면 요청은 **여기서 하지 않는다.**
   *
   * `setFull(true)` 은 곧바로 반영되지 않는다. 바로 뒤에서 `requestFullscreen()` 을 부르면
   * 그 시점의 `hostRef` 는 **아직 옛 요소**다 — 브라우저가 그걸 전체화면으로 만들고 나면
   * 화면에는 아무것도 안 나온다. 실제로 「크게 보는 중…」만 뜨고 까매졌다.
   * 그래서 상태만 켜고, 실제 요청은 아래 effect 가 **다시 그린 뒤에** 한다.
   */
  function enterFull() {
    setFull(true);
  }

  useEffect(() => {
    if (!full) return;
    const el = hostRef.current;
    if (!el) return;
    void (async () => {
      try {
        await el.requestFullscreen?.();
      } catch {
        // iOS 사파리는 video 가 아니면 안 준다. 오버레이만으로도 화면은 꽉 찬다
      }
      try {
        await (
          screen.orientation as { lock?: (o: string) => Promise<void> } | undefined
        )?.lock?.("landscape");
      } catch {
        // 안드로이드 크롬에서만 된다. 안 되면 사용자가 폰을 돌리면 그만이다
      }
    })();
  }, [full]);

  // 화면 크기·방향이 바뀌면 차트 높이를 다시 잰다
  useEffect(() => {
    const onResize = () => setVh(window.innerHeight);
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  /*
   * ESC 로 나가거나, 브라우저가 알아서 전체화면을 풀었을 때 상태를 맞춘다.
   * 이걸 안 하면 전체화면만 풀리고 오버레이가 남아 화면이 잠긴 것처럼 보인다.
   */
  useEffect(() => {
    if (!full) return;
    const onFsChange = () => {
      if (!document.fullscreenElement) setFull(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") exitFull();
    };
    document.addEventListener("fullscreenchange", onFsChange);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("fullscreenchange", onFsChange);
      window.removeEventListener("keydown", onKey);
    };
  }, [full, exitFull]);

  // 오버레이가 떠 있는 동안 뒤 화면이 스크롤되면 안 된다
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [full]);

  const showInsights = insights && prefs.insightsOn && (!full || fullInsights);
  // 눕힌 폰에서는 머리줄을 접는다. 종목명은 차트 툴팁에도 나오므로 잃는 게 없다
  const compact = full && vh < COMPACT_VH;

  /*
   * ⚠️ 전체화면 높이를 **어림하지 않고 실제로 잰다.**
   *
   * 예전엔 `창 높이 − 도구줄 어림값(108px)` 로 계산했다. 두 가지가 틀어졌다.
   *   · 전체화면에 들어가면 브라우저 주소창이 사라져 창 높이가 **그 순간** 바뀐다.
   *     `resize` 가 늦게 오면 옛 높이로 계산한 차트가 그려진다.
   *   · 도구줄이 실제로 몇 픽셀인지는 글꼴 크기 설정에 따라 달라진다. 108 은 어림이다.
   *
   * 그래서 눕힌 폰(844×390)에서 **차트가 649px** 로 잡혀 창보다 커졌고, 남는 자리가
   * 없으니 위의 도구줄이 8px 로 짓눌려 글자가 안 보였다. 사용자 화면이 그 꼴이었다.
   *
   * 차트를 담는 칸의 높이를 그대로 쓴다. 칸의 크기는 아래 CSS 가 flex 로 정하므로
   * 차트가 커진다고 칸이 커지지 않는다 — 순환이 안 생긴다.
   */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapH, setWrapH] = useState(0);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !full) return;
    const measure = () => setWrapH(el.clientHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [full, compact, fullInsights]);

  const chartHeight = full
    ? Math.max(
        200,
        // 잰 값이 아직 없을 때만 어림값으로 시작한다 — 한 프레임 뒤 실제 값으로 바뀐다
        wrapH > 0 ? wrapH : vh - (compact ? CHROME_PX_COMPACT : CHROME_PX),
      )
    : Math.max(140, height ?? 320);

  const toolbar = (
    <div className="period-toggle">
      {/* 크게 보는 중이고 머리줄이 접혔으면(폰 가로) 여기가 종목을 알 수 있는 유일한 자리다 (2026-09-11) */}
      {full && compact && (
        <span className="chart-full-tag">
          <b>{name ?? code}</b>
          {priceTag}
          <span className="period-sep" />
        </span>
      )}
      {/*
        거래소는 **드롭박스로 접는다.** 버튼 셋을 늘어놓으면 도구줄이 길어져서
        정작 자주 누르는 기간 버튼이 화면 밖으로 밀린다 — 거래소는 한 번 정해 두고
        거의 안 바꾸는 값이라 접어 두는 쪽이 맞다.
      */}
      <select
        className="period-select"
        value={curVenue}
        /* (2026-09-11) 분봉과 일·주·월봉의 거래소를 따로 기억한다 — 위 dailyVenue 주석 */
        onChange={(e) => (isIntraday ? setVenue : setDailyVenue)(e.target.value as Venue)}
        title={VENUES.find((v) => v.key === curVenue)?.hint}
      >
        {VENUES.map((v) => (
          <option key={v.key} value={v.key}>
            {v.label}
          </option>
        ))}
      </select>
      <span className="period-sep" />
      {/*
        봉 종류도 **드롭박스로 접는다.**

        여덟 개를 버튼으로 늘어놓으면 도구줄이 화면을 넘어 가로로 굴러간다.
        거기에 분봉 구간까지 붙으니 열한 개가 되어 정작 자주 누르는 게 밖으로 밀렸다.

        고르는 값이 많으면 **접는 게 맞다** — 봉은 한 번 정하면 한동안 그대로 보는 값이고,
        분봉을 켠 뒤 자주 바꾸는 건 **구간**이라 그쪽만 버튼으로 남긴다.
      */}
      <select
        className="period-select"
        value={period}
        onChange={(e) => {
          const p = e.target.value as Period;
          setPeriod(p);
          // 봉이 바뀌면 그 봉의 기본 구간으로 — 안 그러면 매번 다시 확대해야 한다
          setSpan(defaultSpan(p));
        }}
      >
        {(Object.keys(PERIOD_CONFIG) as Period[]).map((p) => (
          <option key={p} value={p}>
            {PERIOD_CONFIG[p].label}
          </option>
        ))}
      </select>
      {/* 구간 — 봉 종류마다 고를 수 있는 것이 다르다 */}
      <span className="period-sep" />
      {SPAN_SETS[kindOf(period)].map((sp) => (
        <button
          key={sp.label}
          className={`period-btn span ${sp.days === span ? "active" : ""}`}
          onClick={() => setSpan(sp.days)}
          title={sp.days === 0 ? "받아온 전체" : `최근 ${sp.days}거래일`}
        >
          {sp.label}
        </button>
      ))}
      {/*
        「크게」는 **전체 버튼 옆** (2026-08-27 사용자 지정) — 예전엔 차트 모서리에
        띄웠는데(당시 도구줄이 버튼 11개라 굴러갔다), 보드에서 칸의 자물쇠·핀과
        겹쳐 그걸 못 누르게 됐다. 지금은 봉 종류가 드롭박스로 접혀 도구줄이 짧아서
        여기 둬도 안 밀린다.
      */}
      {!full && (
        <>
          <span className="period-sep" />
          <button className="period-btn" onClick={() => enterFull()} title="크게 보기">
            ⤢ 크게
          </button>
        </>
      )}
      {/* 복기 — 내 매수▲·매도▼ 를 봉에. 「크게」 옆 (2026-09-10) */}
      <button
        className={`period-btn review${review ? " active" : ""}`}
        onClick={toggleReview}
        title={review ? "내 체결 표시 끄기" : "내가 언제 사고 팔았는지 봉에 표시 (체결 창고, 최근 400일)"}
      >
        📝 복기
      </button>
      {tradeSummary && trades.length > 0 && (
        <button
          className={`period-btn review-list${reviewList ? " active" : ""}`}
          onClick={() => setReviewList((v) => !v)}
          title="언제 사고 팔았는지 줄줄이"
        >
          {reviewList ? "▴ 목록" : "▾ 목록"}
        </button>
      )}
      {tradeSummary && (
        <span className="chart-review-sum pt-n" title={tradeInfo?.from ? `체결 창고 ${tradeInfo.from}부터 ${tradeInfo.days}일치` : undefined}>
          {trades.length === 0 ? (
            tradeInfo && tradeInfo.days === 0 ? "체결 창고가 아직 비었어요" : "이 종목 체결 없음"
          ) : (
            <>
              <b className="positive">매수 {tradeSummary.buys}회 {tradeSummary.buyQty.toLocaleString("ko-KR")}주</b>
              {" · "}
              <b className="negative">매도 {tradeSummary.sells}회 {tradeSummary.sellQty.toLocaleString("ko-KR")}주</b>
            </>
          )}
        </span>
      )}
      {full && (
        <>
          <span className="period-sep" />
          <button
            className={`period-btn ${fullInsights ? "active" : ""}`}
            onClick={() => setFullInsights((v) => !v)}
            title="이동평균·매물대 판독 줄"
          >
            판독
          </button>
          <button className="period-btn" onClick={exitFull} title="닫기 (ESC)">
            ✕ 닫기
          </button>
        </>
      )}
    </div>
  );

  /*
   * 판독 줄(이동평균·매물대)은 **차트 아래**다.
   *
   * 예전엔 도구줄 바로 밑에 있었는데, 그러면 기간을 고르고 나서 정작 차트를 보려면
   * 판독 줄을 지나쳐 내려가야 했다. 이 화면에서 제일 먼저 볼 것은 차트고,
   * 5일선·20일선·매물대는 **차트를 본 다음에** 확인하는 값이다.
   * 순서를 보는 순서대로 맞춘다: 기간 고르기 → 차트 → 숫자.
   */
  /*
   * 판독 줄을 **접었다 편다.**
   *
   * 보고 싶은 값이긴 한데 늘 펴 두면 차트 위 서너 줄을 잡아먹는다 — 특히 보드에서
   * 칸이 작을 때 거슬린다. 그렇다고 아래로 내리면 칸을 키웠을 때 밀려나서 안 보인다
   * (그래서 위로 올렸다). 위에 두되 **접을 수 있게** 하는 게 답이다.
   *
   * 접은 상태는 설정에 남는다 — 매번 접는 건 매번 펴는 것만큼 번거롭다.
   */
  const insightsRow = showInsights && (
    /*
      판독 줄은 **일봉 기준**이다. 「5일선」은 5거래일이므로 주봉으로 재면 5주선이 된다.
      지금 보고 있는 게 KRX 일봉이면 받아 둔 배열을 그대로 넘기고(같은 걸 두 번 받지 않는다),
      다른 봉이나 다른 거래소를 보고 있으면 넘기지 않아 판독 줄이 일봉을 따로 받는다.
    */
    <ChartInsights
      code={code}
      candles={period === "day" && curVenue === "krx" && !loading ? candles : undefined}
    />
  );

  const body = (
    <>
      {toolbar}
      {showInsights && (
        <button
          className="chart-insights-toggle"
          onClick={toggleFold}
          title={fold ? "이동평균·매물대 펴기" : "접기"}
        >
          {fold ? "▾ 이동평균·매물대" : "▴ 이동평균·매물대 접기"}
        </button>
      )}
      {/*
        판독 줄은 **차트 위**다.

        예전엔 아래에 뒀다. 「보는 순서대로 — 기간 고르기 → 차트 → 숫자」라는 이유였는데,
        보드에 넣고 보니 틀렸다. **칸을 키우면 차트만 커지고 판독 줄은 아래로 밀려나** 같이
        안 보인다. 칸 안에서 스크롤을 내려야 나오는 값은 없는 것과 같다.
        차트는 남는 높이를 다 먹는 요소라 **뒤에 둔 것은 반드시 밀린다.**

        위에 두면 칸을 아무리 키워도 이평선·매물대가 늘 눈에 있다. 도구줄과 붙어 있어
        「고르고 → 읽고 → 그림」 순서가 되는데, 실제로 보는 것도 그 순서다.
      */}
      {!fold && insightsRow}
      {reviewRows}
      {loading && <div className="empty">차트 불러오는 중...</div>}
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && (
        <div className="chart-wrap" ref={wrapRef}>
          {/* 「크게」 버튼은 도구줄(전체 옆)로 이사했다 — 모서리 붙박이는 보드 자물쇠를 가렸다 */}
          <CandleChart
            fitKey={`${period}:${span}:${curVenue}`}
            candles={candles}
            intraday={isIntraday}
            trades={review ? trades : undefined}
            height={chartHeight}
            name={name ? `${name} · ${VENUES.find((v) => v.key === curVenue)?.label}` : undefined}
            code={code}
            sizeTick={sizeTick}
            lockScope={viewId}
          />
        </div>
      )}
    </>
  );

  /*
   * **트리 모양을 바꾸지 않는다.**
   *
   * 예전엔 전체화면일 때 다른 구조를 돌려줬는데(div 하나 → 형제 둘),
   * 그러면 React 가 차트를 통째로 버리고 새로 만든다. 그 순간 아직 폭이 0 이라
   * 아무것도 안 그려진 채로 남았다 — 까맣게 보인 두 번째 이유다.
   *
   * 늘 같은 두 형제를 두고 **클래스만 바꾼다.** 차트는 한 번 만들어진 채로 크기만 달라진다.
   */
  return (
    <>
      {/* 원래 자리에 남기는 자국 — 없으면 닫을 때 화면이 튄다 */}
      <div className="chart-placeholder" hidden={!full}>
        크게 보는 중…
      </div>
      <div
        className={full ? `chart-full${compact ? " compact" : ""}` : undefined}
        ref={hostRef}
      >
        {full && !compact && (
          <div className="chart-full-head">
            <span className="chart-full-name">
              {name ?? code}
              <span className="pt-n"> {code}</span>
              {/* 현재가도 같이 — 크게 보면 시트 머리가 가려진다 (2026-09-11) */}
              {priceTag}
            </span>
            <span className="pt-n chart-full-hint">가로로 돌리면 더 넓게 봅니다 · ESC 로 닫기</span>
          </div>
        )}
        {body}
      </div>
    </>
  );
}
