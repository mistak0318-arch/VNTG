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

/**
 * **줄이 너무 길면 서지 않는다** (2026-10-07 — 「신호등·재무·목표주가 카드가 먹통」의 정체).
 *
 * 이 줄은 **초당 2.5건**이고 상한이 없었다. 보드에 카드를 여러 개 띄우면 한투 요청이 수백 개 들어오는데,
 * 뒤에 선 것은 그 수를 2.5 로 나눈 만큼 — 실측 **142~153초** — 기다렸다. 화면에는 「불러오는 중」만 남고,
 * 그동안 새 요청이 또 쌓이니 **한 번 막히면 스스로 풀리지 않는다.** 재무·목표주가·섹터·신호등 근거·공시 조치,
 * 야간선물 차트까지 한투를 쓰는 것이 전부 같은 줄에 선다(벤티지가 하나씩 짚어 준 그대로다).
 *
 * 그래서 **차례를 미리 가늠해 20초를 넘길 것 같으면 즉시 포기**한다. 포기는 실패가 아니라 빨리 알리는 것이다 —
 * 카드가 「지금 붐빔」이라 말하고 다음 새로고침에 받는 쪽이, 모든 카드가 2분씩 매달려 있는 것보다 낫다.
 * 줄이 짧아지니 앞쪽도 제때 끝난다. 한투는 **조회 전용**이라 포기해도 잃는 것은 그 화면 한 칸뿐이다.
 */
/**
 * 줄에서 기다릴 수 있는 최대 시간 — **20초에서 8초로** (2026-10-08).
 *
 * ⚠️ 한투를 기다리는 요청이 **과부하 관문의 자리를 쥔 채로** 기다린다. 그래서 줄이 길어지면
 * 한투와 아무 상관 없는 길(시황 대시보드는 키움·파일만 쓴다)까지 자리가 없어 같이 막혔다.
 * 벤티지: "한투 요청을 기다리고 있어서 다른데 요청 들어가도 같이 안되는거 같은데."
 *
 * 그러니 **한투는 빨리 포기하는 편이 전체에 이롭다.** 카드 하나가 「잠시 뒤 다시 받습니다」로
 * 뜨는 대신, 그 자리를 놓아 다른 화면이 돈다. 부르는 쪽은 대개 이 실패를 받아 제 값만 비운다.
 */
const MAX_QUEUE_WAIT_MS = 8_000;
const MAX_QUEUED = Math.floor(MAX_QUEUE_WAIT_MS / MIN_GAP_MS); // 20건
let queued = 0;

/**
 * **줄 비우기용 세대 번호** (2026-10-08) — 벤티지: "비우기 하면 각 요청도 비워주면 안되?"
 *
 * 줄이 약속 사슬이라 선 것을 하나씩 집어 뺄 수가 없다. 대신 번호를 하나 올리면,
 * 그 전에 줄 선 것들은 차례가 와도 **제 번호가 낡은 걸 보고 스스로 물러난다.**
 */
let generation = 0;

/** 지금 한투 줄에 선 수 — health 가 적는다 */
export function hantooQueueDepth(): number {
  return queued;
}

/** 줄을 통째로 비운다. 비운 건수를 돌려준다 — 「비우기」 단추가 부른다 */
export function dropHantooQueue(): number {
  const n = queued;
  if (n > 0) generation += 1;
  return n;
}

function slot(): Promise<void> {
  if (queued >= MAX_QUEUED) {
    return Promise.reject(
      new HantooError(
        "QUEUE_FULL",
        `한투 조회가 몰려 있습니다 — 앞에 ${queued}건 (약 ${Math.round((queued * MIN_GAP_MS) / 1000)}초). 잠시 뒤 다시 받습니다`,
      ),
    );
  }
  queued += 1;
  /* 줄에 설 때의 번호. 기다리는 사이 비우기가 눌리면 번호가 달라져 있다 */
  const gen = generation;
  const mine = queue
    .then(async () => {
      if (gen !== generation) {
        throw new HantooError("DROPPED", "한투 줄을 비웠습니다 — 다시 눌러 주세요");
      }
      const wait = lastAt + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      /* 기다리는 동안 비웠을 수도 있다 — 쉰 뒤에 한 번 더 본다 */
      if (gen !== generation) {
        throw new HantooError("DROPPED", "한투 줄을 비웠습니다 — 다시 눌러 주세요");
      }
      lastAt = Date.now();
    })
    .finally(() => {
      queued -= 1;
    });
  queue = mine.catch(() => undefined);
  return mine;
}

