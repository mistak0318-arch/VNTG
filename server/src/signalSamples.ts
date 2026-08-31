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
 * 여기 담긴 것은 **되짚을 수 있는 기준뿐**이다 — 일봉에서 나오는 것들과,
 * 2026-08-31 부터는 **수급 3종**(`ka10060` 이 하루하루를 준다).
 *
 * 아직 없는 것은 **ETF 뒷배·영업이익·시가총액**이다. 그때의 편입 비중·공시·
 * 상장주식수를 우리가 갖고 있지 않다. 따라서 **그 셋의 문턱은 시뮬레이터로 정할 수
 * 없다** — 없는 것을 지어내느니 없다고 적는다.
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

  /*
   * 수급 (2026-08-31 추가) — `ka10060` 이 **날짜별로** 주므로 과거도 되짚힌다.
   *
   * 신호등은 `flowDays` 만큼 합산해서 문턱과 잰다. 그런데 그 날수는 설정값이라
   * 하루하루를 다 들고 있어야 시뮬레이션이 되는데, 19만 관측 × 20일치를 파일에
   * 담으면 수십 MB 가 된다. 그래서 **쓸 만한 몇 개만 미리 합쳐 둔다** —
   * `flowDays` 를 5·10·20 밖으로 옮기면 가장 가까운 것으로 재고, 화면이 그걸 적는다.
   *
   * 단위는 신호등과 **같아야 한다** — `amt_qty_tp:"1"`(금액·백만원), `unit_tp:"1000"`.
   * 다르면 저장된 문턱이 딴 값을 재게 된다.
   */
  /** 외국인 순매수 합 — 최근 5·10·20·60 거래일 */
  fgn5: number | null;
  fgn10: number | null;
  fgn20: number | null;
  /**
   * 60거래일 (2026-09-01 추가).
   *
   * 벤티지가 「5일간 10일간 20일간 60일간」 넷을 다 본다고 했는데 60 만 없었다.
   * **같은 응답 안에 있어 조회가 안 는다** — 안 담고 있었을 뿐이다.
   */
  fgn60: number | null;
  /** 기관 순매수 합 */
  inst5: number | null;
  inst10: number | null;
  inst20: number | null;
  inst60: number | null;
  /**
   * **주포** — 투신 + 연기금등 + 사모펀드 (2026-09-01 추가).
   *
   * 「기관계」는 열두 주체의 합이라 서로 상쇄된다. 금융투자(증권사 자기매매)는
   * 헤지·차익 물량이 섞여 방향이 아니고, 은행·보험은 잘 안 움직인다. 실제로
   * 방향을 만드는 셋만 따로 담는다 — `algoScan` 과 신호등의 `smartMoney` 가
   * 쓰는 것과 **같은 세 칸**이다.
   *
   * 이것도 같은 응답에 있어 조회가 안 는다.
   */
  smart5: number | null;
  smart20: number | null;
  smart60: number | null;
  /** 그날 기준 외국인 연속 순매수 일수 */
  fgnStreak: number | null;
  /**
   * **그날의 시가총액(억원)** (2026-09-01 추가).
   *
   * ## 왜 이게 필요한가
   *
   * 수급 문턱이 **절대 금액**이라 대형주 필터가 되는 문제가 계속 발목을 잡았다 —
   * 훑기 1위 조합의 90~100점 구간이 시장을 못 이긴 이유가 그것이었다(순매수
   * 100억을 넘기는 건 대형주뿐이고, 대형주는 20일에 덜 움직인다).
   *
   * 시총이 있으면 문턱을 **시총 대비 비율**로 바꿔 볼 수 있다 — 시총 1조 종목의
   * 100억과 5,000억 종목의 100억은 다른 사건이다.
   *
   * ## 조회가 안 는다
   *
   * 상장주식수는 `stockListCache` 에 이미 있고(하루 캐시), 그날 종가는 일봉에
   * 있다. **곱하면 그날의 시총**이다. 과거 시총을 주는 조회를 따로 부를 필요가
   * 없었다 — 재료가 양쪽에 흩어져 있었을 뿐이다.
   *
   * ⚠️ 상장주식수는 **오늘 것**이다. 증자·감자·액면분할이 있었으면 그 전 구간의
   * 시총이 어긋난다. 400거래일이면 드물지만 없지는 않다 — 정밀한 값이 아니라
   * 「대형주냐 중소형주냐」를 가르는 자로 쓴다.
   */
  mktCap: number | null;

  /*
   * 공매도 · 대차잔고 · 외국인 지분율 (2026-09-01 추가).
   *
   * ## 왜 이제야 담나
   *
   * 셋 다 **화면에도 있고 신호등 계산에도 있었는데 표본에만 없었다.** 그래서
   * 「공매도 비중이 높으면 위험」 같은 판정을 **한 번도 검증하지 못한 채** 켜 두고
   * 있었다. 벤티지가 "공매도 대차잔고도 의미있게 바꿔주고" 라고 해서 방향 중심으로
   * 고쳤는데, 그 개편이 맞는지도 잴 수가 없었다.
   *
   * 셋 다 **기간 조회라 과거 시계열이 온다** — 되짚을 수 있다. 종목당 3콜이 더
   * 나가지만(500종목이면 1,500콜), 검증 못 하는 기준 셋을 안으로 들이는 값이다.
   *
   * ⚠️ 못 받으면 null 이다. 코스닥 소형주는 공매도·대차 기록이 아예 없는 날이 많다.
   */
  /** 그날까지 5거래일 평균 공매도 거래비중(%) */
  short5: number | null;
  /** 그 이전 15거래일 평균(%) — 신호등의 「방향」이 이 둘의 차다 */
  short20: number | null;
  /** 대차잔고(주) — 그날 값 */
  loan: number | null;
  /** 20거래일 전 대비 증감률(%). 음수면 갚는 중(숏커버) */
  loanUp20: number | null;
  /** 외국인 지분율(%) — 그날 값 */
  fgnRatio: number | null;
  /** 20거래일 전 대비 %p 변화 */
  fgnRatioUp20: number | null;

  /**
   * **금리 민감도(베타)** (2026-08-31 — "금리인하 기대주인지, 인상 시 방어주인지").
   *
   * ## 왜 이름표가 아니라 가격으로 재나
   *
   * 「금리인하 수혜주」 목록으로 과거를 채점하면 **테마 강세가 -5.76%p 로 실패한
   * 것과 똑같은 look-ahead** 가 된다 — 지금 그렇게 불리는 종목으로 과거를 매기는
   * 것이라, 이미 오른 것이 좋아 보이게 된다. 뉴스·텔레그램에서 뽑으면 더 나쁘다.
   * 기사는 **오른 다음에** 나온다.
   *
   * 그래서 **실제 움직임으로** 정의한다: 그 시점 직전 60거래일 동안
   * **미 10년물 금리가 1%p 움직일 때 이 종목이 몇 % 움직였나**(회귀계수).
   *
   *   음수  금리가 오르면 내린다 — 「금리인하 기대주」(성장·고밸류)
   *   양수  금리가 오르면 오른다 — 「금리인상 수혜」(은행·보험)
   *   0 근처 금리와 상관없이 움직인다
   *
   * 매수 시점(그날 종가)까지의 자료만 쓰므로 **look-ahead 가 없다.**
   *
   * ⚠️ 한국 국고채가 아니라 **미 10년물(^TNX)** 이다. 야후가 일별로 주고, 국내 증시가
   * 거기 크게 반응한다. 한국 국고채 일별 시계열은 확인된 출처가 없다.
   *
   * ⚠️ 회귀는 **상관이지 인과가 아니다.** 같은 기간에 같이 움직였다는 뜻일 뿐이다.
   */
  rateBeta: number | null;
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

