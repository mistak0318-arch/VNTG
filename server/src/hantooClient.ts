import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";

/**
 * 한국투자증권 OpenAPI.
 *
 * 키움에 **아예 없는 것**만 여기서 받는다 — 증권사 목표주가·투자의견, 해외주식, 국내
 * 선물옵션. 국내주식은 계속 키움을 쓴다. 두 곳에서 같은 값을 받으면 어긋날 때 어느 쪽이
 * 맞는지 판단할 근거가 없기 때문이다.
 *
 * **토큰은 반드시 디스크에 남긴다.** 유효기간이 24시간인데 문서에 「1일 1회 발급 원칙」
 * 이라고 적혀 있고, 6시간 안에 다시 부르면 직전 토큰을 그대로 돌려준다. 메모리에만 두면
 * 서버를 재시작할 때마다 발급을 때리게 된다 — 키움 클라이언트가 메모리 캐시로 버티는 건
 * 키움엔 그런 제약이 없어서다.
 *
 * 자세한 TR_ID·파라미터는 `docs/한투API_참고.md` 에 있다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const TOKEN_FILE = join(DATA_DIR, "hantooToken.json");

const BASE = "https://openapi.koreainvestment.com:9443";

interface TokenState {
  token: string;
  /** epoch ms */
  expiresAt: number;
}

export class HantooError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HantooError";
  }
}

let state: TokenState | null = null;
let issuing: Promise<string> | null = null;

function creds(): { key: string; secret: string } | null {
  const key = process.env.HANTOO_APP_KEY?.trim();
  const secret = process.env.HANTOO_APP_SECRET?.trim();
  if (!key || !secret) return null;
  return { key, secret };
}

/** 키가 꽂혀 있나 — 화면에서 "설정 안 됨"을 안내할 때 쓴다 */
export function hantooReady(): boolean {
  return creds() !== null;
}

async function loadToken(): Promise<TokenState | null> {
  try {
    const raw = JSON.parse(await readFile(TOKEN_FILE, "utf-8")) as Partial<TokenState>;
    if (typeof raw.token === "string" && typeof raw.expiresAt === "number") {
      return { token: raw.token, expiresAt: raw.expiresAt };
    }
  } catch {
    /* 없으면 새로 받는다 */
  }
  return null;
}

async function issueToken(): Promise<string> {
  const c = creds();
  if (!c) throw new HantooError("NO_KEY", "HANTOO_APP_KEY / HANTOO_APP_SECRET 이 없습니다");

  const res = await fetch(`${BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: c.key,
      appsecret: c.secret,
    }),
  });
  void recordApiCall("hantoo", "token", res.ok ? "ok" : "failed");

  const body = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
    error_code?: string;
    error_description?: string;
  };

  if (!res.ok || !body.access_token) {
    const code = body.error_code ?? String(res.status);
    // EGW00105 는 앱시크릿이 틀렸다는 뜻이다. 실제로 붙여넣을 때 한 글자가 더 붙어
    // 181자가 된 적이 있다 — 규격은 정확히 180자다
    const hint =
      code === "EGW00105"
        ? " (앱시크릿은 정확히 180자입니다 — .env 값의 길이를 확인하세요)"
        : "";
    throw new HantooError(code, (body.error_description ?? "토큰 발급 실패") + hint);
  }

  const ttl = Number(body.expires_in) || 86_400;
  state = { token: body.access_token, expiresAt: Date.now() + ttl * 1000 };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, JSON.stringify(state), "utf-8");
  console.log(`[hantoo] 접근토큰 발급 — ${new Date(state.expiresAt).toLocaleString("ko-KR")} 까지`);
  return state.token;
}

async function getToken(): Promise<string> {
  // 만료 1시간 전부터 갱신한다. 조회 도중에 죽는 것보다 조금 일찍 받는 편이 낫다
  const fresh = (s: TokenState | null) => s !== null && s.expiresAt > Date.now() + 3_600_000;

  if (fresh(state)) return state!.token;
  if (!state) {
    state = await loadToken();
    if (fresh(state)) return state!.token;
  }
  if (!issuing) {
    issuing = issueToken().finally(() => {
      issuing = null;
    });
  }
  return issuing;
}

/*
 * 유량 제한.
 *
 * 문서엔 초당 몇 건인지 안 적혀 있다. 세 번을 잇달아 부르니 바로
 * **"초당 거래건수를 초과하였습니다"** 가 났다 — 키움(TR당 초당 5회)보다 빡빡하다.
 *
 * 그래서 **전부 한 줄로 세워** 400ms 씩 띄운다(초당 2.5건). 250ms 로도 걸려서 늘렸다.
 * 조회 전용이라 급할 일이 없고, 목표주가는 6시간 캐시가 걸려 있어 이 속도로 충분하다.
 */
const MIN_GAP_MS = 400;
let lastAt = 0;
let queue: Promise<void> = Promise.resolve();

function slot(): Promise<void> {
  const mine = queue.then(async () => {
    const wait = lastAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  });
  queue = mine.catch(() => undefined);
  return mine;
}

/**
 * 조회 API 호출. GET 전용이다 — 이 프로젝트는 조회 전용이라 주문 경로를 아예 열지 않는다.
 *
 * @param feature 과금·호출 집계용 이름 (어느 메뉴에서 썼는지)
 */
export async function hantooGet<T = Record<string, unknown>>(
  path: string,
  trId: string,
  params: Record<string, string>,
  feature: string,
): Promise<T> {
  const c = creds();
  if (!c) throw new HantooError("NO_KEY", "한국투자증권 API 키가 설정되지 않았습니다");

  const token = await getToken();
  const url = `${BASE}${path}?${new URLSearchParams(params).toString()}`;

  const once = async (): Promise<T & { rt_cd?: string; msg1?: string; msg_cd?: string }> => {
    await slot();
    const res = await fetch(url, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
        appkey: c.key,
        appsecret: c.secret,
        tr_id: trId,
        custtype: "P",
      },
    });
    void recordApiCall("hantoo", feature, res.ok ? "ok" : "failed");
    const body = (await res.json()) as T & { rt_cd?: string; msg1?: string; msg_cd?: string };
    if (!res.ok) throw new HantooError(String(res.status), body.msg1 ?? `HTTP ${res.status}`);
    // rt_cd 는 0 이 정상이다. HTTP 200 이어도 여기가 0 이 아니면 실패다
    if (body.rt_cd !== undefined && body.rt_cd !== "0") {
      throw new HantooError(body.msg_cd ?? "ERR", body.msg1 ?? "조회 실패");
    }
    return body;
  };

  // 유량에 걸린 건 쉬면 풀린다. 그 밖의 실패는 다시 불러도 같으니 바로 던진다
  const throttled = (e: unknown) =>
    e instanceof HantooError && /초당|유량|EGW00201/.test(e.message + e.code);

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once();
    } catch (err) {
      if (attempt >= 2 || !throttled(err)) throw err;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}
