/**
 * 미국 장이 지금 어느 세션인가.
 *
 * 이걸 따로 둔 이유는 **주간거래 괄호를 언제 지울지** 한 곳에서 정하기 위해서다.
 *
 * 예전엔 주간거래 값이 있으면 늘 괄호로 붙여 놨다. 그런데 정규장이 열린 뒤에도
 * 그게 그대로 남아서, 화면에 **가격이 두 개** 보였다 — 하나는 지금 움직이는 값이고
 * 하나는 몇 시간 전에 끝난 세션의 마지막 값인데 생김새가 같으니 헷갈렸다.
 * 정규장이 열리면 최신 값은 정규장이다. 그때는 괄호를 지운다.
 */

/** 미 동부 시각으로 환산한 요일·분 */
function etNow(now = new Date()): { day: number; mins: number } {
  // 서머타임을 직접 세지 않는다 — 브라우저의 시간대 데이터가 대신 계산해 준다
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(f.formatToParts(now).map((p) => [p.type, p.value]));
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const day = days.indexOf(String(parts.weekday));
  // 자정이 "24" 로 오는 환경이 있다
  const hour = Number(parts.hour) % 24;
  return { day, mins: hour * 60 + Number(parts.minute) };
}

/**
 * 미국 정규장이 열려 있나 (평일 09:30~16:00 ET).
 *
 * 휴장일은 가리지 않는다. 휴장일이면 주간거래도 값이 안 들어와 괄호가 애초에 안 뜬다.
 */
export function usRegularOpen(now = new Date()): boolean {
  const { day, mins } = etNow(now);
  if (day === 0 || day === 6) return false;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/**
 * 주간거래 값을 지금 보여줄 것인가.
 *
 * 두 가지를 다 만족해야 한다.
 *   1. 정규장이 닫혀 있을 것 — 열려 있으면 최신 값은 정규장이다
 *   2. 그 세션에 **실제 거래가 있을 것** — 거래량 0 은 아직 아무도 안 샀다는 뜻이라
 *      가격이 있어도 믿을 값이 아니다
 */
export function showDayQuote(
  row: { dayPrice: number | null; dayVolume: number | null },
  now = new Date(),
): boolean {
  return row.dayPrice !== null && !!row.dayVolume && !usRegularOpen(now);
}
