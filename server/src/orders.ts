import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { peerIp, sameHex, scryptHex } from "./auth.js";
import { priceMap } from "./cisRun.js";
import { ensureLiveCode, peekRealtime } from "./realtimeHub.js";
import { KiwoomApiError, KiwoomClient } from "./kiwoomClient.js";
import { pushNotice, stockLink } from "./notifyCenter.js";
import { sendTelegram } from "./telegram.js";

/**
 * 주문 (2026-09-03) — 벤티지: "주문 메뉴 들어갈 때는 아이디랑 비밀번호를 한 번 더, 그 세션을 유지하는 동안.
 * 주문 걸 때도 비밀번호 한 번 더. 대신 자동주문은 아니어야겠지." + "체결되면 종·텔레그램 알림"
 * + "NXT·정규장·통합 모두 주문 가능하게".
 *
 * ## 조사 (2026-09-03, openapi.kiwoom.com 가이드 · 공식 래퍼 목록)
 *   REST 가 주는 주문   = 현금 매수 kt10000 · 매도 kt10001 · 정정 kt10002 · 취소 kt10003 (신용 kt10006~9 는 안 쓴다)
 *   REST 에 **없는 것**  = 예약주문 · 자동감시주문 — 영웅문 HTS 의 기능이다. 09-03 엔 「만들지 않는다」였고,
 *                        **09-07 밤 벤티지 지시로 자동감시를 우리 서버가 한다** (예약은 그날 만들었다 걷어냈다).
 *                        어떻게 못 박았는지는 아래 「자동감시주문」 절.
 *
 * ## ⚠️ 정정 (2026-09-04) — 스톱지정가는 REST 로 된다
 *
 * 09-03 에 「스탑로스·스톱지정가도 REST 에 없다」고 적었는데 **틀렸다.** 키움이 8/27 에 공개한 공식 저장소
 * (github.com/Kiwoom-Securities/Kiwoom-REST-API) 의 `examples/국내주식/주문/buy_domestic_stock.py` 에
 * `trde_tp` 코드표가 있고 **28 = 스톱지정가**다. 발동가는 `cond_uv`(조건단가)로 같이 보내고, 미체결·체결
 * 응답에 `stop_pric`(스톱가)가 돌아온다.
 *
 * **이건 우리 원칙에 안 걸린다.** 주문 한 번으로 조건까지 같이 넘기는 것이라 **우리 서버가 조건을 지켜보지
 * 않는다** — 발동을 판단하는 쪽은 키움/거래소다. 설계가 뺀 「자동감시」는 *우리 서버가* 시세를 보다 스스로
 * 주문을 쏘는 구조를 말한다. 그 성질(placeOrder 의 유일한 호출자가 executePrepared)은 그대로다.
 *
 * 매매구분도 0·3 둘만 쓰고 있었는데 실제로는 18개다 — 아래 `TRADE_TYPES`.
 *   조회               = 미체결 ka10075 · 체결 ka10076 · 예수금 kt00001 · 잔고 kt00018
 *   자리               = /api/dostk/ordr (주문) · /api/dostk/acnt (계좌)
 *
 * ## 겹 (docs/주문기능_설계.md)
 *   L0 별도 앱키(KIWOOM_ORDER_APP_KEY) + **모의가 기본** — 실전은 KIWOOM_ORDER_IS_MOCK=false 를 손으로 적어야
 *   L1 주문 세션 — 앱 아이디·비밀번호를 **다시** 넣어야 열린다. 10분 놀면 닫히고, 열어 둔 채 60분이면 닫힌다
 *   L2 주문 비밀번호 — 앱 비밀번호와 **다른** 것. scrypt 로만 남는다. 실행마다 묻는다. 5번 틀리면 30분 잠금 + 텔레
 *   L3 한도 — data/orderGuard.json. 넘으면 **거절**(줄여서 넣지 않는다)
 *   L4 두 단계 — prepare(30초 nonce) → execute. 나중에 같은 nonce 를 다시 쏴도 안 나간다
 *   L5 ORDERS_ENABLED=1 이 아니면 라우트 자체가 404 · 화면 잠금(uiLocked)은 비밀번호로 풀기 전엔 안 나간다
 *   L6 기록 — data/orderLog.jsonl 에 덧붙이기만. 실행마다 텔레 「order」 방
 *   L7 POST 만 · X-VNTG-Order 헤더 · Origin 검사 (routes/order.ts)
 *
 * ## 자동주문 차단은 규칙이 아니라 **구조**다
 *   주문을 실제로 쏘는 `placeOrder` 는 이 파일의 비공개 함수고, 유일한 호출자는 `executePrepared` — 그것도
 *   30초 nonce 와 주문 비밀번호가 있어야 지나간다. 스케줄러·시스·알림 모듈이 import 할 수 있는 「주문 함수」가
 *   없다. 이 파일을 그렇게 유지하는 것이 이 기능의 첫 번째 안전장치다.
 *
 * ## 필드명 (2026-09-04 공식 예제로 확인)
 *   주문      dmst_stex_tp · stk_cd · ord_qty · ord_uv · trde_tp · cond_uv → 응답 ord_no · dmst_stex_tp
 *   미체결    ka10075 배열 `oso` — ord_no · stk_cd · stk_nm · io_tp_nm · ord_qty · ord_pric · oso_qty · cntr_qty ·
 *             cntr_pric · ord_stt · tm · stex_tp · stex_tp_txt · sor_yn · stop_pric · orig_ord_no
 *   체결      ka10076 배열 `cntr` — 위와 같고 **시각이 ord_tm** (미체결은 tm) · cntr_pric · cntr_qty
 *   남은 실측은 예수금(kt00001) 필드와 왕복 자체뿐이다. 첫 응답 원문은 그대로 기록(kind "raw")에 남긴다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const AUTH_FILE = join(DATA_DIR, "orderAuth.json");
const GUARD_FILE = join(DATA_DIR, "orderGuard.json");
const LOG_FILE = join(DATA_DIR, "orderLog.jsonl");
const SETTINGS_FILE = join(DATA_DIR, "orderSettings.json");

const ORDER_RESOURCE = "/api/dostk/ordr";
const ACNT_RESOURCE = "/api/dostk/acnt";
/** 신용 주문은 자리가 다르다 — kt10006~9 는 `/crdordr` 다 */
const CREDIT_ORDER_RESOURCE = "/api/dostk/crdordr";

export type OrderSide = "buy" | "sell";
/** KRX 정규장 · NXT · SOR(통합 — 키움이 더 좋은 쪽으로 보내는 최선집행) */
export type OrderVenue = "KRX" | "NXT" | "SOR";
export const VENUES: OrderVenue[] = ["KRX", "NXT", "SOR"];

/**
 * 매매구분(`trde_tp`) — 키움 공식 예제의 코드표 그대로 (2026-09-04).
 *
 * `price`  주문단가(ord_uv)를 보내나. "req" 꼭 · "no" 안 보냄(빈 문자열) · "opt" 넣으면 보냄
 * `cond`   조건단가(cond_uv)를 보내나 — 지금은 스톱지정가 하나뿐이다
 * `late`   정규장 시간창 검사를 건너뛴다(시간외 주문이라 당연히 밖에서 낸다)
 *
 * ⚠️ **코드값과 이름은 공식 표다. 「가격을 보내야 하나」는 우리가 추론한 것**이다 — 0·3·28 만
 * 예제로 확인했다. 중간가(29~31)와 시간외(61·81)는 모의 실측에서 틀리면 여기만 고치면 된다.
 * 그래서 화면이 이 표를 그대로 받아 그린다 — 서버와 화면이 갈리지 않게.
 */
export interface TradeType {
  code: string;
  label: string;
  price: "req" | "no" | "opt";
  cond: boolean;
  late: boolean;
  hint: string;
}

export const TRADE_TYPES: TradeType[] = [
  { code: "0", label: "보통(지정가)", price: "req", cond: false, late: false, hint: "값을 정해 걸어 둔다" },
  { code: "3", label: "시장가", price: "no", cond: false, late: false, hint: "지금 나오는 값에 바로" },
  {
    code: "28",
    label: "스톱지정가",
    price: "req",
    cond: true,
    late: false,
    hint: "조건단가에 닿으면 주문단가로 낸다 — 발동을 지켜보는 쪽은 키움이다",
  },
  { code: "5", label: "조건부지정가", price: "req", cond: false, late: false, hint: "장중엔 지정가, 안 되면 마감 동시호가에 시장가" },
  { code: "6", label: "최유리지정가", price: "no", cond: false, late: false, hint: "반대편 첫 호가로" },
  { code: "7", label: "최우선지정가", price: "no", cond: false, late: false, hint: "우리 편 첫 호가로" },
  { code: "10", label: "보통 IOC", price: "req", cond: false, late: false, hint: "되는 만큼만 즉시, 나머지 취소" },
  { code: "13", label: "시장가 IOC", price: "no", cond: false, late: false, hint: "되는 만큼만 즉시, 나머지 취소" },
  { code: "16", label: "최유리 IOC", price: "no", cond: false, late: false, hint: "되는 만큼만 즉시, 나머지 취소" },
  { code: "20", label: "보통 FOK", price: "req", cond: false, late: false, hint: "전부 아니면 전부 취소" },
  { code: "23", label: "시장가 FOK", price: "no", cond: false, late: false, hint: "전부 아니면 전부 취소" },
  { code: "26", label: "최유리 FOK", price: "no", cond: false, late: false, hint: "전부 아니면 전부 취소" },
  { code: "29", label: "중간가", price: "opt", cond: false, late: false, hint: "양쪽 첫 호가의 가운데 — NXT 계열. 실측 전" },
  { code: "30", label: "중간가 IOC", price: "opt", cond: false, late: false, hint: "실측 전" },
  { code: "31", label: "중간가 FOK", price: "opt", cond: false, late: false, hint: "실측 전" },
  { code: "61", label: "장시작전 시간외", price: "no", cond: false, late: true, hint: "전일 종가로 — 08:30~08:40. 실측 전" },
  { code: "62", label: "시간외 단일가", price: "req", cond: false, late: true, hint: "16:00~18:00, 10분 단위 단일가. 실측 전" },
  { code: "81", label: "장마감후 시간외", price: "no", cond: false, late: true, hint: "당일 종가로 — 15:40~16:00. 실측 전" },
];

export function tradeTypeOf(code: string): TradeType | null {
  return TRADE_TYPES.find((t) => t.code === code) ?? null;
}

export interface OrderGuard {
  /** 주문 한 건의 상한(원). 지정가는 가격×수량, 시장가는 현재가×수량으로 잰다 */
  maxOrderKrw: number;
  /** 오늘 낸 주문(매수+매도)의 합 상한(원) */
  maxDailyKrw: number;
  /** 오늘 낸 주문 건수 상한 (취소는 안 센다) */
  maxDailyCount: number;
  /** 현재가에서 이만큼(%) 넘게 벗어난 지정가는 거절 — 0 을 하나 더 친 손가락 */
  priceCollarPct: number;
  /**
   * 스톱 **발동가**(조건단가)는 따로 잰다 (2026-09-04).
   *
   * 손절 스톱은 현재가보다 한참 아래에 두는 것이 정상이다 — 지정가와 같은 ±5% 를 물리면
   * 쓸 수 있는 손절선이 5% 안쪽뿐이라 기능이 죽는다. 넓게 두되 손가락 실수(0 하나 더)는 잡는다.
   * 주문단가는 이 발동가에서 `priceCollarPct` 안에 있어야 한다 — 둘이 멀면 그게 오타다.
   */
  stopCollarPct: number;
  /** 거래소가 주문을 받는 시간에만 — 밖이면 거절 */
  marketHoursOnly: boolean;
  /** 비우면(null) 전 종목. 채우면 이 코드들만 */
  allowedCodes: string[] | null;
  /**
   * **신용 주문을 허용하나** (2026-09-07). 기본 false — 한도처럼 파일에서 손으로 켠다.
   *
   * 벤티지: "신용 기능도 넣어서… 신용 섞어서 매수하는 거 체크해주고." 넣되, 켜는 것은
   * 사람이다. 신용은 빚이라 한 건 한도보다 한 급 위의 결정이고, 그 결정이 화면 단추 하나로
   * 내려지면 안 된다. `orderGuard.json` 에 `"allowCredit": true` 를 적는 순간부터 신용 칸이 열린다.
   */
  allowCredit: boolean;
  /**
   * **자동감시주문을 허용하나** (2026-09-07 밤). 벤티지: "예약이 아니라 자동감시주문이 더 맞는
   * 표현이겠다." 서버가 값을 보다가 조건에 닿으면 사람이 미리 비밀번호까지 넣어 둔 주문서를 낸다.
   * 09-03 설계가 뺀 자리를 벤티지 지시로 연 것이라, 끄는 자리는 여기 파일이다. false 면 새로
   * 안 받고 **기다리던 감시도 발동하지 않는다.**
   */
  allowAutoWatch: boolean;
  /**
   * 계좌 단위 위험 한도 (2026-09-07 밤, 개편 ⑤).
   *   maxPositionPct  종목 하나에 계좌(예수금+평가)의 몇 %까지 — 넘는 매수는 거절.
   *                   **기본 0 = 안 씀** (2026-09-08 — 벤티지 "주문에 왜 한종목 비중초과를
   *                   걸어놨어? 이런거 빼"). 40 으로 박아 둔 것을 삼성전자 45% 에서 걸렸다.
   *                   화면에 바꾸는 자리가 없어 파일을 열어야 했다. 쓰려면 파일에 값을 적는다.
   *   maxDailyLossKrw 오늘 자동감시 매도로 실현한 손실이 이만큼을 넘으면 그날 신규 매수 잠금 (0 = 안 씀)
   *   rebuyCooldownMin 손절 매도가 발동한 종목은 이 분 동안 다시 안 산다
   *   dualStop        「이하면 판다」 감시에 키움 스톱지정가를 아침마다 같이 건다(서버가 죽어도 키움이 판다)
   */
  maxPositionPct: number;
  maxDailyLossKrw: number;
  rebuyCooldownMin: number;
  dualStop: boolean;
}

const DEFAULT_GUARD: OrderGuard = {
  maxOrderKrw: 1_000_000,
  maxDailyKrw: 3_000_000,
  maxDailyCount: 20,
  priceCollarPct: 5,
  stopCollarPct: 30,
  marketHoursOnly: true,
  allowedCodes: null,
  allowCredit: false,
  allowAutoWatch: true,
  maxPositionPct: 0,
  maxDailyLossKrw: 0,
  rebuyCooldownMin: 30,
  dualStop: true,
};

interface OrderAuthFile {
  salt: string;
  hash: string;
  fails: number;
  lockUntil: number;
  /** 화면 잠금 — 켜 두면 비밀번호로 풀기 전엔 어떤 주문도 안 나간다 */
  uiLocked: boolean;
  /**
   * **진입 PIN** (2026-09-04) — 주문 메뉴를 여는 네 자리.
   *
   * 벤티지: "주문메뉴 진입할 때 아이디 비번 말고 주문전용 비밀번호로 하자. 숫자 4개로.
   * (비번 매번 치려니 힘듦)"
   *
   * ⚠️ **주문 비밀번호(위 hash)와 다른 것이어야 한다.** PIN 은 문을 여는 것이고 주문
   * 비밀번호는 주문 한 건을 내보내는 것이다. 둘을 같게 두면 겹이 둘에서 하나로 준다 —
   * 네 자리 하나가 뚫리면 그대로 주문까지 나간다. 그래서 저장도 따로 한다.
   */
  pinSalt: string;
  pinHash: string;
  pinFails: number;
  pinLockUntil: number;
}

export type OrderLogKind =
  | "session"
  | "order"
  | "cancel"
  | "fill"
  | "reject"
  | "error"
  | "lock"
  | "password"
  | "raw"
  /** 자동감시 — 등록·취소·만료·발동. 실제로 나간 것은 "order" */
  | "watch"
  /** 한도·규칙(orderGuard)을 화면에서 바꿨다 (2026-09-08) */
  | "guard";

export interface OrderLogRow {
  at: string;
  kind: OrderLogKind;
  mock: boolean;
  ip?: string;
  side?: OrderSide;
  code?: string;
  name?: string;
  qty?: number;
  /** null = 값을 안 보내는 구분 */
  price?: number | null;
  condPrice?: number | null;
  tradeType?: string;
  venue?: OrderVenue;
  ordNo?: string;
  origOrdNo?: string;
  amount?: number;
  msg?: string;
  raw?: unknown;
  /** 신용(융자) 주문이었나 — 기록에서 현금과 갈라 봐야 한다 */
  credit?: boolean;
}

/**
 * 주문 화면 설정 (2026-09-04) — 화면에서 고칠 수 있는 것만. **한도(orderGuard)는 여기 없다.**
 * 한도를 화면에서 고칠 수 있으면 그건 한도가 아니다 — 그건 파일을 직접 열어야 한다.
 */
export interface OrderSettings {
  /**
   * 주문 비밀번호를 한동안 기억할까 (벤티지: "내 계좌 비밀번호 기억하기 하면 세션 1시간").
   *
   * ⚠️ **비밀번호를 저장하는 것이 아니다.** 한 번 맞힌 뒤 **그 주문 세션에만** 「이 세션은
   * 확인됐다」는 시한을 찍는다. 브라우저에도, 파일에도 비밀번호는 남지 않는다.
   * 시한은 주문 세션의 최대 수명(60분)을 절대 넘지 않는다 — 세션이 닫히면 같이 사라진다.
   */
  rememberPassword: boolean;
  /** 기억할 시간(분). 1~60 */
  rememberMinutes: number;
  /** 주문 화면을 열 때 기본으로 고를 거래소. "auto" 면 그때 열려 있는 곳 */
  defaultVenue: OrderVenue | "auto";
  /** 기본 매매구분(trde_tp) */
  defaultTradeType: string;
  /**
   * **등록된 기기에서만 주문** (2026-09-04). 메일이 설정돼 있어야 켤 수 있다 —
   * 확인할 길이 없는데 막으면 주문 기능이 통째로 잠긴다. 그건 안전이 아니라 고장이다.
   */
  requireTrustedDevice: boolean;
  /** 주문 세션이 가만히 있을 때 닫히는 시간(분). 1~60 */
  idleMinutes: number;
  /** 계속 써도 닫히는 시간(분). 5~240 */
  maxMinutes: number;
  /**
   * 주문 메뉴를 **무엇으로 여나** (2026-09-04, 패턴은 09-08).
   *   "password" 앱 아이디·비밀번호를 다시 (기본)
   *   "pin"      네 자리 숫자 — 손이 편하다. 대신 **기기 등록이 켜져 있어야만** 고를 수 있다
   *   "pattern"  3×3 점을 잇는 패턴 — 벤티지 "매번 입력하려니 귀찮고 숫자 넣으려니깐
   *              저장된 비밀번호 계속나와서 걸리적 거리네". 점을 이은 순서를 숫자열로
   *              ("0125" = 좌상→상→우상→가운데) 보고 PIN 과 **같은 해시 자리**에 둔다.
   *              그래서 잠금·실패 횟수·확인 로직이 전부 그대로다. 길이만 4~9다.
   *
   * PIN 은 만 가지뿐이라 **혼자 서는 문이 아니다.** 앞에 등록된 기기가 있어야 뜻이 산다 —
   * 그래서 `requireTrustedDevice` 가 꺼져 있으면 "pin"·"pattern" 으로 못 바꾼다(saveSettings).
   * 패턴은 4점 이상이면 경우의 수가 PIN 보다 많지만, 같은 겹 안에 둔다 — 문의 성격이 같다.
   */
  entryMode: "password" | "pin" | "pattern";
  /**
   * **주문 비밀번호를 무엇으로 받나** (2026-09-08 — 벤티지 "주문비밀번호도 패턴쓸수 잇게").
   *   "text"     글자 비밀번호 6자 이상 (기본)
   *   "pattern"  3×3 패턴 — 진입 패턴과 같은 숫자열 형식이고 같은 해시 방식이다. 자리는 다르다.
   *
   * 진입 패턴과 **같은 패턴을 쓰면 겹이 둘에서 하나로 준다** — 화면이 경고하지만 막지는
   * 않는다. 서버는 해시만 들고 있어 둘이 같은지 알 수 없다.
   */
  passwordMode: "text" | "pattern";
  /**
   * **접근 점검을 텔레그램으로도 보낼까** (2026-09-04). 기본 켬.
   *
   * 끄면 점검은 그대로 6시간마다 돌고 기록도 남는다 — **알림만** 안 간다.
   * 화면(주문 › 설정 › 접근 로그)이 「마지막 점검 · 이상 없음」을 늘 말하고 있어서,
   * 텔레그램은 겹치는 통로다. 겹치는 통로는 끌 수 있어야 한다.
   */
  auditTelegram: boolean;
}

const DEFAULT_SETTINGS: OrderSettings = {
  rememberPassword: false,
  rememberMinutes: 60,
  defaultVenue: "auto",
  defaultTradeType: "0",
  requireTrustedDevice: true,
  idleMinutes: 10,
  maxMinutes: 60,
  entryMode: "password",
  passwordMode: "text",
  auditTelegram: true,
};