/** 채점에 필요한 설정 조각 — 전체 설정을 넘기지 않아도 되게 */
export type GradeCtx = Pick<SignalConfig, "maLines" | "flowDays">;

/** 이 기준이 이 표본에서 몇 점인가 — 낼 수 없으면 null */
export function gradeOf(f: Feat, c: CheckConfig, cfg: GradeCtx): number | null {
  const { maLines, flowDays } = cfg;
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
    case "foreignFlow": {
      const v = pickFlow(f.fgn5, f.fgn10, f.fgn20, flowDays);
      return v === null ? null : grade(v, c);
    }
    case "instFlow": {
      const v = pickFlow(f.inst5, f.inst10, f.inst20, flowDays);
      return v === null ? null : grade(v, c);
    }
    case "flowStreak":
      return f.fgnStreak === null ? null : grade(f.fgnStreak, c);

    /* ---------------- 수급 개편 (2026-09-01) ---------------- */
    case "flowPersist": {
      /*
       * 여덟 구간(외인 5·10·20·60 · 기관 5·10·20·60) 중 몇이 플러스인가.
       * 신호등(`signalLight`)의 계산과 **같은 규칙**이어야 한다 — 못 잰 구간은
       * 세지 않고, 절반도 못 재면 판정하지 않는다.
       */
      const spans = [5, 10, 20, 60].filter((n) => n <= (c.span ?? 60));
      const byLen: Record<number, [number | null, number | null]> = {
        5: [f.fgn5, f.inst5],
        10: [f.fgn10, f.inst10],
        20: [f.fgn20, f.inst20],
        60: [f.fgn60, f.inst60],
      };
      const vals: (number | null)[] = [];
      for (const n of spans) vals.push(byLen[n][0], byLen[n][1]);
      const measured = vals.filter((v) => v !== null && Number.isFinite(v)) as number[];
      if (measured.length < Math.max(2, spans.length)) return null;
      return grade(measured.filter((v) => v > 0).length, c);
    }
    case "flowAccel": {
      /*
       * 짧은 쪽 ÷ 긴 쪽(일평균). 표본에는 5·10·20·60 만 있으므로 **가장 가까운
       * 짝**으로 잰다 — span 20 이면 5÷20, span 60 이면 20÷60(=60/4 에 가장 가까움).
       */
      const long = c.span ?? 20;
      const pair: [number | null, number, number | null, number] =
        long >= 60 ? [f.fgn20, 20, f.fgn60, 60] : long >= 20 ? [f.fgn5, 5, f.fgn20, 20] : [f.fgn5, 5, f.fgn10, 10];
      const [sv, sn, lv, ln] = pair;
      if (sv === null || lv === null) return null;
      const dS = sv / sn;
      const dL = lv / ln;
      if (dL > 0) return grade(dS / dL, c);
      /* 긴 쪽이 순매도인데 짧은 쪽이 순매수면 전환이다 — 신호등과 같은 규칙 */
      return dS > 0 ? grade(c.strongAt, c) : grade(0, c);
    }
    case "smartMoney": {
      const long = c.span ?? 20;
      const v = long >= 60 ? f.smart60 : long >= 20 ? f.smart20 : f.smart5;
      return v === null ? null : grade(v, c);
    }
    case "marketCap":
      return f.mktCap === null ? null : grade(f.mktCap, c);
    case "flowRatio": {
      /* (외인 + 기관) ÷ 시총 × 100. 순매수는 백만원, 시총은 억원 */
      const long = c.span ?? 20;
      const fg = long >= 60 ? f.fgn60 : long >= 20 ? f.fgn20 : f.fgn5;
      const it = long >= 60 ? f.inst60 : long >= 20 ? f.inst20 : f.inst5;
      if (fg === null || it === null || f.mktCap === null || f.mktCap <= 0) return null;
      return grade((((fg + it) / 100) / f.mktCap) * 100, c);
    }
    case "shortSaleUp": {
      /*
       * 신호등과 **같은 규칙**이어야 한다 — 최근 5일 평균에서 그 이전 15일 평균을
       * 뺀 %p, 그리고 비중 20% 초과분만 수준으로 얹는다.
       */
      if (f.short5 === null) return null;
      const diff = f.short20 === null ? 0 : f.short5 - f.short20;
      const level = Math.max(0, (f.short5 - 20) / 20);
      return grade(diff + level, c);
    }
    case "lendingUp":
      return f.loanUp20 === null ? null : grade(f.loanUp20, c);
    case "foreignRatioUp":
      return f.fgnRatioUp20 === null ? null : grade(f.fgnRatioUp20, c);

    default:
      /* 표본에 없는 기준 — 재무·시가총액·ETF 뒷배. 채점에서 빠진다 */
      return null;
  }
}

