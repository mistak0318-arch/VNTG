import { loadAccount, type CisAccount, type Fill } from "./cisAccount.js";
import { listDays, type CisDay } from "./cisJournal.js";
import { profileOf, type AccountId } from "./cisAccounts.js";

/**
 * CIS 성적표.
 *
 * ## 왜 이게 이 기능의 심장인가
 *
 * 판단을 규칙으로 두기로 한 이유가 「어느 규칙이 나빴나」를 물을 수 있어서다
 * (`cisTrader` 머리 주석). 그 물음에 **숫자로** 답하는 것이 이 파일이다.
 * 이게 없으면 규칙으로 만든 보람이 없다 — 재현은 되는데 고칠 데를 모르게 된다.
 *
 * ## 무엇을 세나
 *
 *   1. **매도 사유별** — 손절로 나간 것, 익절로 나간 것, 시간 만료로 나간 것.
 *      익절보다 손절 건수가 압도적이면 손절폭이 좁은 것이고, 시간 만료가 많으면
 *      애초에 후보가 나쁜 것이다. **어디를 고칠지가 여기서 갈린다.**
 *   2. **근거별** — 「섹터 연속성」을 보고 산 것과 「거래량 배수」를 보고 산 것 중
 *      뭐가 나았나. 벤티지가 보고 싶어 한 「HTS 활용법」의 본체다.
 *   3. **자금별** — 신용·미수가 실제로 도움이 됐나. 이자와 만기 압박을 물고도
 *      남는 게 있었는지.
 *
 * ## ⚠️ 표본이 적으면 말하지 않는다
 *
 * 세 번 이겨 승률 100% 를 적어 두면 그 숫자가 다음 판단을 망친다. 건수를 늘
 * 같이 내보내고, 화면이 적은 표본을 흐리게 그린다. 「모른다」가 정답인 구간이 있다.
 */

export interface Bucket {
  key: string;
  label: string;
  trades: number;
  wins: number;
  /** 승률 (%) — trades 가 적으면 믿지 마라 */
  winRate: number;
  /** 실현손익 합 */
  pnl: number;
  /** 평균 손익 */
  avgPnl: number;
  /** 이긴 것 평균 / 진 것 평균 — 추세추종은 이게 2 를 넘어야 한다 */
  payoff: number | null;
  /** 평균 보유일 */
  avgHold: number;
}

export interface CisStats {
  account: AccountId;
  accountName: string;
  /* ── 큰 그림 ── */
  seed: number;
  equity: number;
  /** 시드 대비 (%) */
  totalReturn: number;
  /** 굴린 날 수 */
  days: number;
  /** 최대낙폭 (%) — 고점에서 얼마나 밀렸나 */
  mdd: number;
  /** 실현손익 합 */
  realized: number;
  /** 매매 비용 합 (수수료+세금+이자) — 얼마를 마찰로 냈나 */
  cost: number;

  /* ── 매매 ── */
  trades: number;
  wins: number;
  winRate: number;
  payoff: number | null;
  avgHold: number;
  /** 가장 크게 번 한 건 / 가장 크게 잃은 한 건 */
  best: { name: string; pnl: number; date: string } | null;
  worst: { name: string; pnl: number; date: string } | null;

  /* ── 쪼개 보기 ── */
  byExit: Bucket[];
  byReason: Bucket[];
  byFunding: Bucket[];
  bySlot: Bucket[];

  /* ── 규율 ── */
  /** 계획 대비 실행률 (%) */
  planRate: number | null;
  /** 규칙을 어긴 날 수 */
  violationDays: number;
  violations: { text: string; count: number }[];

  /** 곡선 — 화면이 그린다 */
  curve: { date: string; equity: number }[];
}

const EXIT_LABEL: Record<string, string> = {
  stop: "손절",
  target: "익절",
  stale: "시간 만료",
  misu: "미수 만기",
  trail: "본전 손절",
};

const FUNDING_LABEL: Record<string, string> = {
  cash: "예수금",
  misu: "미수",
  credit: "신용",
};

const SLOT_LABEL: Record<string, string> = {
  morning: "아침",
  noon: "점심",
  evening: "저녁",
};

