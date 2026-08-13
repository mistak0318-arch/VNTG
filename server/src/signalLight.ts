import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getFinance } from "./dartFinance.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getSectorMood } from "./sectorMood.js";
import { findStock } from "./stockListCache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = resolve(__dirname, "..", "data", "signalConfig.json");

/**
 * 종목 신호등.
 *
 * 종목을 고를 때 매번 확인하는 것들(정배열인가, 수급이 붙었나, 이익이 늘고 있나,
 * 섹터가 뜨고 있나, 규모는 되나)을 기준으로 만들어 초록/노랑/빨강으로 압축한다.
 * 기준과 임계치는 전부 사용자가 바꿀 수 있다 — 사람마다 보는 기준이 다르기 때문이다.
 *
 * 종목당 API 호출이 여러 번이라 결과를 캐싱한다.
 */

export type CheckKey =
  | "trend"
  | "foreignFlow"
  | "instFlow"
  | "profitGrowth"
  | "sectorStrength"
  | "marketCap"
  | "volume";

export interface CheckConfig {
  key: CheckKey;
  label: string;
  /** 이 기준을 쓸지 */
  enabled: boolean;
  /** 가중치 — 중요하게 보는 기준에 더 준다 */
  weight: number;
  /** 기준값 (기준마다 의미가 다르다) */
  threshold: number;
  /** 화면에 보여줄 설명 */
  hint: string;
}

export interface SignalConfig {
  checks: CheckConfig[];
  /** 초록이 되려면 필요한 점수 비율(%) */
  greenAt: number;
  /** 노랑이 되려면 필요한 점수 비율(%). 미만이면 빨강 */
  yellowAt: number;
  /** 수급을 볼 기간(일) */
  flowDays: 5 | 10 | 20;
  /**
   * 정배열 판정에 쓸 이동평균선.
   * 짧은 것부터 오름차순으로 두면 "현재가 ≥ 짧은선 ≥ ... ≥ 긴선"을 확인한다.
   * 2개 이상 골라야 의미가 있다.
   */
  maLines: number[];
}

/** 정배열 판정에 고를 수 있는 이동평균선 */
export const MA_OPTIONS = [5, 10, 20, 60] as const;

export const DEFAULT_CONFIG: SignalConfig = {
  greenAt: 70,
  yellowAt: 40,
  flowDays: 5,
  maLines: [5, 20, 60],
  checks: [
    {
      key: "trend",
      label: "정배열",
      enabled: true,
      weight: 2,
      threshold: 0,
      hint: "현재가 ≥ 짧은 이평선 ≥ 긴 이평선 (아래에서 선 선택)",
    },
    {
      key: "foreignFlow",
      label: "외국인 수급",
      enabled: true,
      weight: 2,
      threshold: 0,
      hint: "설정 기간 외국인 순매수 합계가 기준값 이상(백만원)",
    },
    {
      key: "instFlow",
      label: "기관 수급",
      enabled: true,
      weight: 1,
      threshold: 0,
      hint: "설정 기간 기관 순매수 합계가 기준값 이상(백만원)",
    },
    {
      key: "profitGrowth",
      label: "영업이익 증가",
      enabled: true,
      weight: 2,
      threshold: 0,
      hint: "최근 사업연도 영업이익이 전년 대비 기준값(%) 이상 증가",
    },
    {
      key: "sectorStrength",
      label: "섹터 강세",
      enabled: true,
      weight: 1,
      threshold: 0,
      hint: "소속 업종 등락률이 기준값(%) 이상",
    },
    {
      key: "marketCap",
      label: "시가총액",
      enabled: true,
      weight: 1,
      threshold: 3000,
      hint: "시가총액이 기준값(억원) 이상",
    },
    {
      key: "volume",
      label: "거래대금",
      enabled: false,
      weight: 1,
      threshold: 100,
      hint: "당일 거래대금이 기준값(억원) 이상",
    },
  ],
};

/** 사용자가 보낸 이평선 목록을 허용된 값·오름차순·중복제거로 정리한다 */
function normalizeMaLines(input: unknown): number[] {
  const allowed = new Set<number>(MA_OPTIONS);
  const picked = Array.isArray(input)
    ? [...new Set(input.map(Number).filter((n) => allowed.has(n)))].sort((a, b) => a - b)
    : [];
  // 2개 미만이면 정배열이라는 말 자체가 성립하지 않으므로 기본값으로 되돌린다
  return picked.length >= 2 ? picked : [5, 20, 60];
}

let configCache: SignalConfig | null = null;

