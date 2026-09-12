/**
 * **장 시간표 한 곳** — 2026-09-14 KRX 애프터마켓 개편 (2026-09-12).
 *
 * ## 왜 이 파일이 생겼나
 *
 * 시간표가 코드 서른 곳 넘게 상수로 박혀 있었다(`WATCH_TO 930`, `hm > 1530`, `15:30~20:00` 주석…).
 * 하나를 고치면 다른 곳이 어긋나고, 어긋난 것을 화면에서 알아볼 방법이 없다 — 「왜 이 종목만
 * 애프터 값이 섞였지」 같은 질문은 아무도 답을 못 한다. **판정은 여기서만 한다.**
 *
 * ## 무엇이 바뀌나 (키움 공지 + KRX 발표, 2026-09-11 벤티지가 문자를 붙여 줌)
 *
 *   09/13 까지          09/14 부터
 *   ─────────────────   ─────────────────────────────
 *   08:00~09:00  NXT 프리        (그대로)
 *   09:00~15:30  KRX 정규장      (그대로)
 *   15:30~20:00  NXT 애프터      15:30~16:00  **아무 시장도 안 연다**
 *   16:00~18:00  시간외단일가    16:00~20:00  **KRX 애프터마켓** (+ NXT 애프터)
 *                               시간외단일가 **폐지**
 *
 * - 애프터마켓 주문은 **지정가·최우선지정가·최유리지정가만**. 시장가·조건부·스톱은 없다.
 * - 정규장 미체결주문은 애프터마켓으로 **이전 불가**(취소 후 재주문).
 * - 가격제한폭은 정규장과 같은 전일 종가 대비 ±30%.
 *
 * ## ⚠️ 날짜로 가른다
 *
 * 오늘(9/12) 배포해도 **9/13 까지는 지금과 똑같이** 돌고 9/14 에 저절로 넘어간다. 개편 당일
 * 아침에 서둘러 배포하는 것이 제일 위험하다 — 장이 열린 뒤에 틀린 걸 알게 된다.
 *
 * 실제 경계(키움이 `0s` 장운영구분으로 알려 주는 코드)는 **9/14 에 관측해야** 확실해진다.
 * 그때까지는 발표된 시각을 쓰고, 관측이 쌓이면 `marketPhase.ts` 로 갈아탄다.
 */

/** 이 날부터 새 시간표 (KRX 애프터마켓 개장일) */
export const AFTER_MARKET_FROM = "2026-09-14";

/** 분 단위 시각 — 09:00 = 540 */
export const MIN = {
  nxtPreOpen: 480, // 08:00
  krxOrderFrom: 510, // 08:30 — KRX 주문 접수 시작(동시호가)
  regularOpen: 540, // 09:00
  closeAuction: 920, // 15:20 — 마감 동시호가 시작
  regularClose: 930, // 15:30
  afterOpen: 960, // 16:00 — KRX 애프터마켓 (9/14~)
  afterClose: 1200, // 20:00
} as const;

/** 그 날짜가 새 시간표인가 */
export function afterMarketEra(date: string): boolean {
  return date >= AFTER_MARKET_FROM;
}

/** 지금 국면 — 화면 배지·라벨이 쓰는 말과 같다 */
export type Session =
  | "장전" // 08:00 전
  | "프리" // NXT 프리 08:00~09:00
  | "정규장" // 09:00~15:30
  | "공백" // 15:30~16:00 (9/14~) — 어느 시장도 안 연다
  | "애프터" // NXT 애프터(~9/13) · KRX+NXT 애프터(9/14~)
  | "마감"; // 20:00 뒤

export function sessionOf(date: string, minute: number): Session {
  if (minute < MIN.nxtPreOpen) return "장전";
  if (minute < MIN.regularOpen) return "프리";
  if (minute <= MIN.regularClose) return "정규장";
  if (minute > MIN.afterClose) return "마감";
  /*
   * 9/13 까지는 15:30 직후부터 NXT 애프터가 이어 받는다. 9/14 부터는 30분이 빈다 —
   * **여기를 「거래 중」이라고 말하면 화면이 없는 시장을 있다고 한다.**
   */
  if (afterMarketEra(date) && minute < MIN.afterOpen) return "공백";
  return "애프터";
}

