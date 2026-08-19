import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, "..", "data", "apiUsage.json");

/**
 * 외부 API 호출량 집계.
 * 서비스별 무료 한도가 있어서(특히 DART·네이버) 일별 사용량을 남겨두고 화면에서 확인한다.
 * 날짜별 · 서비스별 · 엔드포인트별로 성공/실패 횟수를 센다.
 */

export type ApiProvider =
  | "kiwoom"
  | "hantoo"
  | "dart"
  | "naver"
  | "yahoo"
  | "anthropic"
  | "gemini"
  | "openai"
  | "dataGoKr"
  | "telegram"
  | "mail";

/**
 * AI 호출 한 묶음의 토큰. **모델 × 용도별로** 따로 담는다.
 *
 * 예전에는 하루치 토큰을 모델 구분 없이 한 덩어리로 더해 놓고, 단가는 calls 객체에서
 * 먼저 나온 모델 하나로 전부 계산했다. 리포트를 Opus 로, 채널 요약을 Haiku 로 돌리면
 * 어느 쪽이 먼저 찍혔느냐에 따라 추정치가 몇 배씩 어긋났다. 단가가 다른 것끼리는
 * 섞어서 더하면 안 된다.
 */
export interface TokenBucket {
  calls: number;
  input: number;
  output: number;
  /** 캐시 쓰기 — 입력 단가의 1.25배로 과금된다 */
  cacheWrite: number;
  /** 캐시 읽기 — 입력 단가의 0.1배 */
  cacheRead: number;
  /** 서버 도구(웹 검색) 사용 횟수 — 토큰과 별도로 건당 과금된다 */
  webSearches: number;
}

function emptyBucket(): TokenBucket {
  return { calls: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0, webSearches: 0 };
}

interface DayStat {
  /** 엔드포인트(또는 TR ID)별 호출 수 */
  calls: Record<string, number>;
  ok: number;
  failed: number;
  /** 한도 초과(429 등) 횟수 — 별도로 세면 한도에 걸렸는지 바로 보인다 */
  rateLimited: number;
  /**
   * 실패 사유별 횟수.
   *
   * 실패 개수만 세면 **무엇이 잘못됐는지 알 수가 없다** — 한투가 하루 3,700건씩
   * 실패하는데 그게 종목이 없어서인지, 토큰이 만료돼서인지, 유량인지 구분이 안 됐다.
   * 사유를 같이 세면 고칠 수 있는 것과 어쩔 수 없는 것이 갈린다.
   */
  reasons?: Record<string, number>;
  /** @deprecated 모델을 안 가리고 더하던 옛 필드. 읽기만 하고 새로 쓰지 않는다 */
  inputTokens?: number;
  outputTokens?: number;
  /** 키는 `용도|모델`. 이렇게 담아야 모델별·기능별을 둘 다 낼 수 있다 */
  ai?: Record<string, TokenBucket>;
}

/**
 * Claude 모델별 100만 토큰당 단가(USD).
 * 비용을 "대략 얼마 나가고 있는지" 감 잡는 용도라 정확한 청구액과는 다를 수 있다.
 */
/** 100만 토큰당 USD. 공개 단가 기준이며 바뀔 수 있다 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  // 2026-08-31 까지 인트로 단가($2/$10). 그 뒤 $3/$15 로 오른다
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  // 공개 단가는 바뀔 수 있다. 정확한 청구는 Google Cloud 결제 콘솔에서 본다
  "gemini-3.5-flash-lite": { input: 0.1, output: 0.4 },
  "gemini-3.5-flash": { input: 0.3, output: 2.5 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

/** 인트로 단가가 끝나는 날. 이 날이 지나면 정상가로 계산한다 */
const SONNET5_INTRO_UNTIL = "2026-08-31";
const SONNET5_LIST = { input: 3, output: 15 };

/**
 * 모델명이 사전에 없을 때의 폴백.
 *
 * 예전엔 전부 sonnet 단가로 떨어졌는데, 그러면 표에 없는 **Gemini 모델이 Claude 단가**로
 * 잡힌다 — 10배 넘게 부풀려진다. 그래서 이름으로 계열을 먼저 갈라 준다.
 */
