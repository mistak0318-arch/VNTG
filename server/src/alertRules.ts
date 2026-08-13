import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getSectorMood } from "./sectorMood.js";

/**
 * 관심종목 시그널 판정.
 *
 * 리포트는 웹에서 봐도 되지만 이건 즉시성이 생명이다 — 놓치면 의미가 없다.
 * 그래서 조건을 넉넉하게 잡기보다 **울리면 반드시 볼 만한 것**으로 좁게 잡는다.
 * 하루에 20건 오는 알림은 0건 오는 알림과 똑같이 무시된다.
 *
 * 판정에 쓰는 데이터는 전부 이미 조회하고 있던 것들이라 새 TR이 필요 없다.
 * 종목당 최대 3콜(기본정보/일봉/투자자)이고, 관심종목이 30개면 90콜이라
 * 초당 5회 제한에 맞춰 청크로 나눠 돈다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const CONFIG_FILE = join(DATA_DIR, "alertConfig.json");
const STATE_FILE = join(DATA_DIR, "alertState.json");

export type AlertKey =
  | "priceJump"
  | "volumeSurge"
  | "flowTurn"
  | "newHigh"
  | "trendAlign";

export interface AlertRule {
  key: AlertKey;
  label: string;
  enabled: boolean;
  /** 기준값 — 규칙마다 의미가 다르다 */
  threshold: number;
  hint: string;
}

export interface AlertConfig {
  /** 시그널 검사 자체를 끌 수 있다 */
  enabled: boolean;
  /** 검사 간격(분). 너무 짧으면 API 한도를 먹는다 */
  intervalMin: number;
  rules: AlertRule[];
}

export const DEFAULT_ALERT_CONFIG: AlertConfig = {
  enabled: true,
  intervalMin: 10,
  rules: [
    {
      key: "priceJump",
      label: "급변",
      enabled: true,
      threshold: 5,
      hint: "당일 등락률 절대값이 기준값(%) 이상",
    },
    {
      key: "volumeSurge",
      label: "거래량 급증",
      enabled: true,
      threshold: 3,
      hint: "당일 거래량이 20일 평균의 기준값 배 이상",
    },
    {
      key: "flowTurn",
      label: "수급 전환",
      enabled: true,
      threshold: 0,
      hint: "외국인 5일 순매수가 직전 5일 순매도에서 매수로 전환",
    },
    {
      key: "newHigh",
      label: "250일 신고가",
      enabled: true,
      threshold: 0,
      hint: "당일 고가가 최근 250일 최고가를 넘음",
    },
    {
      key: "trendAlign",
      label: "정배열 진입",
      enabled: true,
      threshold: 0,
      hint: "어제까지 아니었다가 오늘 5>20>60 정렬 달성",
    },
  ],
};

// ---------------------------------------------------------------- 설정

let configCache: AlertConfig | null = null;

export async function getAlertConfig(): Promise<AlertConfig> {
  if (configCache) return configCache;
  try {
    const saved = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as AlertConfig;
    configCache = {
      ...DEFAULT_ALERT_CONFIG,
      ...saved,
      // 규칙이 나중에 추가돼도 저장본이 깨지지 않게 기본값과 합친다
      rules: DEFAULT_ALERT_CONFIG.rules.map(
        (d) => saved.rules?.find((s) => s.key === d.key) ?? d,
      ),
    };
  } catch {
    configCache = DEFAULT_ALERT_CONFIG;
  }
  return configCache;
}

export async function saveAlertConfig(cfg: AlertConfig): Promise<AlertConfig> {
  const next: AlertConfig = {
    ...cfg,
    // 1분 미만으로 돌면 API 한도를 먹는다
    intervalMin: Math.min(Math.max(Math.round(cfg.intervalMin) || 10, 3), 120),
  };
  configCache = next;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CONFIG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

// ---------------------------------------------------------------- 중복 방지

/** `YYYY-MM-DD|종목코드|규칙` 을 키로 이미 보낸 것을 기억한다 */
type AlertState = Record<string, string>;

async function readState(): Promise<AlertState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, "utf-8")) as AlertState;
  } catch {
    return {};
  }
}

async function writeState(state: AlertState): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

