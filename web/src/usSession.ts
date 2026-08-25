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
 * 키움 실시간(FE)이 흐를 수 있는 시간인가 — 프리 04:00 ~ 애프터 20:00 ET.
 *
 * 해외 관심종목 표가 이 시간에만 실시간을 묻는다. 낮(미국 마감)에 물으면
 * 답도 없는 구독이 화면 몫(10자리)을 채워 국내 화면 실시간을 밀어낸다.
 */
export function usFeActive(now = new Date()): boolean {
  const { day, mins } = etNow(now);
  if (day === 0 || day === 6) return false;
  return mins >= 4 * 60 && mins < 20 * 60;
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
 * 지금 도는 세션.
 *
 * ## ⚠️ 「값을 보고 이름을 붙이던」 것을 뒤집었다 (2026-08-25)
 *
 * 예전 코드는 **두 갈래**였다 — `mins < 09:30 ? "프리장" : "애프터장"`.
 * 그러면 **00:00~04:00 ET 가 「프리장」으로 떨어진다.** 그 시각은 한국 오후 1시~5시,
 * **주간거래** 시간이다. 프리장은 04:00 ET 부터다.
 *
 * 게다가 `sideQuote` 가 `afterPrice` 를 늘 먼저 봤다. 그래서 한국 낮에 **어제
 * 애프터장의 잔값**이 「프리장」이라는 이름표를 달고 떴다 — 값도 이름도 둘 다 틀린
 * 것이다. 세션은 **시계가 정하는 것**이지 어느 칸에 값이 들어 있느냐가 정할 일이 아니다.
 *
 * 그래서 **시각으로 세션을 먼저 정하고, 그 세션의 값을 고른다.**
 *
 *   04:00~09:30 ET  프리장      (한국 17:00~22:30)
 *   09:30~16:00 ET  정규장      (한국 22:30~05:00) — 괄호를 안 쓴다
 *   16:00~20:00 ET  애프터장    (한국 05:00~09:00)
 *   20:00~04:00 ET  주간거래    (한국 09:00~17:00) — 오버나이트 세션
 *
 * ⚠️ 한투 REST 는 **어느 세션인지 말해 주지 않는다.** 「애프터·프리마켓·세션」으로
 * 100개 필드를 훑어 0건이었다(장구분은 키움 실시간 `FE` 의 `290` 에만 있다).
 * 그래서 시계로 셀 수밖에 없고, **그 계산이 맞아야 한다.**
 */
type UsSession = "pre" | "regular" | "after" | "day";

function sessionAt(now = new Date()): UsSession {
  const { day, mins } = etNow(now);
  // 주말엔 어느 세션도 안 돈다. 화면에는 「직전」 값이 남으므로 주간거래 자리로 본다
  if (day === 0 || day === 6) return "day";
  if (mins >= 4 * 60 && mins < 9 * 60 + 30) return "pre";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
  if (mins >= 16 * 60 && mins < 20 * 60) return "after";
  return "day";
}

export function sideQuote(row: SessionQuote, now = new Date()): SideQuote | null {
  const session = sessionAt(now);

  // 정규장이 열려 있으면 괄호를 띄우지 않는다 — 가격이 두 개면 어느 쪽이 지금 값인지 헷갈린다
  if (session === "regular") return null;

  /*
   * 주간거래는 **거래가 실제로 있을 때만.**
   * 거래량 0 은 아직 아무도 안 샀다는 뜻이라 가격이 있어도 정규장 종가 그대로다.
   */
  const dayOk = row.dayPrice !== null && Boolean(row.dayVolume);

  if (session === "day") {
    if (dayOk) {
      return { label: "주간거래", price: row.dayPrice as number, changeRate: row.dayChangeRate };
    }
    /*
     * 주간거래가 아직 안 돌았다. 이때 `afterPrice` 에 남아 있는 건 **직전 애프터장의
     * 마지막 값**이다 — 지금 움직이는 값이 아니다. 숨기지 말고 **그렇다고 적는다.**
     */
    if (row.afterPrice !== null) {
      return {
        label: "직전 애프터장",
        price: row.afterPrice,
        changeRate: row.afterChangeRate,
      };
    }
    return null;
  }

  // 프리장·애프터장 — 시간외 값은 둘 다 같은 칸(`afterPrice`)으로 온다
  if (row.afterPrice !== null) {
    return {
      label: session === "pre" ? "프리장" : "애프터장",
      price: row.afterPrice,
      changeRate: row.afterChangeRate,
    };
  }
  // 그 칸이 비었는데 주간거래 값이 살아 있으면 그거라도 (이름은 정확히)
  if (dayOk) {
    return { label: "주간거래", price: row.dayPrice as number, changeRate: row.dayChangeRate };
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
