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

export type ApiProvider = "kiwoom" | "dart" | "naver" | "yahoo";

interface DayStat {
  /** 엔드포인트(또는 TR ID)별 호출 수 */
  calls: Record<string, number>;
  ok: number;
  failed: number;
  /** 한도 초과(429 등) 횟수 — 별도로 세면 한도에 걸렸는지 바로 보인다 */
  rateLimited: number;
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
): Promise<void> {
  const data = await load();
  const day = today();
  if (!data[day]) data[day] = {} as Record<ApiProvider, DayStat>;
  if (!data[day][provider]) data[day][provider] = emptyStat();

  const stat = data[day][provider];
  stat.calls[endpoint] = (stat.calls[endpoint] ?? 0) + 1;
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
