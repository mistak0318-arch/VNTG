import { mkdir, readFile, writeFile } from "node:fs/promises";
import { exportYoyForSector, getTradeStats } from "./tradeStats.js";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alCode } from "./alCode.js";
import { analystOpinion } from "./analystOpinion.js";
import { getFinance } from "./dartFinance.js";
import { latestRatio } from "./financialRatio.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateThemes } from "./customThemes.js";
import { getSectorMood } from "./sectorMood.js";
import { findStock } from "./stockListCache.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = resolve(__dirname, "..", "data", "signalConfig.json");

/**
 * 종목 신호등.
 *
 * 종목을 고를 때 매번 확인하는 것들을 하나로 압축한다. 기준과 임계치는 전부 사용자가 바꾼다 —
 * 사람마다 보는 기준이 다르기 때문이다.
 *
 * ## 왜 축으로 나눴나 (2026-08-19 개편)
 *
 * 예전엔 여덟 기준을 가중평균해 한 점수로 냈다. 두 가지가 잘못됐다.
 *
 * **첫째, 70점이 무엇인지 알 수 없었다.** 실적이 좋고 수급이 최악인 종목과 그 반대가
 * 같은 점수로 나온다. 살 이유와 팔 이유가 평균에서 상쇄돼 버린다.
 * 그래서 **추세·수급·실적을 따로 낸다.**
 *
 * **둘째, 위험을 깎을 수단이 아예 없었다.** 공매도가 늘든 위에 매물이 잔뜩 걸렸든
 * 감점할 곳이 없어서, 위험한 종목이 초록으로 나올 수 있었다.
 * 그래서 **위험 축을 따로 두고 평균에 섞지 않는다.** 앞의 셋이 아무리 좋아도
 * 위험이 빨강이면 초록을 주지 않는다(`riskBlocksGreen`). 치명적인 위험이
 * 좋은 추세에 씻겨 나가면 안 된다.
 *
 * ## O/X 대신 세 단계
 *
 * 예전엔 `합계 >= 기준값` 한 줄이라 외국인 순매수 +1백만원과 +5,000억이 **같은 1점**이었다.
 * 크기를 통째로 버린 셈이다. 이제 기준마다 선이 둘이다 — `threshold`(50점)와
 * `strongAt`(100점). 판단 불가는 여전히 null 이고 분모에서 뺀다.
 *
 * ## 기존 코드와의 약속
 *
 * `CheckResult.pass` 는 **그대로 남긴다.** watchTracking·paperTrade·tradeJournal·
 * signalScreen 넷이 이 값을 쓴다. `grade >= 50` 이면 통과다.
 * 위험 기준만 반대로 — `grade < 50`(안전) 이 통과다. 그래서 위험 기준의 이름은
 * 「매물 부담 낮음」처럼 **안전한 상태**로 적는다. 그래야 통과/미달 목록이 바로 읽힌다.
 *
 * 종목당 API 호출이 여러 번이라 결과를 캐싱한다.
 */

export type Axis = "trend" | "flow" | "value" | "risk";

export const AXES: { key: Axis; label: string; hint: string }[] = [
  { key: "trend", label: "추세", hint: "지금 올라가는 자리인가" },
  { key: "flow", label: "수급", hint: "누가 사고 있나" },
  { key: "value", label: "실적·가치", hint: "회사가 벌고 있나" },
  { key: "risk", label: "위험", hint: "깨질 구석이 있나 — 높을수록 위험" },
];

export type CheckKey =
  | "trend"
  | "nearHigh"
  | "newHigh"
  | "sectorStrength"
  | "themeStrength"
  | "myThemeStrength"
  | "foreignFlow"
  | "instFlow"
  | "flowStreak"
  | "volume"
  | "profitGrowth"
  | "marketCap"
  | "exportGrowth"
  | "targetUpside"
  | "targetTrend"
  | "roe"
  | "overhead"
  | "disparity"
  | "shortSaleUp"
  | "lendingUp"
  | "debtRatio";

export interface CheckConfig {
  key: CheckKey;
  label: string;
  /** 어느 축에 들어가나 */
  axis: Axis;
  /** 이 기준을 쓸지 */
  enabled: boolean;
  /** 축 안에서의 가중치 */
  weight: number;
  /** 50점 선 */
  threshold: number;
  /** 100점 선 */
  strongAt: number;
  /** 화면에 보여줄 설명 */
  hint: string;
  /**
   * 이 기준을 켜면 **종목당 조회가 몇 번 더** 나가나.
   * 「신호등 찾기」는 100종목을 도는데, 여기 1이 붙은 걸 켜면 100번이 더 나간다.
   * 설정 화면이 이걸 읽어 미리 알려 준다.
   */
  cost: number;
  /**
   * 같은 호출을 나눠 쓰는 기준끼리 묶는 이름.
   *
   * 목표가 괴리율과 눈높이 상향은 **한 번의 응답**에서 둘 다 나온다. 둘 다 켰다고
   * 두 번 부르지 않으므로, 비용을 셀 때 이 묶음마다 한 번만 세야 한다.
   * 없으면 그 기준 혼자 비용을 낸다.
   */
  costGroup?: string;
}