export async function getConfig(): Promise<SignalConfig> {
  if (configCache) return configCache;
  try {
    const saved = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as SignalConfig;
    // 기준이 나중에 추가돼도 저장본이 깨지지 않도록 기본값과 합친다
    const merged: SignalConfig = {
      ...DEFAULT_CONFIG,
      ...saved,
      checks: DEFAULT_CONFIG.checks.map(
        (d) => saved.checks?.find((s) => s.key === d.key) ?? d,
      ),
    };
    configCache = merged;
  } catch {
    configCache = DEFAULT_CONFIG;
  }
  return configCache;
}

export async function saveConfig(input: SignalConfig): Promise<SignalConfig> {
  const cfg: SignalConfig = { ...input, maLines: normalizeMaLines(input.maLines) };
  configCache = cfg;
  await mkdir(dirname(CONFIG_FILE), { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(cfg, null, 2), "utf-8");
  evalCache.clear(); // 기준이 바뀌면 기존 판정은 무효
  return cfg;
}

// ---------------------------------------------------------------- 평가

export type Level = "green" | "yellow" | "red" | "unknown";

export interface CheckResult {
  key: CheckKey;
  label: string;
  /** true=통과, false=미달, null=판단 불가(데이터 없음) */
  pass: boolean | null;
  /** 실제 값 (화면 표시용) */
  value: string;
  /** 눌러서 더 볼 수 있는 대상 (섹터 강세 → 업종 구성종목) */
  link?: { kind: "sector" | "theme"; code: string; name: string };
  weight: number;
}

export interface SignalResult {
  code: string;
  level: Level;
  /** 통과 가중치 / 전체 가중치 × 100 */
  score: number;
  checks: CheckResult[];
  evaluatedAt: string;
}

/** 키움 차트 TR은 기준일이 비어 있으면 데이터를 주지 않는다 */
function todayYyyymmdd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

const evalCache = new Map<string, { data: SignalResult; at: number }>();
const EVAL_TTL_MS = 15 * 60_000;

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, "").replace(/^--/, "-"));
  return Number.isFinite(n) ? n : 0;
}

/** 단순이동평균 — 최신순 배열을 받는다 */
function sma(closes: number[], period: number): number | null {
  if (closes.length < period) return null;
  return closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
}

