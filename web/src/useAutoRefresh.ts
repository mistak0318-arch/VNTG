import { useEffect, useRef, useState } from "react";
import { setPref } from "./prefs";
import { useTabActive } from "./tabActive";
import { useMarketOpen } from "./useLive";

/**
 * 이미 있는 조회 함수를 **주기로 다시 부른다.**
 *
 * ## 왜 `useLive` 를 안 쓰나
 *
 * `useLive` 는 데이터를 자기가 들고 있다(`data`·`loading`·`error`). 그런데 관심종목이나
 * 거래상위 같은 화면은 **이미 자기 방식으로 상태를 들고 있고**, 그걸 갈아엎으려면 화면을
 * 통째로 다시 짜야 한다. 새로고침 버튼이 이미 있으니 **그 버튼을 대신 눌러 주는 것**이면
 * 충분하다 — 그게 이 훅이다.
 *
 * ## 언제 안 도는가
 *
 *   · **장이 안 열렸을 때** — 값이 안 바뀌는데 부를 이유가 없다(키움 초당 5회도 아껴야 한다)
 *   · **탭이 뒤에 있을 때** — 보지도 않는 화면 때문에 호출이 나가면 안 된다
 *   · 사람이 껐을 때 — 끈 것은 기억한다
 *
 * 셋 다 `useLive` 가 지키는 규칙과 같다. 다른 화면은 조용히 도는데 이 화면만 안 돌면
 * 「이 값은 언제 바뀌는 거지」를 매번 묻게 된다.
 */
export function useAutoRefresh(
  run: () => void,
  {
    intervalMs = 20_000,
    /** 끈 상태를 기억할 자리. 화면마다 다르게 두고 싶을 수 있다 */
    storeKey = "vntg.autoRefresh",
    /** 장이 닫혀도 도는가 — 해외처럼 우리 장 시간과 무관한 화면에서 쓴다 */
    ignoreMarket = false,
  }: { intervalMs?: number; storeKey?: string; ignoreMarket?: boolean } = {},
): { on: boolean; toggle: () => void; marketOpen: boolean } {
  const [on, setOn] = useState<boolean>(() => localStorage.getItem(storeKey) !== "0");
  const marketOpen = useMarketOpen();
  /* 숨은 인앱 탭에서는 안 돈다 (2026-08-27) — 탭 상한이 없어지며 열린 페이지가
     전부 마운트된 채 살아서, 게이트가 없으면 탭 수만큼 호출이 배가된다 */
  const tabActive = useTabActive();

  /* 최신 함수를 본다 — 타이머가 옛 클로저를 붙들면 옛 조건으로 조회한다 */
  const runRef = useRef(run);
  runRef.current = run;

  useEffect(() => {
    if (!on || !tabActive) return;
    if (!ignoreMarket && !marketOpen) return;

    const tick = () => {
      // 탭이 뒤에 있으면 건너뛴다. 돌아오면 다음 차례에 받는다
      if (document.visibilityState === "hidden") return;
      runRef.current();
    };
    const t = setInterval(tick, intervalMs);
    return () => clearInterval(t);
  }, [on, marketOpen, ignoreMarket, intervalMs, tabActive]);

  const toggle = () => {
    setOn((v) => {
      const next = !v;
      try {
        localStorage.setItem(storeKey, next ? "1" : "0");
        setPref(storeKey, next ? "1" : "0");
      } catch {
        /* 저장 못 해도 이번 세션에는 바뀐다 */
      }
      return next;
    });
  };

  return { on, toggle, marketOpen };
}