/** 오래된 기록은 버린다 — 무한히 커지면 안 된다 */
function prune(state: AlertState, keepDays = 7): AlertState {
  const cutoff = new Date(Date.now() - keepDays * 86400_000).toISOString().slice(0, 10);
  const out: AlertState = {};
  for (const [k, v] of Object.entries(state)) {
    if (k.slice(0, 10) >= cutoff) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------- 판정

export interface FiredAlert {
  code: string;
  name: string;
  rule: AlertKey;
  ruleLabel: string;
  /** 왜 울렸는지 한 줄 */
  detail: string;
  price: number;
  changeRate: number;
  /** 부가 정보 — 메시지 본문에 같이 붙인다 */
  context: string[];
}

const CHART_RESOURCE = "/api/dostk/chart";
const STKINFO_RESOURCE = "/api/dostk/stkinfo";

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}
function toAbs(v: unknown): number {
  return Math.abs(toNum(v));
}
function sma(values: number[], n: number): number | null {
  if (values.length < n) return null;
  return values.slice(0, n).reduce((s, v) => s + v, 0) / n;
}
function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("ko-KR");
}
function todayYyyymmdd(): string {
  const d = new Date();
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  return `${kst.getFullYear()}${String(kst.getMonth() + 1).padStart(2, "0")}${String(kst.getDate()).padStart(2, "0")}`;
}

