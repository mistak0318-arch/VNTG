import { noteFetchFailure } from "./authGuard";
import { markNeedLogin } from "./loginState";

export type RawRecord = Record<string, unknown>;

/**
 * 모든 요청이 지나는 자리.
 *
 * 요청이 **네트워크 단계에서** 실패하면(=`TypeError`) 인증이 끊겼는지 한 번 확인한다.
 * 밖에서 접속할 때 Cloudflare Access 세션이 끝나면 요청이 로그인 페이지로
 * 리다이렉트되는데, 브라우저가 그걸 CORS 로 막아 여기까지는 그냥 「실패」로 온다.
 * 각 화면이 그 실패를 조용히 삼키면 **아무 말 없는 빈 칸**만 남는다.
 *
 * 그리고 **우리 서버가 401 을 주면** 로그인 칸을 올린다(2026-08-29). 세션은 화면을
 * 보고 있는 도중에도 끝나므로, 그때 데이터를 부르던 화면이 401 을 받는다.
 * 여기 한 곳만 보면 되는 게 이 함수를 지나지 않는 요청이 없기 때문이다.
 */
async function req(path: string, init?: RequestInit): Promise<Response> {
  try {
    const res = await fetch(path, init);
    /* 로그인 창구 자체의 401(비밀번호가 틀림)은 신호가 아니다 — 이미 로그인 칸 안이다 */
    if (res.status === 401 && !path.startsWith("/api/auth/")) markNeedLogin();
    return res;
  } catch (e) {
    noteFetchFailure();
    throw e;
  }
}

async function getJson<T = RawRecord>(path: string): Promise<T> {
  const res = await req(path);
  const body = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    const message = (body as { error?: string }).error ?? `요청 실패 (${res.status})`;
    throw new Error(message);
  }
  return body;
}

