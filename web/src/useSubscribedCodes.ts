import { useEffect, useRef, useState } from "react";

/**
 * **지금 소켓에 붙어 있는 종목** (2026-10-21).
 *
 * 벤티지: "화면에 고정하고 있는데도 소켓이 안 붙는 종목들이 보이네."
 *
 * 그런데 초록불의 판정은 「소켓에 붙었나」가 아니라 **「90초 안에 틱이 왔나」**였다.
 * 그래서 조용한 종목 — 프리마켓의 에코아이는 거래량 594주·거래대금 0억이었다 — 은
 * **붙어 있어도 주황**으로 보인다. 「안 붙음」과 구별이 안 되니 고장처럼 읽힌다.
 *
 * 서버가 구독 목록을 그대로 알려 주므로(`GET /api/realtime/subscribed`) 둘을 가른다:
 *
 *   초록 ●  붙었고 **틱도 온다**
 *   초록 ○  붙었는데 **아직 조용하다** — 거래가 없는 것이지 고장이 아니다
 *   (없음)  안 붙었다 — 값은 폴링으로 온다
 *
 * ⚠️ 20초마다 받는다. 구독은 스케줄러(5분)와 화면(스크롤)이 바꾸므로 그보다 자주
 * 물을 이유가 없고, 이 목록 자체는 값이 아니라 **상태**다.
 */
const REFRESH_MS = 20_000;

export function useSubscribedCodes(on = true): Set<string> {
  const [codes, setCodes] = useState<Set<string>>(() => new Set());
  const dead = useRef(false);

  useEffect(() => {
    if (!on) {
      setCodes(new Set());
      return;
    }
    dead.current = false;
    const pull = () => {
      if (document.visibilityState !== "visible") return;
      fetch("/api/realtime/subscribed")
        .then((r) => r.json() as Promise<{ codes?: string[] }>)
        .then((j) => {
          if (dead.current) return;
          setCodes(new Set(j.codes ?? []));
        })
        .catch(() => undefined);
    };
    pull();
    const t = setInterval(pull, REFRESH_MS);
    return () => {
      dead.current = true;
      clearInterval(t);
    };
  }, [on]);

  return codes;
}
