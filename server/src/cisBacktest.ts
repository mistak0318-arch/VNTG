import { loadCloses, type DayBar } from "./dailyCloses.js";
import { getConfig, type SignalConfig } from "./signalLight.js";
import { loadSamples, scoreFeat, type Sample } from "./signalSamples.js";
import { regimeMap } from "./signalSimulate.js";
import { DEFAULT_RULES, type CisRules } from "./cisTrader.js";

/**
 * **CIS 규칙 백테스터** (2026-09-02) — 조회 0회.
 *
 * ## 왜 만들었나
 *
 * 벤티지: "지금의 CIS를 더 똑똑하게 만들 방법있어?"
 *
 * 열어 보니 `server/data/cis` 폴더가 **아예 없었다** — CIS 는 한 번도 켜진 적이
 * 없다. 그래서 성적 기록이 없고, 튜닝할 근거도 없다. 지금 규칙은 **전부 짐작**이다:
 * 손절 -7% · 익절 +15% · 최대 10일 · 점수 60 · 신호등 가중치 0.5.
 *
 * 그런데 이제 잴 수 있다. 표본 2.8만 관측과 **전종목 일봉 OHLC**(2,751종목 ×
 * 500봉)가 있기 때문이다.
 *
 * ## 표본만으로는 못 재던 것
 *
 * 표본에는 `d1`·`d5`·`d20` 뿐이라 **중간 경로를 모른다.** 20일 뒤 +3% 인 종목이
 * 도중에 -12% 까지 빠졌는지 알 수가 없다 — 그런데 손절 -7% 는 정확히 그 도중에
 * 걸리는 규칙이다.
 *
 * 일봉에는 **고가·저가**가 있다. 편입한 날부터 하루씩 따라가며 「저가가 손절선을
 * 찍었나 · 고가가 익절선을 찍었나 · 어느 쪽이 먼저였나」를 실제로 셀 수 있다.
 *
 * ## ⚠️ 같은 날 둘 다 찍으면 **손절로 친다**
 *
 * 일봉으로는 그날 안에서 어느 쪽이 먼저였는지 알 수 없다. 분봉을 받으면 알 수
 * 있지만 종목마다 조회가 나간다.
 *
 * 모를 때는 **나쁜 쪽을 가정한다.** 익절로 치면 성적이 실제보다 좋게 나오고,
 * 그 숫자를 보고 규칙을 정하면 실전에서 그만큼 못 미친다. 백테스트가 사람을
 * 속이는 가장 흔한 자리가 여기다.
 *
 * ## 무엇과 견주나
 *
 * 「청산 규칙 없이 그냥 20일 들고 있기」와 나란히 낸다. **손절·익절이 값을 하는지**가
 * 이 도구의 물음이라, 안 했을 때와 견주지 않으면 답이 안 나온다.
 *
 * ## 이건 12월 동결 규칙 밖이다
 *
 * 신호등 문턱은 「어느 종목을 볼까」라 표본 구간이 짧으면 그 계절에 맞춰진다.
 * CIS 규칙은 「고른 것을 어떻게 굴릴까」다 — 손절이 걸리는지는 하락장 표본에서
 * 오히려 더 잘 드러난다. 다만 **점수 문턱(`minScore`)만은** 신호등 쪽에 가까우니
 * 그 값은 조심해서 읽어야 한다.
 */

/** 도구용 — 되돌림 고점을 어제까지로 늦춘다 (`tools/sigtune/cisTrail.mts`) */
const TRAIL_LAG = process.env.CIS_TRAIL_LAG === "1";

/** 어떻게 팔렸나 */
export type ExitKind = "stop" | "target" | "trail" | "drop" | "time" | "open";