function priceFor(model: string, day?: string): { input: number; output: number } {
  const hit = MODEL_PRICING[model];
  if (hit) {
    // 인트로 기간이 지난 날짜의 기록은 정상가로 되돌린다
    if (model === "claude-sonnet-5" && day && day > SONNET5_INTRO_UNTIL) return SONNET5_LIST;
    return hit;
  }
  if (/lite/.test(model) && model.startsWith("gemini")) return MODEL_PRICING["gemini-3.5-flash-lite"];
  if (model.startsWith("gemini")) return MODEL_PRICING["gemini-3.5-flash"];
  if (model.startsWith("gpt")) return MODEL_PRICING["gpt-4o-mini"];
  if (model.includes("opus")) return MODEL_PRICING["claude-opus-5"];
  if (model.includes("haiku")) return MODEL_PRICING["claude-haiku-4-5-20251001"];
  return MODEL_PRICING["claude-sonnet-5"];
}

/** 웹 검색 단가 — 검색 1,000건당 USD. 토큰과 **별도로** 청구된다 */
const WEB_SEARCH_USD_PER_1K = 10;

/**
 * 한 묶음의 비용(USD).
 *
 * 캐시 토큰을 빼먹으면 안 된다. 쓰기는 입력 단가의 1.25배, 읽기는 0.1배로 과금되는데
 * 예전 계산은 이 둘을 아예 세지 않아서 캐시가 도는 만큼 실제와 벌어졌다.
 */
export function bucketCost(b: TokenBucket, model: string, day?: string): number {
  const p = priceFor(model, day);
  return (
    (b.input / 1_000_000) * p.input +
    (b.output / 1_000_000) * p.output +
    (b.cacheWrite / 1_000_000) * p.input * 1.25 +
    (b.cacheRead / 1_000_000) * p.input * 0.1 +
    (b.webSearches / 1000) * WEB_SEARCH_USD_PER_1K
  );
}

type UsageData = Record<string, Record<ApiProvider, DayStat>>; // { "2026-08-12": { kiwoom: {...} } }

/** 각 서비스의 일일 무료 한도 (공식 문서 기준, 없으면 null) */
export const DAILY_LIMITS: Record<ApiProvider, { label: string; limit: number | null; note: string }> = {
  kiwoom: {
    label: "키움 REST API",
    limit: null,
    note: "일일 총량 제한은 없으나 TR당 초당 5회 제한이 있습니다",
  },
  hantoo: {
    label: "한국투자증권 OpenAPI",
    limit: null,
    note: "키움에 없는 목표주가·해외주식·선물옵션에만 씁니다. 접근토큰은 하루 한 번 발급 원칙이라 파일에 캐싱합니다",
  },
  dart: {
    label: "DART OpenAPI",
    limit: 20000,
    note: "인증키당 하루 20,000건 (금융감독원 공식)",
  },
  naver: {
    label: "네이버 검색 API",
    limit: 25000,
    note: "일 25,000건 (NAVER API Hub 기준)",
  },
  yahoo: {
    label: "Yahoo Finance",
    limit: null,
    note: "공식 한도 미공개. 과도하게 호출하면 차단될 수 있어 1분 캐싱을 둡니다",
  },
  anthropic: {
    label: "Claude API",
    limit: null,
    note: "종량제 — 호출 수가 아니라 토큰이 비용입니다. 아래 토큰·추정비용을 보세요",
  },
  gemini: {
    label: "Gemini API",
    limit: null,
    note: "종량제. 이미지 분석 등 가벼운 작업에 씁니다 (Claude보다 저렴)",
  },
  openai: {
    label: "OpenAI API",
    limit: null,
    note: "종량제. 이미지 분석 대체 경로입니다",
  },
  dataGoKr: {
    label: "공공데이터포털 (관세청)",
    limit: 10000,
    note: "개발계정 일 10,000건. 수출입 통계는 월 단위 갱신이라 12시간 캐시를 둡니다",
  },
  telegram: {
    label: "텔레그램 봇",
    limit: null,
    note: "무료. 초당 약 30건 제한이 있어 알림이 몰리면 나눠 보냅니다",
  },
  mail: {
    label: "네이버 메일(SMTP)",
    limit: null,
    note: "네이버 정책상 일일 발송 제한이 있습니다. 하루 3회 리포트라 여유롭습니다",
  },
};

let cache: UsageData | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function today(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function emptyStat(): DayStat {
  return { calls: {}, ok: 0, failed: 0, rateLimited: 0 };
}

async function load(): Promise<UsageData> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    cache = JSON.parse(raw) as UsageData;
  } catch {
    cache = {};
  }
  return cache;
}

