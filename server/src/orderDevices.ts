import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Request, Response } from "express";
import { isMailConfigured, sendMail } from "./mailer.js";
import { sendTelegram } from "./telegram.js";

/**
 * **주문은 등록된 기기에서만** (2026-09-04).
 *
 * 벤티지: "주문은 신뢰할 수 있는 기기에서만 할 수 있는 구조로 만들어 줘. 최초의 새로운
 * 기기에서 접근할 때는 신뢰할 수 있는 기기 등록 절차를 만들어 줘 — 이메일로 인증하게."
 *
 * ## 왜 겹 하나를 더 쌓나
 *
 * 지금까지의 겹은 전부 **아는 것**(앱 비밀번호 · 주문 비밀번호)이었다. 아는 것은 새어 나가면
 * 어디서든 쓸 수 있다 — 남의 컴퓨터에서, 지구 반대편에서. 기기 등록은 **가진 것**이라 성질이
 * 다르다. 비밀번호 둘을 다 알아도 **등록 안 된 기기에서는 주문 메뉴가 안 열린다.**
 *
 * 앱 로그인에도 같은 장치가 있다(`auth.ts` 의 devices) — 그런데 그건 **읽기까지**의 문이다.
 * 주문은 돈이 나가는 문이라 명단을 따로 둔다. 앱은 태블릿에서도 보고 싶지만 주문은 폰
 * 하나에서만 하고 싶을 수 있다. 명단이 하나면 그 선택지가 없다.
 *
 * ## 무엇으로 기기를 알아보나
 *
 * 브라우저에 심는 **1년짜리 쿠키 하나**(`vntg_od`)다. 지문(User-Agent·화면 크기)으로 알아보는
 * 방법도 있지만 그건 **틀린다** — 브라우저가 업데이트만 해도 다른 기기가 되고, 반대로 같은
 * 기종이면 남의 기기가 내 기기로 보인다. 쿠키는 그 기기에만 있고, 지우면 다시 인증하면 된다.
 *
 * ## 등록 절차
 *
 *   1. 새 기기에서 주문 메뉴 열기 → 아이디·비밀번호는 맞았지만 명단에 없다 → `needDevice`
 *   2. 메일로 6자리 숫자 (10분, 5번까지)
 *   3. 맞히면 명단에 올리고 쿠키를 심는다 → 그때부터 이 기기는 주문 세션을 열 수 있다
 *
 * 메일이 설정돼 있지 않으면 **기기 확인을 요구하지 않는다.** 확인할 길이 없는데 막으면
 * 주문 기능이 통째로 잠긴다 — 그건 안전이 아니라 고장이다. 대신 그 사실을 화면에 적는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "orderDevices.json");

export const DEVICE_COOKIE = "vntg_od";
const DEVICE_DAYS = 365;
const CODE_TTL_MS = 10 * 60_000;
const CODE_TRIES = 5;

export interface OrderDevice {
  id: string;
  name: string;
  ua: string;
  addedAt: string;
  lastAt: string;
  lastIp: string;
  /** 이 기기에서 나간 주문 건수 — 명단을 볼 때 「안 쓰는 기기」를 가려낸다 */
  orders: number;
}

interface Store {
  devices: OrderDevice[];
}

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, "utf8")) as Store;
    if (!Array.isArray(cache.devices)) cache = { devices: [] };
  } catch {
    cache = { devices: [] };
  }
  return cache;
}

async function save(s: Store): Promise<void> {
  cache = s;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(s, null, 2), "utf8");
}

/* ── 쿠키 ─────────────────────────────────────────────────────────────── */