/** 매도 체결들을 어떤 열쇠로 묶어 성적을 낸다 */
function bucket(
  sells: Fill[],
  keyOf: (f: Fill) => string[],
  label: (k: string) => string,
): Bucket[] {
  const g = new Map<string, Fill[]>();
  for (const f of sells) {
    for (const k of keyOf(f)) {
      if (!k) continue;
      const arr = g.get(k) ?? [];
      arr.push(f);
      g.set(k, arr);
    }
  }
  const out: Bucket[] = [];
  for (const [k, fs] of g) {
    const pnls = fs.map((f) => f.pnl ?? 0);
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0);
    const avgWin = wins.length ? wins.reduce((a, b) => a + b, 0) / wins.length : 0;
    const avgLoss = losses.length
      ? Math.abs(losses.reduce((a, b) => a + b, 0) / losses.length)
      : 0;
    out.push({
      key: k,
      label: label(k),
      trades: fs.length,
      wins: wins.length,
      winRate: fs.length ? Number(((wins.length / fs.length) * 100).toFixed(1)) : 0,
      pnl: Math.round(pnls.reduce((a, b) => a + b, 0)),
      avgPnl: Math.round(pnls.reduce((a, b) => a + b, 0) / fs.length),
      payoff: avgLoss > 0 ? Number((avgWin / avgLoss).toFixed(2)) : null,
      avgHold: Number(
        (fs.reduce((s, f) => s + (f.heldDays ?? 0), 0) / fs.length).toFixed(1),
      ),
    });
  }
  /* 건수가 아니라 **손익 합**으로 세운다 — 고칠 곳은 돈이 많이 샌 데다 */
  return out.sort((a, b) => a.pnl - b.pnl);
}

/**
 * 최대낙폭 — 고점에서 얼마나 밀렸나.
 *
 * 수익률만 보면 「+30%」인 두 계좌가 같아 보이는데, 하나는 도중에 -40% 를 맞았고
 * 하나는 -5% 였다면 완전히 다른 전략이다. **견딜 수 있느냐**가 여기서 갈린다.
 */
function maxDrawdown(curve: { equity: number }[]): number {
  let peak = 0;
  let mdd = 0;
  for (const p of curve) {
    peak = Math.max(peak, p.equity);
    if (peak > 0) mdd = Math.min(mdd, ((p.equity - peak) / peak) * 100);
  }
  return Number(mdd.toFixed(1));
}

export async function cisStats(account: AccountId = "trade"): Promise<CisStats> {
  const a: CisAccount = await loadAccount(account);
  const p = profileOf(account);
  const days: CisDay[] = await listDays(400, account).catch(() => []);

  const sells = a.fills.filter((f) => f.side === "sell");
  const pnls = sells.map((f) => f.pnl ?? 0);
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x < 0);
  const avgWin = wins.length ? wins.reduce((x, y) => x + y, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((x, y) => x + y, 0) / losses.length) : 0;

  const equity = a.equityCurve[a.equityCurve.length - 1]?.equity ?? a.cash;

  /* 가장 크게 번 것·잃은 것 — 한 건이 전체를 좌우했는지 보이게 */
  let best: CisStats["best"] = null;
  let worst: CisStats["worst"] = null;
  for (const f of sells) {
    const v = f.pnl ?? 0;
    if (!best || v > best.pnl) best = { name: f.name, pnl: v, date: f.date };
    if (!worst || v < worst.pnl) worst = { name: f.name, pnl: v, date: f.date };
  }

  /* 규율 — 계획 대비 실행, 규칙 위반 */
  const graded = days.filter((d) => d.review);
  const planned = graded.reduce((s, d) => s + (d.review?.planned ?? 0), 0);
  const executed = graded.reduce((s, d) => s + (d.review?.executed ?? 0), 0);
  const vio = new Map<string, number>();
  for (const d of graded) {
    for (const v of d.review?.violations ?? []) {
      /* 종목명이 붙은 것들을 하나로 묶는다 — 「계획에 없던 X 매수」가 종목마다 따로 세이면 못 읽는다 */
      const key = v.replace(/계획에 없던 .+ 매수/, "계획에 없던 종목 매수");
      vio.set(key, (vio.get(key) ?? 0) + 1);
    }
  }

  return {
    account,
    accountName: p.name,
    seed: p.seed,
    equity,
    totalReturn: p.seed > 0 ? Number((((equity - p.seed) / p.seed) * 100).toFixed(2)) : 0,
    days: a.equityCurve.length,
    mdd: maxDrawdown(a.equityCurve),
    realized: Math.round(pnls.reduce((x, y) => x + y, 0)),
    cost: Math.round(a.fills.reduce((s, f) => s + (f.cost ?? 0), 0)),

    trades: sells.length,
    wins: wins.length,
    winRate: sells.length ? Number(((wins.length / sells.length) * 100).toFixed(1)) : 0,
    payoff: avgLoss > 0 ? Number((avgWin / avgLoss).toFixed(2)) : null,
    avgHold: sells.length
      ? Number((sells.reduce((s, f) => s + (f.heldDays ?? 0), 0) / sells.length).toFixed(1))
      : 0,
    best,
    worst,

    /* 매도 사유는 `used` 에 「매도규칙:stop」 꼴로 박혀 있다 */
    byExit: bucket(
      sells,
      (f) => f.used.filter((u) => u.startsWith("매도규칙:")).map((u) => u.slice(5)),
      (k) => EXIT_LABEL[k] ?? k,
    ),
    /*
     * 근거별 — **살 때의 근거**로 묶어야 하는데 매도 체결에는 없다. 같은 종목의
     * 마지막 매수를 찾아 그 근거를 쓴다. 정확히는 분할매수한 경우 어긋날 수 있지만,
     * 이 계좌는 한 종목을 한 번에 사므로 실질적으로 맞는다.
     */
    byReason: bucket(
      sells,
      (f) => {
        const b = [...a.fills]
          .reverse()
          .find((x) => x.side === "buy" && x.code === f.code && x.date <= f.date);
        return (b?.used ?? []).filter((u) => !u.startsWith("매도규칙:"));
      },
      (k) => k,
    ),
    byFunding: bucket(sells, (f) => [f.funding], (k) => FUNDING_LABEL[k] ?? k),
    bySlot: bucket(sells, (f) => [f.slot], (k) => SLOT_LABEL[k] ?? k),

    planRate: planned > 0 ? Number(((executed / planned) * 100).toFixed(1)) : null,
    violationDays: graded.filter((d) => (d.review?.violations.length ?? 0) > 0).length,
    violations: [...vio.entries()]
      .map(([text, count]) => ({ text, count }))
      .sort((x, y) => y.count - x.count),

    curve: a.equityCurve.map((r) => ({ date: r.date, equity: r.equity })),
  };
}