/** 잦은 디스크 쓰기를 막기 위해 잠시 모았다가 저장 */
function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    if (!cache) return;
    try {
      await mkdir(dirname(DATA_FILE), { recursive: true });
      await writeFile(DATA_FILE, JSON.stringify(cache, null, 2), "utf-8");
    } catch {
      // 사용량 기록 실패가 본 기능을 막으면 안 되므로 조용히 무시
    }
  }, 5000);
}

/** 어느 기능이 부른 호출인지. 모르면 "기타"로 담긴다 */
export type UsageFeature =
  | "report"
  | "ask"
  | "channel"
  | "research"
  | "pulse"
  | "vision"
  | "other";

export const FEATURE_LABEL: Record<UsageFeature, string> = {
  report: "데일리 리포트",
  ask: "시황 질문하기",
  channel: "텔레그램 채널 요약",
  research: "웹 리서치",
  pulse: "시장 흐름 요약",
  vision: "이미지 인식(캘린더)",
  other: "기타",
};

export interface CallTokens {
  inputTokens?: number;
  outputTokens?: number;
  /** 응답 usage 의 cache_creation_input_tokens */
  cacheWriteTokens?: number;
  /** 응답 usage 의 cache_read_input_tokens */
  cacheReadTokens?: number;
  /** server_tool_use.web_search_requests */
  webSearches?: number;
  /** 어느 메뉴가 쓴 건지 — 이게 있어야 "무엇이 돈을 쓰나"를 볼 수 있다 */
  feature?: UsageFeature;
}

export async function recordApiCall(
  provider: ApiProvider,
  endpoint: string,
  outcome: "ok" | "failed" | "rateLimited",
  /** Claude 호출일 때 응답의 usage를 그대로 넘기면 토큰이 누적된다 */
  tokens?: CallTokens,
  /** 실패했을 때 왜 실패했는지 (짧게). 사유별로 세어 화면에 보여 준다 */
  reason?: string,
): Promise<void> {
  const data = await load();
  const day = today();
  if (!data[day]) data[day] = {} as Record<ApiProvider, DayStat>;
  if (!data[day][provider]) data[day][provider] = emptyStat();

  const stat = data[day][provider];
  stat.calls[endpoint] = (stat.calls[endpoint] ?? 0) + 1;
  if (tokens) {
    // 모델(endpoint) × 기능별로 담는다. 단가가 다른 것끼리 섞이지 않게
    const key = `${tokens.feature ?? "other"}|${endpoint}`;
    if (!stat.ai) stat.ai = {};
    const b = (stat.ai[key] ??= emptyBucket());
    b.calls += 1;
    b.input += tokens.inputTokens ?? 0;
    b.output += tokens.outputTokens ?? 0;
    b.cacheWrite += tokens.cacheWriteTokens ?? 0;
    b.cacheRead += tokens.cacheReadTokens ?? 0;
    b.webSearches += tokens.webSearches ?? 0;
  }
  if (outcome === "ok") stat.ok += 1;
  else if (outcome === "failed") stat.failed += 1;
  else {
    stat.rateLimited += 1;
    stat.failed += 1;
  }

  if (outcome !== "ok") {
    // 사유가 안 넘어오면 뭉뚱그린다 — 그래도 「알 수 없음」이 몇 건인지는 보인다
    const key = (reason ?? "알 수 없음").slice(0, 60);
    stat.reasons ??= {};
    stat.reasons[key] = (stat.reasons[key] ?? 0) + 1;
  }

  // 30일치만 보관
  const days = Object.keys(data).sort();
  while (days.length > 30) {
    const oldest = days.shift();
    if (oldest) delete data[oldest];
  }

  scheduleSave();
}

