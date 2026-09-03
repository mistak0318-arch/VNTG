import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadCloses } from "./dailyCloses.js";
import { samplesMeta } from "./signalSamples.js";
import { pushNotice } from "./notifyCenter.js";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 장세 점검 — **신호등을 다시 손볼 때가 됐나.**
 *
 * ## 왜 필요한가 (2026-08-31 벤티지)
 *
 * "신호등은 시장 색깔에 따라 매번 달라질 거야. 그럼 내가 그 시장의 중요한 변화의
 * 순간을 감지할 수 있는 어떤 그런 장치도 필요하다고 봐."
 *
 * 맞는 지적이고, 이번 점검이 그것을 증명했다. 같은 기준이 **120일 표본에서는
 * 뒤쪽 -19%p, 400일 표본에서는 +3.39%p** 였다. 기준이 변한 게 아니라 **장세가**
 * 변한 것이다. 그러니 「한 번 정하고 끝」이 아니라 **언제 다시 재야 하는지**를
 * 알려 주는 자리가 있어야 한다.
 *
 * ## 조회 0회로 잰다
 *
 * 일봉 캐시(`dailyCloses`, 2,300여 종목 × 70일)가 이미 있다. 그것만으로 시장의
 * 폭·신고가 밀도·변동성을 낼 수 있다. **매일 재도 조회가 안 나간다**는 점이
 * 중요하다 — 비싸면 안 재게 되고, 안 재면 장치가 없는 것과 같다.
 *
 * ## 무엇을 재나 — 「신호등이 먹고 사는 것」을 잰다
 *
 * 아무 지표나 재는 게 아니라, **지금 신호등이 실제로 쓰는 것**을 잰다.
 * 기본값이 「60일 신고가 + 외인 연속 순매수 + 위쪽 매물 부담」이므로:
 *
 *   신고가 밀도  — 이게 마르면 초록이 아예 안 나온다. 신호등의 밥줄이다
 *   폭(breadth)  — 20일선 위 비율. 장세의 방향 그 자체
 *   변동성       — 전 종목 등락률의 흩어짐. 급증은 장세 격변의 신호
 *
 * 그리고 도구 쪽:
 *
 *   표본 나이    — 검증에 쓴 표본이 며칠 전 것인가
 *
 * ## 문턱은 「지금 값」이 아니라 「변화」로 잡는다
 *
 * 「신고가가 3% 미만이면 경고」 같은 절대 문턱은 장세마다 다시 정해야 한다.
 * 그래서 **20일 전 대비 얼마나 변했나**로 본다 — 그건 장세가 달라도 뜻이 같다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const HIST_FILE = join(DATA_DIR, "regimeHistory.json");
const CONF_FILE = join(DATA_DIR, "regimeConfig.json");

export interface RegimeConfig {
  /** 켜 두면 매일 한 번 저절로 재고, 문턱을 넘으면 알림을 만든다 */
  enabled: boolean;
  /** 폭이 며칠 전 대비 몇 %p 떨어지면 알릴까 */
  breadthDropPp: number;
  /** 신고가 밀도가 며칠 전 대비 몇 % 줄면 알릴까 (상대 비율) */
  newHighDropPct: number;
  /** 변동성이 며칠 전 대비 몇 배가 되면 알릴까 */
  volSpikeX: number;
  /** 무엇과 견줄까 — 며칠 전 (거래일) */
  lookbackDays: number;
  /** 표본이 며칠 넘으면 「다시 모으세요」를 띄울까 */
  sampleStaleDays: number;
  /**
   * **신호등을 믿을 수 없는 장세의 문턱** (2026-08-31 — 조건부 성적표 실측).
   *
   * 19만 관측을 조건별로 갈라 보니 「폭이 좁은 날」에는 **초록이 시장에 졌다:**
   *
   *   폭 하위 1/3 (20일선 위 41% 미만)   초과 -2.15%p · 승률 43%
   *                                     앞 -2.64 · 뒤 -1.90 — 양쪽 다 음수
   *   신고가 밀도 하위 1/3 (10% 미만)     초과 -1.58%p
   *                                     앞 -1.44 · 뒤 -1.33 — 양쪽 다 음수
   *
   * 반대로 폭 상위 1/3 에서는 뒤쪽 **+2.96%p** 였다. 같은 기준이 장세에 따라
   * 부호가 뒤집힌다 — 그러면 물어야 할 것은 「어느 기준이 최고인가」가 아니라
   * **「오늘 이 도구를 믿어도 되나」**다.
   *
   * ⚠️ 문턱은 **표본에서 나온 값**이라 표본이 바뀌면 달라진다. 그래서 설정으로 뺀다.
   * 그리고 여기서 재는 폭은 일봉 캐시(2,300여 종목) 기준이라, 표본(거래대금 상위
   * 500)과 **모집단이 다르다** — 눈금이 정확히 같지는 않다.
   */
  breadthTrustAt: number;
  newHighTrustAt: number;
}

