import { useCallback, useEffect, useRef, useState } from "react";
import { api, type SectionResult } from "./api";

/**
 * 시황 섹션 하나를 조회하고 주기적으로 갱신한다.
 * 실제 키움 호출량은 서버 캐시가 통제하므로, 여기서는 캐시만 폴링한다.
 * 섹션마다 독립적으로 로딩/에러를 관리해서 한 섹션 실패가 다른 섹션을 막지 않는다.
 */
export function useSection<T>(name: string, intervalMs: number) {
  const [result, setResult] = useState<SectionResult<T> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.overviewSection<T>(name);
      if (cancelledRef.current) return;
      setResult(res);
      setError(res.error);
    } catch (err) {
      if (!cancelledRef.current) setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      if (!cancelledRef.current) setLoading(false);
    }
  }, [name]);

  useEffect(() => {
    cancelledRef.current = false;
    load();
    const timer = setInterval(load, intervalMs);
    return () => {
      cancelledRef.current = true;
      clearInterval(timer);
    };
  }, [load, intervalMs]);

  return {
    data: result?.data ?? null,
    updatedAt: result?.updatedAt ?? null,
    loading,
    error,
    /** 수동 새로고침 — 페이지의 새로고침 버튼에서 호출 */
    refresh: load,
  };
}
