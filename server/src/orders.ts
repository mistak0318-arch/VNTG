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
 *   REST 에 **없는 것**  = 예약주문 · 스탑로스 · 자동감시주문 — 영웅문 HTS 의 기능이다. 이걸 흉내 내려면 우리
 *                        서버가 스스로 주문을 쏴야 하고, 그게 곧 설계가 제외한 「자동감시」다. 만들지 않는다.
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
 * ## 실측 전 (2026-09-03 밤) — 필드명 주의
 *   주문 TR 의 요청 필드(dmst_stex_tp·stk_cd·ord_qty·ord_uv·trde_tp·cond_uv / orig_ord_no·cncl_qty)와 응답 ord_no 는
 *   공개 가이드·예제에서 확인했다. 미체결(ka10075 `oso`)·체결(ka10076 `cntr`)의 **행 필드명은 모의에서 실측해
 *   확정**해야 한다 — 그래서 첫 응답의 원문을 기록(kind "raw")에 남기고, 화면도 정규화 값이 비면 원문을 그대로 보여 준다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const AUTH_FILE = join(DATA_DIR, "orderAuth.json");
const GUARD_FILE = join(DATA_DIR, "orderGuard.json");
const LOG_FILE = join(DATA_DIR, "orderLog.jsonl");

const ORDER_RESOURCE = "/api/dostk/ordr";
const ACNT_RESOURCE = "/api/dostk/acnt";

export type OrderSide = "buy" | "sell";
/** KRX 정규장 · NXT · SOR(통합 — 키움이 더 좋은 쪽으로 보내는 최선집행) */
export type OrderVenue = "KRX" | "NXT" | "SOR";
export const VENUES: OrderVenue[] = ["KRX", "NXT", "SOR"];

export interface OrderGuard {
  /** 주문 한 건의 상한(원). 지정가는 가격×수량, 시장가는 현재가×수량으로 잰다 */
  maxOrderKrw: number;
  /** 오늘 낸 주문(매수+매도)의 합 상한(원) */
  maxDailyKrw: number;
  /** 오늘 낸 주문 건수 상한 (취소는 안 센다) */
  maxDailyCount: number;
  /** 현재가에서 이만큼(%) 넘게 벗어난 지정가는 거절 — 0 을 하나 더 친 손가락 */
  priceCollarPct: number;
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
  /** null = 시장가 */
  price?: number | null;
  venue?: OrderVenue;
  ordNo?: string;
  origOrdNo?: string;
  amount?: number;
  msg?: string;
  raw?: unknown;
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

const EMPTY_AUTH: OrderAuthFile = { salt: "", hash: "", fails: 0, lockUntil: 0, uiLocked: false };

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
const IDLE_MS = 10 * 60_000;
const HARD_MS = 60 * 60_000;

interface OrderSession {
  idle: number;
  hard: number;
  ip: string;
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

export function openSession(req: Request, res: Response): void {
  const token = randomBytes(24).toString("hex");
  const now = Date.now();
  sessions.set(token, { idle: now + IDLE_MS, hard: now + HARD_MS, ip: clientIp(req) });
  setCookie(req, res, token, HARD_MS / 1000);
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
  s.idle = Math.min(now + IDLE_MS, s.hard);
  return s;
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

/* ── 두 단계 (L4) ─────────────────────────────────────────────────────── */

export interface OrderTicket {
  kind: "order";
  side: OrderSide;
  code: string;
  name: string;
  qty: number;
  /** null = 시장가 */
  price: number | null;
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
  venue: OrderVenue;
}

function reject(msg: string, input: Partial<PrepareInput>, ip: string): never {
  void appendLog({ kind: "reject", ip, side: input.side, code: input.code, name: input.name, qty: input.qty, price: input.price, venue: input.venue, msg });
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
  if (!VENUES.includes(input.venue)) reject("거래소 구분이 이상하다", input, ip);
  if (input.side !== "buy" && input.side !== "sell") reject("매수·매도 구분이 없다", input, ip);

  const g = await getGuard();
  if (g.allowedCodes && g.allowedCodes.length > 0 && !g.allowedCodes.includes(input.code)) {
    reject("허용 종목이 아니다 (orderGuard.allowedCodes)", input, ip);
  }
  if (g.marketHoursOnly && !venueOpen(input.venue)) reject(`${input.venue} 가 주문을 받는 시간이 아니다`, input, ip);

  let ref = 0;
  try {
    ref = (await priceMap(main, [input.code])).get(input.code) ?? 0;
  } catch {
    ref = 0;
  }
  if (input.price === null && ref <= 0) reject("현재가를 못 읽어 시장가 금액을 잴 수 없다 — 지정가로", input, ip);
  if (input.price !== null && ref > 0) {
    const off = (Math.abs(input.price - ref) / ref) * 100;
    if (off > g.priceCollarPct) {
      reject(`지정가가 현재가(${ref.toLocaleString()})에서 ${off.toFixed(1)}% 벗어났다 (한도 ${g.priceCollarPct}%)`, input, ip);
    }
  }
  const unit = input.price ?? ref;
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
      trde_tp: t.price === null ? "3" : "0", // 0 보통(지정가) · 3 시장가
      cond_uv: "",
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
): Promise<{ ordNo: string; msg: string; ticket: Ticket }> {
  const p = pending.get(nonce);
  if (!p || p.exp < Date.now()) {
    pending.delete(nonce);
    throw new Error("주문서가 만료됐다(30초) — 다시 만드세요");
  }
  const pw = await checkPassword(password);
  if (!pw.ok) throw new Error(pw.error);
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
      await appendLog({ kind: "order", ip, side: t.side, code: t.code, name: t.name, qty: t.qty, price: t.price, venue: t.venue, ordNo: r.ordNo, amount: t.amount, msg: r.msg, raw: r.raw });
      const sideKo = t.side === "buy" ? "매수" : "매도";
      const priceKo = t.price === null ? "시장가" : `${t.price.toLocaleString()}원`;
      void sendTelegram(
        `🧾 ${tag} <b>${sideKo} 주문</b> ${esc(t.name)} ${t.qty}주 @ ${priceKo} · ${t.venue}\n금액 ${won(t.amount)} · 주문번호 ${esc(r.ordNo || "?")}\n${esc(r.msg)}`,
        "order",
      ).catch(() => undefined);
      if (r.ordNo) watch(r.ordNo, t);
    }
    return { ordNo: r.ordNo, msg: r.msg, ticket: t };
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
    venue: str(pick(r, ["stex_tp", "dmst_stex_tp"])),
    time: str(pick(r, ["tm", "ord_tm"])),
    status: str(pick(r, ["ord_stt"])),
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

/* ── 상태 ─────────────────────────────────────────────────────────────── */

export async function orderStatus(req: Request): Promise<Record<string, unknown>> {
  const enabled = ordersEnabled();
  const configured = orderClient() !== null;
  const a = await loadAuth();
  const [guard, today] = await Promise.all([getGuard(), todayUsage().catch(() => ({ krw: 0, count: 0 }))]);
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
    session: s !== null,
    sessionLeftSec: s ? sessionLeftSec(req) : 0,
    uiLocked: a.uiLocked,
    lockedUntilMs: a.lockUntil > Date.now() ? a.lockUntil : 0,
    guard,
    today,
    open: Object.fromEntries(VENUES.map((v) => [v, venueOpen(v)])),
    watching: watching.size,
  };
}
