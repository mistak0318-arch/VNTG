import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RULES, type CisRules } from "./cisTrader.js";
import type { AiChoice } from "./aiConfig.js";
import type { PensionMethod } from "./cisPensionRun.js";

/**
 * CIS 모드 설정 — 이 계좌의 **규칙과 성격**을 벤티지가 조절하는 자리.
 *
 * ## 왜 따로 두나
 *
 * 기존 `aiConfig` 는 「어떤 모델을 쓸까」만 정한다. 여기서 정하는 것은 그게 아니라
 * **어떻게 매매할까**다 — 손절폭, 종목 수, 빌릴지 말지. 둘을 한 화면에 섞으면
 * 「모델 바꾸려다 손절폭을 건드리는」 사고가 난다.
 *
 * ## AI 를 어디까지 쓰나
 *
 * ⚠️ **AI 는 매매 판단을 바꾸지 않는다** — 기본값에서는. 규칙이 재현 가능해야
 * 복기가 되기 때문이다(`cisTrader` 머리 주석). AI 는 세 자리에 붙는다:
 *
 *   1. `narrate` — 규칙이 만든 뼈대를 트레이더 목소리로 다듬는다. 판단 무관.
 *   2. `screen`  — 후보에 경고를 단다. 기본은 **말만 하고 못 막는다.**
 *   3. `weekly`  — 며칠치를 놓고 「어느 규칙이 나빴나」를 짚는다. 사람이 읽고 고친다.
 *
 * `screenVeto` 를 켜면 2번이 실제로 후보를 뺄 수 있다. 그 순간 이 계좌는 재현
 * 불가능해지므로 **끄는 것이 기본**이고, 켜면 화면에 그렇게 적힌다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data", "cis");
const FILE = join(DATA_DIR, "config.json");

export interface CisAiUse {
  /** 일지 문장 다듬기 */
  narrate: boolean;
  /** 후보 경고 */
  screen: boolean;
  /** 주간 복기 */
  weekly: boolean;
  /**
   * 후보 경고에 **거부권**을 준다. 켜면 AI 가 뺀 종목은 안 산다.
   * ⚠️ 켜는 순간 같은 날을 다시 돌려도 같은 답이 안 나온다.
   */
  screenVeto: boolean;
  /** 어떤 모델로 — null 이면 기본(ANTHROPIC_API_KEY + CLAUDE_MODEL) */
  model: AiChoice | null;
}

export interface CisConfig {
  /** 계좌를 굴릴까. 끄면 스케줄러가 아무것도 안 한다 */
  enabled: boolean;
  /** 자동으로 하루 세 번 쓸까. 끄면 화면에서 손으로 눌러야 돈다 */
  auto: boolean;
  /**
   * **장중 내내 볼까** (1분마다). 끄면 하루 세 번만 본다.
   *
   * 손절선은 12시 30분에만 있는 게 아니다 — 10시에 뚫고 12시에 되돌아오면
   * 세 번만 보는 계좌는 그 손절을 없었던 일로 적는다. 켜는 것이 현실에 가깝다.
   * 비용은 ka10095 하루 390회뿐이고 AI 는 안 부른다.
   */
  watch: boolean;
  /**
   * **몇 분마다 살 자리를 찾을까** (0 이면 안 찾는다 — 하루 세 번만).
   *
   * 15분이 기본이다. 1분으로 하면 후보 스캔(주도주+종목별 신호등)이 초당 5회
   * 한도에 걸리고, 무엇보다 **후보가 1분 사이에 바뀌지 않는다** — 자주 보면
   * 조건 경계에서 샀다 팔았다만 한다. 30분이면 오전 눌림목을 놓친다.
   *
   * ⚠️ 이 값이 0 보다 크면 **매수는 루프가 도맡는다.** 하루 세 번 일지는
   * 글만 쓴다 — 안 그러면 루프가 산 것을 아침 일지가 또 사려 든다.
   */
  buyScanMin: number;
  /** 하루 세 번의 시각 (KST, "HH:MM") */
  times: { morning: string; noon: string; evening: string };
  /** 빌려도 되나 — 끄면 예수금만 쓴다 */
  useMisu: boolean;
  useCredit: boolean;
  rules: CisRules;
  ai: CisAiUse;
  /**
   * 목표 금액 — **오름차순**. 4천만에서 시작해 단계를 밟는다 (2026-08-31 벤티지 지정:
   * 1차 5억 / 2차 10억 / 3차 20억 / 최종 100억).
   *
   * 목표를 두는 이유는 동기부여가 아니라 **자리 감각**이다. 「지금 어디쯤인가」가
   * 있어야 「이 속도면 언제인가」를 물을 수 있고, 그 물음이 규칙을 고치게 만든다.
   * 목표가 매매를 바꾸지는 않는다 — 목표에 쫓겨 비중을 키우는 것이 계좌를 죽이는
   * 가장 흔한 길이라, 이 값은 **화면과 글에만** 쓴다.
   */
  goals: number[];
  /**
   * 연금 계좌가 **무엇을 보고 ETF 를 고를까** (2026-08-31).
   *
   *   theme    이름을 테마·섹터 강세에 잇는다 (넓게 훑지만 근사)
   *   holdings 담은 종목을 직접 본다 (정확하지만 Top10 만 보인다)
   *   simple   품질만 — 거래대금·괴리율·추적오차
   *
   * 어느 쪽이 맞는지는 **성적으로만** 알 수 있어 고를 수 있게 뒀다. 고른 것은
   * 일지에 적힌다 — 나중에 「그때 무엇으로 골랐나」를 물을 수 있어야 비교가 된다.
   */
  pensionMethod: PensionMethod;
  /** 연금을 무슨 요일에 굴릴까 (0=일 … 6=토). 기본 월요일 */
  pensionDay: number;
}