/**
 * `flowDays` 에 가장 가까운 합을 고른다.
 *
 * 하루하루를 다 담으면 파일이 수십 MB 라 5·10·20 만 미리 합쳐 뒀다. 그 사이 값을
 * 고르면 **가장 가까운 것으로 재고**, 그 사실을 화면이 적는다 — 조용히 다른 값을
 * 재면 「7일로 바꿨는데 왜 성적이 그대로지」에서 막힌다.
 */
function pickFlow(
  d5: number | null,
  d10: number | null,
  d20: number | null,
  flowDays: number,
): number | null {
  const opts: [number, number | null][] = [
    [5, d5],
    [10, d10],
    [20, d20],
  ];
  let best: [number, number | null] = opts[0];
  for (const o of opts) {
    if (Math.abs(o[0] - flowDays) < Math.abs(best[0] - flowDays)) best = o;
  }
  return best[1];
}

/** 표본이 실제로 재는 수급 날수 — 화면이 「7일이라 했지만 5일로 쟀다」를 적는다 */
export function effectiveFlowDays(flowDays: number): number {
  const opts = [5, 10, 20];
  return opts.reduce((a, b) => (Math.abs(b - flowDays) < Math.abs(a - flowDays) ? b : a), 5);
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
    const g = gradeOf(f, c, cfg);
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