/** 지금 애프터마켓에 KRX 도 있나 (9/14~ 16:00~20:00) */
export function krxAfterMarket(date: string, minute: number): boolean {
  return afterMarketEra(date) && minute >= MIN.afterOpen && minute <= MIN.afterClose;
}

/** 체결이 도는 시간인가 — 폴링·감시를 켤지 정한다. 「공백」은 거짓 */
export function tradingNow(date: string, minute: number): boolean {
  const s = sessionOf(date, minute);
  return s === "프리" || s === "정규장" || s === "애프터";
}

/**
 * **애프터마켓이 받는 매매구분** — 지정가(0) · 최유리지정가(6) · 최우선지정가(7).
 *
 * 시장가(3) · 조건부지정가(5) · 스톱지정가(28) · IOC/FOK 는 **안 받는다.** 예전엔 시간대와
 * 매매구분을 맞춰 보는 코드가 아예 없어서, 16시 이후 시장가가 그대로 키움까지 나갔다.
 */
export const AFTER_TRADE_TYPES = new Set(["0", "6", "7"]);

export function tradeTypeAllowed(tradeType: string, date: string, minute: number): boolean {
  if (!krxAfterMarket(date, minute)) return true; // 정규장·프리는 예전 그대로
  return AFTER_TRADE_TYPES.has(tradeType);
}

/**
 * **애프터마켓에서 거래되는 종목인가** (2026-09-12 — 뉴시스 09-12 기사로 확인).
 *
 * 애프터마켓은 **2,700여 개 전 종목**이지만 **ETF·ETN 은 빠진다**(자산운용사·유동성공급자 부담).
 * 코넥스·관리·투자경고·초저유동성 종목도 제외다. NXT 애프터는 원래 우량주 600개뿐이었으니,
 * 9/14 에 넓어지는 것은 맞지만 **전부는 아니다.**
 *
 * ⚠️ 이게 왜 중요한가 — 감시가 발동해 주문을 냈는데 키움이 「거래 대상 아님」으로 거절하면
 * 그 감시는 `failed` 로 접힌다. **손절이 사라진다.** 그래서 내기 전에 여기서 거른다.
 *
 * 판정은 종목 목록의 `marketName` 으로 한다(캐시라 공짜다) — 「거래소」·「코스닥」만 애프터에
 * 나간다. 관리·투자경고·초저유동성은 여기서 못 가린다(상태 조회가 따로 필요하다) — 그건
 * 거절로 알게 되고, 매도 감시는 거절을 만나도 보류로 버틴다.
 */
export function afterMarketTradable(marketName: string | undefined | null): boolean {
  return marketName === "거래소" || marketName === "코스닥";
}

/**
 * **마감 뒤 정리를 몇 시에 시작하나.**
 *
 * 벤티지 (2026-09-10): "마감정리를 차라리 8시 10분에 진행하는 건 어때?"
 *
 * 9/13 까지는 15:40 그대로다. 9/14 부터 20:10 — 애프터마켓이 20:00 에 끝나야 그날 값이
 * 굳는다. 15:40 에 시작하면 일봉 단계(30~40분)의 꼬리가 16:00 을 넘어, **뒤쪽 종목만 애프터
 * 값이 섞인 일봉**이 된다. 같은 날 일봉에 기준이 둘인 것이 제일 나쁘다.
 */
export function cleanupStartMinute(date: string): number {
  return afterMarketEra(date) ? 1210 : 940;
}

/**
 * **「그날 종가」를 언제부터 믿을 수 있나.**
 *
 * 정규장 종가는 15:30 에 굳는다. 애프터마켓 종가는 20:00 이다. 둘 중 무엇을 쓸지는 아직
 * 안 정했다(벤티지 2026-09-12: "둘 다 쌓고 나중에 정한다") — 원장에 둘 다 적고, 화면·신호등은
 * 당분간 **정규장 종가**를 쓴다. 신호등 표본 29,570관측과 검증표가 전부 정규장 종가로 만들어져
 * 있어서, 지금 기준을 바꾸면 9/14 를 경계로 과거와 안 맞는다.
 */
export function regularCloseSettled(date: string, minute: number): boolean {
  return minute > MIN.regularClose;
}
export function dayFullySettled(date: string, minute: number): boolean {
  return afterMarketEra(date) ? minute > MIN.afterClose : minute > MIN.regularClose;
}
