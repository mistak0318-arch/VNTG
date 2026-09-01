import { useEffect, useRef, useState } from "react";
import { useTabActive } from "./tabActive";

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
 * @param opts.readOnly **목록 오버레이 모드** (2026-08-25) — 구독을 안 걸고 이미 온
 *   값만 읽는다. 줄이 백 개인 표가 보통 모드로 물으면 임시구독이 정원을 짓밟는다.
 *   거래대금 상위·관심종목은 스케줄러가 이미 걸어 뒀으니 읽기만 하면 된다.
 *   키 상한도 40 → 120 으로 는다.
 */
/**
 * 국내 0B 오버레이를 **믿어도 되는 시간**인가 — KRX 정규장 언저리(08:59~15:35).
 *
 * (2026-08-26) NXT 프리장에 시세분석·관심종목이 ●(실시간 표시)를 켠 채 등락률
 * 0% 를 보여줬다 — KRX 는 아직 안 열렸으니 0 이 맞는데, 화면의 다른 값(통합)은
 * +1.3% 라 「왜 0이냐」가 된다. 이 시간 밖에서는 오버레이를 쓰지 말고
 * 본 시세(통합)를 그대로 두는 게 맞다.
 */
/**
 * 실시간 오버레이를 켤 시간인가.
 *
 * ⚠️ **NXT 시간외까지 포함한다** (2026-08-31 요청 「실시간도 NXT 도 동일하게」).
 *
 * 예전엔 08:59~15:35, **정규장만**이었다. 그런데 실시간 구독을 통합(`_AL`)으로
 * 바꾸면서 NXT 프리마켓(08:00~08:50)·애프터마켓(15:40~20:00) 체결도 들어온다 —
 * 실측으로 확인했다(08:42 프리마켓에서 `_AL` 프레임 도착).
 *
 * 값은 오는데 화면이 안 받으면 아무 소용이 없다. **슈퍼신호등 편입(15:45)과
 * 종가배팅이 애프터마켓 매수를 전제로 하므로**, 정작 살 수 있는 시간에 시세가
 * 멈춰 보이는 것이 제일 나빴다.
 *
 * 08:00 부터 여는 것은 NXT 프리마켓 시작 시각이다. 20:10 까지 두는 것은 애프터가
 * 20:00 에 끝나고 마지막 체결이 조금 늦게 들어오기 때문이다.
 */
/**
 * **KRX 정규장 안인가** — 09:00~15:30 (2026-09-01 신설).
 *
 * `krxOverlayLive` 와 헷갈리면 안 된다. 저쪽은 **실시간 오버레이를 켤 시간**이라
 * 08:00~20:10(프리·애프터 포함)이고, 이쪽은 **KRX 가 도는 시간**이다.
 *
 * ⚠️ 그 둘을 하나로 쓰다가 틀렸다. NXT 서브 줄이 `!krxOverlayLive()` 였는데,
 * 그러면 **08:00~20:10 내내 숨는다** — 프리·애프터까지. 주석에는 「프리·애프터·
 * 마감(NXT 가 그날의 주인공인 시간)엔 보여 준다」고 적혀 있었으니 **말과 코드가
 * 정반대**였다. 벤티지: "8시 지나서 장 마감했으면 NXT 장마감 시세를 보여줘야지
 * 왜 KRX 장마감 시세로 바뀌지?"
 */
export function krxRegularSession(now = new Date()): boolean {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return m >= 9 * 60 && m <= 15 * 60 + 30;
}

export function krxOverlayLive(now = new Date()): boolean {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  const day = kst.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = kst.getUTCHours() * 60 + kst.getUTCMinutes();
  return m >= 8 * 60 && m <= 20 * 60 + 10;
}

