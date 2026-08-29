import { createHmac, randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { NextFunction, Request, Response } from "express";
import { isMailConfigured, sendMail } from "./mailer.js";
import { sendTelegram } from "./telegram.js";
import { currentCode, newSecret, otpauthUri, verifyTotp } from "./totp.js";

/**
 * 앱 자체 로그인 (2026-08-29 요청).
 *
 * ## 왜 만드나 — 앞에 Cloudflare Access 가 있는데도
 *
 * Access 는 **문 하나**다. 그 문이 열려 있는 동안(세션이 길다 — 실제로 「로그인
 * 유지하고 나면 그냥 된다」) 브라우저를 쥔 사람은 곧 나다. 폰을 잠깐 두고 온다든지,
 * 세션 쿠키가 어디로 샌다든지 하면 그걸로 끝이다.
 *
 * 그리고 Access 는 **밖에서 들어오는 길만** 지킨다. 집 안에서 `192.168.x.x:4000`
 * 으로 바로 부르면 문지기를 지나지 않는다. 지금 이 서버에는 인증이 한 줄도 없어서
 * 그 길로는 계좌·매매기록·텔레그램 대화가 전부 열려 있었다.
 *
 * ## 얼마나 귀찮게 할 것인가 — 새 기기에서만 2단계
 *
 * 매번 6자리를 묻게 하면, 그게 귀찮아서 결국 세션을 길게 잡게 된다. 그러면 지금과
 * 같은 자리로 돌아온다. 그래서 **요소가 실제로 하나 더 필요한 순간에만** 묻는다:
 *
 *   · 알던 기기 → 아이디·비밀번호만
 *   · 처음 보는 기기 → 거기에 6자리 (구글 OTP 또는 메일 — 고를 수 있다)
 *
 * 「알던 기기」는 로그인에 성공했을 때 심어 준 서명 쿠키로 알아본다(180일).
 * 브라우저를 지우거나 다른 폰을 쓰면 다시 처음 보는 기기가 된다 — 그게 맞다.
 *
 * ## 비밀번호는 되돌릴 수 없게 저장한다
 *
 * scrypt 해시 + 계정마다 다른 소금. 이 파일이 통째로 새어 나가도 원문은 안 나온다.
 * 그래서 **「비밀번호 보기」 같은 건 만들 수 없다** — 잊었으면 메일로 확인하고
 * 새로 정하는 길뿐이다(그게 아래 `forgot`/`resetPassword` 다).
 *
 * ## ⚠️ 기본값은 **꺼짐**이다
 *
 * 켜는 것은 사람이 설정에서 비밀번호를 정하는 순간이다. 파일이 없거나 꺼져 있으면
 * 미들웨어는 아무것도 안 한다 — 지금까지처럼 그대로 돈다.
 *
 * 나갈 길을 막지 않기 위해서다. 이 코드는 **미니PC에서 시험해 볼 수 없다**(개발
 * PC에는 메일도 도메인도 다르게 걸려 있다). 켜자마자 못 들어가는 일이 생기면
 * 화면으로는 아무것도 할 수 없다.
 *
 * ## 잠겨서 못 들어갈 때
 *
 * 서버를 멈추고 `server/data/auth.json` 의 `"enabled": true` 를 `false` 로 고친 뒤
 * 다시 켜면 된다. 파일을 통째로 지워도 된다(비밀번호·기기 목록이 같이 사라진다).
 * 이 파일은 git 에 올라가지 않는다(`server/data/*` 제외 규칙).
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "auth.json");

const SESSION_COOKIE = "vntg_s";
const DEVICE_COOKIE = "vntg_d";
/** 기기를 기억하는 기간. 이건 「이 브라우저가 내 것인가」라 세션보다 훨씬 길어도 된다 */
const DEVICE_DAYS = 180;

/** 2단계를 무엇으로 할지 */
export type OtpMethod = "email" | "totp";

export interface AuthDevice {
  id: string;
  /** 사람이 알아볼 이름 — 「갤럭시 폰」처럼 로그인할 때 적는다 */
  name: string;
  ua: string;
  addedAt: string;
  lastSeenAt: string;
}

interface AuthFile {
  enabled: boolean;
  /** 계정은 하나뿐이다. 그래도 아이디를 받는 건 손에 익은 절차라서다 */
  username: string;
  /** 서명 열쇠 — 세션·기기 쿠키를 이걸로 서명한다. 새로 뽑으면 전부 로그아웃된다 */
  secret: string;
  passSalt: string;
  passHash: string;
  /** 로그인 한 번이 몇 시간 가나 */
  sessionHours: number;
  /** 처음 보는 기기에 6자리를 물을 것인가 */
  otpForNewDevice: boolean;
  otpMethod: OtpMethod;
  /** 구글 OTP 설정 키(base32). 확인까지 끝난 것만 여기 들어온다 */
  totpSecret: string;
  devices: AuthDevice[];
}

const EMPTY: AuthFile = {
  enabled: false,
  username: "mistak0318",
  secret: "",
  passSalt: "",
  passHash: "",
  sessionHours: 12,
  otpForNewDevice: true,
  otpMethod: "email",
  totpSecret: "",
  devices: [],
};

let cache: AuthFile | null = null;

/**
 * 처음 켤 때 넣어 두는 비밀번호. **바로 바꾸라고 있는 값**이다.
 *
 * 이걸 코드에 두는 이유는, 이게 비밀이 아니기 때문이다 — 비밀은 벤티지가 설정에서
 * 새로 정하는 순간 생기고, 그 값은 해시로만 남아 코드에도 깃에도 안 들어간다.
 * (그래서 최소 길이도 4자로 뒀다. 아래 `setPassword` 참고)
 */
const FIRST_PASSWORD = "0000";

async function load(): Promise<AuthFile> {
  if (cache) return cache;
  try {
    const raw = await readFile(FILE, "utf8");
    cache = { ...EMPTY, ...(JSON.parse(raw) as Partial<AuthFile>) };
  } catch {
    cache = { ...EMPTY };
  }
  /*
   * 비밀번호가 아직 없으면 여기서 심는다.
   *
   * 「설정에 들어가서 켠다」가 아니라 **처음부터 계정이 있는** 상태로 시작하는 게
   * 낫다 — 잠금을 켜는 순간 로그인할 무언가가 이미 있어야 하고, 없으면 켜자마자
   * 못 들어가는 상황이 만들어진다. 잠금 자체는 여전히 꺼짐이 기본이다.
   */
  if (!cache.passHash) {
    const salt = randomBytes(16).toString("hex");
    cache.passSalt = salt;
    cache.passHash = await hash(FIRST_PASSWORD, salt);
    cache.secret = randomBytes(32).toString("hex");
    await save(cache);
  }
  return cache;
}

async function save(next: AuthFile): Promise<void> {
  cache = next;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf8");
}

/* ── 비밀번호 ────────────────────────────────────────────────────────────── */

/**
 * scrypt — **일방향**이다. 되돌리는 함수가 없다.
 *
 * 새 의존성 없이 node 내장으로 되고, 무엇보다 **느리다**. 빠른 해시(sha256)를 쓰면
 * 파일이 새어 나갔을 때 사전 대입이 순식간이다. N=16384 는 한 번에 수십 밀리초를
 * 쓰게 만드는 값이라, 사람은 못 느끼지만 기계로 수억 번 시도하는 쪽은 막힌다.
 */
function hash(pw: string, salt: string): Promise<string> {
  return new Promise((ok, no) => {
    scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1 }, (err, key) => {
      if (err) no(err);
      else ok(key.toString("hex"));
    });
  });
}