export interface CisTrade {
  code: string;
  name: string;
  /** 편입 판정일 (다음 날 시가에 산다) */
  date: string;
  score: number;
  entry: number;
  exit: number;
  /** 며칠 들고 있었나 (거래일) */
  days: number;
  kind: ExitKind;
  /** 수익률 % */
  rate: number;
  /** 같은 자리를 청산 규칙 없이 20일 들고 있었다면 */
  hold20: number | null;
  /** 들고 있는 동안 최저·최고 (진입가 대비 %) — 「얼마나 참아야 했나」 */
  worst: number;
  best: number;
}

export interface CisBacktestResult {
  rules: CisRules;
  /** 몇 관측이 규칙을 통과했나 */
  n: number;
  /** 표본 전체 관측 수 — 「몇 개 중 몇 개」 */
  scanned: number;
  trades: CisTrade[];
  summary: {
    /** 규칙대로 굴렸을 때 */
    ruled: Stat;
    /** 청산 규칙 없이 20일 홀드 */
    hold: Stat;
    /** 청산 사유별 */
    byKind: { kind: ExitKind; label: string; n: number; avg: number; med: number }[];
    /**
     * **손익비** — 이긴 거래의 평균 이익 ÷ 진 거래의 평균 손실.
     *
     * 추세추종은 「이기는 횟수가 적고 이길 때 크게」 먹는 전략이라 이게 2를
     * 넘어야 성립한다고 규칙 주석에 적혀 있는데, **한 번도 확인한 적이 없었다.**
     */
    payoff: number | null;
    /** 손절 뒤 20일까지 봤으면 얼마였나 — 「너무 일찍 잘랐나」 */
    stopRegret: number | null;
    /** 익절 뒤 20일까지 봤으면 얼마였나 — 「너무 일찍 팔았나」 */
    targetRegret: number | null;
  };
  /**
   * **앞/뒤로 갈라 본 성적** (2026-09-02).
   *
   * ## 왜 없으면 안 되나
   *
   * 이 도구는 손절·익절·보유기간을 **훑어서 제일 좋은 것을 고르게** 만든다.
   * 그러면 표본에 맞춰진 값이 1등으로 올라온다 — 오늘 아침에 그 일을 겪었다.
   * 120일 표본에서 「+7.95%, 압도적」이던 조합이 **뒤쪽 절반에서 -19%p** 였다.
   *
   * 표본 날짜를 반으로 갈라 앞뒤를 따로 낸다. 한쪽만 좋으면 그건 그 구간의
   * 성질이지 규칙의 값어치가 아니다. **둘 다 양수여야** 믿을 수 있다.
   *
   * ⚠️ 지금 표본은 80거래일 한 계절뿐이라(4~5월 하락 + 7월 반등) 이 분할도
   * 「하락장 / 반등장」을 가르는 것에 가깝다. 그것대로 뜻이 있지만 —
   * **두 개의 다른 시장에서 다 통하나**를 묻는 것이므로 오히려 까다로운 시험이다.
   */
  split: { at: string; front: Stat; back: Stat; bothPositive: boolean };
  at: string;
}

export interface Stat {
  n: number;
  avg: number;
  med: number;
  win: number;
  /** 보유일 평균 */
  days: number;
}

const KIND_LABEL: Record<ExitKind, string> = {
  stop: "손절",
  target: "익절",
  trail: "본전 손절 (이익 반납)",
  drop: "고점 대비 되돌림 (추세 끝)",
  time: "기간 만료",
  open: "아직 보유 중 (봉이 모자람)",
};

function stat(rows: { rate: number; days: number }[]): Stat {
  if (rows.length === 0) return { n: 0, avg: 0, med: 0, win: 0, days: 0 };
  const v = rows.map((r) => r.rate).sort((a, b) => a - b);
  const sum = v.reduce((a, b) => a + b, 0);
  return {
    n: rows.length,
    avg: Math.round((sum / v.length) * 100) / 100,
    med: Math.round(v[v.length >> 1] * 100) / 100,
    win: Math.round((v.filter((x) => x > 0).length / v.length) * 10000) / 100,
    days: Math.round((rows.reduce((a, b) => a + b.days, 0) / rows.length) * 10) / 10,
  };
}

