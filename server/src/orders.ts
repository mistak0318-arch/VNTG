import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { scryptHex } from "./auth.js";
import { priceMap } from "./cisRun.js";
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
 *   REST 에 **없는 것**  = 예약주문 · 자동감시주문 — 영웅문 HTS 의 기능이다. 이걸 흉내 내려면 우리
 *                        서버가 스스로 주문을 쏴야 하고, 그게 곧 설계가 제외한 「자동감시」다. 만들지 않는다.
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
}

const DEFAULT_GUARD: OrderGuard = {
  maxOrderKrw: 1_000_000,
  maxDailyKrw: 3_000_000,
  maxDailyCount: 20,
  priceCollarPct: 5,
  stopCollarPct: 30,
  marketHoursOnly: true,
  allowedCodes: null,
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
  | "raw";

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
   * 주문 메뉴를 **무엇으로 여나** (2026-09-04).
   *   "password" 앱 아이디·비밀번호를 다시 (기본)
   *   "pin"      네 자리 숫자 — 손이 편하다. 대신 **기기 등록이 켜져 있어야만** 고를 수 있다
   *
   * PIN 은 만 가지뿐이라 **혼자 서는 문이 아니다.** 앞에 등록된 기기가 있어야 뜻이 산다 —
   * 그래서 `requireTrustedDevice` 가 꺼져 있으면 이 값을 "pin" 으로 못 바꾼다(saveSettings).
   */
  entryMode: "password" | "pin";
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
    entryMode: patch.entryMode === "pin" || patch.entryMode === "password" ? patch.entryMode : cur.entryMode,
  };

  /*
   * **PIN 은 기기 등록 없이는 못 쓴다.** 네 자리는 만 가지뿐이라, 앞에 「가진 것」이 없으면
   * 앱 로그인만 뚫리면 주문 문이 사실상 열린다. 둘을 한 묶음으로 강제한다 —
   * 「편하게」와 「위험하게」가 같은 뜻이 되지 않도록.
   */
  if (next.entryMode === "pin" && !next.requireTrustedDevice) {
    throw new Error("PIN 으로 열려면 「등록된 기기에서만 주문」이 켜져 있어야 합니다");
  }
  await writeJson(SETTINGS_FILE, next);
  await appendLog({ kind: "password", msg: `설정 변경 — 비밀번호 기억 ${next.rememberPassword ? `${next.rememberMinutes}분` : "끔"}` });
  /* 기억하기를 켜는 것은 겹 하나를 무르는 일이라 조용히 넘어가지 않는다 */
  if (next.rememberPassword && !cur.rememberPassword) {
    void sendTelegram(
      `🔓 주문 비밀번호 <b>기억하기</b>를 켰습니다 (${next.rememberMinutes}분).
주문 세션이 열려 있는 동안 실행마다 묻지 않습니다.`,
      "order",
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
  try {
    await fs.access(GUARD_FILE);
  } catch {
    await writeJson(GUARD_FILE, g); // 손으로 고칠 수 있게 파일을 만들어 둔다
  }
  return g;
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

export function clientIp(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  return req.socket.remoteAddress ?? "?";
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

export async function setOrderPassword(next: string, current: string | null): Promise<void> {
  const a = await loadAuth();
  if (a.hash) {
    const r = await checkPassword(current ?? "");
    if (!r.ok) throw new Error(r.error);
  }
  if (next.length < 6) throw new Error("주문 비밀번호는 6자 이상");
  const salt = randomBytes(16).toString("hex");
  const hash = await scryptHex(next, salt);
  await writeJson(AUTH_FILE, { ...a, salt, hash, fails: 0, lockUntil: 0 } satisfies OrderAuthFile);
  await appendLog({ kind: "password", msg: a.hash ? "주문 비밀번호 변경" : "주문 비밀번호 처음 설정" });
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
  const same = given.length === a.hash.length && Buffer.from(given, "hex").equals(Buffer.from(a.hash, "hex"));
  if (same) {
    if (a.fails) await writeJson(AUTH_FILE, { ...a, fails: 0 });
    return { ok: true };
  }
  const fails = a.fails + 1;
  const lockUntil = fails >= PW_MAX_FAILS ? Date.now() + PW_LOCK_MS : 0;
  await writeJson(AUTH_FILE, { ...a, fails: lockUntil ? 0 : fails, lockUntil });
  await appendLog({ kind: "lock", msg: lockUntil ? "주문 비밀번호 5회 실패 — 30분 잠금" : `주문 비밀번호 실패 ${fails}회` });
  if (lockUntil) {
    void sendTelegram("🔐 <b>주문 비밀번호 5회 실패 — 30분 잠금</b>\n본인이 아니면 지금 서버의 ORDERS_ENABLED 를 끄세요.", "order").catch(
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
export async function setOrderPin(next: string, current: string): Promise<void> {
  const pin = next.replace(/\D/g, "");
  if (pin.length !== 4) throw new Error("네 자리 숫자로");
  if (TRIVIAL_PINS.has(pin)) throw new Error("너무 뻔한 숫자입니다 — 0000·1234 같은 것은 막습니다");
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
  await appendLog({ kind: "password", msg: a.pinHash ? "진입 PIN 변경" : "진입 PIN 처음 설정" });
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
      "order",
    ).catch(() => undefined);
    return { ok: false, error: "5회 틀림 — 30분 잠금" };
  }
  return { ok: false, error: `PIN 이 다릅니다 (${fails}/${PIN_MAX_FAILS})` };
}

function sameHexSafe(a: string, b: string): boolean {
  return a.length === b.length && a.length > 0 && Buffer.from(a, "hex").equals(Buffer.from(b, "hex"));
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
const pending = new Map<string, { exp: number; ticket: Ticket }>();

function issueNonce(ticket: Ticket): { nonce: string; expiresAt: number } {
  for (const [k, v] of pending) if (v.exp < Date.now()) pending.delete(k);
  const nonce = randomBytes(16).toString("hex");
  const expiresAt = Date.now() + NONCE_MS;
  pending.set(nonce, { exp: expiresAt, ticket });
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
  /*
   * 시간외 주문(61·62·81)은 **정규장 밖에 내는 것이 정상**이라 우리 시간창으로 막으면 기능이 죽는다.
   * 그렇다고 시간외 창을 새로 박아 두지는 않는다 — 시간표는 2026-09-14 KRX 애프터시장 개편 때
   * 한 번에 고치기로 한 자리다(docs/다음작업_TODO.md). 그때까지는 키움이 거절하게 둔다.
   */
  if (g.marketHoursOnly && !tt.late && !venueOpen(input.venue)) {
    reject(`${input.venue} 가 주문을 받는 시간이 아니다`, input, ip);
  }

  let ref = 0;
  try {
    ref = (await priceMap(main, [input.code])).get(input.code) ?? 0;
  } catch {
    ref = 0;
  }
  if (input.price === null && ref <= 0) reject("현재가를 못 읽어 주문 금액을 잴 수 없다 — 값을 적는 구분으로", input, ip);

  if (tt.cond && input.condPrice !== null) {
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
  const unit = input.price ?? input.condPrice ?? ref;
  const amount = unit * input.qty;
  if (amount > g.maxOrderKrw) reject(`한 건 한도 초과 — ${amount.toLocaleString()}원 > ${g.maxOrderKrw.toLocaleString()}원`, input, ip);
  const used = await todayUsage();
  if (used.krw + amount > g.maxDailyKrw) {
    reject(`오늘 한도 초과 — 이미 ${used.krw.toLocaleString()}원 + 이번 ${amount.toLocaleString()}원 > ${g.maxDailyKrw.toLocaleString()}원`, input, ip);
  }
  if (used.count + 1 > g.maxDailyCount) reject(`오늘 건수 한도 초과 — ${used.count}/${g.maxDailyCount}`, input, ip);

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
  };
  return { ...issueNonce(ticket), ticket };
}

export async function prepareCancel(
  input: { ordNo: string; code: string; name: string; qty: number; venue: OrderVenue },
  ip: string,
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
  return { ...issueNonce(ticket), ticket };
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
  const { data } = await oc.request<Record<string, unknown>>(ORDER_RESOURCE, apiId, body, { noAl: true });
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
  try {
    const r = await placeOrder(t);
    if (t.kind === "cancel") {
      await appendLog({ kind: "cancel", ip, code: t.code, name: t.name, qty: t.qty, venue: t.venue, origOrdNo: t.ordNo, ordNo: r.ordNo, msg: r.msg, raw: r.raw });
      unwatch(t.ordNo);
      void sendTelegram(`🧾 ${tag} <b>취소</b> ${esc(t.name)} ${t.qty}주 (원주문 ${esc(t.ordNo)})\n${esc(r.msg)}`, "order").catch(() => undefined);
    } else {
      await appendLog({ kind: "order", ip, side: t.side, code: t.code, name: t.name, qty: t.qty, price: t.price, condPrice: t.condPrice, tradeType: t.tradeType, venue: t.venue, ordNo: r.ordNo, amount: t.amount, msg: graced ? `${r.msg} · 비밀번호 기억으로` : r.msg, raw: r.raw });
      const sideKo = t.side === "buy" ? "매수" : "매도";
      const priceKo = t.price === null ? "시장가" : `${t.price.toLocaleString()}원`;
      void sendTelegram(
        `🧾 ${tag} <b>${sideKo} 주문</b> ${esc(t.name)} ${t.qty}주 @ ${priceKo} · ${t.venue}\n금액 ${won(t.amount)} · 주문번호 ${esc(r.ordNo || "?")}\n${esc(r.msg)}`,
        "order",
      ).catch(() => undefined);
      if (r.ordNo) watch(r.ordNo, t);
      void noteUsage();
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

export async function openOrders(): Promise<OpenRow[]> {
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

export async function fills(): Promise<OpenRow[]> {
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
export async function orderAccount(): Promise<{
  deposit: number;
  holdings: Array<{ code: string; name: string; qty: number; avg: number; cur: number; pnl: number; pnlRate: number }>;
}> {
  const oc = orderClient();
  if (!oc) return { deposit: 0, holdings: [] };
  const [dep, bal] = await Promise.all([
    oc.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00001", { qry_tp: "3" }).catch(() => null),
    oc.request<Record<string, unknown>>(ACNT_RESOURCE, "kt00018", { qry_tp: "1", dmst_stex_tp: "KRX" }).catch(() => null),
  ]);
  const deposit = dep ? num(pick(dep.data, ["100stk_ord_alow_amt", "ord_alow_amt", "entr"])) : 0;
  const holdings = bal
    ? listOf(bal.data, ["acnt_evlt_remn_indv_tot"]).map((r) => ({
        code: str(pick(r, ["stk_cd"])).replace(/^A/, "").replace(/_.*$/, ""),
        name: str(pick(r, ["stk_nm"])),
        qty: num(pick(r, ["rmnd_qty"])),
        avg: num(pick(r, ["pur_pric"])),
        cur: num(pick(r, ["cur_prc"])),
        pnl: num(pick(r, ["evltv_prft"])),
        pnlRate: num(pick(r, ["prft_rt"])),
      }))
    : [];
  return { deposit, holdings };
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
        if (full) unwatch(ordNo);
      } else if (done) {
        await appendLog({ kind: "fill", code: w.t.code, name: w.t.name, ordNo, msg: `감시 종료 — ${status}` });
        unwatch(ordNo);
      }
    }
  } catch (e) {
    // 필드명이 다르거나 키움이 잠깐 죽은 것 — 감시는 이어 가되 30번 연속이면 알리고 그만
    for (const w of watching.values()) w.errors += 1;
    const worst = Math.max(...[...watching.values()].map((w) => w.errors), 0);
    if (worst === 30) {
      const msg = e instanceof Error ? e.message : String(e);
      await appendLog({ kind: "error", msg: `체결 감시 실패 30회 — ${msg}` });
      void sendTelegram(`⚠️ 체결 감시가 계속 실패한다 — 미체결 탭에서 직접 확인\n${esc(msg)}`, "order").catch(() => undefined);
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
    "order",
  ).catch(() => undefined);
}

/** 거절이 잇달으면 — 누군가 한도를 더듬고 있다 */
function noteReject(): void {
  const now = Date.now();
  rejectTimes.push(now);
  while (rejectTimes.length > 0 && now - rejectTimes[0] > 5 * 60_000) rejectTimes.shift();
  if (rejectTimes.length === 3) {
    void sendTelegram("⚠️ 5분 안에 주문이 <b>세 번 거절</b>됐습니다 — 주문 › 설정 › 로그를 보세요.", "order").catch(
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
      /실패|잠금|삭제/.test(m) ||
      (r.kind === "session" && /등록/.test(m));
    findings.push({ at: r.at, kind: r.kind, ip: r.ip, msg: m, level: warn ? "warn" : "info" });
  }
  /* 기본 PIN 은 그 자체로 「이상」이다 — 아무도 안 바꾸면 문이 열려 있는 것과 같다 */
  const auth = await loadAuth();
  const cfgNow = await getSettings();
  if (cfgNow.entryMode === "pin" && auth.pinHash.length === 0) {
    findings.unshift({
      at: new Date().toISOString(),
      kind: "password",
      msg: `진입 PIN 이 아직 기본값(${DEFAULT_PIN})입니다 — 주문 › 설정에서 바꾸세요`,
      level: "warn",
    });
  }
  if (ips.length > 1) {
    findings.unshift({
      at: new Date().toISOString(),
      kind: "lock",
      msg: `주소가 ${ips.length} 곳에서 들어왔습니다 — ${ips.join(" · ")}`,
      level: "warn",
    });
  }

  return {
    hours,
    records: rows.length,
    total: all.length,
    ips,
    findings: findings.slice(0, 30),
    ok: findings.length === 0,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * 주기 점검 — **조용한 것이 기본**이다. 이상이 없으면 아무 데도 안 보낸다.
 * 화면은 `auditAccess` 를 직접 불러 「마지막 점검·이상 없음」을 스스로 말한다.
 */
let lastAuditKey = "";

export function startOrderAudit(): void {
  const run = async () => {
    if (!ordersEnabled()) return;
    try {
      const a = await auditAccess(24);
      if (a.ok) return;
      /* 같은 내용으로 하루에 두 번 울리지 않는다 — 새 발견이 있을 때만 */
      const key = `${kstParts().date}:${a.findings.length}:${a.findings[0]?.at ?? ""}`;
      if (key === lastAuditKey) return;
      lastAuditKey = key;
      const lines = a.findings
        .filter((f) => f.level === "warn")
        .slice(0, 6)
        .map((f) => `• ${f.at.slice(5, 16).replace("T", " ")} ${esc(f.msg)}${f.ip ? ` (${esc(f.ip)})` : ""}`);
      if (lines.length === 0) return;
      const body =
        `🔎 <b>주문 접근 점검</b> — 지난 ${a.hours}시간에 눈에 띄는 것 ${lines.length}건\n` +
        lines.join(`\n`) +
        `\n\n주문 › 설정 › 접근 로그에서 봅니다.`;
      await sendTelegram(body, "order",
      );
    } catch {
      /* 점검이 실패해도 주문은 돌아야 한다 */
    }
  };
  void run();
  setInterval(() => void run(), 6 * 3600_000);
  console.log("[order] 접근 점검 6시간마다 — 이상이 없으면 조용합니다");
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
  };
}
