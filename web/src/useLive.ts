import { useEffect, useRef, useState } from "react";
import { api } from "./api";

/**
 * 조용한 백그라운드 갱신.
 *
 * 윈도우 HTS처럼 화면 앞에서는 아무 일도 없는 듯이 값만 바뀌어야 한다.
 * 기존 `useSection` 은 갱신할 때마다 `loading = true` 로 만들어 **화면이 깜빡였다.**
 * 여기서는 첫 조회만 로딩을 띄우고, 이후 갱신은 조용히 값만 갈아끼운다.
 *
 * 돌지 말아야 할 때는 확실히 멈춘다:
 *   - **장이 안 열렸을 때** — 값이 안 바뀌는데 부를 이유가 없다 (초당 5회 제한도 아껴야 한다)
 *   - **탭이 백그라운드일 때** — 보지도 않는 화면 때문에 호출이 나가면 안 된다
 *   - 이전 요청이 아직 안 끝났을 때 — 느린 응답이 쌓이면 순서가 뒤집힌다
 */

/**
 * **지금 체결이 도는가.** 1분마다 확인한다.
 *
 * 예전엔 정규장(`state === "open"`)만 봤다. 그런데 넥스트레이드가 08:00~09:00 과
 * 15:30~20:00 에도 도는데, 그 시간엔 폴링이 아예 안 걸려서 **종목 창이 멈춰 있었다.**
 * 서버가 주는 `live` 는 NXT 시간외를 포함한다.
 */
export function useMarketOpen(): boolean {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      api
        .marketStatus()
        // 옛 서버는 live 를 안 준다 — 그때는 예전처럼 정규장만 본다
        .then((s) => !cancelled && setOpen(s.live ?? s.state === "open"))
        .catch(() => undefined); // 상태를 못 받으면 폴링하지 않는 쪽(false 유지)이 안전하다
    };
    check();
    const timer = setInterval(check, 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return open;
}

export interface LiveResult<T> {
  data: T | null;
  /** 첫 조회 중일 때만 true. 백그라운드 갱신 중에는 false를 유지한다 */
  loading: boolean;
  error: string | null;
  /** 마지막으로 값이 갱신된 시각 */
  updatedAt: number | null;
  refresh: () => void;
}

/**
 * @param fetcher 값을 가져오는 함수. 참조가 매 렌더 바뀌어도 되도록 ref 로 잡는다.
 * @param deps    이 값들이 바뀌면 처음부터 다시 조회한다 (종목이 바뀐 경우 등)
 * @param intervalMs 갱신 주기. 장중에만 돈다.
 */
export function useLive<T>(
  fetcher: () => Promise<T>,
  deps: unknown[],
  intervalMs = 5000,
): LiveResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const marketOpen = useMarketOpen();
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  /** 요청이 겹치지 않게 — 응답이 느린 날 순서가 뒤집히는 걸 막는다 */
  const inFlight = useRef(false);
  const cancelled = useRef(false);

  /** @param silent true면 로딩 표시를 건드리지 않는다 (백그라운드 갱신) */
  const run = useRef(async (silent: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (!silent) setLoading(true);
    try {
      const next = await fetcherRef.current();
      if (cancelled.current) return;
      setData(next);
      setUpdatedAt(Date.now());
      setError(null);
    } catch (err) {
      if (cancelled.current) return;
      // 백그라운드 갱신이 한 번 실패했다고 화면의 기존 값을 지우지는 않는다
      if (!silent) setError(err instanceof Error ? err.message : "조회 실패");
    } finally {
      inFlight.current = false;
      if (!cancelled.current && !silent) setLoading(false);
    }
  });

  // 대상이 바뀌면 처음부터
  useEffect(() => {
    cancelled.current = false;
    setLoading(true);
    setData(null);
    void run.current(false);
    return () => {
      cancelled.current = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  // 장중 + 탭이 보일 때만 주기 갱신
  useEffect(() => {
    if (!marketOpen || intervalMs <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => void run.current(true), intervalMs);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        // 돌아왔을 때 오래된 값을 그대로 두지 않는다
        void run.current(true);
        start();
      } else {
        stop();
      }
    };

    onVisible();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [marketOpen, intervalMs]);

  return { data, loading, error, updatedAt, refresh: () => void run.current(false) };
}
