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
 * 괄호에 무엇을 넣을 것인가.
 *
 * 괄호는 **「지금 도는 다른 세션」**이다. 미국 종목은 하루에 세 판이 돌기 때문에
 * 「현재가」 하나로는 어느 판의 값인지 알 수가 없다.
 *
 *   정규장 중        괄호 없음 — 지금 값이 곧 정규장 값이다
 *   정규장 마감 후   **애프터장** (미 동부 16:00~20:00)
 *   한국 낮          **주간거래** (오버나이트 세션)
 *
 * 애프터장이 먼저다. 마감 직후에는 애프터장이 돌고 주간거래는 아직 안 열렸는데,
 * 그때 주간거래 자리에 남아 있는 건 **어제 값**이라 보여주면 거짓말이 된다.
 */
export interface SessionQuote {
  afterPrice: number | null;
  afterChangeRate: number | null;
  dayPrice: number | null;
  dayChangeRate: number | null;
  dayVolume: number | null;
}

export interface SideQuote {
  label: string;
  price: number;
  changeRate: number | null;
}

/**
 * 지금이 정규장 **앞**인가 뒤인가 — 시간외 값에 붙일 이름을 정한다.
 *
 * ⚠️ 시간외 가격은 한 칸(`afterPrice`)으로 오는데 그걸 늘 「애프터장」이라 불렀다.
 * 한국 저녁 아홉 시(미 동부 오전 여덟 시)는 **프리장**이다 — 그 시각에 「애프터장」이
 * 뜨면 어제 장이 아직 안 끝난 줄 알게 된다. 실제로 스물한 시 이십삼 분 화면에
 * 애프터장이라 적혀 있었다.
 *
 *   04:00~09:30 ET  프리장
 *   09:30~16:00 ET  정규장 (여기선 괄호를 안 쓴다)
 *   16:00~20:00 ET  애프터장
 *   20:00~04:00 ET  주간거래 — 한국 낮에 도는 오버나이트 세션
 */
function afterHoursName(now = new Date()): string {
  const { mins } = etNow(now);
  return mins < 9 * 60 + 30 ? "프리장" : "애프터장";
}

export function sideQuote(row: SessionQuote, now = new Date()): SideQuote | null {
  // 정규장이 열려 있으면 괄호를 띄우지 않는다 — 가격이 두 개면 어느 쪽이 지금 값인지 헷갈린다
  if (usRegularOpen(now)) return null;

  if (row.afterPrice !== null) {
    return { label: afterHoursName(now), price: row.afterPrice, changeRate: row.afterChangeRate };
  }
  /*
   * 주간거래는 **거래가 실제로 있을 때만.**
   * 거래량 0 은 아직 아무도 안 샀다는 뜻이라 가격이 있어도 정규장 종가 그대로다.
   */
  if (row.dayPrice !== null && row.dayVolume) {
    return { label: "주간거래", price: row.dayPrice, changeRate: row.dayChangeRate };
  }
  return null;
}

/**
 * **지금 값** — 어느 세션이 살아 있든 그것으로 친다.
 *
 * `sideQuote` 는 「괄호에 뭘 넣을까」였고, 이건 「대표로 뭘 보여줄까」다.
 * 관심종목 목록은 정규장 종가 옆에 괄호를 붙여 둘이 다 보이지만,
 * **MAP 타일이나 구성종목 표는 숫자를 하나만 보여준다.** 거기서 정규장 종가만
 * 그리면 애프터장에 3% 오른 종목이 「−0.3%」로 남는다 — 실제로 그랬다.
 *
 * 우선순위는 `sideQuote` 와 같다: 정규장 중이면 정규장, 아니면 애프터장,
 * 그것도 없으면 거래가 있는 주간거래. 셋 다 아니면 마지막 정규장 값이다.
 */
export function liveQuote(
  row: SessionQuote & { price: number | null; changeRate: number | null },
  now = new Date(),
): { price: number | null; changeRate: number | null; label: string } {
  const side = sideQuote(row, now);
  if (!side) return { price: row.price, changeRate: row.changeRate, label: "정규장" };

  /*
   * ⚠️ **시간외 변동률을 그대로 쓰면 안 된다.**
   *
   * 시간외 등락률은 **정규장 종가 대비**다. 정규장 등락률은 **전일 종가 대비**다.
   * 기준이 다른 두 값을 같은 칸에 번갈아 넣고 있었다 — 엔비디아가 표에서는 −0.98%,
   * MAP 타일에서는 −0.05% 로 떴다. 둘 다 맞는 계산인데 한 화면에 같이 있으니
   * 어느 쪽이 진짜인지 알 수가 없다.
   *
   * 타일은 숫자를 하나만 보여주므로 **전일 종가 대비 지금 값**이라야 말이 된다.
   * 전일 종가를 정규장 값에서 되짚어 시간외 가격과 견준다.
   *
   *   전일 종가 = 정규장 가격 ÷ (1 + 정규장 등락률/100)
   *
   * 되짚을 재료가 없으면(등락률이 없거나 −100%) 시간외 변동률을 그대로 둔다 —
   * 없는 값을 지어내느니 기준이 다른 값이라도 있는 게 낫다.
   */
  const base =
    row.price !== null && row.changeRate !== null && 1 + row.changeRate / 100 !== 0
      ? row.price / (1 + row.changeRate / 100)
      : null;
  const rate = base !== null && base > 0 ? (side.price / base - 1) * 100 : side.changeRate;
  return { price: side.price, changeRate: rate, label: side.label };
}