export async function getSettings(): Promise<OrderSettings> {
  const v = await readJson(SETTINGS_FILE, DEFAULT_SETTINGS);
  return {
    ...v,
    rememberMinutes: Math.min(60, Math.max(1, Math.round(v.rememberMinutes) || 60)),
    idleMinutes: Math.min(60, Math.max(1, Math.round(v.idleMinutes) || 10)),
    maxMinutes: Math.min(240, Math.max(5, Math.round(v.maxMinutes) || 60)),
  };
}

export async function saveSettings(patch: Partial<OrderSettings>): Promise<OrderSettings> {
  const cur = await getSettings();
  const next: OrderSettings = {
    rememberPassword: typeof patch.rememberPassword === "boolean" ? patch.rememberPassword : cur.rememberPassword,
    rememberMinutes: Math.min(60, Math.max(1, Math.round(Number(patch.rememberMinutes)) || cur.rememberMinutes)),
    defaultVenue:
      patch.defaultVenue === "auto" || (patch.defaultVenue && VENUES.includes(patch.defaultVenue))
        ? patch.defaultVenue
        : cur.defaultVenue,
    defaultTradeType: tradeTypeOf(String(patch.defaultTradeType ?? "")) ? String(patch.defaultTradeType) : cur.defaultTradeType,
    requireTrustedDevice:
      typeof patch.requireTrustedDevice === "boolean" ? patch.requireTrustedDevice : cur.requireTrustedDevice,
    idleMinutes: Math.min(60, Math.max(1, Math.round(Number(patch.idleMinutes)) || cur.idleMinutes)),
    maxMinutes: Math.min(240, Math.max(5, Math.round(Number(patch.maxMinutes)) || cur.maxMinutes)),
    entryMode:
      patch.entryMode === "pin" || patch.entryMode === "password" || patch.entryMode === "pattern"
        ? patch.entryMode
        : cur.entryMode,
    passwordMode: patch.passwordMode === "pattern" || patch.passwordMode === "text" ? patch.passwordMode : cur.passwordMode ?? "text",
    auditTelegram:
      patch.auditTelegram === undefined ? cur.auditTelegram : Boolean(patch.auditTelegram),
  };

  /*
   * **PIN 은 기기 등록 없이는 못 쓴다.** 네 자리는 만 가지뿐이라, 앞에 「가진 것」이 없으면
   * 앱 로그인만 뚫리면 주문 문이 사실상 열린다. 둘을 한 묶음으로 강제한다 —
   * 「편하게」와 「위험하게」가 같은 뜻이 되지 않도록.
   */
  if ((next.entryMode === "pin" || next.entryMode === "pattern") && !next.requireTrustedDevice) {
    throw new Error(`${next.entryMode === "pin" ? "PIN" : "패턴"}으로 열려면 「등록된 기기에서만 주문」이 켜져 있어야 합니다`);
  }
  await writeJson(SETTINGS_FILE, next);
  await appendLog({ kind: "password", msg: `설정 변경 — 비밀번호 기억 ${next.rememberPassword ? `${next.rememberMinutes}분` : "끔"}` });
  /* 기억하기를 켜는 것은 겹 하나를 무르는 일이라 조용히 넘어가지 않는다 */
  if (next.rememberPassword && !cur.rememberPassword) {
    void sendTelegram(
      `🔓 주문 비밀번호 <b>기억하기</b>를 켰습니다 (${next.rememberMinutes}분).
주문 세션이 열려 있는 동안 실행마다 묻지 않습니다.`,
      "syslog",
    ).catch(() => undefined);
  }
  return next;
}

/* ── 환경 ─────────────────────────────────────────────────────────────── */

export function ordersEnabled(): boolean {
  return (process.env.ORDERS_ENABLED ?? "").trim() === "1";
}

/** 실전은 **명시적으로** false 를 적어야 한다. 비우면 모의 */
export function orderIsMock(): boolean {
  return (process.env.KIWOOM_ORDER_IS_MOCK ?? "true").trim().toLowerCase() !== "false";
}

let orderClientCache: KiwoomClient | null | undefined;

/** 주문 전용 앱키의 클라이언트 — 조회용 앱키와 **섞지 않는다**(토큰이 서로를 죽인다) */
export function orderClient(): KiwoomClient | null {
  if (orderClientCache !== undefined) return orderClientCache;
  const key = (process.env.KIWOOM_ORDER_APP_KEY ?? "").trim();
  const secret = (process.env.KIWOOM_ORDER_APP_SECRET ?? "").trim();
  orderClientCache = key && secret ? new KiwoomClient({ appKey: key, appSecret: secret, isMock: orderIsMock() }) : null;
  return orderClientCache;
}

/* ── 시간 (KST) ───────────────────────────────────────────────────────── */

function kstParts(now = new Date()): { date: string; weekday: number; minute: number } {
  const t = new Date(now.getTime() + 9 * 3600_000);
  return {
    date: t.toISOString().slice(0, 10),
    weekday: t.getUTCDay(),
    minute: t.getUTCHours() * 60 + t.getUTCMinutes(),
  };
}

/**
 * 거래소별 주문 접수 창(분). 🔴 2026-09-14 KRX 애프터시장 신설로 바뀐다 — docs/다음작업_TODO.md.
 *   KRX 08:30~15:30 (동시호가 접수 포함)
 *   NXT 프리 08:00~08:50 · 메인 09:00~15:20 · 애프터 15:30~20:00
 *   SOR 둘의 합집합
 */
const WINDOWS: Record<OrderVenue, Array<[number, number]>> = {
  KRX: [[510, 930]],
  NXT: [
    [480, 530],
    [540, 920],
    [930, 1200],
  ],
  SOR: [[480, 1200]],
};

export function venueOpen(venue: OrderVenue, now = new Date()): boolean {
  const { weekday, minute } = kstParts(now);
  if (weekday === 0 || weekday === 6) return false;
  return WINDOWS[venue].some(([a, b]) => minute >= a && minute <= b);
}

/* ── 파일 ─────────────────────────────────────────────────────────────── */

async function readJson<T>(file: string, fallback: T): Promise<T> {
  try {
    return { ...fallback, ...(JSON.parse(await fs.readFile(file, "utf8")) as Partial<T>) };
  } catch {
    return fallback;
  }
}

async function writeJson(file: string, v: unknown): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(v, null, 2), "utf8");
}

export async function getGuard(): Promise<OrderGuard> {
  const g = await readJson(GUARD_FILE, DEFAULT_GUARD);
  /*
   * 옛 기본값 40 이 파일에 굳어 있으면 0 으로 읽는다. 벤티지가 직접 적은 값이 아니라
   * 처음 파일을 만들 때 기본값이 박힌 것이라, 그걸 존중할 이유가 없다.
   * 40 이 아닌 다른 값이면 사람이 적은 것이니 그대로 둔다.
   */
  if (g.maxPositionPct === 40) g.maxPositionPct = 0;
  try {
    await fs.access(GUARD_FILE);
  } catch {
    await writeJson(GUARD_FILE, g); // 손으로 고칠 수 있게 파일을 만들어 둔다
  }
  return g;
}

/**
 * **규칙을 화면에서 바꾼다** (2026-09-08).
 *
 * 벤티지: "이거 뭐야? 이런 규칙들 어디에 있는 거야? 이거 설정에서 ON/OFF 할 수 있게 해줘봐
 * 다 찾아가지고." — 손절 뒤 쿨다운에 걸려서 삼성전자를 30분 못 산 자리에서.
 *
 * 여태 L3 설계는 「한도는 파일을 손으로 고쳐야 바뀐다」였다. 화면 단추 하나로 한도가 풀리면
 * 한도가 아니라는 생각이었다. 그런데 파일이 어디 있는지, 무슨 규칙이 있는지조차 화면이
 * 말해 주지 않으니 **규칙에 걸린 사람이 왜 걸렸는지 알 길이 없었다.** 그건 안전이 아니라 불투명이다.
 *
 * 절충: 화면에서 고칠 수 있게 하되 **주문 비밀번호를 다시 받고**, 바뀐 값은 로그(orderLog)에
 * 남긴다. 주문을 내는 것과 같은 무게로 취급한다.
 *
 * 값은 여기서 한 번 더 거른다 — 화면이 이상한 값을 보내도 파일이 망가지면 안 된다.
 */
