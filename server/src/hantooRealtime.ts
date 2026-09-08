import type { RealtimeStore } from "./realtimeStore.js";
import { recordApiCall } from "./apiUsage.js";

/**
 * **해외주식 실시간 체결 — 한투 웹소켓** (2026-09-08).
 *
 * 벤티지: "해외주식 갱신주기가 왜케 느리냐" → "소켓 연결해서 갱신 주기를 더 빨리 가져갈 수
 * 있을 거 같은데. 국내주식이랑 비슷하게" → "한투 웹소켓을 활용하거나 하는 건? 안 되는 거야?"
 *
 * 된다. 그날 실측으로 다 확인했다.
 *
 * ## 왜 이게 필요했나
 *
 * 해외는 여태 **폴링뿐**이었다 — 정규장엔 야후 spark 3초, 프리·애프터엔 한투 조회 15초.
 * 국내는 키움 소켓으로 체결이 밀려 들어오는데 해외만 초 단위로 조르고 있었다.
 * 키움 FE(해외 체결)는 **등록만 받고 프레임을 안 준다** — 같은 날 여덟 가지 종목코드
 * 형식으로 정규장 한복판에 35초를 기다려도 0건이었다(`POST /api/realtime/probe-fe`).
 *
 * ## 실측 (2026-09-08 23:0x KST = 10:0x ET, 미국 정규장)
 *
 * ```
 * POST /oauth2/Approval           → approval_key 발급 O
 * ws://ops.koreainvestment.com:21000
 * {header:{approval_key, custtype:"P", tr_type:"1"}, body:{input:{tr_id:"HDFSCNT0", tr_key:"DNASNVDA"}}}
 *                                 → SUBSCRIBE SUCCESS, encrypt:"N" (평문)
 * 25초에 191 프레임 (두 종목) — 종목당 초당 4틱쯤
 * ```
 *
 * ## ⚠️ 구독은 **41건**까지 (실측)
 *
 * 50종목을 걸어 보니 41건에서 `OPSP0008 MAX SUBSCRIBE OVER` 로 잘렸다. 국내(200)보다
 * 훨씬 빡빡하다. 그래서 **지금 보고 있는 그룹만** 건다 — 화면이 빠른 시세를 물을 때
 * 넘겨 주는 심볼 목록을 그대로 쓴다(`/api/us-watch/fast`). 그룹을 옮기면 옛 구독을
 * 풀고 새로 건다. 41 이 넘으면 앞에서부터 41개만 — 화면도 그만큼만 보고 있다.
 *
 * ## 값은 국내와 **같은 저장소**로
 *
 * 프레임을 `FE:<심볼>` 로 저장소에 넣는다. 화면(`UsWatchTable`)은 이미 그 열쇠를 읽고
 * 있어서(`rt.values['FE:NVDA']`, FID 10=현재가·12=등락률) **화면은 한 줄도 안 고쳤다.**
 * 저장소가 둘이면 그때부터 값이 갈린다 — 국내가 이미 겪은 자리다.
 *
 * ## 프레임 형식
 *
 * `0|HDFSCNT0|002|<레코드>^...` — 세 번째 칸이 **레코드 개수**다(002 면 두 건이 이어 붙어
 * 온다). 한 레코드는 `^` 로 나뉜 26칸이고 쓰는 것은 넷이다:
 *
 *   [1] SYMB 심볼 · [11] LAST 현재가 · [14] RATE 등락률 · [20] TVOL 누적거래량 · [24] STRN 체결강도
 */

const APPROVAL_URL = "https://openapi.koreainvestment.com:9443/oauth2/Approval";
const WS_URL = "ws://ops.koreainvestment.com:21000";
const TR_ID = "HDFSCNT0";
/** 실측 상한 — 넘기면 OPSP0008 로 거절된다 */
const MAX_SUBS = 41;
/** 한 레코드의 칸 수 — 이보다 짧으면 우리가 아는 모양이 아니다 */
const FIELDS = 26;

/** 한투 거래소 코드(4자리 excd) → 실시간 tr_key 의 3자리. 미국 셋만 확인했다 */
const EXCD3: Record<string, string> = {
  NAS: "NAS",
  NYS: "NYS",
  AMS: "AMS",
};

