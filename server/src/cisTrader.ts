import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateMarket } from "./marketSignal.js";
import { evaluateSignal } from "./signalLight.js";
import { leaderScan, type LeaderStock } from "./leaderScan.js";
import {
  addTradingDays,
  buy,
  buyingPower,
  equityOf,
  loadAccount,
  markToMarket,
  misuDue,
  saveAccount,
  sell,
  today,
  type CisAccount,
  type Funding,
  type Position,
} from "./cisAccount.js";

/**
 * CIS 트레이더 — **규칙으로 판단한다.**
 *
 * ## 왜 AI 가 아니라 규칙인가
 *
 * 벤티지가 물었다 — "AI 안 붙어도 가능할까?" 가능할 뿐 아니라 **그게 맞다.**
 *
 * 이 일지의 쓸모는 수익률이 아니라 **왜 그렇게 했는지가 남는 것**이다. LLM 이 매일
 * 판단하면 같은 날을 다시 돌려도 다른 답이 나온다. 성적이 나빠도 어느 판단이
 * 나빴는지 짚을 수가 없고, 그러면 복기가 「그날은 그렇게 느꼈나 보다」가 된다.
 *
 * 규칙이면 재현된다. 성적이 나쁘면 **어느 규칙이 나빴는지**를 숫자로 집어낼 수 있고,
 * 그 규칙만 고치면 된다. 그게 이 계좌를 굴리는 이유다.
 *
 * AI 는 나중에 붙어도 **문장을 쓰는 자리**다 — 판단은 여기서 끝나 있어야 한다.
 *
 * ## 역할 — 단기 추세 추종 스윙
 *
 * 오르고 있는 것을, 돈이 몰리는 곳에서, 신호등이 막지 않을 때 산다. 며칠 끌되
 * 추세가 꺾이면 그날 나온다. 바닥을 맞히려 하지 않는다 — 그건 다른 전략이고
 * 이 계좌의 규칙과 섞으면 둘 다 망가진다.
 *
 * ## 하루 세 번
 *
 *   - **아침**(장 전): 오늘 뭘 할지 정한다. 어제 종가 기준 후보와 계획.
 *   - **점심**(장중): 보유만 본다. 손절·익절에 닿았나. **새로 안 산다** —
 *     장중 추격은 이 전략의 최대 손실원이라 아예 금지한다.
 *   - **저녁**(마감 후): 오늘을 채점하고, 만기 미수를 정리하고, 내일 후보를 뽑는다.
 *
 * ⚠️ **아침에 사는 값은 그날 시가**다. 종가를 보고 그 종가에 사는 것은 불가능한데,
 * 그렇게 적으면 성적이 통째로 거짓이 된다(`signalBacktest` 에서 같은 이유로
 * 익일 시가 진입으로 바꿨다). 여기서도 같은 규칙을 쓴다.
 */

/* ------------------------------------------------------------------ 규칙 값 */

/**
 * 규칙의 숫자들을 **한자리에 모은다.** 코드 여기저기에 흩어지면 「왜 3% 인가」를
 * 물을 자리가 없어지고, 고칠 때 한 군데를 빠뜨린다.
 */
export interface CisRules {
  /** 한 종목에 순자산의 몇 %까지 (분산) */
  maxPerStock: number;
  /** 동시에 몇 종목까지 */
  maxPositions: number;
  /** 손절 — 평단 대비 몇 % */
  stopPct: number;
  /** 익절 — 평단 대비 몇 % */
  targetPct: number;
  /** 며칠 지나도 안 움직이면 자리를 비운다 (기회비용) */
  maxHoldDays: number;
  /** 후보의 최소 신호등 점수 */
  minScore: number;
  /** 후보의 최소 거래대금 (억) */
  minTradeValue: number;
  /** 시장이 이 아래면 **아무것도 안 산다** */
  minMarketScore: number;
  /** 이익이 이만큼 나면 손절선을 본전으로 올린다 */
  trailAfterPct: number;
}

export const DEFAULT_RULES: CisRules = {
  /*
   * 한 종목 12% — 여덟 종목이면 꽉 찬다. 더 몰면 한 번의 갭하락이 계좌를 끝내고,
   * 더 쪼개면 이겨도 티가 안 나 전략을 판단할 수 없다.
   */
  maxPerStock: 12,
  maxPositions: 8,
  /*
   * 손절 -7% / 익절 +15%. 추세추종은 **이기는 횟수가 적고 이길 때 크게** 먹는
   * 전략이라 손익비가 2 를 넘어야 한다. 손절을 좁히면(-3%) 흔들림에 다 털리고,
   * 넓히면(-15%) 한 번에 두 달치를 잃는다.
   */
  stopPct: -7,
  targetPct: 15,
  /* 열흘 안에 안 가면 내 판단이 틀린 것이다. 돈이 묶이는 게 더 비싸다 */
  maxHoldDays: 10,
  minScore: 60,
  /* 500억 미만은 내가 사는 수량에 값이 밀린다 — 모의라도 못 살 걸 샀다고 적지 않는다 */
  minTradeValue: 500,
  minMarketScore: 40,
  /* +7% 넘어가면 손절을 본전으로 — 이익을 손실로 바꾸지 않는다 */
  trailAfterPct: 7,
};