/**
 * 조회 API 호출. GET 전용이다 — 이 프로젝트는 조회 전용이라 주문 경로를 아예 열지 않는다.
 *
 * @param feature 과금·호출 집계용 이름 (어느 메뉴에서 썼는지)
 */
/**
 * **같은 조회가 겹치면 한 번만** (2026-10-07 — 키움에 넣은 것과 같은 처방, 여기는 네 배 비싸다).
 *
 * 한투 줄은 **초당 2.5건**이다. 보드에서 종목을 바꾸면 카드 여럿이 **같은 종목의 같은 조회**를 각자 부르는데,
 * 그 하나하나가 400ms 씩 줄을 늘린다. 진행 중인 것을 공유하고 끝난 뒤 3초는 그 답을 그대로 주면,
 * 같은 순간에 들어온 열 번이 한 번이 된다 — 줄이 짧아지는 만큼 **모든 카드가 같이 빨라진다.**
 *
 * 3초로 짧게 잡은 까닭은 시세성 조회(현재가·야간선물)도 이 문을 지나기 때문이다. 재무·목표주가처럼
 * 느리게 변하는 것은 부르는 쪽이 이미 제 캐시(목표주가는 6시간)를 갖고 있다.
 * 받는 쪽이 고쳐 써도 서로 안 흔들리게 **복사해서** 준다. 한투는 조회 전용이라 주문이 섞일 일이 없다.
 */
const shared = new Map<string, { done: number | null; p: Promise<unknown> }>();
const SHARE_MS = 3_000;

/**
 * **느리게 변하는 조회는 더 오래 합친다** (2026-10-08).
 *
 * 벤티지가 보드를 **모니터 셋**에 띄우고 종목연동으로 쓴다 — 세 화면이 **같은 종목**을 본다.
 * 그런데 보드마다 카드가 뜨는 시차가 3초보다 커서, 같은 조회가 **세 번 따로** 나갔다.
 * 한투는 초당 2.5건이라 그 3배가 그대로 줄 길이가 된다(실측: 한투 줄 20, 그때 키움은 2).
 *
 * 창을 넓히면 그 셋이 하나가 된다. 다만 **시세성 조회는 안 된다** — 현재가·야간선물이
 * 15초 묵으면 그 값으로 판단하게 된다. 그래서 **아래 다섯만** 넓힌다:
 * 재무비율·분기실적·투자의견·추정실적·기업개요 — 전부 하루 단위로나 바뀌는 것들이고,
 * 부르는 쪽도 이미 몇 시간짜리 캐시를 갖고 있다(여기서 합치는 것은 **그 캐시가 비어 있는
 * 첫 조회**가 세 화면에서 동시에 일어나는 경우다).
 */
const SLOW_TRS = new Set([
  "FHKST66430300", // 재무비율
  "FHKST66430200", // 분기실적
  "FHKST663300C0", // 투자의견
  "HHKST668300C0", // 추정실적
  "CTPF1002R", // 기업개요
]);
const SLOW_SHARE_MS = 60_000;
const shareMsOf = (trId: string) => (SLOW_TRS.has(trId) ? SLOW_SHARE_MS : SHARE_MS);

export async function hantooGet<T = Record<string, unknown>>(
  path: string,
  trId: string,
  params: Record<string, string>,
  feature: string,
): Promise<T> {
  const key = `${trId}|${path}|${JSON.stringify(params)}`;
  const share = shareMsOf(trId);
  const hit = shared.get(key);
  if (hit && (hit.done === null || Date.now() - hit.done < share)) {
    return structuredClone(await hit.p) as T;
  }
  const p = hantooGetRaw<T>(path, trId, params, feature);
  const entry = { done: null as number | null, p: p as Promise<unknown> };
  shared.set(key, entry);
  p.then(
    () => {
      entry.done = Date.now();
      const t = setTimeout(() => {
        if (shared.get(key) === entry) shared.delete(key);
      }, share);
      t.unref?.();
    },
    /* 실패는 나누지 않는다 — 다음 호출이 새로 부른다 */
    () => {
      if (shared.get(key) === entry) shared.delete(key);
    },
  );
  return structuredClone(await p) as T;
}

