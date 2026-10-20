import { useEffect, useRef } from "react";

/**
 * **지금 화면에 보이는 종목을 서버에 알린다** (2026-10-21).
 *
 * 벤티지: "거래대금 상위 130은 고정을 하고 … 남은 걸로 내 다른 탭 이동하잖아. 그럼
 * 거기서 내 화면에 보이는 애들, 걔네를 실시간으로 붙이는 거야. 그러면 내가 스크롤
 * 내리면은 쭈르르르 새로 붙겠지."
 *
 * 서버는 받은 종목을 `transient` 로 건다 — 정원이 차면 **오래 본 것부터** 밀려나고
 * 스케줄러 몫(거래대금 상위·조회순위)은 안 다친다. 그래서 **뗄 필요가 없다.**
 *
 * ## 왜 스크롤이 멈춘 뒤에 보내나
 *
 * 스크롤 중에 매번 보내면 1초에 수십 건의 REG/REMOVE 가 나가 키움 제한(105110)에
 * 걸린다. 그리고 **지나가는 줄**은 어차피 볼 게 아니다. 멈춘 뒤 0.4초에 한 번만
 * 보낸다(벤티지가 고른 값) — 멈춰 선 곳만 문다.
 *
 * ## 쓰는 법
 *
 *     const viewRef = useViewingCodes();
 *     <tr ref={viewRef(r.code)} …>
 *
 * 줄마다 `ref` 를 달면 그 줄이 화면에 들어오고 나가는 것을 `IntersectionObserver`
 * 가 알아서 본다. 스크롤 이벤트를 듣지 않으므로 긴 표에서도 비용이 거의 없다.
 */
const DEBOUNCE_MS = 400;

export function useViewingCodes(): (code: string) => (el: HTMLElement | null) => void {
  /** 지금 화면에 걸쳐 있는 종목 */
  const visible = useRef(new Set<string>());
  /** 요소 → 종목코드. 관찰이 풀릴 때 어느 코드였는지 알아야 한다 */
  const codeOf = useRef(new WeakMap<Element, string>());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const observer = useRef<IntersectionObserver | null>(null);
  /** 직전에 보낸 묶음 — 같은 것을 또 보내지 않는다 */
  const sent = useRef("");

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const flush = () => {
      const codes = [...visible.current];
      if (codes.length === 0) return;
      const key = codes.slice().sort().join(",");
      /* 스크롤이 제자리로 돌아오면 같은 묶음이 된다 — 그때는 안 보낸다 */
      if (key === sent.current) return;
      sent.current = key;
      void fetch("/api/realtime/viewing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ codes }),
      }).catch(() => undefined);
    };
    observer.current = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const code = codeOf.current.get(e.target);
          if (!code) continue;
          if (e.isIntersecting) visible.current.add(code);
          else visible.current.delete(code);
        }
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(flush, DEBOUNCE_MS);
      },
      /* 화면 위아래로 한 뼘(120px) 더 — 스크롤하면 **닿기 전에** 붙어 있다 */
      { rootMargin: "120px 0px" },
    );
    return () => {
      observer.current?.disconnect();
      observer.current = null;
      if (timer.current) clearTimeout(timer.current);
      visible.current.clear();
      sent.current = "";
    };
  }, []);

  /*
   * 줄마다 돌려주는 ref 콜백. **같은 코드에 같은 함수를 돌려주지 않아도 된다** —
   * React 는 ref 가 바뀌면 옛 것을 `null` 로 한 번 부르므로 거기서 관찰을 푼다.
   */
  return (code: string) => (el: HTMLElement | null) => {
    const ob = observer.current;
    if (!ob || !el) return;
    codeOf.current.set(el, code);
    ob.observe(el);
  };
}
