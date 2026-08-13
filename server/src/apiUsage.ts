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
  | "dart"
  | "naver"
  | "yahoo"
  | "anthropic"
  | "gemini"
  | "openai"
  | "dataGoKr"
  | "telegram"
  | "mail";

interface DayStat {
  /** 엔드포인트(또는 TR ID)별 호출 수 */
  calls: Record<string, number>;
  ok: number;
  failed: number;
  /** 한도 초과(429 등) 횟수 — 별도로 세면 한도에 걸렸는지 바로 보인다 */
  rateLimited: number;
  /** Claude API 전용 — 다른 API와 달리 토큰이 곧 비용이라 따로 누적한다 */
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * Claude 모델별 100만 토큰당 단가(USD).
 * 비용을 "대략 얼마 나가고 있는지" 감 잡는 용도라 정확한 청구액과는 다를 수 있다.
 */
/** 100만 토큰당 USD. 공개 단가 기준이며 바뀔 수 있다 */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5, output: 25 },
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4-5-20251001": { input: 1, output: 5 },
  "gemini-2.5-flash": { input: 0.3, output: 2.5 },
  "gemini-2.5-flash-lite": { input: 0.1, output: 0.4 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
};

/** 모델명이 사전에 없으면 sonnet 단가로 추정 (과소평가보다 과대평가가 안전하다) */
function priceFor(model: string): { input: number; output: number } {
  return MODEL_PRICING[model] ?? MODEL_PRICING["claude-sonnet-5"];
}

type UsageData = Record<string, Record<ApiProvider, DayStat>>; // { "2026-08-12": { kiwoom: {...} } }

/** 각 서비스의 일일 무료 한도 (공식 문서 기준, 없으면 null) */
export const DAILY_LIMITS: Record<ApiProvider, { label: string; limit: number | null; note: string }> = {
  kiwoom: {
    label: "키움 REST API",
    limit: null,
    note: "일일 총량 제한은 없으나 TR당 초당 5회 제한이 있습니다",
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

export async function recordApiCall(
  provider: ApiProvider,
  endpoint: string,
  outcome: "ok" | "failed" | "rateLimited",
  /** Claude 호출일 때 응답의 usage를 그대로 넘기면 토큰이 누적된다 */
  tokens?: { inputTokens?: number; outputTokens?: number },
): Promise<void> {
  const data = await load();
  const day = today();
  if (!data[day]) data[day] = {} as Record<ApiProvider, DayStat>;
  if (!data[day][provider]) data[day][provider] = emptyStat();

  const stat = data[day][provider];
  stat.calls[endpoint] = (stat.calls[endpoint] ?? 0) + 1;
  if (tokens) {
    stat.inputTokens = (stat.inputTokens ?? 0) + (tokens.inputTokens ?? 0);
    stat.outputTokens = (stat.outputTokens ?? 0) + (tokens.outputTokens ?? 0);
  }
  if (outcome === "ok") stat.ok += 1;
  else if (outcome === "failed") stat.failed += 1;
  else {
    stat.rateLimited += 1;
    stat.failed += 1;
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
  /** Claude 전용 — 토큰과 추정 비용(USD). 다른 provider는 null */
  tokens: { input: number; output: number; estimatedUsd: number } | null;
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
    // 엔드포인트 이름이 곧 모델명이므로, 모델별 단가로 나눠 계산한다
    let tokens: ProviderUsage["tokens"] = null;
    if (p === "anthropic" || p === "gemini" || p === "openai") {
      const input = stat.inputTokens ?? 0;
      const output = stat.outputTokens ?? 0;
      const modelNames = Object.keys(stat.calls);
      const price = priceFor(modelNames[0] ?? "");
      const estimatedUsd = (input / 1_000_000) * price.input + (output / 1_000_000) * price.output;
      tokens = { input, output, estimatedUsd };
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