export function useRealtime(
  keys: string[],
  ms = 1500,
  opts?: { readOnly?: boolean },
): RealtimeState {
  const [state, setState] = useState<RealtimeState>(EMPTY);
  /*
   * 숨은 인앱 탭이면 키를 통째로 비운다 (2026-08-26) — 구독·폴링이 전부 멎는다.
   * 상태 보존을 위해 페이지를 언마운트하지 않으므로, 실시간만은 여기서 끊어야
   * 열린 탭 몇 개가 소켓 정원(화면 몫 20)을 짓밟지 않는다.
   */
  const tabActive = useTabActive();
  /*
   * 배열은 매 렌더 새 객체라 그대로 의존성에 넣으면 타이머가 계속 다시 걸린다.
   *
   * ⚠️ **정렬해서 잇는다** (2026-08-28). 여기서 중요한 건 「어떤 종목을 보는가」이지
   * 순서가 아니다. 그냥 이으면 **순위가 한 칸만 뒤바뀌어도 다른 문자열**이 되어
   * 이 훅이 통째로 다시 돌고, **열려 있던 SSE 를 끊고 새로 연다.**
   *
   * 시세분석은 순위를 10초마다 다시 받는다. 거래대금 상위는 그때마다 몇 자리씩
   * 자리를 바꾸므로 — 종목 구성은 그대로인데 — **10초마다 스트림이 끊겼다.**
   * 끊길 때마다 모아 둔 값(values)이 통째로 날아가고 재연결 동안 값이 안 온다.
   * 「시세 갱신이 느려졌다」의 정체가 이것이다.
   */
  const joined = tabActive ? [...keys].sort().join(",") : "";
  const readOnly = opts?.readOnly === true;
  /*
   * 끊겼다 다시 열릴 때 **직전 값에서 이어 그린다.** 종목 구성이 진짜로 바뀌어
   * 다시 열 때도, 남아 있던 종목의 값까지 지우면 표가 한 번 허옇게 된다.
   */
  const lastValues = useRef<Record<string, RealtimeValue | null>>({});
  lastValues.current = state.values ?? lastValues.current;

  useEffect(() => {
    if (!joined) {
      setState(EMPTY);
      return;
    }
    let alive = true;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let es: EventSource | null = null;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      try {
        const r = await fetch(
          `/api/realtime/latest?keys=${encodeURIComponent(joined)}${readOnly ? "&sub=0" : ""}`,
        );
        const j = (await r.json()) as RealtimeState;
        if (alive) setState(j);
      } catch {
        /* 끊겨도 화면은 그대로 둔다 — 마지막 값이 없는 것보다 낫다 */
      }
    };
    const startPolling = () => {
      if (pollTimer) return;
      void tick();
      pollTimer = setInterval(() => void tick(), ms);
    };

    /*
     * SSE 먼저 (2026-08-25) — 읽기 전용(목록 오버레이)은 서버가 틱 도착 즉시 민다.
     * 값의 나이가 폴링 주기(1.5초)에서 0.5초 아래로 준다. 스트림이 못 열리거나
     * 끊기면 **조용히 폴링으로 내려간다** — 화면은 차이를 모른다.
     * 이벤트는 200ms 로 모아서 한 번에 그린다 — 체결이 몰릴 때 키마다 리렌더하면
     * 백 줄 표가 초당 수십 번 그려진다.
     */
    if (readOnly && typeof EventSource !== "undefined") {
      // 직전 값에서 이어 간다 — 다시 여는 동안 표가 비지 않게
      const values: Record<string, RealtimeValue | null> = { ...lastValues.current };
      const flush = () => {
        flushTimer = null;
        if (alive) setState({ enabled: true, healthy: true, values: { ...values } });
      };
      es = new EventSource(`/api/realtime/stream?keys=${encodeURIComponent(joined)}`);
      es.onmessage = (e) => {
        try {
          const d = JSON.parse(e.data) as { key: string; at: number; values: Record<string, string> };
          values[d.key] = { at: d.at, values: d.values };
          if (!flushTimer) flushTimer = setTimeout(flush, 200);
        } catch {
          /* 깨진 이벤트 하나로 스트림을 접지 않는다 */
        }
      };
      es.onerror = () => {
        // 한 번 끊기면 이 마운트에서는 폴링으로 산다 — 재연결 곡예는 폴링이 이미 한다
        es?.close();
        es = null;
        if (alive) startPolling();
      };
    } else {
      startPolling();
    }

    return () => {
      alive = false;
      if (pollTimer) clearInterval(pollTimer);
      if (flushTimer) clearTimeout(flushTimer);
      es?.close();
    };
  }, [joined, ms, readOnly]);

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
