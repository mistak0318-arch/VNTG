import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/**
 * **차트 크게 보기** — 오버레이 + Fullscreen API (2026-11-12에 `ChartPanel` 에서 뽑아냄).
 *
 * 벤티지: "우리 지수 볼때 차트 크게 보는 기능이 빠져있더라고. 고치자"
 *
 * 종목 상세(`ChartPanel`)에만 있었다. 지수·야후·야간선물 시트는 `CandleChart` 를 **직접**
 * 쓰느라 이 기능을 못 받았다 — 같은 캔들차트인데 코스피를 크게 볼 길만 없었던 셈이다.
 *
 * 복사해 붙이는 대신 **로직만 뽑았다.** 두 벌로 두면 언젠가 갈라지고, 그때마다 어느 쪽이
 * 맞는지 사람이 판정해야 한다(이 코드베이스가 되풀이해 겪은 일이다). JSX 는 자리마다
 * 달라서 각자 들고, 움직이는 부분은 여기 하나다.
 *
 * ## 왜 오버레이와 Fullscreen 을 둘 다 쓰나
 *
 * 오버레이만으로도 브라우저 안은 꽉 차지만 주소창·탭이 남고, Fullscreen API 는 그걸
 * 없애 준다. 그런데 **iOS 사파리는 video 가 아닌 요소에 이걸 안 준다.** 그래서
 * 오버레이가 본체고 Fullscreen 은 **되면 얹는 것**이다. 가로 고정(`orientation.lock`)도
 * 같다 — 안드로이드 크롬에서만 되고 iOS 는 무시한다. 셋 다 실패해도 오버레이는 남으므로
 * 어디서든 크게는 보인다.
 *
 * ## 쓰는 법
 *
 *   const fs = useChartFullscreen();
 *   <button onClick={fs.enterFull}>⤢ 크게</button>
 *   <div className={fs.full ? "chart-full" : undefined} ref={fs.hostRef}>
 *     <div className="chart-wrap" ref={fs.wrapRef}>
 *       <CandleChart height={fs.chartHeight(기본높이)} … />
 *
 * `hostRef` 가 전체화면이 될 요소, `wrapRef` 가 차트 높이를 **실제로 재는** 칸이다.
 */

/** 눕힌 폰 — 이보다 낮으면 머리줄을 접어 그만큼을 차트에 준다 */
const COMPACT_VH = 500;
/** 아직 못 쟀을 때만 쓰는 어림값 — 한 프레임 뒤 실제 값으로 바뀐다 */
const CHROME_PX = 108;
const CHROME_PX_COMPACT = 62;

export interface ChartFullscreen {
  full: boolean;
  /** 눕힌 폰처럼 낮은 화면인가 — 머리줄을 접을지 판단 */
  compact: boolean;
  enterFull: () => void;
  exitFull: () => void;
  /** 전체화면이 될 요소 */
  hostRef: RefObject<HTMLDivElement>;
  /** 차트를 담는 칸 — 여기 높이를 재서 차트에 준다 */
  wrapRef: RefObject<HTMLDivElement>;
  /** 크게 보는 중이면 잰 높이, 아니면 평소 높이 */
  chartHeight: (normal: number) => number;
}

export function useChartFullscreen(): ChartFullscreen {
  const [full, setFull] = useState(false);
  const [vh, setVh] = useState(() => (typeof window === "undefined" ? 800 : window.innerHeight));
  const hostRef = useRef<HTMLDivElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [wrapH, setWrapH] = useState(0);

  const exitFull = useCallback(() => {
    /* 실패해도 오버레이는 닫아야 한다 — 안 그러면 빠져나올 방법이 없어진다 */
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
   * 화면에는 아무것도 안 나온다(실제로 「크게 보는 중…」만 뜨고 까매졌다).
   * 그래서 상태만 켜고, 실제 요청은 아래 effect 가 **다시 그린 뒤에** 한다.
   */
  const enterFull = useCallback(() => setFull(true), []);

  useEffect(() => {
    if (!full) return;
    const el = hostRef.current;
    if (!el) return;
    void (async () => {
      try {
        await el.requestFullscreen?.();
      } catch {
        /* iOS 사파리는 video 가 아니면 안 준다. 오버레이만으로도 화면은 꽉 찬다 */
      }
      try {
        await (screen.orientation as { lock?: (o: string) => Promise<void> } | undefined)?.lock?.("landscape");
      } catch {
        /* 안드로이드 크롬에서만 된다. 안 되면 사용자가 폰을 돌리면 그만이다 */
      }
    })();
  }, [full]);

  /* 화면 크기·방향이 바뀌면 높이를 다시 잰다 */
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
   * 이걸 안 하면 전체화면만 풀리고 **오버레이가 남아 화면이 잠긴 것처럼** 보인다.
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

  /* 오버레이가 떠 있는 동안 뒤 화면이 스크롤되면 안 된다 */
  useEffect(() => {
    if (!full) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [full]);

  const compact = full && vh < COMPACT_VH;

  /*
   * ⚠️ 전체화면 높이를 **어림하지 않고 실제로 잰다.**
   *
   * 예전엔 `창 높이 − 도구줄 어림값(108px)` 이었다. 두 가지가 틀어졌다.
   *   · 전체화면에 들어가면 주소창이 사라져 창 높이가 **그 순간** 바뀐다. `resize` 가
   *     늦게 오면 옛 높이로 계산한 차트가 그려진다.
   *   · 도구줄이 실제 몇 픽셀인지는 글꼴 크기 설정에 따라 다르다. 108 은 어림이다.
   *
   * 그래서 눕힌 폰(844×390)에서 차트가 649px 로 잡혀 창보다 커졌고, 남는 자리가 없으니
   * 위의 도구줄이 8px 로 짓눌렸다. 칸의 높이를 그대로 쓴다 — 칸 크기는 CSS 가 flex 로
   * 정하므로 차트가 커진다고 칸이 커지지 않는다(순환이 안 생긴다).
   */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !full) return;
    /*
     * **안쪽 여백은 빼고 준다.** `clientHeight` 는 패딩을 포함하는데 차트가 쓸 수 있는
     * 자리는 그 안쪽이다. 넘치면 `.chart-wrap` 이 그대로 자른다.
     */
    const measure = () => {
      const cs = getComputedStyle(el);
      const pad = parseFloat(cs.paddingTop || "0") + parseFloat(cs.paddingBottom || "0");
      setWrapH(Math.max(0, el.clientHeight - pad));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [full, compact]);

  const chartHeight = useCallback(
    (normal: number) =>
      full
        ? Math.max(200, wrapH > 0 ? wrapH : vh - (compact ? CHROME_PX_COMPACT : CHROME_PX))
        : Math.max(140, normal),
    [full, wrapH, vh, compact],
  );

  return { full, compact, enterFull, exitFull, hostRef, wrapRef, chartHeight };
}