export const DEFAULT_REGIME: RegimeConfig = {
  enabled: true,
  /*
   * 폭 15%p — 20일선 위 종목이 60%에서 45%로 떨어지는 정도다. 이 정도면
   * 「조정 중」이 아니라 **장세가 바뀌는 중**이다. 10%p 로 두면 흔한 눌림에도
   * 울려서 곧 무시하게 된다.
   */
  breadthDropPp: 15,
  /*
   * 신고가 밀도 -50% — 절반으로 마르면 신호등 초록이 그만큼 안 나온다.
   * 이건 「시장이 나쁘다」가 아니라 **「이 신호등이 지금 할 일이 없다」**는 뜻이라,
   * 다른 어떤 지표보다 직접적이다.
   */
  newHighDropPct: 50,
  /* 변동성 1.8배 — 하루 등락의 흩어짐이 두 배 가까이 되면 규칙이 안 먹는 장세다 */
  volSpikeX: 1.8,
  lookbackDays: 20,
  /*
   * 표본 30일 — 검증에 쓴 400거래일 중 30일이 새로 생긴 셈이다.
   * 그보다 자주 다시 모으라고 하면 20분짜리 수집을 계속 시키는 꼴이다.
   */
  sampleStaleDays: 30,
  /* 실측 삼등분 경계 — 폭 41%, 신고가 밀도 10% */
  breadthTrustAt: 41,
  newHighTrustAt: 10,
};

/** 하루치 기록 — 추세를 보려면 쌓여 있어야 한다 */
export interface RegimeSnap {
  date: string;
  /** 20일선 위 종목 비율 % */
  breadth: number | null;
  /** 60일 신고가 근처(97% 이상) 종목 비율 % */
  newHigh: number | null;
  /** 전 종목 일간 등락률의 표준편차 % */
  vol: number | null;
  /** 전 종목 일간 등락률 중앙값 % */
  med: number | null;
  /** 잰 종목 수 */
  n: number;
}

export interface RegimeFinding {
  key: string;
  level: "info" | "warn" | "urgent";
  title: string;
  detail: string;
  /** 이 판정이 근거로 삼은 숫자 */
  now: number | null;
  then: number | null;
}

export interface RegimeResult {
  today: RegimeSnap;
  /** 견준 대상 */
  past: RegimeSnap | null;
  /** 그 대상이 어디서 왔나 — 이력(실측)인가, 캐시에서 되짚은 것인가 */
  pastFrom: "history" | "cache" | null;
  /** 몇 거래일 전과 견줬나 */
  lookbackDays: number;
  history: RegimeSnap[];
  findings: RegimeFinding[];
  sample: { has: boolean; builtAt?: string; ageDays?: number; obs?: number; codeCount?: number };
  /** 캐시가 며칠 전 것인가 — 이게 낡으면 아래 숫자가 전부 낡은 것이다 */
  cacheBuiltAt: string;
}

