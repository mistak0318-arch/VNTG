import { useEffect, useState } from "react";

/**
 * 모바일 머리의 **시각** (2026-09-10 — 벤티지: "시간을 맨 위에 써줘 강조표시로").
 *
 * 폰에서는 화면이 멈춰 있어도 티가 안 난다 — 시각이 위에서 뛰고 있으면 「살아 있는 화면」인지
 * 한눈에 안다. 기기 시계를 KST 로 보여 준다(서버 시각이 아니다 — 서버가 죽어도 이건 뛴다).
 * PC 에서는 머리 자체가 안 보이므로(mobile-header) 여기만 그린다.
 */
export function MobileClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const hh = now.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false, timeZone: "Asia/Seoul" });
  return (
    <time className="mobile-clock" dateTime={now.toISOString()} title="기기 시계 (KST)">
      {hh}
    </time>
  );
}