/* ------------------------------------------------------------------ 후보 */

export interface Candidate {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  sector: string;
  /** 신호등 점수 */
  signalScore: number | null;
  signalLevel: string | null;
  /** 주도주 점수 */
  leaderScore: number;
  /** 최종 점수 — 무엇을 얼마나 반영했는지 `used` 에 남는다 */
  score: number;
  /** 어느 화면을 보고 이 점수가 나왔나 — 일지의 「HTS 활용법」이 이걸 센다 */
  used: string[];
  /** 왜 후보인가 — 사람이 읽을 한 줄 */
  why: string;
  /** 못 산 이유 (걸러졌으면) */
  rejected?: string;
}

/**
 * 오늘의 후보를 뽑는다.
 *
 * 순서가 중요하다 — **주도주에서 시작해 신호등으로 거른다.** 반대로 하면(전 종목
 * 신호등 → 강한 것 고르기) 신호등을 수천 번 불러야 하고, 그건 키움 호출 한도에
 * 걸린다. 주도주가 이미 「돈이 몰린 곳」으로 좁혀 놓았으니 그 위에서만 판단한다.
 */
export async function pickCandidates(
  client: KiwoomClient,
  rules: CisRules = DEFAULT_RULES,
  limit = 12,
): Promise<{ candidates: Candidate[]; rejected: Candidate[]; note: string }> {
  const scan = await leaderScan(client);

  /* 오늘 거래 자체가 없으면 판단하지 않는다 — 0을 「약하다」로 읽으면 안 된다 */
  if (scan.noTrade) {
    return { candidates: [], rejected: [], note: "오늘 거래가 아직 없어 후보를 뽑지 않았다." };
  }

  const pool = scan.stocks
    .filter((s) => s.tradeValue >= rules.minTradeValue)
    .slice(0, 30);

  const out: Candidate[] = [];
  const bad: Candidate[] = [];

  for (const s of pool) {
    const base = toCandidate(s, scan);
    /*
     * 신호등은 한 종목씩 부르는 무거운 조회라 **후보에만** 쓴다. 실패하면 그 종목만
     * 신호등 없이 간다 — 하나 실패했다고 그날 전체를 못 하게 만들 이유가 없다.
     */
    try {
      const sig = await evaluateSignal(client, s.code);
      base.signalScore = sig.score;
      base.signalLevel = sig.level;
      base.used.push(`신호등:${sig.level}(${sig.score})`);
      if (sig.level === "red") {
        base.rejected = "신호등 빨강";
        bad.push(base);
        continue;
      }
      if (sig.score < rules.minScore) {
        base.rejected = `신호등 ${sig.score}점 < ${rules.minScore}`;
        bad.push(base);
        continue;
      }
      /* 신호등 점수를 절반 얹는다 — 주도주가 본체고 신호등은 거르개다 */
      base.score += sig.score * 0.5;
    } catch {
      base.used.push("신호등:조회실패");
    }
    out.push(base);
  }

  out.sort((a, b) => b.score - a.score);
  return {
    candidates: out.slice(0, limit),
    rejected: bad,
    note: scan.note,
  };
}

function toCandidate(s: LeaderStock, scan: Awaited<ReturnType<typeof leaderScan>>): Candidate {
  const used = ["주도주 스캔"];
  const sec = scan.sectors.find((x) => x.name === s.sector);
  let score = s.score;
  const bits: string[] = [`${s.sector} ${s.changeRate.toFixed(1)}%`];

  /*
   * **섹터가 같이 강한지**를 얹는다. 혼자 오른 종목은 다음 날 혼자 빠진다.
   * 돈이 그 판 전체로 들어왔는지가 스윙에서는 종목 자체보다 중요하다.
   */
  if (sec) {
    used.push(`섹터강도:${sec.name}`);
    if (sec.breadth >= 60) {
      score += 10;
      bits.push(`섹터 폭 ${sec.breadth.toFixed(0)}%`);
    }
    if (sec.streak && sec.streak >= 2) {
      score += 8;
      bits.push(`${sec.streak}일 연속 강세`);
      used.push("섹터 연속성");
    }
  }
  /* 거래량이 터진 것 — 추세의 시작은 거래량이 먼저 온다 */
  if (s.volumeRatio && s.volumeRatio >= 2) {
    score += 6;
    bits.push(`거래량 ${s.volumeRatio.toFixed(1)}배`);
    used.push("거래량 배수");
  }

  return {
    code: s.code,
    name: s.name,
    price: s.price,
    changeRate: s.changeRate,
    tradeValue: s.tradeValue,
    sector: s.sector,
    signalScore: null,
    signalLevel: null,
    leaderScore: s.score,
    score,
    used,
    why: bits.join(" · "),
  };
}

