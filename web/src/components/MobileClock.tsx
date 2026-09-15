import { useEffect, useState } from "react";
import { MarketHoursPopover } from "./MarketHoursPopover";

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
  /*
   * **날짜도 짧게** (2026-09-14 — 벤티지: "시간 바로 뒤에 바로 표시로 날짜만 간략하게").
   *
   * 「9/16」처럼 월/일만. 연도는 안 적는다 — 지금 이 화면을 보는 사람에게 연도는 정보가 아니고,
   * 자리만 먹으면 시각이 밀린다(폰 머리는 한 줄이다).
   *
   * 괄호로 묶고 **시각보다 조금 작게** 둔다 (2026-09-14, 벤티지가 눈으로 보고 고른 조합).
   * 구분선은 없애고 괄호로 — 괄호가 이미 「덧붙인 것」을 말한다.
   *
   * 시계와 **같은 KST 기준**으로 뽑는다. `getMonth()` 로 하면 기기 표준시가 KST 가 아닐 때
   * 시각은 한국인데 날짜는 현지가 되어 자정 언저리에 하루가 어긋난다.
   */
  const md = now.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric", timeZone: "Asia/Seoul" }).replace(/\.\s*/g, "/").replace(/\/$/, "");
  /* 누르면 장 시간표 (2026-09-16 — 벤티지: "시간 누르면 국내·미국 장 구분 시간 … 썸머타임 … 미니 팝업") */
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="mobile-clock mc-btn" onClick={() => setOpen((v) => !v)} title="기기 시계 (KST) · 누르면 장 시간표">
        <time dateTime={now.toISOString()}>
          {hh}
          <i className="mc-date">({md})</i>
        </time>
      </button>
      {open && <MarketHoursPopover onClose={() => setOpen(false)} />}
    </>
  );
}