export interface HantooRtStatus {
  enabled: boolean;
  state: "꺼짐" | "연결 중" | "연결됨" | "끊김" | "다른 곳이 쓰는 중";
  /** 마지막 체결 프레임이 온 지 몇 초 — null 이면 아직 */
  lastFrameAgoSec: number | null;
  subscribed: string[];
  max: number;
  frames: number;
  /** 거절 사유 — 상한 초과 같은 것 */
  rejects: string[];
}

let ws: WebSocket | null = null;
let approvalKey = "";
let state: HantooRtStatus["state"] = "꺼짐";
let lastFrameAt = 0;
let frames = 0;
const rejects: string[] = [];
/** 지금 걸려 있는 tr_key → 심볼 */
const subs = new Map<string, string>();
/** 화면이 원하는 심볼(대문자) — 순서가 곧 우선순위다 */
let wanted: string[] = [];
let store: RealtimeStore | null = null;
let retryAt = 0;
let retryMs = 3_000;

/**
 * ⚠️ **앱키당 세션이 하나다.** 그래서 개발 PC 와 미니PC 가 같이 켜면 **먼저 붙은 쪽이 이기고
 * 나머지는 계속 거절**된다(`OPSP8996 ALREADY IN USE appkey`). 실제로 그 일이 났다 —
 * 개발 PC 가 물고 있는 동안 미니PC 화면의 해외 시세가 통째로 멈췄다.
 *
 * 기본은 **켜짐**이다(배포본이 늘 이겨야 한다). 개발 PC 는 제 `.env` 에 `HANTOO_RT=0` 을
 * 적어 끈다 — 그 파일은 깃에 안 올라가므로 배포본에는 영향이 없다.
 */
