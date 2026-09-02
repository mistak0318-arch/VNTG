/**
 * 계좌 셋 — 성격이 서로 다르다.
 *
 * ## 왜 한 엔진에 규칙만 바꿔 끼우지 않나
 *
 * 연금 계좌는 **제도가 다르다.** 손절폭 같은 취향이 아니라 법으로 못 하는 것들이다:
 *
 *   - 연금 계좌에서는 **신용·미수를 쓸 수 없다.** 빌려서 사는 것 자체가 안 된다.
 *   - **레버리지·인버스 ETF 를 담을 수 없다** (연금저축·퇴직연금 공통).
 *   - 퇴직연금은 **위험자산 70% 한도**다. 나머지 30% 는 안전자산이어야 한다.
 *
 * 이걸 「설정값」으로 두면 언젠가 꺼진다. 계좌의 **성질**로 두고 코드가 막는다.
 *
 * ## 왜 개별종목이 아니라 ETF 인가
 *
 * 연금은 십 년 단위로 굴리는 돈이고, 그 자리에 단기 추세추종을 넣으면 세금 이연의
 * 이점을 매매비용으로 다 태운다. 여기서 시스가 하는 일은 **편입과 리밸런싱**이지
 * 트레이딩이 아니다 — 그래서 규칙도 판단 주기도 다르다.
 */

import type { CisRules } from "./cisTrader.js";

export type AccountId = "trade" | "close" | "pension" | "irp";

/**
 * 계좌의 **매매 방식**.
 *
 *   swing     — 하루 세 번 + 15분 루프로 사고, 손절·익절·기간으로 판다 (CIS 트레이딩)
 *   closeBet  — **종가배팅 전용** (2026-09-02 밤, 벤티지: "CIS 트레이딩(종배) 라는거 하나 더
 *               만들자. 얘는 신호등 결과 보고 상위 종목에 대해서 종배를 하는애야. 대신 종배할때
 *               해당 종목의 수급, 그리고 미국장 분위기(미국 선물, 금리, 유가 등), 시장 분위기를
 *               탐지하고 하는거지."). 저녁에만 사고 다음 날 시가에 판다. `cisCloseBet.ts`.
 */
export type TradeStyle = "swing" | "closeBet";

export interface AccountProfile {
  id: AccountId;
  name: string;
  /** 한 줄 설명 — 화면 머리에 그대로 쓴다 */
  hint: string;
  seed: number;
  /** ETF 만 담나 */
  etfOnly: boolean;
  allowMisu: boolean;
  allowCredit: boolean;
  /**
   * 위험자산 한도(%). 100 이면 제한 없음.
   * 퇴직연금만 70 이고, 나머지 30% 는 안전자산(채권형·예금형 ETF)이어야 한다.
   */
  riskCap: number;
  /** 레버리지·인버스를 담을 수 있나 */
  allowLeveraged: boolean;
  /** 며칠에 한 번 손대나 — 연금은 매일 볼 이유가 없다 */
  cadence: "daily" | "weekly" | "monthly";
  /** 매매 방식 — 없으면 swing */
  style?: TradeStyle;
  /**
   * 저녁 실행 시각을 계좌가 따로 가진다 (KST "HH:MM"). 없으면 설정의 `times.evening`.
   *
   * 종배 계좌가 쓴다 — 벤티지: "얘는 신호등 돌아간 다음에 종배해야 하니깐 스케쥴러를
   * NXT 에서 종배하는 친구로 만들어야 겠지?" 신호등 원장은 16:30 무렵 쌓이고 NXT
   * 애프터마켓은 20:00 까지 열려 있다. 그 사이에 돈다 — 그리고 스케줄러는 시각만
   * 보는 게 아니라 **오늘 원장이 실제로 쌓였는지**를 본다(`cisScheduler`).
   */
  eveningAt?: string;
  /**
   * 이 계좌만 덮어쓰는 규칙. 설정의 규칙은 셋이 같이 쓰는데(돈 쓰는 법은 같다 — 벤티지:
   * "계좌 잔액이나 미수, 신용 사용 가능은 동일한 애로"), **파는 법**은 방식마다 달라야 한다.
   * 종배는 하룻밤이라 손절이 짧다 — 벤티지: "종배하고 다음날 매도하는거니깐 매도 손절라인은
   * 짧게 잡고." `cisConfig.rulesFor` 가 합친다.
   */
  ruleOverrides?: Partial<CisRules>;
}

