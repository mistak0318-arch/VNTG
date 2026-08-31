import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import path, { dirname, join } from "node:path";
import type { CheckConfig, SignalConfig } from "./signalLight.js";

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");

/**
 * 신호등 시뮬레이터의 **표본 창고**.
 *
 * ## 왜 필요했나 (2026-08-31 — "신호등이 적절한지는 어떻게 봐야해")
 *
 * 백테스트는 설정 하나를 채점하는 데 **500 종목의 일봉을 새로 받아** 7분이 걸렸다.
 * 그래서 조합을 볼 수가 없었다 — 문턱 하나 옮겨 보려고 7분을 기다리면 아무도
 * 두 번은 안 한다. 결국 「이 설정이 맞나」에 답할 방법이 없었다.
 *
 * 그런데 **비싼 것은 일봉이지 채점이 아니다.** 일봉에서 뽑아낸 원시값
 * (신고가 대비 몇 %, 이격 몇 %, 매물 몇 %…)은 설정과 무관하다. 설정이 정하는 건
 * 그 값을 어디서 자르고 얼마로 곱하느냐뿐이다.
 *
 * 그래서 **원시값만 한 번 받아 파일로 두고**, 설정이 바뀌면 그 파일을 다시 채점한다.
 * 6만 관측을 다시 채점하는 데 수십 밀리초면 된다 — 슬라이더를 움직이는 대로
 * 성적이 따라 나온다.
 *
 * ## ⚠️ 표본이 답하지 못하는 것
 *
 * 여기 담긴 것은 **일봉으로 되짚을 수 있는 기준뿐**이다. 수급·재무·ETF 뒷배는
 * 그때의 값을 우리가 갖고 있지 않아 표본에 없고, 따라서 **그 기준들의 문턱은
 * 시뮬레이터로 정할 수 없다.** 없는 것을 지어내느니 없다고 적는다.
 *
 * 그리고 `theme`(테마 강세)은 **오늘의 테마 구성으로 과거를 채점한 값**이다.
 * 지금 잘나가는 테마에 속한 종목이 과거에도 좋았던 것처럼 부풀려진다
 * (look-ahead). 시뮬레이터에서 이 기준만 꺼 보면 그 영향이 바로 보인다.
 */

const FILE = path.join(DATA_DIR, "signalSamples.json");

/**
 * 이동평균은 **설정이 바꿀 수 있는 것**이라 값을 통째로 들고 있는다.
 * `maLines` 가 이 안의 조합이면 다시 받지 않고 정배열을 다시 판정할 수 있다.
 */
export const MA_PERIODS = [5, 10, 20, 60, 120] as const;

/** 어느 하루, 어느 종목의 **설정과 무관한** 원시값 */
export interface Feat {
  /** 종가 */
  cur: number;
  /** MA_PERIODS 와 같은 순서. 못 낸 것은 null */
  ma: (number | null)[];
  /** 직전 60일 최고 종가 대비 몇 % — 신고가·고점 근접이 쓴다 */
  hiPct: number | null;
  /** 20일선 이격 % (음수는 0으로 눌러 둔다 — 신호등과 같은 규칙) */
  disp: number | null;
  /** 5일선 이격 % */
  ma5Gap: number | null;
  /** 위쪽 매물 비중 % (120일 중 현재가보다 위에서 거래된 몫) */
  over: number | null;
  /** 그날 거래대금(억) */
  volEok: number | null;
  /** 그날 이 종목의 가장 강한 테마 등락률 % — 되짚지 못한 날은 null */
  theme: number | null;
}

export interface Sample extends Feat {
  code: string;
  name: string;
  date: string;
  /** 다음 날 시가에 사서 k 거래일 뒤 종가에 판 수익률 % */
  d1: number | null;
  d5: number | null;
  d20: number | null;
}

export interface SampleFile {
  builtAt: string;
  /** 몇 거래일을 되짚었나 */
  days: number;
  /** 몇 종목에서 뽑았나 */
  codeCount: number;
  samples: Sample[];
}

let cache: SampleFile | null = null;

export async function saveSamples(f: SampleFile): Promise<void> {
  cache = f;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(f), "utf-8");
}

export async function loadSamples(): Promise<SampleFile | null> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(FILE, "utf-8");
    cache = JSON.parse(raw) as SampleFile;
    return cache;
  } catch {
    return null;
  }
}

