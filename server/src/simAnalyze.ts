import type { KiwoomClient } from "./kiwoomClient.js";
import {
  coverageLimits,
  evalCond,
  loadSeriesFor,
  newState,
  step,
  summarize,
  type SimResult,
} from "./simEngine.js";
import type { SimRule } from "./simRules.js";
import { stockBars, type Point } from "./simSeries.js";

/**
 * 백테스트 **상세 분석** (2026-09-05).
 *
 * 벤티지: "백테스트를 좀 더 디테일한 분석까지 볼 수 있게… 어떤 영향인지 흐름인지
 * 알 수 있게 구성해서."
 *
 * 요약 한 줄(`SimResult`)은 **얼마 벌었나**만 답한다. 그런데 규칙을 고치려면 두 가지를
 * 더 알아야 한다:
 *
 *   **영향** — 이 조건이 성적에 무엇을 했나. 빼면 나아지나?
 *   **흐름** — 언제 벌고 언제 잃었나. 한 달에 다 벌고 나머지는 새고 있었나?
 *
 * ## 「영향」을 어떻게 재나 — **빼고 다시 돌린다**
 *
 * 조건이 며칠 맞았는지만 세면 그건 빈도지 영향이 아니다. 매일 맞는 조건은 아무것도
 * 안 거르는 것이고, 하루도 안 맞는 조건은 규칙을 통째로 막는 것인데, 둘 다 「빈도」로는
 * 좋아 보이거나 나빠 보이기만 한다.
 *
 * 그래서 **그 조건 하나를 빼고 같은 구간을 다시 돌린다.** 뺐더니 성적이 좋아지면 그
 * 조건은 **해를 끼치고 있었다.** 이건 빈도로는 절대 안 나오는 답이다.
 * 반대편도 같이 낸다 — **그 조건 하나만으로** 돌리면 얼마인가.
 *
 * ⚠️ 이 둘은 **같은 과거 한 벌**을 여러 번 재는 것이라, 조건을 여기에 맞춰 고르면
 * 그 과거에만 맞는 규칙이 된다. 도구가 그걸 막을 수는 없고, 화면이 그렇게 적는다.
 *
 * ## 판단하는 코드는 여기 한 줄도 없다
 *
 * 변형 규칙도 전부 `simEngine.step()` 을 지난다. 여기서 따로 사고팔면 분석표의 숫자와
 * 실제 백테스트가 갈리고, 그러면 이 표는 성적을 **설명**하는 게 아니라 다른 이야기를
 * 하는 것이 된다.
 */

/** 한 회차 — 자리를 잡아서 비울 때까지 */
export interface SimLeg {
  buyD: string;
  sellD: string;
  /** 낀 거래일 수 */
  held: number;
  pnl: number;
  pnlPct: number;
  buyWhy: string;
  sellWhy: string;
}

export interface CondStat {
  side: "buy" | "sell";
  /** 규칙 안에서 몇 번째 조건인가 — 화면이 이 번호로 문장을 붙인다 */
  index: number;
  /** 이 조건 하나가 참이었던 거래일 */
  hit: number;
  /** 못 잰 날 — 자료가 없으면 「안 맞음」으로 세어지므로 갈라 적는다 */
  unknown: number;
  /** 이 조건 하나만 남기고 돌렸다면 */
  alone: { ret: number; closed: number } | null;
  /** 이 조건만 빼고 돌렸다면. `emptied` 면 그 쪽 조건이 통째로 비었다는 뜻 */
  without: { ret: number; closed: number; emptied: boolean } | null;
}

export interface MonthRow {
  /** `YYYY-MM` */
  m: string;
  /** 그 달 수익률(%) — 전달 말 평가액 대비 */
  ret: number;
  /** 그 달에 끝난 회차 수 */
  legs: number;
  /** 그 달에 들고 있던 날 비율(%) */
  exposure: number;
}