export const DEFAULT_CIS_CONFIG: CisConfig = {
  enabled: false, // 처음엔 꺼져 있다 — 켜는 것은 사람이 정한다
  auto: true,
  watch: true,
  buyScanMin: 15,
  /*
   * 08:40 — 장 열기 20분 전. 어제 종가·간밤 해외가 다 들어와 있고, 시가에 살
   * 계획을 세울 시간이 있다.
   * 12:30 — 오전장이 끝난 자리. 오전의 힘이 오후에도 갈지 보이는 때다.
   * 15:45 — 마감 직후. 종가가 확정됐고 그날 채점이 가능하다.
   *
   * ⚠️ 마감 뒤인데 **종가배팅이 가능한 이유**: NXT 애프터마켓이 15:40~20:00 이라
   * 종가 근처 값에 실제로 살 수 있다. 15:30 에 딱 맞춰 판단하면 종가가 아직
   * 확정 전이라 「종가를 보고 종가에 산다」는 불가능한 기록이 된다 —
   * 확정된 값으로 판단하고 애프터마켓에서 담는 쪽이 현실에 맞는다.
   */
  times: { morning: "08:40", noon: "12:30", evening: "15:45" },
  useMisu: true,
  useCredit: true,
  rules: { ...DEFAULT_RULES },
  goals: [500_000_000, 1_000_000_000, 2_000_000_000, 10_000_000_000],
  /* 담은 종목을 직접 보는 쪽이 근사가 아니라서 기본으로 둔다 */
  pensionMethod: "holdings",
  /* 월요일 — 한 주의 판이 정해지기 전에 담는다 */
  pensionDay: 1,
  ai: {
    narrate: true,
    screen: true,
    weekly: true,
    screenVeto: false,
    model: null,
  },
};

let cache: CisConfig | null = null;

export async function getCisConfig(): Promise<CisConfig> {
  if (cache) return cache;
  try {
    const saved = JSON.parse(await readFile(FILE, "utf8")) as Partial<CisConfig>;
    cache = {
      ...DEFAULT_CIS_CONFIG,
      ...saved,
      times: { ...DEFAULT_CIS_CONFIG.times, ...(saved.times ?? {}) },
      /* 규칙은 **항목별로** 합친다 — 새 규칙이 생겼을 때 저장된 옛 설정이 그것을 지우면 안 된다 */
      rules: { ...DEFAULT_CIS_CONFIG.rules, ...(saved.rules ?? {}) },
      ai: { ...DEFAULT_CIS_CONFIG.ai, ...(saved.ai ?? {}) },
    };
  } catch {
    cache = { ...DEFAULT_CIS_CONFIG };
  }
  return cache;
}

