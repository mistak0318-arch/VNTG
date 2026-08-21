import { useEffect, useState } from "react";

/**
 * 실시간 값을 읽는다 — **화면이 달라고 하면 서버가 알아서 구독한다.**
 *
 * ## 왜 폴링인가 (웹소켓인데)
 *
 * 웹소켓은 **서버와 키움 사이**에 있다. 브라우저와 서버 사이는 아직 REST 다.
 * 그래도 예전과 크게 다르다 — 예전엔 화면이 키움 TR 을 5~20초로 당겼고
 * 그 주기가 곧 값의 나이였다. 지금은 서버가 이미 최신값을 들고 있으므로,
 * 1~2초로 물어보면 **값의 나이도 1~2초**다. 키움 호출 횟수는 늘지 않는다.
 *
 * 브라우저까지 밀어주려면(SSE) 한 겹 더 얹어야 하는데, 그게 필요한지는
 * 이걸 써 보고 정하는 게 맞다.
 *
 * ## 여러 개를 한 번에 묻는다
 *
 * 칸마다 따로 물어보면 1초에 열 번이 나간다. 키를 모아 한 번에 보낸다.
 *
 * ## 죽으면 죽었다고 한다
 *
 * `healthy` 가 거짓이면 실시간을 믿으면 안 된다 — 화면은 평소 폴링으로 되돌리면 된다.
 * 붙어 있어도 오래 조용하면 거짓이 된다(끊긴 걸 모르는 게 제일 위험하다).
 */

export interface RealtimeValue {
  at: number;
  values: Record<string, string>;
}

export interface RealtimeState {
  enabled: boolean;
  healthy: boolean;
  values: Record<string, RealtimeValue | null>;
}

const EMPTY: RealtimeState = { enabled: false, healthy: false, values: {} };

/**
 * @param keys `["0F:005930", "0B:005930"]` 처럼 `TR:종목` 목록
 * @param ms   몇 밀리초마다 물어볼지. 기본 1.5초
 */
export function useRealtime(keys: string[], ms = 1500): RealtimeState {
  const [state, setState] = useState<RealtimeState>(EMPTY);
  // 배열은 매 렌더 새 객체라 그대로 의존성에 넣으면 타이머가 계속 다시 걸린다
  const joined = keys.join(",");

  useEffect(() => {
    if (!joined) {
      setState(EMPTY);
      return;
    }
    let alive = true;
    const tick = async () => {
      try {
        const r = await fetch(`/api/realtime/latest?keys=${encodeURIComponent(joined)}`);
        const j = (await r.json()) as RealtimeState;
        if (alive) setState(j);
      } catch {
        /* 끊겨도 화면은 그대로 둔다 — 마지막 값이 없는 것보다 낫다 */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), ms);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [joined, ms]);

  return state;
}

/** FID 를 숫자로. 부호가 붙어 오므로 그대로 파싱한다 */
export function fid(v: RealtimeValue | null | undefined, id: string): number | null {
  const raw = v?.values?.[id];
  if (raw === undefined) return null;
  const n = Number(String(raw).trim());
  return Number.isFinite(n) ? n : null;
}

/** FID 를 글자로 (거래원 이름 등) */
export function fidText(v: RealtimeValue | null | undefined, id: string): string {
  return String(v?.values?.[id] ?? "").trim();
}