function cookieOf(req: Request, name: string): string | null {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

function setDeviceCookie(req: Request, res: Response, id: string): void {
  const bits = [
    `${DEVICE_COOKIE}=${encodeURIComponent(id)}`,
    "Path=/api/order",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${DEVICE_DAYS * 86400}`,
  ];
  if (req.secure || String(req.headers["x-forwarded-proto"] ?? "").includes("https")) bits.push("Secure");
  res.append("Set-Cookie", bits.join("; "));
}

/* ── 명단 ─────────────────────────────────────────────────────────────── */

export async function listDevices(req: Request): Promise<(OrderDevice & { current: boolean })[]> {
  const cur = cookieOf(req, DEVICE_COOKIE);
  const s = await load();
  return s.devices.map((d) => ({ ...d, current: d.id === cur }));
}

/** 이 기기가 명단에 있나. 메일이 없으면 확인 자체를 안 하므로 늘 참 */
export async function deviceOf(req: Request): Promise<OrderDevice | null> {
  const id = cookieOf(req, DEVICE_COOKIE);
  if (!id) return null;
  const s = await load();
  return s.devices.find((d) => d.id === id) ?? null;
}

export async function renameDevice(id: string, name: string): Promise<void> {
  const s = await load();
  const d = s.devices.find((x) => x.id === id);
  if (!d) throw new Error("그런 기기가 없다");
  d.name = name.trim().slice(0, 30) || "이름 없는 기기";
  await save(s);
}

export async function removeDevice(id: string): Promise<void> {
  const s = await load();
  const gone = s.devices.find((x) => x.id === id);
  s.devices = s.devices.filter((x) => x.id !== id);
  await save(s);
  if (gone) {
    void sendTelegram(
      `🗑️ 주문 기기 삭제 — <b>${esc(gone.name)}</b>\n그 기기는 다음에 열 때 메일 확인을 다시 거칩니다.`,
      "order",
    ).catch(() => undefined);
  }
}

/** 주문이 나갈 때마다 — 명단에서 「어느 기기가 실제로 쓰는가」를 보이게 */
export async function noteDeviceUse(req: Request, counted: boolean): Promise<void> {
  const id = cookieOf(req, DEVICE_COOKIE);
  if (!id) return;
  const s = await load();
  const d = s.devices.find((x) => x.id === id);
  if (!d) return;
  d.lastAt = new Date().toISOString();
  d.lastIp = ipOf(req);
  if (counted) d.orders += 1;
  await save(s);
}

function ipOf(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  return req.socket.remoteAddress ?? "?";
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ── 등록 (메일 6자리) ────────────────────────────────────────────────── */

interface Pending {
  code: string;
  exp: number;
  tries: number;
  ip: string;
}

const pending = new Map<string, Pending>();

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}

/** 메일로 확인할 수 있는 상태인가 — 아니면 기기 확인을 요구하지 않는다 */
export function deviceCheckPossible(): boolean {
  return isMailConfigured();
}

export async function startDeviceCheck(req: Request): Promise<{ ticket: string } | { error: string }> {
  sweep();
  if (!isMailConfigured()) return { error: "메일이 설정돼 있지 않다" };
  const code = String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
  const ticket = randomBytes(18).toString("hex");
  pending.set(ticket, { code, exp: Date.now() + CODE_TTL_MS, tries: 0, ip: ipOf(req) });
  const sent = await sendMail(
    "VNTG 주문 기기 등록 확인",
    `<div style="font-family:system-ui,sans-serif">
       <p style="font-size:15px"><b>주문 메뉴</b>를 새 기기에서 열려고 합니다.</p>
       <p style="font-size:15px">본인이 아니라면 <b>이 메일을 무시</b>하고, 서버의 <code>ORDERS_ENABLED</code> 를 꺼 주세요.</p>
       <p style="font-size:30px;letter-spacing:6px;font-weight:700;margin:18px 0">${code}</p>
       <p style="color:#666;font-size:13px">10분 안에 넣으세요 · 요청 주소 ${esc(ipOf(req))}</p>
       <p style="color:#666;font-size:13px">기기: ${esc(String(req.headers["user-agent"] ?? "?").slice(0, 120))}</p>
     </div>`,
  );
  if (!sent.ok) {
    pending.delete(ticket);
    return { error: sent.error ?? "메일을 못 보냈다" };
  }
  void sendTelegram(`📧 주문 기기 등록 확인 메일을 보냈습니다 · ${esc(ipOf(req))}`, "order").catch(() => undefined);
  return { ticket };
}

export async function finishDeviceCheck(
  req: Request,
  res: Response,
  ticket: string,
  code: string,
  name: string,
): Promise<{ ok: true; device: OrderDevice } | { ok: false; error: string }> {
  sweep();
  const p = pending.get(ticket);
  if (!p) return { ok: false, error: "확인 시간이 지났습니다 — 다시 받으세요" };
  /* 코드를 받은 곳과 넣는 곳이 달라지면 그건 남의 손이다 */
  if (p.ip !== ipOf(req)) {
    pending.delete(ticket);
    return { ok: false, error: "다른 곳에서의 요청입니다" };
  }
  p.tries += 1;
  if (p.tries > CODE_TRIES) {
    pending.delete(ticket);
    return { ok: false, error: "너무 많이 틀렸습니다 — 다시 받으세요" };
  }
  const given = code.replace(/\D/g, "");
  /* 6자리 고정이라 길이가 같다 — 시간 일정 비교가 성립한다 */
  if (given.length !== 6 || !timingSafeEqual(Buffer.from(given), Buffer.from(p.code))) {
    return { ok: false, error: `숫자가 다릅니다 (${CODE_TRIES - p.tries}회 남음)` };
  }
  pending.delete(ticket);

  const now = new Date().toISOString();
  const device: OrderDevice = {
    id: randomUUID(),
    name: name.trim().slice(0, 30) || "이름 없는 기기",
    ua: String(req.headers["user-agent"] ?? "?").slice(0, 160),
    addedAt: now,
    lastAt: now,
    lastIp: ipOf(req),
    orders: 0,
  };
  const s = await load();
  s.devices.push(device);
  await save(s);
  setDeviceCookie(req, res, device.id);
  void sendTelegram(
    `🔐 <b>주문 기기 등록</b> — ${esc(device.name)}\n주소 ${esc(device.lastIp)}\n본인이 아니면 설정 › 주문 › 기기에서 지우세요.`,
    "order",
  ).catch(() => undefined);
  return { ok: true, device };
}
