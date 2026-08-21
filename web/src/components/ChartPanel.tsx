import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "../useLive";
import type { RawRecord } from "../api";
import { CandleChart } from "./CandleChart";
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
const SPANS: { key: string; label: string; days: number }[] = [
  { key: "1d", label: "1일", days: 1 },
  { key: "3d", label: "3일", days: 3 },
  { key: "all", label: "전체", days: 0 },
];

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
}) {
  const { prefs } = useChartPrefs();
  const [period, setPeriod] = useState<Period>(initialPeriod);
  const [venue, setVenue] = useState<Venue>("krx");
  /** 분봉에서만 쓰는 표시 구간 */
  const [span, setSpan] = useState("1d");
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

  const all = toCandles(chart, period);
  /*
   * 분봉만 자른다. 자를 때도 **받은 것을 버리지 않는다** — 구간을 바꾸면 다시 안 받고
   * 바로 넓어진다(같은 응답을 다시 부르면 초당 제한만 먹는다).
   */
  const candles = isIntraday ? lastDays(all, SPANS.find((s) => s.key === span)?.days ?? 1) : all;

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
  const chartHeight = full
    ? Math.max(200, vh - (compact ? CHROME_PX_COMPACT : CHROME_PX) - (fullInsights ? 150 : 0))
    : Math.max(140, height ?? 320);

  const toolbar = (
    <div className="period-toggle">
      {/*
        거래소는 **드롭박스로 접는다.** 버튼 셋을 늘어놓으면 도구줄이 길어져서
        정작 자주 누르는 기간 버튼이 화면 밖으로 밀린다 — 거래소는 한 번 정해 두고
        거의 안 바꾸는 값이라 접어 두는 쪽이 맞다.
      */}
      <select
        className="period-select"
        value={venue}
        onChange={(e) => setVenue(e.target.value as Venue)}
        title={VENUES.find((v) => v.key === venue)?.hint}
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
        onChange={(e) => setPeriod(e.target.value as Period)}
      >
        {(Object.keys(PERIOD_CONFIG) as Period[]).map((p) => (
          <option key={p} value={p}>
            {PERIOD_CONFIG[p].label}
          </option>
        ))}
      </select>
      {/* 분봉에서만 — 일봉·주봉은 원래 길게 보는 것이다 */}
      {isIntraday && (
        <>
          <span className="period-sep" />
          {SPANS.map((sp) => (
            <button
              key={sp.key}
              className={`period-btn span ${sp.key === span ? "active" : ""}`}
              onClick={() => setSpan(sp.key)}
              title={sp.days === 0 ? "받아온 전체" : `최근 ${sp.days}거래일`}
            >
              {sp.label}
            </button>
          ))}
        </>
      )}
      {/*
        전체화면일 때만 여기 둔다. 「크게」 버튼은 도구줄에 두면 안 된다 —
        이 줄은 가로로 굴러가고(모바일 가로밀림을 막느라 그렇게 했다) 맨 끝 버튼은
        화면 밖으로 나가 **아예 안 보인다.** 그래서 차트 모서리에 따로 띄운다.
      */}
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
  const insightsRow = showInsights && (
    /*
      판독 줄은 **일봉 기준**이다. 「5일선」은 5거래일이므로 주봉으로 재면 5주선이 된다.
      지금 보고 있는 게 KRX 일봉이면 받아 둔 배열을 그대로 넘기고(같은 걸 두 번 받지 않는다),
      다른 봉이나 다른 거래소를 보고 있으면 넘기지 않아 판독 줄이 일봉을 따로 받는다.
    */
    <ChartInsights
      code={code}
      candles={period === "day" && venue === "krx" && !loading ? candles : undefined}
    />
  );

  const body = (
    <>
      {toolbar}
      {loading && <div className="empty">차트 불러오는 중...</div>}
      {error && <div className="error-banner">{error}</div>}
      {!loading && !error && (
        <div className="chart-wrap">
          {/*
            차트 오른쪽 위에 붙박는다. 도구줄이 굴러가도 이건 늘 같은 자리에 있다.
            전체화면 안에서는 도구줄에 닫기가 있으므로 띄우지 않는다.
          */}
          {!full && (
            <button className="chart-expand" onClick={() => void enterFull()} title="크게 보기">
              ⤢ 크게
            </button>
          )}
          <CandleChart
            fitKey={`${period}:${span}:${venue}`}
            candles={candles}
            intraday={isIntraday}
            height={chartHeight}
            name={name ? `${name} · ${VENUES.find((v) => v.key === venue)?.label}` : undefined}
            code={code}
            sizeTick={sizeTick}
          />
        </div>
      )}
      {insightsRow}
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
            </span>
            <span className="pt-n chart-full-hint">가로로 돌리면 더 넓게 봅니다 · ESC 로 닫기</span>
          </div>
        )}
        {body}
      </div>
    </>
  );
}