export interface ProviderUsage {
  provider: ApiProvider;
  label: string;
  limit: number | null;
  note: string;
  total: number;
  ok: number;
  failed: number;
  rateLimited: number;
  usageRate: number | null; // 한도 대비 %
  topEndpoints: { endpoint: string; count: number }[];
  /** 실패 사유별 — 실패 건수만 보면 무엇을 고쳐야 할지 알 수 없다 */
  failReasons: { reason: string; count: number }[];
  /** AI provider 전용 — 토큰과 추정 비용(USD). 그 밖에는 null */
  tokens: {
    input: number;
    output: number;
    cacheWrite: number;
    cacheRead: number;
    webSearches: number;
    estimatedUsd: number;
    /** 모델별 내역 — 단가가 다르므로 합계만 보면 어디서 나갔는지 모른다 */
    byModel: { model: string; calls: number; input: number; output: number; usd: number }[];
    /** 기능별 내역 — "어느 메뉴가 돈을 쓰나" */
    byFeature: { feature: UsageFeature; label: string; calls: number; usd: number }[];
    /**
     * 기능 × 모델 한 줄씩. 호출 내역을 모델명만 나열하면 어느 메뉴가 부른 건지 알 수 없다 —
     * "claude-sonnet-5 20회"만 봐서는 리포트인지 채널 요약인지 구분이 안 된다.
     */
    detail: {
      feature: UsageFeature;
      label: string;
      model: string;
      calls: number;
      input: number;
      output: number;
      usd: number;
    }[];
    /** 옛 기록이라 모델·기능을 못 가르는 토큰이 섞여 있는지 */
    hasLegacy: boolean;
  } | null;
}

/**
 * 하루치 AI 버킷을 합산한다.
 *
 * `ai` 가 생기기 전에 저장된 날은 모델·기능을 가를 수 없다. 그 토큰은 버리지 않고
 * "기타|(구버전 기록)"으로 넣되 hasLegacy 를 세워서, 화면이 "이 날 숫자는 덜 정확하다"고
 * 말할 수 있게 한다. 조용히 섞어 버리면 왜 안 맞는지 영영 모른다.
 */
function summarizeBuckets(stat: DayStat, day: string): NonNullable<ProviderUsage["tokens"]> {
  const buckets: { feature: UsageFeature; model: string; b: TokenBucket }[] = [];
  for (const [key, b] of Object.entries(stat.ai ?? {})) {
    const sep = key.indexOf("|");
    buckets.push({
      feature: (sep > 0 ? key.slice(0, sep) : "other") as UsageFeature,
      model: sep > 0 ? key.slice(sep + 1) : key,
      b,
    });
  }

  const legacyIn = stat.inputTokens ?? 0;
  const legacyOut = stat.outputTokens ?? 0;
  const hasLegacy = legacyIn > 0 || legacyOut > 0;
  if (hasLegacy) {
    buckets.push({
      feature: "other",
      model: Object.keys(stat.calls)[0] ?? "",
      b: { ...emptyBucket(), input: legacyIn, output: legacyOut },
    });
  }

  const byModelMap = new Map<string, { calls: number; input: number; output: number; usd: number }>();
  const byFeatureMap = new Map<UsageFeature, { calls: number; usd: number }>();
  const detail: NonNullable<ProviderUsage["tokens"]>["detail"] = [];
  let input = 0;
  let output = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  let webSearches = 0;
  let estimatedUsd = 0;

  for (const { feature, model, b } of buckets) {
    const usd = bucketCost(b, model, day);
    input += b.input;
    output += b.output;
    cacheWrite += b.cacheWrite;
    cacheRead += b.cacheRead;
    webSearches += b.webSearches;
    estimatedUsd += usd;

    const m = byModelMap.get(model) ?? { calls: 0, input: 0, output: 0, usd: 0 };
    m.calls += b.calls;
    m.input += b.input + b.cacheWrite + b.cacheRead;
    m.output += b.output;
    m.usd += usd;
    byModelMap.set(model, m);

    const f = byFeatureMap.get(feature) ?? { calls: 0, usd: 0 };
    f.calls += b.calls;
    f.usd += usd;
    byFeatureMap.set(feature, f);

    detail.push({
      feature,
      label: FEATURE_LABEL[feature] ?? feature,
      model,
      calls: b.calls,
      input: b.input + b.cacheWrite + b.cacheRead,
      output: b.output,
      usd,
    });
  }

  return {
    input,
    output,
    cacheWrite,
    cacheRead,
    webSearches,
    estimatedUsd,
    byModel: [...byModelMap.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.usd - a.usd),
    byFeature: [...byFeatureMap.entries()]
      .map(([feature, v]) => ({ feature, label: FEATURE_LABEL[feature] ?? feature, ...v }))
      .sort((a, b) => b.usd - a.usd),
    detail: detail.sort((a, b) => b.usd - a.usd),
    hasLegacy,
  };
}