export async function evaluateSignal(
  client: KiwoomClient,
  code: string,
  force = false,
): Promise<SignalResult> {
  const hit = evalCache.get(code);
  if (!force && hit && Date.now() - hit.at < EVAL_TTL_MS) return hit.data;

  const cfg = await getConfig();
  const enabled = cfg.checks.filter((c) => c.enabled);
  const need = new Set(enabled.map((c) => c.key));

  // 필요한 것만 조회한다 (기준을 꺼두면 호출도 안 한다)
  const wantChart = need.has("trend");
  const wantFlow = need.has("foreignFlow") || need.has("instFlow");
  const wantFinance = need.has("profitGrowth");
  const wantSector = need.has("sectorStrength");
  const wantInfo = need.has("marketCap") || need.has("volume");

  const [chart, flow, finance, mood, entry, info] = await Promise.all([
    wantChart
      ? client
          .request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
            stk_cd: code,
            base_dt: todayYyyymmdd(),
            upd_stkpc_tp: "1",
          })
          .catch(() => null)
      : null,
    wantFlow
      ? client
          .request<Record<string, unknown>>("/api/dostk/chart", "ka10060", {
            dt: todayYyyymmdd(),
            stk_cd: code,
            amt_qty_tp: "1",
            trde_tp: "0",
            unit_tp: "1000",
          })
          .catch(() => null)
      : null,
    wantFinance ? getFinance(code).catch(() => null) : null,
    wantSector ? getSectorMood(client, code).catch(() => null) : null,
    wantInfo ? findStock(client, code).catch(() => undefined) : undefined,
    wantInfo
      ? client
          .request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10001", { stk_cd: code })
          .catch(() => null)
      : null,
  ]);

  const checks: CheckResult[] = [];

  for (const c of enabled) {
    let pass: boolean | null = null;
    let link: CheckResult["link"];
    let value = "-";

    if (c.key === "trend") {
      const rows = (chart?.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
      const closes = rows.map((r) => Math.abs(toNum(r.cur_prc))).filter((n) => n > 0);
      const lines = [...cfg.maLines].sort((a, b) => a - b);
      const mas = lines.map((n) => sma(closes, n));
      const cur = closes[0];
      // 하나라도 계산이 안 되면(상장 기간 부족 등) 판단 불가로 남긴다
      if (cur && lines.length >= 2 && mas.every((m): m is number => !!m)) {
        // 현재가 → 짧은 선 → 긴 선 순으로 계속 내려가야 정배열
        const seq = [cur, ...mas];
        pass = seq.every((v, i) => i === 0 || seq[i - 1] >= v);
        const label = lines.map((n) => `${n}일`).join("≥");
        value = pass ? `정배열 (${label})` : `역배열/혼조 (${label})`;
      }
    } else if (c.key === "foreignFlow" || c.key === "instFlow") {
      const rows = (flow?.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[];
      if (rows.length > 0) {
        const field = c.key === "foreignFlow" ? "frgnr_invsr" : "orgn";
        const sum = rows.slice(0, cfg.flowDays).reduce((s, r) => s + toNum(r[field]), 0);
        pass = sum >= c.threshold;
        value = `${cfg.flowDays}일 ${sum > 0 ? "+" : ""}${Math.round(sum).toLocaleString("ko-KR")}`;
      }
    } else if (c.key === "profitGrowth") {
      const periods = finance?.periods ?? [];
      if (periods.length >= 2) {
        const latest = periods[periods.length - 1].operatingProfit;
        const prev = periods[periods.length - 2].operatingProfit;
        if (latest !== null && prev !== null && prev !== 0) {
          const g = ((latest - prev) / Math.abs(prev)) * 100;
          pass = g >= c.threshold;
          value = `${g > 0 ? "+" : ""}${g.toFixed(1)}%`;
        }
      }
    } else if (c.key === "sectorStrength") {
      if (mood?.sector) {
        pass = mood.sector.changeRate >= c.threshold;
        value = `${mood.sector.name} ${mood.sector.changeRate > 0 ? "+" : ""}${mood.sector.changeRate.toFixed(2)}%`;
        // 업종지수 코드를 찾은 경우에만 구성종목을 열 수 있다
        if (mood.sector.code) {
          link = { kind: "sector", code: mood.sector.code, name: mood.sector.name };
        }
      }
    } else if (c.key === "marketCap") {
      // ka10001의 mac은 억원 단위
      const cap = toNum(info?.data?.mac);
      if (cap > 0) {
        pass = cap >= c.threshold;
        value = `${Math.round(cap).toLocaleString("ko-KR")}억`;
      } else if (entry?.shares) {
        const price = Math.abs(toNum(info?.data?.cur_prc));
        const calc = Math.round((entry.shares * price) / 100_000_000);
        pass = calc >= c.threshold;
        value = `${calc.toLocaleString("ko-KR")}억`;
      }
    } else if (c.key === "volume") {
      // 거래량 × 현재가로 대략의 거래대금 (억원)
      const qty = toNum(info?.data?.trde_qty);
      const price = Math.abs(toNum(info?.data?.cur_prc));
      if (qty > 0 && price > 0) {
        const amount = Math.round((qty * price) / 100_000_000);
        pass = amount >= c.threshold;
        value = `${amount.toLocaleString("ko-KR")}억`;
      }
    }

    checks.push({ key: c.key, label: c.label, pass, value, weight: c.weight, link });
  }

  // 판단 불가(null)는 분모에서 뺀다 — 데이터가 없다고 감점하면 억울하다
  const judged = checks.filter((c) => c.pass !== null);
  const total = judged.reduce((s, c) => s + c.weight, 0);
  const got = judged.filter((c) => c.pass).reduce((s, c) => s + c.weight, 0);
  const score = total > 0 ? Math.round((got / total) * 100) : 0;

  const level: Level =
    total === 0 ? "unknown" : score >= cfg.greenAt ? "green" : score >= cfg.yellowAt ? "yellow" : "red";

  const result: SignalResult = {
    code,
    level,
    score,
    checks,
    evaluatedAt: new Date().toISOString(),
  };
  evalCache.set(code, { data: result, at: Date.now() });
  return result;
}

/**
 * 여러 종목 평가. 키움은 TR당 초당 5회 제한이 있어 동시에 몰면 429가 난다.
 * 3개씩 끊어서 순차 처리한다.
 */
export async function evaluateMany(
  client: KiwoomClient,
  codes: string[],
): Promise<Record<string, SignalResult>> {
  const out: Record<string, SignalResult> = {};
  const chunk = 3;
  for (let i = 0; i < codes.length; i += chunk) {
    const slice = codes.slice(i, i + chunk);
    const results = await Promise.all(
      slice.map((c) => evaluateSignal(client, c).catch(() => null)),
    );
    for (const r of results) if (r) out[r.code] = r;
  }
  return out;
}
