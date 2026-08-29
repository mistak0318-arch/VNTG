import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * 구글 OTP (TOTP, RFC 6238) — 6자리 30초.
 *
 * ## 왜 직접 짜나
 *
 * 계산 자체가 스무 줄이다. 이걸 위해 의존성을 하나 늘리면, 그 패키지가 언젠가
 * 손 바뀌거나 버려질 때 **인증이 걸린 문**이 같이 흔들린다. 표준이 고정돼 있고
 * 짧은 코드라 직접 두는 편이 낫다.
 *
 * ## 계산
 *
 *   T = floor(현재초 / 30)          — 30초마다 1씩 오르는 숫자
 *   H = HMAC-SHA1(비밀키, T를 8바이트 빅엔디언으로)
 *   o = H 마지막 바이트의 하위 4비트   — 어디서부터 읽을지 (동적 절단)
 *   코드 = (H[o..o+4] & 0x7fffffff) % 1000000
 *
 * `& 0x7fffffff` 는 최상위 비트를 버리는 것이다 — 부호 있는 정수로 읽는 구현과
 * 답이 갈리지 않게 하려고 표준이 정해 둔 것이다.
 *
 * ## 시계가 어긋날 때
 *
 * 폰과 서버 시계가 몇 초씩 다를 수 있고, 30초 경계에서 누르면 한 칸이 밀린다.
 * 그래서 **앞뒤 한 칸씩**(±30초) 같이 본다. 더 넓히면 그만큼 오래 유효한 코드가
 * 되므로 한 칸에서 멈춘다.
 */

const STEP = 30;
const DIGITS = 6;
/** 앞뒤로 몇 칸까지 봐줄지 — 1이면 ±30초 */
const DRIFT = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 사람이 손으로 옮겨 적을 수 있어야 해서 base32 다 (0/O, 1/l 이 없다) */
export function toBase32(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

function fromBase32(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) continue;
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 20바이트 — SHA1 블록에 맞는 표준 길이다 */
export function newSecret(): string {
  return toBase32(randomBytes(20));
}

function codeAt(secret: string, step: number): string {
  const key = fromBase32(secret);
  const msg = Buffer.alloc(8);
  /* 자바스크립트 정수는 32비트 비트연산이라 위/아래를 나눠 쓴다.
     상위 4바이트는 서기 1만년쯤까지 0이지만, 표준이 8바이트라 자리를 지킨다. */
  msg.writeUInt32BE(Math.floor(step / 2 ** 32), 0);
  msg.writeUInt32BE(step >>> 0, 4);

  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const num = h.readUInt32BE(o) & 0x7fffffff;
  return String(num % 10 ** DIGITS).padStart(DIGITS, "0");
}

/** 지금 화면에 떠 있을 코드 — 설정을 시험할 때 쓴다 */
export function currentCode(secret: string): string {
  return codeAt(secret, Math.floor(Date.now() / 1000 / STEP));
}

/**
 * 맞나 확인하고, 맞으면 **몇 번째 칸이었는지** 돌려준다.
 *
 * 부르는 쪽이 그 번호를 기억했다가 같은 칸을 다시 안 받으면 재사용을 막을 수 있다 —
 * 30초 안에 코드를 훔쳐 본 사람이 그대로 한 번 더 쓰는 것을 막는 값이다.
 */
export function verifyTotp(
  secret: string,
  input: string,
  lastUsedStep = 0,
): { ok: boolean; step?: number; error?: string } {
  const given = input.replace(/\D/g, "");
  if (given.length !== DIGITS) return { ok: false, error: "6자리를 입력하세요" };
  if (!secret) return { ok: false, error: "구글 OTP 가 설정되지 않았습니다" };

  const now = Math.floor(Date.now() / 1000 / STEP);
  for (let d = -DRIFT; d <= DRIFT; d += 1) {
    const step = now + d;
    /* 길이가 같은 6자리끼리라 시간 일정 비교가 성립한다 */
    if (timingSafeEqual(Buffer.from(given), Buffer.from(codeAt(secret, step)))) {
      if (step <= lastUsedStep) return { ok: false, error: "이미 쓴 코드입니다" };
      return { ok: true, step };
    }
  }
  return { ok: false, error: "숫자가 다릅니다" };
}

/**
 * 인증 앱에 넣을 주소.
 *
 * 폰에서 이 링크를 누르면 구글 OTP 가 바로 열리면서 등록된다 — QR 을 찍는 것보다
 * 오히려 빠르다. PC 에서 설정할 때는 아래에 같이 보여 주는 **설정 키**를 앱에
 * 손으로 넣으면 된다.
 */
export function otpauthUri(secret: string, account: string, issuer = "VNTG HTS"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP),
  });
  return `otpauth://totp/${label}?${q.toString()}`;
}
