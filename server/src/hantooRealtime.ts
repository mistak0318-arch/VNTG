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
  /** 거절 사유 — 상한 초과 같은 것. 붙는 순간 비운다(옛 기록이 지금 문제로 보이면 안 된다) */
  rejects: string[];
  /** 붙은 지 몇 초 — null 이면 아직 */
  connectedForSec: number | null;
  /**
   * **붙었는데 한 건도 안 왔나** (2026-11-12).
   *
   * `lastFrameAgoSec: null` 만으로는 「아직 안 붙음」과 「붙었는데 조용함」이 구별되지
   * 않아서, 42분째 멎은 소켓이 밖에서 멀쩡해 보였다. 이게 `true` 면 **지금 고장이다.**
   */
  무프레임: boolean;
  /** 조용해서 다시 붙인 횟수 — 늘기만 하면 재접속이 답이 아니라는 뜻이다 */
  조용해서다시붙임: number;
}

let ws: WebSocket | null = null;
let approvalKey = "";
let state: HantooRtStatus["state"] = "꺼짐";
let lastFrameAt = 0;
/**
 * **조용해서 다시 붙인 횟수** (2026-11-12).
 *
 * 다시 붙여도 한투가 애프터 체결을 원래 안 주는 것이라면 이 수만 3분마다 는다 —
 * 그러면 「고쳤다」가 아니라 **다른 데를 봐야 한다**는 뜻이다. 숫자가 그 말을 대신한다.
 */
let silentRevives = 0;
let frames = 0;
const rejects: string[] = [];
/** 지금 걸려 있는 tr_key → 심볼 */
const subs = new Map<string, string>();
/**
 * **상한(41)에 걸려 거절당한 자리** — 다시 걸어 봐야 또 거절이다 (2026-09-08 재검토).
 * 기억하지 않으면 목록이 조금 흔들릴 때마다 같은 거절이 반복된다. 재연결하면 비운다.
 */
const refused = new Set<string>();
/** 화면이 원하는 심볼(대문자) — 순서가 곧 우선순위다 */
let wanted: string[] = [];
let store: RealtimeStore | null = null;
let retryAt = 0;
let retryMs = 3_000;
/** 언제 붙었나 — 「방금 붙었는데 값이 없다」와 「오래 붙었는데 값이 없다」는 다른 이야기다 */
let connectedAt = 0;

/**
 * ⚠️ **앱키당 세션이 하나다.** 그래서 개발 PC 와 미니PC 가 같이 켜면 **먼저 붙은 쪽이 이기고
 * 나머지는 계속 거절**된다(`OPSP8996 ALREADY IN USE appkey`). 실제로 그 일이 났다 —
 * 개발 PC 가 물고 있는 동안 미니PC 화면의 해외 시세가 통째로 멈췄다.
 *
 * 기본은 **켜짐**이다(배포본이 늘 이겨야 한다). 개발 PC 는 제 `.env` 에 `HANTOO_RT=0` 을
 * 적어 끈다 — 그 파일은 깃에 안 올라가므로 배포본에는 영향이 없다.
 */