async function postJson<T = RawRecord>(path: string, body?: unknown): Promise<T> {
  const res = await req(path, {
    method: "POST",
    ...(body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  }
  return parsed;
}

async function patchJson<T = RawRecord>(path: string, body?: unknown): Promise<T> {
  const res = await req(path, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return parsed;
}

async function putJson<T = RawRecord>(path: string, body?: unknown): Promise<T> {
  const res = await req(path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  return parsed;
}

async function deleteJson<T = RawRecord>(path: string): Promise<T> {
  const res = await req(path, { method: "DELETE" });
  const parsed = (await res.json()) as T & { error?: string };
  if (!res.ok) {
    throw new Error((parsed as { error?: string }).error ?? `요청 실패 (${res.status})`);
  }
  return parsed;
}

export interface StockSearchResult {
  code: string;
  name: string;
  marketName: string;
}

export type FlowSubject = "foreign" | "inst" | "mainInst" | "combined" | "foreignMain";

export const FLOW_SUBJECTS: { key: FlowSubject; label: string; short: string }[] = [
  { key: "combined", label: "합산(외국인+기관)", short: "합산" },
  { key: "foreign", label: "외국인", short: "외국인" },
  { key: "inst", label: "기관계", short: "기관" },
  { key: "mainInst", label: "메인기관(투신+연기금+사모)", short: "메인기관" },
  { key: "foreignMain", label: "외국인+메인기관", short: "외인+메인" },
];

export interface AlgoConfig {
  candidateSort: "1" | "2" | "3";
  topN: number;
  periods: number[];
  maPeriods: number[];
  requirePriceAboveMa: boolean;
  minChangeRate: number | null;
  maxChangeRate: number | null;
  minPrice: number | null;
  maxPrice: number | null;
}

export interface AlgoResult {
  code: string;
  name: string;
  market: "코스피" | "코스닥";
  curPrc: number;
  fluRt: number;
  net: Record<FlowSubject, Record<string, number>>;
  pass: Record<FlowSubject, boolean>;
  trendPass: boolean | null;
  ma: Record<string, number> | null;
}

export interface AlgoJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  results: AlgoResult[];
  error?: string;
  config: AlgoConfig;
  usedPreviousDay: boolean;
}

/* ── 로그인 (2026-08-29) ─────────────────────────────────────────────────── */

export type OtpMethod = "email" | "totp";

export interface AuthState {
  enabled: boolean;
  authed: boolean;
  knownDevice: boolean;
  mailReady: boolean;
  otpForNewDevice: boolean;
  otpMethod: OtpMethod;
  username: string;
}

/** 서버가 어디까지 열려 있나 — 설정 화면의 「문단속」 칸 */
export interface DoorState {
  corsRestricted: boolean;
  corsOrigins: string[];
  loopbackOnly: boolean;
  bindHost: string;
}

export interface AuthDevice {
  id: string;
  name: string;
  ua: string;
  addedAt: string;
  lastSeenAt: string;
  current: boolean;
}

export interface AuthConfigView {
  enabled: boolean;
  username: string;
  hasPassword: boolean;
  isFirstPassword: boolean;
  sessionHours: number;
  otpForNewDevice: boolean;
  otpMethod: OtpMethod;
  totpReady: boolean;
  mailReady: boolean;
  mailTo: string;
  devices: AuthDevice[];
  door: DoorState;
}

/** 비밀번호가 맞았지만 처음 보는 기기라 6자리를 더 받아야 하는 상태 */
export interface LoginNeedsOtp {
  ok: false;
  otpRequired: true;
  method: OtpMethod;
  ticket: string;
  /** 어디로 보냈는지 — 가려서 보여 준다 */
  sentTo: string;
}

/* ── 지금 시장의 화제 (2026-08-30) ──────────────────────────────────────── */

export type PulseWindow = "overnight" | "now" | "today";

export interface PulseItem {
  term: string;
  kind: string;
  /** 어디서 떴나 — 양쪽이 제일 값지다 */
  where: "both" | "channel" | "news";
  buzzCount: number;
  newsCount: number;
  /** 몇 개 방 / 몇 개 매체 */
  sources: number;
  score: number;
  buzzRatio: number;
  newsRatio: number;
  fresh: boolean;
  codes: string[];
  quote: string | null;
  quoteFrom: string | null;
}

export interface TopicPulse {
  window: PulseWindow;
  hours: number;
  /** 「지금 무슨 일인가」 한 문장 */
  headline: string;
  /** 그 문장의 근거 */
  detail: string;
  hot: boolean;
  items: PulseItem[];
  health: {
    channelReady: boolean;
    newsReady: boolean;
    baselineDays: number;
    channelTotal: number;
    newsArticles: number;
  };
  at: string;
}

/* ── 버즈·키워드 알고리즘 설정 (2026-08-30) ─────────────────────────────── */

/** 실시간 연결 상태 (2026-08-31) — 「연결됨인데 값이 안 온다」를 눈으로 보려고 */
export interface RealtimeStatus {
  enabled: boolean;
  state: string;
  healthy: boolean;
  lastSeen: string | null;
  subscribed: number;
  keys: number;
  regErrors: { at: string; code: number; msg: string }[];
}
export interface RealtimeStoreInfo {
  day: string;
  keys: number;
  points: number;
  pending: number;
  types: Record<string, number>;
}

/** 데이터 보관 현황 (2026-08-31) */
export interface DataCatStat {
  key: string;
  label: string;
  what: string;
  kind: "daily" | "append" | "single";
  bytes: number;
  files: number;
  oldest: string | null;
  newest: string | null;
  keepDays: number | null;
  defaultKeep: number | null;
  byAge: { d7: number; d30: number; d90: number; d365: number; older: number };
  /** 지금 설정대로 자르면 빠질 용량 */
  prunable: number;
  perDay: number;
}
export interface DataReport {
  dir: string;
  cats: DataCatStat[];
  otherBytes: number;
  totalBytes: number;
  prunableBytes: number;
  disk: { free: number; total: number } | null;
}

/** 네이버에서 스스로 긁어오는 일들 (2026-08-30) */
export interface NaverSyncJob {
  key: string;
  label: string;
  what: string;
  when: string;
  /** 「몇 분마다」가 뜻이 있는 일인가 — 아니면 주기 칸을 안 보여 준다 */
  periodic: boolean;
}
export interface NaverSyncConfig {
  jobs: NaverSyncJob[];
  off: string[];
  periodMin: Record<string, number | undefined>;
  state: Record<string, { at?: string; msg?: string; ok?: boolean } | undefined>;
}

export interface BuzzConfig {
  zMin: number;
  minCount: number;
  fullSources: number;
  singleSourcePenalty: number;
  buzzWindowHours: number;
  baselineDays: number;
  timeOfDay: boolean;
}

/* ── 버즈 대시보드 (2026-08-30) ─────────────────────────────────────────── */

export type BuzzKind = "theme" | "myTheme" | "stock" | "event" | "entity";

export interface BuzzBoardRow {
  term: string;
  kind: BuzzKind;
  recent: number;
  baseline: number;
  ratio: number;
  /** 몇 개의 방에서 나왔나 — 한 방이 떠드는 것과 여러 방이 말하는 것은 다르다 */
  channels: number;
  /** 뜻밖의 정도 — (지금−평소)/√(평소+1). 정렬과 판정의 기준 */
  z: number;
  /** 채널 서명으로 판정해 깎은 몫(0~1) — 0.8 이면 언급의 80%가 그 방들의 버릇이었다 */
  boilerplate: number;
  /** 알림 문턱을 넘었나 */
  alerted: boolean;
  codes: string[];
}

export interface BuzzBoard {
  windowHours: number;
  baselineDays: number;
  rows: BuzzBoardRow[];
  total: number;
  byHour: { hour: number; count: number }[];
  threshold: { minCount: number; minRatio: number; sharpCount: number; sharpRatio: number };
  reader: boolean;
  at: string;
}

export interface BuzzTermDetail {
  term: string;
  kind: BuzzKind | null;
  codes: string[];
  hourly: { at: string; count: number }[];
  daily: { day: string; count: number }[];
  channels: { name: string; count: number }[];
  /** full — 주요 채널 아카이브에서 전문을 찾아 바꿔 넣은 것 (2026-08-31) */
  samples: { at: string; channel: string; text: string; link: string; full?: boolean }[];
}

/* ── 뉴스 키워드 흐름 (2026-08-30) ──────────────────────────────────────── */

export type KeywordKind = "theme" | "myTheme" | "stock" | "event" | "entity" | "new";

export interface KeywordHit {
  term: string;
  kind: KeywordKind;
  /** 고른 창 안의 언급 수 */
  recent: number;
  /** 같은 길이의 평소 언급 수 */
  baseline: number;
  /** recent / baseline — **이 값이 이 화면의 요점**이다 */
  ratio: number;
  /** 기준선이 사실상 0이었나 — 처음 보는 말 */
  fresh: boolean;
  codes: string[];
  /** inTitle — 제목에서 걸렸나 (2026-08-31) */
  samples: { title: string; link: string; press: string; at: string; inTitle?: boolean }[];
  /** 종목 낱말이면 지금 등락률 — 이미 오른 뒤인지 */
  changeRate?: number;
  /** 몇 개 매체가 썼나 — 한 매체가 열 번 쓴 것과 열 매체가 한 번씩은 다르다 */
  presses: number;
  /** 뜻밖의 정도 — (지금−평소)/√(평소+1) */
  z: number;
  /** 텔레그램 채널에서도 급증했나. null = 채널 쪽이 아직 판단할 수 없음 */
  buzzRatio: number | null;
}

export interface KeywordFlow {
  windowMin: number;
  articles: number;
  hits: KeywordHit[];
  baselineDays: number;
  timeline: { minute: string; count: number }[];
  buzzReady: boolean;
  updatedAt: string;
}

export const api = {
  health: () => getJson<{ ok: boolean }>("/api/health"),

  /* 버즈 대시보드 (2026-08-30) — 문턱과 무관하게 전부 본다 */
  /** 네 브리핑 화면이 같은 문장을 쓰게 하는 자리 */
  topicPulse: (w: PulseWindow) => getJson<TopicPulse>(`/api/signal/topic-pulse?window=${w}`),

  buzzConfig: () => getJson<BuzzConfig>("/api/signal/buzz/config"),
  buzzConfigSave: (patch: Partial<BuzzConfig>) =>
    putJson<BuzzConfig>("/api/signal/buzz/config", patch),

  buzzBoard: (hours: number) => getJson<BuzzBoard>(`/api/signal/buzz/board?hours=${hours}`),
  buzzTerm: (term: string) =>
    getJson<BuzzTermDetail>(`/api/signal/buzz/term/${encodeURIComponent(term)}`),

  keywordFlow: (windowMin: number) =>
    getJson<KeywordFlow>(`/api/news-keywords/flow?window=${windowMin}`),
  keywordCollect: () =>
    postJson<{ articles: number; terms: number }>("/api/news-keywords/collect"),

  realtimeStatus: () => getJson<RealtimeStatus>("/api/realtime/status"),
  realtimeStoreInfo: () => getJson<RealtimeStoreInfo>("/api/realtime/store"),

  dataReport: () => getJson<DataReport>("/api/data"),
  dataKeep: (key: string, days: number | null) =>
    postJson<DataReport>(`/api/data/${key}/keep`, { days }),
  dataPrune: () =>
    postJson<{ removed: number; bytes: number; report: DataReport }>("/api/data/prune"),

  naverSync: () => getJson<NaverSyncConfig>("/api/naver-sync"),
  naverSyncEnable: (key: string, on: boolean) =>
    postJson<NaverSyncConfig>(`/api/naver-sync/${key}/enabled`, { on }),
  naverSyncPeriod: (key: string, min: number | null) =>
    postJson<NaverSyncConfig>(`/api/naver-sync/${key}/period`, { min }),
  naverSyncRun: (key: string) =>
    postJson<{ ok: boolean; msg: string; config: NaverSyncConfig }>(
      `/api/naver-sync/${key}/run`,
    ),

  authState: () => getJson<AuthState>("/api/auth/state"),
  /**
   * 로그인. 던지지 않고 **결과를 돌려준다** — 「비밀번호가 틀렸다」는 예외가 아니라
   * 정상적인 답이고, 화면은 그걸 칸 아래에 적어야지 오류로 터뜨리면 안 된다.
   */
  login: async (
    username: string,
    password: string,
  ): Promise<{ ok: true } | LoginNeedsOtp | { ok: false; error: string }> => {
    const res = await req("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    });
    return (await res.json()) as { ok: true } | LoginNeedsOtp | { ok: false; error: string };
  },
  loginOtp: async (
    ticket: string,
    code: string,
    deviceName: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const res = await req("/api/auth/otp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, code, deviceName }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  },
  logout: () => postJson<{ ok: boolean }>("/api/auth/logout"),

  /* 비밀번호 찾기 — 이 둘도 던지지 않고 결과를 돌려준다(로그인 칸 안에서 쓴다) */
  authForgot: async (): Promise<{
    ok: boolean;
    ticket?: string;
    sentTo?: string;
    error?: string;
  }> => {
    const res = await req("/api/auth/forgot", { method: "POST" });
    return (await res.json()) as { ok: boolean; ticket?: string; sentTo?: string; error?: string };
  },
  authReset: async (
    ticket: string,
    code: string,
    next: string,
  ): Promise<{ ok: boolean; error?: string }> => {
    const res = await req("/api/auth/reset", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket, code, next }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  },

  authConfig: () => getJson<AuthConfigView>("/api/auth/config"),
  authSetPassword: (current: string, next: string) =>
    postJson<{ ok: boolean }>("/api/auth/password", { current, next }),
  authSetUsername: (username: string) =>
    postJson<AuthConfigView>("/api/auth/username", { username }),
  authEnable: (on: boolean) => postJson<{ ok: boolean }>("/api/auth/enable", { on }),
  authOptions: (o: { sessionHours?: number; otpForNewDevice?: boolean; otpMethod?: OtpMethod }) =>
    putJson<AuthConfigView>("/api/auth/options", o),
  authRemoveDevice: (id: string) =>
    deleteJson<AuthConfigView>(`/api/auth/device/${encodeURIComponent(id)}`),
  authRevokeAll: () => postJson<{ ok: boolean }>("/api/auth/revoke-all"),

  /* 구글 OTP 등록 — begin 으로 키를 받아 앱에 넣고, confirm 으로 확인해야 켜진다 */
  authTotpBegin: () => postJson<{ secret: string; uri: string }>("/api/auth/totp/begin"),
  authTotpConfirm: (code: string) => postJson<AuthConfigView>("/api/auth/totp/confirm", { code }),
  authTotpClear: () => deleteJson<AuthConfigView>("/api/auth/totp"),
  authTotpNow: () => getJson<{ code: string }>("/api/auth/totp/now"),
  accountSummary: () => getJson("/api/account/summary"),
  accountDeposit: () => getJson("/api/account/deposit"),
  holdings: () => getJson("/api/account/holdings"),
  /** 보유 집중도 — 업종·내 테마별 비중 (2026-08-27) */
  accountConcentration: () =>
    getJson<{
      total: number;
      stocks: {
        code: string;
        name: string;
        value: number;
        weight: number;
        sector: string;
        themes: string[];
      }[];
      bySector: { name: string; value: number; count: number; weight: number }[];
      byTheme: { name: string; value: number; count: number; weight: number }[];
    }>("/api/account/concentration"),
  manualBrokers: () => getJson<{ brokers: string[] }>("/api/account/manual/brokers"),
  manualAccounts: () => getJson<{ accounts: EvaluatedAccount[] }>("/api/account/manual"),
  manualAccountAdd: (broker: string, name: string) =>
    postJson<{ accounts: EvaluatedAccount[] }>("/api/account/manual", { broker, name }),
  manualAccountRemove: (id: string) =>
    deleteJson<{ accounts: EvaluatedAccount[] }>(`/api/account/manual/${id}`),
  manualAccountCash: (id: string, cash: number) =>
    putJson<{ accounts: EvaluatedAccount[] }>(`/api/account/manual/${id}/cash`, { cash }),
  manualHoldingAdd: (id: string, h: { code: string; name: string; avgPrice: number; qty: number }) =>
    postJson<{ accounts: EvaluatedAccount[] }>(`/api/account/manual/${id}/holdings`, h),
  manualHoldingRemove: (id: string, code: string) =>
    deleteJson<{ accounts: EvaluatedAccount[] }>(`/api/account/manual/${id}/holdings/${code}`),
  /** 코스피200 선물 투자자별 순매수(계약) — 네이버. 키움엔 없는 값 */
  futuresFlow: (days = 30) =>
    getJson<{ days: { date: string; individual: number; foreign: number; institution: number }[] }>(
      `/api/market/futures-flow?days=${days}`,
    ),
  /** ETF 구성종목 — ETF 가 아니면 {etf:false}. 구성은 네이버, 과세·NAV·추적오차는 키움 병합 */
  etfInfo: (code: string) =>
    getJson<{
      etf: boolean;
      name?: string;
      issuer?: string;
      baseIndex?: string;
      fee?: number | null;
      nav?: number | null;
      deviation?: number | null;
      /** "비과세" | "보유기간과세" — 키움 ka40002. 퇴직연금 세금 판단용 */
      taxType?: string;
      /** 추적오차율(%) — 키움 ka40004 */
      traceErr?: number | null;
      constituents?: { code: string; name: string; weight: number | null }[];
      sectors?: { name: string; weight: number }[];
    }>(`/api/market/etf/${code}`),
  /** ETF 전체 시세 — ka40004, 서버 3분 캐시. 괴리율은 서버가 (현재가−NAV)/NAV 로 계산 */
  etfList: () => getJson<{ rows: EtfListRow[]; at: number }>("/api/etf/list"),
  /** 이 종목을 담은 ETF — 서버 역인덱스(파일)를 읽는다. 조회 0회 */
  etfHolders: (code: string) =>
    getJson<{ holders: EtfHolder[]; builtAt: string; scanned: number }>(`/api/etf/holders/${code}`),
  /* VNTG 방 뷰어 (2026-08-27) — 봇이 보낸 방들을 브라우저에서 텔레그램처럼 */
  tgRooms: () => getJson<{ rooms: TgRoom[] }>("/api/tg-feed/rooms"),
  tgRoom: (ch: string, limit = 120) =>
    getJson<{ channel: string; label: string; messages: TgMsg[]; readAt: string }>(
      `/api/tg-feed/room/${ch}?limit=${limit}`,
    ),
  tgRoomRead: (ch: string) => postJson<{ ok: boolean }>(`/api/tg-feed/room/${ch}/read`, {}),
  tgStar: (channel: string, m: TgMsg) =>
    postJson<{ starred: boolean }>("/api/tg-feed/star", { channel, ...m }),
  tgStars: () => getJson<{ stars: TgStar[] }>("/api/tg-feed/stars"),
  /** 슈퍼신호등 배지용 — 마지막 수집일 + 당일 상승/하락 수 + 추적 종목 목록(가벼움) */
  signalSuperStatus: () =>
    getJson<{
      lastRunDate: string | null;
      up: number | null;
      down: number | null;
      stocks: { code: string; name: string }[];
    }>("/api/signal/super/status"),
  /** 데일리 리포트 최신 발행분 — 사이드바 N 배지용 */
  reportStatus: () => getJson<{ latest: string | null }>("/api/report/status"),
  /** 알림 점검 — 갈래별 켜짐·방·마지막 발송 (2026-08-27) */
  alertHealth: () => getJson<AlertHealth>("/api/settings/alert-health"),
  /** 밤사이 버즈 — 채널 언급 급증 (장전 브리핑룸) */
  buzz: () =>
    getJson<{
      hits: {
        term: string;
        kind: "theme" | "myTheme" | "stock" | "event" | "entity";
        recent: number;
        baseline: number;
        ratio: number;
        codes: string[];
        samples: { at: string; channel: string; text: string; link: string }[];
      }[];
      baselineDays: number;
      topToday: { term: string; kind: string; recent: number }[];
      /** 문턱에 못 미친 것들 — 「왜 안 오나」의 답 (2026-08-30) */
      nearMiss?: {
        term: string;
        kind: string;
        recent: number;
        baseline: number;
        ratio: number;
      }[];
      /** 지금 걸려 있는 문턱 */
      threshold?: {
        minCount: number;
        minRatio: number;
        sharpCount: number;
        sharpRatio: number;
      };
      windowHours: number;
      at: string;
      /** 살아 있나 — 「안 온다」가 고장인지 조용한 것인지 (2026-08-27) */
      health?: {
        reader: boolean;
        todayCount: number;
        days: number;
        lastCollect: string | null;
        needDays: number;
      };
    }>("/api/signal/buzz"),
  /** 호가창 — 종목 상세·종목분석이 같은 것을 쓴다 */
  /** 거래원 — 부를 때마다 시계열이 한 점씩 쌓인다 */
  /** 종목별 프로그램매매 (일자별) — 단위 백만원 */
  programTradesByStock: (code: string) => getJson<RawRecord>(`/api/market/program/${code}`),
  brokerFlow: (code: string) => getJson<BrokerFlow>(`/api/market/broker-flow/${code}`),
  orderBook: (code: string) => getJson<OrderBook>(`/api/market/orderbook/${code}`),
  stockInfo: (code: string) => getJson(`/api/market/info/${code}`),
  quote: (code: string) => getJson(`/api/market/quote/${code}`),
  dailyChart: (code: string) => getJson(`/api/market/chart/daily/${code}`),
  /** 체결금액대별 매매비중 — 소액이 사고 고액이 팔면 개인이 받는 중이다 */
  tradeSize: (code: string) =>
    getJson<{ rows: TradeSizeRow[] }>(`/api/market/trade-size/${code}`),
  opinion: (code: string) => getJson<OpinionSummary>(`/api/market/opinion/${code}`),
  weeklyChart: (code: string) => getJson(`/api/market/chart/weekly/${code}`),
  monthlyChart: (code: string) => getJson(`/api/market/chart/monthly/${code}`),
  minuteChart: (code: string, tic: string) =>
    getJson(`/api/market/chart/minute/${code}?tic_scope=${tic}`),
  /** days 를 주면 그만큼 채울 때까지 연속조회한다 (한 번 = 100줄, 2026-08-31) */
  investorChart: (code: string, days?: number) =>
    getJson(`/api/market/chart/investor/${code}${days ? `?days=${days}` : ""}`),
  broker: (code: string) => getJson(`/api/market/broker/${code}`),
  snapshot: (code: string) => getJson(`/api/market/snapshot/${code}`),
  credit: (code: string) => getJson(`/api/market/credit/${code}`),
  dailyDetail: (code: string, days = 30) => getJson(`/api/market/daily-detail/${code}?days=${days}`),
  strength: (code: string, mode: "time" | "daily") =>
    getJson(`/api/market/strength/${code}?mode=${mode}`),
  investorDaily: (code: string) => getJson(`/api/market/investor-daily/${code}`),
  programTrend: (code: string) => getJson(`/api/market/program/${code}`),
  sectorMood: (code: string) => getJson<MoodResult>(`/api/market/sector-mood/${code}`),
  foreignTrend: (code: string) => getJson(`/api/market/foreign/${code}`),
  shortSale: (code: string, days = 60) => getJson(`/api/market/shortsale/${code}?days=${days}`),
  stockLending: (code: string, days = 60) => getJson(`/api/market/lending/${code}?days=${days}`),
  searchStocks: (q: string) =>
    getJson<{ results: StockSearchResult[] }>(`/api/market/search?q=${encodeURIComponent(q)}`),
  volumeRanking: (market: string, sort: string) => getJson(`/api/ranking/volume?market=${market}&sort=${sort}`),
  sameNetTradeRanking: (market: string, trade: string) =>
    getJson(`/api/ranking/same-net-trade?market=${market}&trade=${trade}`),
  continuousTradeRanking: (market: string, days: string) =>
    getJson(`/api/ranking/continuous-trade?market=${market}&days=${days}`),
  algoConfigDefault: () => getJson<AlgoConfig>("/api/algo/config/default"),
  algoScanStart: (config: AlgoConfig) =>
    postJson<{ jobId: string; config: AlgoConfig }>("/api/algo/scan/start", config),
  algoScanStatus: (jobId: string) => getJson<AlgoJob>(`/api/algo/scan/status/${jobId}`),
  marketStatus: () => getJson<MarketStatus>("/api/overview/status"),
  overviewSection: <T>(name: string) => getJson<SectionResult<T>>(`/api/overview/section/${name}`),
  indexDetail: (code: string, range: IndexRange) =>
    getJson<IndexDetailData>(`/api/overview/index/${code}?range=${range}`),
  flowIntraday: (date?: string) =>
    getJson<{ day: FlowIntradayDay | null; dates: string[] }>(
      `/api/overview/flow-intraday${date ? `?date=${date}` : ""}`,
    ),
  watchlist: () => getJson<{ items: WatchItem[] }>("/api/watchlist"),
  watchGroups: () => getJson<{ groups: string[] }>("/api/watchlist/groups"),
  watchGroupAdd: (name: string) => postJson<{ groups: string[] }>("/api/watchlist/groups", { name }),
  watchGroupRename: (from: string, name: string) =>
    patchJson<{ groups: string[] }>(`/api/watchlist/groups/${encodeURIComponent(from)}`, { name }),
  /** 그룹 안 종목 순서 — 보이는 순서를 통째로 보낸다 */
  watchReorder: (group: string, codes: string[]) =>
    putJson<{ items: unknown[] }>("/api/watchlist/reorder", { group, codes }),
  /** 구분선 한 줄 넣기 */
  watchAddDivider: (group: string, label = "") =>
    postJson<{ items: unknown[] }>("/api/watchlist/divider", { group, label }),
  watchGroupReorder: (order: string[]) =>
    putJson<{ groups: string[] }>("/api/watchlist/groups/reorder", { order }),
  watchGroupRemove: (name: string) =>
    deleteJson<{ groups: string[] }>(`/api/watchlist/groups/${encodeURIComponent(name)}`),
  watchlistAdd: (item: {
    code: string;
    name: string;
    addedPrice: number;
    memo?: string;
    group?: string;
    /** 한 종목을 여러 그룹에 담을 수 있다 */
    groups?: string[];
  }) => postJson<{ items: WatchItem[] }>("/api/watchlist", item),
  /** 그룹 하나를 넣거나 뺀다 — 표에서 칩을 눌러 토글 */
  watchGroupToggle: (code: string, group: string) =>
    postJson<{ items: WatchItem[] }>(
      `/api/watchlist/${code}/groups/${encodeURIComponent(group)}`,
    ),
  watchlistSetGroup: (code: string, group: string) =>
    patchJson<{ items: WatchItem[] }>(`/api/watchlist/${code}`, { group }),
  watchStatuses: () =>
    getJson<{ statuses: { key: WatchStatus; label: string; hint: string }[] }>(
      "/api/watchlist/statuses",
    ),
  /** 섹터 집중도 — 관심·보유가 어느 업종에 쏠렸나 */
  watchConcentration: () =>
    getJson<{
      all: { total: number; top: { sector: string; count: number; pct: number }[] };
      holding: { total: number; top: { sector: string; count: number; pct: number }[] };
    }>("/api/watchlist/concentration"),
  /** 관찰/대기/보유/청산 — 그룹(성격)과 **다른 축**이다 */
  watchlistSetStatus: (code: string, status: WatchStatus) =>
    patchJson<{ items: WatchItem[] }>(`/api/watchlist/${code}`, { status }),
  watchlistRemove: (code: string) => deleteJson<{ items: WatchItem[] }>(`/api/watchlist/${code}`),
  /**
   * **일괄 처리** (2026-09-01) — 42종목을 하나씩 부르면 요청이 42번 나가고,
   * 중간에 실패하면 어디까지 됐는지도 모른다. 한 번에 보내고 결과를 받는다.
   *
   * `done`/`failed` 로 갈라 오므로 화면이 「40개만 됐다」를 말할 수 있다.
   */
  watchlistBulk: (codes: string[], action: "remove" | "group" | "status", group?: string, status?: string) =>
    postJson<{ done: string[]; failed: string[]; items: WatchItem[] }>("/api/watchlist/bulk", {
      codes,
      action,
      group,
      status,
    }),
  watchlistTracking: (force = false) =>
    getJson<{ items: TrackedStock[] }>(`/api/watchlist/tracking${force ? "?force=1" : ""}`),
  kiwoomGroups: () => getJson<{ groups: KiwoomGroup[] }>("/api/watchlist/kiwoom/groups"),
  kiwoomGroupStocks: (code: string) =>
    getJson<{ items: KiwoomGroupStock[] }>(`/api/watchlist/kiwoom/groups/${code}`),
  channels: () =>
    getJson<{ configured: boolean; channels: ChannelEntry[] }>("/api/channels"),
  channelsRefresh: () => postJson<{ channels: ChannelEntry[] }>("/api/channels/refresh"),
  channelsSetEnabled: (updates: { id: string; enabled: boolean }[]) =>
    putJson<{ channels: ChannelEntry[] }>("/api/channels/enabled", { updates }),
  /* 주요 채널 (2026-08-27) — 골라 둔 채널의 글을 빠짐없이 원문 그대로 */
  channelsSetMajor: (updates: { id: string; major: boolean }[]) =>
    putJson<{ channels: ChannelEntry[] }>("/api/channels/major", { updates }),
  majorRooms: () => getJson<{ rooms: MajorRoom[] }>("/api/channels/major-rooms"),
  majorRoom: (id: string, limit = 200) =>
    getJson<{ name: string; messages: MajorMsg[]; readAt: string }>(
      `/api/channels/major-room/${encodeURIComponent(id)}?limit=${limit}`,
    ),
  majorRoomRead: (id: string) =>
    postJson<{ ok: boolean }>(`/api/channels/major-room/${encodeURIComponent(id)}/read`, {}),
  channelsReportStatus: (jobId: string) => getJson<PublishJob>(`/api/channels/report/${jobId}`),
  /** 끝날 때까지 기다리는 옛 방식 — 진행 표시가 필요 없는 짧은 확인용 */
  channelsReportSync: (o: { ai?: boolean; send?: boolean; minutes?: number } = {}) => {
    const q = new URLSearchParams();
    if (o.ai === false) q.set("ai", "0");
    if (o.send) q.set("send", "1");
    if (o.minutes) q.set("minutes", String(o.minutes));
    return postJson<ChannelReport>(`/api/channels/report-sync${q.toString() ? "?" + q : ""}`);
  },
  /** 곧바로 jobId 를 돌려준다. 진행은 channelsReportStatus 로 폴링 */
  channelsReport: (o: { ai?: boolean; send?: boolean; minutes?: number } = {}) => {
    const q = new URLSearchParams();
    if (o.ai === false) q.set("ai", "0");
    if (o.send) q.set("send", "1");
    if (o.minutes) q.set("minutes", String(o.minutes));
    return postJson<{ jobId: string }>(`/api/channels/report${q.toString() ? "?" + q : ""}`);
  },
  askStatus: () => getJson<{ ready: boolean }>("/api/ask/status"),
  ask: (
    question: string,
    history: AskTurn[] = [],
    opts: { useSearch?: boolean; useMarketData?: boolean } = {},
  ) => postJson<AskResult>("/api/ask", { question, history, ...opts }),
  aiConfig: () =>
    getJson<{
      config: AiConfig;
      defaults: AiConfig;
      models: VisionModelOption[];
      purposes: Record<string, string>;
      fallback: string | null;
    }>("/api/ai/config"),
  aiConfigSave: (config: AiConfig) => putJson<{ config: AiConfig }>("/api/ai/config", config),
  calendarEconomic: () =>
    getJson<{ verifiedAt: string; events: { date: string; title: string }[] }>(
      "/api/calendar/economic",
    ),
  calendarEconomicInstall: () =>
    postJson<{ added: number; replaced: number; verifiedAt: string }>("/api/calendar/economic"),
  calendarVisionStatus: () =>
    getJson<{ ready: boolean; providers: string[]; models: VisionModelOption[] }>(
      "/api/calendar-vision/status",
    ),
  calendarVisionParse: (
    image: string,
    mimeType: string,
    provider?: string,
    model?: string,
  ) =>
    postJson<{
      events: ParsedEvent[];
      provider: string | null;
      model: string | null;
      inputTokens: number;
      outputTokens: number;
      error?: string;
    }>("/api/calendar-vision/parse", { image, mimeType, provider, model }),
  calendarVisionCommit: (events: ParsedEvent[], fileName: string) =>
    postJson<{ added: number }>("/api/calendar-vision/commit", { events, fileName }),
  channelReports: (limit = 10) =>
    getJson<{ reports: ChannelReport[] }>(`/api/channels/reports?limit=${limit}`),
  alertConfig: () =>
    getJson<{ config: AlertConfig; defaults: AlertConfig; channels: TelegramChannelStatus[] }>(
      "/api/alert/config",
    ),
  alertConfigSave: (config: AlertConfig) =>
    putJson<{ config: AlertConfig }>("/api/alert/config", config),
  /** 텔레그램 방 재배정 — 갈래별 보내는 방을 화면에서 바꾼다 */
  telegramRooms: () => getJson<TelegramRoomsData>("/api/alert/telegram-rooms"),
  telegramRoomsSave: (store: TelegramRoomStore) =>
    putJson<{ store: TelegramRoomStore; channels: TelegramChannelStatus[] }>(
      "/api/alert/telegram-rooms",
      store,
    ),
  telegramRoomTest: (channel: string) =>
    postJson<{ ok: boolean; error?: string }>(`/api/alert/telegram-rooms/test/${channel}`, {}),
  alertScan: (send = false) =>
    postJson<{ alerts: FiredAlert[]; sent: boolean; error?: string; preview: string }>(
      `/api/alert/scan${send ? "?send=1" : ""}`,
    ),
  /** 종목 한 장 요약 — 몸값 + 오늘 수급. 서버가 조회 넷을 합쳐 준다 */
  stockSummary: (code: string) => getJson<StockSummaryData>(`/api/market/summary/${code}`),
  /** 장중 기준선 — 분봉+일봉 2회 조회다. 종목을 「들여다보는」 화면에서만 부른다 */
  intraday: (code: string) =>
    getJson<{ levels: IntradayLevels | null }>(`/api/market/intraday/${code}`),
  /** 키움 미국 세부 — 업종·프리장·52주·10호가. 한투 상세에 **얹는** 값이다(교체 아님) */
  usKiwoomDetail: (symbol: string) =>
    getJson<UsKiwoomDetailData>(`/api/us-kiwoom/detail/${encodeURIComponent(symbol)}`),
  /* 마켓 브리핑 — 셋 다 서버 캐시·파일만 읽는다. 외부 호출 0 */
  briefingTimeline: (limit = 60) =>
    /* eventDay: 로그 이벤트(급증·시그널·손절·키워드)가 어느 날 것인가 — 자정 넘어 오늘 것이 없으면 마지막 장일 */
    getJson<{ items: BriefingEvent[]; eventDay?: string }>(`/api/briefing/timeline?limit=${limit}`),
  briefingHeat: () =>
    getJson<{ traded: boolean; tiles: BriefingTile[] }>("/api/briefing/heat"),
  briefingBrief: () =>
    getJson<{ brief: { date: string; label: string; text: string } | null }>("/api/briefing/brief"),
  backtestRules: () => getJson<{ rules: BacktestRuleDef[] }>("/api/backtest/rules"),
  backtestRun: (cfg: BacktestConfig) => postJson<{ id: string }>("/api/backtest/run", cfg),
  backtestJob: (id: string) => getJson<BacktestJob>(`/api/backtest/job/${id}`),
  /** 네이버 증권 주요뉴스 — 편집자가 고른 목록, 썸네일 포함 */
  newsMain: (size = 20) =>
    getJson<{
      items: { title: string; summary: string; thumb: string | null; press: string; link: string; at: string }[];
    }>(`/api/feed/news/main?size=${size}`),
  /**
   * 네이버 뉴스 카테고리 + 페이지 (2026-08-26) —
   * main 주요 · flash 속보 · market 시황·전망 · company 기업·종목 · world 해외증시 · estate 부동산
   */
  newsNaver: (cat: NaverNewsCat, page = 1) =>
    getJson<{ items: NaverNewsItem[]; hasMore: boolean }>(
      `/api/feed/news/naver?cat=${cat}&page=${page}`,
    ),
  /** 돌려 본 조건들 — 엣지 순 리더보드. 통찰은 실행들 사이의 비교에서 나온다 */
  backtestRuns: () =>
    getJson<{
      runs: {
        id: string;
        at: string;
        label: string;
        hit: BacktestStat;
        base: BacktestStat;
        edge: number | null;
        from: string;
        to: string;
        codes: number;
        /** 밤 그리드가 돌린 것 */
        auto?: boolean;
        verdict: { tone: "good" | "weak" | "thin" | "bad"; text: string };
      }[];
    }>("/api/backtest/runs"),
  /** 밤 그리드를 지금 돌린다 — 조합 ~18개, 조회는 종목 50 + 순위 1 */
  backtestGrid: () => postJson<{ ran: boolean; combos?: number }>("/api/backtest/grid", {}),
  /** 손절 감시 상태 — 보내지 않는다. 「감시 못 하는 자리가 몇인가」를 보는 창 */
  stopWatch: () =>
    getJson<{
      /** 들고 있는 자리 수 (복기 노트의 매수·매도를 FIFO 로 맞춘 것) */
      positions: number;
      /** 그중 손절선을 적어 둬 감시되는 자리 */
      watched: number;
      /** 손절선이 없어 감시 못 하는 자리 */
      unwatched: number;
      breaks: {
        code: string;
        name: string;
        price: number;
        stop: number;
        entry: number;
        qty: number;
        lossPct: number;
        from: string;
      }[];
      preview: string;
    }>("/api/alert/stop-watch"),
  trade: (force = false) =>
    getJson<{
      items: TradeSummary[];
      fetchedAt: string;
      configured: boolean;
      error?: string;
    }>(`/api/trade${force ? "?force=1" : ""}`),
  customThemes: (force = false) =>
    getJson<{ themes: EvaluatedTheme[]; snapshotAt: number; coverage: string }>(
      `/api/custom-themes${force ? "?force=1" : ""}`,
    ),
  disclosureAlert: () =>
    getJson<{ config: DisclosureAlertConfig; intervals: number[]; telegramReady: boolean }>(
      "/api/disclosure-alert",
    ),
  disclosureAlertSave: (config: DisclosureAlertConfig) =>
    putJson<{ config: DisclosureAlertConfig }>("/api/disclosure-alert", config),
  disclosureAlertRun: (send: boolean) =>
    postJson<DisclosureRunResult>(`/api/disclosure-alert/run${send ? "?send=1" : ""}`),
  keywordConfig: () =>
    getJson<{ config: KeywordConfig; keywords: KeywordSource[]; intervals: number[] }>("/api/keyword"),
  keywordSave: (config: KeywordConfig) =>
    putJson<{ config: KeywordConfig; keywords: KeywordSource[] }>("/api/keyword", config),
  keywordRun: (send: boolean) =>
    postJson<KeywordRunResult>(`/api/keyword/run${send ? "?send=1" : ""}`),
  usWatch: (force = false) => getJson<UsWatchResult>(`/api/us-watch${force ? "?force=1" : ""}`),
  /** 빠른 시세(야후 spark 배치) — 현재가·등락률만, 4초 캐시. 표 오버레이용 */
  usWatchFast: (symbols: string[]) =>
    getJson<{ quotes: Record<string, { price: number; changeRate: number | null; at: number }> }>(
      `/api/us-watch/fast?symbols=${encodeURIComponent(symbols.join(","))}`,
    ),
  usWatchSearch: (q: string) =>
    getJson<{ results: UsSearchResult[] }>(`/api/us-watch/search?q=${encodeURIComponent(q)}`),
  usWatchGroupAdd: (name: string, memo = "") =>
    postJson<{ groups: UsWatchGroup[] }>("/api/us-watch/groups", { name, memo }),
  usWatchGroupRemove: (id: string) =>
    deleteJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${id}`),
  usWatchGroupOrder: (ids: string[]) =>
    putJson<UsWatchResult>("/api/us-watch/groups/order", { ids }),
  usWatchStockAdd: (groupId: string, symbol: string, name: string) =>
    postJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${groupId}/stocks`, { symbol, name }),
  usWatchStockOrder: (groupId: string, symbols: string[]) =>
    putJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${groupId}/stocks/order`, { symbols }),
  usWatchStockRemove: (groupId: string, symbol: string) =>
    deleteJson<{ groups: UsWatchGroup[] }>(`/api/us-watch/groups/${groupId}/stocks/${symbol}`),
  dartToday: (force = false) =>
    getJson<{ day: string; events: DartEvent[] }>(`/api/dart/today${force ? "?force=1" : ""}`),

  /* ── 종목 정보 (2026-09-01) ──────────────────────────────────────
     정적 사실은 열 때 저절로, AI 서술은 **버튼을 눌러야만**.
     GET 은 절대 AI 를 안 부른다 — 그래야 종목을 훑기만 해도 토큰이 나가는 일이 없다. */
  /**
   * 회사 명세(대표·설립·본사·업종).
   *
   * ⚠️ **화면은 안 쓴다.** 「무슨 일로 버나·왜 지금·벌고 있나」 어디에도 답을 안 해서
   * 뺐다. 서버가 계속 받는 것은 모델이 회사를 특정하는 재료로 쓰기 때문이다 —
   * 사람이 읽을 값이 아니라 모델이 읽을 값이다. 이 함수는 그 값을 눈으로 확인할
   * 자리를 남겨 둔 것이다.
   */
  companyFacts: (code: string) => getJson<{ facts: CompanyFacts | null }>(`/api/company/${code}/facts`),
  /** 이미 엮어 둔 것만 본다. 없으면 null — 화면은 그때 버튼을 보인다 */
  companyBrief: (code: string) => getJson<{ brief: CompanyBrief | null }>(`/api/company/${code}/brief`),
  /** ⚠️ 실제로 AI 를 부른다. 버튼에서만 */
  companyBriefRun: (code: string, name: string, opts: { force?: boolean; price?: number | null } = {}) =>
    postJson<{ brief: CompanyBrief | null; ran: boolean; error?: string }>(
      `/api/company/${code}/brief`,
      { name, force: opts.force ?? false, price: opts.price ?? null },
    ),
  /* ── CIS 일지 — 시스가 굴리는 모의 계좌 (2026-08-31) ────────────────
     모든 조회가 account 를 받는다. 안 주면 트레이딩 계좌다. */
  /** ETF 분석 — 테마·상대강도·추세·품질. 무거우니 화면이 부를 때만 */
  etfAnalysis: (detail = 30) => getJson<EtfAnalysis>(`/api/etf/analysis?detail=${detail}`),
  /** 구성종목 분석 — signal=true 면 구성종목마다 신호등을 잰다(무겁다) */
  etfHoldings: (signal = false, limit = 40) =>
    getJson<HoldingsAnalysis>(`/api/etf/holdings-analysis?limit=${limit}${signal ? "&signal=1" : ""}`),
  cisAccounts: () => getJson<{ accounts: CisProfile[] }>("/api/cis/accounts"),
  cisAccount: (account: string) =>
    getJson<CisAccountView>(`/api/cis/account?account=${account}`),
  cisFills: (account: string, limit = 200) =>
    getJson<{ fills: CisFill[]; total: number }>(
      `/api/cis/fills?account=${account}&limit=${limit}`,
    ),
  cisDay: (account: string, date?: string) =>
    getJson<CisDay>(`/api/cis/day?account=${account}${date ? `&date=${date}` : ""}`),
  cisDays: (account: string, limit = 60) =>
    getJson<{ days: CisDay[]; state: CisPersonaState }>(
      `/api/cis/days?account=${account}&limit=${limit}`,
    ),
  cisStats: (account: string) => getJson<CisStats>(`/api/cis/stats?account=${account}`),
  cisUsage: (account: string) =>
    getJson<{ rows: CisUsageRow[] }>(`/api/cis/usage?account=${account}`),
  cisConfig: () =>
    getJson<{
      config: CisConfig;
      ruleLabels: Record<string, CisRuleLabel>;
      methodLabels: Record<string, string>;
      aiReady: boolean;
      /** 고를 수 있는 모델 — 싼 것부터 */
      aiModels: { provider: string; model: string; label: string; hint: string }[];
    }>("/api/cis/config"),
  cisSaveConfig: (c: Partial<CisConfig>) =>
    putJson<{ config: CisConfig }>("/api/cis/config", c),
  /**
   * 손으로 돌리기. force 는 이미 쓴 시간대를 덮는다 — 「다시 쓰기」에서만.
   *
   * ⚠️ **작업 id 만 돌아온다.** 안에서 주도주 스캔·신호등이 수십 초 걸려
   * 동기로 기다리면 화면이 멈춘다. 진행은 cisRunProgress 로 묻는다.
   */
  cisRun: (account: string, slot: string, force = false) =>
    postJson<{ jobId: string }>("/api/cis/run", { account, slot, force }),
  cisRunProgress: (jobId: string) => getJson<PublishJob>(`/api/cis/run-progress/${jobId}`),
  /** 연금 주간 배분 — 무거워서(ETF 분석 한 판) 작업 id 만 돌아온다 */
  cisPensionRun: (account: string, force = false) =>
    postJson<{ jobId: string }>("/api/cis/pension-run", { account, force }),
  cisWatch: (account: string) =>
    getJson<{
      open: boolean;
      lastRun: string | null;
      lastBuyScan: string | null;
      events: CisWatchEvent[];
      /** 자동 실행이 실패한 것 — 화면이 「왜 안 썼나」를 말할 수 있게 */
      failures: { key: string; fails: number; error?: string; at: string }[];
    }>(
      `/api/cis/watch?account=${account}`,
    ),
  cisReset: (account: string) =>
    postJson<{ ok: boolean; seed: number }>("/api/cis/reset", { account, confirm: "초기화" }),
  cisReview: (account: string) =>
    postJson<{ text: string | null; ai: boolean; error?: string }>("/api/cis/review", { account }),

  journal: () => getJson<JournalData>("/api/journal"),
  /** 내 판단 추적 — 종목마다 일봉을 받아 몇 십 초 걸릴 수 있다 */
  journalTrack: () => getJson<TradeTrackResult>("/api/journal/track"),
  journalSave: (e: Partial<JournalEntry> & { date: string }) =>
    putJson<{ entries: JournalEntry[]; stats: JournalStats }>("/api/journal", e),
  paperTrades: () => getJson<PaperResult>("/api/paper"),
  paperTradeAdd: (t: { code: string; name: string; entryPrice: number; qty: number; thesis?: string }) =>
    postJson<PaperResult>("/api/paper", t),
  paperTradeClose: (id: string, exitPrice: number, exitNote?: string) =>
    postJson<PaperResult>(`/api/paper/${id}/close`, { exitPrice, exitNote }),
  paperTradeRemove: (id: string) => deleteJson<PaperResult>(`/api/paper/${id}`),
  marketSignal: (force = false) =>
    getJson<MarketSignal>(`/api/signal/market${force ? "?force=1" : ""}`),
  signalScreenStart: (market: string, level: "green" | "yellow", limit: number, universe = "trade-value") =>
    postJson<{ jobId: string }>(
      `/api/signal/screen/start?market=${market}&level=${level}&limit=${limit}&universe=${encodeURIComponent(universe)}`,
    ),
  /** 고를 수 있는 모집단 — 서버가 정한다. 화면에 박아 두면 서버와 갈린다 */
  signalScreenUniverses: () =>
    getJson<{ universes: { key: string; label: string; hint: string }[] }>(
      "/api/signal/screen/universes",
    ),
  signalScreenStatus: (jobId: string) => getJson<ScreenJob>(`/api/signal/screen/${jobId}`),
  /** 슈퍼신호등 — 여러 목록에 동시에 걸린 초록의 관찰 목록 */
  signalSuper: () =>
    getJson<{
      entries: SuperEntry[];
      lastRunDate: string | null;
      minLists: number;
      /** 지금 쓰이는 문턱 — 화면이 조절 칸의 현재값으로 쓴다 */
      config?: {
        minLists: number;
        rainbowDays: number;
        universeSize: number;
        maxEval: number;
        /** 폭이 좁은 날 새 편입 — 담되 표시(mark) / 안 담음(skip) */
        weakRegimeMode?: "mark" | "skip";
      };
      grade: SuperGradeRow[];
      /** 전체와 값이 똑같아 서버가 뺀 줄 수 (편입 규칙이 이미 요구하는 조건들) */
      gradeHidden?: number;
      stats: SuperStats;
    }>("/api/signal/super"),
  /**
   * 슈퍼신호등 문턱 — 교집합 몇 곳, 무지개 며칠.
   * ⚠️ 바꾸면 **이미 쌓인 기록의 뜻이 달라진다** — 옛 편입은 옛 문턱으로 걸린 것이다.
   */
  signalSuperConfig: (c: {
    minLists?: number;
    rainbowDays?: number;
    universeSize?: number;
    maxEval?: number;
    /** 폭이 좁은 날 새 편입을 어떻게 할까 — 담되 표시(mark) / 안 담음(skip) */
    weakRegimeMode?: "mark" | "skip";
  }) =>
    putJson<{
      config: {
        minLists: number;
        rainbowDays: number;
        universeSize: number;
        maxEval: number;
        /** 폭이 좁은 날 새 편입 — 담되 표시(mark) / 안 담음(skip) */
        weakRegimeMode?: "mark" | "skip";
      };
    }>("/api/signal/super/config", c),
  /** 대시보드 상세 — 주가·지수·수급 흐름. 클릭했을 때만 */
  signalSuperDetail: (code: string) => getJson<SuperDetail>(`/api/signal/super/detail/${code}`),
  /**
   * 테마 지수 — 상세와 **따로** 받는다.
   * 테마엔 지수가 없어 구성종목 일봉으로 만드는 값이라(최대 8콜) 시트 열림을
   * 잡아두면 안 된다. 서버 캐시 6시간.
   */
  signalSuperTheme: (code: string) =>
    getJson<{ theme: ThemeSeries | null }>(`/api/signal/super/theme/${code}`),
  /** ETF 뒷배 비교선 — 뒷배 점수와 같은 규칙으로 고른 ETF 하나 (6시간 캐시) */
  signalSuperEtf: (code: string) =>
    getJson<{
      etf: {
        code: string;
        name: string;
        weight: number | null;
        series: { date: string; close: number }[];
      } | null;
    }>(`/api/signal/super/etf/${code}`),
  signalSuperExit: (code: string, note: string) =>
    postJson<{ ok: boolean }>(`/api/signal/super/exit/${code}`, { note }),
  signalSuperNote: (code: string, note: string) =>
    putJson<{ ok: boolean }>(`/api/signal/super/note/${code}`, { note }),
  signalSuperJob: () =>
    getJson<{
      status: "idle" | "running" | "done" | "error";
      step: string;
      done: number;
      total: number;
      added: number;
      error?: string;
      /** 약한 장세라 안 담은 수 (설정이 skip 일 때만) */
      skippedWeak?: number;
      regimeWhy?: string | null;
      /**
       * **교집합을 통과한 수**와 **평가 상한에 잘린 수**.
       * 없으면 「후보가 적었다」와 「후보는 많았는데 잘렸다」가 구분이 안 된다 —
       * 처방이 정반대인데도.
       */
      qualified?: number;
      cut?: number;
    }>("/api/signal/super/job"),
  signalSuperRun: () =>
    postJson<{ status: string }>("/api/signal/super/run", {}),
  signalSuperRemove: (code: string) => deleteJson<{ ok: boolean }>(`/api/signal/super/${code}`),
  /** 지금 돌고 있는 찾기 — 전역 작업 띠와 화면 복귀가 본다 */
  signalScreenActive: () =>
    getJson<{
      jobs: {
        id: string;
        done: number;
        total: number;
        market: string;
        universe: string;
        universeLabel: string;
        hits: number;
      }[];
    }>("/api/signal/screen/active"),
  yahooChart: (symbol: string, range: string) =>
    getJson<YahooChart>(
      `/api/market/yahoo-chart?symbol=${encodeURIComponent(symbol)}&range=${range}`,
    ),
  /* ── 테마 DB (2026-08-28) — 분류는 네이버, 숫자는 우리가 계산 ── */
  /** 저장된 분류 원본 */
  naverThemes: () => getJson<NaverThemeStore>("/api/market/naver-themes"),
  naverThemeSummary: () => getJson<ThemeDbSummary>("/api/market/naver-themes/summary"),
  naverThemeProgress: () =>
    getJson<{ done: number; total: number; at: string; running: boolean }>(
      "/api/market/naver-themes/progress",
    ),
  naverThemeFetch: () => postJson<{ started: boolean }>("/api/market/naver-themes/fetch", {}),
  naverThemeFetchUs: () => postJson<{ started: boolean }>("/api/market/naver-themes/fetch-us", {}),
  /** 테마 강도 — 등락률·상승비율·연속성. **조회 0회**(분류는 파일, 시세는 스냅샷) */
  themeStrength: (market: "kr" | "etf" | "us", includeHidden = false) =>
    getJson<{ themes: ThemeStrength[]; at: string; warming?: boolean; hidden: string[] }>(
      `/api/market/theme-strength/${market}${includeHidden ? "?hidden=1" : ""}`,
    ),
  /**
   * 테마 숨기기 — **지우는 게 아니라 가린다.**
   *
   * 네이버 분류라 지워도 다음 동기화에 그대로 돌아온다. 원본은 두고 가리개만
   * 우리가 갖는다. 서버가 `themeStrength` 한 곳에서 거르므로 테마 DB·MAP·신호등이
   * 전부 따라온다.
   */
  /** names 를 같이 보내면 그 테마가 나중에 사라져도 이름을 보여 줄 수 있다 */
  themeHide: (keys: string[], hidden: boolean, names?: Record<string, string>) =>
    putJson<{ hidden: string[] }>("/api/market/theme-hidden", { keys, hidden, names }),
  themeHideClear: () => deleteJson<{ hidden: string[] }>("/api/market/theme-hidden"),
  naverThemeFetchEtf: () => postJson<{ count: number }>("/api/market/naver-themes/fetch-etf", {}),
  /** 시장 렌즈 — 체온계 + 테마 로테이션 + 미국 밤사이. 조회 0회 */
  marketLens: () => getJson<MarketLens>("/api/market/lens"),
  /* 일봉 캐시 — 5·20·60일 누적의 바탕. 없으면 그 칸들이 통째로 「—」다 */
  dailyClosesBuild: () => postJson<{ started: boolean }>("/api/market/daily-closes/build", {}),
  dailyClosesProgress: () =>
    getJson<{ done: number; total: number; running: boolean }>("/api/market/daily-closes/progress"),
  dailyClosesSummary: () =>
    getJson<{ builtAt: string; total: number }>("/api/market/daily-closes/summary"),
  /** 테마 브리핑 — 국내·미국이 같은 이야기를 하는 짝과 「누가 앞서나」 */
  themeLinks: () => getJson<{ pairs: ThemeLink[]; note: string }>("/api/market/theme-links"),
  /** 미국 ETF 구성종목 — 섹터 MAP 타일을 눌렀을 때. 하루 캐시라 여닫아도 조회가 안 는다 */
  usEtfHoldings: (symbol: string) =>
    getJson<UsEtfHoldings>(`/api/market/us-etf-holdings?symbol=${encodeURIComponent(symbol)}`),
  usDetail: (symbol: string) => getJson<UsDetail>(`/api/market/us-detail/${encodeURIComponent(symbol)}`),
  usChart: (symbol: string, period: "D" | "W" | "M") =>
    getJson<{
      candles: { t: string; open: number; high: number; low: number; close: number; volume: number }[];
      error: string | null;
    }>(`/api/market/us-chart/${encodeURIComponent(symbol)}?period=${period}`),
  futuresChart: (code: string, period: "D" | "W" | "M", days: number, market: "F" | "CM" = "CM") =>
    getJson<{
      code: string;
      candles: { t: string; open: number; high: number; low: number; close: number; volume: number }[];
      error: string | null;
    }>(
      `/api/market/futures-chart?code=${encodeURIComponent(code)}&period=${period}&days=${days}&market=${market}`,
    ),
  /** 표 칸 너비 — 화면 이름 → 칸 키 → 픽셀. 카드 배치와 같은 층이라 서버에 둔다 */
  columnWidths: () => getJson<Record<string, Record<string, number>>>("/api/settings/columns"),
  columnWidthsSave: (o: Record<string, Record<string, number>>) =>
    putJson<Record<string, Record<string, number>>>("/api/settings/columns", o),
  cardOrder: () => getJson<Record<string, string[]>>("/api/settings/cards"),
  cardOrderSave: (o: Record<string, string[]>) =>
    putJson<Record<string, string[]>>("/api/settings/cards", o),
  /** `saved` 는 서버에 한 번이라도 저장된 적이 있는지 — 첫 이사 때 필요하다 */
  menuPrefs: () => getJson<MenuPrefsDto & { saved: boolean }>("/api/settings/menu"),
  menuPrefsSave: (p: MenuPrefsDto) => putJson<MenuPrefsDto>("/api/settings/menu", p),
  signalTrack: () => getJson<TrackSummary>("/api/signal/track"),
  /** 시작만 시킨다 — 몇 분짜리 일이라 붙들고 기다리면 프록시가 먼저 끊는다 */
  signalTrackRun: (force = false) =>
    postJson<TrackJob>(`/api/signal/track/run${force ? "?force=1" : ""}`),
  signalTrackJob: () => getJson<TrackJob | null>("/api/signal/track/job"),
  signalTrackConfig: () => getJson<TrackConfig>("/api/signal/track/config"),
  signalTrackConfigSave: (c: TrackConfig) =>
    putJson<TrackConfig>("/api/signal/track/config", c),
  signalScreenRuns: () => getJson<{ runs: ScreenRunSummary[] }>("/api/signal/screen/runs"),
  signalScreenRun: (id: string) => getJson<ScreenRun>(`/api/signal/screen/runs/${id}`),
  signalScreenDiff: (from: string, to: string) =>
    getJson<{ added: ScreenHit[]; removed: ScreenHit[]; stayed: ScreenHit[] }>(
      `/api/signal/screen/diff?from=${from}&to=${to}`,
    ),
  reviewableReports: () =>
    getJson<{ reports: ReviewableReport[] }>("/api/report/reviewable"),
  reviewReport: (date: string, edition: string) =>
    getJson<{ result: ReviewResult | null }>(
      `/api/report/review?date=${date}&edition=${encodeURIComponent(edition)}`,
    ),
  reportSchedule: () =>
    getJson<{ schedule: { slots: EditionSlot[] }; defaults: { slots: EditionSlot[] } }>(
      "/api/report/schedule",
    ),
  reportScheduleSave: (slots: EditionSlot[]) =>
    putJson<{ schedule: { slots: EditionSlot[] } }>("/api/report/schedule", { slots }),
  /** 곧바로 jobId 를 돌려준다. 진행 상황은 reportPublishStatus 로 폴링한다 */
  reportPublishNow: (deliver = false) =>
    postJson<{ jobId: string }>("/api/report/publish-now", { deliver }),
  reportPublishStatus: (jobId: string) => getJson<PublishJob>(`/api/report/publish/${jobId}`),
  /** 지금 돌고 있는 작업 — 페이지를 옮겨도 진행 상황을 되찾으려고 */
  activeJobs: () => getJson<{ jobs: { id: string; job: PublishJob }[] }>("/api/report/jobs/active"),
  exchangeQuotes: (code: string) =>
    getJson<{ code: string; exchanges: ExchangeQuote[] }>(`/api/market/exchanges/${code}`),
  channelConfig: () =>
    getJson<{
      config: { pickAuto: PickAutoConfig; pinned: string[] };
      defaults: { pickAuto: PickAutoConfig; pinned: string[] };
      intervals: number[];
      mailConfigured: boolean;
    }>("/api/channels/config"),
  channelConfigSave: (config: { pickAuto: PickAutoConfig; pinned: string[] }) =>
    putJson<{ config: { pickAuto: PickAutoConfig; pinned: string[] } }>(
      "/api/channels/config",
      config,
    ),
  /** 고정 채널 원문 — 선별·AI 를 안 거친다 */
  channelPinned: (edition: string, limit = 3, force = false) =>
    getJson<{ posts: PinnedPost[]; summary?: string | null; health?: PinnedHealth }>(
      `/api/channels/pinned?edition=${edition}&limit=${limit}${force ? "&force=1" : ""}`,
    ),
  /** 주도주 탐색기. 뉴스는 섹터마다 네이버를 부르므로 원할 때만 켠다 */
  /** 일정 매매 — 목록은 가볍고, 추적은 종목마다 일봉을 받아 몇 십 초 걸린다 */
  /** 종가배팅 — 지금 시장 조건 */
  betGauge: () => getJson<{ day: BetGaugeDay; verdicts: BetVerdict[] }>("/api/pulse/closebet/gauge"),
  /** 과거 검증. 종목마다 일봉을 받아 몇 십 초 걸린다 */
  /*
   * 유가·환율은 **일부러 안 건다**(999). 둘은 조건별 표에서 따로 보는 쪽이 낫다 —
   * 넷을 한꺼번에 걸면 남는 날이 너무 적어서 승률이 아무 말도 못 한다.
   * 금리는 사용자가 정한 상승폭 상한을 그대로 넘긴다.
   */
  betBacktest: (
    codes: string,
    days: number,
    venue: "krx" | "nxt",
    futuresMin: number,
    y10MaxRise: number,
    y30MaxRise: number,
  ) =>
    getJson<BetBacktest>(
      `/api/pulse/closebet/backtest?codes=${encodeURIComponent(codes)}&days=${days}&venue=${venue}` +
        `&futuresMin=${futuresMin}&oilMax=999&fxMax=999` +
        `&y10MaxRise=${y10MaxRise}&y30MaxRise=${y30MaxRise}`,
    ),
  betLog: (settled = false) =>
    getJson<BetLogSummary>(`/api/pulse/closebet/log${settled ? "?settled=1" : ""}`),
  betLogRun: () => postJson<{ days: number; scored: number }>("/api/pulse/closebet/log/run"),
  eventPlays: () => getJson<{ plays: EventPlay[] }>("/api/event-plays"),
  eventPlaysTrack: () => getJson<{ plays: EventPlayResult[] }>("/api/event-plays/track"),
  eventPlaySave: (p: Partial<EventPlay>) =>
    putJson<{ plays: EventPlay[] }>("/api/event-plays", p),
  eventPlayRemove: (id: string) =>
    deleteJson<{ plays: EventPlay[] }>(`/api/event-plays/${encodeURIComponent(id)}`),
  leaderScan: (withNews = false) =>
    getJson<LeaderScan>(`/api/pulse/leaders${withNews ? "" : "?news=0"}`),
  /** 탐색기 성적 — 종목마다 일봉을 받아 몇 십 초 걸린다 */
  leaderTrack: () => getJson<LeaderTrackResult>("/api/pulse/leaders/track"),
  leaderConfig: () => getJson<LeaderConfig>("/api/pulse/leaders/config"),
  leaderConfigSave: (c: LeaderConfig) => putJson<LeaderConfig>("/api/pulse/leaders/config", c),
  pulse: (force = false) => getJson<MarketPulse>(`/api/pulse${force ? "?force=1" : ""}`),
  pulseBrief: (force = false) =>
    getJson<PulseBrief>(`/api/pulse/brief${force ? "?force=1" : ""}`),
  usKr: () => getJson<{ links: EvaluatedLink[]; themeNames: string[]; at: string }>("/api/us-kr"),
  usKrCorrelation: () => getJson<{ result: CorrelationResult | null }>("/api/us-kr/correlation"),
  usKrCorrelate: (days = 60) =>
    postJson<{ result: CorrelationResult }>(`/api/us-kr/correlation?days=${days}`),
  /**
   * 보드 화면 구성 — **서버(전역)**.
   *
   * localStorage 는 창끼리 공유돼서 창 하나가 다른 창의 구성을 덮어썼다.
   * `saved` 가 false 면 아직 서버에 올린 적이 없다는 뜻이라, 화면이 예전 로컬 값을
   * 그때 한 번 올려 준다(빈 값으로 덮어쓰면 짜 둔 구성이 사라진다).
   */
  boardPrefs: () =>
    getJson<{ presets: BoardPresetDto[]; saved: boolean }>("/api/settings/board"),
  boardPrefsSave: (presets: BoardPresetDto[]) =>
    putJson<{ presets: BoardPresetDto[] }>("/api/settings/board", { presets }),

  rankSpecs: () => getJson<{ groups: RankSpecGroup[] }>("/api/rank/specs"),
  rank: (key: string, market = "000", exchange = "3", limit = 100) =>
    getJson<RankResult>(`/api/rank/${key}?market=${market}&exchange=${exchange}&limit=${limit}`),
  sectorFlow: (subject = "foreign", window = 5) =>
    getJson<SectorFlowResult>(`/api/sector-flow?subject=${subject}&window=${window}`),
  sectorFlowStocks: (market: string, code: string) =>
    getJson<{
      stocks: { code: string; name: string; price: number; changeRate: number }[];
      /** 전 종목 등락률이 0 — 아직 장이 열리지 않았다는 뜻 */
      beforeTrading: boolean;
    }>(`/api/sector-flow/stocks?market=${market}&code=${code}`),
  sectorFlowBackfill: (days = 60) =>
    postJson<{ added: number; skipped: number; total: number }>(
      `/api/sector-flow/backfill?days=${days}`,
    ),
  customThemeCreate: (t: {
    name: string;
    memo?: string;
    codes?: string[];
    source?: "manual" | "infostock";
  }) =>
    postJson<{ themes: unknown[] }>("/api/custom-themes", t),
  customThemeUpdate: (id: string, patch: { name?: string; memo?: string; codes?: string[] }) =>
    patchJson<{ themes: unknown[] }>(`/api/custom-themes/${id}`, patch),
  customThemeRemove: (id: string) => deleteJson<{ themes: unknown[] }>(`/api/custom-themes/${id}`),
  customThemeToggleStock: (id: string, code: string) =>
    postJson<{ themes: unknown[] }>(`/api/custom-themes/${id}/stocks/${code}`),
  customThemeFromWatchlist: (name: string, group?: string, memo?: string) =>
    postJson<{ themes: unknown[] }>("/api/custom-themes/from-watchlist", { name, group, memo }),
  tradeStocks: (key: string) =>
    getJson<{
      stocks: { code: string; name: string; changeRate: number; marketCap?: number | null }[];
      from: "theme" | "sector" | "none";
      label: string;
    }>(`/api/trade/${key}/stocks`),
  /** 관심종목 통합(KRX+NXT) 시세 — NXT 프리·애프터에 0B 오버레이가 조용할 때의 값 */
  watchQuotes: () =>
    getJson<{ quotes: Record<string, { price: number; changeRate: number }> }>(
      "/api/watchlist/quotes",
    ),
  /* 메모장 — 자유 메모 + 일기 (종목 메모와 다른 저장소) */
  memoList: (q = "", tag = "") =>
    getJson<{ items: MemoEntry[] }>(
      `/api/memo?q=${encodeURIComponent(q)}&tag=${encodeURIComponent(tag)}`,
    ),
  memoTags: () => getJson<{ tags: { tag: string; count: number }[] }>("/api/memo/tags"),
  memoAdd: (title: string, body: string, tags: string[]) =>
    postJson<{ memo: MemoEntry }>("/api/memo", { title, body, tags }),
  memoUpdate: (
    id: string,
    patch: Partial<Pick<MemoEntry, "title" | "body" | "tags" | "pinned" | "stocks">>,
  ) => patchJson<{ memo: MemoEntry }>(`/api/memo/${id}`, patch),
  /** 이 종목에 매어 둔 메모 — 종목 상세가 읽는다 */
  memosOfStock: (code: string) => getJson<{ items: MemoEntry[] }>(`/api/memo/stock/${code}`),
  memoRemove: (id: string) => deleteJson<{ ok: boolean }>(`/api/memo/${id}`),
  /**
   * 붙임 파일 올리기 — **바이너리 그대로** 보낸다(base64 는 3분의 1 부푼다).
   * 이름은 한글·공백이 흔해 헤더에 그냥 넣으면 깨지므로 base64 로 감싼다.
   */
  memoFileAdd: async (id: string, file: File): Promise<{ file: MemoFile }> => {
    const res = await fetch(`/api/memo/${id}/files`, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "application/octet-stream",
        "x-file-name": btoa(String.fromCharCode(...new TextEncoder().encode(file.name))),
        "x-file-type": file.type || "application/octet-stream",
      },
      body: file,
    });
    if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { error?: string }).error ?? "올리지 못했습니다");
    return res.json() as Promise<{ file: MemoFile }>;
  },
  memoFileRemove: (id: string, fileId: string) =>
    deleteJson<{ ok: boolean }>(`/api/memo/${id}/files/${fileId}`),
  /** 미리보기·내려받기 주소 — `inline` 이면 브라우저가 열고, 아니면 받는다 */
  memoFileUrl: (id: string, fileId: string, inline = false) =>
    `/api/memo/${id}/files/${fileId}${inline ? "?inline=1" : ""}`,
  /** 장중 투자자별 누적 순매수 — 01 코스피 · 02 코스닥 · 03 K200선물. 시트 열 때만 */
  intradayFlow: (market: "01" | "02" | "03") =>
    getJson<{ date: string; points: IntraFlowPoint[] }>(
      `/api/market/intraday-flow?market=${market}`,
    ),
  /** 큰 변화 브리핑 — 분기·반기·연간으로 크게 움직인 품목. pending>0 이면 아직 채우는 중 */
  tradeBrief: () =>
    getJson<{
      rows: {
        key: string;
        label: string;
        watch: "export" | "import";
        quarter: { cur: number; prev: number; rate: number | null } | null;
        half: { cur: number; prev: number; rate: number | null } | null;
        year: { cur: number; prev: number; rate: number | null } | null;
        top: number;
      }[];
      pending: number;
    }>("/api/trade/brief"),
  /** 품목의 월별 수출·수입 시계열 (36개월) — 품목을 펼칠 때만 부른다 */
  tradeHistory: (key: string) =>
    getJson<{ months: { month: string; exportUsd: number; importUsd: number }[] }>(
      `/api/trade/${key}/history`,
    ),
  /** 품목의 나라별 상위 — 어느 나라로 얼마나 + 그 나라 안의 세부 품목 구성 */
  tradeCountries: (key: string) =>
    getJson<{
      month: string;
      watch: "export" | "import";
      rows: {
        country: string;
        exportUsd: number;
        importUsd: number;
        yoy: number | null;
        top: { name: string; usd: number; share: number }[];
      }[];
      /** 상위 5개 나라의 최근 13개월 흐름 — 값은 보는 방향(수출/수입) */
      series: { months: string[]; countries: { country: string; values: number[] }[] } | null;
    }>(`/api/trade/${key}/countries`),
  breadth: (days = 60) =>
    getJson<{ days: number; points: BreadthPoint[]; summary: string }>(
      `/api/breadth?days=${days}`,
    ),
  signal: (code: string, force = false) =>
    getJson<SignalResult>(`/api/signal/${code}${force ? "?force=1" : ""}`),
  signalBatch: (codes: string[]) =>
    getJson<{ results: Record<string, SignalResult> }>(
      `/api/signal/batch?codes=${codes.join(",")}`,
    ),
  signalConfig: () =>
    getJson<{ config: SignalConfig; defaults: SignalConfig }>("/api/signal/config"),
  signalConfigSave: (config: SignalConfig) =>
    putJson<{ config: SignalConfig }>("/api/signal/config", config),
  /**
   * 신호등 백테스트 — 기준을 바꿔 과거를 다시 매긴다. **저장하지 않는다.**
   * 일봉으로 되살릴 수 있는 기준만 쓴다(테마·ETF·수급·재무는 그때의 구성을 모른다).
   */
  /** 백그라운드 시작 (2026-08-28) — 결과는 /result 를 폴링해서 받는다 */
  signalBacktest: (body: {
    limit: number;
    days: number;
    config: SignalConfig;
    /** 000 전체 · 001 코스피 · 101 코스닥 */
    market?: string;
  }) =>
    postJson<{ started: boolean }>("/api/signal/backtest", body),
  signalBacktestProgress: () =>
    getJson<{ done: number; total: number; running: boolean }>("/api/signal/backtest/progress"),
  /** 마지막 결과 — 탭을 떠났다 돌아와도 그대로 (서버 재시작이면 없다) */
  signalBacktestResult: () =>
    getJson<{ result: SignalBacktestResult | null; at: string; error?: string }>(
      "/api/signal/backtest/result",
    ),
  /*
   * 시뮬레이터 (2026-08-31) — 백테스트가 남긴 **원시값 창고**를 설정만 바꿔
   * 다시 채점한다. API 를 안 부르므로 즉답이고, 파일이라 서버 재시작에도 남는다.
   */
  signalSamples: () =>
    getJson<{ has: boolean; builtAt?: string; days?: number; codeCount?: number; obs?: number }>(
      "/api/signal/samples",
    ),
  signalSimulate: (config?: SignalConfig) =>
    postJson<{ result: SignalSimResult }>("/api/signal/simulate", config ? { config } : {}),
  /**
   * 전수 훑기 — 켤 수 있는 기준의 **모든 조합**.
   * 순위는 뒤쪽 절반(검증 구간) 성적으로 매긴다 — 앞에서만 좋은 조합을 거르려는 것이다.
   */
  signalSweep: (config?: SignalConfig, top = 20) =>
    postJson<{ result: SignalSweepResult }>("/api/signal/sweep", { config, top }),
  /**
   * 조건부 성적표 — **어디서 먹히고 어디서 안 먹히나.**
   * 표본 안에서 그날 시장을 되짚으므로 조회가 0회다.
   */
  signalConditional: (config?: SignalConfig) =>
    postJson<{ result: SignalCondResult }>("/api/signal/conditional", { config }),
  /**
   * 슈퍼신호등 재구성 — **두 겹 문이 각각 값을 하나.**
   * 표본에서 일곱 목록 중 여섯을 되살려 「교집합만」·「초록만」·「둘 다」를 견준다.
   */
  /* ---------------- 신호등 분석 (목록별 추적, 2026-08-31) ---------------- */
  listTrack: () => getJson<ListTrackSummary>("/api/signal/list-track"),
  listTrackJob: () =>
    getJson<{
      status: string;
      step: string;
      done: number;
      total: number;
      added: number;
      error?: string;
      counts?: Record<string, { universe: number; green: number }>;
    }>("/api/signal/list-track/job"),
  /** 지금 돌리기 — 40분쯤, 백그라운드 */
  listTrackRun: () => postJson<{ started: boolean }>("/api/signal/list-track/run", {}),

  signalSuperSim: (config?: SignalConfig, minLists = 3) =>
    postJson<{ result: SignalSuperSimResult }>("/api/signal/super-sim", { config, minLists }),

  /* ---------------- 알림함 + 장세 점검 (2026-08-31) ---------------- */

  /**
   * 종 옆 배지와 목록을 **한 번에** 받는다 — 배지 때문에 따로 부르면 폴링이 두 배다.
   */
  notices: (opts: { limit?: number; kind?: NoticeKind | "all"; unreadOnly?: boolean } = {}) =>
    getJson<{ items: Notice[]; unread: number; unreadBy: Record<NoticeKind, number> }>(
      `/api/notify?limit=${opts.limit ?? 50}&kind=${opts.kind ?? "all"}` +
        (opts.unreadOnly ? "&unread=1" : ""),
    ),
  /** `ids` 를 안 주면 전부 읽음으로 */
  noticesRead: (ids?: string[]) => postJson<{ marked: number }>("/api/notify/read", { ids }),
  /** 읽은 것만 비운다 — 안 읽은 것은 남는다 */
  noticesClear: () => postJson<{ removed: number }>("/api/notify/clear", {}),

  regimeConfig: () =>
    getJson<{ config: RegimeConfig; defaults: RegimeConfig }>("/api/notify/regime/config"),
  regimeConfigSave: (config: Partial<RegimeConfig>) =>
    putJson<{ config: RegimeConfig }>("/api/notify/regime/config", config),
  /** `notify` 는 문턱을 넘은 항목을 알림으로도 만들지 — 화면에서 눌러 볼 땐 끈다 */
  regimeCheck: (notify = false) =>
    postJson<RegimeResult>("/api/notify/regime/check", { notify }),
  notes: (code: string) => getJson<{ name: string; notes: StockNote[] }>(`/api/notes/${code}`),
  notesRecent: (limit = 30) =>
    getJson<{ items: { code: string; name: string; note: StockNote }[] }>(
      `/api/notes/recent?limit=${limit}`,
    ),
  noteAdd: (code: string, name: string, text: string) =>
    postJson<{ name: string; notes: StockNote[] }>(`/api/notes/${code}`, { name, text }),
  noteUpdate: (code: string, id: string, text: string) =>
    patchJson<{ name: string; notes: StockNote[] }>(`/api/notes/${code}/${id}`, { text }),
  noteRemove: (code: string, id: string) =>
    deleteJson<{ name: string; notes: StockNote[] }>(`/api/notes/${code}/${id}`),
  calendarList: (month?: string) =>
    getJson<{ events: CalendarEvent[] }>(`/api/calendar${month ? `?month=${month}` : ""}`),
  /** 기간 조회 — 주·일 보기가 월 경계를 넘는다. 반복은 서버가 기간 인스턴스로 편다 */
  calendarRange: (from: string, to: string) =>
    getJson<{ events: CalendarEvent[] }>(`/api/calendar?from=${from}&to=${to}`),
  calendarUpcoming: (days = 14) =>
    getJson<{ events: CalendarEvent[] }>(`/api/calendar/upcoming?days=${days}`),
  calendarAdd: (e: Omit<CalendarEvent, "id">) =>
    postJson<{ events: CalendarEvent[] }>("/api/calendar", e),
  calendarSubs: () =>
    getJson<{ subs: { label: string; masked: string; url: string; count: number }[] }>(
      "/api/calendar/subs",
    ),
  calendarSubAdd: (url: string, label: string) =>
    postJson<{ added: number; events: CalendarEvent[] }>("/api/calendar/subs", { url, label }),
  calendarSubRemove: (url: string) =>
    deleteJson<{ events: CalendarEvent[] }>(`/api/calendar/subs?url=${encodeURIComponent(url)}`),
  calendarSync: () =>
    postJson<{ results: { label: string; added: number; error?: string }[]; events: CalendarEvent[] }>(
      "/api/calendar/sync",
    ),
  calendarImport: (filename: string, text: string, kind: EventKind) =>
    postJson<{ added: number; replaced: number; events: CalendarEvent[] }>("/api/calendar/import", {
      filename,
      text,
      kind,
    }),
  calendarRemove: (id: string) => deleteJson<{ events: CalendarEvent[] }>(`/api/calendar/${id}`),
  calendarUpdate: (id: string, patch: Partial<Omit<CalendarEvent, "id">>) =>
    patchJson<{ events: CalendarEvent[] }>(`/api/calendar/${id}`, patch),
  apiUsage: () => getJson<{ day: string; providers: ProviderUsage[] }>("/api/settings/usage"),
  apiUsageTotals: (days = 30) => getJson<UsageTotals>(`/api/settings/usage/totals?days=${days}`),
  apiUsageHistory: (days = 14) =>
    getJson<{ history: { day: string; counts: Record<string, number> }[] }>(
      `/api/settings/usage/history?days=${days}`,
    ),
  apiKeys: () =>
    getJson<{ keys: { name: string; configured: boolean }[]; isMock: boolean }>("/api/settings/keys"),
  news: (q: string, opts: { scope?: "major" | "all"; display?: number } = {}) =>
    getJson<{ items: NewsItem[]; counts: { major: number; all: number } }>(
      `/api/feed/news?q=${encodeURIComponent(q)}&display=${opts.display ?? 30}&scope=${opts.scope ?? "major"}`,
    ),
  publishedReport: (date?: string, edition?: string) => {
    const q = new URLSearchParams();
    if (date) q.set("date", date);
    if (edition) q.set("edition", edition);
    const qs = q.toString();
    return getJson<PublishedReportResponse>(`/api/report/published${qs ? `?${qs}` : ""}`);
  },
  reportPublish: (edition: string) =>
    postJson<{ report: PublishedReport }>("/api/report/publish", { edition }),
  reportDeliver: (date: string, edition: string) =>
    postJson<{ telegram: { ok: boolean; error?: string }; mail: { ok: boolean; error?: string } }>(
      "/api/report/deliver",
      { date, edition },
    ),
  indexIntraday: (code: string, tic = "5") =>
    getJson(`/api/market/index-intraday/${code}?tic=${tic}`),
  marketDrivers: (top = 5) => getJson<MarketDriverReport>(`/api/report/drivers?top=${top}`),
  newsSectors: (scope: "major" | "all" = "major", per = 20, sort: "importance" | "recent" = "importance") =>
    getJson<{
      sectors: { key: string; label: string; items: ScoredNews[] }[];
      fetchedAt: string;
      /** 어느 목록에서 종목을 뽑아 검색했는지 — 안 밝히면 왜 이 기사가 떴는지 모른다 */
      mineSources?: string[];
      mineNames?: string[];
    }>(
      `/api/feed/news/sectors?scope=${scope}&per=${per}&sort=${sort}`,
    ),
  /** 속보 — [속보]·[단독]·[긴급] 머리표가 붙은 것만. 증시·기업 갈래가 먼저다 */
  newsBreaking: () =>
    getJson<{
      categories: { key: string; label: string; items: NewsItem[] }[];
      fetchedAt: string;
    }>("/api/feed/news/breaking"),
  finance: (code: string) => getJson<FinanceResult>(`/api/feed/finance/${code}`),
  disclosures: (code: string, days = 180) =>
    getJson<{ items: DisclosureItem[] }>(`/api/feed/disclosures/${code}?days=${days}`),
  programTrades: (market: string, scope: string) =>
    getJson<{ items: ProgramRow[] }>(`/api/overview/program/${market}/${scope}`),
  themeStocks: (code: string) => getJson<{ items: StockRow[] }>(`/api/overview/theme/${code}/stocks`),
  sectorStocks: (market: string, code: string) =>
    getJson<{ items: StockRow[] }>(`/api/overview/sector/${market}/${code}/stocks`),
};

/** 증권사 투자의견 한 건 (한국투자증권) */
export interface OpinionItem {
  date: string;
  broker: string;
  opinionRaw: string;
  stance: "매수" | "중립" | "매도" | "기타";
  prevStance: "매수" | "중립" | "매도" | "기타";
  /** 직전 대비 상향(+1)·하향(-1)·유지(0) */
  move: number;
  goalPrice: number | null;
  prevGoalPrice: number | null;
  /** 같은 증권사의 직전 목표가 대비 % */
  goalChange: number | null;
}

export interface OpinionSummary {
  code: string;
  items: OpinionItem[];
  brokerCount: number;
  goalMedian: number | null;
  goalMin: number | null;
  goalMax: number | null;
  upside: number | null;
  price: number | null;
  stanceCount: { 매수: number; 중립: number; 매도: number; 기타: number };
  goalTrend: number | null;
  truncated: boolean;
  upgrades: OpinionItem[];
  downgrades: OpinionItem[];
  fetchedAt: string;
}

export interface WatchItem {
  /**
   * 그룹 안에서의 자리 — 그룹 이름 → 순번. 없으면 맨 아래(새로 담은 것).
   * 한 종목이 여러 그룹에 드므로 **그룹마다 따로** 둔다.
   */
  order?: Record<string, number>;
  /** 구분선인가 — 종목이 아니라 눈으로 묶음을 가르는 빈 줄 */
  divider?: boolean;
  code: string;
  name: string;
  addedAt: string;
  addedPrice: number;
  memo: string;
  /** @deprecated 한 그룹만 담던 옛 필드 */
  group?: string;
  /** 소속 그룹들 — 한 종목이 여러 그룹에 담긴다 */
  groups: string[];
  /**
   * 지금 이 종목과 나의 관계 — **그룹(성격)과 다른 축**이다.
   * 같은 종목이 「반도체」이면서 동시에 「진입 대기」일 수 있다.
   */
  status?: WatchStatus;
}

export type WatchStatus = "watching" | "ready" | "holding" | "closed";

export interface KiwoomGroup {
  code: string;
  name: string;
}

export interface KiwoomGroupStock {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  volume: number;
  tradeAmount: number;
}

export interface TrackedStock extends WatchItem {
  price: number;
  changeRate: number;
  returnRate: number | null;
  foreign5: number;
  foreign10: number;
  foreign20: number;
  inst5: number;
  inst60: number;
  /** 종가가 5일선/20일선 위인가 */
  above5: boolean | null;
  above20: boolean | null;
  /** 최근 3일 추세 +1 늘었다 / -1 줄었다 / 0 그대로 / null 모름 */
  shortTrend: number | null;
  lendingTrend: number | null;
  profitUp: boolean | null;
  sectorStrong: boolean | null;
  /** 조건 충족 수 / 판단 가능한 수 */
  passCount: number;
  passTotal: number;
  /** 목표가(컨센서스 중앙값)까지 남은 폭 % */
  upside: number | null;
  /** 최근 60일 의견 변경: +1 상향, -1 하향, 0 없음 */
  opinionMove: number | null;
  brokerCount: number | null;
  inst20: number;
  trendPass: boolean | null;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  error: string | null;
}

export interface MarketStatus {
  state: "pre" | "open" | "closed" | "holiday";
  label: string;
  /** 지금 체결이 도는가 — NXT 시간외(08:00~09:00, 15:30~20:00)를 포함한다 */
  live?: boolean;
  venue?: "none" | "nxt" | "krx";
}

export interface SectionResult<T> {
  data: T | null;
  updatedAt: number | null;
  error: string | null;
  stale: boolean;
  /** 서버가 이 섹션을 얼마마다 새로 만드는가(ms) — 화면 폴링의 하한 (2026-08-31) */
  ttlMs?: number;
}

/** 메모장 글 하나 — 자유 메모 + 일기 */
/** 메모 붙임 파일 — 파일은 서버 디스크에, 여기엔 이름표만 */
export interface MemoFile {
  id: string;
  name: string;
  mime: string;
  size: number;
  at: string;
}

export interface MemoEntry {
  id: string;
  at: string;
  updatedAt: string;
  title: string;
  body: string;
  tags: string[];
  pinned: boolean;
  /** 옛 메모에는 이 칸이 없다 */
  files?: MemoFile[];
  /** 이어 둔 종목 — 종목 상세에서도 이 메모가 보인다 */
  stocks?: { code: string; name: string }[];
}

/** 장중 투자자별 누적 순매수 한 점 — 코스피/코스닥 억원, 선물 계약 */
export interface IntraFlowPoint {
  t: string;
  individual: number;
  foreign: number;
  institution: number;
}

/** 네이버 뉴스 카테고리 — 서버 NaverCat 과 같은 값 */
export type NaverNewsCat = "main" | "flash" | "market" | "company" | "world" | "estate";

export interface NaverNewsItem {
  title: string;
  summary: string;
  thumb: string | null;
  press: string;
  link: string;
  at: string;
}

export interface IndexCard {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  sparkline: number[];
  upperLimit: number;
  rising: number;
  flat: number;
  falling: number;
  lowerLimit: number;
  /** 코스피200 에만 붙는다 — 그 옆의 선물 (한국투자증권) */
  futures?: FuturesQuote | null;
}

export interface FuturesQuote {
  code: string;
  name: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  theoretical: number | null;
  openInterest: number | null;
  volume: number | null;
  /** 선물 − 현물. 음수면 백워데이션이고 프로그램 매도가 붙기 쉽다 */
  basis: number | null;
}

export interface FlowSample {
  /** HHmm (한국시간) */
  t: string;
  foreign: number;
  institution: number;
  individual: number;
}

export interface FlowIntradayDay {
  date: string;
  kospi: FlowSample[];
  kosdaq: FlowSample[];
}

export type IndexRange = "day" | "week" | "month";

export interface IndexCandle {
  dt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /** 그날 시장 전체 거래대금(억원) — 지수가 오르는 날과 돈이 들어오는 날은 다르다 */
  tradeValue: number;
  /** 거래량(천주) */
  volume: number;
}

/* VNTG 방 뷰어 */
export interface TgRoom {
  channel: string;
  label: string;
  lastAt: string | null;
  preview: string;
  unread: number;
  total: number;
}
export interface TgMsg {
  id: string;
  at: string;
  text: string;
}
export interface TgStar extends TgMsg {
  channel: string;
  starredAt: string;
}

/** ETF 전체 시세 한 줄 (ka40004 실측 필드 기반) */
/** 이 종목을 담은 ETF 한 줄 (2026-08-27) — 서버가 하루 1회 뒤집어 만든 인덱스에서 */
export interface EtfHolder {
  code: string;
  name: string;
  /** 이 ETF 안에서 그 종목의 비중(%) */
  weight: number | null;
  /** 순자산총액 — 사람이 읽는 형태("25조 4,885억") */
  aum: string;
  aumRaw: number;
  changeRate: number | null;
  w1: number | null;
  m1: number | null;
  m3: number | null;
  index: string;
}

export interface EtfListRow {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  volume: number;
  /** 거래대금(억원) — 현재가 × 거래량 어림 */
  tradeValue: number;
  nav: number | null;
  /** 괴리율(%) — 양수면 NAV 보다 비싸게(프리미엄) 거래 중 */
  deviation: number | null;
  traceErr: number | null;
  index: string;
}

export interface IndexFlowRow {
  date: string;
  changeRate: number;
  foreign: number;
  institution: number;
  individual: number;
  pension: number;
  trust: number;
  /** 사모펀드 (2026-08-27) */
  privateFund: number;
  /** 금융투자 — 수집 스키마에 2026-08-27 추가돼 그 전 날짜는 null("-") */
  securities: number | null;
  /* 아래 다섯은 2026-08-31 추가 — 그 전 날짜는 null("-"). 0 이 아니라 「모름」이다 */
  insurance: number | null;
  bank: number | null;
  otherFinance: number | null;
  nation: number | null;
  otherCorp: number | null;
}

export interface IndexDetailData {
  code: string;
  name: string;
  range: IndexRange;
  candles: IndexCandle[];
  flows: IndexFlowRow[];
}

export interface TradeSizeRow {
  /** "3백이하", "5억초과" 같은 구간 이름 */
  band: string;
  buyQty: number;
  sellQty: number;
  totalQty: number;
  netQty: number;
  buyRate: number;
  sellRate: number;
  netRate: number;
  buyAvgPrice: number;
  sellAvgPrice: number;
}

export interface TopTraderRow {
  rank: number;
  code: string;
  name: string;
  price: number;
  changeRate: number;
  /** 순매수 금액 (억원) */
  netAmount: number;
  netQty: number;
  /** 이 종목을 들고 있는 상위 계좌 수 */
  accounts: number;
  avgBuyPrice: number;
  /** 그 계좌들의 수익률(%) */
  profitRate: number;
}

export interface RateRow {
  code: string;
  name: string;
  /** 금리 (%) */
  rate: number | null;
  /** 전일대비 (%p) — 등락률이 아니다 */
  change: number | null;
  group: "국내" | "해외";
}

/** 미장 표의 줄 단위 경고 — 신호등(green/yellow/red)과는 다른 개념이다 */
export type RowLevel = "danger" | "warn" | "ok";

export interface RowSignal {
  level: RowLevel;
  why: string;
}

export interface UsMajorRow {
  key: string;
  label: string;
  symbol: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  /** 금리는 값 자체가 % 다 */
  isRate: boolean;
  digits: number;
  quotedAt: number | null;
  /** 어디서 받은 값인가 — 야후가 막히면 한투로 메운다 */
  source: "yahoo" | "hantoo";
  /** 지금 눈여겨볼 상태인가 (없으면 평범한 것) */
  signal: RowSignal | null;
  error: string | null;
}

export interface UsBoardSignal {
  level: "green" | "yellow" | "red";
  summary: string;
  reasons: string[];
}

export interface UsMajorResult {
  /** 줄 경고들을 한 덩어리로 굴린 판정. 판정은 서버에서만 한다 */
  boardSignal: UsBoardSignal;
  rows: UsMajorRow[];
  /** 코스피 야간선물 — 이것만 지금 움직인다 */
  nightFutures: UsMajorRow | null;
  /** 장단기 금리차 한 줄 */
  curveNote: string | null;
  fetchedAt: number;
}

export interface InvestorFlow {
  individual: number;
  foreign: number;
  institution: number;
  financialInvestment: number;
  investmentTrust: number;
  pensionFund: number;
  privateFund: number;
  insurance: number;
  bank: number;
  otherFinance: number;
  nation: number;
  otherCorp: number;
}

export interface MarketFlow {
  kospi: InvestorFlow;
  kosdaq: InvestorFlow;
}

/** 시가총액(marketCap)은 억원 단위. 상장주식수를 못 찾으면 null */
export interface EvaluatedHolding {
  code: string;
  name: string;
  avgPrice: number;
  qty: number;
  price: number;
  changeRate: number;
  value: number;
  cost: number;
  profit: number;
  returnRate: number | null;
}

export interface EvaluatedAccount {
  id: string;
  broker: string;
  name: string;
  holdings: EvaluatedHolding[];
  totalCost: number;
  /** 주식 평가금액 */
  totalValue: number;
  totalProfit: number;
  totalReturnRate: number | null;
  /** 예수금 */
  cash: number;
  /** 주식 + 예수금 = 실제 잔고 */
  totalAssets: number;
  /** 총자산 대비 주식 비중(%) */
  stockRatio: number | null;
  cashUpdatedAt?: string;
}

export interface AskTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AskResult {
  text: string | null;
  searches: string[];
  sources: { title: string; url: string }[];
  inputTokens: number;
  outputTokens: number;
  model: string;
  error?: string;
}

export interface AiChoice {
  provider: string;
  model: string;
}

export interface AiConfig {
  report: AiChoice | null;
  channel: AiChoice | null;
  research: AiChoice | null;
  /** 시황 질문하기 — Claude 만 고를 수 있다 */
  ask: AiChoice | null;
  /** 시장 흐름 요약. 안 고르면 report 를 따라간다 */
  pulse: AiChoice | null;
  /** 고정 채널 AI 세줄 — 안 고르면 report 를 따라간다 */
  pinned: AiChoice | null;
  /** 캘린더 이미지 인식 — 안 고르면 싼 제공자부터 시도한다 */
  vision: AiChoice | null;
}

export interface VisionModelOption {
  provider: string;
  model: string;
  label: string;
  hint: string;
}

export interface ParsedEvent {
  date: string;
  time?: string;
  title: string;
  kind: string;
  memo?: string;
}

export interface ChannelEntry {
  id: string;
  name: string;
  username: string | null;
  broadcast: boolean;
  participants: number | null;
  lastAt: string | null;
  enabled: boolean;
  /** 주요 채널 — 글을 빠짐없이 아카이브해 「주요 채널」 방에서 읽는다 */
  major?: boolean;
}

/** 주요 채널 피드 한 건 — 원문 그대로 */
export interface MajorMsg {
  id: string;
  channelId: string;
  at: string;
  channel: string;
  text: string;
  link: string;
}

/** 주요 채널 방 목록 한 줄 — 받은 방과 같은 모양 */
export interface MajorRoom {
  id: string;
  name: string;
  lastAt: string | null;
  preview: string;
  unread: number;
  total: number;
}

/** 고정 채널이 어디서 막혔나 — 빈 목록만으로는 원인을 못 가린다 */
export interface PinnedHealth {
  triedAt: string | null;
  /** 마지막으로 **글을 실제로 가져온** 시각 */
  okAt: string | null;
  okCount: number;
  stage: string | null;
  pinned: string[];
  visible: string[];
  detail: string;
}

export interface PinnedPost {
  channelName: string;
  username: string | null;
  at: string;
  text: string;
  link: string;
}

export interface ScoredChannelItem {
  /** AI 에게 보낼 몫 — 400자로 자른 것. 사람에게 보일 때는 fullText 를 쓴다 */
  text: string;
  /** 자르지 않은 원문 (2026-08-31) */
  fullText?: string;
  at: string;
  channels: string[];
  channelName?: string;
  link?: string;
  coverage: number;
  mentions: string[];
  /** 본문에서 찾아낸 종목 (관심종목 + 내 테마 종목). 비어 있으면 못 찾은 것 */
  stocks?: string[];
  /** 그 종목들이 속한 내 테마 */
  themes?: string[];
  score: number;
}

export interface ChannelReport {
  date: string;
  generatedAt: string;
  channels: number;
  rawCount: number;
  usedCount: number;
  items: ScoredChannelItem[];
  summary: string | null;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  skipped: string[];
  /** 몇 시간치를 훑었는지 */
  windowMinutes?: number;
  /** 실제로 잡힌 메시지의 시각 범위 */
  oldestAt?: string | null;
  newestAt?: string | null;
}

export interface AlertRule {
  key: string;
  label: string;
  enabled: boolean;
  threshold: number;
  hint: string;
}

export interface AlertConfig {
  enabled: boolean;
  intervalMin: number;
  rules: AlertRule[];
}

/* ---------------- 슈퍼신호등 대시보드 (2026-08-26) ---------------- */

export interface SuperDaily {
  date: string;
  close: number;
  score: number;
  level: string;
  /** 그날 체크별 판정 (라벨·grade 0/50/100/null) — 점수 변동 사유의 재료 (2026-08-27) */
  checks?: { l: string; g: number | null }[];
  /** 그날의 시장 신호등 — 메모 복기 브리핑용 (2026-08-27부터 기록) */
  market?: { level: string; score: number };
}

export interface SuperExit {
  date: string;
  price: number | null;
  score: number | null;
  marketLevel: string | null;
  marketScore: number | null;
  note: string;
  auto: boolean;
}

export interface SuperEntry {
  /**
   * 편입일로부터 며칠 (2026-08-31). **편입 당일은 0.**
   * `seenCount`(걸린 날 수)와 다른 질문의 답이다 — 8/28 편입 후 다시 안 걸렸으면
   * seenCount 는 1 인데 오늘이 8/31 이면 여기는 3 이다.
   */
  daysSince?: number;
  /**
   * 지수 대비 초과수익(%p) — 같은 날짜 코스피 수익률을 뺀 값 (2026-08-31).
   * 이게 없으면 절대수익률이 좋은 건지 나쁜 건지 알 수 없다.
   */
  excess?: { d1: number | null; d5: number | null; d20: number | null };
  /**
   * 이탈 후 성적 — 이탈일 종가 대비. **양수면 나오고 나서 올랐다는 뜻**(이탈이 일렀다).
   * 이탈 규칙이 맞았는지 재는 유일한 길이다.
   */
  afterExit?: { d1: number | null; d5: number | null; d20: number | null };
  /** 오늘 편입됐나 — N 배지 */
  isNew?: boolean;
  /**
   * **무지개** — 사흘 이상 계속 교집합에 걸린 활성 종목 (2026-08-31).
   * 점수가 아니라 **지속성**에 등급을 뒀다 — 성적을 가른 유일한 축이라서다.
   */
  rainbow?: boolean;
  code: string;
  name: string;
  addedDate: string;
  addedPrice: number;
  score: number;
  lists: string[];
  seenCount: number;
  lastSeenDate: string;
  returns?: { d1: number | null; d5: number | null; d20: number | null };
  active?: boolean;
  daily?: SuperDaily[];
  exits?: SuperExit[];
  note?: string;
  /** 메모 이력 (2026-08-27) — 날짜와 함께 쌓인다. note 는 마지막 것의 사본 */
  notes?: { date: string; text: string }[];
  /** 어느 그룹에서 온 줄인가 — super=슈퍼 원장, cross=「슈퍼신호등+교차」 관심 그룹 */
  groupTags?: ("super" | "cross")[];
  /* 서버가 스냅샷에서 붙여 주는 현재 값 */
  price: number | null;
  changeRate: number | null;
  sinceAdded: number | null;
  /** 지금 이 종목의 무리 — 든 네이버 테마 중 오늘 가장 강한 것 (2026-08-28) */
  theme?: { key: string; name: string; changeRate: number; streak: number } | null;
  /** ETF 뒷배 — 상위 3 ETF 오늘 평균 (신호등 뒷배와 같은 규칙) */
  etfBack?: { rate: number; top: string } | null;
}

export interface SuperGradeRow {
  label: string;
  /** 어느 묶음의 줄인가 — 화면이 구획을 나눠 그린다 (서버 superSignal.ts 와 같다) */
  group: "base" | "lists" | "streak" | "score" | "universe" | "regime";
  d1: { avg: number | null; n: number };
  d5: { avg: number | null; n: number };
  d20: { avg: number | null; n: number };
  /** 지수 대비 초과수익 평균(%p) — 이 줄이 없으면 위의 셋은 뜻이 없다 */
  ex1?: { avg: number | null; n: number };
  ex5?: { avg: number | null; n: number };
  ex20?: { avg: number | null; n: number };
  /** 승률(%) — 평균과 같이 봐야 뜻이 산다 */
  win1?: { rate: number | null; n: number };
  win20?: { rate: number | null; n: number };
}

export interface SuperStats {
  activeCount: number;
  exitedCount: number;
  todayAdded: number;
  win: {
    d1: { rate: number | null; n: number };
    d5: { rate: number | null; n: number };
    d20: { rate: number | null; n: number };
  };
  best: { name: string; v: number } | null;
  worst: { name: string; v: number } | null;
}

/** 백테스트 성적 — 평균 수익률과 승률 */
export interface BacktestSummary {
  n: number;
  d1: { avg: number | null; win: number | null };
  d5: { avg: number | null; win: number | null };
  d20: { avg: number | null; win: number | null };
}

/** 신호등 백테스트 결과 — 서버 signalBacktest.ts 와 같은 모양 */
export interface SignalBacktestResult {
  used: string[];
  skipped: string[];
  days: number;
  codes: number;
  rows: {
    date: string;
    code: string;
    name: string;
    score: number;
    close: number;
    d1: number | null;
    d5: number | null;
    d20: number | null;
  }[];
  green: BacktestSummary;
  base: BacktestSummary;
  /** 점수대별 — 위 칸이 아래 칸보다 잘 갔는지가 기준이 맞는지를 증명한다 */
  buckets: { label: string; from: number; to: number; s: BacktestSummary }[];
  note: string;
}

/** 기준 하나가 **혼자서** 무엇을 가르나 — 서버 signalSimulate.ts 와 같은 모양 */
export interface SignalCheckStat {
  key: string;
  label: string;
  axis: string;
  weight: number;
  threshold: number;
  strongAt: number;
  /** 표본으로 되짚을 수 있나 — 없으면 아래 성적이 전부 비어 있다 */
  inSamples: boolean;
  hit: BacktestSummary;
  mid: BacktestSummary;
  miss: BacktestSummary;
  /** 만점 무리의 20일 성적에서 0점 무리를 뺀 값(%p). 0 이면 아무것도 안 가른다 */
  edge: number | null;
}

/** 신호등 시뮬레이터 결과 */
export interface SignalSimResult {
  builtAt: string;
  days: number;
  codeCount: number;
  obs: number;
  used: string[];
  skipped: string[];
  base: BacktestSummary;
  green: BacktestSummary;
  yellow: BacktestSummary;
  red: BacktestSummary;
  buckets: { label: string; s: BacktestSummary }[];
  checks: SignalCheckStat[];
  /** 초록선을 옮겨 보며 잰 성적 — lift 는 전체 대비 20일 초과분(%p) */
  cuts: { cut: number; s: BacktestSummary; lift: number | null }[];
}

/** 조합 하나의 성적 — 앞/뒤로 갈라 잰다 */
export interface SignalSweepRow {
  keys: string[];
  labels: string[];
  n: number;
  lift: number | null;
  win: number | null;
  /** 앞쪽 절반(고르는 구간)에서의 초과분 */
  trainLift: number | null;
  /** 뒤쪽 절반(검증 구간) — **순위는 이것으로 매긴다** */
  testLift: number | null;
  testN: number;
}

/** 전수 훑기 결과 */
export interface SignalSweepResult {
  obs: number;
  splitDate: string;
  trainBase: number | null;
  testBase: number | null;
  combos: number;
  rows: SignalSweepRow[];
  current: SignalSweepRow | null;
}

export interface SuperSeriesPoint {
  date: string;
  close: number;
}

/**
 * 테마 지수 — 구성종목 일봉의 **동일가중** 평균 (첫날 = 100).
 *
 * 테마엔 지수라는 물건이 없어서 서버가 만든다. 시가총액 가중이 아닌 이유는,
 * 큰 종목 하나가 테마 전체를 대변해 버리면 「이 묶음이 같이 움직이나」에 답을
 * 못 하기 때문이다. `used < total` 이면 시가총액 상위 몇 개만 쓴 것이다.
 */
export interface ThemeSeries {
  kind: "custom" | "naver" | "kiwoom";
  name: string;
  used: number;
  total: number;
  series: SuperSeriesPoint[];
}

export interface SuperDetail {
  entry: Omit<SuperEntry, "price" | "changeRate" | "sinceAdded">;
  /** 지금 시세 — 시트 머리에 현재가(등락률)를 단다 */
  now: { price: number | null; changeRate: number | null } | null;
  stock: SuperSeriesPoint[];
  index: { code: string; name: string; series: SuperSeriesPoint[] };
  flows: { date: string; foreign: number; inst: number }[];
  signalNow: { level: string; score: number } | null;
  marketNow: { level: string; score: number; summary: string } | null;
}

/** 알림 점검 (2026-08-27) — 「왜 조용한가」를 갈래마다 */
export interface AlertHealth {
  readerConfigured: boolean;
  botConfigured: boolean;
  senders: {
    key: string;
    label: string;
    enabled: boolean | null;
    needsReader?: boolean;
    inWindow?: boolean | null;
    room: boolean;
    lastSent: string | null;
  }[];
}

export interface TelegramChannelStatus {
  /** 서버 telegram.ts 의 TelegramChannel 과 같은 목록이어야 한다 */
  channel: "report" | "signal" | "log" | "channel" | "disclosure" | "keyword" | "super" | "buzz";
  chatId: string;
  dedicated: boolean;
  /** 화면에서 재배정된 갈래인가 (.env 대신 저장된 배정이 정함) */
  overridden: boolean;
  envChatId: string;
}

export interface TelegramRoomStore {
  assign: Record<string, string>;
  custom: { name: string; chatId: string }[];
}

export interface TelegramRoomsData {
  channels: TelegramChannelStatus[];
  envRooms: { key: string; label: string; chatId: string }[];
  store: TelegramRoomStore;
}

export interface FiredAlert {
  code: string;
  name: string;
  rule: string;
  ruleLabel: string;
  detail: string;
  price: number;
  changeRate: number;
  context: string[];
}

export interface EvaluatedTheme {
  id: string;
  name: string;
  memo: string;
  codes: string[];
  color: string;
  createdAt: string;
  /** 시총 가중평균 등락률 */
  changeRate: number | null;
  /** 단순평균 — 가중과 크게 다르면 대형주가 끌고 있다는 뜻 */
  simpleRate: number | null;
  stocks: {
    code: string;
    name: string;
    changeRate: number;
    marketCap: number | null;
    /** 오늘 거래대금(억원) — 내 테마도 거래대금으로 볼 수 있게 (2026-08-30) */
    tradeValue: number | null;
    weight: number | null;
    found: boolean;
  }[];
  risingCount: number;
  fallingCount: number;
  missing: number;
  /** manual = 내가 만든 것, infostock = 인포스탁 테마표에서 옮겨온 것 */
  source?: "manual" | "infostock";
}

/** 리포트 발행 판 하나 */
export interface ScreenHit {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  /** 거래대금(백만원). 장 밖이면 직전 거래일 어림값 — 그때 `stale` 이 선다 */
  tradeValue: number;
  level: "green" | "yellow" | "red" | "unknown";
  score: number;
  passed: string[];
  failed: string[];
  /** 등락률·거래대금이 **직전 거래일 값**으로 메워진 줄 (장 밖에 돌렸을 때) */
  stale?: boolean;
  /** 렌즈 (2026-08-28) — 이 종목의 무리(가장 강한 사업 테마)와 ETF 뒷배 */
  theme?: { key: string; name: string; changeRate: number; streak: number } | null;
  etfBack?: { rate: number; top: string } | null;
}

export interface ScreenJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  results: ScreenHit[];
  market: string;
  minLevel: string;
  /** 어느 목록에서 찾았나 — 예전 기록에는 없다(거래대금 상위였다) */
  universe?: string;
  startedAt: string;
  error?: string;
  /** 지금 슈퍼신호등 원장에 있는 종목들 — 결과표가 🌟 를 단다 */
  superCodes?: string[];
}

export interface ScreenRunSummary {
  id: string;
  at: string;
  market: string;
  minLevel: string;
  universe?: string;
  total: number;
  hits: number;
}

export interface ScreenRun extends ScreenRunSummary {
  results: ScreenHit[];
}

export interface ReviewableReport {
  date: string;
  edition: string;
  label: string;
  publishedAt: string;
  count: number;
  /** 발행 후 며칠 지났나. 0이면 아직 채점할 수 없다 */
  elapsedDays: number;
}

export interface ScoredCheckpoint {
  kind: "stock" | "theme" | "market";
  key: string;
  label: string;
  direction: "up" | "down" | "flat";
  reason: string;
  basePrice: number | null;
  lastPrice: number | null;
  /** 실제 등락률(%) */
  actual: number | null;
  verdict: "hit" | "miss" | "partial" | "pending" | "unknown";
  note: string;
  /** 실제로 견준 두 거래일 — 달력 날수와 다를 수 있다 (2026-08-31) */
  baseDate?: string;
  lastDate?: string;
}

export interface ReviewResult {
  date: string;
  edition: string;
  label: string;
  publishedAt: string;
  elapsedDays: number;
  items: ScoredCheckpoint[];
  hit: number;
  miss: number;
  partial: number;
}

export interface EditionSlot {
  id: string;
  label: string;
  hour: number;
  minute: number;
  /** 어떤 프롬프트를 쓸지 */
  kind: "morning" | "intraday" | "closing" | "weekend";
  enabled: boolean;
  days: "weekday" | "weekend" | "always";
  /** 발행 후 텔레그램·메일로 보낼지 */
  deliver: boolean;
}

export interface PickAutoConfig {
  enabled: boolean;
  /** 발송 주기(분) */
  intervalMin: number;
  /** 몇 시간치를 훑을지 */
  windowHours: number;
  telegram: boolean;
  mail: boolean;
  weekdayOnly: boolean;
  startHour: number;
  endHour: number;
}

export interface ExchangeQuote {
  key: "krx" | "nxt" | "all";
  label: string;
  price: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** 거래대금(백만원) — 08~09시 NXT 프리마켓에는 KRX 쪽이 0 이라 이게 있어야 한다 */
  tradeValue: number | null;
  /** 상장주식수(천주) — 회전율의 분모 */
  shares: number | null;
  changeRate: number;
  error: string | null;
}

export interface UsQuote {
  symbol: string;
  name: string;
  price: number | null;
  changeRate: number | null;
  error: string | null;
}

export interface LinkStat {
  us: string;
  kr: string;
  /** 미국 D일 → 국내 D+1일 상관계수 */
  corr: number;
  /** 미국 1% 당 국내 평균 % */
  beta: number;
  samples: number;
}

export interface CorrelationResult {
  at: string;
  days: number;
  pairs: {
    label: string; us: string; kr: string;
    sameDay: number | null; nextDay: number | null;
    samples: number; beta: number | null;
  }[];
  krFetched: number;
  krFailed: number;
}

export interface EvaluatedLink {
  label: string;
  us: string[];
  kr: string[];
  memo?: string;
  usQuotes: UsQuote[];
  usAvg: number | null;
  krThemes: { name: string; changeRate: number | null; found: boolean }[];
  krAvg: number | null;
  /** 미국 대비 국내가 얼마나 따라왔는가(%p) */
  gap: number | null;
  /** 검증된 연동 강도. 아직 계산 전이면 null */
  stat: LinkStat | null;
  /** 평소 연동대로면 국내가 갔어야 할 등락률 */
  expected: number | null;
  /** 기대 대비 실제(%p) */
  surprise: number | null;
}

export interface RankSpecGroup {
  group: string;
  items: { key: string; label: string }[];
}

export interface RankResult {
  spec: {
    key: string;
    label: string;
    columns: { key: string; label: string; type?: "text" | "price" | "num" | "pct" | "signed" }[];
    exchange: boolean;
    note: string;
  };
  market: string;
  exchange: string;
  /**
   * code·name 은 항상 있고, 나머지는 명세의 컬럼 키로 들어온다.
   *
   * `cap`·`tv`·`mkt`·`sector`·`common` 은 **거르라고 서버가 얹어 주는 값**이다 —
   * 키움 순위 TR 에는 시가총액이 없어서 종목 목록(하루 캐시)에서 붙인다.
   */
  rows: (Record<string, unknown> & {
    code: string;
    name: string;
    /** 시가총액(억원). 상장주식수를 못 찾으면 null */
    cap: number | null;
    /** 거래대금(억원). 못 내면 null */
    tv: number | null;
    /** 거래대금이 어림값(거래량 × 현재가)인가 */
    tvEst: boolean;
    /** KRX 몫의 거래대금(억원). `tv` 는 통합(=KRX+NXT)이다 */
    tvKrx: number | null;
    /** 통합(NXT 최종) 가격 — KRX 로 덮기 전 원값. KRX 와 같으면 null */
    nxtPrice?: number | null;
    nxtRate?: number | null;
    /** 회전율(%) — 거래량 ÷ 상장주식수. 「그 종목 치고 얼마나 돌았나」 */
    turn: number | null;
    /** 코스피 / 코스닥 */
    mkt: string;
    sector: string;
    /** ETF·ETN·리츠·우선주가 아닌 보통주인가 */
    common: boolean;
    /** ETF 인가 — 「ETF만」 필터가 쓴다 */
    etf: boolean;
  })[];
}

export interface SectorFlowStat {
  code: string;
  name: string;
  /** "코스피 전기/전자" */
  label: string;
  market: "kospi" | "kosdaq";
  /** 기간 누적 순매수(억원) */
  sum: number;
  today: number;
  delta: number;
  rank: number;
  /** 직전 기간 대비 순위 변화. +면 올라온 것 */
  rankChange: number | null;
}

export interface SectorConsensus {
  code: string;
  name: string;
  label: string;
  market: "kospi" | "kosdaq";
  /** consensusSubjects 순서대로의 기간 누적 */
  values: number[];
  /** 같은 방향으로 움직인 주체 수 */
  agree: number;
  side: 1 | -1;
  total: number;
}

export interface SectorFlowResult {
  subject: string;
  subjectLabel: string;
  window: number;
  dates: string[];
  stats: SectorFlowStat[];
  streaks: {
    code: string;
    name: string;
    label: string;
    market: "kospi" | "kosdaq";
    streak: number;
    sum: number;
  }[];
  splits: {
    code: string;
    name: string;
    label: string;
    market: "kospi" | "kosdaq";
    pension: number;
    trust: number;
  }[];
  /** 여러 주체가 같은 방향으로 움직인 업종 */
  consensusBuy: SectorConsensus[];
  consensusSell: SectorConsensus[];
  /** values 배열의 순서와 이름 */
  consensusSubjects: { key: string; label: string }[];
  sizes: { label: string; foreign: number; institution: number }[];
  subjects: { key: string; label: string }[];
}

export interface TradeSummary {
  key: string;
  label: string;
  hs: string;
  sectors: string[];
  note: string;
  /** 이 품목에서 봐야 할 쪽. 원유처럼 사오기만 하는 품목은 수입을 본다 */
  watch: "export" | "import";
  month: string;
  exportUsd: number;
  importUsd: number;
  balanceUsd: number;
  exportYoy: number | null;
  importYoy: number | null;
  top: { name: string; exportUsd: number; yoy: number | null }[];
}

export interface BreadthPoint {
  date: string;
  advanceDecline: number;
  adLine: number;
  risingPct: number;
  newHigh: number;
  newLow: number;
  highLowDiff: number;
  kospiRate: number;
  kosdaqRate: number;
  foreign: number;
  institution: number;
  individual: number;
  foreignCum: number;
  instCum: number;
  individualCum: number;
}

export type SignalLevel = "green" | "yellow" | "red" | "unknown";

export type SignalAxis = "trend" | "flow" | "value" | "risk";

export interface SignalCheck {
  key: string;
  label: string;
  axis: SignalAxis;
  /** 0 · 50 · 100. 판단 불가면 null */
  grade: number | null;
  /**
   * 통과 여부. 일반 기준은 grade >= 50, **위험 기준은 반대로** grade < 50(안전)이 통과다.
   * 그래서 위험 기준의 이름은 「매물 부담 낮음」처럼 안전한 상태로 적혀 있다.
   */
  pass: boolean | null;
  value: string;
  weight: number;
  link?: { kind: "sector" | "theme"; code: string; name: string };
  /** ETF 뒷배 — 상위 셋. 눌러서 각 ETF 를 연다 (2026-08-28) */
  etfs?: { code: string; name: string; weight: number | null; changeRate: number | null }[];
}

export interface SignalAxisResult {
  key: SignalAxis;
  label: string;
  /** 0~100. 위험 축은 **위험도**(높을수록 나쁘다), 나머지는 높을수록 좋다 */
  score: number | null;
  level: SignalLevel;
}

export interface SignalResult {
  code: string;
  level: SignalLevel;
  /** 추세·수급·실적 세 축의 가중평균. 위험은 섞지 않는다 */
  score: number;
  checks: SignalCheck[];
  axes: SignalAxisResult[];
  /** 위험이 빨강이라 초록이 막혔나 */
  riskCapped: boolean;
  /**
   * **탈락 조건에 걸린 기준 이름들** (2026-09-01) — 비어 있으면 탈락 없음.
   *
   * 탈락은 위험 축과 다르다. 위험은 평균이라 하나가 커도 묻히는데, 탈락은
   * **하나라도 걸리면 그것으로 빨강**이다. 「점수가 높아도 이건 안 된다」를
   * 말하는 자리다.
   */
  vetoedBy?: string[];
  evaluatedAt: string;
}

export interface SignalCheckConfig {
  key: string;
  label: string;
  axis: SignalAxis;
  enabled: boolean;
  weight: number;
  /** 50점 선 */
  threshold: number;
  /** 100점 선 */
  strongAt: number;
  hint: string;
  /**
   * **이 기준이 며칠을 되짚나** — 뜻은 기준마다 다르다(`hint` 참고).
   *
   *   수급 지속    여기까지의 구간만 본다 (60 이면 5·10·20·60 넷)
   *   수급 가속    견줄 긴 쪽. 짧은 쪽은 늘 그 1/4
   *   주포·프로그램  누적 거래일 수
   *   외국인 지분율  며칠 전과 견주나
   *
   * 없으면 기간이라는 개념이 없는 기준이다(신고가·정배열처럼).
   */
  span?: number;
  /** 켜면 종목당 조회가 몇 번 더 나가나 — 「신호등 찾기」 100종목이면 그 100배다 */
  cost: number;
  /** 같은 호출을 나눠 쓰는 기준끼리 묶는 이름. 비용을 셀 때 묶음마다 한 번만 센다 */
  costGroup?: string;
}

export interface SignalConfig {
  checks: SignalCheckConfig[];
  greenAt: number;
  yellowAt: number;
  flowDays: 5 | 10 | 20;
  maLines: number[];
  /** 축끼리의 가중치 */
  axisWeights: Record<"trend" | "flow" | "value", number>;
  /** 위험도가 이 이상이면 노랑 */
  riskYellowAt: number;
  /** 위험도가 이 이상이면 빨강 */
  riskRedAt: number;
  /** 위험이 빨강이면 종합을 초록으로 올리지 않는다 */
  riskBlocksGreen: boolean;
}

export interface StockNote {
  id: string;
  at: string;
  price: number;
  changeRate: number;
  text: string;
}

/** 서버 `calendar.ts` 의 EventKind 와 같아야 한다 (2026-08-28 이벤트·학회 추가) */
export type EventKind =
  | "market"
  | "personal"
  | "earnings"
  | "holiday"
  | "event"
  | "conference"
  /* 리서치 캘린더 양식 (2026-08-30) — 「증시」 하나에 뭉쳐 있던 것을 가른다 */
  | "indicator"
  | "meeting"
  | "bond"
  | "deriv"
  /** 날짜 일정이 아니라 **그 주의 요약** — 그 주 일요일에 달아 둔다 */
  | "weekly";

export interface CalendarEvent {
  id: string;
  date: string;
  time?: string;
  /** 끝나는 시각. 없고 time 만 있으면 화면에서 한 시간짜리로 본다 */
  endTime?: string;
  /** 며칠짜리 일정의 마지막 날. 없으면 하루짜리 (2026-08-31) */
  endDate?: string;
  /**
   * **화면에서만 붙는 표시** — 서버에 이런 값은 없다 (2026-08-31).
   *
   * 며칠짜리 일정을 날짜별 묶음으로 펼칠 때 「3일 중 2일째」를 적으려고 사본에 단다.
   * 저장 요청에 실어 보내면 안 된다.
   */
  span?: { i: number; of: number };
  title: string;
  kind: EventKind;
  memo?: string;
  /** 반복 — date 가 첫 회. 조회 시 인스턴스(id 에 @날짜)로 전개돼 온다 */
  repeat?: "weekly" | "monthly" | "yearly";
  /** 할 일 — 체크로 끝내는 것 */
  todo?: boolean;
  done?: boolean;
  /** (전개 인스턴스에만) 원본 날짜 */
  anchor?: string;
  /** 어느 나라 일정인가 — 비우면 화면이 아무것도 안 쓴다 */
  country?: string;
  /** 그날의 대표 일정 — 주간 브리핑 맨 위로 올라간다 */
  headline?: boolean;
  /** 서버가 붙여 주는 나라 후보 (읽기 전용) */
}

export interface AiSummary {
  text: string | null;
  basedOn: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  digest?: string;
}

export interface PublishedReport {
  date: string;
  edition: string;
  label: string;
  publishedAt: string;
  summary: AiSummary;
}

export interface PublishedReportResponse {
  report: PublishedReport | null;
  requested: { date: string; edition: string };
  editions: { key: string; label: string; hour: number }[];
  recent: { date: string; edition: string }[];
}

export interface ThemeWithReason {
  code: string;
  name: string;
  changeRate: number;
  stockCount: number;
  mainStock: string;
  reasons: ScoredNews[];
}

export interface SectorWithReason {
  code: string;
  name: string;
  changeRate: number;
  market: "코스피" | "코스닥";
  reasons: ScoredNews[];
}

/** 웹·메일·텔레그램이 공유하는 리포트 조립 결과 */
export interface MarketDriverReport {
  fetchedAt: string;
  themes: { up: ThemeWithReason[]; down: ThemeWithReason[] };
  sectors: SectorWithReason[];
}

export interface StockRow {
  marketCap?: number | null;
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
}

export interface SectorRow {
  code: string;
  name: string;
  changeRate: number;
}

export interface ThemeRow {
  code: string;
  name: string;
  changeRate: number;
  stockCount: number;
  mainStock: string;
}

export interface GlobalQuote {
  key: string;
  label: string;
  group: string;
  symbol: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  isRate: boolean;
  error: string | null;
  /** 묶음 색 — 서버가 정한다. 시황과 리포트가 같은 색을 쓰게 하려는 것이다 */
  color: string;
  /** 줄 단위 경고. 색만 있으면 왜 빨간지 모르므로 why 를 같이 준다 */
  signal: RowSignal | null;
}

export interface ProviderUsage {
  provider: string;
  label: string;
  limit: number | null;
  note: string;
  total: number;
  ok: number;
  failed: number;
  rateLimited: number;
  usageRate: number | null;
  topEndpoints: { endpoint: string; count: number }[];
  /** 실패 사유별 — 실패 건수만 보면 무엇을 고쳐야 할지 알 수 없다 */
  failReasons: { reason: string; count: number }[];
  /** AI provider 전용 — 토큰과 추정 비용(USD) */
  tokens: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    webSearches: number;
    estimatedUsd: number;
    byModel: { model: string; calls: number; input: number; output: number; usd: number }[];
    byFeature: { feature: string; label: string; calls: number; usd: number }[];
    detail: {
      feature: string;
      label: string;
      model: string;
      calls: number;
      input: number;
      output: number;
      usd: number;
    }[];
    hasLegacy: boolean;
  } | null;
}

export interface UsageTotals {
  from: string;
  to: string;
  days: number;
  estimatedUsd: number;
  byFeature: { feature: string; label: string; calls: number; usd: number }[];
  byModel: { model: string; calls: number; input: number; output: number; usd: number }[];
  byDay: { day: string; usd: number }[];
  hasLegacy: boolean;
}

export interface FinancialPeriod {
  label: string;
  revenue: number | null;
  operatingProfit: number | null;
  netIncome: number | null;
  assets: number | null;
  liabilities: number | null;
  equity: number | null;
}

export interface DividendInfo {
  yieldRate: number | null;
  perShare: number | null;
  payoutRatio: number | null;
  eps: number | null;
}

export interface QuarterRow {
  period: string;
  /** 2026 3Q */
  label: string;
  /** **그 분기만의** 값 (한투가 주는 누적을 되돌린 것). 단위 억원 */
  revenue: number | null;
  operatingProfit: number | null;
  netIncome: number | null;
  /** 영업이익률 (%) */
  margin: number | null;
  /** 직전 분기 대비 영업이익 증감률 (%) */
  qoq: number | null;
  /** 1년 전 같은 분기 대비 (%) */
  yoy: number | null;
}

export interface EstimateColumn {
  /** 2026.12E 처럼 뒤에 E 가 붙으면 추정치다 */
  period: string;
  revenue: number | null;
  revenueGrowth: number | null;
  operatingProfit: number | null;
  operatingGrowth: number | null;
  netIncome: number | null;
  netGrowth: number | null;
  roe: number | null;
  debtRatio: number | null;
  per: number | null;
  eps: number | null;
}

export interface EstimateResult {
  code: string;
  name: string;
  opinion: string | null;
  estimatedAt: string | null;
  columns: EstimateColumn[];
}

export interface FinanceResult {
  basis: "연결" | "별도" | null;
  /** DART 연간 — 단위는 **원**이다 */
  periods: FinancialPeriod[];
  /** 한투 분기 — 단위는 **억원**이다. 연간과 단위가 다르니 섞어 쓰면 안 된다 */
  quarters: QuarterRow[];
  /** 애널리스트 추정 (한투). 160여 개 대형주만 있고 없으면 null 이다 */
  estimate: EstimateResult | null;
  dividend: DividendInfo | null;
  note: string | null;
}

export interface SectorMood {
  code: string;
  name: string;
  changeRate: number;
  rank: number | null;
  total: number | null;
  market: "코스피" | "코스닥";
  marketKey: "kospi" | "kosdaq";
}

export interface ThemeMood {
  code: string;
  name: string;
  changeRate: number;
  stockCount: number;
  risingCount: number;
  fallingCount: number;
  periodReturn: number;
  mainStocks: string;
}

export interface MoodResult {
  sector: SectorMood | null;
  themes: ThemeMood[];
  note?: string;
  /** 표준산업분류 (한투). 키움 업종보다 자세하다 — 등락률은 없고 이름만 있다 */
  industry?: string | null;
  /**
   * 네이버 테마 (2026-08-28) — **종목마다 편입 사유가 붙는다.**
   * 「가온전선: LS그룹 계열사로 전력케이블 및 통신케이블 등을 생산하는…」
   * 키움 테마는 왜 묶였는지를 말해 주지 않아서, 이 한 줄이 이 화면에서 제일 쓸모 있다.
   * 서버가 파일에서 읽어 붙여 주므로 조회가 늘지 않는다.
   */
  naverThemes?: { no: number; name: string; desc: string }[];
}

export interface NewsItem {
  title: string;
  press: string;
  link: string;
  originalLink: string;
  publishedAt: string;
  major: boolean;
  summary: string;
}

/** 섹터 뉴스는 점수·보도량 정보가 더 붙는다 */
export interface ScoredNews extends NewsItem {
  coverage: number;
  alsoPress: string[];
  mentions: string[];
  score: number;
}

export interface DisclosureItem {
  reportName: string;
  filerName: string;
  receiptDate: string;
  receiptNo: string;
  url: string;
}

export interface ProgramRow {
  time: string;
  arbSell: number;
  arbBuy: number;
  arbNet: number;
  nonArbSell: number;
  nonArbBuy: number;
  nonArbNet: number;
  allSell: number;
  allBuy: number;
  allNet: number;
}

export interface ViRow {
  code: string;
  name: string;
  motionPrice: number;
  openChangeRate: number;
  releaseTime: string;
  motionCount: number;
}

/** 콤마 포함 숫자 포맷. 값이 숫자가 아니면 "-" */
export function fmtNum(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return n.toLocaleString("ko-KR");
}

/** cur_prc 등 "부호가 포함된 숫자"로 오는 가격 필드용 - 절댓값으로 표시 */
export function fmtAbsNum(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "-";
  return Math.abs(n).toLocaleString("ko-KR");
}

/** 양수면 positive(빨강), 음수면 negative(파랑) 클래스 */
export function signClass(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n) || n === 0) return "";
  return n > 0 ? "positive" : "negative";
}

/**
 * 키움 응답 필드는 문서 접근 없이는 100% 확정하기 어려워, 흔히 쓰이는 후보 키 여러 개를
 * 순서대로 시도해서 값을 찾는다. 실제 응답을 콘솔/원본 JSON 뷰로 확인 후 필요하면
 * 이 목록에 실제 필드명을 추가하면 된다.
 */
export function pick(record: RawRecord | undefined, keys: string[]): string {
  if (!record) return "-";
  for (const key of keys) {
    const value = record[key];
    if (value !== undefined && value !== null && value !== "") {
      return String(value);
    }
  }
  return "-";
}

export function pickList(record: RawRecord | undefined, keys: string[]): RawRecord[] {
  if (!record) return [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value as RawRecord[];
  }
  // 후보 키에 못 찾으면, 배열 타입인 첫 필드를 자동으로 사용
  for (const value of Object.values(record)) {
    if (Array.isArray(value)) return value as RawRecord[];
  }
  return [];
}

/**
 * 종목코드를 순수 6자리로 정규화한다.
 * 키움은 응답에 따라 접두어("A005930": 주식/J:ELW/Q:ETN)나
 * 거래소 접미어("226340_AL": 통합, "_NX": NXT)를 붙여 보낸다.
 */
export function normalizeStockCode(code: string): string {
  const withoutSuffix = code.replace(/_(AL|NX)$/, "");
  return /^[A-Z]\d{6}$/.test(withoutSuffix) ? withoutSuffix.slice(1) : withoutSuffix;
}

/** 발행 진행 상황 — 서버가 단계별로 채운다 */
export type JobKind = "report" | "channel" | "cis";

export interface ProgressStep {
  key: string;
  label: string;
  state: "pending" | "running" | "done" | "failed" | "skipped";
  note?: string;
  ms?: number;
}

export interface PublishJob {
  status: "running" | "done" | "error";
  /** 어느 화면이 시작한 작업인가 — 돌아왔을 때 자기 작업을 되찾는 데 쓴다 */
  kind: JobKind;
  label: string;
  steps: ProgressStep[];
  startedAt: string;
  report?: { date: string; edition: string; label: string };
  error?: string;
}


/** 시장 전체 신호등 */
export interface MarketCheck {
  key: string;
  label: string;
  pass: boolean | null;
  value: string;
  why: string;
  weight: number;
}

export interface MarketSignal {
  level: "green" | "yellow" | "red" | "unknown";
  score: number;
  checks: MarketCheck[];
  summary: string;
  evaluatedAt: string;
}


/** 모의투자 */
export interface EntryEvidence {
  level: "green" | "yellow" | "red" | "unknown";
  score: number;
  checks: { key: string; label: string; pass: boolean | null; value: string }[];
  market: { level: string; score: number; summary: string } | null;
  themes: { name: string; changeRate: number | null }[];
  sector: { name: string; foreign5: number; inst5: number } | null;
  marketBreadth: string | null;
}

export interface EvaluatedTrade {
  id: string;
  code: string;
  name: string;
  entryAt: string;
  entryPrice: number;
  qty: number;
  thesis: string;
  evidence: EntryEvidence;
  exitAt?: string | null;
  exitPrice?: number | null;
  exitNote?: string | null;
  price: number;
  pnl: number;
  returnRate: number;
  open: boolean;
  holdingDays: number;
}

export interface EvidenceEdge {
  key: string;
  label: string;
  withCount: number;
  withWinRate: number | null;
  withAvgReturn: number | null;
  withoutCount: number;
  withoutWinRate: number | null;
  withoutAvgReturn: number | null;
  edge: number | null;
}

export interface PaperResult {
  trades: EvaluatedTrade[];
  stats: {
    invested: number;
    value: number;
    pnl: number;
    returnRate: number;
    openCount: number;
    closedCount: number;
    winRate: number | null;
    avgReturn: number | null;
  };
  edges: EvidenceEdge[];
}


/** 종목 한 장 요약 */
export interface StockSummaryData {
  code: string;
  date: string;
  facts: {
    price: number;
    changeRate: number;
    /** 억원 */
    marketCap: number | null;
    shares: number | null;
    /** 억원 */
    tradeValue: number | null;
    volume: number;
    /** % */
    turnover: number | null;
    strength: number | null;
    prevClose: number;
    high: number;
    low: number;
    open: number;
    upperLimit: number;
    lowerLimit: number;
  };
  /** 순매수 금액(백만원). 부호가 방향이다 */
  main: { key: string; label: string; amount: number }[];
  institution: { key: string; label: string; amount: number }[];
  /** 프로그램 순매수(백만원) — 위 셋과 **겹치는 값**이라 더하면 안 된다 */
  program: number | null;
  /** 못 받은 조각 — 「0」과 「못 받음」은 다르다 */
  missing: string[];
  /**
   * 일자별 **누적** 수급(백만원) — 같은 응답의 나머지 날로 만든다(조회 0회 추가).
   * ⚠️ 장중이 아니라 일자별이다 — 개별 종목의 장중 투자자별 누적은 출처가 없다.
   */
  flowSeries: { date: string; main: Record<string, number>; inst: Record<string, number> }[];
  /**
   * 오늘 **장중** 누적 — 종목 화면이 부를 때마다 한 점씩 쌓인 것이다.
   * ⚠️ **보고 있는 동안만 쌓인다.** 안 열어 둔 시간은 빈다.
   */
  intraday: {
    /** HH:MM */
    t: string;
    ind: number;
    frgn: number;
    orgn: number;
    etc: number;
    fnnc: number;
    invt: number;
    penf: number;
    samo: number;
    insr: number;
    bank: number;
    etcf: number;
  }[];
}

/** 장중 기준선 — VWAP·시가갭·전일고저·장초반 30분 */
export interface IntradayLevels {
  code: string;
  date: string;
  price: number;
  open: number;
  high: number;
  low: number;
  /** ⚠️ 분봉 전형가로 낸 **어림값** — 진짜 VWAP 은 체결 단위라 REST 로 못 받는다 */
  vwap: number | null;
  vsVwap: number | null;
  prevClose: number | null;
  prevHigh: number | null;
  prevLow: number | null;
  gapPct: number | null;
  /** 갭이 ±0.5% 안이면 `null` — 메울 갭이 없다 */
  gapFilled: boolean | null;
  or30High: number | null;
  or30Low: number | null;
  bars: number;
}

/* ── 키움 미국 세부 ────────────────────────────────────────── */

export interface UsKiwoomDetailData {
  summary: {
    symbol: string;
    stex: string;
    name: string;
    sectorLg: string;
    sectorSm: string;
    /** 백만 달러 */
    marketCap: number | null;
    shares: number | null;
    price: number | null;
    changeRate: number | null;
    volume: number | null;
    week52: {
      high: number | null;
      highDate: string;
      highGap: number | null;
      low: number | null;
      lowDate: string;
      lowGap: number | null;
    };
    pre: { open: number | null; high: number | null; low: number | null };
    baseClose: number | null;
    exchangeRate: number | null;
  } | null;
  book: {
    asks: { price: number | null; qty: number }[];
    bids: { price: number | null; qty: number }[];
    totalAsk: number;
    totalBid: number;
    tradeValue: number | null;
    turnover: number | null;
    at: string;
    date: string;
  } | null;
  unsupported?: string;
}

/* ── 마켓 브리핑 ───────────────────────────────────────────── */

/** 타임라인 한 줄. `t` 가 "HH:mm" 이 아니면(공시) 시각 없는 묶음이다 */
export interface BriefingEvent {
  t: string;
  kind: string;
  badge: string;
  code?: string;
  name: string;
  summary: string;
  source?: string;
  watch: boolean;
  link?: string;
}

export interface BriefingTile {
  code: string;
  name: string;
  rate: number | null;
  /** 억원 — 툴팁에만 (칸 크기는 균등 격자로 바뀜) */
  cap: number | null;
  status: string;
  /** 대표 그룹 — 슈퍼신호등이 있으면 그것, 아니면 그룹 정렬순 첫 그룹 */
  group: string;
}

/* ── 조건 백테스트 ─────────────────────────────────────────── */

export type BacktestRuleKey =
  | "maAlign"
  | "aboveMa"
  | "volSurge"
  | "newHigh"
  | "minRate"
  | "nearHigh52"
  | "disparity"
  | "volValue"
  | "gapUp"
  | "minScore";

export interface BacktestRuleDef {
  key: BacktestRuleKey;
  label: string;
  hint: string;
  hasValue: boolean;
  defaultValue: number;
}

export interface BacktestConfig {
  market: string;
  universe: number;
  /** 며칠 들고 있다 파나 (거래일) */
  holdDays: number;
  rules: { key: BacktestRuleKey; value: number }[];
}

export interface BacktestStat {
  count: number;
  avg: number;
  median: number;
  winRate: number;
  best: number;
  worst: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  hit: BacktestStat;
  /** 조건을 안 걸고 같은 기간·같은 종목에서 잰 것 — 이게 없으면 위 숫자는 못 읽는다 */
  base: BacktestStat;
  /** 조건이 만든 차이(%p) — 진짜 봐야 할 숫자 */
  edge: number | null;
  codes: number;
  failed: number;
  from: string;
  to: string;
  samples: { code: string; name: string; date: string; rate: number }[];
}

export interface BacktestJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  startedAt: string;
  result: BacktestResult | null;
  error?: string;
}

/** 복기 노트 */
export interface DayContext {
  marketLevel: string;
  marketScore: number;
  marketSummary: string;
  breadth: string | null;
  trend: string | null;
  topThemes: { name: string; changeRate: number }[];
  bottomThemes: { name: string; changeRate: number }[];
  /** 그날 국내 선물 순매수(계약) — 2026-08-27 박제 */
  futures?: { foreign: number; institution: number; individual: number } | null;
}

/** 예측 종목 (2026-08-27) — 내일 오를까 내릴까. 다음 거래일 종가로 채점된다 */
export interface JournalPick {
  id: string;
  code: string;
  name: string;
  dir: "up" | "down";
  note?: string;
  basePrice?: number;
  market?: { level: string; score: number };
  signal?: { level: string; score: number };
  futForeign?: number;
  result?: { date: string; close: number; rate: number; hit: boolean };
}

/** 예측 성적 */
export interface PickStats {
  graded: number;
  pending: number;
  hitRate: number | null;
  avgEdge: number | null;
  up: { n: number; hitRate: number | null };
  down: { n: number; hitRate: number | null };
  byMarket: { level: string; n: number; hitRate: number; avgEdge: number }[];
  byFutures: { band: "매수" | "중립" | "매도"; n: number; hitRate: number; avgEdge: number }[];
  byStock: { code: string; name: string; n: number; hitRate: number; avgEdge: number }[];
  /** 예측한 순간 그 종목 신호등 색깔별 적중률 (2026-08-29) */
  bySignal: { level: string; n: number; hitRate: number; avgEdge: number }[];
  /** 나아지고 있나 — 최근 10건 vs 그 이전 (표본이 적으면 null) */
  trend: { recent: number | null; earlier: number | null; recentN: number; earlierN: number };
  recent: {
    date: string;
    code: string;
    name: string;
    dir: "up" | "down";
    rate: number;
    hit: boolean;
    note?: string;
    market?: { level: string; score: number };
    signal?: { level: string; score: number };
    gradedAt: string;
  }[];
}

export interface JournalTrade {
  id: string;
  kind: "buy" | "sell";
  code: string;
  name: string;
  price: number;
  qty: number;
  note: string;
  /** 근거 태그 — 자유 서술은 그대로 두고, 셀 수 있는 형태를 같이 받는다 */
  reasons?: string[];
  level?: string;
  score?: number;
  passed?: string[];
  /** 기록 시점의 당일 외인·기관 순매수 (백만원) */
  flow?: { foreign: number; inst: number };
  /** 손절선(원) — 살 때만 적는다. R 배수의 분모 */
  stop?: number;
  /** 목표가(원) */
  target?: number;
  /** 이 매매에 건 위험 — 계좌 대비 % */
  risk?: number;
}

export interface JournalEntry {
  date: string;
  updatedAt: string;
  /** 오늘 매매했나 쉬었나 — 안 사는 것도 판단이다 */
  stance?: "trade" | "watch" | null;
  /** 쉰 이유 */
  watchReasons?: string[];
  what: string;
  why: string;
  followedRules: boolean | null;
  brokenRule: string;
  trades: JournalTrade[];
  mistakes: string[];
  mood: string;
  lesson: string;
  tomorrow: string;
  /** 오늘의 예측 */
  picks?: JournalPick[];
  context: DayContext | null;
}

export interface JournalStats {
  /** 예측 성적 — 「내 판단이 실제로 맞는가」 */
  picks: PickStats;
  days: number;
  streak: number;
  ruleRate: number | null;
  mistakes: { key: string; label: string; count: number }[];
  moods: { key: string; label: string; count: number; ruleRate: number | null }[];
  ruleEdge: {
    keptDays: number;
    keptAvgReturn: number | null;
    brokeDays: number;
    brokeAvgReturn: number | null;
  };
  /** 전체 실현 R — 손절선을 적은 매매에서만 */
  rStat: { count: number; avg: number | null; best: number | null; worst: number | null };
  reasonEdge: EdgeRow[];
  signalEdge: EdgeRow[];
  marketEdge: EdgeRow[];
  watch: {
    days: number;
    tradeDays: number;
    reasons: { key: string; label: string; count: number }[];
    byMarket: { key: string; count: number }[];
    tradeByMarket: { key: string; count: number }[];
  };
  /** 판단 vs 실행 — 예측 적중률과 실현 매매 승률 (둘 다 있을 때만) */
  judgeVsAct: { pickHit: number | null; tradeWin: number | null; tradeN: number } | null;
  lessons: { date: string; lesson: string }[];
}

/** 무엇으로 묶든 성적은 같은 모양 */
export interface EdgeRow {
  key: string;
  label: string;
  /** 판 건수 — 적으면 평균이 우연이다 */
  count: number;
  avgReturn: number;
  winRate: number;
  /** 평균 실현 R — 손절선을 적은 매매에서만. 승률 옆에 꼭 같이 본다 */
  avgR: number | null;
  /** R 을 낼 수 있었던 건수 */
  rCount: number;
}

export interface JournalData {
  entries: JournalEntry[];
  stats: JournalStats;
  mistakeTags: { key: string; label: string; hint: string }[];
  moodTags: { key: string; label: string }[];
  reasonTags: { key: string; label: string; hint: string }[];
  watchTags: { key: string; label: string; hint: string }[];
}


/** 오늘 공시 (DART) */
export interface DartEvent {
  corpName: string;
  stockCode: string;
  market: string;
  title: string;
  date: string;
  url: string;
  weight: number;
  watched: boolean;
  themes: string[];
  amended: boolean;
}

/**
 * 종목의 **정적** 사실 — DART 기업개황 + 한투 표준산업분류.
 *
 * 설립일·대표자·본사는 한 달에 한 번만 받으면 된다. 「최근 동향」처럼 낡는 값이
 * 여기 섞이면 안 된다 — 그건 아래 `CompanyBrief` 가 날짜를 달고 따로 산다.
 */
export interface CompanyFacts {
  code: string;
  corpName: string | null;
  corpNameEng: string | null;
  ceo: string | null;
  /** YYYYMMDD */
  establishedAt: string | null;
  accountMonth: string | null;
  address: string | null;
  /** 프로토콜이 없이 오기도 한다 — 링크로 쓸 땐 붙여야 한다 */
  homepage: string | null;
  irUrl: string | null;
  marketName: string | null;
  indutyCode: string | null;
  sectorLarge: string | null;
  sectorMid: string | null;
  sectorSmall: string | null;
  /** 표준산업분류 이름 — "반도체 제조업" */
  industry: string | null;
  fetchedAt: string;
}

/** AI 가 엮은 서술. **날짜를 달고 산다** — 같은 날이면 다시 안 엮는다 */
export interface CompanyBrief {
  code: string;
  name: string;
  /** YYYY-MM-DD (KST) */
  day: string;
  at: string;
  text: string;
  model: string | null;
  /** 무엇을 엮었는지 */
  sources: string[];
  inputTokens: number;
  outputTokens: number;
}

/** 관심종목 (미국) */
export interface UsSearchResult {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
  /** 국가 (USA/JPN/HKG/CHN…) — 네이버 검색 결과에만 있다 */
  nation?: string;
}

export interface UsQuoteRow {
  symbol: string;
  name: string;
  price: number | null;
  changeRate: number | null;
  returnRate: number | null;
  addedPrice: number | null;
  memo: string;
  marketState: string | null;
  /** Yahoo 가 알려준 체결 시각(ms) */
  quotedAt: number | null;
  error: string | null;
  /** 원화 환산가 (한국투자증권) */
  /*
   * 미국 주간거래(오버나이트) — **프리마켓이 아니다.**
   * 미 동부 프리마켓은 한국 밤이라 우리가 볼 때는 이미 끝나 있다.
   * 이건 한국 낮에 열리는 세션이고, 국내장이 도는 동안 움직이는 미국 가격은 이것뿐이다.
   */
  /** 애프터장 (미 동부 16:00~20:00) — 괄호에 들어간다 */
  afterPrice: number | null;
  afterChangeRate: number | null;
  dayPrice: number | null;
  dayChangeRate: number | null;
  dayVolume: number | null;
  wonPrice: number | null;
  /** 오늘 거래량 ÷ 전일 거래량 × 100 */
  volumeVsPrev: number | null;
  /** 52주 구간에서 지금 위치 (0=저가, 100=고가) */
  pos52: number | null;
  high52: number | null;
  low52: number | null;
  /** 체결강도 — 100 보다 크면 사는 쪽이 세다 */
  power: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  /** 한투가 알려준 장 상태 */
  state: string | null;
  /** 통화 — 나라가 섞이면 78.89 가 달러인지 엔인지 알 수 없다 */
  currency: string | null;
  country: string | null;
  flag: string | null;
  source: "hantoo" | "yahoo";
}

export interface UsWatchGroup {
  id: string;
  name: string;
  memo: string;
  changeRate: number | null;
  rising: number;
  falling: number;
  stocks: UsQuoteRow[];
}

export interface UsWatchResult {
  groups: UsWatchGroup[];
  /** 거래소 마지막 체결 시각(ms) */
  quotedAt: number | null;
  /** 우리가 받아온 시각(ms) */
  fetchedAt: number;
}


/** 내 관심 키워드 */
export interface KeywordConfig {
  enabled: boolean;
  intervalMin: number;
  keywords: string[];
  useWatchlist: boolean;
  useThemes: boolean;
  weekdayOnly: boolean;
  startHour: number;
  endHour: number;
  maxPerRun: number;
}

export interface KeywordSource {
  word: string;
  from: string;
}

export interface KeywordHit {
  key: string;
  channelName: string;
  at: string;
  text: string;
  link: string;
  words: string[];
}

export interface KeywordRunResult {
  scanned: number;
  matched: number;
  sent: number;
  skipped: number;
  hits: KeywordHit[];
  error?: string;
}


/** 관심종목 공시 알림 */
export interface DisclosureAlertConfig {
  enabled: boolean;
  intervalMin: number;
  watchedOnly: boolean;
  includeThemes: boolean;
  marketWeightMin: number;
  weekdayOnly: boolean;
  startHour: number;
  endHour: number;
  maxPerRun: number;
}

export interface DisclosureHit {
  event: DartEvent;
  reason: string;
}

export interface DisclosureRunResult {
  scanned: number;
  matched: number;
  sent: number;
  skipped: number;
  hits: DisclosureHit[];
  error?: string;
}


/* ------------------------------------------------------------------ */
/* 시장 맥박 — 돈이 어디로 가고 있나                                    */
/* ------------------------------------------------------------------ */

export type PhaseKey =
  | "foreignLed"
  | "instLed"
  | "bothIn"
  | "retailOnly"
  | "bothOut"
  | "mixed";

export interface PulseFlow {
  /** 5일 누적 순매수 (억원) */
  foreign5: number;
  inst5: number;
  individual5: number;
  foreign20: number;
  inst20: number;
  individual20: number;
  /** 양수면 연속 순매수 일수, 음수면 연속 순매도 일수 */
  foreignStreak: number;
  instStreak: number;
  /** 실제 계산에 쓴 일수 — 「20일 누적」이 9일치면 화면이 그렇게 적는다 */
  days5: number;
  days20: number;
}

/** 교차 신호 — 주도주 태그 ∩ 슈퍼신호등 */
export interface PulseCrossStock {
  code: string;
  name: string;
  sector: string;
  tags: string[];
  sectorInflow: boolean;
  changeRate: number;
}

export interface MarketPulse {
  /** 며칠치가 쌓였나. 적으면 아래 판정은 전부 잠정이다 */
  days: number;
  phase: { key: PhaseKey; label: string; note: string };
  flow: PulseFlow;
  divergence: {
    warning: boolean;
    indexMove: number | null;
    breadthMove: number | null;
    note: string;
  };
  /** 누적과 최근 방향이 어긋나는가 — 변곡점 */
  turn: { turning: boolean; who: string | null; note: string };
  signal: { level: string; score: number; summary: string } | null;
  basis: number | null;
  /** basis 를 못 받았을 때의 설명 — 「못 봤다」와 「정상」을 가른다 */
  basisNote: string | null;
  /** 교차 신호 — 없으면 null */
  cross: { stocks: PulseCrossStock[]; note: string } | null;
  risks: { key: string; label: string; detail: string; level: "warn" | "danger" }[];
  external: { label: string; value: string; changeRate: number | null; note?: string }[];
  at: string;
}

export interface PulseBrief {
  text: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  at: string;
  error: string | null;
}


/* ------------------------------------------------------------------ */
/* 신호등 추적기 — 신호등이 정말 맞는지 스스로 검증한다                  */
/* ------------------------------------------------------------------ */

export interface TrackResult {
  days: number;
  price: number;
  /** 편입가 대비 (%) */
  rate: number;
  at: string;
}

export interface TrackEntry {
  id: string;
  code: string;
  name: string;
  /** 어느 문턱(70·80·90)으로 들어왔나 */
  tier: number;
  date: string;
  score: number;
  level: string;
  /** 편입 당시 축별 점수 */
  axes: Partial<Record<"trend" | "flow" | "value" | "risk", number | null>>;
  riskCapped: boolean;
  /**
   * **탈락 조건에 걸린 기준 이름들** (2026-09-01) — 비어 있으면 탈락 없음.
   *
   * 탈락은 위험 축과 다르다. 위험은 평균이라 하나가 커도 묻히는데, 탈락은
   * **하나라도 걸리면 그것으로 빨강**이다. 「점수가 높아도 이건 안 된다」를
   * 말하는 자리다.
   */
  vetoedBy?: string[];
  basePrice: number;
  /** 그때의 신호등 기준 지문 — 기준이 바뀌면 같은 90점도 다른 뜻이다 */
  configHash: string;
  results: TrackResult[];
  closed: boolean;
}

export interface TrackSummary {
  entries: TrackEntry[];
  tiers: {
    tier: number;
    count: number;
    pending: number;
    byHorizon: {
      days: number;
      n: number;
      winRate: number;
      avg: number;
      median: number;
      best: number;
      worst: number;
    }[];
  }[];
  currentConfig: string;
  mixedConfig: boolean;
  lastRunDate: string | null;
}


/** 사이드바 메뉴 설정 — 서버에 둔다(기기가 달라도 같은 메뉴여야 한다) */
export interface MenuPrefsDto {
  order: string[];
  hidden: string[];
  labels: Record<string, string>;
  groupOf: Record<string, string>;
  extraGroups: string[];
  favorites: string[];
}


/** 추적기 편입 조건 — 무엇을 담았는지 눈에 보여야 나중 숫자를 믿을 수 있다 */
export interface TrackConfig {
  tiers: number[];
  universe: number;
  market: "000" | "001" | "101";
  minTradeValue: number;
  includeRiskCapped: boolean;
}

export interface TrackJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  current: string;
  added: number;
  skippedDuplicate: number;
  /** 평가 자체가 실패한 종목 수 — 0건일 때 이유를 가르는 숫자다 */
  failed: number;
  firstError?: string;
  startedAt: string;
  report?: {
    date: string;
    scanned: number;
    added: number;
    skippedDuplicate: number;
    failed: number;
    belowTier: number;
    byTier: Record<string, number>;
    note: string;
  };
  error?: string;
}


/* ── 테마 DB (2026-08-28) ────────────────────────────────────── */

/** 네이버에서 받아 둔 분류 원본 — 화면은 대개 `themeStrength` 쪽을 쓴다 */
export interface NaverThemeStore {
  fetchedAt: string;
  themes: { no: number; name: string; stocks: { code: string; name: string; desc: string }[] }[];
  us: {
    code: string;
    name: string;
    stocks: {
      symbol: string;
      name: string;
      exchange: string;
      changeRate: number | null;
      marketCap: number | null;
    }[];
  }[];
  usFetchedAt: string;
}

export interface ThemeDbSummary {
  fetchedAt: string;
  themes: number;
  stocks: number;
  /** 편입 사유가 붙은 종목 수 — 국내는 전부 붙는다 */
  withDesc: number;
  usFetchedAt: string;
  usThemes: number;
  usStocks: number;
  etfFetchedAt: string;
  etfs: number;
}

/**
 * 테마 강도 — **분류는 네이버, 숫자는 우리 것.**
 * 등락률은 구성종목의 단순평균이다(시총 가중이면 큰 종목 하나가 테마를 대변해 버린다).
 */
export interface ThemeStrength {
  /**
   * 네이버 분류에서 **사라진 테마** (2026-08-31).
   *
   * 숨겨 둔 사이에 네이버가 그 테마를 뺀 경우다. 숫자는 없지만 되살리기 화면에는
   * 띄운다 — 안 띄우면 숨김만 남고 되돌릴 길이 없다.
   */
  gone?: boolean;
  key: string;
  name: string;
  changeRate: number;
  up: number;
  down: number;
  /** 오른 종목 비율(%) — 몇몇이 끄는지 다 같이 가는지 */
  breadth: number;
  /** 며칠째 **연속으로** 오르고 있나. 기록이 없으면 0 */
  streak: number;
  /** 최근 5일 중 오른 날 — `of` 는 실제로 가진 날 수다(기록이 모자라면 그만큼만) */
  hit5: { n: number; of: number };
  hit10: { n: number; of: number };
  /** 테마 거래대금 합계(억원, 어림값). ETF 는 순자산 */
  tradeValue: number;
  /** 테마 전체 시가총액 합계(억원, 어림값) — MAP 타일 크기이자 표 정렬 기준 */
  marketCap: number;
  /** 5거래일 누적(%). 기록이 모자라면 null */
  w1: number | null;
  /** 20거래일 누적(%). 기록이 모자라면 null */
  m1: number | null;
  /** 60거래일 누적(%) — 「이 테마가 원래 오던 자리인가」 */
  m60: number | null;
  /** 3개월 수익률(%) — ETF 만. 네이버가 주는 값이라 월간(m1)과 칸이 다르다 */
  m3: number | null;
  /** ETF 만 — 분류(국내 업종/테마 · 해외 주식 · 원자재…) */
  group?: string;
  stocks: {
    code: string;
    name: string;
    desc: string;
    changeRate: number | null;
    tradeValue?: number | null;
  }[];
}

/** 시장 렌즈 — 서버 `marketLens.ts` 와 같은 모양 */
export interface RotationTheme {
  key: string;
  name: string;
  changeRate: number;
  w1: number | null;
  m1: number | null;
  m60: number | null;
  streak: number;
  hit10: { n: number; of: number };
  breadth: number;
  tradeValue: number;
}

export interface MarketLens {
  thermo: {
    stocks: number;
    builtAt: string;
    series: { rise: number[]; above20: number[]; high60: number[]; low60: number[] };
    riseNow: number | null;
  };
  rotation: {
    lead: RotationTheme[];
    fresh: RotationTheme[];
    rest: RotationTheme[];
    universe: number;
    ready: boolean;
    at: string;
  };
  us: {
    top: { key: string; name: string; changeRate: number; streak: number }[];
    bottom: { key: string; name: string; changeRate: number; streak: number }[];
  };
}

export interface ThemeLink {
  key: string;
  label: string;
  kr: ThemeStrength | null;
  us: ThemeStrength | null;
  etf: ThemeStrength | null;
  lead: "kr" | "us" | null;
  note: string;
}

/**
 * 미국 ETF 구성종목 (야후 topHoldings).
 * **상위 10종목 안팎이다** — 전량이 아니므로 화면이 그렇게 적어야 한다.
 */
export interface UsEtfHoldings {
  symbol: string;
  holdings: { symbol: string; name: string; weight: number | null }[];
  sectors: { name: string; weight: number }[];
  error: string | null;
}

/** 야후 심볼 봉 데이터 — 전광판의 지수·원자재를 눌렀을 때 */
export interface YahooChart {
  symbol: string;
  range: string;
  interval: string;
  candles: { t: string; open: number; high: number; low: number; close: number; volume: number }[];
  prevClose: number | null;
  /**
   * 차트와 **같이 오는** 요약값 (2026-08-27).
   * 지수·원자재·금리는 개별종목 상세(us-detail)를 못 받는다 — 그런데 이 값들이
   * 차트 응답에 이미 들어 있어서, 조회를 늘리지 않고 시트를 채울 수 있다.
   */
  meta: {
    price: number | null;
    dayHigh: number | null;
    dayLow: number | null;
    high52: number | null;
    low52: number | null;
    volume: number | null;
    currency: string;
    exchange: string;
    name: string;
  } | null;
  error: string | null;
}


/** 내 매매 판단 추적 — 매도는 부호가 뒤집힌다(팔고 내렸으면 잘 판 것) */
export interface TradeTrackResult {
  trades: {
    id: string;
    date: string;
    kind: "buy" | "sell";
    code: string;
    name: string;
    price: number;
    qty: number;
    note: string;
    outcomes: { days: number; price: number; move: number; edge: number }[];
    error?: string;
  }[];
  buy: TradeHorizonStat[];
  sell: TradeHorizonStat[];
  soldTooEarly: { date: string; name: string; days: number; move: number; note: string }[];
  fetched: number;
  failed: number;
}

export interface TradeHorizonStat {
  days: number;
  n: number;
  hitRate: number;
  avgEdge: number;
  best: number;
  worst: number;
}


/**
 * 해외종목 상세 (한투).
 * ⚠️ **종목명은 안 온다** — 부르는 쪽이 이미 아는 이름을 쓴다. 재무제표·수급도 없다.
 */
export interface UsDetail {
  symbol: string;
  excd: string | null;
  sector: string;
  price: number | null;
  base: number | null;
  change: number | null;
  changeRate: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  prevVolume: number | null;
  high52: number | null;
  low52: number | null;
  marketCap: number | null;
  per: number | null;
  pbr: number | null;
  eps: number | null;
  bps: number | null;
  shares: number | null;
  currency: string;
  wonPrice: number | null;
  fxRate: number | null;
  tradable: string;
  error: string | null;
}


/** 주도주 탐색기 */
export interface LeaderConfig {
  minTradeValue: number;
  universe: number;
  surgeRate: number;
  volumeSpike: number;
  topSectors: number;
  minMembers: number;
}

export interface LeaderStock {
  code: string;
  name: string;
  sector: string;
  price: number;
  changeRate: number;
  /** 억원 */
  tradeValue: number;
  marketCap: number | null;
  volumeRatio: number | null;
  tags: string[];
  score: number;
}

export interface LeaderScan {
  at: string;
  date: string;
  config: LeaderConfig;
  sectors: {
    name: string;
    /** 거래대금 가중 등락률 */
    weightedRate: number;
    simpleRate: number;
    tradeValue: number;
    members: number;
    rising: number;
    /** 오른 종목 비율(%) — 낮으면 섹터가 아니라 종목 이슈 */
    breadth: number;
    leaders: LeaderStock[];
    streak: number | null;
    carryOver: number | null;
    news: { title: string; press: string; link: string }[];
  }[];
  stocks: LeaderStock[];
  scanned: number;
  belowThreshold: number;
  note: string;
}


/** 주도주 탐색기 성적 */
export interface LeaderGroupStat {
  key: string;
  n: number;
  byHorizon: {
    days: number;
    n: number;
    winRate: number;
    avg: number;
    median: number;
    best: number;
    worst: number;
  }[];
}

export interface LeaderTrackResult {
  picks: {
    date: string;
    code: string;
    name: string;
    sector: string;
    price: number;
    changeRate: number;
    tradeValue: number;
    tags: string[];
    outcomes: { days: number; price: number; rate: number }[];
  }[];
  /** 태그별 — 내가 어떤 신호를 잘 고르는지 */
  byTag: LeaderGroupStat[];
  bySector: LeaderGroupStat[];
  overall: LeaderGroupStat;
  days: number;
  codes: number;
  failed: number;
  note: string;
}


/** 일정 매매 — 일정을 보고 미리 들어가서 일정 즈음에 나온다 */
export interface EventPlay {
  id: string;
  date: string;
  title: string;
  note: string;
  themeIds: string[];
  calendarId?: string;
  createdAt: string;
}

export interface EventPlayResult extends EventPlay {
  themes: {
    themeId: string;
    themeName: string;
    members: number;
    /** D-1 종가를 100 으로 놓은 상대 곡선 */
    points: { offset: number; index: number; rate: number }[];
    runUp: number | null;
    after: number | null;
    /** 일정일이 고점이었나 — 「소문에 사서 뉴스에 판다」가 맞았는지 */
    peakedAtEvent: boolean | null;
  }[];
  upcoming: boolean;
}


/* ── 종가배팅 ── */

export interface BetGaugeDay {
  date: string;
  futuresBody: number | null;
  oilMove: number | null;
  fxMove: number | null;
  /** 실제 값 — 변동률만으로는 수준을 모른다 */
  futuresPrice: number | null;
  oilPrice: number | null;
  fxPrice: number | null;
  /** 미 국채금리 — 하루 변화·5일 변화는 bp, 수준은 % */
  y10Move: number | null;
  y30Move: number | null;
  y10Trend: number | null;
  y30Trend: number | null;
  y10: number | null;
  y30: number | null;
}

export interface BetVerdict {
  key: "futures" | "oil" | "fx" | "y10" | "y30";
  label: string;
  level: "ok" | "warn" | "bad";
  value: string;
  /** 지금 값 */
  price: string;
  why: string;
}

export interface BetStat {
  key: string;
  n: number;
  openWin: number;
  openAvg: number;
  closeWin: number;
  closeAvg: number;
  /** 코스피 대비(%p) — 이게 없으면 시장이 오른 건지 종목을 고른 건지 모른다 */
  openExcess: number;
  closeExcess: number;
  excessWin: number;
}

export interface BetBacktest {
  venue: "krx" | "nxt";
  stocks: { code: string; name: string; days: number }[];
  matched: BetStat;
  unmatched: BetStat;
  perCondition: BetStat[];
  benchDays: number;
  note: string;
}

export interface BetLogStat {
  key: string;
  n: number;
  openWin: number;
  openAvg: number;
  openExcess: number;
  excessWin: number;
}

export interface BetLogSummary {
  days: number;
  scored: number;
  watch: { code: string; name: string }[];
  periods: { label: string; matched: BetLogStat; unmatched: BetLogStat }[];
  recent: {
    date: string;
    atClose: BetGaugeDay | null;
    settled: BetGaugeDay | null;
    scored: boolean;
    stocks: {
      code: string;
      name: string;
      close: number;
      nxtClose: number | null;
      openRate: number | null;
      openExcess: number | null;
      nxtOpenRate: number | null;
      nxtOpenExcess: number | null;
    }[];
  }[];
  note: string;
}


/** 호가창 */
export interface OrderBook {
  code: string;
  at: string;
  asks: { step: number; price: number; qty: number }[];
  bids: { step: number; price: number; qty: number }[];
  totalAsk: number;
  totalBid: number;
  overtimeAsk: number;
  overtimeBid: number;
  /** 매수잔량 ÷ 매도잔량. **체결강도가 아니다** — 대기 물량이다 */
  ratio: number | null;
  price: number;
  changeRate: number;
  open: number;
  krxHigh: number;
  krxLow: number;
  nxtHigh: number | null;
  nxtLow: number | null;
  high250: number;
  low250: number;
  upperLimit: number;
  lowerLimit: number;
  volume: number;
  /** 거래량 ÷ 상장주식수 (%) */
  turnover: number | null;
  /** 체결강도(%). 100 초과면 매수 체결이 우세. **잔량비와 다르다 — 실제 체결이다** */
  strength: number | null;
  /** 기준가(전일 종가) — 호가마다 등락률을 붙이는 기준 */
  basePrice: number;
  /** 누적거래대금(원). `ka10003` 이 준다 */
  tradeValue: number;
  /** 최근 체결 — 수량 부호가 방향이다(음수면 매도 체결) */
  ticks: { t: string; price: number; qty: number }[];
  error: string | null;
}


/** 거래원 */
export interface BrokerFlow {
  code: string;
  at: string;
  sell: { rank: number; code: string; name: string; qty: number; delta: number; foreign: boolean }[];
  buy: { rank: number; code: string; name: string; qty: number; delta: number; foreign: boolean }[];
  foreignNet: number;
  /** 우리가 쌓은 시간대별 — 화면을 안 본 시간은 빈다 */
  series: { t: string; net: Record<string, number> }[];
  names: Record<string, string>;
  error: string | null;
}

/**
 * 보드 화면 구성 한 벌 — 서버가 주고받는 모양.
 * 화면 쪽 `Preset` 과 같은 모양이지만, 서버 계약이라 여기에도 적어 둔다.
 */
export interface BoardPresetDto {
  id: string;
  name: string;
  pick: string[];
  sizes: Record<string, { w: number; h: number }>;
  pins: string[];
  locks: Record<string, { code: string; name: string }>;
  /** 잠갔나 — 이름·순서·삭제·덮어쓰기가 막힌다 */
  locked?: boolean;
}

/* ────────────────────────────────────────────────────────────────────
 * CIS 일지 (2026-08-31)
 *
 * 시스가 굴리는 **모의 계좌**. 이 HTS 는 조회 전용이라 실제 주문은 없고,
 * 「그때 그 값에 샀다면」을 장부로 남긴다. 서버의 cisAccount.ts 참고.
 * ──────────────────────────────────────────────────────────────────── */

export interface CisProfile {
  id: string;
  name: string;
  hint: string;
  seed: number;
  etfOnly: boolean;
  allowMisu: boolean;
  allowCredit: boolean;
  /** 위험자산 한도(%) — 퇴직연금만 70 */
  riskCap: number;
  allowLeveraged: boolean;
  cadence: string;
}

export interface CisPosition {
  code: string;
  name: string;
  qty: number;
  avg: number;
  funding: string;
  openedAt: string;
  dueDate?: string;
  why: string;
  used: string[];
  stop: number | null;
  target: number | null;
  safe?: boolean;
  /**
   * 흔들림 — 들고 있는 동안 어디까지 밀렸고 어디까지 갔나 (MAE/MFE).
   * 1분 감시가 갱신한다. 종가만 봐서는 절대 안 보이는 값이다.
   */
  worstPct?: number;
  worstAt?: string;
  bestPct?: number;
  bestAt?: string;
  /** 지금 값 — 못 읽었으면 null (0 이 아니다) */
  price: number | null;
  value: number;
  pnl: number | null;
  pnlPct: number | null;
}

export interface CisGoal {
  stage: number;
  next: number | null;
  pct: number;
  multiple: number | null;
  finalPct: number;
  label: string;
}

export interface CisAccountView {
  profile: CisProfile;
  cash: number;
  misu: number;
  credit: number;
  equity: number;
  stockValue: number;
  debt: number;
  leverage: number;
  startedAt: string;
  positions: CisPosition[];
  risk: { risky: number; safe: number; riskyPct: number; cap: number; over: boolean };
  goal: CisGoal;
  curve: { date: string; equity: number; cash: number; debt: number }[];
}

export interface CisFill {
  id: string;
  date: string;
  slot: string;
  side: "buy" | "sell";
  code: string;
  name: string;
  qty: number;
  price: number;
  funding: string;
  cost: number;
  pnl?: number;
  heldDays?: number;
  why: string;
  used: string[];
}

export interface CisCandidate {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  sector: string;
  signalScore: number | null;
  signalLevel: string | null;
  leaderScore: number;
  score: number;
  used: string[];
  why: string;
  rejected?: string;
}

export interface CisSlotEntry {
  slot: string;
  at: string;
  text: string;
  market: { ok: boolean; score: number; label: string; reason: string } | null;
  candidates: CisCandidate[];
  plans: {
    name: string;
    code: string;
    qty: number;
    price: number;
    funding: string;
    stop: number;
    target: number;
    why: string;
  }[];
  actions: {
    side: "buy" | "sell";
    code: string;
    name: string;
    qty: number;
    price: number;
    funding: string;
    why: string;
    used: string[];
    pnl?: number;
  }[];
  exits: { name: string; code: string; kind: string; reason: string }[];
  used: string[];
  equity: number;
  cash: number;
  debt: number;
}

export interface CisDay {
  date: string;
  account: string;
  morning: CisSlotEntry | null;
  noon: CisSlotEntry | null;
  evening: CisSlotEntry | null;
  review: {
    planned: number;
    executed: number;
    realized: number;
    equityChange: number;
    violations: string[];
    text: string;
  } | null;
}

/** 시스의 지금 상태 — 최근 성적에서 나온다. 글에만 쓰이고 매매를 바꾸지 않는다 */
export interface CisPersonaState {
  condition: "cold" | "steady" | "hot" | "bruised" | "new";
  streak: number;
  recentPnl: number;
  violations: string[];
  lastWord: string | null;
  basedOn: number;
}

export interface CisBucket {
  key: string;
  label: string;
  trades: number;
  wins: number;
  winRate: number;
  pnl: number;
  avgPnl: number;
  payoff: number | null;
  avgHold: number;
}

export interface CisStats {
  account: string;
  accountName: string;
  seed: number;
  equity: number;
  totalReturn: number;
  days: number;
  mdd: number;
  realized: number;
  cost: number;
  trades: number;
  wins: number;
  winRate: number;
  payoff: number | null;
  avgHold: number;
  best: { name: string; pnl: number; date: string } | null;
  worst: { name: string; pnl: number; date: string } | null;
  byExit: CisBucket[];
  byReason: CisBucket[];
  byFunding: CisBucket[];
  bySlot: CisBucket[];
  planRate: number | null;
  violationDays: number;
  violations: { text: string; count: number }[];
  /** 흔들림 요약 — 손절폭이 적당한지에 숫자로 답한다 */
  swing: { tracked: number; avgWorst: number | null; avgBest: number | null; nearStop: number | null };
  curve: { date: string; equity: number }[];
}

export interface CisUsageRow {
  name: string;
  used: number;
  trades: number;
  winRate: number | null;
  pnl: number;
}

export interface CisRules {
  maxPerStock: number;
  maxPositions: number;
  stopPct: number;
  targetPct: number;
  maxHoldDays: number;
  minScore: number;
  minTradeValue: number;
  minMarketScore: number;
  trailAfterPct: number;
}

export interface CisRuleLabel {
  label: string;
  unit: string;
  hint: string;
}

export interface CisConfig {
  enabled: boolean;
  auto: boolean;
  /** 장중 내내 볼까 (1분마다). 끄면 하루 세 번만 본다 */
  watch: boolean;
  /** 몇 분마다 살 자리를 찾을까 (0 이면 하루 세 번만) */
  buyScanMin: number;
  times: { morning: string; noon: string; evening: string };
  useMisu: boolean;
  useCredit: boolean;
  rules: CisRules;
  goals: number[];
  /** 연금이 무엇을 보고 ETF 를 고를까 — theme·holdings·simple */
  pensionMethod: string;
  /** 연금을 무슨 요일에 굴릴까 (0=일 … 6=토) */
  pensionDay: number;
  ai: {
    narrate: boolean;
    screen: boolean;
    weekly: boolean;
    /** 켜면 AI 가 후보를 뺄 수 있다 — 그 순간 재현 불가능해진다 */
    screenVeto: boolean;
    model: { provider: string; model: string } | null;
  };
}

/** 장중 감시가 실제로 한 일 — 「아무 일 없음」은 안 담는다 */
export interface CisWatchEvent {
  at: string;
  account: string;
  kind: "sell" | "trail" | "buy";
  name: string;
  code: string;
  qty?: number;
  price?: number;
  pnl?: number;
  reason: string;
}

export interface CisRunResult {
  ok: boolean;
  account: string;
  slot: string;
  date: string;
  skipped?: string;
  entry?: CisSlotEntry;
  day?: CisDay;
  screenNotes?: { code: string; name: string; verdict: string; note: string }[];
  aiError?: string;
}


/* ────────────────────────────────────────────────────────────────────
 * ETF 분석 (2026-08-31) — 테마를 축으로 본다.
 *
 * 개별 주도주 신호는 ETF 안에서 희석되지만 **테마·섹터 강세는 ETF 와 단위가
 * 같다.** 「2차전지(생산)가 2일 연속 강세」면 그것을 담은 ETF 가 그 강세를
 * 그대로 받는다. 서버의 etfAnalysis.ts 참고.
 * ──────────────────────────────────────────────────────────────────── */

export interface EtfScore {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  group: string;
  safe: boolean;
  deviation: number | null;
  traceErr: number | null;
  /** 이어진 판. `via` 는 **무엇으로 이어졌나** — 잘못 이어진 것을 눈으로 잡으라고 띄운다 */
  theme: { name: string; rate: number; streak: number; via: string } | null;
  themeScore: number;
  /** 지수 대비 초과수익(%p). 못 쟀으면 null — 절대수익률로 대신하지 않는다 */
  rs20: number | null;
  rs60: number | null;
  rsScore: number;
  trend: { ma20: number; ma60: number; ma120: number | null; aligned: boolean; above20: boolean } | null;
  trendScore: number;
  qualityScore: number;
  score: number;
  why: string;
}

export interface EtfAnalysis {
  at: string;
  boards: { name: string; rate: number; streak: number }[];
  rows: EtfScore[];
  /** 안전자산은 따로 — 하락장에서 늘 지수를 이겨 순위를 망친다 */
  safe: EtfScore[];
  benchmark: { name: string; r20: number | null; r60: number | null } | null;
  scanned: number;
  detailed: number;
  note: string;
}


export interface EtfHoldingStock {
  code: string;
  name: string;
  /** 이 ETF 안에서의 비중(%) */
  weight: number | null;
  changeRate: number | null;
  sector: string | null;
  signal?: { level: string; score: number } | null;
}

export interface EtfHoldingScore {
  code: string;
  name: string;
  group: string;
  safe: boolean;
  aumRaw: number;
  holdings: EtfHoldingStock[];
  /** Top10 이 이 ETF 를 얼마나 덮나(%) — 낮으면 판단의 대표성이 떨어진다 */
  coverage: number;
  /** 구성종목 등락률의 비중 가중평균 */
  weighted: number | null;
  breadth: number | null;
  signalAvg: number | null;
  green: number;
  red: number;
  score: number;
  why: string;
}

export interface HoldingsAnalysis {
  at: string;
  builtAt: string | null;
  rows: EtfHoldingScore[];
  /** 순위에서 뺀 것 — 안전자산이거나 Top10 이 너무 적게 덮는 ETF */
  aside: EtfHoldingScore[];
  scanned: number;
  withSignal: boolean;
  note: string;
}

/** 알림 갈래 — 서버 notifyCenter.ts 와 같다 */
export type NoticeKind = "stock" | "market" | "system";

/** 알림함의 한 줄 */
export interface Notice {
  id: string;
  at: string;
  /** 같은 사건이 이어지면 여기만 올라간다 */
  lastAt: string;
  /** 겹쳐 들어온 횟수 */
  hits: number;
  kind: NoticeKind;
  level: "info" | "warn" | "urgent";
  title: string;
  body?: string;
  /** 누르면 갈 곳 — 앱 안의 해시 경로 (#/watchlist 처럼) */
  link?: string;
  code?: string;
  name?: string;
  read: boolean;
}

/** 장세 점검 설정 */
export interface RegimeConfig {
  enabled: boolean;
  breadthDropPp: number;
  newHighDropPct: number;
  volSpikeX: number;
  lookbackDays: number;
  sampleStaleDays: number;
  /** 이 아래면 「오늘은 신호등이 잘 안 듣는 장세」로 본다 (실측 삼등분 경계) */
  breadthTrustAt: number;
  newHighTrustAt: number;
}

/** 어느 하루의 장세 */
export interface RegimeSnap {
  date: string;
  /** 20일선 위 종목 비율 % */
  breadth: number | null;
  /** 60일 신고가 근처 종목 비율 % */
  newHigh: number | null;
  /** 전 종목 일간 등락률의 표준편차 % */
  vol: number | null;
  /** 전 종목 일간 등락률 중앙값 % */
  med: number | null;
  n: number;
}

export interface RegimeFinding {
  key: string;
  level: "info" | "warn" | "urgent";
  title: string;
  detail: string;
  now: number | null;
  then: number | null;
}

export interface RegimeResult {
  today: RegimeSnap;
  past: RegimeSnap | null;
  /** 견준 대상이 실측 이력인가, 캐시에서 되짚은 것인가 */
  pastFrom: "history" | "cache" | null;
  lookbackDays: number;
  history: RegimeSnap[];
  findings: RegimeFinding[];
  sample: { has: boolean; builtAt?: string; ageDays?: number; obs?: number; codeCount?: number };
  cacheBuiltAt: string;
}

/** 조건부 성적표의 한 칸 */
export interface SignalCondCell {
  label: string;
  /** 이 칸의 전체 표본 */
  total: number;
  /** 그중 초록 */
  n: number;
  /** 이 칸 전체의 20일 평균 — 초록을 여기에 대고 읽는다 */
  base: number | null;
  green: number | null;
  /** 초과분(%p) */
  lift: number | null;
  win: number | null;
  trainLift: number | null;
  testLift: number | null;
  /** 뒤쪽(검증) 구간의 초록 표본 — 이게 얇으면 그 칸은 못 믿는다 */
  testN: number;
}

export interface SignalCondAxis {
  key: string;
  title: string;
  hint: string;
  cells: SignalCondCell[];
}

export interface SignalCondResult {
  obs: number;
  splitDate: string;
  axes: SignalCondAxis[];
}

/** 슈퍼신호등 재구성의 한 줄 */
export interface SignalSuperSimRow {
  label: string;
  n: number;
  d20: number | null;
  win: number | null;
  /** 전체 대비 초과분(%p) */
  lift: number | null;
  trainLift: number | null;
  testLift: number | null;
  testN: number;
}

export interface SignalSuperSimResult {
  obs: number;
  splitDate: string;
  /** 되살린 목록 수 / 전체 (장중 기관 매매상위는 못 살린다) */
  listsUsed: number;
  listsTotal: number;
  minLists: number;
  rows: SignalSuperSimRow[];
}

/** 목록별 추적 원장의 한 줄 — 서버 listTrack.ts 와 같은 모양 */
export interface ListEntry {
  code: string;
  name: string;
  /** 어느 목록에서 왔나 (SCREEN_UNIVERSES key) */
  list: string;
  addedDate: string;
  addedPrice: number;
  score: number;
  /** 편입일 그 목록에서의 자리 */
  rank: number;
  configHash?: string;
  regime?: { breadth: number | null; newHigh: number | null; weak: boolean };
  seenCount: number;
  lastSeenDate: string;
  active?: boolean;
  exitedDate?: string;
  /** 편입일 종가 대비 — 슈퍼신호등과 같은 기준이라 견줄 수 있다 */
  returns?: { d1: number | null; d5: number | null; d20: number | null };
}

export interface ListTrackSummary {
  entries: ListEntry[];
  lastRunDate: string | null;
  /** 목록별로 몇 개를 받았고 몇 개가 초록이었나 */
  counts: Record<string, { universe: number; green: number }>;
  byList: { key: string; label: string; active: number; exited: number; avgScore: number | null }[];
  /** 성적표 — 슈퍼신호등 채점표와 같은 모양이라 나란히 놓을 수 있다 */
  grade: ListGradeRow[];
  /** 추적 중 종목의 당일 상승/하락 수 — 사이드바 배지 (조회 0회) */
  up: number | null;
  down: number | null;
}

/** 성적 한 줄 */
export interface ListGradeRow {
  label: string;
  n: number;
  d1: { avg: number | null; n: number };
  d5: { avg: number | null; n: number };
  d20: { avg: number | null; n: number };
  win1: number | null;
}