/**
 * 한 자리를 규칙대로 굴려 본다.
 *
 * @param bars 그 종목 일봉 (옛날 → 최신)
 * @param at   편입 판정일의 봉 인덱스. **다음 봉 시가에 산다**
 */
function runOne(bars: DayBar[], at: number, r: CisRules): Omit<CisTrade, "code" | "name" | "date" | "score"> | null {
  const entryBar = bars[at + 1];
  if (!entryBar || !(entryBar.o > 0)) return null;
  const entry = entryBar.o;

  const stopAt = entry * (1 + r.stopPct / 100);
  /* 익절 0 = 「익절 없음」 — 추세를 고정 폭으로 자르지 않는다 (신조 ③, 2026-09-02) */
  const targetAt = r.targetPct > 0 ? entry * (1 + r.targetPct / 100) : Infinity;
  /*
   * **고점 대비 되돌림** (신조 ③ — 오르는 놈은 계속 오른다, 진입 뒤에).
   * 들고 있는 동안의 최고가(고가 기준)에서 `trailDropPct` 만큼 내려오면 판다.
   * 같은 날 고가가 새 고점을 찍고 저가가 그 아래 되돌림선을 찍었으면 판 것으로
   * 친다 — 순서를 모르니 나쁜 쪽. 0 이면 끔.
   */
  const dropOn = r.trailDropPct > 0;
  let peak = entry;
  /*
   * **본전 손절** — 이익이 `trailAfterPct` 를 넘으면 손절선을 진입가로 올린다.
   * 「이익을 손실로 바꾸지 않는다」는 규칙인데, 그 대가로 흔들림에 털린다.
   * 그 맞바꿈이 실제로 얼마인지가 이 백테스트로 처음 드러난다.
   */
  const trailOn = r.trailAfterPct > 0;
  let trailArmed = false;

  let worst = 0;
  let best = 0;

  for (let k = 1; k <= r.maxHoldDays; k++) {
    const b = bars[at + k];
    if (!b) break;
    /* 첫날은 시가에 샀으므로 그날 고저도 본다 */
    const lo = ((b.l - entry) / entry) * 100;
    const hi = ((b.h - entry) / entry) * 100;
    if (lo < worst) worst = lo;
    if (hi > best) best = hi;

    /*
     * ⚠️ **손절을 먼저 본다.** 같은 날 저가가 손절선을, 고가가 익절선을 둘 다
     * 찍었을 때 일봉으로는 순서를 알 수 없다. 모를 때는 나쁜 쪽을 가정한다 —
     * 익절로 치면 성적이 실제보다 좋게 나오고, 그 숫자로 규칙을 정하면 실전이
     * 그만큼 못 미친다.
     */
    const armedStop = trailArmed ? entry : stopAt;
    if (b.l <= armedStop) {
      const px = Math.min(armedStop, b.o > 0 ? b.o : armedStop);
      return {
        entry,
        exit: px,
        days: k,
        kind: trailArmed ? "trail" : "stop",
        rate: ((px - entry) / entry) * 100,
        hold20: null,
        worst,
        best,
      };
    }
    if (b.h >= targetAt) {
      const px = Math.max(targetAt, b.o > 0 ? b.o : targetAt);
      return {
        entry,
        exit: px,
        days: k,
        kind: "target",
        rate: ((px - entry) / entry) * 100,
        hold20: null,
        worst,
        best,
      };
    }
    if (dropOn) {
      /*
       * 기본은 오늘 고가까지 고점에 넣고 오늘 저가와 견준다(나쁜 쪽 가정).
       * `CIS_TRAIL_LAG=1` 이면 어제까지의 고점만 쓴다 — 후한 쪽. 둘을 같이 봐야
       * 「같은 날 순서를 모른다」는 가정이 결론을 흔드는지 알 수 있다(도구용).
       */
      if (!TRAIL_LAG && b.h > peak) peak = b.h;
      const dropAt = peak * (1 - r.trailDropPct / 100);
      if (TRAIL_LAG && b.h > peak) peak = b.h;
      /* 손절선·본전선보다 위에 있을 때만 뜻이 있다 — 아래면 위에서 이미 걸렸다 */
      if (dropAt > armedStop && b.l <= dropAt) {
        const px = Math.min(dropAt, b.o > 0 ? b.o : dropAt);
        return {
          entry,
          exit: px,
          days: k,
          kind: "drop",
          rate: ((px - entry) / entry) * 100,
          hold20: null,
          worst,
          best,
        };
      }
    }
    /* 오늘 종가 기준으로 본전 손절을 켤지 정한다 — 장중에 스쳤다고 켜지 않는다 */
    if (trailOn && !trailArmed && ((b.c - entry) / entry) * 100 >= r.trailAfterPct) {
      trailArmed = true;
    }
  }

  /* 기간 만료 — 마지막으로 있는 봉의 종가에 판다 */
  const lastIdx = Math.min(at + r.maxHoldDays, bars.length - 1);
  const lastBar = bars[lastIdx];
  if (!lastBar || lastIdx <= at) return null;
  const held = lastIdx - at;
  return {
    entry,
    exit: lastBar.c,
    days: held,
    kind: held < r.maxHoldDays ? "open" : "time",
    rate: ((lastBar.c - entry) / entry) * 100,
    hold20: null,
    worst,
    best,
  };
}