function enabled(): boolean {
  const flag = (process.env.HANTOO_RT ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  return Boolean(process.env.HANTOO_APP_KEY?.trim() && process.env.HANTOO_APP_SECRET?.trim());
}

async function getApprovalKey(): Promise<string> {
  if (approvalKey) return approvalKey;
  const res = await fetch(APPROVAL_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: process.env.HANTOO_APP_KEY?.trim(),
      secretkey: process.env.HANTOO_APP_SECRET?.trim(),
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`approval ${res.status}`);
  const j = (await res.json()) as { approval_key?: string };
  if (!j.approval_key) throw new Error("approval_key 없음");
  approvalKey = j.approval_key;
  return approvalKey;
}

function send(obj: unknown): void {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function sub(trKey: string, on: boolean): void {
  send({
    header: { approval_key: approvalKey, custtype: "P", tr_type: on ? "1" : "2", "content-type": "utf-8" },
    body: { input: { tr_id: TR_ID, tr_key: trKey } },
  });
}

/**
 * 원하는 목록에 맞춰 구독을 고친다 — 빠진 것은 풀고 새 것은 건다.
 * 소켓이 아직이면 아무것도 안 한다(붙을 때 `resync` 를 다시 부른다).
 */
function resync(): void {
  if (!ws || ws.readyState !== 1) return;
  const want = new Map<string, string>();
  for (const sym of wanted.slice(0, MAX_SUBS)) {
    const key = trKeyOf(sym);
    if (key) want.set(key, sym);
  }
  for (const key of [...subs.keys()]) {
    if (!want.has(key)) {
      sub(key, false);
      subs.delete(key);
    }
  }
  for (const [key, sym] of want) {
    if (subs.has(key)) continue;
    subs.set(key, sym);
    sub(key, true);
  }
}

/** 심볼 → tr_key. 거래소를 모르면 나스닥으로 본다 — 미국 관심종목이 대부분 나스닥·뉴욕이다 */
const excdBySymbol = new Map<string, string>();
function trKeyOf(sym: string): string | null {
  if (sym.includes(".")) return null; // 미국 밖(야후 꼬리) 종목은 이 TR 이 아니다
  const excd = EXCD3[excdBySymbol.get(sym) ?? ""] ?? "NAS";
  return `D${excd}${sym}`;
}

/** 종목의 거래소를 알려 준다 — 본 시세(한투)가 `excd` 를 이미 알고 있다 */
export function noteUsExchange(symbol: string, excd: string | null | undefined): void {
  const e = String(excd ?? "").trim().toUpperCase();
  if (e && EXCD3[e]) excdBySymbol.set(symbol.toUpperCase(), e);
}

function onText(text: string): void {
  /* 제어 메시지는 JSON, 체결은 파이프 문자열 */
  if (text.startsWith("{")) {
    try {
      const j = JSON.parse(text) as {
        header?: { tr_id?: string; tr_key?: string };
        body?: { rt_cd?: string; msg_cd?: string; msg1?: string };
      };
      /* 살아 있음 확인 — 받은 그대로 돌려주는 것이 한투 규약이다 */
      if (j.header?.tr_id === "PINGPONG") {
        send(j);
        return;
      }
      const msg = j.body?.msg1 ?? "";
      if (msg && !/SUCCESS/i.test(msg)) {
        const line = `${j.header?.tr_key ?? ""} ${j.body?.msg_cd ?? ""} ${msg}`.trim().slice(0, 120);
        rejects.unshift(line);
        rejects.splice(20);
        /* 상한 초과면 그 자리는 포기한다 — 다시 걸어 봐야 또 거절이다 */
        if (/OPSP0008/.test(j.body?.msg_cd ?? "") && j.header?.tr_key) subs.delete(j.header.tr_key);
        /*
         * ⚠️ **앱키당 세션 하나다** (2026-09-08 실측 `OPSP8996 ALREADY IN USE appkey`).
         *
         * 다른 곳이 물고 있으면 붙어도 거절만 돌아온다. 5초마다 다시 시도하면 거절 로그만
         * 쌓이므로 쉬었다 본다 — 다만 **너무 길면 안 된다.** 개발 PC 를 끄고 배포본이
         * 자리를 이어받아야 하는 순간이 바로 그 사이라, 10분은 「해외 시세가 10분 멈춤」이다.
         * 45초로 둔다. 키움 앱키가 아침에 겪은 것과 같은 성질이다(같은 키로 둘이 붙으면
         * 서로 죽인다) — 다른 점은 이쪽은 **나중에 온 쪽이 진다**는 것뿐이다.
         */
        if (/OPSP8996/.test(j.body?.msg_cd ?? "")) {
          state = "다른 곳이 쓰는 중";
          retryAt = Date.now() + 45_000;
          try {
            ws?.close();
          } catch {
            /* 이미 닫혔을 수 있다 */
          }
        }
      }
    } catch {
      /* 우리가 모르는 제어 프레임 — 무시한다 */
    }
    return;
  }

  const parts = text.split("|");
  if (parts.length < 4 || parts[1] !== TR_ID) return;
  const count = Number(parts[2]) || 1;
  const cells = parts[3].split("^");
  for (let i = 0; i < count; i++) {
    const off = i * FIELDS;
    if (cells.length < off + FIELDS) break;
    const sym = String(cells[off + 1] ?? "").trim().toUpperCase();
    const last = Number(cells[off + 11]);
    if (!sym || !Number.isFinite(last) || last <= 0) continue;
    frames += 1;
    lastFrameAt = Date.now();
    /*
     * 국내 체결(0B)과 같은 FID 자리에 넣는다 — 화면은 10(현재가)·12(등락률)만 읽는다.
     * 13(누적거래량)·228(체결강도)도 같이 넣어 둔다(FE 필드표에 이미 있는 자리다).
     */
    /*
     * ⚠️ 여기서 던지면 이 소켓의 메시지 처리가 멎는다. 저장소는 **국내와 같은 것**이라
     * 더더욱 조심한다 — 해외 프레임 하나가 이상해도 국내 쪽에 불똥이 튀면 안 된다.
     */
    try {
      store?.takeExternal("FE", sym, {
        "10": String(last),
        "12": String(Number(cells[off + 14]) || 0),
        "13": String(Number(cells[off + 20]) || 0),
        "228": String(Number(cells[off + 24]) || 0),
      });
    } catch {
      /* 한 프레임을 버린다 — 다음 틱이 곧 온다 */
    }
  }
}

function connect(): void {
  if (!enabled() || ws) return;
  if (Date.now() < retryAt) return;
  state = "연결 중";
  void (async () => {
    try {
      await getApprovalKey();
      const sock = new WebSocket(WS_URL);
      ws = sock;
      sock.onopen = () => {
        state = "연결됨";
        retryMs = 3_000;
        void recordApiCall("hantoo", "ws:HDFSCNT0", "ok");
        resync();
      };
      sock.onmessage = (e) => onText(String(e.data));
      sock.onerror = () => {
        /* onclose 가 뒤따른다 — 여기서는 상태만 */
        state = "끊김";
      };
      sock.onclose = () => {
        state = "끊김";
        ws = null;
        subs.clear();
        /* 열쇠는 끊김과 함께 버린다 — 재발급이 싸고, 만료된 열쇠로 붙으면 조용히 실패한다 */
        approvalKey = "";
        retryAt = Date.now() + retryMs;
        retryMs = Math.min(60_000, retryMs * 2);
      };
    } catch (e) {
      state = "끊김";
      ws = null;
      rejects.unshift(`연결 실패 — ${e instanceof Error ? e.message : String(e)}`);
      rejects.splice(20);
      retryAt = Date.now() + retryMs;
      retryMs = Math.min(60_000, retryMs * 2);
    }
  })();
}

/**
 * **지금 보고 있는 종목들** — 화면이 빠른 시세를 물을 때마다 불린다.
 *
 * 목록이 그대로면 아무 일도 안 한다. 바뀌었으면 구독을 고치고, 소켓이 없으면 붙인다.
 * 미국 장이 아예 안 도는 시간에도 붙여 둔다 — 프리장 04:00 ET 부터 체결이 오고,
 * 그때가 이 기능이 제일 필요한 시간이다.
 */
/**
 * 요청한 목록들 — **덮어쓰지 않고 합친다.**
 *
 * ⚠️ 화면이 하나가 아니다. 관심종목(해외) 페이지와 시황 전광판이 **각자 다른 그룹**으로
 * 같은 창구(`/api/us-watch/fast`)를 3초마다 부른다. 마지막 것으로 갈아치우면 둘이 41자리를
 * 서로 뺏어 3초마다 구독이 뒤집히고, 그때마다 프레임이 끊긴다 — 화면은 「안 바뀐다」가 된다.
 * 그래서 목록마다 마지막으로 물어본 시각을 들고 있다가 **합집합**을 건다. 30초 넘게 안
 * 물어본 목록은 화면이 닫힌 것으로 보고 뺀다.
 */
const asked = new Map<string, { syms: string[]; at: number }>();

export function setUsRealtimeSymbols(symbols: string[]): void {
  if (!enabled()) return;
  /*
   * ⚠️ **한두 종목짜리 요청은 목록으로 삼지 않는다.** 같은 창구를 차트 시트가 **종목 하나**로도
   * 부른다 — 그것까지 자리를 먹으면 표가 밀린다. 목록을 정하는 것은 **표**뿐이다.
   */
  if (symbols.length < 3) return;
  const syms = symbols.map((s) => s.trim().toUpperCase()).filter(Boolean);
  asked.set(syms.join(","), { syms, at: Date.now() });

  /* 오래된 화면은 뺀다 — 3초마다 물어보므로 30초면 닫힌 것이다 */
  const now = Date.now();
  for (const [k, v] of asked) if (now - v.at > 30_000) asked.delete(k);

  /* 최근에 물어본 목록부터 채운다 — 방금 보고 있는 화면이 먼저다 */
  const order = [...asked.values()].sort((a, b) => b.at - a.at);
  const merged: string[] = [];
  for (const g of order) {
    for (const sym of g.syms) {
      if (merged.length >= MAX_SUBS) break;
      if (!merged.includes(sym)) merged.push(sym);
    }
  }
  const same = merged.length === wanted.length && merged.every((s, i) => s === wanted[i]);
  wanted = merged;
  connect();
  if (!same) resync();
}

export function startHantooRealtime(s: RealtimeStore): void {
  store = s;
  if (!enabled()) {
    console.log("[해외실시간] HANTOO_APP_KEY 가 없어 꺼짐");
    return;
  }
  /* 끊기면 다시 붙는다 — 하루 종일 물고 있어야 하므로 끊김이 정상 상태다 */
  setInterval(() => {
    if (wanted.length > 0) connect();
  }, 5_000);
  /* `connect` 는 `retryAt` 을 보므로 「다른 곳이 쓰는 중」이면 10분 뒤에야 다시 시도한다 */
  console.log("[해외실시간] 한투 웹소켓 준비 — 보고 있는 그룹만 최대 41종목");
}

export function hantooRealtimeStatus(): HantooRtStatus {
  return {
    enabled: enabled(),
    state,
    lastFrameAgoSec: lastFrameAt ? Math.round((Date.now() - lastFrameAt) / 1000) : null,
    subscribed: [...subs.values()],
    max: MAX_SUBS,
    frames,
    rejects: [...rejects],
  };
}