export interface SimAnalysis {
  rule: SimRule;
  result: SimResult;
  /** 곡선의 날짜 — `result.curve` 와 길이가 같다 */
  days: string[];
  /** 그냥 보유했다면의 평가액 — 규칙 곡선과 **겹쳐 그리라고** 같이 보낸다 */
  hold: number[];
  /** 그날 들고 있었나 (0/1) */
  pos: number[];
  /** 구간 중 들고 있던 날 비율(%) — 「시장에 얼마나 나가 있었나」 */
  exposure: number;
  months: MonthRow[];
  legs: SimLeg[];
  conds: CondStat[];
  /** 매수 조건이 **전부** 맞은 날 / 매도 조건이 전부 맞은 날 */
  buyAllDays: number;
  sellAllDays: number;
  /**
   * 가장 오래 물려 있던 구간 — 고점을 찍고 그 고점을 되찾기까지.
   * 낙폭의 **깊이**만큼 **길이**도 실전에서 사람을 무너뜨린다.
   */
  worstSpell: { from: string; to: string; dd: number; days: number; recovered: boolean } | null;
}

const pct = (n: number) => Number(n.toFixed(2));

/** 변형 규칙 하나를 같은 구간에 돌린다 — `step()` 을 그대로 지난다 */
function run(
  rule: SimRule,
  bars: { d: string; c: number }[],
  stock: Point[],
  ext: Map<string, Point[]>,
): { ret: number; closed: number } {
  const st = newState(rule.seed);
  for (const b of bars) step(rule, st, b.d, b.c, stock, ext);
  const r = summarize(rule, st, bars);
  return { ret: r.ret, closed: r.closed };
}