/** 길이가 다르면 timingSafeEqual 이 던진다 — 그것부터 막고 시간 일정 비교로 간다 */
function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/* ── 서명 토큰 ───────────────────────────────────────────────────────────── */

function sign(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

/** `본문.서명` — 본문은 base64url 한 JSON */
function makeToken(secret: string, data: unknown): string {
  const body = Buffer.from(JSON.stringify(data), "utf8").toString("base64url");
  return `${body}.${sign(secret, body)}`;
}

function readToken<T>(secret: string, token: string | undefined): T | null {
  if (!token || !secret) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = token.slice(dot + 1);
  if (!sameHex(mac, sign(secret, body))) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

interface SessionPayload {
  /** 만료 시각 (ms) */
  e: number;
  /** 어느 기기에서 */
  d: string;
}
interface DevicePayload {
  d: string;
}

/* ── 쿠키 ────────────────────────────────────────────────────────────────── */

/** cookie-parser 를 새로 넣지 않는다 — 우리가 읽을 쿠키는 둘뿐이다 */
function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/**
 * `Secure` 는 https 일 때만 붙인다.
 *
 * 밖에서는 Cloudflare 가 https 로 받아 평문으로 넘겨주므로 `x-forwarded-proto` 를
 * 봐야 한다. 집 안에서 `http://192.168...` 로 쓸 때 Secure 를 붙이면 브라우저가
 * 쿠키를 아예 저장하지 않아 **로그인이 영영 안 된다**.
 */
function cookieOpts(req: Request, maxAgeSec: number): string {
  const proto = String(req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  const https = proto === "https" || req.protocol === "https";
  return ["Path=/", "HttpOnly", "SameSite=Lax", https ? "Secure" : "", `Max-Age=${maxAgeSec}`]
    .filter(Boolean)
    .join("; ");
}

function setCookie(req: Request, res: Response, name: string, value: string, maxAgeSec: number) {
  const prev = res.getHeader("Set-Cookie");
  const line = `${name}=${encodeURIComponent(value)}; ${cookieOpts(req, maxAgeSec)}`;
  const all = prev === undefined ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  res.setHeader("Set-Cookie", [...all, line]);
}

function clearCookie(req: Request, res: Response, name: string) {
  setCookie(req, res, name, "", 0);
}

/* ── 접속자 ──────────────────────────────────────────────────────────────── */

/**
 * 누가 두드렸나.
 *
 * ⚠️ `trust proxy` 를 켜지 않는다. 켜면 집 안의 아무나 `X-Forwarded-For` 를 지어내
 * 시도 횟수 제한을 피할 수 있다. Cloudflare 가 붙여 주는 `cf-connecting-ip` 만
 * 믿고(그 길로 온 것은 문지기를 지난 것이다), 없으면 실제 소켓 주소를 쓴다.
 */
function who(req: Request): string {
  const cf = req.headers["cf-connecting-ip"];
  if (typeof cf === "string" && cf.trim()) return cf.trim();
  return req.socket.remoteAddress ?? "?";
}

/**
 * 텔레그램·메일에 남의 글자를 실을 때.
 *
 * User-Agent 는 **부르는 쪽이 정하는 값**이라 `<b>` 든 뭐든 들어올 수 있다.
 * 그대로 HTML 로 보내면 발송이 실패하거나(파싱 오류) 알림이 엉뚱하게 보인다 —
 * 하필 「누가 두드리고 있다」를 알려야 하는 순간에 그러면 안 된다.
 */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ── 시도 횟수 제한 ──────────────────────────────────────────────────────── */

/**
 * 틀린 비밀번호를 주소별로 센다. 다섯 번 넘으면 기다리게 한다(횟수만큼 길어진다).
 * 서버를 다시 켜면 지워지는데, 그건 괜찮다 — 서버를 껐다 켤 수 있는 사람은
 * 이미 그 PC 앞에 있는 사람이다.
 */
const fails = new Map<string, { n: number; until: number }>();
const FREE_TRIES = 5;

function penalty(ip: string): number {
  const f = fails.get(ip);
  if (!f) return 0;
  return Math.max(0, f.until - Date.now());
}

function noteFail(ip: string): number {
  const f = fails.get(ip) ?? { n: 0, until: 0 };
  f.n += 1;
  /* 5회까지는 그냥, 그다음부터 30초씩 늘려 최대 10분 */
  const over = Math.max(0, f.n - FREE_TRIES);
  f.until = Date.now() + Math.min(10 * 60_000, over * 30_000);
  fails.set(ip, f);
  return f.n;
}

function clearFails(ip: string): void {
  fails.delete(ip);
}

/* ── 6자리 ───────────────────────────────────────────────────────────────── */

const OTP_MINUTES = 5;
const OTP_TRIES = 5;

/** 000000 도 나와야 한다 — 앞자리를 버리면 경우의 수가 준다 */
function sixDigits(): string {
  return String(randomBytes(4).readUInt32BE(0) % 1_000_000).padStart(6, "0");
}

function maskMail(addr: string): string {
  const [id, host] = addr.split("@");
  if (!host) return "메일";
  const head = id.slice(0, 2);
  return `${head}${"*".repeat(Math.max(1, id.length - 2))}@${host}`;
}

interface Pending {
  method: OtpMethod;
  /** 메일 방식일 때만 — 구글 OTP 는 서버가 코드를 만들지 않는다 */
  code?: string;
  exp: number;
  tries: number;
  ip: string;
}
/** 진행 중인 새 기기 확인. 서버 메모리에만 둔다 — 5분짜리라 남길 이유가 없다 */
const pending = new Map<string, Pending>();

function sweep(): void {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  if (totpSetup && totpSetup.exp < now) totpSetup = null;
  if (resetting && resetting.exp < now) resetting = null;
}

/**
 * 구글 OTP 재사용 막기.
 *
 * 같은 30초 안에 코드를 어깨너머로 본 사람이 그대로 한 번 더 쓰는 것을 막는다.
 * 「이번에 쓴 칸 번호」를 기억했다가 그 이하는 안 받는다.
 */
let lastTotpStep = 0;

/* ── 바깥에서 쓰는 것 ────────────────────────────────────────────────────── */

export interface AuthState {
  enabled: boolean;
  authed: boolean;
  /** 이 브라우저를 아는가 — 안다면 6자리 없이 들어온다 */
  knownDevice: boolean;
  /** 메일이 준비돼 있나. 안 되어 있으면 메일 방식과 비밀번호 찾기를 못 쓴다 */
  mailReady: boolean;
  otpForNewDevice: boolean;
  otpMethod: OtpMethod;
  /** 로그인 칸에 미리 채워 둘 아이디 */
  username: string;
}

export async function authState(req: Request): Promise<AuthState> {
  const cfg = await load();
  const c = cookies(req);
  const sess = readToken<SessionPayload>(cfg.secret, c[SESSION_COOKIE]);
  const dev = readToken<DevicePayload>(cfg.secret, c[DEVICE_COOKIE]);
  return {
    enabled: cfg.enabled,
    authed: !cfg.enabled || (sess !== null && sess.e > Date.now()),
    knownDevice: dev !== null && cfg.devices.some((d) => d.id === dev.d),
    mailReady: isMailConfigured(),
    otpForNewDevice: cfg.otpForNewDevice,
    otpMethod: cfg.otpMethod,
    username: cfg.username,
  };
}

/**
 * 문지기.
 *
 * 열어 두는 것: 로그인 자체(`/api/auth/*`), 헬스체크, 그리고 **화면 파일 전부**.
 * 화면을 막으면 로그인 칸을 그릴 수단이 없어진다 — 로그인 화면은 이 앱의 일부다.
 * 대신 화면이 부르는 `/api/*` 가 전부 막히므로 데이터는 한 줄도 안 나간다.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const cfg = await load();
  if (!cfg.enabled) return next();
  if (!req.path.startsWith("/api/")) return next(); // 정적 파일·SPA
  if (req.path.startsWith("/api/auth/")) return next();
  if (req.path === "/api/health") return next();

  const c = cookies(req);
  const sess = readToken<SessionPayload>(cfg.secret, c[SESSION_COOKIE]);
  if (sess && sess.e > Date.now()) return next();

  res.status(401).json({ error: "로그인이 필요합니다", needLogin: true });
}

/* ── 로그인 흐름 ─────────────────────────────────────────────────────────── */

export type LoginResult =
  | { ok: true }
  | { ok: false; otpRequired: true; method: OtpMethod; ticket: string; sentTo: string }
  | { ok: false; error: string; waitMs?: number };

export async function login(
  req: Request,
  res: Response,
  username: string,
  password: string,
): Promise<LoginResult> {
  const cfg = await load();
  if (!cfg.enabled) return { ok: true };

  const ip = who(req);
  const wait = penalty(ip);
  if (wait > 0) return { ok: false, error: "잠시 뒤 다시 시도하세요", waitMs: wait };

  /*
   * 아이디와 비밀번호를 **따로 알려 주지 않는다.**
   * 「아이디가 없습니다」라고 답하면 어떤 아이디가 있는지 찾아낼 수 있다.
   * 계정이 하나뿐이라 큰 차이는 아니지만, 굳이 알려 줄 이유도 없다.
   */
  const idOk = username.trim().toLowerCase() === cfg.username.toLowerCase();
  const given = await hash(password, cfg.passSalt);
  const pwOk = sameHex(given, cfg.passHash);

  if (!idOk || !pwOk) {
    const n = noteFail(ip);
    /*
     * 텔레그램으로 알린다 — 이게 실제 탐지 수단이다. 비밀번호를 아무리 잘 골라도
     * 「누가 시도하고 있다」를 모르면 뚫린 뒤에야 안다. 처음 한 번과 그 뒤 5회마다.
     */
    if (n === 1 || n % 5 === 0) {
      void sendTelegram(
        `🔐 VNTG 로그인 실패 ${n}회\n주소: ${esc(ip)}\n기기: ${esc(
          String(req.headers["user-agent"] ?? "?").slice(0, 80),
        )}`,
      ).catch(() => undefined);
    }
    return { ok: false, error: "아이디 또는 비밀번호가 다릅니다" };
  }
  clearFails(ip);

  const c = cookies(req);
  const dev = readToken<DevicePayload>(cfg.secret, c[DEVICE_COOKIE]);
  const known = dev !== null && cfg.devices.some((d) => d.id === dev.d);

  /* 구글 OTP 로 해 뒀는데 아직 등록 전이면 물어볼 수가 없다 — 통과시킨다.
     여기서 막으면 설정하러 들어갈 수도 없어 영영 잠긴다. */
  const totpUsable = cfg.otpMethod === "totp" && cfg.totpSecret.length > 0;
  const needOtp = cfg.otpForNewDevice && !known && (cfg.otpMethod === "email" || totpUsable);

  if (!needOtp) {
    const id = known && dev ? dev.d : randomUUID();
    if (!known) {
      cfg.devices.push(newDevice(id, req, "이름 없는 기기"));
      await save(cfg);
    } else {
      await touch(cfg, id);
    }
    issue(req, res, cfg, id);
    return { ok: true };
  }

  sweep();
  const ticket = randomUUID();

  /* 구글 OTP — 서버가 보낼 것이 없다. 앱에 이미 떠 있는 숫자를 받으면 된다 */
  if (cfg.otpMethod === "totp") {
    pending.set(ticket, {
      method: "totp",
      exp: Date.now() + OTP_MINUTES * 60_000,
      tries: 0,
      ip,
    });
    return { ok: false, otpRequired: true, method: "totp", ticket, sentTo: "구글 OTP 앱" };
  }

  /* 메일 — 6자리를 만들어 보낸다 */
  if (!isMailConfigured()) {
    return { ok: false, error: "새 기기인데 메일 설정이 없어 확인 코드를 보낼 수 없습니다" };
  }
  const code = sixDigits();
  pending.set(ticket, {
    method: "email",
    code,
    exp: Date.now() + OTP_MINUTES * 60_000,
    tries: 0,
    ip,
  });

  const ua = String(req.headers["user-agent"] ?? "?").slice(0, 120);
  const sent = await sendMail(
    `[VNTG] 새 기기 로그인 확인 ${code}`,
    codeMail("처음 보는 기기에서 로그인하려고 합니다.", code, ip, ua),
  );
  if (!sent.ok) {
    pending.delete(ticket);
    return { ok: false, error: `확인 메일을 보내지 못했습니다 (${sent.error ?? "발송 실패"})` };
  }

  return {
    ok: false,
    otpRequired: true,
    method: "email",
    ticket,
    sentTo: maskMail((process.env.MAIL_TO ?? "").trim()),
  };
}

function codeMail(lead: string, code: string, ip: string, ua: string): string {
  return `<div style="font-family:system-ui,sans-serif">
     <p style="font-size:15px">${lead}</p>
     <p style="font-size:32px;letter-spacing:6px;font-weight:700;margin:18px 0">${code}</p>
     <p style="color:#666;font-size:13px">${OTP_MINUTES}분 안에 입력하세요.</p>
     <hr style="border:none;border-top:1px solid #ddd;margin:16px 0">
     <p style="color:#666;font-size:12px">주소 ${esc(ip)}<br>기기 ${esc(ua)}</p>
     <p style="color:#c00;font-size:13px">본인이 아니라면 <b>지금 비밀번호를 바꾸세요.</b></p>
   </div>`;
}

function newDevice(id: string, req: Request, name: string): AuthDevice {
  const now = new Date().toISOString();
  return {
    id,
    name: name.trim().slice(0, 30) || "이름 없는 기기",
    ua: String(req.headers["user-agent"] ?? "?").slice(0, 160),
    addedAt: now,
    lastSeenAt: now,
  };
}

async function touch(cfg: AuthFile, id: string): Promise<void> {
  const d = cfg.devices.find((x) => x.id === id);
  if (!d) return;
  d.lastSeenAt = new Date().toISOString();
  await save(cfg);
}

/** 세션 쿠키를 굽는다. 기기 쿠키도 같이 갱신해 180일이 계속 밀린다 */
function issue(req: Request, res: Response, cfg: AuthFile, deviceId: string): void {
  const sec = Math.round(cfg.sessionHours * 3600);
  setCookie(
    req,
    res,
    SESSION_COOKIE,
    makeToken(cfg.secret, { e: Date.now() + sec * 1000, d: deviceId } satisfies SessionPayload),
    sec,
  );
  setCookie(
    req,
    res,
    DEVICE_COOKIE,
    makeToken(cfg.secret, { d: deviceId } satisfies DevicePayload),
    DEVICE_DAYS * 86400,
  );
}

export async function verifyOtp(
  req: Request,
  res: Response,
  ticket: string,
  code: string,
  deviceName: string,
): Promise<{ ok: boolean; error?: string }> {
  sweep();
  const p = pending.get(ticket);
  if (!p) return { ok: false, error: "확인 시간이 지났습니다. 다시 로그인하세요" };
  if (p.ip !== who(req)) {
    pending.delete(ticket);
    return { ok: false, error: "다른 곳에서의 요청입니다" };
  }
  p.tries += 1;
  if (p.tries > OTP_TRIES) {
    pending.delete(ticket);
    return { ok: false, error: "너무 많이 틀렸습니다. 다시 로그인하세요" };
  }

  const cfg = await load();

  if (p.method === "totp") {
    const r = verifyTotp(cfg.totpSecret, code, lastTotpStep);
    if (!r.ok) return { ok: false, error: `${r.error} (${OTP_TRIES - p.tries}회 남음)` };
    lastTotpStep = r.step ?? lastTotpStep;
  } else {
    const given = code.replace(/\D/g, "");
    /* 6자리 고정이라 길이가 같다 — 시간 일정 비교가 성립한다 */
    if (given.length !== 6 || !timingSafeEqual(Buffer.from(given), Buffer.from(p.code ?? "······"))) {
      return { ok: false, error: `숫자가 다릅니다 (${OTP_TRIES - p.tries}회 남음)` };
    }
  }
  pending.delete(ticket);

  const id = randomUUID();
  cfg.devices.push(newDevice(id, req, deviceName));
  await save(cfg);
  issue(req, res, cfg, id);
  void sendTelegram(
    `🔓 VNTG 새 기기 등록\n이름: ${esc(deviceName || "이름 없는 기기")}\n주소: ${esc(who(req))}`,
  ).catch(() => undefined);
  return { ok: true };
}

export function logout(req: Request, res: Response): void {
  clearCookie(req, res, SESSION_COOKIE);
  /* 기기 쿠키는 지우지 않는다 — 「내 기기」라는 사실은 로그아웃과 무관하다.
     이 기기를 더는 믿고 싶지 않으면 설정에서 지운다(그쪽이 진짜 해제다). */
}

/* ── 비밀번호 찾기 (메일 확인) ───────────────────────────────────────────── */

/**
 * 해시는 되돌릴 수 없으므로 「찾기」란 사실 **새로 정하기**다.
 *
 * 이 창구는 로그인 없이 부를 수 있어야 한다(못 들어가는 사람이 쓰는 것이니까).
 * 그래서 두 가지를 건다:
 *
 *   · **메일은 등록된 한 곳(MAIL_TO)으로만** 간다. 요청하는 쪽이 주소를 못 고른다.
 *   · 같은 주소에서 1분에 한 번만. 안 그러면 남의 메일함을 채우는 장치가 된다.
 *
 * 새로 정하고 나면 **모든 기기와 세션을 끊는다.** 비밀번호를 새로 정하는 상황은
 * 「잊었다」 아니면 「샜다」인데, 뒤쪽이면 남아 있는 세션이 곧 열린 문이다.
 */
let resetting: { code: string; exp: number; tries: number; ip: string; ticket: string } | null =
  null;
let lastResetMailAt = 0;

export async function forgot(
  req: Request,
): Promise<{ ok: boolean; ticket?: string; sentTo?: string; error?: string }> {
  const cfg = await load();
  if (!cfg.passHash) return { ok: false, error: "아직 비밀번호가 없습니다" };
  if (!isMailConfigured()) return { ok: false, error: "메일 설정이 없어 확인 코드를 보낼 수 없습니다" };
  if (Date.now() - lastResetMailAt < 60_000) {
    return { ok: false, error: "방금 보냈습니다. 1분 뒤에 다시 눌러 주세요" };
  }

  sweep();
  const ip = who(req);
  const code = sixDigits();
  const ticket = randomUUID();
  resetting = { code, exp: Date.now() + OTP_MINUTES * 60_000, tries: 0, ip, ticket };

  const ua = String(req.headers["user-agent"] ?? "?").slice(0, 120);
  const sent = await sendMail(
    `[VNTG] 비밀번호 재설정 ${code}`,
    codeMail("비밀번호를 새로 정하려고 합니다.", code, ip, ua),
  );
  if (!sent.ok) {
    resetting = null;
    return { ok: false, error: `메일을 보내지 못했습니다 (${sent.error ?? "발송 실패"})` };
  }
  lastResetMailAt = Date.now();
  void sendTelegram(`🔑 VNTG 비밀번호 재설정 요청\n주소: ${esc(ip)}`).catch(() => undefined);
  return { ok: true, ticket, sentTo: maskMail((process.env.MAIL_TO ?? "").trim()) };
}

export async function resetPassword(
  req: Request,
  ticket: string,
  code: string,
  next: string,
): Promise<{ ok: boolean; error?: string }> {
  sweep();
  const r = resetting;
  if (!r || r.ticket !== ticket) {
    return { ok: false, error: "확인 시간이 지났습니다. 다시 요청하세요" };
  }
  if (r.ip !== who(req)) {
    resetting = null;
    return { ok: false, error: "다른 곳에서의 요청입니다" };
  }
  r.tries += 1;
  if (r.tries > OTP_TRIES) {
    resetting = null;
    return { ok: false, error: "너무 많이 틀렸습니다. 다시 요청하세요" };
  }
  const given = code.replace(/\D/g, "");
  if (given.length !== 6 || !timingSafeEqual(Buffer.from(given), Buffer.from(r.code))) {
    return { ok: false, error: `숫자가 다릅니다 (${OTP_TRIES - r.tries}회 남음)` };
  }
  if (next.length < 4) return { ok: false, error: "4자 이상으로 정해 주세요" };

  resetting = null;
  const cfg = await load();
  const salt = randomBytes(16).toString("hex");
  cfg.passSalt = salt;
  cfg.passHash = await hash(next, salt);
  /* 샜을 수도 있는 상황이다 — 열쇠를 새로 뽑아 남은 세션·기기를 전부 끊는다 */
  cfg.secret = randomBytes(32).toString("hex");
  cfg.devices = [];
  await save(cfg);
  void sendTelegram(`🔑 VNTG 비밀번호가 새로 정해졌습니다\n모든 기기가 로그아웃됐습니다`).catch(
    () => undefined,
  );
  return { ok: true };
}

/* ── 설정에서 쓰는 것 ────────────────────────────────────────────────────── */

export interface AuthConfigView {
  enabled: boolean;
  username: string;
  hasPassword: boolean;
  /** 아직 처음 준 0000 그대로인가 — 그렇다면 화면이 계속 채근해야 한다 */
  isFirstPassword: boolean;
  sessionHours: number;
  otpForNewDevice: boolean;
  otpMethod: OtpMethod;
  totpReady: boolean;
  mailReady: boolean;
  mailTo: string;
  devices: (AuthDevice & { current: boolean })[];
  /** 이 서버의 문단속 상태 — 아래 `doorState` 참고 */
  door: DoorState;
}

/**
 * 로그인 말고 **서버가 어디까지 열려 있나**.
 *
 * 2026-08-29 에 「CORS 안 채우면 전면허용이라던 거, 지금 적용된 건가?」를 물었는데,
 * 그걸 알아보려면 미니PC 의 `.env` 를 열어 봐야 했다. 화면에서 볼 수 있어야 하는
 * 값이다 — 설정이 빠져 있다는 걸 **모르고 지내는 것**이 여기서는 제일 위험하다.
 *
 * 로그인한 사람에게만 보여 준다(설정 화면 안이다). 밖에서 이 답을 얻을 수 있으면
 * 그 자체가 「여기 문이 열려 있다」는 안내가 된다.
 */
export interface DoorState {
  /** ALLOWED_ORIGINS 를 채웠나 — 비면 아무 웹사이트나 이 API 를 부를 수 있다 */
  corsRestricted: boolean;
  corsOrigins: string[];
  /** BIND_HOST=127.0.0.1 인가 — 아니면 같은 공유기의 아무 기기나 닿는다 */
  loopbackOnly: boolean;
  bindHost: string;
}

export function doorState(): DoorState {
  const origins = (process.env.ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const bindHost = process.env.BIND_HOST ?? "0.0.0.0";
  return {
    corsRestricted: origins.length > 0,
    corsOrigins: origins,
    loopbackOnly: bindHost === "127.0.0.1" || bindHost === "localhost",
    bindHost,
  };
}

export async function authConfig(req: Request): Promise<AuthConfigView> {
  const cfg = await load();
  const dev = readToken<DevicePayload>(cfg.secret, cookies(req)[DEVICE_COOKIE]);
  return {
    enabled: cfg.enabled,
    username: cfg.username,
    hasPassword: cfg.passHash.length > 0,
    /* 해시는 되돌릴 수 없으니 「0000 인가」는 같은 소금으로 다시 해시해 견줘 본다 */
    isFirstPassword: sameHex(await hash(FIRST_PASSWORD, cfg.passSalt), cfg.passHash),
    sessionHours: cfg.sessionHours,
    otpForNewDevice: cfg.otpForNewDevice,
    otpMethod: cfg.otpMethod,
    totpReady: cfg.totpSecret.length > 0,
    mailReady: isMailConfigured(),
    mailTo: isMailConfigured() ? maskMail((process.env.MAIL_TO ?? "").trim()) : "",
    devices: cfg.devices.map((d) => ({ ...d, current: dev?.d === d.id })),
    door: doorState(),
  };
}

/**
 * 비밀번호를 정하거나 바꾼다.
 *
 * 이미 있으면 **지금 것을 먼저 맞혀야** 한다. 안 그러면 로그인된 화면을 잠깐
 * 빌린 사람이 비밀번호를 갈아 치우고 나를 내쫓을 수 있다.
 */
export async function setPassword(
  current: string,
  next: string,
): Promise<{ ok: boolean; error?: string }> {
  const cfg = await load();
  /*
   * 최소 4자.
   *
   * 짧은 비밀번호는 원래 위험하지만, 여기서는 **틀릴 때마다 느려지는 문**이
   * 뒤를 받쳐 준다(5회까지는 그냥, 그다음부터 30초씩 늘어 최대 10분). 네 자리
   * 만 개를 그 속도로 훑으려면 몇 달이 걸린다. 그리고 앞에는 Cloudflare 가 있다.
   * 그래도 짧을수록 얇은 벽이라, 화면에서 「짧다」고 말은 해 준다.
   */
  if (next.length < 4) return { ok: false, error: "4자 이상으로 정해 주세요" };

  if (cfg.passHash) {
    const given = await hash(current, cfg.passSalt);
    if (!sameHex(given, cfg.passHash)) return { ok: false, error: "지금 비밀번호가 다릅니다" };
  }
  const salt = randomBytes(16).toString("hex");
  cfg.passSalt = salt;
  cfg.passHash = await hash(next, salt);
  if (!cfg.secret) cfg.secret = randomBytes(32).toString("hex");
  await save(cfg);
  return { ok: true };
}

export async function setUsername(name: string): Promise<{ ok: boolean; error?: string }> {
  const clean = name.trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(clean)) {
    return { ok: false, error: "영문·숫자·. _ - 로 3~30자" };
  }
  const cfg = await load();
  cfg.username = clean;
  await save(cfg);
  return { ok: true };
}

export async function setEnabled(on: boolean): Promise<{ ok: boolean; error?: string }> {
  const cfg = await load();
  if (on && !cfg.passHash) return { ok: false, error: "먼저 비밀번호를 정해 주세요" };
  cfg.enabled = on;
  await save(cfg);
  void sendTelegram(`🔐 VNTG 로그인 잠금 ${on ? "켜짐" : "꺼짐"}`).catch(() => undefined);
  return { ok: true };
}

export async function setOptions(o: {
  sessionHours?: number;
  otpForNewDevice?: boolean;
  otpMethod?: OtpMethod;
}): Promise<{ ok: boolean; error?: string }> {
  const cfg = await load();
  if (typeof o.sessionHours === "number" && Number.isFinite(o.sessionHours)) {
    /* 1시간~30일. 0 을 넣어 사실상 매 요청 로그인이 되는 사고를 막는다 */
    cfg.sessionHours = Math.min(720, Math.max(1, Math.round(o.sessionHours)));
  }
  if (typeof o.otpForNewDevice === "boolean") cfg.otpForNewDevice = o.otpForNewDevice;
  if (o.otpMethod === "email" || o.otpMethod === "totp") {
    /* 등록도 안 한 구글 OTP 로 바꿔 두면 새 기기에서 물어볼 수가 없다 */
    if (o.otpMethod === "totp" && !cfg.totpSecret) {
      return { ok: false, error: "구글 OTP 를 먼저 등록해 주세요" };
    }
    cfg.otpMethod = o.otpMethod;
  }
  await save(cfg);
  return { ok: true };
}

/* ── 구글 OTP 등록 ───────────────────────────────────────────────────────── */

/** 아직 확인 안 된 설정 키. 확인에 성공해야 파일로 넘어간다 */
let totpSetup: { secret: string; exp: number } | null = null;

/**
 * 설정 키를 새로 뽑아 보여 준다. **아직 저장하지 않는다.**
 *
 * 앱에 넣고 **실제로 뜬 숫자를 맞혀야** 저장된다(`confirmTotp`). 이 순서가
 * 중요한 이유: 잘못 옮겨 적었거나 앱에 안 들어갔는데 저장돼 버리면, 다음에 새
 * 기기로 들어오려 할 때 **아무도 모르는 숫자를 요구받는다.** 확인을 통과해야만
 * 켜지므로 그런 일이 안 생긴다.
 */
export async function beginTotp(): Promise<{ secret: string; uri: string }> {
  const cfg = await load();
  const secret = newSecret();
  totpSetup = { secret, exp: Date.now() + 10 * 60_000 };
  return { secret, uri: otpauthUri(secret, cfg.username) };
}

export async function confirmTotp(code: string): Promise<{ ok: boolean; error?: string }> {
  sweep();
  if (!totpSetup) return { ok: false, error: "등록 시간이 지났습니다. 다시 시작하세요" };
  const r = verifyTotp(totpSetup.secret, code);
  if (!r.ok) return { ok: false, error: r.error ?? "숫자가 다릅니다" };

  const cfg = await load();
  cfg.totpSecret = totpSetup.secret;
  totpSetup = null;
  lastTotpStep = r.step ?? 0;
  await save(cfg);
  return { ok: true };
}

/** 등록을 지운다. 메일 방식으로 돌아간다 — 아무 방법도 없는 상태를 만들지 않는다 */
export async function clearTotp(): Promise<void> {
  const cfg = await load();
  cfg.totpSecret = "";
  if (cfg.otpMethod === "totp") cfg.otpMethod = "email";
  totpSetup = null;
  await save(cfg);
}

/** 설정 화면에서 「지금 맞나」를 눌러 볼 때 — 서버가 보는 현재 코드 */
export async function totpNow(): Promise<string> {
  const cfg = await load();
  return cfg.totpSecret ? currentCode(cfg.totpSecret) : "";
}

export async function removeDevice(id: string): Promise<void> {
  const cfg = await load();
  cfg.devices = cfg.devices.filter((d) => d.id !== id);
  await save(cfg);
}

/**
 * 전부 로그아웃. 서명 열쇠를 새로 뽑으면 **이미 나간 쿠키가 전부 무효**가 된다 —
 * 기기 쿠키까지 같이 죽으므로 모든 브라우저가 「처음 보는 기기」로 돌아간다.
 * 어딘가에 세션이 살아 있는 것 같을 때 쓰는 마지막 수단이다.
 */
export async function revokeAll(): Promise<void> {
  const cfg = await load();
  cfg.secret = randomBytes(32).toString("hex");
  cfg.devices = [];
  await save(cfg);
}