/* ------------------------------------------------------------------ 매도 판단 */

export interface ExitCall {
  position: Position;
  price: number;
  reason: string;
  kind: "stop" | "target" | "stale" | "misu" | "trail";
}

/**
 * 지금 팔아야 할 것들. **판단은 여기 한 곳**이고, 아침·점심·저녁이 모두 이걸 부른다 —
 * 시간대마다 따로 적으면 손절 규칙이 셋으로 갈라져 서로 달라진다.
 */
export function exitCalls(
  a: CisAccount,
  priceOf: (code: string) => number | null,
  rules: CisRules = DEFAULT_RULES,
  date = today(),
): ExitCall[] {
  const out: ExitCall[] = [];
  for (const p of a.positions) {
    const px = priceOf(p.code);
    if (px === null || px <= 0) continue;
    const pct = ((px - p.avg) / p.avg) * 100;
    const held = Math.max(0, Math.round((Date.parse(date) - Date.parse(p.openedAt)) / 86400_000));

    /*
     * 미수 만기가 **가장 먼저다.** 다른 이유로 들고 있고 싶어도 못 들고 있는다 —
     * 실제로는 반대매매가 나간다. 여기서 안 팔면 장부가 현실을 벗어난다.
     */
    if (p.funding === "misu" && p.dueDate && p.dueDate <= date) {
      out.push({ position: p, price: px, kind: "misu", reason: `미수 만기(${p.dueDate})` });
      continue;
    }
    if (p.stop !== null && px <= p.stop) {
      out.push({ position: p, price: px, kind: "stop", reason: `손절선 ${p.stop.toLocaleString()}원 이탈` });
      continue;
    }
    if (pct <= rules.stopPct) {
      out.push({ position: p, price: px, kind: "stop", reason: `${pct.toFixed(1)}% (손절 ${rules.stopPct}%)` });
      continue;
    }
    if (p.target !== null && px >= p.target) {
      out.push({ position: p, price: px, kind: "target", reason: `목표가 ${p.target.toLocaleString()}원 도달` });
      continue;
    }
    if (pct >= rules.targetPct) {
      out.push({ position: p, price: px, kind: "target", reason: `${pct.toFixed(1)}% (익절 ${rules.targetPct}%)` });
      continue;
    }
    if (held >= rules.maxHoldDays) {
      out.push({
        position: p,
        price: px,
        kind: "stale",
        reason: `${held}일째 제자리 (${pct.toFixed(1)}%)`,
      });
    }
  }
  return out;
}

/**
 * 이익이 난 자리는 손절선을 **본전으로 올린다.** 판단이 아니라 관리라서 매도와
 * 나눠 둔다 — 이걸 안 하면 +12% 를 보고도 -7% 로 끝나는 날이 생긴다.
 */
export function trailStops(
  a: CisAccount,
  priceOf: (code: string) => number | null,
  rules: CisRules = DEFAULT_RULES,
): { code: string; name: string; from: number | null; to: number }[] {
  const moved: { code: string; name: string; from: number | null; to: number }[] = [];
  for (const p of a.positions) {
    const px = priceOf(p.code);
    if (px === null || px <= 0) continue;
    const pct = ((px - p.avg) / p.avg) * 100;
    if (pct < rules.trailAfterPct) continue;
    if (p.stop !== null && p.stop >= p.avg) continue; // 이미 본전 위
    moved.push({ code: p.code, name: p.name, from: p.stop, to: p.avg });
    p.stop = p.avg;
  }
  return moved;
}

/* ------------------------------------------------------------------ 매수 실행 */

