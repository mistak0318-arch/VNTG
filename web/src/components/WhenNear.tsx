import { useEffect, useRef, useState, type ReactNode } from "react";

/**
 * **보일 때쯤 그린다** (2026-10-14).
 *
 * 벤티지: "지금 종목 상세 들어갈 때 로딩이 걸리는데 이유 좀 분석해 봐."
 *
 * 재 보니 서버는 결백했다 — 루프 지연 평균 30ms, 조회 대기 평균 126ms, 관문도 한가.
 * 느린 까닭은 **시트 하나를 여는 데 서로 다른 28개 요청이 한꺼번에 나가는 것**이다.
 * 브라우저는 한 출처에 여섯 개만 동시에 보내므로 다섯 줄로 줄을 서고, 하나하나는
 * 300~800ms 인데 마지막이 3초에 닿는다.
 *
 * 그런데 그 28개 중 **상당수는 열자마자 보이지도 않는다** — 차트·투자자 추이·프로그램·
 * 거래량 흐름은 한참 내려야 나온다. 안 보이는 것을 먼저 받느라 보이는 것이 기다리는 셈이다.
 *
 * 화면에 들어올 때쯤 그린다. 줄의 앞자리가 **지금 보고 있는 것**에게 돌아간다.
 *
 * ## 왜 「들어오면」이 아니라 「들어올 때쯤」인가
 *
 * `rootMargin` 을 넉넉히(한 화면 높이) 준다. 스크롤해서 눈에 닿은 **뒤에** 받기
 * 시작하면 빈칸을 보며 기다리게 되는데, 그건 지금보다 나쁜 경험이다. 한 화면 앞에서
 * 미리 받으면 내려갔을 때 이미 차 있다.
 *
 * ## ⚠️ 한 번 그리면 되돌리지 않는다
 *
 * 다시 올라갔다고 떼어 내면 내려올 때 또 받는다 — 요청을 줄이려다 늘리는 꼴이다.
 * `seen` 이 한 번 참이 되면 그대로 둔다.
 *
 * ## ⚠️ 자리는 미리 잡아 둔다
 *
 * 안 그린 동안 높이가 0 이면 **스크롤 막대가 춤춘다** — 내려가는 중에 아래 것이 그려지며
 * 길이가 늘면 보던 자리가 밀린다. `minHeight` 로 대강의 자리를 잡아 두면 그 일이 없다.
 * (정확할 필요는 없다. 0 만 아니면 된다.)
 */
export function WhenNear({
  children,
  minHeight = 160,
  onShow,
}: {
  children: ReactNode;
  minHeight?: number;
  /** 처음 보일 때 한 번 — 이 칸이 쓸 데이터를 그때 받으려고 (2026-10-14) */
  onShow?: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onShowRef = useRef(onShow);
  onShowRef.current = onShow;
  const [seen, setSeen] = useState(false);

  useEffect(() => {
    if (seen) return;
    const el = ref.current;
    if (!el) return;
    /* 옛 브라우저(또는 막힌 환경)면 그냥 다 그린다 — 안 보이는 것보다 느린 게 낫다 */
    if (typeof IntersectionObserver === "undefined") {
      setSeen(true);
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setSeen(true);
          onShowRef.current?.();
          io.disconnect();
        }
      },
      { rootMargin: "100% 0px" },
    );
    io.observe(el);
    /*
     * **안전망** (2026-10-14). 관찰자가 영영 안 울 수 있는 자리가 있다 — 창이 가려져
     * 있으면(`visibilityState: "hidden"`) 크롬은 교차 판정을 아예 안 돌린다. 실제로
     * 시험하다 겪었다: 칸이 화면 안에 들어왔는데도 안 그려졌고, 원인은 내 브라우저
     * 창이 뒤에 있던 것이었다.
     *
     * 그 자리에서 **빈칸으로 남는 것**은 지금보다 나쁘다. 3초가 지나면 그냥 그린다 —
     * 늦게 받는 것과 못 받는 것은 다르다. 이래도 **여는 순간의 몰림은 그대로 풀린다**,
     * 그게 이 장치의 목적이다.
     */
    const t = setTimeout(() => setSeen(true), 3000);
    return () => {
      io.disconnect();
      clearTimeout(t);
    };
  }, [seen]);

  return (
    <div ref={ref} className={seen ? "wn on" : "wn"} style={seen ? undefined : { minHeight }}>
      {seen ? children : null}
    </div>
  );
}