export async function regimeConfig(): Promise<{ config: RegimeConfig; defaults: RegimeConfig }> {
  try {
    const saved = JSON.parse(await fs.readFile(CONF_FILE, "utf-8")) as Partial<RegimeConfig>;
    return { config: { ...DEFAULT_REGIME, ...saved }, defaults: DEFAULT_REGIME };
  } catch {
    return { config: DEFAULT_REGIME, defaults: DEFAULT_REGIME };
  }
}

export async function saveRegimeConfig(input: Partial<RegimeConfig>): Promise<RegimeConfig> {
  const { config } = await regimeConfig();
  const next: RegimeConfig = {
    ...config,
    ...input,
    /* 문턱을 0 이나 음수로 두면 매일 울린다 — 그러면 곧 안 본다 */
    breadthDropPp: clamp(input.breadthDropPp ?? config.breadthDropPp, 3, 60),
    newHighDropPct: clamp(input.newHighDropPct ?? config.newHighDropPct, 10, 95),
    volSpikeX: clamp(input.volSpikeX ?? config.volSpikeX, 1.1, 5),
    lookbackDays: Math.round(clamp(input.lookbackDays ?? config.lookbackDays, 5, 60)),
    sampleStaleDays: Math.round(clamp(input.sampleStaleDays ?? config.sampleStaleDays, 7, 180)),
    breadthTrustAt: clamp(input.breadthTrustAt ?? config.breadthTrustAt, 0, 100),
    newHighTrustAt: clamp(input.newHighTrustAt ?? config.newHighTrustAt, 0, 100),
  };
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CONF_FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

const clamp = (v: number, lo: number, hi: number): number =>
  Math.min(Math.max(Number.isFinite(v) ? v : lo, lo), hi);

async function loadHistory(): Promise<RegimeSnap[]> {
  try {
    return JSON.parse(await fs.readFile(HIST_FILE, "utf-8")) as RegimeSnap[];
  } catch {
    return [];
  }
}

const sma = (xs: number[], p: number): number | null =>
  xs.length < p ? null : xs.slice(-p).reduce((a, b) => a + b, 0) / p;

/**
 * 일봉 캐시에서 오늘의 장세 지표를 낸다 — **조회 0회.**
 *
 * `k` 는 「끝에서 몇 번째 날인가」다. 0 이면 캐시의 마지막 날. 과거 날을 다시
 * 계산할 수 있어야 이력이 없어도 견줄 대상이 생긴다.
 */
function snapAt(closes: Record<string, number[]>, k: number): RegimeSnap {
  let above = 0;
  let aboveN = 0;
  let near = 0;
  let nearN = 0;
  const rates: number[] = [];

  for (const arr of Object.values(closes)) {
    if (!arr || arr.length < 22 + k) continue;
    /* 그날까지만 자른다 — 뒤쪽(미래)을 보면 지표가 통째로 거짓이 된다 */
    const hist = k > 0 ? arr.slice(0, arr.length - k) : arr;
    const cur = hist[hist.length - 1];
    const prev = hist[hist.length - 2];
    if (!(cur > 0) || !(prev > 0)) continue;

    const m20 = sma(hist, 20);
    if (m20 !== null) {
      aboveN += 1;
      if (cur >= m20) above += 1;
      rates.push(((cur - prev) / prev) * 100);
    }

    /*
     * 신고가는 **61일이 더 필요하다.** 캐시가 70일치라 20일 전의 신고가는 못 낸다
     * (82일이 있어야 한다). 그럴 때 0 으로 채우면 「신고가가 말랐다」는 거짓 경보가
     * 뜬다 — 못 내면 못 낸 채로 둔다.
     */
    if (hist.length >= 62) {
      const win = hist.slice(-61, -1);
      const hi = Math.max(...win);
      if (hi > 0) {
        nearN += 1;
        /* 신호등의 「60일 신고가」와 같은 자 — 97% 이상이면 그 기준이 점수를 준다 */
        if ((cur / hi) * 100 >= 97) near += 1;
      }
    }
  }

  if (aboveN === 0) {
    return { date: "", breadth: null, newHigh: null, vol: null, med: null, n: 0 };
  }
  const mean = rates.reduce((a, b) => a + b, 0) / rates.length;
  const vari = rates.reduce((s2, r) => s2 + (r - mean) ** 2, 0) / rates.length;
  const sorted = [...rates].sort((a, b) => a - b);
  return {
    date: "",
    breadth: Math.round((above / aboveN) * 1000) / 10,
    /* 표본이 너무 적으면 비율이 튄다 — 200 종목은 나와야 읽을 값으로 본다 */
    newHigh: nearN >= 200 ? Math.round((near / nearN) * 1000) / 10 : null,
    vol: rates.length > 0 ? Math.round(Math.sqrt(vari) * 100) / 100 : null,
    med: sorted.length > 0 ? Math.round(sorted[Math.floor(sorted.length / 2)] * 100) / 100 : null,
    n: aboveN,
  };
}

/**
 * **오늘 이 신호등을 믿을 만한 장세인가** — 부작용 없이 값만 낸다.
 *
 * `regimeCheck` 는 이력을 쓰고 알림도 만든다. 슈퍼신호등이 편입할 때마다 그걸
 * 부르면 그 회차가 이력에 끼어든다. 여기서는 **재기만** 한다.
 *
 * 근거는 조건부 성적표 실측이다 — 폭 하위 1/3 에서 초록이 시장에 -2.15%p 졌고
 * 승률이 43% 였다(앞·뒤 절반 모두 음수). 폭 상위 1/3 에서는 +2.96%p 였다.
 * 같은 기준인데 장세에 따라 **부호가 뒤집힌다.**
 *
 * 캐시가 없으면 `weak: false` 다 — **모르면 막지 않는다.** 재지 못한 것을 이유로
 * 편입을 건너뛰면 「장세가 나빠서」가 아니라 「캐시가 없어서」 안 담긴 것이 된다.
 */
export async function regimeTrust(): Promise<{
  weak: boolean;
  breadth: number | null;
  newHigh: number | null;
  /** 왜 약한가 — 화면·기록이 그대로 적는다 */
  why: string | null;
}> {
  try {
    const { config } = await regimeConfig();
    const { closes } = await loadCloses();
    if (Object.keys(closes).length === 0) {
      return { weak: false, breadth: null, newHigh: null, why: null };
    }
    const t = snapAt(closes, 0);
    const reasons: string[] = [];
    if (t.breadth !== null && t.breadth < config.breadthTrustAt) {
      reasons.push(`폭 ${t.breadth}% < ${config.breadthTrustAt}%`);
    }
    if (t.newHigh !== null && t.newHigh < config.newHighTrustAt) {
      reasons.push(`신고가 ${t.newHigh}% < ${config.newHighTrustAt}%`);
    }
    return {
      weak: reasons.length > 0,
      breadth: t.breadth,
      newHigh: t.newHigh,
      why: reasons.length > 0 ? reasons.join(" · ") : null,
    };
  } catch {
    /* 못 재면 막지 않는다 */
    return { weak: false, breadth: null, newHigh: null, why: null };
  }
}

const todayKst = (): string =>
  new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

/**
 * 지금 장세를 재고, 문턱을 넘은 것을 찾아낸다.
 *
 * `notify` 가 참일 때만 알림을 만든다 — 화면에서 그냥 눌러 보는 것이
 * 알림함을 채우면 안 된다.
 */
export async function regimeCheck(
  _client: KiwoomClient,
  opts: { notify?: boolean } = {},
): Promise<RegimeResult> {
  const { config } = await regimeConfig();
  const { closes, builtAt } = await loadCloses();

  const today = { ...snapAt(closes, 0), date: todayKst() };
  /* 이력에 오늘치를 남긴다 (하루 한 줄) */
  const hist = await loadHistory();

  /*
   * 견줄 대상을 고르는 순서 — **실제로 그날 관측한 것이 제일 낫다.**
   *
   *   ① 이력에 `lookbackDays` 거래일 전 줄이 있으면 그것
   *   ② 없으면 캐시에서 되짚어 계산 (첫날에도 뭔가는 말할 수 있게)
   *
   * ②가 필요한 이유는, 이 장치를 켠 첫날에 이력이 비어 있기 때문이다. 그때
   * 아무 말도 못 하면 **제일 필요한 순간에 쓸모가 없다.** 다만 캐시가 70일치라
   * 20일 전의 신고가는 되짚지 못한다 — 그런 칸은 비어 있고, 이력이 쌓이면 채워진다.
   */
  const past =
    hist.length > config.lookbackDays
      ? hist[hist.length - 1 - config.lookbackDays]
      : Object.keys(closes).length > 0
        ? snapAt(closes, config.lookbackDays)
        : null;
  const pastFrom: "history" | "cache" | null =
    hist.length > config.lookbackDays ? "history" : Object.keys(closes).length > 0 ? "cache" : null;

  const idx = hist.findIndex((h) => h.date === today.date);
  if (idx >= 0) hist[idx] = today;
  else hist.push(today);
  /* 1년치면 충분하다 — 그보다 옛날은 장세가 달라 견줄 뜻이 없다 */
  const trimmed = hist.slice(-260);
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(HIST_FILE, JSON.stringify(trimmed), "utf-8").catch(() => undefined);

  const meta = await samplesMeta();
  const ageDays = meta.builtAt
    ? Math.floor((Date.now() - new Date(meta.builtAt).getTime()) / 86_400_000)
    : undefined;

  const findings: RegimeFinding[] = [];
  const ok = (v: number | null | undefined): v is number => v !== null && v !== undefined && Number.isFinite(v);

  if (past && ok(today.breadth) && ok(past.breadth)) {
    const drop = past.breadth - today.breadth;
    if (drop >= config.breadthDropPp) {
      findings.push({
        key: "breadth",
        level: "urgent",
        title: "장세 전환 조짐 — 시장의 폭이 좁아졌습니다",
        detail:
          `20일선 위 종목이 ${config.lookbackDays}거래일 전 ${past.breadth}% 에서 ` +
          `${today.breadth}% 로 ${drop.toFixed(1)}%p 줄었습니다. ` +
          `추세추종 기준은 이런 구간에서 먼저 무너집니다 — 신호등 성적을 다시 재 보세요.`,
        now: today.breadth,
        then: past.breadth,
      });
    }
  }

  if (past && ok(today.newHigh) && ok(past.newHigh) && past.newHigh > 0) {
    const dropPct = ((past.newHigh - today.newHigh) / past.newHigh) * 100;
    if (dropPct >= config.newHighDropPct) {
      findings.push({
        key: "newHigh",
        level: "warn",
        title: "신고가가 마르고 있습니다 — 신호등의 밥줄입니다",
        detail:
          `60일 신고가 근처 종목이 ${past.newHigh}% 에서 ${today.newHigh}% 로 ` +
          `${dropPct.toFixed(0)}% 줄었습니다. 지금 기본값의 추세 축은 「60일 신고가」 ` +
          `하나뿐이라, 이게 마르면 초록 자체가 잘 안 나옵니다.`,
        now: today.newHigh,
        then: past.newHigh,
      });
    }
  }

  if (past && ok(today.vol) && ok(past.vol) && past.vol > 0) {
    const x = today.vol / past.vol;
    if (x >= config.volSpikeX) {
      findings.push({
        key: "vol",
        level: "urgent",
        title: "변동성이 급증했습니다",
        detail:
          `전 종목 일간 등락의 흩어짐이 ${past.vol}% → ${today.vol}% 로 ` +
          `${x.toFixed(1)}배가 됐습니다. 규칙이 잘 안 먹는 장세입니다 — ` +
          `문턱을 손보기보다 **비중을 줄이는 편**이 먼저입니다.`,
        now: today.vol,
        then: past.vol,
      });
    }
  }

  /*
   * **오늘 이 신호등을 믿어도 되나** — 위의 「장세가 바뀌었나」와 다른 물음이다.
   * 저건 「재정비할 때인가」이고 이건 **「오늘 초록을 사도 되나」**다.
   */
  if (ok(today.breadth) && today.breadth < config.breadthTrustAt) {
    findings.push({
      key: "trust-breadth",
      level: "warn",
      title: "오늘은 신호등이 잘 안 듣는 장세입니다",
      detail:
        `20일선 위 종목이 ${today.breadth}% 로 문턱(${config.breadthTrustAt}%) 아래입니다. ` +
        `19만 관측 실측에서 이 구간의 초록은 시장에 **-2.15%p 졌고 승률이 43%** 였습니다 ` +
        `(앞·뒤 절반 모두 음수). 폭이 넓은 날에는 반대로 +2.96%p 였습니다. ` +
        `기준을 손보는 자리가 아니라 **쉬어 가는 자리**로 읽는 편이 맞습니다.`,
      now: today.breadth,
      then: config.breadthTrustAt,
    });
  }
  if (ok(today.newHigh) && today.newHigh < config.newHighTrustAt) {
    findings.push({
      key: "trust-newhigh",
      level: "warn",
      title: "신고가가 말라 초록이 뜻을 잃는 구간입니다",
      detail:
        `60일 신고가 근처 종목이 ${today.newHigh}% 로 문턱(${config.newHighTrustAt}%) ` +
        `아래입니다. 추세 축이 「60일 신고가」 하나뿐이라, 이 구간의 초록은 실측에서 ` +
        `**-1.58%p** 였습니다(앞·뒤 모두 음수).`,
      now: today.newHigh,
      then: config.newHighTrustAt,
    });
  }

  if (!meta.has) {
    findings.push({
      key: "sample",
      level: "info",
      title: "검증 표본이 아직 없습니다",
      detail:
        "신호등 찾기에서 백테스트를 한 번 돌리면 표본이 만들어지고, 그 뒤로는 " +
        "설정 > 시뮬레이터에서 즉시 재 볼 수 있습니다.",
      now: null,
      then: null,
    });
  } else if (ageDays !== undefined && ageDays >= config.sampleStaleDays) {
    findings.push({
      key: "sample",
      level: "info",
      title: `검증 표본이 ${ageDays}일 지났습니다`,
      detail:
        `지금 기본값은 ${meta.codeCount}종목 × ${meta.days}거래일 표본에서 정한 값입니다. ` +
        `그동안 장세가 달라졌을 수 있으니 표본을 다시 모으고 시뮬레이터로 재 보세요.`,
      now: ageDays,
      then: config.sampleStaleDays,
    });
  }

  if (opts.notify) {
    for (const f of findings) {
      await pushNotice({
        /* 출처를 안 적어 「그 밖에」로 갔고 「장세 점검」 스위치가 헛돌았다 (2026-09-03 전수 점검) */
        source: f.key === "sample" ? "sample" : "regime",
        kind: f.key === "sample" ? "system" : "market",
        level: f.level,
        title: f.title,
        body: f.detail,
        /*
         * 누르면 **그 판단을 할 자리**로 간다.
         *   재정비·표본 → 설정
         *   「오늘 믿어도 되나」 → 신호등 찾기 (거기서 초록을 보고 있으니)
         */
        link: f.key.startsWith("trust-") ? "#/signalScreen" : "#/settings",
        dedupeKey: `regime:${f.key}`,
        /* 하루에 한 번까지만 — 같은 장세가 며칠 이어져도 매번 울리면 안 본다 */
        dedupeHours: 24,
      });
    }
  }

  return {
    today,
    past,
    pastFrom,
    lookbackDays: config.lookbackDays,
    history: trimmed.slice(-60),
    findings,
    sample: { ...meta, ageDays },
    cacheBuiltAt: builtAt,
  };
}