export async function analyze(
  client: KiwoomClient,
  rule: SimRule,
  days = 250,
): Promise<SimAnalysis> {
  const all = await stockBars(rule.code);
  const bars = all.slice(-Math.max(20, Math.min(500, days)));
  const stock: Point[] = all.map((b) => ({ d: b.d, c: b.c }));
  const ext = await loadSeriesFor(client, rule);

  if (bars.length === 0) {
    const empty = summarize(rule, newState(rule.seed), []);
    return {
      rule,
      result: { ...empty, note: "이 종목의 일봉이 창고에 없습니다 — 설정 › 일봉 수집에서 받아야 합니다" },
      days: [],
      hold: [],
      pos: [],
      exposure: 0,
      months: [],
      legs: [],
      conds: [],
      buyAllDays: 0,
      sellAllDays: 0,
      worstSpell: null,
    };
  }

  /* ── 본 판. 날마다 「들고 있었나」를 같이 적는다 ── */
  const st = newState(rule.seed);
  const pos: number[] = [];
  for (const b of bars) {
    step(rule, st, b.d, b.c, stock, ext);
    pos.push(st.qty > 0 ? 1 : 0);
  }
  const result: SimResult = {
    ...summarize(rule, st, bars),
    limits: coverageLimits(ext, bars),
  };

  /*
   * 그냥 보유 곡선 — 첫날 종가에 시드를 다 넣고 가만히.
   * ⚠️ **수수료를 한 번 뗀다.** 안 떼면 비교 상대가 실제보다 유리해지는데,
   * 이 곡선은 규칙을 재는 자라서 자가 틀리면 잰 것이 전부 틀린다.
   */
  const first = bars[0].c;
  const hold = bars.map((b) => Math.round((rule.seed / first) * b.c * 0.99985));

  /* ── 흐름 ① 회차: 자리를 잡아 비울 때까지를 한 줄로 ── */
  const idxOf = new Map(bars.map((b, i) => [b.d, i]));
  const legs: SimLeg[] = [];
  let openD: string | null = null;
  let openWhy = "";
  let cost = 0;
  for (const t of st.trades) {
    if (t.side === "buy") {
      if (openD === null) {
        openD = t.d;
        openWhy = t.why;
        cost = 0;
      }
      cost += t.amount;
    } else if (openD !== null) {
      const a = idxOf.get(openD) ?? 0;
      const b = idxOf.get(t.d) ?? a;
      legs.push({
        buyD: openD,
        sellD: t.d,
        held: b - a,
        pnl: t.pnl ?? 0,
        pnlPct: cost > 0 ? pct(((t.pnl ?? 0) / cost) * 100) : 0,
        buyWhy: openWhy,
        sellWhy: t.why,
      });
      openD = null;
    }
  }

  /* ── 흐름 ② 달마다 ── */
  const months: MonthRow[] = [];
  let prevEq = rule.seed;
  const byMonth = new Map<string, number[]>();
  result.curve.forEach((p, i) => {
    const m = `${p.d.slice(0, 4)}-${p.d.slice(4, 6)}`;
    const arr = byMonth.get(m) ?? [];
    arr.push(i);
    byMonth.set(m, arr);
  });
  for (const [m, idxs] of byMonth) {
    const last = result.curve[idxs[idxs.length - 1]].equity;
    months.push({
      m,
      ret: prevEq > 0 ? pct(((last - prevEq) / prevEq) * 100) : 0,
      legs: legs.filter((l) => `${l.sellD.slice(0, 4)}-${l.sellD.slice(4, 6)}` === m).length,
      exposure: pct((idxs.reduce((s, i) => s + (pos[i] ?? 0), 0) / idxs.length) * 100),
    });
    prevEq = last;
  }

  /* ── 흐름 ③ 가장 오래 물려 있던 구간 ── */
  let peak = 0;
  let peakAt = 0;
  let worst: SimAnalysis["worstSpell"] = null;
  let deepest = 0;
  let deepAt = 0;
  let deepPeakAt = 0;
  result.curve.forEach((p, i) => {
    if (p.equity >= peak) {
      peak = p.equity;
      peakAt = i;
    }
    const dd = peak > 0 ? ((p.equity - peak) / peak) * 100 : 0;
    if (dd < deepest) {
      deepest = dd;
      deepAt = i;
      deepPeakAt = peakAt;
    }
  });
  if (deepest < 0 && result.curve.length > 0) {
    const target = result.curve[deepPeakAt].equity;
    let back = -1;
    for (let i = deepAt; i < result.curve.length; i += 1) {
      if (result.curve[i].equity >= target) {
        back = i;
        break;
      }
    }
    const end = back >= 0 ? back : result.curve.length - 1;
    worst = {
      from: result.curve[deepPeakAt].d,
      to: result.curve[end].d,
      dd: pct(deepest),
      days: end - deepPeakAt,
      recovered: back >= 0,
    };
  }

  /* ── 영향: 조건마다 「며칠 맞았나」 · 「이것만으로」 · 「이걸 빼면」 ── */
  const conds: CondStat[] = [];
  let buyAllDays = 0;
  let sellAllDays = 0;
  for (const b of bars) {
    if (rule.buy.length > 0 && rule.buy.every((c) => evalCond(c, b.d, stock, ext).ok === true))
      buyAllDays += 1;
    if (rule.sell.length > 0 && rule.sell.every((c) => evalCond(c, b.d, stock, ext).ok === true))
      sellAllDays += 1;
  }

  for (const side of ["buy", "sell"] as const) {
    const list = rule[side];
    for (let i = 0; i < list.length; i += 1) {
      const c = list[i];
      let hit = 0;
      let unknown = 0;
      for (const b of bars) {
        const r = evalCond(c, b.d, stock, ext);
        if (r.ok === null) unknown += 1;
        else if (r.ok) hit += 1;
      }

      /* 이것만으로 — 반대편 조건은 그대로 둔다. 안 그러면 사고 안 파는(또는 그 반대) 판이 된다 */
      const alone = run({ ...rule, [side]: [c] }, bars, stock, ext);
      const rest = list.filter((_, j) => j !== i);
      const without = run({ ...rule, [side]: rest }, bars, stock, ext);

      conds.push({
        side,
        index: i,
        hit,
        unknown,
        alone,
        without: { ...without, emptied: rest.length === 0 },
      });
    }
  }

  return {
    rule,
    result,
    days: result.curve.map((p) => p.d),
    hold: result.curve.map((p) => hold[idxOf.get(p.d) ?? 0] ?? rule.seed),
    pos,
    exposure: pct((pos.reduce((s, v) => s + v, 0) / Math.max(1, pos.length)) * 100),
    months,
    legs,
    conds,
    buyAllDays,
    sellAllDays,
    worstSpell: worst,
  };
}