/** 창고에 무엇이 있나 — 표본을 다시 받아야 하는지 화면이 판단할 때 쓴다 */
export async function samplesMeta(): Promise<{
  has: boolean;
  builtAt?: string;
  days?: number;
  codeCount?: number;
  obs?: number;
}> {
  const f = await loadSamples();
  if (!f) return { has: false };
  return { has: true, builtAt: f.builtAt, days: f.days, codeCount: f.codeCount, obs: f.samples.length };
}

/* ------------------------------------------------------------------ */
/* 채점 — 백테스트와 **같은 규칙**이어야 한다                            */
/* ------------------------------------------------------------------ */

/**
 * ⚠️ `hi`/`lo` 를 max/min 으로 정규화한다 — 문턱이 뒤집혀 저장돼도 동작은 맞다.
 * 대신 **화면이 거짓말할 수 있으므로** saveConfig 에서 순서를 바로잡아 저장한다.
 */
function grade(value: number, c: CheckConfig): number {
  const hi = Math.max(c.threshold, c.strongAt);
  const lo = Math.min(c.threshold, c.strongAt);
  if (value >= hi) return 100;
  if (value >= lo) return 50;
  return 0;
}

/** 이 기준이 이 표본에서 몇 점인가 — 낼 수 없으면 null */
export function gradeOf(f: Feat, c: CheckConfig, maLines: number[]): number | null {
  switch (c.key) {
    case "trend": {
      const vs = [...maLines]
        .sort((a, b) => a - b)
        .map((p) => {
          const i = MA_PERIODS.indexOf(p as (typeof MA_PERIODS)[number]);
          return i < 0 ? null : f.ma[i];
        });
      if (vs.some((v) => v === null || v === undefined)) return null;
      const v = vs as number[];
      const full = f.cur >= v[0] && v.every((x, i) => i === 0 || v[i - 1] >= x);
      return full ? 100 : f.cur >= v[0] ? 50 : 0;
    }
    case "newHigh":
    case "nearHigh":
      return f.hiPct === null ? null : grade(f.hiPct, c);
    case "disparity":
      return f.disp === null ? null : grade(f.disp, c);
    case "ma5Gap":
      return f.ma5Gap === null ? null : grade(f.ma5Gap, c);
    case "overhead":
      return f.over === null ? null : grade(f.over, c);
    case "volume":
      return f.volEok === null ? null : grade(f.volEok, c);
    case "naverTheme":
      return f.theme === null ? null : grade(f.theme, c);
    default:
      /* 표본에 없는 기준 — 수급·재무·ETF 뒷배. 채점에서 빠진다 */
      return null;
  }
}

export interface Scored {
  score: number;
  level: "green" | "yellow" | "red";
  /** 위험 축 점수 — 높을수록 위험. 낼 수 없으면 null */
  risk: number | null;
}

/**
 * 표본 하나를 지금 설정으로 채점한다.
 *
 * 위험 축은 **섞지 않는다** — 실제 신호등과 같은 규칙이다. 위험하면 초록을 막는다.
 */
export function scoreFeat(f: Feat, cfg: SignalConfig): Scored | null {
  const axes: Record<string, { sum: number; w: number }> = {};
  for (const c of cfg.checks) {
    if (!c.enabled) continue;
    const g = gradeOf(f, c, cfg.maLines);
    if (g === null) continue;
    (axes[c.axis] ??= { sum: 0, w: 0 });
    axes[c.axis].sum += g * c.weight;
    axes[c.axis].w += c.weight;
  }
  const risk = axes.risk && axes.risk.w > 0 ? axes.risk.sum / axes.risk.w : null;
  const good = (["trend", "flow", "value"] as const)
    .map((k) => ({ k, a: axes[k] }))
    .filter((x) => x.a && x.a.w > 0);
  if (good.length === 0) return null;
  const wSum = good.reduce((s, x) => s + cfg.axisWeights[x.k], 0);
  if (wSum <= 0) return null;
  const score = Math.round(
    good.reduce((s, x) => s + (x.a.sum / x.a.w) * cfg.axisWeights[x.k], 0) / wSum,
  );
  const level: Scored["level"] =
    risk !== null && risk >= 75 ? "red" : score >= 70 ? "green" : score >= 45 ? "yellow" : "red";
  return { score, level, risk };
}