export async function saveGuard(patch: Partial<OrderGuard>): Promise<OrderGuard> {
  const cur = await getGuard();
  const next: OrderGuard = { ...cur };
  const num = (k: keyof OrderGuard, v: unknown, min: number, max: number, int = true): void => {
    if (v === undefined) return;
    const n = Number(v);
    if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${k}: ${min}~${max} 사이여야 한다`);
    (next as unknown as Record<string, unknown>)[k] = int ? Math.round(n) : n;
  };
  const bool = (k: keyof OrderGuard, v: unknown): void => {
    if (v === undefined) return;
    (next as unknown as Record<string, unknown>)[k] = Boolean(v);
  };
  num("maxOrderKrw", patch.maxOrderKrw, 10_000, 1_000_000_000);
  num("maxDailyKrw", patch.maxDailyKrw, 10_000, 10_000_000_000);
  num("maxDailyCount", patch.maxDailyCount, 1, 1000);
  num("priceCollarPct", patch.priceCollarPct, 1, 30, false);
  num("stopCollarPct", patch.stopCollarPct, 1, 90, false);
  num("maxPositionPct", patch.maxPositionPct, 0, 100, false);
  num("maxDailyLossKrw", patch.maxDailyLossKrw, 0, 10_000_000_000);
  num("rebuyCooldownMin", patch.rebuyCooldownMin, 0, 24 * 60);
  bool("marketHoursOnly", patch.marketHoursOnly);
  bool("allowCredit", patch.allowCredit);
  bool("allowAutoWatch", patch.allowAutoWatch);
  bool("dualStop", patch.dualStop);
  if (patch.allowedCodes !== undefined) {
    if (patch.allowedCodes === null) next.allowedCodes = null;
    else if (Array.isArray(patch.allowedCodes)) {
      const codes = patch.allowedCodes.map((c) => String(c).trim()).filter((c) => /^\d{6}$/.test(c));
      next.allowedCodes = codes.length > 0 ? codes : null;
    }
  }
  /* 뭐가 바뀌었는지 한 줄 — 나중에 「누가 언제 쿨다운을 껐나」를 이 줄로 찾는다 */
  const changed = (Object.keys(next) as (keyof OrderGuard)[])
    .filter((k) => JSON.stringify(cur[k]) !== JSON.stringify(next[k]))
    .map((k) => `${k}: ${JSON.stringify(cur[k])} → ${JSON.stringify(next[k])}`);
  if (changed.length === 0) return cur;
  await writeJson(GUARD_FILE, next);
  await appendLog({ kind: "guard", msg: `규칙 변경 — ${changed.join(" · ")}` });
  return next;
}

const EMPTY_AUTH: OrderAuthFile = {
  salt: "",
  hash: "",
  fails: 0,
  lockUntil: 0,
  uiLocked: false,
  pinSalt: "",
  pinHash: "",
  pinFails: 0,
  pinLockUntil: 0,
};

async function loadAuth(): Promise<OrderAuthFile> {
  return readJson(AUTH_FILE, EMPTY_AUTH);
}

export async function appendLog(row: Omit<OrderLogRow, "at" | "mock">): Promise<void> {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const full: OrderLogRow = { at: new Date().toISOString(), mock: orderIsMock(), ...row };
  await fs.appendFile(LOG_FILE, JSON.stringify(full) + "\n", "utf8");
}

export async function readLog(limit = 200): Promise<OrderLogRow[]> {
  try {
    const lines = (await fs.readFile(LOG_FILE, "utf8")).split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((l) => {
        try {
          return JSON.parse(l) as OrderLogRow;
        } catch {
          return null;
        }
      })
      .filter((r): r is OrderLogRow => r !== null)
      .reverse();
  } catch {
    return [];
  }
}

/** 오늘(KST) 나간 주문의 합과 건수 — 한도는 **기록**에서 센다. 메모리는 재시작에 지워지니까 */
async function todayUsage(): Promise<{ krw: number; count: number }> {
  const { date } = kstParts();
  const rows = await readLog(2000);
  let krw = 0;
  let count = 0;
  for (const r of rows) {
    if (r.kind !== "order" || r.mock !== orderIsMock()) continue;
    if (kstParts(new Date(r.at)).date !== date) continue;
    krw += r.amount ?? 0;
    count += 1;
  }
  return { krw, count };
}

/* ── 주문 세션 (L1) ────────────────────────────────────────────────────── */

export const ORDER_COOKIE = "vntg_o";

interface OrderSession {
  idle: number;
  hard: number;
  ip: string;
  /** 이 시각까지는 주문 비밀번호를 다시 안 묻는다 (기억하기). 0 이면 매번 묻는다 */
  pwUntil: number;
  /** 이 세션이 쓰는 유휴 시한(ms) — 열 때 설정에서 굳힌다 */
  idleMs: number;
}

const sessions = new Map<string, OrderSession>();

function cookieOf(req: Request, name: string): string | null {
  const raw = req.headers.cookie ?? "";
  for (const part of raw.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function secure(req: Request): boolean {
  return req.secure || String(req.headers["x-forwarded-proto"] ?? "").includes("https");
}

function setCookie(req: Request, res: Response, value: string, maxAgeSec: number): void {
  const bits = [
    `${ORDER_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/api/order",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secure(req)) bits.push("Secure");
  res.append("Set-Cookie", bits.join("; "));
}

/** 접속자 주소 — 판정은 auth.ts 하나에 둔다(헤더를 언제 믿나가 거기 적혀 있다) */
export function clientIp(req: Request): string {
  return peerIp(req);
}

/** 시한은 설정에서 온다 — 여는 순간의 값으로 굳는다(도중에 바꿔도 열린 세션은 안 늘어난다) */
export async function openSession(req: Request, res: Response): Promise<void> {
  const cfg = await getSettings();
  const idleMs = cfg.idleMinutes * 60_000;
  const hardMs = cfg.maxMinutes * 60_000;
  const token = randomBytes(24).toString("hex");
  const now = Date.now();
  sessions.set(token, { idle: now + idleMs, hard: now + hardMs, ip: clientIp(req), pwUntil: 0, idleMs });
  setCookie(req, res, token, Math.round(hardMs / 1000));
}

/** 살아 있으면 유휴 시한을 민다. 죽었으면 null */
export function sessionOf(req: Request): OrderSession | null {
  const token = cookieOf(req, ORDER_COOKIE);
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  const now = Date.now();
  if (now > s.idle || now > s.hard) {
    sessions.delete(token);
    return null;
  }
  s.idle = Math.min(now + s.idleMs, s.hard);
  return s;
}

/** 남은 「기억」 시간(초). 0 이면 다음 주문에 비밀번호를 묻는다 */
export function passwordLeftSec(req: Request): number {
  const token = cookieOf(req, ORDER_COOKIE);
  const s = token ? sessions.get(token) : undefined;
  if (!s) return 0;
  return Math.max(0, Math.floor((s.pwUntil - Date.now()) / 1000));
}

/** 기억을 지금 끊는다 — 설정에서 끄거나 「잠금」을 누를 때 */
export function forgetPassword(req: Request): void {
  const token = cookieOf(req, ORDER_COOKIE);
  const s = token ? sessions.get(token) : undefined;
  if (s) s.pwUntil = 0;
}

export function sessionLeftSec(req: Request): number {
  const token = cookieOf(req, ORDER_COOKIE);
  const s = token ? sessions.get(token) : undefined;
  if (!s) return 0;
  return Math.max(0, Math.floor((Math.min(s.idle, s.hard) - Date.now()) / 1000));
}

export function closeSession(req: Request, res: Response): void {
  const token = cookieOf(req, ORDER_COOKIE);
  if (token) sessions.delete(token);
  setCookie(req, res, "", 0);
}

/* ── 주문 비밀번호 (L2) ────────────────────────────────────────────────── */

const PW_MAX_FAILS = 5;
const PW_LOCK_MS = 30 * 60_000;

export async function hasOrderPassword(): Promise<boolean> {
  const a = await loadAuth();
  return a.hash.length > 0;
}

export async function setOrderPassword(next: string, current: string | null, kind: "text" | "pattern" = "text"): Promise<void> {
  const a = await loadAuth();
  if (a.hash) {
    const r = await checkPassword(current ?? "");
    if (!r.ok) throw new Error(r.error);
  }
  if (kind === "pattern") {
    /* 진입 패턴과 같은 규칙 — 네 점 이상, 같은 점 두 번 금지, 한 줄로만 긋기 금지 */
    if (next.length < 4) throw new Error("패턴은 점 네 개 이상을 이어야 합니다");
    if (next.length > 9) throw new Error("패턴이 너무 깁니다");
    if (/[^0-8]/.test(next)) throw new Error("패턴 값이 이상합니다");
    if (new Set(next).size !== next.length) throw new Error("같은 점을 두 번 지났습니다");
    if (/^(012|345|678|036|147|258|048|246)/.test(next) && next.length <= 4)
      throw new Error("너무 뻔한 패턴입니다 — 한 줄로만 긋는 것은 막습니다");
  } else if (next.length < 6) throw new Error("주문 비밀번호는 6자 이상");
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptHex(next, salt);
  await writeJson(AUTH_FILE, { ...a, salt, hash, fails: 0, lockUntil: 0 } satisfies OrderAuthFile);
  const what = kind === "pattern" ? "주문 패턴" : "주문 비밀번호";
  await appendLog({ kind: "password", msg: a.hash ? `${what} 변경` : `${what} 처음 설정` });
}

/** 틀리면 세고, 다섯 번이면 30분 잠그고 텔레그램 */
export async function checkPassword(pw: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const a = await loadAuth();
  if (!a.hash) return { ok: false, error: "주문 비밀번호가 아직 없다 — 먼저 정하세요" };
  if (a.lockUntil > Date.now()) {
    const min = Math.ceil((a.lockUntil - Date.now()) / 60_000);
    return { ok: false, error: `비밀번호 잠금 — ${min}분 뒤에` };
  }
  const given = await scryptHex(pw, a.salt);
  const same = sameHexSafe(given, a.hash);
  if (same) {
    if (a.fails) await writeJson(AUTH_FILE, { ...a, fails: 0 });
    return { ok: true };
  }
  const fails = a.fails + 1;
  const lockUntil = fails >= PW_MAX_FAILS ? Date.now() + PW_LOCK_MS : 0;
  await writeJson(AUTH_FILE, { ...a, fails: lockUntil ? 0 : fails, lockUntil });
  await appendLog({ kind: "lock", msg: lockUntil ? "주문 비밀번호 5회 실패 — 30분 잠금" : `주문 비밀번호 실패 ${fails}회` });
  if (lockUntil) {
    void sendTelegram("🔐 <b>주문 비밀번호 5회 실패 — 30분 잠금</b>\n본인이 아니면 지금 서버의 ORDERS_ENABLED 를 끄세요.", "syslog").catch(
      () => undefined,
    );
    return { ok: false, error: "5회 틀림 — 30분 잠금" };
  }
  return { ok: false, error: `주문 비밀번호가 다릅니다 (${fails}/${PW_MAX_FAILS})` };
}

export async function uiLocked(): Promise<boolean> {
  return (await loadAuth()).uiLocked;
}

export async function setUiLock(locked: boolean): Promise<void> {
  const a = await loadAuth();
  await writeJson(AUTH_FILE, { ...a, uiLocked: locked });
  await appendLog({ kind: "lock", msg: locked ? "화면 잠금" : "화면 잠금 해제" });
}

/* ── 진입 PIN (2026-09-04) ─────────────────────────────────────────────── */

const PIN_MAX_FAILS = 5;
const PIN_LOCK_MS = 30 * 60_000;
/** 처음에는 0000 — 벤티지 요청. 대신 안 바꾸면 화면과 점검이 계속 조른다 */
export const DEFAULT_PIN = "0000";

/** 뻔한 것은 막는다 — 만 가지 중 이 몇 개가 먼저 시도된다 */
const TRIVIAL_PINS = new Set([
  "0000", "1111", "2222", "3333", "4444", "5555", "6666", "7777", "8888", "9999",
  "1234", "4321", "1212", "2580", "0123", "9876",
]);

export async function pinIsDefault(): Promise<boolean> {
  const a = await loadAuth();
  return a.pinHash.length === 0;
}

/**
 * PIN 을 정한다. 처음이면 그냥, 이미 있으면 **지금 PIN 또는 주문 비밀번호**로 확인한다 —
 * PIN 을 잊었을 때 주문 비밀번호로 되돌릴 길이 있어야 파일을 지우는 일이 안 생긴다.
 */
export async function setOrderPin(next: string, current: string, kind: "pin" | "pattern" = "pin"): Promise<void> {
  const pin = next.replace(/\D/g, "");
  if (kind === "pattern") {
    /*
     * 패턴 — 3×3 점 인덱스(0~8)를 이은 순서. 네 점부터, 같은 점을 두 번 못 밟는다.
     * 화면(PatternPad)이 이미 막지만, 서버가 믿을 것은 서버가 본 값뿐이다.
     */
    if (pin.length < 4) throw new Error("패턴은 점 네 개 이상을 이어야 합니다");
    if (pin.length > 9) throw new Error("패턴이 너무 깁니다");
    if (/[^0-8]/.test(pin)) throw new Error("패턴 값이 이상합니다");
    if (new Set(pin).size !== pin.length) throw new Error("같은 점을 두 번 지났습니다");
    /* 한 줄·한 열·대각선을 그대로 긋는 것은 PIN 의 1234 다 */
    if (/^(012|345|678|036|147|258|048|246)/.test(pin) && pin.length <= 4)
      throw new Error("너무 뻔한 패턴입니다 — 한 줄로만 긋는 것은 막습니다");
  } else {
    if (pin.length !== 4) throw new Error("네 자리 숫자로");
    if (TRIVIAL_PINS.has(pin)) throw new Error("너무 뻔한 숫자입니다 — 0000·1234 같은 것은 막습니다");
  }
  const a = await loadAuth();
  if (a.pinHash) {
    const byPin = await checkPin(current, { count: false });
    if (!byPin.ok) {
      const byPw = await checkPassword(current);
      if (!byPw.ok) throw new Error("지금 PIN 또는 주문 비밀번호가 다릅니다");
    }
  }
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptHex(pin, salt);
  await writeJson(AUTH_FILE, { ...a, pinSalt: salt, pinHash: hash, pinFails: 0, pinLockUntil: 0 } satisfies OrderAuthFile);
  const what = kind === "pattern" ? "진입 패턴" : "진입 PIN";
  await appendLog({ kind: "password", msg: a.pinHash ? `${what} 변경` : `${what} 처음 설정` });
}

/**
 * PIN 확인. **잠금이 이 문의 전부다** — 네 자리는 만 가지라, 마음껏 두드리게 두면 하루면 뚫린다.
 * 다섯 번에 30분이면 하루 240번, 만 가지를 다 밟는 데 40일이 넘고 그 전에 알림이 먼저 간다.
 */
export async function checkPin(
  pin: string,
  opts: { count?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  const count = opts.count !== false;
  const a = await loadAuth();
  if (a.pinLockUntil > Date.now()) {
    const min = Math.ceil((a.pinLockUntil - Date.now()) / 60_000);
    return { ok: false, error: `PIN 잠금 — ${min}분 뒤에` };
  }
  const given = pin.replace(/\D/g, "");
  /* 아직 안 정했으면 기본값과 견준다 — 화면이 「기본값이다」를 계속 알린다 */
  const ok = a.pinHash
    ? sameHexSafe(await scryptHex(given, a.pinSalt), a.pinHash)
    : given === DEFAULT_PIN;
  if (ok) {
    if (a.pinFails && count) await writeJson(AUTH_FILE, { ...a, pinFails: 0 });
    return { ok: true };
  }
  if (!count) return { ok: false, error: "PIN 이 다릅니다" };
  const fails = a.pinFails + 1;
  const lock = fails >= PIN_MAX_FAILS ? Date.now() + PIN_LOCK_MS : 0;
  await writeJson(AUTH_FILE, { ...a, pinFails: lock ? 0 : fails, pinLockUntil: lock });
  await appendLog({ kind: "lock", msg: lock ? "진입 PIN 5회 실패 — 30분 잠금" : `진입 PIN 실패 ${fails}회` });
  if (lock) {
    void sendTelegram(
      "\u{1F513} <b>주문 진입 PIN 5회 실패 — 30분 잠금</b>\n본인이 아니면 지금 서버의 ORDERS_ENABLED 를 끄세요.",
      "syslog",
    ).catch(() => undefined);
    return { ok: false, error: "5회 틀림 — 30분 잠금" };
  }
  return { ok: false, error: `PIN 이 다릅니다 (${fails}/${PIN_MAX_FAILS})` };
}

/** 시간 일정 비교 — `Buffer.equals` 는 첫 다른 바이트에서 멈춘다. 해시 비교엔 그것도 안 쓴다 */
function sameHexSafe(a: string, b: string): boolean {
  return sameHex(a, b);
}

/* ── 두 단계 (L4) ─────────────────────────────────────────────────────── */

export interface OrderTicket {
  kind: "order";
  side: OrderSide;
  code: string;
  name: string;
  qty: number;
  /** null = 값을 안 보내는 구분(시장가·최유리·최우선·시간외 종가 계열) */
  price: number | null;
  /** 스톱지정가의 발동가(cond_uv). 그 밖에는 null */
  condPrice: number | null;
  /** trde_tp */
  tradeType: string;
  /** 화면·텔레그램에 그대로 쓰는 이름 */
  tradeLabel: string;
  venue: OrderVenue;
  refPrice: number;
  amount: number;
  /**
   * **신용** (2026-09-07). 매수는 `kt10006`(융자), 매도는 `kt10007`(융자 상환)로 `/crdordr` 에 낸다.
   * 매도엔 **대출일**이 있어야 한다 — 잔고 줄의 `crd_loan_dt`. 같은 종목을 두 날 나눠 융자로
   * 샀으면 잔고에 두 줄이라, 어느 줄을 파는지 사람이 고른다(화면의 「잔고에서 고르기」).
   */
  credit: boolean;
  loanDate: string | null;
  /**
   * **자동감시** (2026-09-07 밤). null 이면 보통 주문. 있으면 실행 단계에서 키움에 안 내고
   * `orderWatch.json` 에 적힌다 — 서버가 값을 보다가 `spec.trigger` 에 닿으면 `spec.exec` 대로 낸다.
   */
  watch: WatchSpec | null;
  /**
   * **출구 계획** (2026-09-07 밤, 개편 ①) — 지금 내는 매수에 붙는 단계. 체결되면 단계마다 매도 감시가
   * 자동으로 걸린다. 벤티지: "매수할 때 출구를 같이 정한다." 없이 사려면 화면에서 일부러 꺼야 한다.
   */
  exit: WatchLeg[] | null;
}

export type WatchDir = "le" | "ge";
export type WatchBasis = "price" | "prevClose" | "avg" | "now";
export type WatchExec = "market" | "limit_trigger" | "limit_now" | "limit_fixed";
export interface WatchSpec {
  /** le: 이하가 되면 · ge: 이상이 되면 */
  dir: WatchDir;
  /** price: 값을 바로 적음 · prevClose/avg/now: 기준가 대비 pct */
  basis: WatchBasis;
  pct: number | null;
  basisPrice: number | null;
  /** 발동가(절대값, 호가 단위) */
  trigger: number;
  /** 닿으면 어떻게 내나 — 시장가 · 지정가(발동가) · 지정가(그때 현재가) · 지정가(적은 값) */
  exec: WatchExec;
  limitPrice: number | null;
  /** 유효한 마지막 날(KST) — 그날 장이 끝나면 만료 */
  validUntil: string;
  /**
   * 매수 감시가 체결되면 자동으로 거는 매도 감시 — **단계**(2026-09-07 밤, 벤티지: "몇 프로만 팔 건지도
   * 설정해야지"). 체결가 대비 pct 에 체결 수량의 qtyPct 만큼. 예: [−3%·50%·시장가, −7%·50%·시장가].
   */
  then: WatchLeg[] | null;
  /**
   * 매도 감시를 **단계로 나눠** 거는 틀 — 기준가 대비 pct 에 대상 수량의 qtyPct. 실행 단계에서 단계마다
   * 감시 한 건씩 태어나고(같은 groupId), 이 틀 자체는 저장되지 않는다.
   */
  legs?: WatchLeg[] | null;
  /**
   * **수정** (2026-09-07 밤) — 이 감시가 등록되는 순간 `replaceId` 의 옛 감시를 「수정으로 대체」로 접는다.
   * 수정도 새 주문서다: 확인 창·비밀번호를 그대로 지난다. 옛것을 제자리에서 고치는 길은 없다.
   */
  replaceId?: string | null;
  /**
   * **이중 손절** (개편 ②) — 「이하면 판다」 감시에 키움 스톱지정가(trde_tp 28)를 거래일 아침마다 같이 건다.
   * 키움이 지켜보니 서버가 죽어도 판다. 서버 감시가 먼저 닿으면 그 스톱을 취소하고 시장가로 낸다.
   */
  dual?: boolean;
}

export interface CancelTicket {
  kind: "cancel";
  ordNo: string;
  code: string;
  name: string;
  qty: number;
  venue: OrderVenue;
}

export type Ticket = OrderTicket | CancelTicket;

const NONCE_MS = 30_000;
/**
 * 주문서는 **만든 세션만** 실행할 수 있다 (2026-09-07 보안 점검).
 * nonce 는 128비트라 못 맞히지만, 맞히는 것과 별개로 「내가 만든 주문서를 내가 실행한다」는
 * 성질은 코드로 못 박아 둔다 — 세션이 하나 새면 그 세션이 만든 것만 나간다.
 */
const pending = new Map<string, { exp: number; ticket: Ticket; owner: OrderSession | null }>();

function issueNonce(ticket: Ticket, owner: OrderSession | null): { nonce: string; expiresAt: number } {
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + NONCE_MS;
  pending.set(nonce, { exp: expiresAt, ticket, owner });
  return { nonce, expiresAt };
}

export interface PrepareInput {
  side: OrderSide;
  code: string;
  name: string;
  qty: number;
  price: number | null;
  condPrice: number | null;
  tradeType: string;
  venue: OrderVenue;
  /** 신용(융자) 주문 — 기본 false */
  credit?: boolean;
  /** 신용 매도의 대출일(YYYYMMDD). 신용 매수엔 없다 */
  loanDate?: string | null;
  /** 자동감시 — 조건에 닿으면 내 달라 (2026-09-07 밤) */
  watch?: WatchInput | null;
  /** 지금 내는 매수에 붙는 출구 계획 — 체결되면 단계마다 매도 감시 (개편 ①) */
  exit?: WatchLeg[] | null;
}

export interface WatchLeg {
  /** 기준가(체결가·평단…) 대비 % — 음수면 손절, 양수면 익절 */
  pct: number;
  /** 대상 수량의 몇 % 를 파나 (1~100). 단계 합은 100 을 못 넘는다 */
  qtyPct: number;
  exec: "market" | "limit_now";
}

export interface WatchInput {
  dir: WatchDir;
  basis: WatchBasis;
  pct: number | null;
  /** basis=price 일 때의 발동가 */
  price: number | null;
  exec: WatchExec;
  limitPrice: number | null;
  validUntil: string | null;
  then: WatchLeg[] | null;
  legs: WatchLeg[] | null;
  /** 수정 — 이 id 의 감시를 대체한다 */
  replaceId?: string | null;
  dual?: boolean;
}

/** 단계 목록을 검사한다 — 하나라도 어긋나면 이유를 돌려준다 */
function checkLegs(legs: WatchLeg[], what: string): string | null {
  if (legs.length === 0 || legs.length > 4) return `${what}는 1~4단계`;
  let sum = 0;
  const seen = new Set<number>();
  for (const l of legs) {
    if (!Number.isFinite(l.pct) || l.pct === 0 || Math.abs(l.pct) > 30) return `${what}의 %가 이상하다 (0 아닌 ±30 이내)`;
    if (!Number.isInteger(l.qtyPct) || l.qtyPct < 1 || l.qtyPct > 100) return `${what}의 수량 %는 1~100`;
    if (l.exec !== "market" && l.exec !== "limit_now") return `${what}는 시장가 또는 지정가(그때 현재가)`;
    if (seen.has(l.pct)) return `${what}에 같은 %가 두 번 있다`;
    seen.add(l.pct);
    sum += l.qtyPct;
  }
  if (sum > 100) return `${what}의 수량 % 합이 ${sum} — 100 을 넘는다`;
  return null;
}

/** 대상 수량을 단계별로 나눈다 — 내림하고, 합이 100 이면 마지막 단계가 나머지를 가져간다 */
function splitQty(total: number, legs: WatchLeg[]): number[] {
  const out = legs.map((l) => Math.floor((total * l.qtyPct) / 100));
  const sum = legs.reduce((a, l) => a + l.qtyPct, 0);
  if (sum === 100) {
    const used = out.reduce((a, b) => a + b, 0);
    out[out.length - 1] += total - used;
  }
  return out;
}

function legsSay(legs: WatchLeg[]): string {
  return legs.map((l) => `${l.pct > 0 ? "+" : ""}${l.pct}%에 ${l.qtyPct}% ${l.exec === "market" ? "시장가" : "지정가"}`).join(" · ");
}

function reject(msg: string, input: Partial<PrepareInput>, ip: string): never {
  noteReject();
  void appendLog({ kind: "reject", ip, side: input.side, code: input.code, name: input.name, qty: input.qty, price: input.price, venue: input.venue, tradeType: input.tradeType, msg });
  throw new Error(msg);
}

/**
 * 주문서를 만든다 — 여기서 **한도를 전부** 잰다. 통과하면 30초짜리 nonce.
 * 현재가는 조회용 클라이언트(ka10001)로 본다 — 주문 앱키는 주문에만 쓴다.
 */
export async function prepareOrder(
  main: KiwoomClient,
  input: PrepareInput,
  ip: string,
  owner: OrderSession | null = null,
): Promise<{ nonce: string; expiresAt: number; ticket: OrderTicket }> {
  if (!ordersEnabled() || !orderClient()) reject("주문 기능이 꺼져 있다", input, ip);
  if (await uiLocked()) reject("화면 잠금 중 — 먼저 풀어야 한다", input, ip);
  if (!/^\d{6}$/.test(input.code)) reject("종목코드가 6자리가 아니다", input, ip);
  if (!Number.isInteger(input.qty) || input.qty <= 0 || input.qty > 100_000) reject("수량이 이상하다", input, ip);
  if (input.price !== null && (!Number.isInteger(input.price) || input.price <= 0)) reject("가격이 이상하다", input, ip);
  if (input.condPrice !== null && (!Number.isInteger(input.condPrice) || input.condPrice <= 0)) {
    reject("조건단가가 이상하다", input, ip);
  }
  if (!VENUES.includes(input.venue)) reject("거래소 구분이 이상하다", input, ip);
  if (input.side !== "buy" && input.side !== "sell") reject("매수·매도 구분이 없다", input, ip);
  /*
   * **모의투자는 KRX 만 받는다** (2026-09-04, 벤티지 실측: 통합(SOR)으로 내니 `RC9000 —
   * 모의투자에서는 지원되지 않는다`).
   *
   * 생각해 보면 당연하다 — NXT 는 실제로 돌아가는 거래소고 SOR 은 키움이 두 시장을 견줘
   * 보내는 실전 기능이다. 모의투자는 그 뒤에 있는 시장이 없다.
   *
   * 여기서 막는 이유: 키움이 거절해도 결과는 같지만, **거절은 기록에 「실패」로 남고 그
   * 이유를 사람이 읽어야 안다.** 못 나갈 주문은 나가기 전에 막고 이유를 화면에 적는 편이 낫다.
   */
  if (orderIsMock() && input.venue !== "KRX") {
    reject("모의투자는 KRX 만 받는다 — 통합(SOR)·NXT 는 실전에서만 (키움 RC9000)", input, ip);
  }

  /* 매매구분마다 「가격을 보내야 하나」가 다르다 — 표가 유일한 기준이다 (2026-09-04) */
  const tt = tradeTypeOf(input.tradeType);
  if (!tt) reject("매매구분을 모르겠다", input, ip);
  if (tt.price === "req" && input.price === null) reject(`${tt.label} 는 주문단가가 있어야 한다`, input, ip);
  if (tt.price === "no" && input.price !== null) reject(`${tt.label} 는 주문단가를 안 쓴다`, input, ip);
  if (tt.cond && input.condPrice === null) reject(`${tt.label} 는 조건단가(발동가)가 있어야 한다`, input, ip);
  if (!tt.cond && input.condPrice !== null) reject(`${tt.label} 는 조건단가를 안 쓴다`, input, ip);

  const g = await getGuard();
  if (g.allowedCodes && g.allowedCodes.length > 0 && !g.allowedCodes.includes(input.code)) {
    reject("허용 종목이 아니다 (orderGuard.allowedCodes)", input, ip);
  }
  const credit = input.credit === true;
  const loanDate = input.loanDate ?? null;
  if (credit) {
    if (!g.allowCredit) reject('신용 주문이 꺼져 있다 — orderGuard.json 에 "allowCredit": true 를 적어야 켜진다', input, ip);
    if (orderIsMock()) reject("모의투자는 신용 주문을 받지 않는다 (키움 모의는 현금만)", input, ip);
    if (input.side === "sell" && !/^\d{8}$/.test(loanDate ?? "")) {
      reject("신용 매도엔 대출일(YYYYMMDD)이 있어야 한다 — 잔고에서 줄을 골라야 한다", input, ip);
    }
    if (tt.cond) reject("신용 주문엔 스톱지정가를 쓰지 않는다 — 현금 주문으로", input, ip);
  }
  /*
   * 시간외 주문(61·62·81)은 **정규장 밖에 내는 것이 정상**이라 우리 시간창으로 막으면 기능이 죽는다.
   * 그렇다고 시간외 창을 새로 박아 두지는 않는다 — 시간표는 2026-09-14 KRX 애프터시장 개편 때
   * 한 번에 고치기로 한 자리다(docs/다음작업_TODO.md). 그때까지는 키움이 거절하게 둔다.
   */
  const wi = input.watch ?? null;
  let watchSpec: WatchSpec | null = null;
  if (wi) {
    /*
     * 자동감시 (2026-09-07 밤). 영웅문S 「자동감시주문」과 같은 폭 — 조건은 가격 하나(이하/이상),
     * 기준가는 값·전일 종가·평단·지금 값. 닿으면 시장가 또는 지정가(발동가·그때 현재가·적은 값).
     * KRX 체결로만 판정한다(NXT 는 호가가 얇아 한 틱에 헛발동한다 — 손절 감시와 같은 원칙).
     */
    if (!g.allowAutoWatch) reject('자동감시가 꺼져 있다 — orderGuard.json 의 "allowAutoWatch" 를 true 로', input, ip);
    if (input.venue !== "KRX") reject("자동감시는 KRX 로만 낸다 — 판정도 KRX 체결로 한다", input, ip);
    if (credit) reject("자동감시는 신용으로 못 낸다", input, ip);
    if (tt.cond) reject("자동감시엔 스톱지정가를 쓰지 않는다 — 감시가 곧 스톱이다", input, ip);
    if (wi.exec === "market" && tt.code !== "3") reject("시장가로 내는 감시는 매매구분이 시장가여야 한다", input, ip);
    if (wi.exec !== "market" && tt.code !== "0") reject("지정가로 내는 감시는 매매구분이 보통이어야 한다", input, ip);
    const q = await quoteOf(main, input.code);
    if (!q || q.price <= 0) reject("현재가를 못 읽어 감시 조건을 잴 수 없다", input, ip);
    let basisPrice: number | null = null;
    let trigger = 0;
    if (wi.basis === "price") {
      if (!wi.price || !Number.isInteger(wi.price) || wi.price <= 0) reject("발동가가 이상하다", input, ip);
      trigger = wi.price;
    } else {
      if (wi.pct === null || !Number.isFinite(wi.pct) || wi.pct === 0 || Math.abs(wi.pct) > 30) reject("기준가 대비 %가 이상하다 (0 아닌 ±30 이내)", input, ip);
      if (wi.basis === "prevClose") basisPrice = q.prevClose;
      else if (wi.basis === "now") basisPrice = q.price;
      else {
        if (input.side !== "sell") reject("평단 기준은 매도 감시에서만 — 매수엔 평단이 없다", input, ip);
        const acct = await orderAccount().catch(() => null);
        const h = acct?.holdings.find((x) => x.code === input.code && !x.creditType);
        if (!h || h.avg <= 0) reject("잔고에 그 종목이 없어 평단을 모른다", input, ip);
        basisPrice = h.avg;
      }
      if (!basisPrice || basisPrice <= 0) reject("기준가를 못 읽었다", input, ip);
      trigger = toTick(basisPrice * (1 + wi.pct / 100));
    }
    if (trigger <= 0) reject("발동가를 못 정했다", input, ip);
    /* 이미 조건 안이면 감시가 아니라 그냥 주문이다 — 등록 즉시 나가는 것은 사람이 뜻한 게 아니다 */
    if ((wi.dir === "le" && q.price <= trigger) || (wi.dir === "ge" && q.price >= trigger)) {
      reject(`지금 값(${q.price.toLocaleString()})이 이미 조건 안이다 — 감시가 아니라 바로 주문으로`, input, ip);
    }
    const offNow = (Math.abs(trigger - q.price) / q.price) * 100;
    if (offNow > 30) reject(`발동가가 지금 값에서 ${offNow.toFixed(1)}% 떨어져 있다 (30% 이내)`, input, ip);
    if (wi.exec === "limit_fixed") {
      if (!wi.limitPrice || !Number.isInteger(wi.limitPrice) || wi.limitPrice <= 0) reject("지정가 값이 이상하다", input, ip);
      const off = (Math.abs(wi.limitPrice - trigger) / trigger) * 100;
      if (off > g.priceCollarPct) reject(`지정가가 발동가에서 ${off.toFixed(1)}% 벗어났다 (한도 ${g.priceCollarPct}%)`, input, ip);
    }
    const today = kstParts().date;
    let validUntil = wi.validUntil && /^\d{4}-\d{2}-\d{2}$/.test(wi.validUntil) ? wi.validUntil : today;
    if (validUntil < today) validUntil = today;
    if (validUntil > addDays(today, 30)) reject("유효기간은 30일까지", input, ip);
    if (wi.basis === "prevClose" && validUntil !== today) reject("전일 종가 기준은 당일만 — 내일은 기준가가 다르다", input, ip);
    let then: WatchSpec["then"] = null;
    if (wi.then && wi.then.length > 0) {
      if (input.side !== "buy") reject("「체결되면 매도 감시」는 매수 감시에만 붙는다", input, ip);
      const bad = checkLegs(wi.then, "체결 뒤 매도 단계");
      if (bad) reject(bad, input, ip);
      then = wi.then.map((l) => ({ pct: l.pct, qtyPct: l.qtyPct, exec: l.exec }));
    }
    let legs: WatchSpec["legs"] = null;
    if (wi.legs && wi.legs.length > 0) {
      if (input.side !== "sell") reject("단계로 나눠 파는 것은 매도 감시에서만", input, ip);
      if (wi.basis === "price") reject("단계 매도는 기준가(평단·지금 값·전일 종가) 대비로만", input, ip);
      const bad = checkLegs(wi.legs, "매도 단계");
      if (bad) reject(bad, input, ip);
      legs = wi.legs.map((l) => ({ pct: l.pct, qtyPct: l.qtyPct, exec: l.exec }));
      const qs = splitQty(input.qty, legs);
      if (qs.some((n) => n <= 0)) reject("수량이 적어 어느 단계가 0주가 된다 — 단계를 줄이거나 수량을 늘려야 한다", input, ip);
      /* 단계마다 이미 조건 안이면 안 된다 — 그 단계는 등록 즉시 나간다 */
      for (const l of legs) {
        const tr = toTick((basisPrice ?? 0) * (1 + l.pct / 100));
        const d = l.pct < 0 ? "le" : "ge";
        if ((d === "le" && q.price <= tr) || (d === "ge" && q.price >= tr)) {
          reject(`${l.pct > 0 ? "+" : ""}${l.pct}% 단계(${tr.toLocaleString()})는 지금 값(${q.price.toLocaleString()})이 이미 조건 안이다`, input, ip);
        }
      }
    }
    const replaceId = wi.replaceId ?? null;
    const all = await listAutoWatches();
    if (replaceId) {
      const old = all.find((r) => r.id === replaceId);
      if (!old) reject("수정하려는 감시가 없다", input, ip);
      if (old.status !== "waiting") reject(`수정하려는 감시가 이미 ${autoWatchStatusKo(old.status)} — 새로 걸어야 한다`, input, ip);
    }
    const active = all.filter((r) => r.status === "waiting" && r.id !== replaceId);
    /*
     * 겹침 — 매수는 종목당 하나. 매도는 **단계**가 있으니 종목당 여럿이되 같은 발동가는 안 된다.
     * 단계 매도(legs)는 단계 수만큼 자리를 쓴다.
     */
    const legCount = legs ? legs.length : 1;
    if (active.length + legCount > WATCH_MAX) reject(`자동감시는 ${WATCH_MAX}건까지 — 기다리는 것을 먼저 정리해야 한다`, input, ip);
    const sameSide = active.filter((r) => r.ticket.code === input.code && r.ticket.side === input.side);
    if (input.side === "buy" && sameSide.length > 0) {
      reject(`${input.name || input.code} 매수 감시가 이미 있다 — 겹쳐 걸지 않는다`, input, ip);
    }
    if (input.side === "sell") {
      const triggers = legs ? legs.map((l) => toTick((basisPrice ?? 0) * (1 + l.pct / 100))) : [trigger];
      const dup = sameSide.find((r) => triggers.includes(r.spec.trigger));
      if (dup) reject(`${input.name || input.code} 매도 감시에 발동가 ${dup.spec.trigger.toLocaleString()}원이 이미 있다`, input, ip);
      const held = sameSide.reduce((a, r) => a + r.ticket.qty, 0);
      const acct = await orderAccount().catch(() => null);
      /* 이중 스톱이 물고 있는 수는 매매가능에서 빠져 보이지만 우리 감시 몫이다 — 되돌려 센다 */
      const dualLocked = sameSide.filter((r) => r.dualOrdNo).reduce((a, r) => a + r.ticket.qty, 0);
      const able = acct ? acct.holdings.filter((x) => x.code === input.code && !x.creditType).reduce((a, x) => a + x.ableQty, 0) + dualLocked : null;
      if (able !== null && held + input.qty > able) {
        reject(`매도 감시 수량 합(${held + input.qty}주)이 매매가능수량(${able}주)을 넘는다`, input, ip);
      }
    }
    watchSpec = {
      dir: wi.dir,
      basis: wi.basis,
      pct: wi.basis === "price" ? null : wi.pct,
      basisPrice,
      trigger,
      exec: wi.exec,
      limitPrice: wi.exec === "limit_fixed" ? wi.limitPrice : null,
      validUntil,
      then,
      legs,
      replaceId,
      dual: wi.dual !== false,
    };
  }
  if (!watchSpec && g.marketHoursOnly && !tt.late && !venueOpen(input.venue)) {
    reject(`${input.venue} 가 주문을 받는 시간이 아니다`, input, ip);
  }
  let exit: WatchLeg[] | null = null;
  if (input.exit && input.exit.length > 0) {
    if (input.side !== "buy") reject("출구 계획은 매수에만 붙는다", input, ip);
    if (watchSpec) reject("감시 매수는 「체결되면」 단계로 — 출구 계획과 겹친다", input, ip);
    if (credit) reject("신용 매수엔 출구 계획을 못 붙인다", input, ip);
    const bad = checkLegs(input.exit, "출구 계획");
    if (bad) reject(bad, input, ip);
    exit = input.exit.map((l) => ({ pct: l.pct, qtyPct: l.qtyPct, exec: l.exec }));
  }
  if (input.side === "buy") {
    /* 계좌 단위 위험 한도 (개편 ⑤) — 손절 뒤 쿨다운 · 오늘 실현손실 잠금 */
    const block = await buyBlockReason(input.code, g);
    if (block) reject(block, input, ip);
  }

  let ref = 0;
  try {
    ref = (await priceMap(main, [input.code])).get(input.code) ?? 0;
  } catch {
    ref = 0;
  }
  if (input.price === null && ref <= 0 && !watchSpec) reject("현재가를 못 읽어 주문 금액을 잴 수 없다 — 값을 적는 구분으로", input, ip);

  if (watchSpec) {
    /* 감시는 발동가가 멀리 있는 게 정상이다 — 가격 자는 **발동하는 순간** 그때 값으로 잰다 */
  } else if (tt.cond && input.condPrice !== null) {
    /*
     * 스톱은 자를 둘 쓴다.
     *   발동가 ↔ 현재가   넓게(stopCollarPct) — 손절선은 원래 멀리 둔다
     *   주문가 ↔ 발동가   좁게(priceCollarPct) — 둘이 멀면 그건 오타다
     */
    if (ref > 0) {
      const offCond = (Math.abs(input.condPrice - ref) / ref) * 100;
      if (offCond > g.stopCollarPct) {
        reject(
          `발동가가 현재가(${ref.toLocaleString()})에서 ${offCond.toFixed(1)}% 벗어났다 (한도 ${g.stopCollarPct}%)`,
          input,
          ip,
        );
      }
    }
    if (input.price !== null) {
      const offOrd = (Math.abs(input.price - input.condPrice) / input.condPrice) * 100;
      if (offOrd > g.priceCollarPct) {
        reject(
          `주문단가가 발동가(${input.condPrice.toLocaleString()})에서 ${offOrd.toFixed(1)}% 벗어났다 (한도 ${g.priceCollarPct}%)`,
          input,
          ip,
        );
      }
    }
  } else if (input.price !== null && ref > 0) {
    const off = (Math.abs(input.price - ref) / ref) * 100;
    if (off > g.priceCollarPct) {
      reject(`지정가가 현재가(${ref.toLocaleString()})에서 ${off.toFixed(1)}% 벗어났다 (한도 ${g.priceCollarPct}%)`, input, ip);
    }
  }
  const unit = watchSpec ? (watchSpec.limitPrice ?? watchSpec.trigger) : (input.price ?? input.condPrice ?? ref);
  const amount = unit * input.qty;
  if (input.side === "buy" && g.maxPositionPct > 0 && g.maxPositionPct < 100) {
    /* 종목 하나가 계좌의 몇 %까지 — 이미 든 것 + 이번 것 */
    const acct = await orderAccount().catch(() => null);
    if (acct) {
      const equity = acct.deposit + acct.holdings.reduce((a, h) => a + h.cur * h.qty, 0);
      const already = acct.holdings.filter((h) => h.code === input.code).reduce((a, h) => a + h.cur * h.qty, 0);
      if (equity > 0 && ((already + amount) / equity) * 100 > g.maxPositionPct) {
        reject(`한 종목 비중 초과 — ${input.name || input.code} ${(((already + amount) / equity) * 100).toFixed(0)}% > ${g.maxPositionPct}% (orderGuard.maxPositionPct)`, input, ip);
      }
    }
  }
  if (amount > g.maxOrderKrw) reject(`한 건 한도 초과 — ${amount.toLocaleString()}원 > ${g.maxOrderKrw.toLocaleString()}원`, input, ip);
  if (watchSpec) {
    const active = (await listAutoWatches()).filter((r) => r.status === "waiting" && r.id !== (watchSpec.replaceId ?? null));
    const sum = active.reduce((a, r) => a + r.ticket.amount, 0);
    if (sum + amount > g.maxDailyKrw) {
      reject(`감시 합이 하루 한도를 넘는다 — 기다리는 ${sum.toLocaleString()}원 + 이번 ${amount.toLocaleString()}원 > ${g.maxDailyKrw.toLocaleString()}원`, input, ip);
    }
  } else {
    const used = await todayUsage();
    if (used.krw + amount > g.maxDailyKrw) {
      reject(`오늘 한도 초과 — 이미 ${used.krw.toLocaleString()}원 + 이번 ${amount.toLocaleString()}원 > ${g.maxDailyKrw.toLocaleString()}원`, input, ip);
    }
    if (used.count + 1 > g.maxDailyCount) reject(`오늘 건수 한도 초과 — ${used.count}/${g.maxDailyCount}`, input, ip);
  }

  const ticket: OrderTicket = {
    kind: "order",
    side: input.side,
    code: input.code,
    name: input.name.slice(0, 40),
    qty: input.qty,
    price: input.price,
    condPrice: input.condPrice,
    tradeType: tt.code,
    tradeLabel: tt.label,
    venue: input.venue,
    refPrice: ref,
    amount,
    credit,
    loanDate: credit && input.side === "sell" ? loanDate : null,
    watch: watchSpec,
    exit,
  };
  return { ...issueNonce(ticket, owner), ticket };
}

/**
 * 신규 매수를 막을 이유 (개편 ⑤). 자동감시의 매수 발동도 같은 자를 쓴다.
 *   · 손절 매도 감시가 발동한 종목은 rebuyCooldownMin 동안 다시 안 산다
 *   · 오늘 자동감시 매도로 실현한 손실이 maxDailyLossKrw 를 넘으면 신규 매수 잠금
 */
async function buyBlockReason(code: string, g: OrderGuard): Promise<string | null> {
  const rows = await readWatches().catch(() => [] as AutoWatch[]);
  const now = Date.now();
  if (g.rebuyCooldownMin > 0) {
    const cool = rows.find(
      (r) => r.ticket.code === code && r.ticket.side === "sell" && r.spec.dir === "le" && r.firedAt && (r.status === "fired" || r.status === "filled") && now - Date.parse(r.firedAt) < g.rebuyCooldownMin * 60_000,
    );
    if (cool) return `손절 뒤 쿨다운 — ${cool.ticket.name} 은 ${g.rebuyCooldownMin}분 동안 다시 안 산다 (${localHm(cool.firedAt!)} 발동)`;
  }
  if (g.maxDailyLossKrw > 0) {
    const loss = realizedLossToday(rows);
    if (loss <= -g.maxDailyLossKrw) return `오늘 실현손실 ${won(loss)} — 하루 한도(−${won(g.maxDailyLossKrw)})를 넘어 신규 매수를 잠갔다`;
  }
  return null;
}

/** 오늘 자동감시 매도가 체결되며 실현한 손익의 합 — 발동 순간의 평단(avgAtFire)과 체결가로 */
function realizedLossToday(rows: AutoWatch[]): number {
  const { date } = kstParts();
  let sum = 0;
  for (const r of rows) {
    if (r.ticket.side !== "sell" || r.status !== "filled" || !r.fillPrice || !r.fillQty || !r.avgAtFire) continue;
    if (!r.firedAt || kstParts(new Date(r.firedAt)).date !== date) continue;
    sum += (r.fillPrice - r.avgAtFire) * r.fillQty;
  }
  return sum;
}

function localHm(iso: string): string {
  const t = new Date(new Date(iso).getTime() + 9 * 3600_000);
  return t.toISOString().slice(11, 16);
}

export async function prepareCancel(
  input: { ordNo: string; code: string; name: string; qty: number; venue: OrderVenue },
  ip: string,
  owner: OrderSession | null = null,
): Promise<{ nonce: string; expiresAt: number; ticket: CancelTicket }> {
  if (!ordersEnabled() || !orderClient()) reject("주문 기능이 꺼져 있다", input, ip);
  if (await uiLocked()) reject("화면 잠금 중", input, ip);
  if (!/^[\w-]{1,20}$/.test(input.ordNo)) reject("주문번호가 이상하다", input, ip);
  if (!VENUES.includes(input.venue)) reject("거래소 구분이 이상하다", input, ip);
  const ticket: CancelTicket = {
    kind: "cancel",
    ordNo: input.ordNo,
    code: input.code,
    name: input.name.slice(0, 40),
    qty: input.qty,
    venue: input.venue,
  };
  return { ...issueNonce(ticket, owner), ticket };
}

/* ── 실행 ─────────────────────────────────────────────────────────────── */

/**
 * **유일하게 키움에 주문을 쏘는 곳.** export 하지 않는다. 호출자는 아래 executePrepared 하나.
 * 정정(kt10002)은 아직 안 만든다 — 취소하고 다시 내면 된다. 길을 하나라도 덜 만드는 편이 낫다.
 */
async function placeOrder(t: Ticket): Promise<{ ordNo: string; msg: string; raw: unknown }> {
  const oc = orderClient();
  if (!oc) throw new Error("주문 앱키가 없다");
  let apiId: string;
  let body: Record<string, string>;
  if (t.kind === "cancel") {
    apiId = "kt10003";
    body = { dmst_stex_tp: t.venue, orig_ord_no: t.ordNo, stk_cd: t.code, cncl_qty: "0" }; // 0 = 잔량 전부
  } else if (t.credit) {
    /*
     * 신용(융자) — 공식 예제 `examples/국내주식/신용주문/*.py` (2026-09-07 확인).
     *   매수 kt10006: 현금 매수와 같은 몸통. 융자 종류는 계좌 설정을 따른다(몸통에 칸이 없다)
     *   매도 kt10007: `crd_deal_tp` 33(융자) + `crd_loan_dt` 대출일 — 어느 융자를 갚는지
     */
    apiId = t.side === "buy" ? "kt10006" : "kt10007";
    body = {
      dmst_stex_tp: t.venue,
      stk_cd: t.code,
      ord_qty: String(t.qty),
      ord_uv: t.price === null ? "" : String(t.price),
      trde_tp: t.tradeType,
      cond_uv: "",
      ...(t.side === "sell" ? { crd_deal_tp: "33", crd_loan_dt: t.loanDate ?? "" } : {}),
    };
  } else {
    apiId = t.side === "buy" ? "kt10000" : "kt10001";
    body = {
      dmst_stex_tp: t.venue,
      stk_cd: t.code,
      ord_qty: String(t.qty),
      ord_uv: t.price === null ? "" : String(t.price),
      trde_tp: t.tradeType, // 표는 TRADE_TYPES — 28 이 스톱지정가다
      cond_uv: t.condPrice === null ? "" : String(t.condPrice), // 스톱 발동가
    };
  }
  const resource = t.kind === "order" && t.credit ? CREDIT_ORDER_RESOURCE : ORDER_RESOURCE;
  const { data } = await oc.request<Record<string, unknown>>(resource, apiId, body, { noAl: true });
  return { ordNo: String(data.ord_no ?? ""), msg: String(data.return_msg ?? ""), raw: data };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function won(n: number): string {
  return `${Math.round(n).toLocaleString()}원`;
}

/** nonce + 주문 비밀번호가 맞아야 여기를 지난다. 한 번 쓴 nonce 는 지운다 */
export async function executePrepared(
  nonce: string,
  password: string,
  ip: string,
  opts: { session?: OrderSession | null; remember?: boolean } = {},
): Promise<{ ordNo: string; msg: string; ticket: Ticket; remembered: boolean }> {
  const p = pending.get(nonce);
  if (!p || p.exp < Date.now()) {
    pending.delete(nonce);
    throw new Error("주문서가 만료됐다(30초) — 다시 만드세요");
  }
  /* 다른 세션이 만든 주문서는 실행하지 않는다 — 그리고 그 주문서는 태운다 */
  if (p.owner !== (opts.session ?? null)) {
    pending.delete(nonce);
    await appendLog({ kind: "reject", ip, msg: "다른 세션의 주문서를 실행하려 했다 — 주문서 폐기" });
    throw new Error("이 주문서는 이 세션의 것이 아니다 — 다시 만드세요");
  }

  /*
   * 비밀번호 — **기억하기**가 켜져 있고 이 세션이 아직 시한 안이면 다시 안 묻는다 (2026-09-04).
   *
   * 기억하는 것은 비밀번호가 아니라 **「이 세션은 확인됐다」는 시각 하나**다. 브라우저에도
   * 파일에도 비밀번호는 안 남는다. 시한은 주문 세션의 최대 수명을 못 넘고(아래 Math.min),
   * 세션이 닫히면 같이 사라진다 — 「닫기」를 누르면 그 자리에서 무효가 된다.
   */
  const sess = opts.session ?? null;
  const cfg = await getSettings();
  const graced = Boolean(sess && cfg.rememberPassword && sess.pwUntil > Date.now());
  let remembered = graced;
  if (!graced) {
    const pw = await checkPassword(password);
    if (!pw.ok) throw new Error(pw.error);
    if (sess && cfg.rememberPassword && opts.remember) {
      sess.pwUntil = Math.min(Date.now() + cfg.rememberMinutes * 60_000, sess.hard);
      remembered = true;
      await appendLog({ kind: "password", ip, msg: `비밀번호 기억 시작 — ${cfg.rememberMinutes}분` });
    }
  }
  pending.delete(nonce);
  if (await uiLocked()) throw new Error("화면 잠금 중");
  if (!ordersEnabled()) throw new Error("주문 기능이 꺼져 있다");
  const t = p.ticket;
  const mock = orderIsMock();
  const tag = mock ? "[모의]" : "[실전]";
  if (t.kind === "order" && t.watch && t.watch.legs && t.watch.legs.length > 0) {
    /* 단계 매도 — 단계마다 감시 한 건. 같은 groupId. 한 번의 비밀번호로 여럿이 걸린다(확인 창에 단계가 다 적혀 있었다) */
    const legs = t.watch.legs;
    const qs = splitQty(t.qty, legs);
    const groupId = randomBytes(4).toString("hex");
    const ids: string[] = [];
    for (let i = 0; i < legs.length; i++) {
      const l = legs[i];
      const trigger = toTick((t.watch.basisPrice ?? 0) * (1 + l.pct / 100));
      const spec: WatchSpec = {
        dir: l.pct < 0 ? "le" : "ge",
        basis: t.watch.basis,
        pct: l.pct,
        basisPrice: t.watch.basisPrice,
        trigger,
        exec: l.exec,
        limitPrice: null,
        validUntil: t.watch.validUntil,
        then: null,
      };
      const leg: OrderTicket = {
        ...t,
        qty: qs[i],
        price: null,
        condPrice: null,
        tradeType: l.exec === "market" ? "3" : "0",
        tradeLabel: l.exec === "market" ? "시장가" : "보통(지정가)",
        amount: trigger * qs[i],
        watch: spec,
      };
      const row = await addAutoWatch(leg, ip, undefined, groupId);
      ids.push(row.id);
    }
    if (t.watch.replaceId) await retireAutoWatch(t.watch.replaceId, ids[0]);
    await appendLog({ kind: "watch", ip, side: t.side, code: t.code, name: t.name, qty: t.qty, tradeType: t.tradeType, venue: t.venue, amount: t.amount, msg: `단계 매도 감시 ${legs.length}건 등록 (${ids.join(",")}) — ${legsSay(legs)}` });
    void sendTelegram(
      `👁 ${tag} <b>단계 매도 감시 등록</b> ${esc(t.name)} ${t.qty}주를 ${legs.length}단계로\n${esc(legsSay(legs))}\n${t.watch.validUntil} 까지 · 주문 › 자동감시 탭`,
      "order",
    ).catch(() => undefined);
    return { ordNo: "", msg: `단계 매도 감시 ${legs.length}건 등록 — ${legsSay(legs)}`, ticket: t, remembered };
  }
  if (t.kind === "order" && t.watch) {
    const row = await addAutoWatch(t, ip);
    const sideKo = t.side === "buy" ? "매수" : "매도";
    const replaced = t.watch.replaceId ? await retireAutoWatch(t.watch.replaceId, row.id) : false;
    await appendLog({ kind: "watch", ip, side: t.side, code: t.code, name: t.name, qty: t.qty, price: t.watch.limitPrice, tradeType: t.tradeType, venue: t.venue, amount: t.amount, msg: `${replaced ? `감시 수정 (${t.watch.replaceId} → ${row.id})` : `감시 등록 (${row.id})`} — ${watchSay(t.watch)}` });
    void sendTelegram(
      `👁 ${tag} <b>자동감시 ${sideKo} ${replaced ? "수정" : "등록"}</b> ${esc(t.name)} ${t.qty}주\n${esc(watchSay(t.watch))}\n${t.watch.validUntil} 까지 · 주문 › 자동감시 탭에서 취소`,
      "order",
    ).catch(() => undefined);
    return { ordNo: "", msg: `감시 ${replaced ? "수정" : "등록"} — ${watchSay(t.watch)}`, ticket: t, remembered };
  }
  try {
    const r = await placeOrder(t);
    if (t.kind === "cancel") {
      await appendLog({ kind: "cancel", ip, code: t.code, name: t.name, qty: t.qty, venue: t.venue, origOrdNo: t.ordNo, ordNo: r.ordNo, msg: r.msg, raw: r.raw });
      unwatch(t.ordNo);
      void sendTelegram(`🧾 ${tag} <b>취소</b> ${esc(t.name)} ${t.qty}주 (원주문 ${esc(t.ordNo)})\n${esc(r.msg)}`, "order").catch(() => undefined);
    } else {
      await appendLog({ kind: "order", ip, side: t.side, code: t.code, name: t.name, qty: t.qty, price: t.price, condPrice: t.condPrice, tradeType: t.tradeType, venue: t.venue, ordNo: r.ordNo, amount: t.amount, credit: t.credit, msg: graced ? `${r.msg} · 비밀번호 기억으로` : r.msg, raw: r.raw });
      /* 신용은 이름부터 다르게 — 알림에서 「매수」와 「신용매수」가 같아 보이면 빚이 조용히 는다 */
      const sideKo = (t.credit ? "신용" : "") + (t.side === "buy" ? "매수" : "매도");
      const priceKo = t.price === null ? "시장가" : `${t.price.toLocaleString()}원`;
      void sendTelegram(
        `🧾 ${tag} <b>${sideKo} 주문</b> ${esc(t.name)} ${t.qty}주 @ ${priceKo} · ${t.venue}\n금액 ${won(t.amount)} · 주문번호 ${esc(r.ordNo || "?")}\n${esc(r.msg)}`,
        "order",
      ).catch(() => undefined);
      if (r.ordNo) watch(r.ordNo, t);
      void noteUsage();
      /*
       * 출구 계획 (개편 ①) — 지금 낸 매수가 체결되면 단계마다 매도 감시가 걸리도록, 「발동된 감시」 모양의
       * 줄을 하나 적어 두고 체결 감시에 갈고리를 건다. 자동감시 매수와 같은 길(onAutoWatchFill)이라
       * 포지션 카드도 같은 모양으로 보인다.
       */
      if (t.side === "buy" && t.exit && t.exit.length > 0 && r.ordNo) {
        const spec: WatchSpec = {
          dir: "le",
          basis: "price",
          pct: null,
          basisPrice: null,
          trigger: t.price ?? t.refPrice,
          exec: t.price === null ? "market" : "limit_fixed",
          limitPrice: t.price,
          validUntil: kstParts().date,
          then: t.exit,
        };
        const row = await addAutoWatch({ ...t, watch: spec, exit: null }, ip, undefined, undefined, { status: "fired", ordNo: r.ordNo, origin: "order", firePrice: t.refPrice });
        const id = row.id;
        fillHooks.set(r.ordNo, (ev) => void onAutoWatchFill(id, ev).catch(() => undefined));
        await appendLog({ kind: "watch", ip, side: "buy", code: t.code, name: t.name, qty: t.qty, msg: `출구 계획 붙임 (${id}) — 체결되면 체결가 대비 ${legsSay(t.exit)} 매도 감시` });
      }
    }
    return { ordNo: r.ordNo, msg: r.msg, ticket: t, remembered };
  } catch (e) {
    const msg = e instanceof KiwoomApiError ? `${e.returnCode} ${e.message}` : e instanceof Error ? e.message : String(e);
    await appendLog({ kind: "error", ip, code: t.code, name: t.name, qty: t.qty, venue: t.venue, msg, raw: e instanceof KiwoomApiError ? e.raw : undefined });
    void sendTelegram(`⚠️ ${tag} 주문 실패 ${esc(t.name)}\n${esc(msg)}`, "order").catch(() => undefined);
    throw new Error(`키움이 거절했다: ${msg}`);
  }
}

/* ── 조회 (주문 계좌 기준) ────────────────────────────────────────────── */

function num(v: unknown): number {
  if (typeof v === "number") return v;
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v === undefined || v === null ? "" : String(v).trim();
}

function pick(row: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) if (row[k] !== undefined && row[k] !== "") return row[k];
  return undefined;
}

function listOf(data: Record<string, unknown>, keys: string[]): Record<string, unknown>[] {
  for (const k of keys) {
    const v = data[k];
    if (Array.isArray(v)) return v as Record<string, unknown>[];
  }
  // 이름을 모르면 첫 배열
  for (const v of Object.values(data)) if (Array.isArray(v)) return v as Record<string, unknown>[];
  return [];
}

export interface OpenRow {
  ordNo: string;
  code: string;
  name: string;
  side: string;
  qty: number;
  price: number;
  remain: number;
  filled: number;
  venue: string;
  time: string;
  status: string;
  /** 스톱지정가 발동가 — 0 이면 스톱 주문이 아니다 */
  stopPrice: number;
  raw: Record<string, unknown>;
}

const rawSeen = new Set<string>();

/** 첫 응답의 원문을 하루 한 번 기록 — 필드명 실측용 */
async function noteRaw(apiId: string, data: unknown): Promise<void> {
  const key = `${apiId}:${kstParts().date}`;
  if (rawSeen.has(key)) return;
  rawSeen.add(key);
  await appendLog({ kind: "raw", msg: apiId, raw: data });
}

function normOpen(r: Record<string, unknown>): OpenRow {
  return {
    ordNo: str(pick(r, ["ord_no"])),
    code: str(pick(r, ["stk_cd"])).replace(/_.*$/, "").replace(/^A/, ""),
    name: str(pick(r, ["stk_nm"])),
    side: str(pick(r, ["io_tp_nm", "sell_tp", "trde_tp"])),
    qty: num(pick(r, ["ord_qty"])),
    price: num(pick(r, ["ord_pric", "ord_uv"])),
    remain: num(pick(r, ["oso_qty", "unfilled_qty"])),
    filled: num(pick(r, ["cntr_qty"])),
    /* 공식 명세: stex_tp 는 코드(0 통합·1 KRX·2 NXT), stex_tp_txt 가 사람이 읽는 이름 */
    venue: str(pick(r, ["stex_tp_txt", "stex_tp", "dmst_stex_tp"])),
    /* 미체결은 tm, 체결은 ord_tm 이다 — 둘 다 본다 */
    time: str(pick(r, ["tm", "ord_tm"])),
    status: str(pick(r, ["ord_stt"])),
    /** 스톱지정가로 낸 주문이면 발동가가 돌아온다 (2026-09-04) */
    stopPrice: num(pick(r, ["stop_pric"])),
    raw: r,
  };
}

/**
 * 짧은 캐시 + 겹침 합치기 (2026-09-07 밤). 미체결 탭(5초)·체결 탭(8초)·체결 감시(5초)·잔고 탭이 같은
 * 조회를 각자 부르면 주문 앱키에 초당 몇 번씩 나가고, 키움이 429 로 밀어내면 화면이 느려진다 —
 * 벤티지: "체결/미체결은 클릭하면 반응도 느리고." 2.5초 안의 같은 조회는 한 번만 나간다.
 */
const shortCache = new Map<string, { at: number; p: Promise<unknown> }>();
function memo<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = shortCache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.p as Promise<T>;
  const p = fn().catch((e) => {
    shortCache.delete(key);
    throw e;
  });
  shortCache.set(key, { at: Date.now(), p });
  return p;
}

export async function openOrders(): Promise<OpenRow[]> {
  return memo("open", 2_500, openOrdersRaw);
}
export async function fills(): Promise<OpenRow[]> {
  return memo("fills", 2_500, fillsRaw);
}

async function openOrdersRaw(): Promise<OpenRow[]> {
  const oc = orderClient();
  if (!oc) return [];
  const { data } = await oc.request<Record<string, unknown>>(ACNT_RESOURCE, "ka10075", {
    all_stk_tp: "0",
    trde_tp: "0",
    stk_cd: "",
    stex_tp: "0",
  });
  void noteRaw("ka10075", data);
  return listOf(data, ["oso"]).map(normOpen);
}

async function fillsRaw(): Promise<OpenRow[]> {
  const oc = orderClient();
  if (!oc) return [];
  const { data } = await oc.request<Record<string, unknown>>(ACNT_RESOURCE, "ka10076", {
    stk_cd: "",
    qry_tp: "0",
    sell_tp: "0",
    ord_no: "",
    stex_tp: "0",
  });
  void noteRaw("ka10076", data);
  return listOf(data, ["cntr"]).map((r) => {
    const o = normOpen(r);
    // 체결 조회는 체결가·체결량이 따로 온다
    o.price = num(pick(r, ["cntr_pric"])) || o.price;
    return o;
  });
}

/** 예수금(kt00001)·잔고(kt00018) — **주문 계좌**의 것. /api/account 는 조회용 앱키의 계좌라 다를 수 있다 */
export interface Holding {
  code: string;
  name: string;
  /** 보유수량 */
  qty: number;
  /** **매매가능수량** — 미체결 매도·미결제가 빠진 수. 「전량 매도」는 이걸 써야 한다 */
  ableQty: number;
  avg: number;
  cur: number;
  pnl: number;
  pnlRate: number;
  /** 신용 줄이면 구분명(「융자」 등)과 대출일 — 현금 줄은 null. 신용 매도의 열쇠다 */
  creditType: string | null;
  loanDate: string | null;
}

export async function orderAccount(): Promise<{
  deposit: number;
  /** 총융자금액 — 신용으로 산 것의 합. 0 이면 신용 없음 */
  creditLoan: number;
  holdings: Holding[];
}> {
  return memo("account", 2_500, orderAccountRaw);
}

async function orderAccountRaw(): Promise<{ deposit: number; creditLoan: number; holdings: Holding[] }> {
  const oc = orderClient();
  if (!oc) return { deposit: 0, creditLoan: 0, holdings: [] };
  const [dep, bal] = await Promise.all([
    oc.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00001", { qry_tp: "3" }).catch(() => null),
    oc.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00018", { qry_tp: "2", dmst_stex_tp: "KRX" }).catch(() => null),
  ]);
  const deposit = dep ? num(pick(dep.data, ["100stk_ord_alow_amt", "ord_alow_amt", "entr"])) : 0;
  /*
   * qry_tp "2"(개별) — 현금 줄과 신용 줄을 **따로** 준다. "1"(합산)이면 융자로 산 것이 현금과
   * 한 줄로 합쳐져 대출일을 잃는다 — 신용 매도에 대출일이 필요하니 개별로 받는다.
   */
  const holdings: Holding[] = bal
    ? listOf(bal.data, ["acnt_evlt_remn_indv_tot"]).map((r) => {
        const crd = str(pick(r, ["crd_tp_nm"])).trim();
        const crdTp = str(pick(r, ["crd_tp"])).trim();
        const isCredit = Boolean(crd) && crdTp !== "" && crdTp !== "00" && !/현금/.test(crd);
        const qty = num(pick(r, ["rmnd_qty"]));
        const able = num(pick(r, ["trde_able_qty"]));
        return {
          code: str(pick(r, ["stk_cd"])).replace(/^A/, "").replace(/_.*$/, ""),
          name: str(pick(r, ["stk_nm"])),
          qty,
          ableQty: able > 0 ? able : qty,
          avg: num(pick(r, ["pur_pric"])),
          cur: num(pick(r, ["cur_prc"])),
          pnl: num(pick(r, ["evltv_prft"])),
          pnlRate: num(pick(r, ["prft_rt"])),
          creditType: isCredit ? crd : null,
          loanDate: isCredit ? str(pick(r, ["crd_loan_dt"])).replace(/\D/g, "").slice(0, 8) || null : null,
        };
      })
    : [];
  const creditLoan = bal ? num(pick(bal.data, ["tot_crd_loan_amt", "tot_loan_amt"])) : 0;
  return { deposit, creditLoan, holdings };
}

/* ── 매수 가능 수량 — 현금·증거금·신용 (2026-09-07) ───────────────────── */

export interface BuyPower {
  code: string;
  /** 잰 가격 — 이 값으로 나눈 수량이다 */
  price: number;
  /** 주문가능현금(예수금 기준) */
  cash: number;
  /**
   * **현금만** — 미수를 안 쓰는 100% 현금 매수. 「신용 안 쓰고 현금으로」의 그 수.
   * kt00011 의 `min_ord_alow*`(미수불가) 다.
   */
  cashOnly: { amt: number; qty: number };
  /**
   * **증거금 적용** — 종목 증거금율(예: 40%)만큼만 현금을 걸고 나머지는 미수(T+2 결제).
   * 키움 앱의 「매수가능」이 보통 이 수다. 미수는 이틀 뒤 갚아야 하는 돈이라 갈라 적는다.
   */
  margin: { rate: number; amt: number; qty: number };
  /**
   * **신용(융자)** — 이 종목이 신용 가능일 때만. kt20017 로 가능 여부, kt00012 로 수량.
   * 보증금율(예: 45%)만큼 현금을 걸고 나머지는 융자다. `allowed:false` 면 종목이 신용 불가,
   * `null` 이면 조회를 못 했거나 신용이 꺼져 있다(가드).
   */
  credit: { allowed: boolean; rate: number | null; amt: number; qty: number } | null;
  /** 신용이 가드에서 꺼져 있나 — 화면이 「켜는 법」을 적는다 */
  creditEnabled: boolean;
  /** 못 받은 조각 — 「0주」와 「못 잼」은 다르다 */
  missing: string[];
}

/**
 * 어느 가격에 몇 주까지 살 수 있나 — 셋을 나란히.
 *
 * 벤티지: "신용 안 쓰고 현금으로 매수했을 때 총 가능한 금액과 신용 썼을 때 총 매수 가능한
 * 수량이 나올 수 있도록." 키움이 셋을 각각 다른 창구로 준다:
 *
 *   kt00011  증거금율별 주문가능수량 — 20/30/40/50/60/100% 칸과 **미수불가**(현금만) 칸
 *   kt00012  신용보증금율별 주문가능수량 — 30/40/50/60% 칸, 종목보증금율
 *   kt20017  신용가능여부 — `crd_alow_yn`
 *
 * 증거금 칸은 `aplc_rt`(적용증거금율)에 맞는 것을 고른다. 없는 율(예: 45%)이면 **더 높은 쪽**
 * (더 적은 수량)을 쓴다 — 못 사는 수를 살 수 있다고 적는 것이 더 나쁘다.
 */
export async function buyPower(code: string, price: number): Promise<BuyPower> {
  const oc = orderClient();
  if (!oc) throw new Error("주문 앱키가 없다");
  const uv = String(Math.max(1, Math.round(price)));
  const g = await getGuard();
  const missing: string[] = [];

  const [m, c, y] = await Promise.all([
    oc.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00011", { stk_cd: code, uv }).catch(() => null),
    g.allowCredit
      ? oc.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00012", { stk_cd: code, uv }).catch(() => null)
      : Promise.resolve(null),
    g.allowCredit
      ? oc.request<Record<string, unknown>>("/api/dostk/stkinfo", "kt20017", { stk_cd: code }).catch(() => null)
      : Promise.resolve(null),
  ]);
  if (m) void noteRaw("kt00011", m.data);
  if (c) void noteRaw("kt00012", c.data);

  const md = m?.data ?? {};
  if (!m) missing.push("증거금 조회");
  const cashOnly = { amt: num(md.min_ord_alow_amt), qty: num(md.min_ord_alowq) };
  const rate = num(md.aplc_rt) || num(md.stk_profa_rt) || 100;
  /* 적용률에 맞는 칸 — 없으면 바로 위 칸. 20→30→40→50→60→100 */
  const tiers = [20, 30, 40, 50, 60, 100];
  const tier = tiers.find((t) => t >= rate) ?? 100;
  const margin = {
    rate,
    amt: num(md[`profa_${tier}ord_alow_amt`]),
    qty: num(md[`profa_${tier}ord_alowq`]),
  };
  const cash = num(md.ord_alowa) || num(md.entr);

  let credit: BuyPower["credit"] = null;
  if (g.allowCredit) {
    const allowed = y ? String(y.data.crd_alow_yn ?? "").toUpperCase() === "Y" : false;
    if (!y) missing.push("신용가능여부");
    if (!c) missing.push("신용 수량");
    const cd = c?.data ?? {};
    const crRate = num(cd.stk_assr_rt) || null;
    const ctiers = [30, 40, 50, 60];
    const ctier = crRate ? (ctiers.find((t) => t >= crRate) ?? 60) : 60;
    credit = {
      allowed,
      rate: crRate,
      amt: allowed ? num(cd[`assr_${ctier}ord_alow_amt`]) : 0,
      qty: allowed ? num(cd[`assr_${ctier}ord_alowq`]) : 0,
    };
  }

  return { code, price: Number(uv), cash, cashOnly, margin, credit, creditEnabled: g.allowCredit, missing };
}

/* ── 거래일 (2026-09-07) — 자동감시가 쓴다 ──────────────────────────── */

/**
 * KRX 휴장일 — 주말 말고 쉬는 날. 자동감시는 이 날엔 발동하지 않는다(값도 안 온다). 해가 바뀌면 채울 것.
 */
const KRX_HOLIDAYS = new Set([
  "2026-09-24", "2026-09-25", // 추석
  "2026-10-05", // 개천절 대체휴일
  "2026-10-09", // 한글날
  "2026-12-25", // 성탄절
  "2026-12-31", // 연말 휴장
  "2027-01-01",
]);

function isTradingDate(date: string): boolean {
  const d = new Date(date + "T00:00:00Z");
  const wd = d.getUTCDay();
  return wd !== 0 && wd !== 6 && !KRX_HOLIDAYS.has(date);
}

function addDays(date: string, n: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/* ── 자동감시주문 (2026-09-07 밤) ──────────────────────────────────────── */

/**
 * 벤티지: "어떤 종목이 얼만큼 하락하면 매수, 이런 걸 하려고 했었지. 매수 이후 얼마 이하 하락하면
 * 매도(시장가인지, 현재가인지도 다 체크 가능하게끔). 잔고에서도 예약주문으로 체결된 건에 대해서는
 * 표시해 주고 관리할 수 있는 기능. 예약이 아니라 자동감시주문이 더 맞는 표현이겠다."
 *
 * **이 자리는 09-03 설계가 「안 한다」로 뺀 자동감시주문이다.** 그날 벤티지가 "자동주문은 아니어야겠지"
 * 라고 했고, 09-07 밤에 뒤집었다. 서버가 값을 보다가 **판단**해서 낸다는 성질이 처음 생겼다.
 * 그래서 겹은 하나도 안 빼고 그 위에 올린다:
 *   · 감시는 **주문서**다 — prepare(한도) → 확인 창 → **주문 비밀번호** → 파일. 만드는 길이 그것 하나
 *   · **한 번뿐** — 닿으면 한 번 내고 끝. 실패해도 재시도 없음. 같은 종목·방향 감시는 하나만
 *   · 판정은 **KRX 체결**(실시간 0B, 없으면 ka10095 조회)로 — NXT 틱은 안 본다
 *   · 발동하는 순간 검문을 다시 한다 — 허용·한 건·하루 합·건수 + 지정가 ↔ 그때 값 ±priceCollarPct
 *   · 정규장 09:00~15:30 에만 발동한다. 유효기간은 30일까지, 지나면 「만료」
 *   · `allowAutoWatch:false` 면 새로 안 받고 기다리던 것도 발동하지 않는다
 *   · 「체결되면 매도 감시」는 매수 감시를 등록하는 확인 창에 **글자로 적혀** 같은 비밀번호로 승인된다.
 *     자식 감시의 금액은 부모의 체결 금액을 못 넘는다
 */
export interface AutoWatch {
  id: string;
  at: string;
  ip: string;
  ticket: OrderTicket;
  spec: WatchSpec;
  status: "waiting" | "fired" | "filled" | "failed" | "expired" | "cancelled";
  firedAt?: string;
  /** 발동 순간의 값 */
  firePrice?: number;
  ordNo?: string;
  fillQty?: number;
  fillPrice?: number;
  msg?: string;
  /** 「체결되면 매도 감시」로 태어난 자식이면 부모, 부모면 자식(들) */
  parentId?: string;
  childId?: string;
  childIds?: string[];
  /** 단계 매도로 함께 태어난 형제들의 묶음 */
  groupId?: string;
  /** 어디서 왔나 — 감시 폼(watch) · 즉시 매수의 출구 계획(order) */
  origin?: "watch" | "order";
  /** 매도 발동 순간의 평단 — 실현손익을 셀 때 */
  avgAtFire?: number;
  /** 이중 손절 — 오늘 아침 키움에 건 스톱지정가 주문번호와 날짜 */
  dualOrdNo?: string;
  dualDate?: string;
  dualMsg?: string;
}

const WATCH_FILE = join(DATA_DIR, "orderWatch.json");
const WATCH_MAX = 20;
/** 발동 창 — 정규장. 동시호가(08:30~09:00)의 예상체결가로는 발동하지 않는다 */
const WATCH_FROM = 540;
const WATCH_TO = 930;

/** 호가 단위 (KRX 2023-01) */
function tickOf(p: number): number {
  return p < 2000 ? 1 : p < 5000 ? 5 : p < 20000 ? 10 : p < 50000 ? 50 : p < 200000 ? 100 : p < 500000 ? 500 : 1000;
}
function toTick(p: number): number {
  const t = tickOf(p);
  return Math.floor(p / t) * t;
}

/** 지금 값과 전일 종가 — ka10095 한 번 */
async function quoteOf(main: KiwoomClient, code: string): Promise<{ price: number; prevClose: number } | null> {
  try {
    const { data } = await main.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10095", { stk_cd: `${code}_AL` });
    const rows = Array.isArray(data.atn_stk_infr) ? (data.atn_stk_infr as Record<string, unknown>[]) : [];
    const q = rows.find((r) => String(r.stk_cd ?? "").replace(/_(AL|NX)$/i, "") === code) ?? rows[0];
    if (!q) return null;
    const price = Math.abs(num(q.cur_prc));
    const chg = num(q.pred_pre);
    return { price, prevClose: price - chg };
  } catch {
    return null;
  }
}

export function watchSay(s: WatchSpec): string {
  const basisKo =
    s.basis === "price" ? "" : s.basis === "prevClose" ? "전일 종가" : s.basis === "avg" ? "평단" : "등록 때 값";
  const cond =
    s.basis === "price"
      ? `${s.trigger.toLocaleString()}원 ${s.dir === "le" ? "이하" : "이상"}`
      : `${basisKo}(${(s.basisPrice ?? 0).toLocaleString()}) 대비 ${s.pct! > 0 ? "+" : ""}${s.pct}% → ${s.trigger.toLocaleString()}원 ${s.dir === "le" ? "이하" : "이상"}`;
  const exec =
    s.exec === "market" ? "시장가" : s.exec === "limit_trigger" ? "발동가 지정가" : s.exec === "limit_now" ? "그때 현재가 지정가" : `${(s.limitPrice ?? 0).toLocaleString()}원 지정가`;
  const then = s.then && s.then.length > 0 ? ` · 체결되면 체결가 대비 ${legsSay(s.then)} 매도 감시` : "";
  if (s.legs && s.legs.length > 0) {
    return `${basisKo}(${(s.basisPrice ?? 0).toLocaleString()}) 대비 ${legsSay(s.legs)} — ${s.legs.length}단계 매도`;
  }
  return `${cond}면 ${exec}${then}`;
}

async function readWatches(): Promise<AutoWatch[]> {
  const v = await readJson<{ rows: AutoWatch[] }>(WATCH_FILE, { rows: [] });
  const rows = Array.isArray(v.rows) ? v.rows : [];
  /* 옛 모양(then 이 객체 하나)은 단계 하나·전량으로 읽는다 */
  for (const r of rows) {
    const th = r.spec?.then as unknown;
    if (th && !Array.isArray(th) && typeof th === "object") {
      const one = th as { pct: number; exec: "market" | "limit_now" };
      r.spec.then = [{ pct: one.pct, qtyPct: 100, exec: one.exec }];
    }
  }
  return rows;
}

async function writeWatches(rows: AutoWatch[]): Promise<void> {
  const live = rows.filter((r) => r.status === "waiting" || r.status === "fired");
  const done = rows.filter((r) => r.status !== "waiting" && r.status !== "fired").slice(-80);
  await writeJson(WATCH_FILE, { rows: [...live, ...done] });
}

export async function listAutoWatches(): Promise<AutoWatch[]> {
  const rank = (s: AutoWatch["status"]) => (s === "waiting" ? 0 : s === "fired" ? 1 : 2);
  return (await readWatches()).sort((a, b) => rank(a.status) - rank(b.status) || b.at.localeCompare(a.at));
}

async function addAutoWatch(t: OrderTicket, ip: string, parentId?: string, groupId?: string, init: Partial<AutoWatch> = {}): Promise<AutoWatch> {
  if (!t.watch) throw new Error("감시 조건이 없다");
  const rows = await readWatches();
  const { legs: _legs, replaceId: _rid, ...spec } = t.watch;
  const row: AutoWatch = {
    id: randomBytes(6).toString("hex"),
    at: new Date().toISOString(),
    ip,
    ticket: { ...t, watch: spec },
    spec,
    status: "waiting",
    origin: "watch",
    ...(parentId ? { parentId } : {}),
    ...(groupId ? { groupId } : {}),
    ...init,
    ...(init.status === "fired" ? { firedAt: new Date().toISOString() } : {}),
  };
  rows.push(row);
  if (parentId) {
    const p = rows.find((r) => r.id === parentId);
    if (p) {
      p.childId = row.id;
      p.childIds = [...(p.childIds ?? []), row.id];
    }
  }
  await writeWatches(rows);
  void ensureLiveCode(t.code);
  return row;
}

/** 수정으로 대체된 옛 감시를 접는다 — 아직 기다리는 중일 때만. 발동해 버렸으면 새것과 둘 다 산다(알린다) */
async function retireAutoWatch(oldId: string, newId: string): Promise<boolean> {
  const rows = await readWatches();
  const old = rows.find((r) => r.id === oldId);
  if (!old) return false;
  if (old.status !== "waiting") {
    void sendTelegram(`⚠️ 감시 수정 — 옛 감시(${esc(old.ticket.name)})가 그새 ${autoWatchStatusKo(old.status)}이라 접지 못했다. 새 감시와 둘 다 있다 — 자동감시 탭을 확인`, "order").catch(() => undefined);
    return false;
  }
  old.status = "cancelled";
  old.firedAt = new Date().toISOString();
  old.msg = `수정으로 대체 → ${newId}`;
  await cancelDualStop(old);
  await writeWatches(rows);
  return true;
}

/** 지난 감시 한 건을 목록에서 지운다 — 기록(orderLog)은 남는다. 살아 있는 것(waiting/fired)은 못 지운다 */
export async function deleteAutoWatch(id: string, ip: string): Promise<void> {
  const rows = await readWatches();
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error("그 감시가 없다");
  if (row.status === "waiting" || row.status === "fired") throw new Error("살아 있는 감시는 지우지 않는다 — 먼저 취소");
  await writeWatches(rows.filter((r) => r.id !== id));
  await appendLog({ kind: "watch", ip, code: row.ticket.code, name: row.ticket.name, msg: `감시 히스토리 삭제 (${id}, ${autoWatchStatusKo(row.status)})` });
}

/** 지난 감시를 모두 지운다 — 살아 있는 것만 남긴다 */
export async function clearAutoWatchHistory(ip: string): Promise<number> {
  const rows = await readWatches();
  const keep = rows.filter((r) => r.status === "waiting" || r.status === "fired");
  const n = rows.length - keep.length;
  if (n > 0) {
    await writeWatches(keep);
    await appendLog({ kind: "watch", ip, msg: `감시 히스토리 ${n}건 모두 삭제` });
  }
  return n;
}

export async function cancelAutoWatch(id: string, ip: string): Promise<AutoWatch> {
  const rows = await readWatches();
  const row = rows.find((r) => r.id === id);
  if (!row) throw new Error("그 감시가 없다");
  if (row.status !== "waiting") throw new Error(`이미 ${autoWatchStatusKo(row.status)} 감시다`);
  if (watchFiring) throw new Error("지금 감시가 발동 중이다 — 잠시 뒤 다시");
  row.status = "cancelled";
  row.firedAt = new Date().toISOString();
  row.msg = "사람이 취소";
  await cancelDualStop(row);
  await writeWatches(rows);
  const t = row.ticket;
  await appendLog({ kind: "watch", ip, side: t.side, code: t.code, name: t.name, qty: t.qty, venue: t.venue, amount: t.amount, msg: `감시 취소 (${row.id})` });
  void sendTelegram(`👁 감시 취소 — ${esc(t.name)} ${t.side === "buy" ? "매수" : "매도"} ${t.qty}주`, "order").catch(() => undefined);
  return row;
}

export function autoWatchStatusKo(s: AutoWatch["status"]): string {
  return s === "waiting" ? "지켜보는 중" : s === "fired" ? "발동 — 체결 대기" : s === "filled" ? "체결" : s === "failed" ? "실패" : s === "expired" ? "만료" : "취소됨";
}

let watchFiring = false;
let lastPoll = 0;
const pollCache = new Map<string, { price: number; at: number }>();

/** 지금 값 — 실시간 KRX 체결이 20초 안이면 그것, 아니면 조회(5초에 한 번 묶어서) */
async function livePrices(main: KiwoomClient, codes: string[]): Promise<Map<string, { price: number; from: "실시간" | "조회" }>> {
  const out = new Map<string, { price: number; from: "실시간" | "조회" }>();
  const { store } = peekRealtime();
  const need: string[] = [];
  for (const code of codes) {
    const tick = store?.getLatestKrx("0B", code);
    const raw = tick?.values?.["10"];
    const fresh = tick && Date.now() - tick.at < 20_000;
    if (raw && fresh) {
      const n = Math.abs(Number(String(raw).replace(/[+,\s]/g, "")));
      if (Number.isFinite(n) && n > 0) {
        out.set(code, { price: n, from: "실시간" });
        continue;
      }
    }
    need.push(code);
  }
  if (need.length > 0) {
    if (Date.now() - lastPoll > 5_000) {
      lastPoll = Date.now();
      try {
        const m = await priceMap(main, need);
        for (const [c, p] of m) pollCache.set(c, { price: p, at: Date.now() });
      } catch {
        /* 이번 틱은 캐시로 */
      }
    }
    for (const c of need) {
      const v = pollCache.get(c);
      if (v && Date.now() - v.at < 30_000) out.set(c, { price: v.price, from: "조회" });
    }
  }
  return out;
}

/**
 * 3초마다. 정규장 밖이면 만료만 정리한다. 안이면 값을 읽어 조건에 닿은 것을 **한 번** 낸다.
 */
let lastWatchTick = 0;
let lastDualDay = "";

async function runAutoWatch(main: KiwoomClient): Promise<void> {
  if (watchFiring) return;
  if (!ordersEnabled() || !orderClient()) return;
  lastWatchTick = Date.now();
  const rows = await readWatches();
  const waiting = rows.filter((r) => r.status === "waiting");
  if (waiting.length === 0) return;
  const { date, minute } = kstParts();
  const tag = orderIsMock() ? "[모의]" : "[실전]";
  watchFiring = true;
  try {
    let changed = false;
    /* 만료 — 유효한 마지막 날의 장이 끝났거나 날이 지났다 */
    for (const r of waiting) {
      if (r.spec.validUntil < date || (r.spec.validUntil === date && minute > WATCH_TO)) {
        r.status = "expired";
        r.firedAt = new Date().toISOString();
        r.msg = "유효기간이 지났다 — 닿지 않았다";
        changed = true;
        const t = r.ticket;
        await appendLog({ kind: "watch", side: t.side, code: t.code, name: t.name, qty: t.qty, venue: t.venue, msg: `감시 만료 (${r.id}) — ${watchSay(r.spec)}` });
        void sendTelegram(`👁 ${tag} 감시 만료 — ${esc(t.name)} ${t.side === "buy" ? "매수" : "매도"} ${t.qty}주\n${esc(watchSay(r.spec))}`, "order").catch(() => undefined);
      }
    }
    const live = waiting.filter((r) => r.status === "waiting");
    /* 이중 손절 (개편 ②) — 거래일 08:31~08:59 에 한 번, 「이하면 판다」 감시마다 키움 스톱지정가 */
    if (isTradingDate(date) && minute >= 511 && minute <= 539 && lastDualDay !== date) {
      lastDualDay = date;
      if (await placeDualStops(rows, date)) changed = true;
    }
    /* 이중 스톱이 먼저 팔았나 — 정규장에 확인. 날이 지난 스톱 번호는 지운다(당일 유효) */
    if (live.some((r) => r.dualOrdNo)) {
      if (await syncDualStops(rows, date, minute)) changed = true;
    }
    if (live.length > 0 && isTradingDate(date) && minute >= WATCH_FROM && minute <= WATCH_TO) {
      for (const r of live) void ensureLiveCode(r.ticket.code);
      const prices = await livePrices(main, [...new Set(live.map((r) => r.ticket.code))]);
      for (const r of live) {
        const q = prices.get(r.ticket.code);
        if (!q) continue;
        const hit = r.spec.dir === "le" ? q.price <= r.spec.trigger : q.price >= r.spec.trigger;
        if (!hit) continue;
        changed = true;
        await fireAutoWatch(r, q.price, q.from, rows, tag);
        await new Promise((ok) => setTimeout(ok, 400));
      }
    }
    if (changed) await writeWatches(rows);
  } finally {
    watchFiring = false;
  }
}

/** 조건에 닿았다 — 검문 다시, 그리고 한 번 낸다 */
async function fireAutoWatch(r: AutoWatch, cur: number, from: string, rows: AutoWatch[], tag: string): Promise<void> {
  const base = r.ticket;
  const s = r.spec;
  const sideKo = base.side === "buy" ? "매수" : "매도";
  r.firedAt = new Date().toISOString();
  r.firePrice = cur;
  const g = await getGuard();
  let why: string | null = null;
  let price: number | null = null;
  let tradeType = "3";
  if (s.exec !== "market") {
    tradeType = "0";
    price = s.exec === "limit_trigger" ? s.trigger : s.exec === "limit_now" ? toTick(cur) : (s.limitPrice ?? s.trigger);
    const off = (Math.abs(price - cur) / cur) * 100;
    if (off > g.priceCollarPct) why = `지정가(${price.toLocaleString()})가 그때 값(${cur.toLocaleString()})에서 ${off.toFixed(1)}% 벗어났다 (한도 ${g.priceCollarPct}%)`;
  }
  const amount = (price ?? cur) * base.qty;
  if (!why && base.side === "buy") why = await buyBlockReason(base.code, g);
  if (!why) {
    if (!g.allowAutoWatch) why = "자동감시가 꺼져 있다(orderGuard.allowAutoWatch)";
    else if (g.allowedCodes && g.allowedCodes.length > 0 && !g.allowedCodes.includes(base.code)) why = "허용 종목이 아니다";
    else if (amount > g.maxOrderKrw) why = `한 건 한도 초과 — ${won(amount)} > ${won(g.maxOrderKrw)}`;
    else {
      const used = await todayUsage();
      if (used.krw + amount > g.maxDailyKrw) why = `오늘 한도 초과 — 이미 ${won(used.krw)} + ${won(amount)}`;
      else if (used.count + 1 > g.maxDailyCount) why = `오늘 건수 한도 초과 — ${used.count}/${g.maxDailyCount}`;
    }
  }
  if (why) {
    r.status = "failed";
    r.msg = why;
    await appendLog({ kind: "reject", side: base.side, code: base.code, name: base.name, qty: base.qty, price, venue: base.venue, tradeType, msg: `감시 발동했으나 안 냄 (${r.id}) — ${why}` });
    void sendTelegram(`⚠️ ${tag} <b>감시 발동 — 안 냄</b> ${esc(base.name)} ${sideKo} ${base.qty}주 (값 ${cur.toLocaleString()})\n${esc(why)}`, "order").catch(() => undefined);
    return;
  }
  const tt = tradeTypeOf(tradeType);
  const t: OrderTicket = {
    ...base,
    price,
    condPrice: null,
    tradeType,
    tradeLabel: tt?.label ?? (tradeType === "3" ? "시장가" : "보통(지정가)"),
    refPrice: cur,
    amount,
    watch: null,
    exit: null,
  };
  if (base.side === "sell") {
    /* 실현손익용 평단, 그리고 이중 스톱이 걸려 있으면 그것부터 취소한다(그 스톱이 수량을 물고 있다) */
    const acct = await orderAccount().catch(() => null);
    const h = acct?.holdings.find((x) => x.code === base.code && !x.creditType);
    if (h && h.avg > 0) r.avgAtFire = h.avg;
    if (r.dualOrdNo) {
      const open = await openOrders().catch(() => []);
      const still = open.find((x) => x.ordNo === r.dualOrdNo);
      if (still) {
        try {
          await placeOrder({ kind: "cancel", ordNo: r.dualOrdNo, code: base.code, name: base.name, qty: still.remain || still.qty, venue: "KRX" });
          await appendLog({ kind: "cancel", code: base.code, name: base.name, origOrdNo: r.dualOrdNo, msg: `이중 스톱 취소 — 서버 감시가 먼저 닿았다 (${r.id})` });
        } catch (e) {
          const m = e instanceof Error ? e.message : String(e);
          await appendLog({ kind: "error", code: base.code, name: base.name, msg: `이중 스톱 취소 실패 (${r.id}) — ${m}. 그래도 시장가 매도를 낸다` });
        }
      } else if (still === undefined) {
        /* 미체결에 없다 = 키움 스톱이 이미 나갔거나 체결됐다. 우리 매도는 수량이 없어 거절될 것 — 낼 것 없다 */
        const fl = await fills().catch(() => []);
        const f = fl.find((x) => x.ordNo === r.dualOrdNo);
        if (f && f.filled > 0) {
          r.status = "filled";
          r.fillQty = f.filled;
          r.fillPrice = f.price;
          r.msg = `키움 스톱이 먼저 팔았다 (주문번호 ${r.dualOrdNo})`;
          await appendLog({ kind: "fill", side: "sell", code: base.code, name: base.name, qty: f.filled, price: f.price, ordNo: r.dualOrdNo, msg: `이중 스톱 체결 — 서버 감시 ${r.id} 는 낼 것 없음` });
          return;
        }
      }
    }
  }
  try {
    const res = await placeOrder(t);
    r.status = "fired";
    r.ordNo = res.ordNo;
    r.msg = res.msg;
    await appendLog({ kind: "order", ip: r.ip, side: t.side, code: t.code, name: t.name, qty: t.qty, price: t.price, condPrice: null, tradeType: t.tradeType, venue: t.venue, ordNo: res.ordNo, amount: t.amount, credit: false, msg: `감시 발동(${from} ${cur.toLocaleString()}) → ${res.msg}`, raw: res.raw });
    const priceKo = t.price === null ? "시장가" : `${t.price.toLocaleString()}원`;
    void sendTelegram(
      `👁🧾 ${tag} <b>감시 발동 — ${sideKo} 나감</b> ${esc(t.name)} ${t.qty}주 @ ${priceKo}\n${esc(watchSay(s))}\n그때 값 ${cur.toLocaleString()}(${from}) · 금액 ${won(t.amount)} · 주문번호 ${esc(res.ordNo || "?")}\n${esc(res.msg)}`,
      "order",
    ).catch(() => undefined);
    void noteUsage();
    if (res.ordNo) {
      watch(res.ordNo, t);
      const id = r.id;
      fillHooks.set(res.ordNo, (ev) => void onAutoWatchFill(id, ev).catch(() => undefined));
    }
  } catch (e) {
    const msg = e instanceof KiwoomApiError ? `${e.returnCode} ${e.message}` : e instanceof Error ? e.message : String(e);
    r.status = "failed";
    r.msg = msg;
    await appendLog({ kind: "error", code: t.code, name: t.name, qty: t.qty, venue: t.venue, msg: `감시 발동 실패 (${r.id}) — ${msg}`, raw: e instanceof KiwoomApiError ? e.raw : undefined });
    void sendTelegram(`⚠️ ${tag} <b>감시 발동 실패</b> ${esc(t.name)} ${sideKo} ${t.qty}주\n${esc(msg)}\n다시 안 냅니다.`, "order").catch(() => undefined);
  }
}

/** 발동한 주문이 체결됐다 — 기록하고, 「체결되면 매도 감시」가 있으면 자식을 건다 */
async function onAutoWatchFill(id: string, ev: { filled: number; price: number; full: boolean; done: boolean; status: string }): Promise<void> {
  const rows = await readWatches();
  const r = rows.find((x) => x.id === id);
  if (!r) return;
  r.fillQty = ev.filled;
  if (ev.price > 0) r.fillPrice = ev.price;
  if (ev.done) {
    r.status = ev.filled > 0 ? "filled" : "failed";
    if (ev.filled === 0) r.msg = `체결 없이 끝났다 — ${ev.status}`;
  }
  if (ev.done && ev.filled > 0 && r.spec.then && r.spec.then.length > 0 && r.ticket.side === "buy" && !r.childId) {
    const fillPx = r.fillPrice && r.fillPrice > 0 ? r.fillPrice : r.firePrice ?? r.spec.trigger;
    const legs = r.spec.then;
    const qs = splitQty(ev.filled, legs);
    await writeWatches(rows);
    const groupId = randomBytes(4).toString("hex");
    const made: string[] = [];
    for (let i = 0; i < legs.length; i++) {
      if (qs[i] <= 0) continue;
      const l = legs[i];
      const trigger = toTick(fillPx * (1 + l.pct / 100));
      const childSpec: WatchSpec = {
        dir: l.pct < 0 ? "le" : "ge",
        basis: "avg",
        pct: l.pct,
        basisPrice: fillPx,
        trigger,
        exec: l.exec,
        limitPrice: null,
        validUntil: addDays(kstParts().date, 30),
        then: null,
      };
      const child: OrderTicket = {
        ...r.ticket,
        side: "sell",
        qty: qs[i],
        price: null,
        condPrice: null,
        tradeType: l.exec === "market" ? "3" : "0",
        tradeLabel: l.exec === "market" ? "시장가" : "보통(지정가)",
        refPrice: fillPx,
        amount: trigger * qs[i],
        watch: childSpec,
      };
      const c = await addAutoWatch(child, r.ip, r.id, groupId);
      made.push(c.id);
      await appendLog({ kind: "watch", ip: r.ip, side: "sell", code: child.code, name: child.name, qty: child.qty, venue: child.venue, amount: child.amount, msg: `체결 뒤 매도 감시 자동 등록 (${c.id}, 부모 ${r.id}) — ${watchSay(childSpec)}` });
    }
    void sendTelegram(
      `👁 ${orderIsMock() ? "[모의]" : "[실전]"} <b>매도 감시 자동 등록</b> ${esc(r.ticket.name)} ${ev.filled}주 체결 → ${made.length}단계\n체결가 ${fillPx.toLocaleString()} 대비 ${esc(legsSay(legs))}\n30일 유효`,
      "order",
    ).catch(() => undefined);
    return;
  }
  await writeWatches(rows);
}

/** 감시 목록에 붙일 지금 값 — 실시간이면 실시간, 아니면 조회(5초 캐시). 카드가 「발동까지 몇 %」를 그린다 */
export async function watchPrices(main: KiwoomClient, codes: string[]): Promise<Record<string, { price: number; from: string }>> {
  if (codes.length === 0) return {};
  const m = await livePrices(main, [...new Set(codes)]);
  return Object.fromEntries([...m].map(([c, v]) => [c, { price: v.price, from: v.from }]));
}

/** 감시 폼이 종목을 고르면 — 지금 값·전일 종가·(있으면) 평단·매매가능수량·예수금을 한 번에 */
export async function watchQuote(main: KiwoomClient, code: string): Promise<{
  price: number;
  prevClose: number;
  changeRate: number;
  avg: number | null;
  held: number;
  ableQty: number;
  deposit: number;
}> {
  const [q, acct] = await Promise.all([quoteOf(main, code), orderAccount().catch(() => null)]);
  if (!q) throw new Error("현재가를 못 읽었다");
  const h = acct?.holdings.find((x) => x.code === code && !x.creditType) ?? null;
  return {
    price: q.price,
    prevClose: q.prevClose,
    changeRate: q.prevClose > 0 ? ((q.price - q.prevClose) / q.prevClose) * 100 : 0,
    avg: h && h.avg > 0 ? h.avg : null,
    held: h?.qty ?? 0,
    ableQty: h?.ableQty ?? 0,
    deposit: acct?.deposit ?? 0,
  };
}

/**
 * 이중 손절 — 아침마다 「이하면 판다」 감시에 키움 스톱지정가를 건다 (개편 ②).
 * 발동가 = 감시 발동가, 주문가 = 발동가의 1.5% 아래(호가 단위) — 발동되면 곧 체결되게.
 * 서버가 죽어도 키움이 판다. 서버 감시가 먼저 닿으면 이 스톱을 취소하고 시장가로 낸다(fireAutoWatch).
 * 모의투자가 28 을 거절하면 dualMsg 에 남기고 서버 감시만으로 간다.
 */
async function placeDualStops(rows: AutoWatch[], date: string): Promise<boolean> {
  const g = await getGuard();
  if (!g.dualStop) return false;
  let changed = false;
  for (const r of rows) {
    if (r.status !== "waiting" || r.ticket.side !== "sell" || r.spec.dir !== "le" || r.spec.dual === false) continue;
    if (r.dualDate === date && r.dualOrdNo) continue;
    if (r.ticket.credit) continue;
    const trigger = r.spec.trigger;
    const limit = toTick(trigger * 0.985);
    const t: OrderTicket = {
      ...r.ticket,
      price: limit,
      condPrice: trigger,
      tradeType: "28",
      tradeLabel: "스톱지정가",
      refPrice: trigger,
      amount: limit * r.ticket.qty,
      watch: null,
      exit: null,
    };
    try {
      const res = await placeOrder(t);
      r.dualOrdNo = res.ordNo;
      r.dualDate = date;
      r.dualMsg = res.msg;
      changed = true;
      await appendLog({ kind: "order", ip: r.ip, side: "sell", code: t.code, name: t.name, qty: t.qty, price: limit, condPrice: trigger, tradeType: "28", venue: "KRX", ordNo: res.ordNo, amount: t.amount, credit: false, msg: `이중 손절 스톱 (${r.id}) → ${res.msg}`, raw: res.raw });
    } catch (e) {
      const msg = e instanceof KiwoomApiError ? `${e.returnCode} ${e.message}` : e instanceof Error ? e.message : String(e);
      r.dualDate = date;
      r.dualOrdNo = undefined;
      r.dualMsg = `키움 스톱 못 걸음 — ${msg}`;
      changed = true;
      await appendLog({ kind: "error", code: t.code, name: t.name, qty: t.qty, msg: `이중 손절 스톱 실패 (${r.id}) — ${msg}. 서버 감시만으로 간다` });
    }
    await new Promise((ok) => setTimeout(ok, 350));
  }
  if (changed) {
    const n = rows.filter((r) => r.dualDate === date && r.dualOrdNo).length;
    const bad = rows.filter((r) => r.dualDate === date && !r.dualOrdNo && r.dualMsg).length;
    void sendTelegram(`🛡 ${orderIsMock() ? "[모의]" : "[실전]"} 이중 손절 — 키움 스톱 ${n}건 걸음${bad > 0 ? ` · 못 건 것 ${bad}건(기록 탭)` : ""}`, "order").catch(() => undefined);
  }
  return changed;
}

/** 이중 스톱이 먼저 팔았으면 감시를 「체결」로 접는다. 장이 끝나면 당일 스톱 번호를 비운다 */
async function syncDualStops(rows: AutoWatch[], date: string, minute: number): Promise<boolean> {
  let changed = false;
  const targets = rows.filter((r) => r.status === "waiting" && r.dualOrdNo);
  if (targets.length === 0) return false;
  if (minute > WATCH_TO || !isTradingDate(date) || targets.some((r) => r.dualDate !== date)) {
    for (const r of targets) {
      if (r.dualDate !== date || minute > WATCH_TO) {
        r.dualOrdNo = undefined;
        changed = true;
      }
    }
    return changed;
  }
  if (minute < WATCH_FROM) return false;
  const fl = await fills().catch(() => null);
  if (!fl) return false;
  for (const r of targets) {
    const f = fl.find((x) => x.ordNo === r.dualOrdNo && x.filled > 0);
    if (!f) continue;
    const acct = await orderAccount().catch(() => null);
    const h = acct?.holdings.find((x) => x.code === r.ticket.code && !x.creditType);
    r.status = "filled";
    r.firedAt = new Date().toISOString();
    r.firePrice = f.price;
    r.fillQty = f.filled;
    r.fillPrice = f.price;
    r.avgAtFire = h?.avg ?? r.spec.basisPrice ?? undefined;
    r.msg = `키움 스톱이 팔았다 (주문번호 ${r.dualOrdNo})`;
    changed = true;
    await appendLog({ kind: "fill", side: "sell", code: r.ticket.code, name: r.ticket.name, qty: f.filled, price: f.price, ordNo: r.dualOrdNo, msg: `이중 손절 스톱 체결 (${r.id})` });
    void sendTelegram(`🛡🧾 ${orderIsMock() ? "[모의]" : "[실전]"} <b>이중 손절 체결</b> ${esc(r.ticket.name)} ${f.filled}주 @ ${f.price.toLocaleString()} — 키움 스톱이 팔았다`, "order").catch(() => undefined);
  }
  return changed;
}

/** 감시를 취소할 때 오늘 걸린 이중 스톱도 거둔다 */
async function cancelDualStop(r: AutoWatch): Promise<void> {
  if (!r.dualOrdNo) return;
  try {
    const open = await openOrders();
    const still = open.find((x) => x.ordNo === r.dualOrdNo);
    if (still) {
      await placeOrder({ kind: "cancel", ordNo: r.dualOrdNo, code: r.ticket.code, name: r.ticket.name, qty: still.remain || still.qty, venue: "KRX" });
      await appendLog({ kind: "cancel", code: r.ticket.code, name: r.ticket.name, origOrdNo: r.dualOrdNo, msg: `이중 스톱 취소 — 감시 취소에 따라 (${r.id})` });
    }
  } catch (e) {
    await appendLog({ kind: "error", code: r.ticket.code, name: r.ticket.name, msg: `이중 스톱 취소 실패 (${r.id}) — ${e instanceof Error ? e.message : String(e)}. 미체결 탭에서 직접 취소` });
  }
  r.dualOrdNo = undefined;
}

/* ── 포지션 (개편 ①) ────────────────────────────────────────────────────── */

export interface Position {
  code: string;
  name: string;
  qty: number;
  ableQty: number;
  avg: number;
  cur: number;
  pnl: number;
  pnlRate: number;
  creditType: string | null;
  loanDate: string | null;
  /** 감시에 걸린 수 · 미체결 매도에 묶인 수 · 아직 자유로운 수 */
  watchQty: number;
  pendingQty: number;
  freeQty: number;
  /** 이 종목의 살아 있는 감시(대기·발동) */
  watches: AutoWatch[];
  /** 오늘 미체결·체결 */
  open: OpenRow[];
  fills: OpenRow[];
  /** 출구 — 손절선(제일 먼저 닿을 「이하면 판다」)과 익절선(제일 먼저 닿을 「이상이면 판다」) */
  stopLine: number | null;
  takeLine: number | null;
  /** 키움 스톱지정가가 미체결로 걸려 있나 */
  kiwoomStop: OpenRow | null;
  /** 출구가 하나도 없다 — 카드가 빨갛게 */
  noExit: boolean;
  /** 자동감시로 산 것인가 */
  boughtByWatch: boolean;
}

export async function positions(main: KiwoomClient): Promise<{
  deposit: number;
  equity: number;
  /** 총 매입금액 · 총 평가금액 · 총 평가손익(원, %) — 벤티지: "총액과 등락률은 보여줘야지. 그게 제일 중요하잖아" */
  investTotal: number;
  valueTotal: number;
  pnlTotal: number;
  pnlRateTotal: number;
  /** 키움 잔고 화면의 「추정자산」(kt00003)과 「실현손익」(오늘, ka10074) — 못 받으면 null */
  totalAsset: number | null;
  realizedToday: number | null;
  positions: Position[];
  /** 아직 안 산 매수 감시(진입 대기) */
  entries: AutoWatch[];
  /** 보유가 없는 종목의 미체결 */
  orphanOpen: OpenRow[];
  prices: Record<string, { price: number; from: string }>;
  todayLoss: number;
  buyLocked: string | null;
}> {
  const oc = orderClient();
  const today = kstParts().date.replace(/-/g, "");
  const [acct, rows, open, fl, g, assetRes, rlzRes] = await Promise.all([
    orderAccount(),
    readWatches(),
    openOrders().catch(() => [] as OpenRow[]),
    fills().catch(() => [] as OpenRow[]),
    getGuard(),
    oc ? memo("asset", 30_000, () => oc.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00003", { qry_tp: "0" })).catch(() => null) : Promise.resolve(null),
    oc ? memo("rlzToday", 30_000, () => oc.request<Record<string, unknown>>(ACNT_RESOURCE, "ka10074", { strt_dt: today, end_dt: today })).catch(() => null) : Promise.resolve(null),
  ]);
  const totalAsset = assetRes ? num(assetRes.data.prsm_dpst_aset_amt) || null : null;
  const realizedToday = rlzRes ? num(rlzRes.data.rlzt_pl) : null;
  const live = rows.filter((r) => r.status === "waiting" || r.status === "fired");
  const held = new Set(acct.holdings.map((h) => h.code));
  const positionsOut: Position[] = acct.holdings.map((h) => {
    const ws = live.filter((r) => r.ticket.code === h.code);
    const sells = ws.filter((r) => r.ticket.side === "sell" && r.status === "waiting");
    const watchQty = sells.reduce((a, r) => a + r.ticket.qty, 0);
    const myOpen = open.filter((x) => x.code === h.code);
    /* 이중 스톱이 미체결로 물고 있는 수는 「감시」이지 「주문 중」이 아니다 — 두 번 세지 않는다 */
    const dualLocked = sells.filter((r) => r.dualOrdNo && myOpen.some((x) => x.ordNo === r.dualOrdNo)).reduce((a, r) => a + r.ticket.qty, 0);
    const pendingQty = Math.max(0, h.qty - h.ableQty - dualLocked);
    const kiwoomStop = myOpen.find((x) => x.stopPrice > 0 && /매도/.test(x.side)) ?? null;
    const stopLine = sells.filter((r) => r.spec.dir === "le").sort((a, b) => b.spec.trigger - a.spec.trigger)[0]?.spec.trigger ?? kiwoomStop?.stopPrice ?? null;
    const takeLine = sells.filter((r) => r.spec.dir === "ge").sort((a, b) => a.spec.trigger - b.spec.trigger)[0]?.spec.trigger ?? null;
    const boughtByWatch = rows.some((r) => r.ticket.code === h.code && r.ticket.side === "buy" && (r.status === "filled" || r.status === "fired"));
    return {
      code: h.code,
      name: h.name,
      qty: h.qty,
      ableQty: h.ableQty,
      avg: h.avg,
      cur: h.cur,
      pnl: h.pnl,
      pnlRate: h.pnlRate,
      creditType: h.creditType,
      loanDate: h.loanDate,
      watchQty,
      pendingQty,
      freeQty: Math.max(0, h.ableQty + dualLocked - watchQty),
      watches: ws,
      open: myOpen,
      fills: fl.filter((x) => x.code === h.code),
      stopLine,
      takeLine,
      kiwoomStop,
      noExit: stopLine === null && !h.creditType,
      boughtByWatch,
    };
  });
  const codes = [...new Set([...positionsOut.map((p) => p.code), ...live.map((r) => r.ticket.code)])];
  const prices = await watchPrices(main, codes).catch(() => ({}));
  const investTotal = acct.holdings.reduce((a, h) => a + h.avg * h.qty, 0);
  const valueTotal = acct.holdings.reduce((a, h) => a + h.cur * h.qty, 0);
  const equity = acct.deposit + valueTotal;
  const pnlTotal = valueTotal - investTotal;
  const pnlRateTotal = investTotal > 0 ? (pnlTotal / investTotal) * 100 : 0;
  const todayLoss = realizedLossToday(rows);
  const buyLocked = g.maxDailyLossKrw > 0 && todayLoss <= -g.maxDailyLossKrw ? `오늘 실현손실 ${won(todayLoss)} — 신규 매수 잠김` : null;
  return {
    deposit: acct.deposit,
    equity,
    investTotal,
    valueTotal,
    pnlTotal,
    pnlRateTotal,
    totalAsset,
    realizedToday,
    positions: positionsOut,
    entries: live.filter((r) => r.ticket.side === "buy" && !held.has(r.ticket.code) || (r.ticket.side === "buy" && r.status === "waiting")),
    orphanOpen: open.filter((x) => !held.has(x.code)),
    prices,
    todayLoss,
    buyLocked,
  };
}

/* ── 살아 있다는 신호 · 아침 인사 · 저녁 정합성 (개편 ②) ──────────────────── */

let lastDeadAlert = 0;
let greetedDay = "";
let reconciledDay = "";

export function startOrderHeartbeat(main: KiwoomClient): void {
  const run = async () => {
    if (!ordersEnabled() || !orderClient()) return;
    const { date, minute } = kstParts();
    const trading = isTradingDate(date);
    /* ① 감시 루프가 멎었나 — 정규장에 90초 넘게 안 돌았고 기다리는 감시가 있으면 10분에 한 번 알린다 */
    if (trading && minute >= WATCH_FROM && minute <= WATCH_TO && lastWatchTick > 0 && Date.now() - lastWatchTick > 90_000) {
      const rows = await readWatches().catch(() => [] as AutoWatch[]);
      if (rows.some((r) => r.status === "waiting") && Date.now() - lastDeadAlert > 600_000) {
        lastDeadAlert = Date.now();
        void sendTelegram(`🚨 <b>자동감시 루프가 ${Math.round((Date.now() - lastWatchTick) / 1000)}초 동안 안 돌았다</b> — 기다리는 감시가 있다. 서버를 확인하라`, "order").catch(() => undefined);
      }
    }
    /* ② 08:55 아침 인사 — 오늘 살아 있는 것들 */
    if (trading && minute === 535 && greetedDay !== date) {
      greetedDay = date;
      const rows = await readWatches().catch(() => [] as AutoWatch[]);
      const waiting = rows.filter((r) => r.status === "waiting");
      const dual = waiting.filter((r) => r.dualDate === date && r.dualOrdNo).length;
      const { store, client } = peekRealtime();
      const rt = client ? (client.healthy ? "실시간 연결 정상" : "실시간 연결 불안정") : "실시간 연결 없음 — 조회로 판정";
      const keys = store?.health?.keys ?? 0;
      void sendTelegram(
        `🌅 ${orderIsMock() ? "[모의]" : "[실전]"} <b>주문 서버 아침 점검</b>\n자동감시 ${waiting.length}건 기다리는 중 (매수 ${waiting.filter((r) => r.ticket.side === "buy").length} · 매도 ${waiting.filter((r) => r.ticket.side === "sell").length}) · 이중 스톱 ${dual}건\n${rt}${keys ? ` · 시세 ${keys}종목` : ""}\n09:00 부터 3초마다 봅니다.`,
        "order",
      ).catch(() => undefined);
    }
    /* ③ 15:40 정합성 — 키움 체결 중 우리 기록에 없는 주문번호 */
    if (trading && minute === 940 && reconciledDay !== date) {
      reconciledDay = date;
      try {
        const [fl, log] = await Promise.all([fills(), readLog(3000)]);
        const ours = new Set(log.filter((r) => r.kind === "order" && r.ordNo).map((r) => r.ordNo));
        const strangers = fl.filter((f) => f.filled > 0 && !ours.has(f.ordNo));
        const mine = fl.filter((f) => f.filled > 0 && ours.has(f.ordNo));
        const sum = (xs: OpenRow[]) => xs.reduce((a, f) => a + f.price * f.filled, 0);
        const body =
          `🧮 ${orderIsMock() ? "[모의]" : "[실전]"} <b>저녁 정합성</b> — 오늘 체결 ${fl.filter((f) => f.filled > 0).length}건\n` +
          `우리가 낸 것 ${mine.length}건 · ${won(sum(mine))}\n` +
          (strangers.length > 0
            ? `⚠️ <b>우리 기록에 없는 체결 ${strangers.length}건</b>: ${strangers.map((f) => `${esc(f.name)} ${f.side} ${f.filled}주 #${f.ordNo}`).join(", ")}\n이 앱 밖(영웅문 등)에서 낸 주문이 아니면 앱키를 의심하라`
            : "우리 기록과 어긋나는 체결 없음");
        void sendTelegram(body, "order").catch(() => undefined);
        await appendLog({ kind: "session", msg: `저녁 정합성 — 체결 ${fl.length}건, 기록 밖 ${strangers.length}건` });
      } catch (e) {
        await appendLog({ kind: "error", msg: `저녁 정합성 실패 — ${e instanceof Error ? e.message : String(e)}` });
      }
    }
    void main;
  };
  setInterval(() => void run().catch(() => undefined), 30_000);
  console.log("[order] 심장 박동 — 루프 멎음 알림 · 08:55 아침 점검 · 15:40 저녁 정합성");
}

export async function autoWatchSummary(): Promise<{ allowed: boolean; waiting: number; fired: number }> {
  const [g, rows] = await Promise.all([getGuard(), readWatches()]);
  return { allowed: g.allowAutoWatch, waiting: rows.filter((r) => r.status === "waiting").length, fired: rows.filter((r) => r.status === "fired").length };
}

export function startAutoWatch(main: KiwoomClient): void {
  setInterval(() => void runAutoWatch(main).catch(() => undefined), 3_000);
  console.log("[order] 자동감시주문 — 정규장에 3초마다 값을 보고 조건에 닿은 주문서를 한 번 낸다");
}

/* ── 체결 감시 → 종 + 텔레그램 ────────────────────────────────────────── */

interface Watched {
  t: OrderTicket;
  filled: number;
  since: number;
  errors: number;
}

const watching = new Map<string, Watched>();
let timer: ReturnType<typeof setInterval> | null = null;
const WATCH_MS = 5_000;
const WATCH_MAX_MS = 5 * 3600_000;

function watch(ordNo: string, t: OrderTicket): void {
  watching.set(ordNo, { t, filled: 0, since: Date.now(), errors: 0 });
  if (!timer) timer = setInterval(() => void tick(), WATCH_MS);
}

/** 체결 감시가 알려 줄 곳 — 자동감시가 「체결되면 매도 감시」를 걸 때 쓴다 */
const fillHooks = new Map<string, (ev: { filled: number; price: number; full: boolean; done: boolean; status: string }) => void>();

function unwatch(ordNo: string): void {
  watching.delete(ordNo);
  if (watching.size === 0 && timer) {
    clearInterval(timer);
    timer = null;
  }
}

let ticking = false;

/**
 * 우리가 낸 주문만 본다(ka10076 에서 주문번호로). 체결량이 늘면 알림, 다 차거나 취소·거부면 그만.
 * 5초 주기라도 감시 중일 때만 돈다 — 미체결이 없으면 호출이 0 이다.
 */
async function tick(): Promise<void> {
  if (ticking || watching.size === 0) return;
  ticking = true;
  try {
    const rows = await fills();
    for (const [ordNo, w] of [...watching]) {
      if (Date.now() - w.since > WATCH_MAX_MS) {
        /* 시한이 다한 주문 — 자동감시가 붙어 있으면 「끝났다」고 알려 줘야 카드가 「체결 대기」에 안 머문다 (2026-09-07 밤 점검) */
        fillHooks.get(ordNo)?.({ filled: w.filled, price: 0, full: false, done: true, status: "감시 시한(5시간) 종료" });
        fillHooks.delete(ordNo);
        unwatch(ordNo);
        continue;
      }
      const mine = rows.filter((r) => r.ordNo === ordNo);
      if (mine.length === 0) continue;
      const filled = Math.max(...mine.map((r) => r.filled));
      const status = mine[0].status;
      const done = /취소|거부|확인/.test(status);
      if (filled > w.filled) {
        const px = mine[0].price;
        w.filled = filled;
        const sideKo = w.t.side === "buy" ? "매수" : "매도";
        const full = filled >= w.t.qty;
        const title = `${full ? "✅ 체결" : "🟡 일부 체결"} · ${w.t.name} ${sideKo} ${filled}/${w.t.qty}주${px ? ` @ ${px.toLocaleString()}` : ""}`;
        const tag = orderIsMock() ? "[모의]" : "[실전]";
        await appendLog({ kind: "fill", side: w.t.side, code: w.t.code, name: w.t.name, qty: filled, price: px || null, venue: w.t.venue, ordNo, msg: status });
        await pushNotice({
          kind: "stock",
          source: "order",
          level: "urgent",
          title: `${tag} ${title}`,
          body: `주문번호 ${ordNo} · ${w.t.venue} · ${status || "체결"}`,
          code: w.t.code,
          name: w.t.name,
          link: stockLink(w.t.code, w.t.name),
          dedupeKey: `order:fill:${ordNo}:${filled}`,
          dedupeHours: 24,
        });
        void sendTelegram(`${tag} ${esc(title)}\n주문번호 ${esc(ordNo)} · ${w.t.venue}`, "order").catch(() => undefined);
        fillHooks.get(ordNo)?.({ filled, price: px, full, done: full, status });
        if (full) {
          unwatch(ordNo);
          fillHooks.delete(ordNo);
        }
      } else if (done) {
        await appendLog({ kind: "fill", code: w.t.code, name: w.t.name, ordNo, msg: `감시 종료 — ${status}` });
        fillHooks.get(ordNo)?.({ filled: w.filled, price: mine[0].price, full: false, done: true, status });
        unwatch(ordNo);
        fillHooks.delete(ordNo);
      }
    }
  } catch (e) {
    // 필드명이 다르거나 키움이 잠깐 죽은 것 — 감시는 이어 가되 30번 연속이면 알리고 그만
    for (const w of watching.values()) w.errors += 1;
    const worst = Math.max(...[...watching.values()].map((w) => w.errors), 0);
    if (worst === 30) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendLog({ kind: "error", msg: `체결 감시 실패 30회 — ${msg}` });
      /* 로그 방으로 (2026-09-04) — 주문이 아니라 조회가 고장 난 것이다 */
      void sendTelegram(`⚠️ 체결 감시가 계속 실패한다 — 미체결 탭에서 직접 확인\n${esc(msg)}`, "log").catch(() => undefined);
    }
  } finally {
    ticking = false;
  }
}

/**
 * **이상한 낌새를 알린다** (2026-09-04) — 벤티지: "이상 징후가 있는 경우 나한테 알림을."
 *
 * 겹을 아무리 쌓아도 **뚫렸을 때 알아채는 것**과는 다른 일이다. 기록만 남기면 사고가 난 뒤
 * 파일을 열어 봐야 알고, 그때는 이미 늦다. 그래서 「평소와 다른 것」은 그 자리에서 보낸다.
 *
 * 무엇을 이상하다고 보나 — 셋 다 **평소에는 안 울리는 것**이어야 한다. 자주 울리는 경보는
 * 아무도 안 본다.
 *   ① 처음 보는 주소(IP)에서 주문 메뉴를 열었다
 *   ② 하루 한도의 8할을 넘겼다 (금액 또는 건수)
 *   ③ 거절이 잇달았다 (5분에 세 번 — 뭔가를 더듬고 있다는 뜻이다)
 */
const seenIps = new Set<string>();
let ipsLoaded = false;
const rejectTimes: number[] = [];

async function loadSeenIps(): Promise<void> {
  if (ipsLoaded) return;
  ipsLoaded = true;
  for (const r of await readLog(2000)) if (r.ip) seenIps.add(r.ip);
}

/** 처음 보는 주소인가 — 기록 전체를 한 번만 훑어 기억해 둔다 */
export async function noteAccess(ip: string, what: string): Promise<void> {
  await loadSeenIps();
  if (seenIps.has(ip)) return;
  seenIps.add(ip);
  await appendLog({ kind: "lock", ip, msg: `처음 보는 주소에서 ${what}` });
  void sendTelegram(
    `🚨 <b>처음 보는 주소에서 ${esc(what)}</b>
주소 ${esc(ip)}
본인이 아니면 지금 서버의 ORDERS_ENABLED 를 끄세요.`,
    "syslog",
  ).catch(() => undefined);
}

/** 거절이 잇달으면 — 누군가 한도를 더듬고 있다 */
function noteReject(): void {
  const now = Date.now();
  rejectTimes.push(now);
  while (rejectTimes.length > 0 && now - rejectTimes[0] > 5 * 60_000) rejectTimes.shift();
  if (rejectTimes.length === 3) {
    void sendTelegram("⚠️ 5분 안에 주문이 <b>세 번 거절</b>됐습니다 — 주문 › 설정 › 로그를 보세요.", "syslog").catch(
      () => undefined,
    );
  }
}

/** 한도의 8할을 넘겼을 때 한 번 — 평소에는 안 울린다 */
let warnedToday = "";
async function noteUsage(): Promise<void> {
  const { date } = kstParts();
  if (warnedToday === date) return;
  const [g, u] = await Promise.all([getGuard(), todayUsage()]);
  const hotKrw = u.krw >= g.maxDailyKrw * 0.8;
  const hotCnt = u.count >= g.maxDailyCount * 0.8;
  if (!hotKrw && !hotCnt) return;
  warnedToday = date;
  void sendTelegram(
    `📊 오늘 주문이 한도의 8할을 넘었습니다 — ${u.count}/${g.maxDailyCount}건 · ${won(u.krw)} / ${won(g.maxDailyKrw)}`,
    "order",
  ).catch(() => undefined);
}

/* ── 스스로 훑기 (2026-09-04) ──────────────────────────────────────────── */

/**
 * **기록을 사람이 읽게 두지 않는다** — 벤티지: "전부를 다 보여줄 필요는 없어. 그럼 엄청
 * 쌓일 테니깐. 「기록 중」이라고만 쓰고 「이상 행위 없었음」 이렇게 표시해줘. 니가 주기적으로
 * 체크해주고."
 *
 * 맞다. 로그를 화면에 늘어놓는 건 **판정을 사람에게 미루는 것**이다. 하루 수십 줄이 쌓이면
 * 아무도 안 읽고, 안 읽는 기록은 없는 것과 같다. 기계가 훑고 **다른 것만** 말한다.
 *
 * 무엇을 「이상」으로 보나 — 전부 **평소에는 0인 것**들이다:
 *   · 주소가 둘 이상 (내 기기는 대개 한 자리에서 들어온다)
 *   · 비밀번호·로그인 실패
 *   · 한도에 걸려 거절 · 키움이 거절한 실패
 *   · 기기 등록·삭제 · 화면 잠금
 * 하나도 없으면 「이상 행위 없었음」이다. 그 한 줄이 백 줄짜리 표보다 낫다.
 */
export interface AccessAudit {
  /** 훑은 구간(시간) */
  hours: number;
  /** 그 구간에 쌓인 줄 수 — 「기록 중」의 근거 */
  records: number;
  /** 통째로 쌓인 줄 수 */
  total: number;
  /** 들어온 주소들 */
  ips: string[];
  /** 이상한 것만 */
  findings: { at: string; kind: OrderLogKind; ip?: string; msg: string; level: "warn" | "info" }[];
  ok: boolean;
  checkedAt: string;
}

const AUDIT_KINDS: OrderLogKind[] = ["session", "lock", "password", "reject", "error"];

export async function auditAccess(hours = 24): Promise<AccessAudit> {
  const all = await readLog(2000);
  const since = Date.now() - hours * 3600_000;
  const rows = all.filter((r) => new Date(r.at).getTime() >= since);
  const gate = rows.filter((r) => AUDIT_KINDS.includes(r.kind));
  const ips = [...new Set(gate.map((r) => r.ip).filter((v): v is string => Boolean(v)))];

  const findings: AccessAudit["findings"] = [];
  for (const r of gate) {
    const m = r.msg ?? "";
    /* 「열림」은 평소 일이라 세지 않는다 — 다만 주소가 여럿이면 아래에서 한 줄로 걸린다 */
    if (r.kind === "session" && /열림/.test(m) && !/실패|등록|삭제/.test(m)) continue;
    const warn =
      r.kind === "reject" ||
      r.kind === "error" ||
      /실패|잠금|삭제/.test(m);
    /*
     * 기기 **등록**은 경보에서 뺐다 (2026-09-04). 본인이 방금 한 일이고, 등록은 이미
     * 메일 확인을 지나야 된다 — 지난 문을 다시 알릴 이유가 없다. 반면 기기 **삭제**는
     * 위 `/삭제/` 에 그대로 걸린다(누가 내 기기를 지우는 것은 다른 이야기다).
     */
    findings.push({ at: r.at, kind: r.kind, ip: r.ip, msg: m, level: warn ? "warn" : "info" });
  }
  /*
   * ⚠️ 아래 둘은 **`info` 다** (2026-09-04에 내렸다 — 벤티지: "주문 접근 점검 텔레그램
   * 계속 오는데 이것 좀 어떻게 좀 해봐").
   *
   * 둘 다 `warn` 이었고, 둘 다 `at` 이 **점검한 시각**이라 매번 새 값이었다. 위의 주기
   * 점검은 「같은 내용이면 안 보낸다」를 `findings[0].at` 으로 판정했는데, 그 값이 매번
   * 바뀌니 **중복 방지가 통째로 무력했다.** 그래서 6시간마다 같은 소리가 왔다.
   *
   * 시각만 고쳐도 덜 오지만, 애초에 이 둘은 경보가 아니다:
   *
   *   · **주소 여럿** — 폰·태블릿·PC 를 쓰고 밖에서도 접속하면 당연히 여럿이다.
   *     진짜 신호는 「처음 보는 주소」이고 그건 `noteAccess` 가 그 자리에서 따로 알린다.
   *     여기서 또 세면 정상 사용이 매번 경보가 된다.
   *   · **기본 PIN** — 이건 **할 일**이지 이상 행위가 아니다. 화면이 빨갛게 적어 두면
   *     되고, 여섯 시간마다 찌를 일이 아니다.
   *
   * `info` 는 화면에는 그대로 뜨고 `ok` 를 안 깬다 — 텔레그램만 안 간다.
   */
  const auth = await loadAuth();
  const cfgNow = await getSettings();
  if ((cfgNow.entryMode === "pin" || cfgNow.entryMode === "pattern") && auth.pinHash.length === 0) {
    findings.unshift({
      at: new Date().toISOString(),
      kind: "password",
      msg: `진입 PIN 이 아직 기본값(${DEFAULT_PIN})입니다 — 주문 › 설정에서 바꾸세요`,
      level: "info",
    });
  }
  if (ips.length > 1) {
    findings.unshift({
      at: new Date().toISOString(),
      kind: "lock",
      msg: `주소가 ${ips.length} 곳에서 들어왔습니다 — ${ips.join(" · ")}`,
      level: "info",
    });
  }

  return {
    hours,
    records: rows.length,
    total: all.length,
    ips,
    findings: findings.slice(0, 30),
    /* 「이상 없음」은 **경보가 없다**는 뜻이다 — 적어 둘 거리(info)는 이상이 아니다 */
    ok: findings.every((f) => f.level !== "warn"),
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 주기 점검 — **조용한 것이 기본**이다. 이상이 없으면 아무 데도 안 보낸다.
 * 화면은 `auditAccess` 를 직접 불러 「마지막 점검·이상 없음」을 스스로 말한다.
 */
let lastAuditKey = "";

/**
 * 점검 물때 — **어디까지 알렸나.** 파일에 적는 이유는 위 주석 그대로다:
 * 메모리에만 두면 재시작이 초기화하고, 배포가 잦은 날 같은 소리가 반복된다.
 */
const MARK_FILE = join(DATA_DIR, "orderAuditMark.json");

async function readAuditMark(): Promise<string> {
  try {
    const j = JSON.parse(await fs.readFile(MARK_FILE, "utf8")) as { at?: string };
    return typeof j.at === "string" ? j.at : "";
  } catch {
    return "";
  }
}

async function writeAuditMark(at: string): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(MARK_FILE, JSON.stringify({ at }), "utf8");
  } catch {
    /* 못 적으면 다음에 한 번 더 올 뿐이다 — 주문을 막을 일이 아니다 */
  }
}

export function startOrderAudit(): void {
  const run = async () => {
    if (!ordersEnabled()) return;
    try {
      const a = await auditAccess(24);
      if ((await getSettings()).auditTelegram === false) return;

      /*
       * **아직 안 알린 것만.** (2026-09-04 두 번째 고침)
       *
       * 벤티지: "얘는 왜 계속 알람 오냐… 적당히 오라고 해, 문제 없었던 거니깐."
       *
       * 첫 번째 고침(중복 열쇠를 내용으로)은 **재시작을 못 견뎠다.** 열쇠가 메모리에만
       * 있고 뜰 때 `void run()` 이 한 번 도니까, **배포할 때마다 같은 소리가 다시 갔다.**
       * 오늘 여섯 번 배포했고 여섯 번 왔다. 그래서 물때(watermark)를 **파일에 적는다.**
       */
      const mark = await readAuditMark();
      const fresh = a.findings.filter((f) => f.level === "warn" && f.at > mark);
      if (fresh.length === 0) return;

      /*
       * **끝이 좋았으면 안 알린다.**
       *
       * 「PIN 실패 1/5 · 2/5」 뒤에 열렸으면 그건 **오타지 사건이 아니다.** 사람이
       * 손가락을 헛디딘 것을 여섯 시간마다 알리면, 정작 진짜일 때 안 읽게 된다.
       * 알리는 것은 **잠금까지 간 것**과 **거절·오류·기기 삭제**뿐이다.
       */
      const serious = fresh.filter((f) => !/실패 \d+회|열기 실패|잠금 해제/.test(f.msg));
      await writeAuditMark(a.checkedAt);
      if (serious.length === 0) return;

      const lines = serious
        .slice(0, 6)
        .map((f) => `• ${f.at.slice(5, 16).replace("T", " ")} ${esc(f.msg)}${f.ip ? ` (${esc(f.ip)})` : ""}`);
      const body =
        `🔎 <b>주문 접근 점검</b> — 새로 눈에 띄는 것 ${serious.length}건
` +
        lines.join(`
`) +
        `

주문 › 설정 › 접근 로그에서 봅니다.`;
      await sendTelegram(body, "syslog");
    } catch {
      /* 점검이 실패해도 주문은 돌아야 한다 */
    }
  };
  /*
   * 뜨자마자 돌리지 않는다 — 배포가 잦은 날 재시작마다 한 번씩 울렸다.
   * 5분 뒤 첫 점검이면 사고를 놓치지 않으면서 배포 소음이 사라진다.
   */
  setTimeout(() => void run(), 5 * 60_000);
  setInterval(() => void run(), 6 * 3600_000);
  console.log("[order] 접근 점검 6시간마다 — 새 사건이 있고 심각할 때만 알립니다");
}

/* ── 상태 ─────────────────────────────────────────────────────────────── */

export async function orderStatus(req: Request): Promise<Record<string, unknown>> {
  const enabled = ordersEnabled();
  const configured = orderClient() !== null;
  const a = await loadAuth();
  const [guard, today, settings] = await Promise.all([
    getGuard(),
    todayUsage().catch(() => ({ krw: 0, count: 0 })),
    getSettings(),
  ]);
  const s = sessionOf(req);
  return {
    enabled,
    configured,
    mock: orderIsMock(),
    reason: !enabled
      ? "서버 .env 에 ORDERS_ENABLED=1 이 없다 (킬 스위치)"
      : !configured
        ? "서버 .env 에 KIWOOM_ORDER_APP_KEY / KIWOOM_ORDER_APP_SECRET 이 없다"
        : null,
    hasPassword: a.hash.length > 0,
    /* 진입 PIN 을 아직 안 바꿨나 — 화면이 계속 조를 수 있게 */
    pinIsDefault: a.pinHash.length === 0,
    pinLockedUntilMs: a.pinLockUntil > Date.now() ? a.pinLockUntil : 0,
    session: s !== null,
    sessionLeftSec: s ? sessionLeftSec(req) : 0,
    settings,
    passwordLeftSec: s ? passwordLeftSec(req) : 0,
    uiLocked: a.uiLocked,
    lockedUntilMs: a.lockUntil > Date.now() ? a.lockUntil : 0,
    guard,
    today,
    open: Object.fromEntries(VENUES.map((v) => [v, venueOpen(v)])),
    /* 지금 낼 수 있는 거래소 — 모의는 KRX 뿐이다. 화면이 나머지를 잠근다 */
    venueAllowed: orderIsMock() ? ["KRX"] : VENUES,
    /* 화면이 매매구분을 하드코딩하지 않게 — 표를 고치면 화면이 따라온다 */
    tradeTypes: TRADE_TYPES,
    watching: watching.size,
    /* 자동감시 (2026-09-07 밤) — 몇 건 지켜보나·발동해서 체결 기다리나 */
    autoWatch: await autoWatchSummary().catch(() => ({ allowed: false, waiting: 0, fired: 0 })),
    /* 살아 있다는 신호 — 감시 루프가 마지막으로 돈 때 (개편 ②) */
    watchTickAgoSec: lastWatchTick > 0 ? Math.round((Date.now() - lastWatchTick) / 1000) : null,
  };
}