/** 값의 범위를 여기서 막는다 — 화면을 믿지 않는다(직접 POST 할 수도 있다) */
function clampRules(r: Partial<CisRules>, base: CisRules): CisRules {
  const num = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
  };
  return {
    maxPerStock: num(r.maxPerStock, 3, 50, base.maxPerStock),
    maxPositions: Math.round(num(r.maxPositions, 1, 20, base.maxPositions)),
    /* 손절은 **반드시 음수** — 양수로 들어오면 사자마자 파는 계좌가 된다 */
    stopPct: -Math.abs(num(r.stopPct, -30, -1, base.stopPct)),
    targetPct: Math.abs(num(r.targetPct, 2, 100, base.targetPct)),
    maxHoldDays: Math.round(num(r.maxHoldDays, 1, 120, base.maxHoldDays)),
    /* 켬/끔 — 숫자가 아니라 참거짓이다. 안 주면 지금 값을 지킨다 */
    useRegimeGate:
      typeof r.useRegimeGate === "boolean" ? r.useRegimeGate : base.useRegimeGate,
    useListTrack:
      typeof r.useListTrack === "boolean" ? r.useListTrack : base.useListTrack,
    minScore: num(r.minScore, 0, 100, base.minScore),
    minTradeValue: num(r.minTradeValue, 0, 100_000, base.minTradeValue),
    /* 억. 0 은 「문턱 없음」이라 유효하다 */
    minMarketCap: num(r.minMarketCap, 0, 10_000_000, base.minMarketCap),
    minMarketScore: num(r.minMarketScore, 0, 100, base.minMarketScore),
    trailAfterPct: Math.abs(num(r.trailAfterPct, 1, 100, base.trailAfterPct)),
    useOpen: r.useOpen ?? base.useOpen,
    useIntra: r.useIntra ?? base.useIntra,
    useClose: r.useClose ?? base.useClose,
    maxOpenGap: Math.abs(num(r.maxOpenGap, 0, 30, base.maxOpenGap)),
    intraMinFromOpen: num(r.intraMinFromOpen, -10, 20, base.intraMinFromOpen),
    closeMinRate: num(r.closeMinRate, -10, 30, base.closeMinRate),
  };
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function saveCisConfig(input: Partial<CisConfig>): Promise<CisConfig> {
  const cur = await getCisConfig();
  const t: Partial<CisConfig["times"]> = input.times ?? {};
  const time = (v: unknown, dflt: string) => (typeof v === "string" && HHMM.test(v) ? v : dflt);

  const next: CisConfig = {
    enabled: input.enabled ?? cur.enabled,
    auto: input.auto ?? cur.auto,
    watch: input.watch ?? cur.watch,
    /* 너무 잦으면 호출 한도에 걸린다 — 0(끔) 또는 5분 이상만 받는다 */
    buyScanMin: (() => {
      const n = Number(input.buyScanMin);
      if (!Number.isFinite(n)) return cur.buyScanMin;
      if (n <= 0) return 0;
      return Math.min(120, Math.max(5, Math.round(n)));
    })(),
    times: {
      morning: time(t.morning, cur.times.morning),
      noon: time(t.noon, cur.times.noon),
      evening: time(t.evening, cur.times.evening),
    },
    useMisu: input.useMisu ?? cur.useMisu,
    useCredit: input.useCredit ?? cur.useCredit,
    rules: clampRules(input.rules ?? {}, cur.rules),
    /* 오름차순으로 정리하고 이상한 값은 버린다 — 순서가 뒤집히면 단계 계산이 무너진다 */
    goals: Array.isArray(input.goals)
      ? [...new Set(input.goals.map(Number).filter((n) => Number.isFinite(n) && n > 0))].sort(
          (a, b) => a - b,
        )
      : cur.goals,
    pensionMethod: (["theme", "holdings", "simple"] as const).includes(
      input.pensionMethod as PensionMethod,
    )
      ? (input.pensionMethod as PensionMethod)
      : cur.pensionMethod,
    pensionDay: (() => {
      const n = Number(input.pensionDay);
      return Number.isFinite(n) && n >= 0 && n <= 6 ? Math.round(n) : cur.pensionDay;
    })(),
    ai: { ...cur.ai, ...(input.ai ?? {}) },
  };
  cache = next;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/** 규칙 한 줄 설명 — 화면과 AI 프롬프트가 같은 글을 쓰게 한다 */
export const RULE_LABEL: Record<keyof CisRules, { label: string; unit: string; hint: string }> = {
  maxPerStock: { label: "한 종목 비중", unit: "%", hint: "순자산 대비. 크면 한 번에 크게 다친다" },
  maxPositions: { label: "최대 종목 수", unit: "종목", hint: "많으면 이겨도 티가 안 난다" },
  stopPct: { label: "손절", unit: "%", hint: "좁으면 흔들림에 털리고 넓으면 한 번에 크게 잃는다" },
  targetPct: { label: "익절", unit: "%", hint: "손절의 두 배는 되어야 추세추종이 성립한다" },
  maxHoldDays: { label: "최대 보유", unit: "일", hint: "안 가면 자리를 비운다 — 돈이 묶이는 게 더 비싸다" },
  minScore: { label: "신호등 최소점", unit: "점", hint: "이 아래 종목은 후보에서 뺀다" },
  minTradeValue: { label: "최소 거래대금", unit: "억", hint: "얇으면 내 주문에 값이 밀린다" },
  minMarketCap: {
    label: "최소 시가총액",
    unit: "억",
    hint:
      "거래대금만으로는 부족하다 — 시총 300억짜리가 테마에 걸려 하루 800억이 돌면 " +
      "그 문턱을 통과하지만 그건 유동성이 아니라 소나기다. 다음 날 30억으로 돌아가면 " +
      "들고 있는 물량을 못 판다. 시총은 하루 이벤트로 안 변하는 바닥 크기라, " +
      "둘을 같이 걸어야 「오늘도 돌고 평소에도 큰」 종목만 남는다. 0 이면 문턱 없음",
  },
  minMarketScore: { label: "시장 최소점", unit: "점", hint: "이 아래면 그날은 아무것도 안 산다" },
  useListTrack: {
    label: "신호등 분석 원장 쓰기",
    unit: "",
    hint:
      "매일 16:30 에 쌓이는 목록별 추적(추적 중인 초록)을 후보에 더한다. " +
      "이미 재놓은 종목이라 신호등 조회가 0회이고, 주도주 스캔이 못 보는 목록" +
      "(외국인 연속순매매·동일순매매 등)에서 온 종목이 섞인다. " +
      "⚠️ 원장은 전날 16:30 기준이라 장중 신규는 주도주 스캔이 잡는다 — 둘을 합쳐 쓴다",
  },
  useRegimeGate: {
    label: "장세 신뢰도 문",
    unit: "",
    hint:
      "「시장이 좋은가」가 아니라 「내 신호등이 오늘 골라낼 수 있나」를 묻는다. " +
      "실측: 폭 좁은 날의 초록은 시장에 -2.15%p 지고 승률 43% (넓은 날 +2.20%p, 53%). " +
      "그런데 두 날의 시장 평균은 거의 같았다 — 시장 점수로는 못 잡는 것이다",
  },
  trailAfterPct: { label: "본전 손절 전환", unit: "%", hint: "이만큼 벌면 손절선을 평단으로 올린다" },
  useOpen: { label: "시가배팅", unit: "", hint: "아침 — 어제 신호가 살아 있고 시가가 안 튀었을 때" },
  useIntra: { label: "장중배팅", unit: "", hint: "점심 — 눌렸다 회복하며 거래가 붙을 때" },
  useClose: { label: "종가배팅", unit: "", hint: "저녁 — 오늘 강하게 마감하고 판이 연속으로 강할 때" },
  maxOpenGap: { label: "허용 갭", unit: "%", hint: "이보다 크게 갭상승했으면 안 산다 — 손절까지 거리가 사라진다" },
  intraMinFromOpen: { label: "장중 회복선", unit: "%", hint: "시가 대비 이만큼 위여야 「회복했다」로 본다" },
  closeMinRate: { label: "종가배팅 최소 등락", unit: "%", hint: "어중간하게 끝난 것은 갭을 안 준다" },
};

/* ------------------------------------------------------------------ 목표 */

export interface GoalProgress {
  /** 지금 몇 단계를 지났나 (0 = 아직 1차 전) */
  stage: number;
  /** 다음 목표 금액. 다 이뤘으면 null */
  next: number | null;
  /** 다음 목표까지 몇 % 왔나 — **직전 목표를 기준으로** 잰다 */
  pct: number;
  /** 다음 목표까지 몇 배 남았나 */
  multiple: number | null;
  /** 최종 목표 대비 몇 % */
  finalPct: number;
  label: string;
}

/**
 * 지금 어디쯤인가.
 *
 * ⚠️ 진척률을 **0원 기준으로 재지 않는다.** 5억 목표에 4천만이면 8% 인데, 그 숫자는
 * 1차를 지나 5억에서 10억으로 갈 때의 「50%」와 뜻이 완전히 달라진다. 직전 목표(처음엔
 * 시드)를 0으로 놓고 재야 단계마다 같은 뜻의 숫자가 된다.
 */
export function goalProgress(equity: number, goals: number[], seed: number): GoalProgress {
  const sorted = [...goals].sort((a, b) => a - b);
  const stage = sorted.filter((g) => equity >= g).length;
  const next = stage < sorted.length ? sorted[stage] : null;
  const floor = stage === 0 ? seed : sorted[stage - 1];
  const final = sorted[sorted.length - 1] ?? 0;
  const 억 = (n: number) => `${Math.round(n / 100_000_000)}억`;
  return {
    stage,
    next,
    pct: next && next > floor ? Math.max(0, Math.min(100, ((equity - floor) / (next - floor)) * 100)) : 100,
    multiple: next && equity > 0 ? Number((next / equity).toFixed(2)) : null,
    finalPct: final > 0 ? Math.max(0, (equity / final) * 100) : 0,
    label: next ? `${stage + 1}차 ${억(next)}` : "최종 목표 달성",
  };
}