/** 한 종목을 검사해 발동한 시그널들을 돌려준다 */
async function evaluateStock(
  client: KiwoomClient,
  item: { code: string; name: string },
  cfg: AlertConfig,
): Promise<FiredAlert[]> {
  const rules = new Map(cfg.rules.filter((r) => r.enabled).map((r) => [r.key, r]));
  if (rules.size === 0) return [];

  const [info, chart, flow] = await Promise.all([
    client
      .request<Record<string, unknown>>(STKINFO_RESOURCE, "ka10001", { stk_cd: item.code })
      .catch(() => null),
    client
      .request<Record<string, unknown>>(CHART_RESOURCE, "ka10081", {
        stk_cd: item.code,
        base_dt: todayYyyymmdd(),
        upd_stkpc_tp: "1",
      })
      .catch(() => null),
    rules.has("flowTurn")
      ? client
          .request<Record<string, unknown>>(CHART_RESOURCE, "ka10060", {
            stk_cd: item.code,
            dt: todayYyyymmdd(),
            amt_qty_tp: "1",
            trde_tp: "0",
            unit_tp: "1000",
          })
          .catch(() => null)
      : null,
  ]);

  const price = toAbs(info?.data?.cur_prc);
  const changeRate = toNum(info?.data?.flu_rt);
  if (price === 0) return []; // 시세를 못 받으면 판단하지 않는다

  const rows = (chart?.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  const closes = rows.map((r) => toAbs(r.cur_prc)).filter((n) => n > 0);
  const volumes = rows.map((r) => toNum(r.trde_qty));

  const fired: FiredAlert[] = [];
  const context: string[] = [];

  // 공통 부가정보 — 메시지에 같이 실어주면 앱을 안 열어도 판단이 된다
  const todayVol = toNum(info?.data?.trde_qty);
  const avgVol20 = sma(volumes.slice(1), 20); // 오늘 제외 20일
  if (todayVol > 0 && avgVol20 && avgVol20 > 0) {
    context.push(`거래량 ${fmtInt(todayVol)} (20일 평균 ${(todayVol / avgVol20).toFixed(1)}배)`);
  }

  const flowRows = (flow?.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[];
  const foreign5 = flowRows.slice(0, 5).reduce((s, r) => s + toNum(r.frgnr_invsr), 0);
  const foreignPrev5 = flowRows.slice(5, 10).reduce((s, r) => s + toNum(r.frgnr_invsr), 0);
  const inst5 = flowRows.slice(0, 5).reduce((s, r) => s + toNum(r.orgn), 0);
  if (flowRows.length > 0) {
    context.push(
      `외인 5일 ${foreign5 > 0 ? "+" : ""}${fmtInt(foreign5)} · 기관 ${inst5 > 0 ? "+" : ""}${fmtInt(inst5)}`,
    );
  }

  const mood = await getSectorMood(client, item.code).catch(() => null);
  if (mood?.sector?.name) {
    const r = mood.sector.changeRate;
    context.push(`업종 ${mood.sector.name} ${r > 0 ? "+" : ""}${r.toFixed(2)}%`);
  }

  const base = { code: item.code, name: item.name, price, changeRate, context };

  // --- 급변
  const jump = rules.get("priceJump");
  if (jump && Math.abs(changeRate) >= jump.threshold) {
    fired.push({
      ...base,
      rule: "priceJump",
      ruleLabel: jump.label,
      detail: `${changeRate > 0 ? "+" : ""}${changeRate.toFixed(2)}%`,
    });
  }

  // --- 거래량 급증
  const surge = rules.get("volumeSurge");
  if (surge && avgVol20 && avgVol20 > 0 && todayVol / avgVol20 >= surge.threshold) {
    fired.push({
      ...base,
      rule: "volumeSurge",
      ruleLabel: surge.label,
      detail: `20일 평균의 ${(todayVol / avgVol20).toFixed(1)}배`,
    });
  }

  // --- 수급 전환 (직전 5일 순매도 → 최근 5일 순매수)
  const turn = rules.get("flowTurn");
  if (turn && flowRows.length >= 10 && foreignPrev5 < 0 && foreign5 > 0) {
    fired.push({
      ...base,
      rule: "flowTurn",
      ruleLabel: turn.label,
      detail: `외국인 ${fmtInt(foreignPrev5)} → +${fmtInt(foreign5)}`,
    });
  }

  // --- 250일 신고가 (오늘 제외한 과거 최고가를 오늘 고가가 넘었는지)
  const high = rules.get("newHigh");
  if (high && rows.length >= 60) {
    const todayHigh = toAbs(info?.data?.high_pric) || price;
    const past = rows.slice(1, 251).map((r) => toAbs(r.high_pric)).filter((n) => n > 0);
    const prevMax = past.length > 0 ? Math.max(...past) : 0;
    if (prevMax > 0 && todayHigh > prevMax) {
      fired.push({
        ...base,
        rule: "newHigh",
        ruleLabel: high.label,
        detail: `${fmtInt(prevMax)} 돌파 (${past.length}일 최고)`,
      });
    }
  }

  // --- 정배열 진입 (어제까지는 아니었는데 오늘 달성한 것만)
  const align = rules.get("trendAlign");
  if (align && closes.length >= 61) {
    const aligned = (offset: number): boolean | null => {
      const s = closes.slice(offset);
      const m5 = sma(s, 5);
      const m20 = sma(s, 20);
      const m60 = sma(s, 60);
      if (!m5 || !m20 || !m60) return null;
      return s[0] >= m5 && m5 >= m20 && m20 >= m60;
    };
    // 오늘은 정배열인데 어제는 아니었을 때만 — 계속 정배열이면 매일 울릴 이유가 없다
    if (aligned(0) === true && aligned(1) === false) {
      fired.push({
        ...base,
        rule: "trendAlign",
        ruleLabel: align.label,
        detail: "5 > 20 > 60일선 정렬 달성",
      });
    }
  }

  return fired;
}

/**
 * 관심종목 전체를 검사한다.
 * 이미 오늘 보낸 시그널은 걸러서, **처음 발동한 것만** 돌려준다.
 */
export async function scanAlerts(
  client: KiwoomClient,
  watch: { code: string; name: string }[],
  opts: { dryRun?: boolean } = {},
): Promise<FiredAlert[]> {
  const cfg = await getAlertConfig();
  if (!cfg.enabled || watch.length === 0) return [];

  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const state = prune(await readState());
  const out: FiredAlert[] = [];

  // 초당 5회 제한 — 종목당 3콜이므로 한 번에 2종목씩
  for (let i = 0; i < watch.length; i += 2) {
    const chunk = watch.slice(i, i + 2);
    const results = await Promise.all(
      chunk.map((w) => evaluateStock(client, w, cfg).catch(() => [] as FiredAlert[])),
    );
    for (const list of results) {
      for (const a of list) {
        const key = `${today}|${a.code}|${a.rule}`;
        if (state[key]) continue; // 같은 종목·같은 시그널은 하루 1회
        state[key] = new Date().toISOString();
        out.push(a);
      }
    }
    if (i + 2 < watch.length) await new Promise((r) => setTimeout(r, 700));
  }

  // dryRun이면 상태를 남기지 않는다 — 테스트가 진짜 알림을 잡아먹으면 안 된다
  if (!opts.dryRun && out.length > 0) await writeState(state);
  return out;
}

// ---------------------------------------------------------------- 메시지

const RULE_ICON: Record<AlertKey, string> = {
  priceJump: "🔴",
  volumeSurge: "📊",
  flowTurn: "🔄",
  newHigh: "🚀",
  trendAlign: "📈",
};

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 발동한 시그널을 한 통으로 묶는다.
 * 종목별로 묶어서 보내야 스크롤이 줄고, 같은 종목이 두 조건에 걸린 게 한눈에 보인다.
 */
export function formatAlerts(alerts: FiredAlert[]): string {
  const byCode = new Map<string, FiredAlert[]>();
  for (const a of alerts) {
    const list = byCode.get(a.code) ?? [];
    list.push(a);
    byCode.set(a.code, list);
  }

  const blocks: string[] = [];
  for (const list of byCode.values()) {
    const head = list[0];
    const icons = list.map((a) => RULE_ICON[a.rule]).join("");
    const sign = head.changeRate > 0 ? "+" : "";
    blocks.push(
      [
        `${icons} <b>${esc(head.name)}</b> ${sign}${head.changeRate.toFixed(2)}%  ${fmtInt(head.price)}`,
        ...list.map((a) => `  · ${esc(a.ruleLabel)} — ${esc(a.detail)}`),
        ...head.context.map((c) => `  ${esc(c)}`),
      ].join("\n"),
    );
  }

  return `<b>관심종목 시그널 ${alerts.length}건</b>\n\n${blocks.join("\n\n")}`;
}
