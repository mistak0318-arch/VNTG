import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **해외선물 계좌 키(`HANTOO_APP_KEY_2`)로 미국 선물 시세가 열리나** (2026-09-15).
 *
 * 벤티지가 한투 해외선물 계좌를 열고 그 계좌로 앱키를 따로 받아 **미니PC** `.env` 에 `_2` 로 넣었다.
 * 개발기에서는 미니PC `.env` 를 못 읽고, 밖에서 미니PC 를 들여다볼 창은 `health.json` 뿐이다.
 * 그래서 서버가 스스로 찔러 보고 **된다/안 된다와 사유 문장만** 거기 적는다 — 키·계좌·값은 안 싣는다.
 *
 * 9/15 첫 키(주식 계좌)로 재 본 것: 홍콩 항셍은 나오고, CME·CBOT·NYMEX·COMEX 는
 * `EGW00550~553` 「○○ SUB거래소 신청 계좌가 아닙니다」. 이 키로 풀리는지가 이 파일의 물음이다.
 *
 * 한 시간마다 다시 본다 — 한투 앱에서 거래소 시세를 신청하면 다음 회차에 바뀐 것이 보인다.
 * 토큰은 파일에 둔다(24시간). 한투는 「1일 1회 발급」이 원칙이라 재시작마다 받으면 안 된다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = join(here, "..", "data", "hantooToken2.json");
const BASE = "https://openapi.koreainvestment.com:9443";

/** 무엇을 찔러 보나 — 이름과 월물. 월물은 3개월마다 바뀌니 시험용으로만 박아 둔다 */
const TARGETS: { label: string; code: string }[] = [
  { label: "E-mini S&P (CME)", code: "ESZ26" },
  { label: "나스닥 (CME)", code: "NQZ26" },
  { label: "WTI (NYMEX)", code: "CLX26" },
  { label: "금 (COMEX)", code: "GCZ26" },
  { label: "구리 (COMEX)", code: "HGZ26" },
  { label: "미 10년물 (CBOT)", code: "ZNZ26" },
  { label: "항셍 (HKEx, 대조)", code: "HSIV26" },
];

let result: Record<string, unknown> = { 상태: "아직 안 봄" };
export const hantooFutProbeSnapshot = (): Record<string, unknown> => result;

function creds(): { key: string; secret: string } | null {
  const key = process.env.HANTOO_APP_KEY_2?.trim();
  const secret = process.env.HANTOO_APP_SECRET_2?.trim();
  return key && secret ? { key, secret } : null;
}

async function token(c: { key: string; secret: string }): Promise<string> {
  try {
    const t = JSON.parse(await readFile(TOKEN_FILE, "utf-8")) as { token: string; expiresAt: number; keyTail: string };
    /* 키가 바뀌었으면 옛 토큰을 쓰지 않는다 — 끝 네 글자만 견준다(키를 파일에 통째로 두지 않는다) */
    if (t.token && t.expiresAt - Date.now() > 30 * 60_000 && t.keyTail === c.key.slice(-4)) return t.token;
  } catch {
    /* 처음 */
  }
  const res = await fetch(`${BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: c.key, appsecret: c.secret }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string; msg1?: string };
  if (!res.ok || !body.access_token) throw new Error(`토큰 발급 실패: HTTP ${res.status} ${body.error_description ?? body.msg1 ?? ""}`.trim());
  const expiresAt = Date.now() + (body.expires_in ?? 86_400) * 1000;
  await mkdir(dirname(TOKEN_FILE), { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify({ token: body.access_token, expiresAt, keyTail: c.key.slice(-4) }), "utf-8");
  return body.access_token;
}

async function probe(): Promise<void> {
  const c = creds();
  if (!c) {
    result = { 상태: "키2 없음 — .env 에 HANTOO_APP_KEY_2 / HANTOO_APP_SECRET_2 가 안 읽힌다" };
    return;
  }
  const at = new Date(Date.now() + 9 * 3600_000).toISOString().slice(11, 16);
  let tk: string;
  try {
    tk = await token(c);
  } catch (e) {
    result = { 상태: "토큰 실패", 시각: at, 사유: e instanceof Error ? e.message.slice(0, 160) : String(e) };
    return;
  }
  const out: Record<string, string> = {};
  for (const t of TARGETS) {
    try {
      const res = await fetch(`${BASE}/uapi/overseas-futureoption/v1/quotations/inquire-price?SRS_CD=${t.code}`, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${tk}`,
          appkey: c.key,
          appsecret: c.secret,
          tr_id: "HHDFC55010000",
          custtype: "P",
        },
      });
      const txt = await res.text();
      /* 실패 본문은 JSON 이 아닐 때가 있다({rt_cd:"1",…} 처럼 키에 따옴표가 없다) — 정규식으로 사유만 꺼낸다 */
      const msg = txt.match(/"?msg1"?\s*:\s*"([^"]*)"/)?.[1] ?? "";
      const code = txt.match(/"?msg_cd"?\s*:\s*"([^"]*)"/)?.[1] ?? "";
      const time = txt.match(/"proc_time"\s*:\s*"(\d{6})"/)?.[1];
      const last = txt.match(/"last_price"\s*:\s*"\s*([\d.]+)"/)?.[1];
      out[t.label] = res.ok && last
        ? `✅ 된다 — 마지막 체결 ${time ? `${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4)}` : "?"}`
        : res.ok
          ? "빈 응답(종목코드가 틀렸거나 그 거래소를 안 준다)"
          : `❌ ${code} ${msg}`.trim();
    } catch (e) {
      out[t.label] = `❌ 네트워크 ${e instanceof Error ? e.message.slice(0, 80) : ""}`;
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  result = { 상태: "봤다", 시각: at, 결과: out };
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startHantooFutProbe(): void {
  if (timer) return;
  /* 기동 1분 뒤 한 번, 그 뒤 한 시간마다 */
  setTimeout(() => void probe().catch(() => undefined), 60_000);
  timer = setInterval(() => void probe().catch(() => undefined), 60 * 60_000);
  timer.unref?.();
}