export const ACCOUNTS: Record<AccountId, AccountProfile> = {
  trade: {
    id: "trade",
    name: "CIS 트레이딩",
    hint: "개별종목 단기 추세추종 스윙. 신용·미수를 쓴다.",
    seed: 40_000_000,
    etfOnly: false,
    allowMisu: true,
    allowCredit: true,
    riskCap: 100,
    allowLeveraged: true,
    cadence: "daily",
    style: "swing",
  },
  /*
   * **종배 전용** (2026-09-02 밤). 트레이딩 계좌와 돈 쓰는 법은 같고(시드·미수·신용),
   * 다른 것은 셋뿐이다 — ① 저녁 한 번만 산다(신호등 원장 상위 → 수급 → 미국장 분위기 → 시장)
   * ② 다음 날 시가에 판다 ③ 그사이 손절 -3%. 벤티지: "종배 전용으로 테스트 해보고 싶어서
   * 그래. 신호등 + 시장 분위기 조합으로다가."
   */
  close: {
    id: "close",
    name: "CIS 트레이딩(종배)",
    hint: "종가배팅 전용 — 신호등 상위 + 수급 + 미국장 분위기. 저녁에만 사고 다음 날 시가에 판다. 손절 -3%.",
    seed: 40_000_000,
    etfOnly: false,
    allowMisu: true,
    allowCredit: true,
    riskCap: 100,
    allowLeveraged: true,
    cadence: "daily",
    style: "closeBet",
    /* 원장(16:30 무렵)이 쌓인 뒤, NXT 애프터마켓(~20:00) 안 */
    eveningAt: "17:00",
    ruleOverrides: {
      /* 하룻밤이라 짧게 — 벤티지: "매도 손절라인은 짧게 잡고" */
      stopPct: -3,
      /* 익절·되돌림·본전 전환은 안 쓴다 — 파는 자리는 다음 날 시가 하나다 */
      targetPct: 0,
      trailDropPct: 0,
      trailAfterPct: 0,
      maxHoldDays: 1,
    },
  },
  pension: {
    id: "pension",
    name: "개인연금 (연금저축)",
    hint: "ETF 만. 위험자산 100% 까지 담을 수 있다. 빌려 쓸 수 없다.",
    seed: 90_000_000,
    etfOnly: true,
    allowMisu: false,
    allowCredit: false,
    riskCap: 100,
    /* 연금저축은 레버리지·인버스 ETF 매수가 막혀 있다 */
    allowLeveraged: false,
    cadence: "weekly",
  },
  irp: {
    id: "irp",
    name: "퇴직연금 (IRP)",
    hint: "ETF 만. 위험자산 70% 한도 — 나머지 30% 는 안전자산이어야 한다.",
    seed: 110_000_000,
    etfOnly: true,
    allowMisu: false,
    allowCredit: false,
    riskCap: 70,
    allowLeveraged: false,
    cadence: "weekly",
  },
};

export const ACCOUNT_IDS: AccountId[] = ["trade", "close", "pension", "irp"];

export function profileOf(id: string): AccountProfile {
  return ACCOUNTS[(id as AccountId) in ACCOUNTS ? (id as AccountId) : "trade"];
}

/** 매매 방식 — 프로필에 없으면 swing */
export function styleOf(id: string): TradeStyle {
  return profileOf(id).style ?? "swing";
}

/* ------------------------------------------------------------------ 안전자산 */

/**
 * 이 ETF 가 **안전자산**인가 (퇴직연금 30% 몫).
 *
 * ⚠️ 이름으로 가른다. 제도상으로는 상품별 위험등급표가 기준인데 우리에겐 그 표가
 * 없다 — **없는 데이터를 지어내지 않는다**는 이 코드베이스의 원칙대로, 규칙을
 * 이름 기반으로 두고 그 사실을 여기 적는다. 틀릴 수 있고, 틀리면 화면에서
 * 사람이 바로잡는다(편입 목록에 표시된다).
 *
 * 국내 ETF 이름은 대체로 유형이 이름에 들어간다 — 「국고채」, 「단기채」,
 * 「종합채권」, 「머니마켓」, 「CD금리」, 「KOFR」 같은 것들.
 */
const SAFE_WORDS = [
  "국고채",
  "국채",
  "통안채",
  "단기채",
  "중기채",
  "장기채",
  "종합채권",
  "회사채",
  "우량채",
  "머니마켓",
  "MMF",
  "CD금리",
  "KOFR",
  "금리액티브",
  "초단기",
  "채권액티브",
];

export function isSafeAsset(name: string): boolean {
  return SAFE_WORDS.some((w) => name.includes(w));
}

/**
 * 담을 수 없는 ETF 인가 — 레버리지·인버스.
 *
 * 연금 계좌에서 이걸 사면 주문 자체가 거절된다. 모의라도 **못 사는 것을 샀다고
 * 적지 않는다** — 그러면 이 장부가 현실과 다른 이야기가 된다.
 */
const BLOCKED_WORDS = ["레버리지", "인버스", "2X", "2배", "곱버스", "선물인버스"];

export function isBlockedForPension(name: string): boolean {
  const up = name.toUpperCase();
  return BLOCKED_WORDS.some((w) => up.includes(w.toUpperCase()));
}

/** 계좌가 이 종목을 담을 수 있나 — 되는 이유가 아니라 **안 되는 이유**를 돌려준다 */
export function rejectReason(
  p: AccountProfile,
  s: { name: string; etf?: boolean },
): string | null {
  if (p.etfOnly && s.etf === false) return "이 계좌는 ETF 만 담는다";
  if (!p.allowLeveraged && isBlockedForPension(s.name)) {
    return "연금 계좌에서는 레버리지·인버스를 살 수 없다";
  }
  return null;
}