/**
 * 자금을 무엇으로 쓸까.
 *
 * 규칙은 단순하다 — **예수금이 있으면 예수금.** 없을 때만 빌리고, 그때는
 * **오래 끌 것이면 신용, 짧게 칠 것이면 미수**다. 판단 근거는 「그 종목을 며칠
 * 볼 것인가」인데 우리는 그걸 섹터 연속성으로 어림한다: 며칠째 강한 판이면 더 끈다.
 *
 * ⚠️ 빌리는 것을 **기본으로 두지 않는다.** 레버리지는 이기는 전략을 더 이기게
 * 하지만 지는 전략을 훨씬 빨리 죽인다. 이 계좌는 아직 이기는지 모른다.
 */
export function fundingFor(a: CisAccount, need: number, keepDays: number): Funding {
  if (a.cash >= need) return "cash";
  return keepDays >= 3 ? "credit" : "misu";
}

export interface BuyPlan {
  candidate: Candidate;
  qty: number;
  price: number;
  funding: Funding;
  stop: number;
  target: number;
  amount: number;
}

/**
 * 후보에서 실제 주문을 만든다. **살 수 있는 것만** 만든다 — 여력을 넘는 계획을
 * 세워 두고 나중에 못 사면, 일지에는 「사려 했다」가 남고 계좌에는 아무것도 없어
 * 둘이 어긋난다.
 */
export function planBuys(
  a: CisAccount,
  cands: Candidate[],
  priceOf: (code: string) => number | null,
  rules: CisRules = DEFAULT_RULES,
): { plans: BuyPlan[]; skipped: { name: string; reason: string }[] } {
  const plans: BuyPlan[] = [];
  const skipped: { name: string; reason: string }[] = [];
  const { equity } = equityOf(a, priceOf);
  const room = rules.maxPositions - a.positions.length;
  if (room <= 0) {
    return { plans: [], skipped: cands.map((c) => ({ name: c.name, reason: "보유 종목이 꽉 찼다" })) };
  }

  const budget = Math.floor((equity * rules.maxPerStock) / 100);

  for (const c of cands) {
    if (plans.length >= room) {
      skipped.push({ name: c.name, reason: "자리 없음" });
      continue;
    }
    if (a.positions.some((p) => p.code === c.code)) {
      skipped.push({ name: c.name, reason: "이미 보유" });
      continue;
    }
    const price = priceOf(c.code) ?? c.price;
    if (price <= 0) {
      skipped.push({ name: c.name, reason: "값을 못 읽었다" });
      continue;
    }
    /* 며칠 볼 것인가 — 섹터가 연속으로 강하면 길게 본다(fundingFor 의 근거) */
    const keepDays = c.used.some((u) => u === "섹터 연속성") ? 4 : 2;
    const funding = fundingFor(a, budget, keepDays);
    const power = buyingPower(a, funding, priceOf);
    const amount = Math.min(budget, power);
    const qty = Math.floor(amount / price);
    if (qty <= 0) {
      skipped.push({ name: c.name, reason: `${funding} 여력 부족` });
      continue;
    }
    plans.push({
      candidate: c,
      qty,
      price,
      funding,
      stop: Math.round(price * (1 + rules.stopPct / 100)),
      target: Math.round(price * (1 + rules.targetPct / 100)),
      amount: qty * price,
    });
  }
  return { plans, skipped };
}

/* ------------------------------------------------------------------ 시장 문 */

export interface MarketGate {
  ok: boolean;
  score: number;
  label: string;
  reason: string;
}

/**
 * 오늘 사도 되는 시장인가.
 *
 * **살 이유가 아니라 안 살 이유를 찾는 문이다.** 추세추종은 시장이 무너질 때
 * 가장 크게 다친다 — 개별 종목이 아무리 좋아도 지수가 무너지면 같이 빠진다.
 * 벤티지가 "요즘 시장이 어지러워서 거래를 안 하고 있다"고 한 그 판단을 규칙으로 옮긴 것이다.
 */
export async function marketGate(
  client: KiwoomClient,
  rules: CisRules = DEFAULT_RULES,
): Promise<MarketGate> {
  try {
    const m = await evaluateMarket(client);
    const score = typeof m.score === "number" ? m.score : 0;
    const ok = score >= rules.minMarketScore;
    return {
      ok,
      score,
      label: m.level ?? "",
      reason: ok
        ? `시장 ${score}점 — 매수 허용`
        : `시장 ${score}점 < ${rules.minMarketScore}점, 오늘은 안 산다`,
    };
  } catch {
    /* 못 읽었으면 **안 사는 쪽**이다. 모르는 시장에서 사는 것이 가장 비싸다 */
    return { ok: false, score: 0, label: "", reason: "시장 판단을 못 읽어 오늘은 쉰다" };
  }
}

/* ------------------------------------------------------------------ 실행 */

export { loadAccount, saveAccount, markToMarket, misuDue, buy, sell, addTradingDays };
