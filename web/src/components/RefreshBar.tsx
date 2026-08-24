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
  auto,
}: {
  onRefresh: () => void;
  loading?: boolean;
  /** 갱신 시각 (없으면 버튼만 표시) */
  updatedAt?: number | Date | null;
  /** 좌측에 추가로 넣을 요소 (필터 등) */
  children?: React.ReactNode;
  /**
   * **스스로 갱신하는 화면**이면 그 스위치를 여기 붙인다.
   *
   * 새로고침 버튼 옆이 맞는 자리다 — 「이 값이 언제 바뀌나」를 묻는 사람이 보는 곳이
   * 거기이기 때문이다. 자동이 도는 중이면 버튼을 굳이 누를 이유도 없어진다.
   */
  auto?: { on: boolean; toggle: () => void; marketOpen: boolean };
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
      {auto && (
        <button
          className={`refresh-auto${auto.on ? " on" : ""}`}
          onClick={auto.toggle}
          title={
            auto.on
              ? auto.marketOpen
                ? "장중에는 스스로 다시 받습니다 — 눌러서 끄기"
                : "켜져 있지만 장이 닫혀 쉬는 중입니다"
              : "스스로 다시 받게 하기"
          }
        >
          {auto.on ? (auto.marketOpen ? "⟳ 자동" : "⟳ 자동(대기)") : "⟳ 자동 꺼짐"}
        </button>
      )}
      <button className="refresh-btn" onClick={onRefresh} disabled={loading} title="데이터만 다시 불러옵니다">
        {loading ? "갱신 중…" : "↻ 새로고침"}
      </button>
    </div>
  );
}