export async function getUsage(day = today()): Promise<{ day: string; providers: ProviderUsage[] }> {
  const data = await load();
  const dayData = data[day] ?? ({} as Record<ApiProvider, DayStat>);

  const providers = (Object.keys(DAILY_LIMITS) as ApiProvider[]).map((p) => {
    const stat = dayData[p] ?? emptyStat();
    const total = stat.ok + stat.failed;
    const meta = DAILY_LIMITS[p];
    const topEndpoints = Object.entries(stat.calls)
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    const failReasons = Object.entries(stat.reasons ?? {})
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
    let tokens: ProviderUsage["tokens"] = null;
    if (p === "anthropic" || p === "gemini" || p === "openai") {
      tokens = summarizeBuckets(stat, day);
    }

    return {
      provider: p,
      label: meta.label,
      limit: meta.limit,
      note: meta.note,
      total,
      ok: stat.ok,
      failed: stat.failed,
      rateLimited: stat.rateLimited,
      usageRate: meta.limit ? (total / meta.limit) * 100 : null,
      topEndpoints,
      failReasons,
      tokens,
    };
  });

  return { day, providers };
}

/** 최근 N일 총 호출 수 (추이용) */
export async function getHistory(days = 14): Promise<{ day: string; counts: Record<ApiProvider, number> }[]> {
  const data = await load();
  return Object.keys(data)
    .sort()
    .slice(-days)
    .map((day) => {
      const d = data[day];
      const counts = {} as Record<ApiProvider, number>;
      for (const p of Object.keys(DAILY_LIMITS) as ApiProvider[]) {
        const s = d[p];
        counts[p] = s ? s.ok + s.failed : 0;
      }
      return { day, counts };
    });
}

/**
 * 보관 중인 전 기간 AI 비용.
 *
 * 하루치만 보여 주면 "얼마 썼나"에 답을 못 한다 — 매일 아침 0원부터 다시 시작하는
 * 화면을 보면서 실제 청구서와 비교할 수는 없다. 그래서 누적을 따로 낸다.
 * (보관은 30일이므로 그보다 오래된 것은 여기에도 없다. 그 사실을 같이 돌려준다)
 */
export interface UsageTotals {
  from: string;
  to: string;
  days: number;
  /** 이 기간에 실제로 기록이 있는 날 수 — 30일 보관이라 그보다 짧을 수 있다 */
  estimatedUsd: number;
  byFeature: { feature: UsageFeature; label: string; calls: number; usd: number }[];
  byModel: { model: string; calls: number; input: number; output: number; usd: number }[];
  byDay: { day: string; usd: number }[];
  /** 모델·기능을 못 가르는 옛 기록이 섞여 있는가 */
  hasLegacy: boolean;
}

export async function getTotals(days = 30): Promise<UsageTotals> {
  const data = await load();
  const allDays = Object.keys(data).sort().slice(-days);

  const byFeatureMap = new Map<UsageFeature, { calls: number; usd: number }>();
  const byModelMap = new Map<string, { calls: number; input: number; output: number; usd: number }>();
  const byDay: { day: string; usd: number }[] = [];
  let estimatedUsd = 0;
  let hasLegacy = false;

  for (const day of allDays) {
    let dayUsd = 0;
    for (const p of ["anthropic", "gemini", "openai"] as const) {
      const stat = data[day]?.[p];
      if (!stat) continue;
      const t = summarizeBuckets(stat, day);
      dayUsd += t.estimatedUsd;
      if (t.hasLegacy) hasLegacy = true;

      for (const f of t.byFeature) {
        const cur = byFeatureMap.get(f.feature) ?? { calls: 0, usd: 0 };
        cur.calls += f.calls;
        cur.usd += f.usd;
        byFeatureMap.set(f.feature, cur);
      }
      for (const m of t.byModel) {
        const cur = byModelMap.get(m.model) ?? { calls: 0, input: 0, output: 0, usd: 0 };
        cur.calls += m.calls;
        cur.input += m.input;
        cur.output += m.output;
        cur.usd += m.usd;
        byModelMap.set(m.model, cur);
      }
    }
    estimatedUsd += dayUsd;
    byDay.push({ day, usd: dayUsd });
  }

  return {
    from: allDays[0] ?? "",
    to: allDays[allDays.length - 1] ?? "",
    days: allDays.length,
    estimatedUsd,
    byFeature: [...byFeatureMap.entries()]
      .map(([feature, v]) => ({ feature, label: FEATURE_LABEL[feature] ?? feature, ...v }))
      .sort((a, b) => b.usd - a.usd),
    byModel: [...byModelMap.entries()]
      .map(([model, v]) => ({ model, ...v }))
      .sort((a, b) => b.usd - a.usd),
    byDay,
    hasLegacy,
  };
}