/** 미국이 도는 시간인가 — 프리 04:00 ~ 애프터 20:00 ET. 그때만 「값이 없다」가 이상한 것이다 */
function usTradingWindow(now = new Date()): boolean {
  const f = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const p = Object.fromEntries(f.formatToParts(now).map((x) => [x.type, x.value]));
  const day = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(String(p.weekday));
  const mins = (Number(p.hour) % 24) * 60 + Number(p.minute);

  /*
   * **주간거래(오버나이트)까지 센다** (2026-11-09 — 벤티지: "프리장 애프터장 값이 이상하더라.
   * 저 시간에 엔비디아 4프로 하락중이었는데 갱신이 안되고 있더라고").
   *
   * 벤티지가 본 때는 한국 11/9(월) 12:42 = **ET 11/8(일) 22:42**, 일요일 밤이다. 화면에는
   * 금요일 종가가 그대로 있었다. 그런데 미국 주간거래는 **일요일 ET 20:00 부터** 돈다 —
   * 이 창은 주말을 통째로 빼고(`day === 0`) 평일도 20:00 에 닫아서, **주간거래 시간이
   * 통째로 창 밖**이었다. 이 함수는 「값이 안 오면 소켓을 다시 붙일까」를 정하므로,
   * 창 밖이면 조용히 멎어도 아무도 되살리지 않는다.
   *
   *   정규장 포함 프리·애프터  평일 04:00 ~ 20:00
   *   주간거래(오버나이트)     일~목 20:00 ~ 이튿날 04:00
   *
   * 금요일 20:00 에 끝나 일요일 20:00 에 다시 열린다 — 토요일 하루만 쉰다.
   */
  const weekday = day >= 1 && day <= 5;
  /* 낮 구간: 평일 04:00~20:00 (프리·정규·애프터) */
  if (weekday && mins >= 4 * 60 && mins < 20 * 60) return true;
  /* 밤 구간(주간거래): 일~목 20:00~24:00 */
  if (day >= 0 && day <= 4 && mins >= 20 * 60) return true;
  /* 밤 구간이 날짜를 넘긴 뒤: 월~금 00:00~04:00 */
  if (weekday && mins < 4 * 60) return true;
  return false;
}

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
    if (subs.has(key) || refused.has(key)) continue;
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
        if (/OPSP0008/.test(j.body?.msg_cd ?? "") && j.header?.tr_key) {
          subs.delete(j.header.tr_key);
          refused.add(j.header.tr_key);
        } else if (j.header?.tr_key) {
          /*
           * (2026-09-10 전수 점검) 그 밖의 거절은 `subs` 에서만 뺀다 — 「걸렸다」로 남아 있으면
           * 다음 `resync` 가 건너뛰어 영영 안 건다. 빼 두면 다음 목록 갱신 때 다시 시도한다.
           */
          subs.delete(j.header.tr_key);
        }
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
     * (2026-09-10 전수 점검) 등락률 부호. 한투 HDFSCNT0 은 [12] SIGN(1 상한·2 상승·3 보합·4 하한·5 하락) ·
     * [13] DIFF · [14] RATE 다. RATE 가 부호 없이 오면 하락 종목이 +로 보인다. 부호 칸이 1~5 로
     * 읽히고 RATE 가 음수가 아닐 때만 부호를 입힌다 — 이미 음수로 오면 그대로 둔다(방어적).
     */
    const sign = String(cells[off + 12] ?? "").trim();
    let rate = Number(cells[off + 14]) || 0;
    if (/^[45]$/.test(sign) && rate > 0) rate = -rate;
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
        "12": String(rate),
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
        /*
         * 붙었으면 **옛 거절 기록을 지운다** (2026-09-08). 스무 줄이 그대로 남아 있어서
         * 벤티지가 상태를 봤을 때 「연결됨」인데 거절이 스무 개라 지금 문제처럼 보였다.
         * 이력은 로그가 아니라 **지금 무엇이 막고 있나**를 말하는 자리다.
         */
        rejects.length = 0;
        refused.clear();
        connectedAt = Date.now();
        lastFrameAt = 0;
        void recordApiCall("hantoo", "ws:HDFSCNT0", "ok");
        resync();
      };
      sock.onmessage = (e) => onText(String(e.data));
      sock.onerror = () => {
        /* onclose 가 뒤따른다 — 여기서는 상태만. (2026-09-10 전수 점검) 「다른 곳이 쓰는 중」은 덮지 않는다 */
        if (state !== "다른 곳이 쓰는 중") state = "끊김";
      };
      sock.onclose = () => {
        /*
         * (2026-09-10 전수 점검) OPSP8996 이 잡아 둔 45초 대기와 상태 글자를 여기서 짧게·「끊김」으로
         * 덮어쓰고 있었다 — 닫힌 직후 3초 만에 다시 붙어 거절 로그만 쌓였다. 더 긴 쪽을 쓴다.
         */
        if (state !== "다른 곳이 쓰는 중") state = "끊김";
        ws = null;
        subs.clear();
        /* 열쇠는 끊김과 함께 버린다 — 재발급이 싸고, 만료된 열쇠로 붙으면 조용히 실패한다 */
        approvalKey = "";
        retryAt = Math.max(retryAt, Date.now() + retryMs);
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
  wanted = merged;
  connect();
  /*
   * (2026-09-10 전수 점검) 목록이 그대로여도 `resync` 를 부른다 — 멱등이라 걸린 것과 같으면 아무것도
   * 안 보낸다. 거절돼서 `subs` 에서 빠진 자리는 이 호출이 다시 건다. 예전엔 목록이 안 바뀌면 영영 안 걸었다.
   */
  resync();
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
    /*
     * **좀비 연결 감시** (2026-09-08 재검토). TCP 는 살아 있는데 한투가 조용해지면
     * `onclose` 가 안 오고 우리는 영영 기다린다 — 소켓은 「연결됨」인데 값만 안 오는,
     * 이 프로젝트가 제일 무서워하는 조용한 실패다. 미국이 도는 시간(프리 04:00 ~ 애프터
     * 20:00 ET)에 구독이 있는데 **3분 넘게 프레임이 없으면** 끊고 다시 붙는다.
     * 거래가 뜸한 종목만 담긴 그룹일 수도 있으니 3분은 넉넉하게 잡았다.
     */
    /*
     * ⚠️ **붙은 뒤 한 건도 못 받은 경우가 빠져 있었다** (2026-11-12 — 벤티지: "장 시작하면
     * 해외주식 소켓 닫혀?? 안보이네 애프터장 시세").
     *
     * 조건에 `lastFrameAt > 0` 이 있었는데, `onopen` 이 붙을 때마다 그 값을 **0 으로
     * 리셋**한다. 그래서 「붙었지만 프레임이 한 건도 안 오는」 상태는 **감시 대상에서
     * 통째로 빠졌다** — 이 감시자가 막으려던 바로 그 조용한 실패인데.
     *
     * 실측(2026-11-12 09:45, ET 19:23 애프터장):
     *   state 연결됨 · subscribed 20 · connectedForSec 2560 · lastFrameAgoSec **null**
     * 42분째 한 건도 없는데 아무도 안 깨웠다. 화면은 정규장 종가에 「시간외」 딱지만
     * 붙은 채였다.
     *
     * 이제 **프레임이 없으면 붙은 시각부터** 잰다. 붙자마자 조용한 것도 조용한 것이다.
     */
    const 조용한지 = lastFrameAt > 0 ? Date.now() - lastFrameAt : connectedAt ? Date.now() - connectedAt : 0;
    if (state === "연결됨" && subs.size > 0 && usTradingWindow() && 조용한지 > 3 * 60_000) {
      rejects.unshift(
        lastFrameAt > 0
          ? `프레임이 ${Math.round(조용한지 / 1000)}초째 없어 다시 붙는다`
          : `붙은 지 ${Math.round(조용한지 / 1000)}초인데 **한 건도** 안 와서 다시 붙는다`,
      );
      rejects.splice(20);
      silentRevives += 1;
      try {
        ws?.close();
      } catch {
        /* 이미 닫히는 중일 수 있다 */
      }
    }
  }, 5_000);
  /* `connect` 는 `retryAt` 을 보므로 「다른 곳이 쓰는 중」이면 10분 뒤에야 다시 시도한다 */
  console.log("[해외실시간] 한투 웹소켓 준비 — 보고 있는 그룹만 최대 41종목");
}

export function hantooRealtimeStatus(): HantooRtStatus {
  return {
    enabled: enabled(),
    state,
    lastFrameAgoSec: lastFrameAt ? Math.round((Date.now() - lastFrameAt) / 1000) : null,
    /*
     * **붙은 뒤 한 건도 못 받았나** (2026-11-12). `lastFrameAgoSec: null` 은 「모름」처럼
     * 읽혀서, 42분째 아무것도 안 오는 상태를 밖에서 알아볼 길이 없었다. 그 경우를
     * 이름으로 적는다.
     */
    무프레임: lastFrameAt === 0 && state === "연결됨",
    조용해서다시붙임: silentRevives,
    subscribed: [...subs.values()],
    max: MAX_SUBS,
    frames,
    rejects: [...rejects],
    connectedForSec: connectedAt ? Math.round((Date.now() - connectedAt) / 1000) : null,
  };
}