/* ------------------------------------------------------------------ 활용법 */

export interface UsageRow {
  name: string;
  /** 몇 번 판단에 썼나 */
  used: number;
  /** 그 근거로 산 것의 성적 */
  trades: number;
  winRate: number | null;
  pnl: number;
}

/**
 * **HTS 활용법** — 어느 화면·지표를 얼마나 썼고, 그게 돈이 됐나.
 *
 * 벤티지가 이 기능을 만들자고 한 첫 이유가 이거다 — "내가 이 HTS를 어떻게 활용할지
 * 그리고 실제 결과는 어땠는지 볼 수 있도록". 쓴 횟수만 세면 「많이 봤다」로 끝나므로
 * **성적을 붙인다.** 자주 보는데 돈이 안 되는 화면이 보이면 그게 배움이다.
 */
export async function cisUsage(account: AccountId = "trade"): Promise<UsageRow[]> {
  const a = await loadAccount(account);
  const days = await listDays(400, account).catch(() => []);

  const used = new Map<string, number>();
  for (const d of days) {
    for (const s of [d.morning, d.noon, d.evening]) {
      for (const u of s?.used ?? []) used.set(u, (used.get(u) ?? 0) + 1);
    }
  }

  /* 그 근거로 산 종목의 성적 */
  const perf = new Map<string, { pnl: number; trades: number; wins: number }>();
  for (const f of a.fills) {
    if (f.side !== "sell") continue;
    const b = [...a.fills]
      .reverse()
      .find((x) => x.side === "buy" && x.code === f.code && x.date <= f.date);
    for (const u of b?.used ?? []) {
      const cur = perf.get(u) ?? { pnl: 0, trades: 0, wins: 0 };
      cur.pnl += f.pnl ?? 0;
      cur.trades += 1;
      if ((f.pnl ?? 0) > 0) cur.wins += 1;
      perf.set(u, cur);
    }
  }

  const keys = new Set([...used.keys(), ...perf.keys()]);
  return [...keys]
    .map((name) => {
      const pf = perf.get(name);
      return {
        name,
        used: used.get(name) ?? 0,
        trades: pf?.trades ?? 0,
        winRate: pf && pf.trades > 0 ? Number(((pf.wins / pf.trades) * 100).toFixed(1)) : null,
        pnl: Math.round(pf?.pnl ?? 0),
      };
    })
    .sort((x, y) => y.used - x.used);
}
