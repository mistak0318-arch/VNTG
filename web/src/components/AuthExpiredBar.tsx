import { useEffect, useState } from "react";
import { clearAuthExpired, onAuthExpired } from "../authGuard";

/**
 * 인증이 끊겼다고 알리는 띠.
 *
 * ## 왜 크게 띄우나
 *
 * 이건 한 화면의 문제가 아니라 **앱 전체가 값을 못 받는 상태**다.
 * 카드 하나에 작게 적으면 다른 화면으로 옮겼을 때 사라져서, 옮긴 곳에서는 또
 * 「왜 비어 있지」가 된다. 실제로 보드에서 칸 절반이 빈 채로 한참을 헤맸다.
 *
 * ## 새로고침이 답인 이유
 *
 * Cloudflare Access 는 **문서를 다시 요청할 때** 로그인 화면을 태워 준다.
 * 화면 안에서 나가는 요청은 아무리 다시 보내도 리다이렉트에서 막힐 뿐이라,
 * 자동으로 되살릴 방법이 없다 — 사람이 한 번 눌러 줘야 한다.
 */
export function AuthExpiredBar() {
  const [on, setOn] = useState(false);

  useEffect(() => onAuthExpired(setOn), []);

  if (!on) return null;

  return (
    <div className="auth-bar" role="alert">
      <span>
        <b>인증이 만료됐습니다.</b> 화면이 비거나 값이 안 바뀝니다 — 새로고침하면 다시
        로그인됩니다.
      </span>
      <span className="auth-bar-btns">
        <button className="primary-btn" onClick={() => window.location.reload()}>
          새로고침
        </button>
        {/* 집에서 쓸 때처럼 인증이 없는 자리에서 잘못 떴다면 닫을 수 있어야 한다 */}
        <button className="filter-btn" onClick={clearAuthExpired}>
          닫기
        </button>
      </span>
    </div>
  );
}