/**
 * 표본 전체를 규칙대로 굴린다. **조회 0회** — 표본과 일봉 파일만 읽는다.
 *
 * @param limit 너무 많으면 잘라 낸다(화면이 다 못 그린다). 통계는 자르기 전 전부로 낸다.
 */
export async function cisBacktest(
  rules: Partial<CisRules> = {},
  cfgIn?: SignalConfig,
  limit = 300,
): Promise<CisBacktestResult | null> {
  const file = await loadSamples();
  if (!file || file.samples.length === 0) return null;
  const cfg = cfgIn ?? (await getConfig());
  const r: CisRules = { ...DEFAULT_RULES, ...rules };
  const { bars } = await loadCloses();
  const barsOf = bars ?? {};

  const S = file.samples;
  const regimeOf = regimeMap(S, cfg);

  /* 종목별 날짜 → 봉 인덱스. 한 번만 만든다 */
  const idxOf = new Map<string, Map<string, number>>();
  const indexFor = (code: string): Map<string, number> | null => {
    const hit = idxOf.get(code);
    if (hit) return hit;
    const bs = barsOf[code];
    if (!bs) return null;
    const m = new Map<string, number>();
    bs.forEach((b, i) => m.set(b.d, i));
    idxOf.set(code, m);
    return m;
  };

  const trades: CisTrade[] = [];
  const holdRows: { rate: number; days: number }[] = [];

  for (const s of S) {
    /*
     * ## CIS 의 문에 실제로 걸리는 것만
     *
     * 순서가 뜻을 가진다 — 싼 판정부터 본다. 점수는 계산이 붙으므로 마지막이다.
     */
    if (r.minTradeValue > 0 && s.volEok !== null && s.volEok < r.minTradeValue) continue;
    if (r.minMarketCap > 0 && s.mktCap !== null && s.mktCap < r.minMarketCap) continue;

    const sc = scoreFeat(s, cfg, regimeOf.get(s.date));
    if (!sc) continue;
    /*
     * ⚠️ **커버리지 미달은 뺀다.** 실전 신호등이 그런 종목에 초록을 안 주므로
     * (`lowCoverage`) 여기서 세면 실전에 없는 자리를 재게 된다.
     */
    if (sc.lowCoverage) continue;
    if (sc.score < r.minScore) continue;

    const map = indexFor(s.code);
    const bs = barsOf[s.code];
    if (!map || !bs) continue;
    const at = map.get(s.date);
    if (at === undefined) continue;

    const t = runOne(bs, at, r);
    if (!t) continue;

    /* 견줄 자리 — 같은 진입가로 청산 규칙 없이 20일 */
    const exit20 = bs[at + 20];
    const hold20 =
      exit20 && t.entry > 0 ? ((exit20.c - t.entry) / t.entry) * 100 : null;

    trades.push({
      code: s.code,
      name: s.name,
      date: s.date,
      score: sc.score,
      ...t,
      hold20,
    });
    if (hold20 !== null) holdRows.push({ rate: hold20, days: 20 });
  }

  const ruled = stat(trades);
  const hold = stat(holdRows);

  /* 청산 사유별 */
  const kinds: ExitKind[] = ["stop", "trail", "drop", "target", "time", "open"];
  const byKind = kinds
    .map((k) => {
      const rows = trades.filter((t) => t.kind === k);
      const st = stat(rows);
      return { kind: k, label: KIND_LABEL[k], n: st.n, avg: st.avg, med: st.med };
    })
    .filter((x) => x.n > 0);

  /* 손익비 — 이긴 거래의 평균 이익 ÷ 진 거래의 평균 손실 */
  const wins = trades.filter((t) => t.rate > 0).map((t) => t.rate);
  const losses = trades.filter((t) => t.rate < 0).map((t) => -t.rate);
  const payoff =
    wins.length > 0 && losses.length > 0
      ? Math.round(
          ((wins.reduce((a, b) => a + b, 0) / wins.length) /
            (losses.reduce((a, b) => a + b, 0) / losses.length)) *
            100,
        ) / 100
      : null;

  /*
   * **후회 지표** — 자르고 나서 어떻게 됐나.
   *
   * 손절한 자리를 20일까지 들고 있었으면 얼마였나(양수면 「너무 일찍 잘랐다」),
   * 익절한 자리는 얼마까지 갔나(양수면 「너무 일찍 팔았다」).
   *
   * 이 두 숫자가 손절·익절 폭을 정하는 근거다. 지금은 -7 / +15 인데 아무도
   * 어디서 왔는지 모른다.
   */
  const regret = (kind: ExitKind): number | null => {
    const rows = trades.filter((t) => t.kind === kind && t.hold20 !== null);
    if (rows.length === 0) return null;
    const d = rows.map((t) => (t.hold20 as number) - t.rate);
    return Math.round((d.reduce((a, b) => a + b, 0) / d.length) * 100) / 100;
  };

  /*
   * 앞/뒤 분할 — 날짜 가운데를 자른다. 거래 수가 아니라 **날짜**로 자르는 이유는
   * 어느 날에 거래가 몰릴 수 있어서다(그날 초록이 많았으면 그 하루가 절반을 먹는다).
   */
  const dates = [...new Set(trades.map((t) => t.date))].sort();
  const cut = dates[Math.floor(dates.length / 2)] ?? "";
  const frontRows = trades.filter((t) => t.date < cut);
  const backRows = trades.filter((t) => t.date >= cut);
  const front = stat(frontRows);
  const back = stat(backRows);

  return {
    rules: r,
    n: trades.length,
    scanned: S.length,
    /* 최근 것부터 — 화면이 위에서 아래로 읽는다 */
    trades: [...trades].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit),
    summary: {
      ruled,
      hold,
      byKind,
      payoff,
      stopRegret: regret("stop"),
      targetRegret: regret("target"),
    },
    split: {
      at: cut,
      front,
      back,
      /* 한쪽만 좋으면 그 구간의 성질이지 규칙의 값어치가 아니다 */
      bothPositive: front.n > 0 && back.n > 0 && front.avg > 0 && back.avg > 0,
    },
    at: new Date().toISOString(),
  };
}
