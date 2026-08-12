import { useEffect, useState } from "react";

/**
 * 페이지 공통 새로고침 바.
 *
 * 브라우저 새로고침(F5)은 화면 전체를 다시 그리므로, 여기서는 데이터만 다시 불러온다.
 * 마지막 갱신 시각을 함께 보여줘서 지금 보고 있는 값이 언제 것인지 알 수 있게 한다.
 */
export function RefreshBar({
  onRefresh,
  loading,
  updatedAt,
  children,
}: {
  onRefresh: () => void;
  loading?: boolean;
  /** 갱신 시각 (없으면 버튼만 표시) */
  updatedAt?: number | Date | null;
  /** 좌측에 추가로 넣을 요소 (필터 등) */
  children?: React.ReactNode;
}) {
  // 상대 시간을 살아있게 보여주기 위해 주기적으로 다시 그린다
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((v) => v + 1), 30_000);
    return () => clearInterval(timer);
  }, []);

  const at = updatedAt instanceof Date ? updatedAt.getTime() : updatedAt ?? null;
  const label = at ? new Date(at).toLocaleTimeString("ko-KR", { hour12: false }) : null;

  return (
    <div className="refresh-bar">
      <div className="refresh-bar-left">{children}</div>
      {label && <span className="refresh-at">{label} 기준</span>}
      <button className="refresh-btn" onClick={onRefresh} disabled={loading} title="데이터만 다시 불러옵니다">
        {loading ? "갱신 중…" : "↻ 새로고침"}
      </button>
    </div>
  );
}
