import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SectionResult } from "./api";
import { useTabActive } from "./tabActive";

/**
 * 시황 섹션 하나를 조회하고 주기적으로 갱신한다.
 * 실제 키움·야후 호출량은 **서버 캐시가 통제**하므로, 여기서는 그 캐시만 폴링한다.
 * 섹션마다 독립적으로 로딩·에러를 관리해서 한 섹션 실패가 다른 섹션을 막지 않는다.
 *
 * ## 깜빡임을 없앤 방법
 *
 * 예전엔 **폴링할 때마다** `setLoading(true)` 를 했다. 카드가 그때마다 내용을
 * 스켈레톤으로 갈아치우니 주기마다 화면이 번쩍였다 — 값을 읽는 중에 사라지면
 * 그게 곧 방해다.
 *
 * 이제 **첫 조회에만** 로딩을 띄운다. 그 뒤로는 값만 조용히 갈아끼운다.
 * 실패해도 화면의 기존 값을 지우지 않는다 — 한 번 못 받았다고 있던 숫자를
 * 없애는 건 안 보여주는 것보다 나쁘다.
 *
 * 보지 않는 탭에서는 멈춘다. 우리 서버를 두들기는 것도 서버가 외부를 부를 빌미가 된다.
 * 숨은 인앱 탭도 마찬가지다(2026-08-27) — 탭 상한이 없어지며 열린 페이지가 전부
 * 마운트된 채 살아서, 게이트가 없으면 열어 둔 탭 수만큼 폴링이 배가된다.
 */
/**
 * 시황 섹션 하나를 물어본다.
 *
 * ⚠️ **서버 캐시보다 빨리 물어봐야 소용없다** (2026-08-31 점검).
 *
 * 실측에서 여덟 섹션 중 **일곱**이 그랬다 — 화면은 20초마다 묻는데 서버는 60초마다만
 * 새 값을 만드니 **체감은 60초**고 요청만 세 배였다. 화면 코드에 20초라고 적혀 있어
 * 「왜 이렇게 느리지」의 원인이 됐다.
 *
 * 이제 서버가 응답에 제 주기(`ttlMs`)를 실어 준다. 여기서 **둘 중 느린 쪽**을 쓴다 —
 * 주기를 정하는 곳이 서버 한 곳으로 모이고, 화면은 짧게 적어도 헛돌지 않는다.
 * 화면이 일부러 **더 느리게** 두고 싶은 경우(뒤쪽 카드 등)는 그대로 존중한다.
 */
export function useSection<T>(name: string, intervalMs: number) {
  const [result, setResult] = useState<SectionResult<T> | null>(null);
  /** 서버가 알려준 제 주기 — 받기 전에는 화면이 적은 값을 쓴다 */
  const [serverTtl, setServerTtl] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const tabActive = useTabActive();
  /** 요청이 겹치지 않게 — 느린 응답이 쌓이면 순서가 뒤집힌다 */
  const inFlight = useRef(false);
  /** 값을 한 번이라도 받았나. 로딩 표시를 띄울지 정하는 기준 */
  const hasData = useRef(false);

  /** @param silent 로딩 표시를 건드리지 않는다 (주기 갱신) */
  const load = useCallback(
    async (silent = false) => {
      if (inFlight.current) return;
      inFlight.current = true;
      // 값이 이미 있으면 조용히 — 있는 걸 지우고 스켈레톤을 띄울 이유가 없다
      if (!silent && !hasData.current) setLoading(true);
      try {
        const res = await api.overviewSection<T>(name);
        if (cancelledRef.current) return;
        setResult(res);
        if (typeof res.ttlMs === "number" && res.ttlMs > 0) setServerTtl(res.ttlMs);
        hasData.current = res.data !== null;
        setError(res.error);
      } catch (err) {
        if (cancelledRef.current) return;
        // 주기 갱신이 한 번 실패했다고 화면의 기존 값을 지우지 않는다
        if (!hasData.current) setError(err instanceof Error ? err.message : "알 수 없는 오류");
      } finally {
        inFlight.current = false;
        if (!cancelledRef.current) setLoading(false);
      }
    },
    [name],
  );

  /* 섹션이 바뀔 때만 처음부터 — 탭을 오간 것 때문에 스켈레톤이 다시 뜨면 안 된다 */
  useEffect(() => {
    hasData.current = false;
  }, [load]);

  useEffect(() => {
    cancelledRef.current = false;
    // 숨은 인앱 탭은 첫 조회도 미룬다 — 탭을 여는 순간 이 effect 가 다시 돌며 받는다
    if (!tabActive) return;
    void load();

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      /* 서버 주기와 화면 주기 중 **느린 쪽** — 빨리 물어도 값이 안 바뀐다 */
      const every = Math.max(intervalMs, serverTtl);
      if (!timer) timer = setInterval(() => void load(true), every);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        // 돌아왔을 때 오래된 값을 그대로 두지 않는다
        void load(true);
        start();
      } else {
        stop();
      }
    };

    onVisible();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelledRef.current = true;
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [load, intervalMs, tabActive, serverTtl]);

  return {
    data: result?.data ?? null,
    updatedAt: result?.updatedAt ?? null,
    loading,
    error,
    /** 수동 새로고침 — 페이지의 새로고침 버튼에서 호출 */
    refresh: () => void load(),
  };
}
