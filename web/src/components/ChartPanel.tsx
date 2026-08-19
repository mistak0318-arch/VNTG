import { useCallback, useEffect, useRef, useState } from "react";
import { useLive } from "../useLive";
import type { RawRecord } from "../api";
import { CandleChart } from "./CandleChart";
import { useChartPrefs } from "../useChartPrefs";
import { ChartInsights } from "./ChartInsights";
import { PERIOD_CONFIG, toCandles, type Period } from "./chartCandles";

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
const CHROME_PX = 108;
const CHROME_PX_COMPACT = 62;
/** 이보다 낮으면 폰을 눕힌 것으로 본다 */
const COMPACT_VH = 500;

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

  const candles = toCandles(chart, period);

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

  async function enterFull() {
    setFull(true);
    try {
      await hostRef.current?.requestFullscreen?.();
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
  }

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
    : 320;

  const toolbar = (
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

  const body = (
    <>
      {toolbar}
      {/*
        판독 줄은 **일봉 기준**이다. 「5일선」은 5거래일이므로 주봉으로 재면 5주선이 된다.
        지금 보고 있는 게 KRX 일봉이면 받아 둔 배열을 그대로 넘기고(같은 걸 두 번 받지 않는다),
        다른 봉이나 다른 거래소를 보고 있으면 넘기지 않아 판독 줄이 일봉을 따로 받는다.
      */}
      {showInsights && (
        <ChartInsights
          code={code}
          candles={period === "day" && venue === "krx" && !loading ? candles : undefined}
        />
      )}
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
            candles={candles}
            intraday={isIntraday}
            height={chartHeight}
            name={name ? `${name} · ${VENUES.find((v) => v.key === venue)?.label}` : undefined}
            code={code}
          />
        </div>
      )}
    </>
  );

  if (full) {
    return (
      <>
        {/* 원래 자리에는 빈 자국을 남긴다 — 안 그러면 닫을 때 화면이 튄다 */}
        <div className="chart-placeholder">크게 보는 중…</div>
        <div className={`chart-full${compact ? " compact" : ""}`} ref={hostRef}>
          {!compact && (
            <div className="chart-full-head">
              <span className="chart-full-name">
                {name ?? code}
                <span className="pt-n"> {code}</span>
              </span>
              <span className="pt-n chart-full-hint">
                가로로 돌리면 더 넓게 봅니다 · ESC 로 닫기
              </span>
            </div>
          )}
          {body}
        </div>
      </>
    );
  }

  return <div ref={hostRef}>{body}</div>;
}