async function hantooGetRaw<T = Record<string, unknown>>(
  path: string,
  trId: string,
  params: Record<string, string>,
  feature: string,
): Promise<T> {
  const c = creds();
  if (!c) throw new HantooError("NO_KEY", "한국투자증권 API 키가 설정되지 않았습니다");

  const token = await getToken();
  const url = `${BASE}${path}?${new URLSearchParams(params).toString()}`;

  /** 유량에 걸린 것. 쉬면 풀린다 */
  const throttled = (e: unknown) =>
    e instanceof HantooError && /초당|유량|EGW00201/.test(e.message + e.code);

  const once = async (): Promise<T & { rt_cd?: string; msg1?: string; msg_cd?: string }> => {
    await slot();

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
          appkey: c.key,
          appsecret: c.secret,
          tr_id: trId,
          custtype: "P",
        },
      });
    } catch (err) {
      // 네트워크가 끊긴 것. 요청이 서버에 닿지도 않았으므로 다시 부르면 된다
      void recordApiCall("hantoo", feature, "failed", undefined, "네트워크 오류");
      throw new HantooError("NETWORK", err instanceof Error ? err.message : "네트워크 오류");
    }

    const body = (await res.json().catch(() => ({}))) as T & {
      rt_cd?: string;
      msg1?: string;
      msg_cd?: string;
    };

    if (!res.ok) {
      void recordApiCall(
        "hantoo",
        feature,
        res.status === 429 ? "rateLimited" : "failed",
        undefined,
        `HTTP ${res.status}`,
      );
      throw new HantooError(String(res.status), body.msg1 ?? `HTTP ${res.status}`);
    }

    /*
     * rt_cd 는 0 이 정상이다. HTTP 200 이어도 여기가 0 이 아니면 실패다.
     *
     * **예전엔 이걸 「성공」으로 세고 있었다.** 위에서 `res.ok` 만 보고 기록한 뒤
     * 여기서 던졌기 때문이다 — 화면의 성공 건수가 실제보다 부풀어 있었다.
     * 한투가 유량 초과를 HTTP 200 + rt_cd 로 주기도 해서, 그것도 여기서 갈라 센다.
     */
    if (body.rt_cd !== undefined && body.rt_cd !== "0") {
      const err = new HantooError(body.msg_cd ?? "ERR", body.msg1 ?? "조회 실패");
      void recordApiCall(
        "hantoo",
        feature,
        throttled(err) ? "rateLimited" : "failed",
        undefined,
        // 메시지가 곧 사유다 — 「기간이 올바르지 않습니다」 처럼 고칠 수 있는 것이 대부분이다
        `${err.code} ${err.message}`,
      );
      throw err;
    }

    void recordApiCall("hantoo", feature, "ok");
    return body;
  };

  /*
   * 다시 불러 볼 값어치가 있는 실패.
   *
   * 예전엔 **유량만** 다시 불렀다. 그런데 하루 실패가 3,700건인데 유량은 0 이었다 —
   * 즉 그 실패들은 한 번도 재시도되지 않았다는 뜻이다.
   * 네트워크가 끊긴 것과 서버 쪽 5xx·429 는 **같은 요청이 다음엔 될 수 있다.**
   * 종목이 없다거나 파라미터가 틀린 것(그 밖의 rt_cd)은 다시 불러도 같으므로 그대로 던진다.
   */
  const retryable = (e: unknown) =>
    e instanceof HantooError &&
    (throttled(e) || e.code === "NETWORK" || e.code === "429" || /^5\d\d$/.test(e.code));

  for (let attempt = 0; ; attempt += 1) {
    try {
      return await once();
    } catch (err) {
      if (attempt >= 2 || !retryable(err)) {
        if (attempt > 0 && err instanceof HantooError) {
          console.error(`[hantoo] ${feature} 재시도 ${attempt}회 후에도 실패: ${err.code} ${err.message}`);
        }
        throw err;
      }
      // 유량은 좀 더 쉬고, 그 밖의 일시 오류는 짧게 쉰다
      const wait = throttled(err) ? 1500 * (attempt + 1) : 600 * (attempt + 1);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