export interface SignalConfig {
  checks: CheckConfig[];
  /** 초록이 되려면 필요한 점수 */
  greenAt: number;
  /** 노랑이 되려면 필요한 점수. 미만이면 빨강 */
  yellowAt: number;
  /** 수급을 볼 기간(일) */
  flowDays: 5 | 10 | 20;
  /**
   * 정배열 판정에 쓸 이동평균선.
   * 짧은 것부터 오름차순으로 두면 "현재가 ≥ 짧은선 ≥ ... ≥ 긴선"을 확인한다.
   * 2개 이상 골라야 의미가 있다.
   */
  maLines: number[];
  /** 축끼리의 가중치 — 무엇을 더 중요하게 볼지 */
  axisWeights: Record<"trend" | "flow" | "value", number>;
  /** 위험도가 이 이상이면 노랑 */
  riskYellowAt: number;
  /** 위험도가 이 이상이면 빨강 */
  riskRedAt: number;
  /** 위험이 빨강이면 종합을 초록으로 올리지 않는다 */
  riskBlocksGreen: boolean;
}

/** 정배열 판정에 고를 수 있는 이동평균선 */
export const MA_OPTIONS = [5, 10, 20, 60] as const;

export const DEFAULT_CONFIG: SignalConfig = {
  greenAt: 70,
  yellowAt: 40,
  flowDays: 5,
  maLines: [5, 20, 60],
  axisWeights: { trend: 1, flow: 1, value: 1 },
  riskYellowAt: 40,
  riskRedAt: 70,
  riskBlocksGreen: true,
  checks: [
    // ---------------- 추세 ----------------
    {
      key: "trend",
      label: "정배열",
      axis: "trend",
      enabled: true,
      weight: 2,
      threshold: 0,
      strongAt: 0,
      hint: "현재가 ≥ 짧은 이평선 ≥ 긴 이평선 (아래에서 선 선택). 완전 정배열 100, 가장 짧은 선 위 50",
      cost: 0,
    },
    {
      key: "nearHigh",
      label: "고점 근접",
      axis: "trend",
      enabled: true,
      weight: 1,
      threshold: 80,
      strongAt: 95,
      hint: "현재가가 52주 고가의 몇 %인가. 신고가 부근일수록 높다",
      cost: 0,
    },
    /*
     * 60일 신고가 — **자체 백테스트가 고른 기준이다** (2026-08-25).
     *
     * 조건 백테스트(코스피 상위 20, 2024-03~2026-08)에서 「60일 신고가 돌파 →
     * 20일 보유」가 기준선 대비 **+3.77%p** 로, 잰 조건 중 엣지가 가장 컸다.
     * 그런데 신호등엔 52주 고가 근접만 있고 정작 이게 없었다 — 검증된 것부터
     * 넣는 게 순서다. 일봉을 재사용하므로 조회는 안 늘어난다.
     */
    {
      key: "newHigh",
      label: "60일 신고가",
      axis: "trend",
      enabled: true,
      weight: 1,
      threshold: 97,
      strongAt: 100,
      hint: "현재가 ÷ 직전 60일 고가(%). 100이면 돌파 — 자체 백테스트에서 엣지가 가장 컸던 조건(20일 뒤 +3.77%p)",
      cost: 0,
    },
    /*
     * 「어느 무리에 속했나」는 **세 갈래**다. 하나로 합치면 답이 흐려진다.
     *
     *   업종   거래소가 정한 분류. 업종 지수와 업종 수급이라는 **실제 데이터**가 붙는다
     *   테마   시장이 부르는 이름. 키움이 묶어 준다 — 업종과 자주 어긋나는데 그게 정보다
     *   내 테마 내가 묶은 것. 남이 안 묶은 걸 묶으려고 만든 자리라 남의 분류와 섞으면 뜻이 없다
     *
     * 셋이 같은 말을 하면 그건 센 신호고, 갈리면 왜 갈리는지가 볼거리다.
     * 각각 켜고 끌 수 있게 따로 둔다.
     */
    {
      key: "sectorStrength",
      label: "업종 강세",
      axis: "trend",
      enabled: true,
      weight: 1,
      threshold: 0,
      strongAt: 1.5,
      hint: "소속 업종 등락률(%). ⚠️ 지주사는 업종 지수가 없어 못 냅니다",
      cost: 0,
    },
    {
      key: "themeStrength",
      label: "테마 강세",
      axis: "trend",
      enabled: true,
      weight: 1,
      threshold: 0,
      strongAt: 2,
      hint: "이 종목이 든 키움 테마 중 **가장 센 것**의 등락률(%)",
      cost: 0,
    },
    {
      key: "myThemeStrength",
      label: "내 테마 강세",
      axis: "trend",
      /* 내 테마를 안 만들었으면 늘 빈칸이라 기본은 꺼 둔다 */
      enabled: false,
      weight: 1,
      threshold: 0,
      strongAt: 2,
      hint: "내가 묶은 테마 중 이 종목이 든 것의 등락률(%)",
      cost: 0,
    },
    // ---------------- 수급 ----------------
    {
      key: "foreignFlow",
      label: "외국인 수급",
      axis: "flow",
      enabled: true,
      weight: 2,
      threshold: 0,
      strongAt: 10000,
      hint: "설정 기간 외국인 순매수 합계(백만원). 종목 규모와 무관한 절대금액이라 대형주에 유리하다",
      cost: 0,
    },
    {
      key: "instFlow",
      label: "기관 수급",
      axis: "flow",
      enabled: true,
      weight: 1,
      threshold: 0,
      strongAt: 10000,
      hint: "설정 기간 기관 순매수 합계(백만원)",
      cost: 0,
    },
    {
      key: "flowStreak",
      label: "외인 연속 순매수",
      axis: "flow",
      enabled: true,
      weight: 1,
      threshold: 2,
      strongAt: 5,
      hint: "외국인이 며칠 연속 순매수했나. 하루치 큰 금액보다 이어지는 게 낫다",
      cost: 0,
    },
    {
      key: "volume",
      label: "거래대금",
      axis: "flow",
      enabled: false,
      weight: 1,
      threshold: 100,
      strongAt: 500,
      hint: "당일 거래대금(억원)",
      cost: 0,
    },
    // ---------------- 실적·가치 ----------------
    {
      key: "profitGrowth",
      label: "영업이익 증가",
      axis: "value",
      enabled: true,
      weight: 2,
      threshold: 0,
      strongAt: 20,
      hint: "최근 사업연도 영업이익 전년 대비 증가율(%)",
      cost: 0,
    },
    {
      key: "marketCap",
      label: "시가총액",
      axis: "value",
      enabled: true,
      weight: 1,
      threshold: 3000,
      strongAt: 10000,
      hint: "시가총액(억원)",
      cost: 0,
    },
    {
      key: "targetUpside",
      label: "목표가 괴리율",
      axis: "value",
      enabled: false,
      weight: 2,
      threshold: 10,
      strongAt: 30,
      hint: "증권사 목표가 중앙값까지 남은 폭(%). 한투 조회가 종목당 1회 더 나간다",
      cost: 1,
      costGroup: "hantooOpinion",
    },
    {
      key: "targetTrend",
      label: "목표가 눈높이 상향",
      axis: "value",
      enabled: false,
      weight: 1,
      threshold: 0,
      strongAt: 5,
      hint: "최근 3개월 컨센서스가 그 이전 3개월보다 몇 % 높은가. 목표가 괴리율과 같은 응답에서 나온다",
      cost: 1,
      costGroup: "hantooOpinion",
    },
    {
      key: "roe",
      label: "ROE",
      axis: "value",
      enabled: false,
      weight: 2,
      threshold: 8,
      strongAt: 15,
      hint: "자기자본이익률(%). 한투 재무비율 조회가 종목당 1회 더 나간다",
      cost: 1,
      costGroup: "hantooRatio",
    },
    {
      key: "exportGrowth",
      label: "업종 수출 증가",
      axis: "value",
      enabled: false,
      weight: 1,
      threshold: 0,
      strongAt: 10,
      hint: "소속 업종의 관세청 수출 증감률(%) (수출입 API 키 필요)",
      cost: 0,
    },
    // ---------------- 위험 (값이 클수록 위험하다) ----------------
    {
      key: "overhead",
      label: "매물 부담 낮음",
      axis: "risk",
      enabled: true,
      weight: 2,
      threshold: 40,
      strongAt: 65,
      hint: "최근 120일 매물 중 현재가 **위에** 쌓인 비중(%). 높을수록 오를 때 팔 사람이 많다",
      cost: 0,
    },
    {
      key: "disparity",
      label: "이격도 정상",
      axis: "risk",
      enabled: true,
      weight: 1,
      threshold: 15,
      strongAt: 25,
      hint: "현재가가 20일선보다 몇 % 위인가. 너무 벌어지면 되돌림이 온다",
      cost: 0,
    },
    {
      key: "debtRatio",
      label: "부채비율 안정",
      axis: "risk",
      enabled: false,
      weight: 1,
      threshold: 150,
      strongAt: 250,
      hint: "부채비율(%). 높을수록 위험하다. ROE 와 같은 응답에서 나온다",
      cost: 1,
      costGroup: "hantooRatio",
    },
    {
      key: "shortSaleUp",
      label: "공매도 안정",
      axis: "risk",
      enabled: false,
      weight: 1,
      threshold: 5,
      strongAt: 10,
      hint: "최근 5일 평균 공매도 거래비중(%)",
      cost: 1,
    },
    {
      key: "lendingUp",
      label: "대차 안정",
      axis: "risk",
      enabled: false,
      weight: 1,
      threshold: 5,
      strongAt: 15,
      hint: "대차잔고가 5거래일 전 대비 몇 % 늘었나. 빌려 간 주식은 결국 팔린다",
      cost: 1,
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

/**
 * 저장본과 기본값을 합친다.
 *
 * **통째로 덮어쓰면 안 된다.** 예전 저장본에는 `axis` 도 `strongAt` 도 없다 —
 * 저장된 항목을 그대로 쓰면 축이 없는 기준이 생겨 화면이 무너진다.
 * 그래서 **뼈대는 기본값에서, 사용자가 정한 값(켬/끔·가중치·기준값)만 저장본에서** 가져온다.
 */
function mergeConfig(saved: Partial<SignalConfig> | null): SignalConfig {
  const savedChecks = new Map(
    (saved?.checks ?? []).map((c) => [c.key, c as Partial<CheckConfig>]),
  );
  return {
    ...DEFAULT_CONFIG,
    ...saved,
    axisWeights: { ...DEFAULT_CONFIG.axisWeights, ...(saved?.axisWeights ?? {}) },
    checks: DEFAULT_CONFIG.checks.map((d) => {
      const s = savedChecks.get(d.key);
      if (!s) return d;
      return {
        ...d,
        enabled: typeof s.enabled === "boolean" ? s.enabled : d.enabled,
        weight: Number.isFinite(s.weight) ? Number(s.weight) : d.weight,
        threshold: Number.isFinite(s.threshold) ? Number(s.threshold) : d.threshold,
        // strongAt 은 예전 저장본에 없다. 없으면 기본값을 쓴다
        strongAt: Number.isFinite(s.strongAt) ? Number(s.strongAt) : d.strongAt,
      };
    }),
    maLines: normalizeMaLines(saved?.maLines ?? DEFAULT_CONFIG.maLines),
  };
}

export async function getConfig(): Promise<SignalConfig> {
  if (configCache) return configCache;
  try {
    const saved = JSON.parse(await readFile(CONFIG_FILE, "utf-8")) as Partial<SignalConfig>;
    configCache = mergeConfig(saved);
  } catch {
    configCache = DEFAULT_CONFIG;
  }
  return configCache;
}

export async function saveConfig(input: SignalConfig): Promise<SignalConfig> {
  const cfg = mergeConfig(input);
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
  axis: Axis;
  /** 0 · 50 · 100. 판단 불가면 null */
  grade: number | null;
  /**
   * 통과 여부. 일반 기준은 `grade >= 50`, **위험 기준은 반대로** `grade < 50`(안전)이 통과다.
   * 기존 화면과 기록이 이 값을 쓰므로 없애지 않는다.
   */
  pass: boolean | null;
  /** 실제 값 (화면 표시용) */
  value: string;
  /** 눌러서 더 볼 수 있는 대상 (섹터 강세 → 업종 구성종목) */
  link?: { kind: "sector" | "theme"; code: string; name: string };
  weight: number;
}

export interface AxisResult {
  key: Axis;
  label: string;
  /** 0~100. 위험 축은 **위험도**(높을수록 나쁘다), 나머지는 높을수록 좋다. 판단 불가면 null */
  score: number | null;
  level: Level;
}

export interface SignalResult {
  code: string;
  level: Level;
  /** 추세·수급·실적 세 축의 가중평균 (위험은 섞지 않는다) */
  score: number;
  checks: CheckResult[];
  axes: AxisResult[];
  /** 위험 때문에 초록이 막혔나 — 화면이 이유를 말해 줄 수 있게 */
  riskCapped: boolean;
  evaluatedAt: string;
}

/** 키움 차트 TR은 기준일이 비어 있으면 데이터를 주지 않는다 */
function todayYyyymmdd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function daysAgoYyyymmdd(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
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

/**
 * 값을 0·50·100 으로 자른다.
 *
 * 위험 기준도 같은 식을 쓴다 — 값이 클수록 큰 숫자가 나오는데, 위험 축에서는
 * 그 큰 숫자가 「위험하다」는 뜻이다.
 * 사용자가 두 선을 거꾸로 넣어도 무너지지 않게 크기로 정렬해 둔다.
 */
function grade(value: number, c: CheckConfig): number {
  const hi = Math.max(c.threshold, c.strongAt);
  const lo = Math.min(c.threshold, c.strongAt);
  if (value >= hi) return 100;
  if (value >= lo) return 50;
  return 0;
}

/** 매물대 — 현재가 위에 쌓인 비중(%). 일봉을 그대로 쓰므로 추가 조회가 없다 */
function overheadPct(rows: Record<string, unknown>[]): number | null {
  const win = rows.slice(0, 120);
  if (win.length < 20) return null;
  const bars = win.map((r) => ({
    high: Math.abs(toNum(r.high_pric)),
    low: Math.abs(toNum(r.low_pric)),
    vol: Math.abs(toNum(r.trde_qty)),
  }));
  const price = Math.abs(toNum(win[0].cur_prc));
  const hi = Math.max(...bars.map((b) => b.high));
  const lo = Math.min(...bars.map((b) => b.low));
  if (!(price > 0) || !(hi > lo)) return null;

  const BANDS = 20;
  const step = (hi - lo) / BANDS;
  const vol = new Array<number>(BANDS).fill(0);
  for (const b of bars) {
    // 하루 거래량을 그날 고가~저가에 고르게 흩는다. 종가 한 점에 몰면
    // 크게 흔든 날 실제로 손바뀜한 구간을 못 잡는다
    const from = Math.min(BANDS - 1, Math.max(0, Math.floor((b.low - lo) / step)));
    const to = Math.min(BANDS - 1, Math.max(0, Math.floor((b.high - lo) / step)));
    const each = b.vol / (to - from + 1);
    for (let i = from; i <= to; i++) vol[i] += each;
  }
  const total = vol.reduce((s, v) => s + v, 0);
  if (!(total > 0)) return null;

  let above = 0;
  for (let i = 0; i < BANDS; i++) {
    const from = lo + step * i;
    const to = lo + step * (i + 1);
    if (from >= price) above += vol[i];
    else if (to > price) above += (vol[i] * (to - price)) / (to - from);
  }
  return (above / total) * 100;
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
  /*
   * 목표가 괴리율은 현재가가 있어야 잰다. 일봉 첫 줄이 현재가라 차트를 같이 받는다 —
   * 시세를 따로 부르는 것보다 싸다(정배열·매물대가 켜져 있으면 어차피 받는 응답이다).
   */
  const wantChart =
    need.has("trend") ||
    need.has("nearHigh") ||
    need.has("newHigh") ||
    need.has("overhead") ||
    need.has("disparity") ||
    need.has("targetUpside");
  // 둘은 한 응답에서 나온다. 하나만 켜도 부르고, 둘 다 켜도 한 번만 부른다
  const wantOpinion = need.has("targetUpside") || need.has("targetTrend");
  const wantRatio = need.has("roe") || need.has("debtRatio");
  const wantFlow = need.has("foreignFlow") || need.has("instFlow") || need.has("flowStreak");
  const wantFinance = need.has("profitGrowth");
  /* 테마 강세도 같은 조회에서 나온다 — `getSectorMood` 가 업종과 테마를 같이 준다 */
  const wantSector =
    need.has("sectorStrength") || need.has("themeStrength") || need.has("exportGrowth");
  const wantMyTheme = need.has("myThemeStrength");
  const wantInfo = need.has("marketCap") || need.has("volume");
  const wantShort = need.has("shortSaleUp");
  const wantLending = need.has("lendingUp");

  /*
   * 내 테마는 **전부 평가한 목록**에서 이 종목이 든 것만 고른다. 종목마다 다시 평가하면
   * 신호등 하나에 스물여덟 테마를 새로 계산하게 된다 — 목록은 그 안에서 캐싱된다.
   */
  const myThemes = wantMyTheme
    ? await evaluateThemes(client)
        .then((r) =>
          r.themes
            .filter((t) => t.codes.includes(code))
            .map((t) => ({ name: t.name, rate: t.changeRate ?? 0 })),
        )
        .catch(() => [])
    : [];

  const [chart, flow, finance, mood, entry, info, shortSale, lending, opinion, ratio] =
    await Promise.all([
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
    wantShort
      ? client
          .request<Record<string, unknown>>("/api/dostk/shsa", "ka10014", {
            // 통합(_AL) — KRX 단독은 매매비중 분모가 작아 비중이 부풀었다 (2026-08-26 실측)
            stk_cd: alCode(code),
            tm_tp: "1",
            strt_dt: daysAgoYyyymmdd(30),
            end_dt: todayYyyymmdd(),
          })
          .catch(() => null)
      : null,
    wantLending
      ? client
          .request<Record<string, unknown>>("/api/dostk/slb", "ka20068", {
            strt_dt: daysAgoYyyymmdd(30),
            end_dt: todayYyyymmdd(),
            all_tp: "0",
            stk_cd: code,
          })
          .catch(() => null)
      : null,
    // 현재가는 아직 모른다(같은 Promise.all 안이다). 괴리율은 아래에서 직접 잰다
    wantOpinion ? analystOpinion(code).catch(() => null) : null,
    wantRatio ? latestRatio(code) : null,
  ]);

  const chartRows = (chart?.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  const closes = chartRows.map((r) => Math.abs(toNum(r.cur_prc))).filter((n) => n > 0);
  const cur = closes[0];
  const flowRows = (flow?.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[];

  const checks: CheckResult[] = [];

  for (const c of enabled) {
    /** 판단 불가면 null 로 남긴다 — 데이터가 없다고 감점하면 억울하다 */
    let g: number | null = null;
    let link: CheckResult["link"];
    let value = "-";

    if (c.key === "trend") {
      const lines = [...cfg.maLines].sort((a, b) => a - b);
      const mas = lines.map((n) => sma(closes, n));
      if (cur && lines.length >= 2 && mas.every((m): m is number => !!m)) {
        const seq = [cur, ...mas];
        const full = seq.every((v, i) => i === 0 || seq[i - 1] >= v);
        const label = lines.map((n) => `${n}일`).join("≥");
        // 완전 정배열이 아니어도 가장 짧은 선 위면 절반은 준다 — 막 돌아서는 자리다
        g = full ? 100 : cur >= mas[0] ? 50 : 0;
        value = full
          ? `정배열 (${label})`
          : cur >= mas[0]
            ? `${lines[0]}일선 위 (완전 정배열은 아님)`
            : `역배열/혼조 (${label})`;
      }
    } else if (c.key === "nearHigh") {
      const win = chartRows.slice(0, 250);
      const high = win.length > 0 ? Math.max(...win.map((r) => Math.abs(toNum(r.high_pric)))) : 0;
      if (cur && high > 0) {
        const pct = (cur / high) * 100;
        g = grade(pct, c);
        value = `52주 고가의 ${pct.toFixed(0)}%`;
      }
    } else if (c.key === "newHigh") {
      /*
       * ⚠️ **오늘을 빼고** 잰다. 첫 줄이 오늘이라 포함해서 재면 현재가 ≤ 오늘 고가라
       * 100 을 절대 못 넘는다 — 「돌파」라는 말이 성립하려면 기준은 **직전** 60일이다.
       * 봉이 20개도 안 되는 새내기는 신고가라는 말 자체가 이르므로 비워 둔다.
       */
      const win = chartRows.slice(1, 61);
      const high = win.length >= 20 ? Math.max(...win.map((r) => Math.abs(toNum(r.high_pric)))) : 0;
      if (cur && high > 0) {
        const pct = (cur / high) * 100;
        g = grade(pct, c);
        value =
          pct >= 100
            ? `60일 신고가 돌파 (+${(pct - 100).toFixed(1)}%)`
            : `직전 60일 고가의 ${pct.toFixed(0)}%`;
      }
    } else if (c.key === "sectorStrength") {
      /*
       * ⚠️ **업종 지수를 못 찾았으면 점수를 주지 않는다.**
       *
       * 못 찾은 경우 등락률이 0 으로 온다. 그걸 그대로 재면 기준이 0 이라 **통과로
       * 잡힌다** — 실제로 SK 가 「지주 0.00%」로 O 를 받았다. 없는 값이 점수를 만드는
       * 건 틀린 것보다 나쁘다. 여러 사업을 거느린 지주사는 업종 하나로 잴 수 없는 게
       * 맞으므로, 그렇게 말하고 비워 둔다.
       */
      if (mood?.sector?.code) {
        g = grade(mood.sector.changeRate, c);
        value = `${mood.sector.name} ${mood.sector.changeRate > 0 ? "+" : ""}${mood.sector.changeRate.toFixed(2)}%`;
        link = { kind: "sector", code: mood.sector.code, name: mood.sector.name };
      } else if (mood?.sector) {
        value = `${mood.sector.name} — 업종 지수가 없습니다`;
      }
    } else if (c.key === "themeStrength") {
      /*
       * 든 테마 중 **가장 센 것**을 쓴다. 평균을 내면 여러 테마에 걸친 종목이 늘
       * 밋밋해진다 — 오늘 그 종목을 끌고 있는 건 대개 그중 하나다.
       */
      const best = (mood?.themes ?? []).reduce<{ name: string; changeRate: number; code: string } | null>(
        (top, t) => (top === null || t.changeRate > top.changeRate ? t : top),
        null,
      );
      if (best) {
        g = grade(best.changeRate, c);
        value = `${best.name} ${best.changeRate > 0 ? "+" : ""}${best.changeRate.toFixed(2)}%`;
        if (best.code) link = { kind: "theme", code: best.code, name: best.name };
      }
    } else if (c.key === "myThemeStrength") {
      const best = (myThemes ?? []).reduce<{ name: string; rate: number } | null>(
        (top, t) => (top === null || t.rate > top.rate ? t : top),
        null,
      );
      if (best) {
        g = grade(best.rate, c);
        value = `${best.name} ${best.rate > 0 ? "+" : ""}${best.rate.toFixed(2)}%`;
      }
    } else if (c.key === "foreignFlow" || c.key === "instFlow") {
      if (flowRows.length > 0) {
        const field = c.key === "foreignFlow" ? "frgnr_invsr" : "orgn";
        const sum = flowRows.slice(0, cfg.flowDays).reduce((s, r) => s + toNum(r[field]), 0);
        g = grade(sum, c);
        value = `${cfg.flowDays}일 ${sum > 0 ? "+" : ""}${Math.round(sum).toLocaleString("ko-KR")}`;
      }
    } else if (c.key === "flowStreak") {
      if (flowRows.length > 0) {
        // 최신부터 연속으로 순매수인 날을 센다
        let streak = 0;
        for (const r of flowRows) {
          if (toNum(r.frgnr_invsr) > 0) streak += 1;
          else break;
        }
        g = grade(streak, c);
        value = `${streak}일 연속`;
      }
    } else if (c.key === "profitGrowth") {
      const periods = finance?.periods ?? [];
      if (periods.length >= 2) {
        const latest = periods[periods.length - 1].operatingProfit;
        const prev = periods[periods.length - 2].operatingProfit;
        if (latest !== null && prev !== null && prev !== 0) {
          const growth = ((latest - prev) / Math.abs(prev)) * 100;
          g = grade(growth, c);
          value = `${growth > 0 ? "+" : ""}${growth.toFixed(1)}%`;
        }
      }
    } else if (c.key === "marketCap") {
      // ka10001의 mac은 억원 단위
      let cap = toNum(info?.data?.mac);
      if (!(cap > 0) && entry?.shares) {
        const price = Math.abs(toNum(info?.data?.cur_prc));
        cap = Math.round((entry.shares * price) / 100_000_000);
      }
      if (cap > 0) {
        g = grade(cap, c);
        value = `${Math.round(cap).toLocaleString("ko-KR")}억`;
      }
    } else if (c.key === "exportGrowth") {
      /*
       * 업종 수출 증감률. 관세청 데이터는 12시간 캐시라 종목마다 새로 부르지 않는다.
       * 수출 지표가 없는 업종(금융·서비스 등)은 판단 불가로 남긴다 —
       * 억지로 0으로 채우면 그 업종 종목이 부당하게 감점된다.
       */
      const sector = mood?.sector?.name;
      if (sector) {
        const trade = await getTradeStats().catch(() => null);
        const yoy = trade ? exportYoyForSector(trade.items, sector) : null;
        if (yoy !== null) {
          g = grade(yoy, c);
          value = `${sector} 수출 ${yoy > 0 ? "+" : ""}${yoy.toFixed(1)}%`;
        } else {
          value = `${sector} — 수출 지표 없음`;
        }
      }
    } else if (c.key === "volume") {
      // 거래량 × 현재가로 대략의 거래대금 (억원)
      const qty = toNum(info?.data?.trde_qty);
      const price = Math.abs(toNum(info?.data?.cur_prc));
      if (qty > 0 && price > 0) {
        const amount = Math.round((qty * price) / 100_000_000);
        g = grade(amount, c);
        value = `${amount.toLocaleString("ko-KR")}억`;
      }
    } else if (c.key === "targetUpside") {
      /*
       * `analystOpinion` 에 현재가를 안 넘겨서 `upside` 가 비어 있다 — 여기서 직접 잰다.
       * 넘기려면 시세를 먼저 받아야 하는데 그건 같은 Promise.all 안이라 순서가 안 맞는다.
       */
      const goal = opinion?.goalMedian ?? null;
      const price = cur || Math.abs(toNum(info?.data?.cur_prc));
      if (goal !== null && price > 0) {
        const up = ((goal - price) / price) * 100;
        g = grade(up, c);
        value = `${up > 0 ? "+" : ""}${up.toFixed(1)}% (${opinion?.brokerCount ?? 0}곳)`;
      }
    } else if (c.key === "targetTrend") {
      // 100건 상한에 걸린 응답은 오래된 쪽이 잘려 추세를 믿을 수 없다 — 판단 불가로 남긴다
      if (opinion && !opinion.truncated && opinion.goalTrend !== null) {
        g = grade(opinion.goalTrend, c);
        value = `${opinion.goalTrend > 0 ? "+" : ""}${opinion.goalTrend.toFixed(1)}%`;
      } else if (opinion?.truncated) {
        value = "조회 상한에 걸려 추세를 못 냅니다";
      }
    } else if (c.key === "roe") {
      if (ratio?.roe !== null && ratio?.roe !== undefined) {
        g = grade(ratio.roe, c);
        value = `${ratio.roe.toFixed(1)}% (${ratio.period.slice(0, 4)}년)`;
      }
    } else if (c.key === "debtRatio") {
      if (ratio?.debtRatio !== null && ratio?.debtRatio !== undefined) {
        g = grade(ratio.debtRatio, c);
        value = `${ratio.debtRatio.toFixed(0)}%`;
      }
    } else if (c.key === "overhead") {
      const pct = overheadPct(chartRows);
      if (pct !== null) {
        g = grade(pct, c);
        value = `위쪽 매물 ${pct.toFixed(0)}%`;
      }
    } else if (c.key === "disparity") {
      const ma20 = sma(closes, 20);
      if (cur && ma20) {
        const away = ((cur - ma20) / ma20) * 100;
        // 아래로 벌어진 건 과열이 아니다. 위로 벌어진 것만 위험으로 친다
        g = grade(Math.max(0, away), c);
        value = `20일선 ${away > 0 ? "+" : ""}${away.toFixed(1)}%`;
      }
    } else if (c.key === "shortSaleUp") {
      const rows = (shortSale?.data?.shrts_trnsn ?? []) as Record<string, unknown>[];
      const win = rows.slice(0, 5);
      if (win.length > 0) {
        const avg = win.reduce((s, r) => s + toNum(r.trde_wght), 0) / win.length;
        g = grade(avg, c);
        value = `5일 평균 거래비중 ${avg.toFixed(1)}%`;
      }
    } else if (c.key === "lendingUp") {
      const rows = (lending?.data?.dbrt_trde_trnsn ?? []) as Record<string, unknown>[];
      if (rows.length >= 6) {
        const now = toNum(rows[0].rmnd);
        const before = toNum(rows[5].rmnd);
        if (before > 0) {
          const up = ((now - before) / before) * 100;
          g = grade(Math.max(0, up), c);
          value = `잔고 5일 ${up > 0 ? "+" : ""}${up.toFixed(1)}%`;
        }
      }
    }

    /*
     * 위험 기준은 통과의 뜻이 반대다. 값이 크면 위험하므로 `grade < 50` 이 안전(통과)이다.
     * 이름을 「매물 부담 낮음」처럼 안전한 상태로 적어 둔 것이 이것 때문이다 —
     * 통과/미달 목록에 그대로 들어가기 때문이다.
     */
    const pass = g === null ? null : c.axis === "risk" ? g < 50 : g >= 50;
    checks.push({ key: c.key, label: c.label, axis: c.axis, grade: g, pass, value, weight: c.weight, link });
  }

  // ---- 축별 점수 ----
  const axes: AxisResult[] = AXES.map((a) => {
    const judged = checks.filter((c) => c.axis === a.key && c.grade !== null);
    const total = judged.reduce((s, c) => s + c.weight, 0);
    if (total === 0) return { key: a.key, label: a.label, score: null, level: "unknown" as Level };
    const got = judged.reduce((s, c) => s + (c.grade ?? 0) * c.weight, 0);
    const score = Math.round(got / total);
    const level: Level =
      a.key === "risk"
        ? // 위험 축은 높을수록 나쁘다 — 신호 색이 뒤집힌다
          score >= cfg.riskRedAt
          ? "red"
          : score >= cfg.riskYellowAt
            ? "yellow"
            : "green"
        : score >= cfg.greenAt
          ? "green"
          : score >= cfg.yellowAt
            ? "yellow"
            : "red";
    return { key: a.key, label: a.label, score, level };
  });

  // ---- 종합 ----
  // 위험은 평균에 섞지 않는다. 치명적인 위험이 좋은 추세에 씻겨 나가면 안 된다
  const scored = axes.filter((a) => a.key !== "risk" && a.score !== null);
  const wSum = scored.reduce((s, a) => s + cfg.axisWeights[a.key as "trend" | "flow" | "value"], 0);
  const score =
    wSum > 0
      ? Math.round(
          scored.reduce(
            (s, a) => s + (a.score ?? 0) * cfg.axisWeights[a.key as "trend" | "flow" | "value"],
            0,
          ) / wSum,
        )
      : 0;

  let level: Level =
    scored.length === 0 ? "unknown" : score >= cfg.greenAt ? "green" : score >= cfg.yellowAt ? "yellow" : "red";

  // 위험이 빨강이면 초록을 주지 않는다
  const risk = axes.find((a) => a.key === "risk");
  const riskCapped = cfg.riskBlocksGreen && risk?.level === "red" && level === "green";
  if (riskCapped) level = "yellow";

  const result: SignalResult = {
    code,
    level,
    score,
    checks,
    axes,
    riskCapped,
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
