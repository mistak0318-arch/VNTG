import type { KiwoomClient } from "./kiwoomClient.js";
import { fetchAll, type EtfListRow } from "./routes/etf.js";
import { isBlockedForPension, isSafeAsset, type AccountProfile } from "./cisAccounts.js";
import type { Candidate } from "./cisTrader.js";
import type { CisAccount } from "./cisAccount.js";
import { equityOf } from "./cisAccount.js";

/**
 * 연금 계좌 엔진 — **ETF 배분**이지 트레이딩이 아니다.
 *
 * ## 왜 따로 있나 (2026-08-31)
 *
 * 벤티지 지적: "개인연금이랑 퇴직연금은 ETF 쪽을 봐야 하는데 얘도 동일하게 개별주
 * 위주로 보고있네. 로직이 완전 달라야지 둘은." 맞다 — 전엔 연금도 `cisTrader` 의
 * 주도주 스캔(개별종목 모집단)을 쓰고 거기서 ETF 만 걸러냈다. 모집단에 ETF 가
 * 거의 없으니 후보가 안 나왔고, 나와도 그건 「개별주 고르듯 고른 ETF」였다.
 *
 * **모집단부터 다르다.** 여기는 ETF 전체 시세(ka40004)에서 시작한다.
 *
 * ## 전략이 다른 이유
 *
 * 연금은 십 년 단위로 굴리는 돈이고 중도 인출에 불이익이 있다. 그 자리에 단기
 * 추세추종을 넣으면 세금 이연의 이점을 매매비용으로 다 태운다. 그래서:
 *
 *   - **덜 자주 손댄다.** 주 1회(cadence: weekly). 매일 갈아타지 않는다.
 *   - **손절을 안 한다.** 대신 **비중을 줄인다.** 지수를 담는 자리라 −7% 에
 *     털고 나오면 그 지수가 회복할 때 자리에 없다. 개별주와 정반대다.
 *   - **분산이 목적이다.** 같은 지수를 두 번 담지 않고, 한 자리에 몰지 않는다.
 *
 * ## 두 계좌의 차이
 *
 *   - **개인연금(연금저축)**: 위험자산 100%. 담고 싶은 ETF 를 다 담을 수 있다.
 *   - **퇴직연금(IRP)**: 위험 70% / 안전 30%. 안전자산 몫을 **먼저** 채운다 —
 *     나중에 채우려 하면 위험자산이 이미 자리를 다 먹어 규정을 못 맞춘다.
 *
 * ⚠️ 둘 다 **레버리지·인버스는 못 담는다.** 제도상 연금 계좌에서 파생형 ETF 는
 * 매수가 막힌다. 「모든 ETF」라는 말은 배분 한도 이야기이지 이 금지를 푸는 것이
 * 아니다 — 모의라도 못 사는 것을 샀다고 적으면 이 장부가 현실과 달라진다.
 */

/** 연금 규칙 — 트레이딩 규칙과 값이 다르므로 섞지 않는다 */
export interface PensionRules {
  /** 위험자산 쪽을 몇 개로 나눌까 */
  riskySlots: number;
  /** 안전자산 쪽을 몇 개로 나눌까 (IRP 만) */
  safeSlots: number;
  /** 한 ETF 에 순자산의 몇 %까지 */
  maxPerEtf: number;
  /** 이 아래로 거래되는 ETF 는 안 담는다 (억) — 얇으면 못 산다 */
  minTradeValue: number;
  /**
   * 괴리율이 이보다 크면 안 담는다(%). NAV 보다 비싸게 사는 것이라
   * 사는 순간 그만큼 손해다.
   */
  maxDeviation: number;
  /** 추적오차가 이보다 크면 안 담는다(%) — 지수를 못 따라가는 ETF 다 */
  maxTraceErr: number;
  /**
   * 비중이 목표에서 이만큼 벌어지면 되돌린다(%p). 작으면 매매가 잦아져
   * 비용만 나가고, 크면 한쪽으로 쏠린 채 방치된다.
   */
  rebalanceBand: number;
  /**
   * 손절 대신 **비중을 줄이는** 문턱(%). 개별주와 달리 털고 나오지 않는다 —
   * 지수를 담는 자리라 회복할 때 자리에 없으면 그게 더 손해다.
   */
  trimBelow: number;
}

export const DEFAULT_PENSION_RULES: PensionRules = {
  /*
   * 위험 5 / 안전 2. 더 쪼개면 한 자리가 1% 도 안 돼 움직여도 티가 안 나고,
   * 덜 쪼개면 지수 하나에 연금 전체가 걸린다.
   */
  riskySlots: 5,
  safeSlots: 2,
  maxPerEtf: 25,
  /* 50억 미만 ETF 는 호가가 얇아 큰 금액이 안 들어간다 */
  minTradeValue: 50,
  /* 괴리율 1.5% 넘게 주고 사면 그만큼 이미 잃고 시작한다 */
  maxDeviation: 1.5,
  maxTraceErr: 3,
  rebalanceBand: 8,
  /* -20% 아래면 절반으로 줄인다. 털지는 않는다 */
  trimBelow: -20,
};

/* ------------------------------------------------------------------ 분류 */

/**
 * ETF 를 **성격으로** 묶는다.
 *
 * ⚠️ 이름으로 가른다. 제도상 분류표(자산군·위험등급)는 우리에게 없다 —
 * **없는 데이터를 지어내지 않는다**는 원칙대로 규칙을 이름에 두고 여기 적는다.
 * 틀릴 수 있고, 틀리면 화면의 후보 목록에서 사람이 바로 본다.
 *
 * 묶는 이유는 **분산**이다. 같은 묶음에서 두 개를 담으면 분산이 아니라
 * 같은 것을 두 번 담은 것이다.
 */
export type EtfGroup =
  | "safe"
  | "kr-large"
  | "kr-sector"
  | "us"
  | "global"
  | "gold"
  | "other";

const GROUP_LABEL: Record<EtfGroup, string> = {
  safe: "안전자산",
  "kr-large": "국내 대표지수",
  "kr-sector": "국내 업종·테마",
  us: "미국",
  global: "해외(미국 외)",
  gold: "금·원자재",
  other: "그 밖",
};

export function groupOf(name: string): EtfGroup {
  if (isSafeAsset(name)) return "safe";
  const n = name.toUpperCase();
  if (/금현물|골드|은현물|원유|WTI|구리|원자재/.test(name)) return "gold";
  if (/S&P|나스닥|NASDAQ|미국|다우|필라델피아|russell|러셀/i.test(name)) return "us";
  if (/차이나|중국|항셍|인도|니케이|일본|유로|유럽|베트남|신흥국|선진국|글로벌|월드/i.test(name))
    return "global";
  if (/200|코스피|KOSPI|코스닥|KOSDAQ|대형주|TOP|배당/i.test(n)) return "kr-large";
  return "kr-sector";
}

/* ------------------------------------------------------------------ 후보 */

export interface PensionPick extends Candidate {
  group: EtfGroup;
  groupLabel: string;
  safe: boolean;
  deviation: number | null;
  traceErr: number | null;
}

/**
 * 연금이 담을 만한 ETF 를 뽑는다.
 *
 * 순서: **못 담는 것을 먼저 버리고**(제도·유동성·품질), 남은 것을 묶음별로
 * 한 개씩만 고른다. 「좋은 것 순서로 N개」로 뽑으면 국내 반도체 ETF 다섯 개가
 * 나란히 뽑히고, 그건 분산이 아니라 몰빵이다.
 */
export async function pickEtfs(
  client: KiwoomClient,
  profile: AccountProfile,
  rules: PensionRules = DEFAULT_PENSION_RULES,
): Promise<{ risky: PensionPick[]; safe: PensionPick[]; rejected: PensionPick[]; note: string }> {
  const all = await fetchAll(client);
  const risky: PensionPick[] = [];
  const safe: PensionPick[] = [];
  const rejected: PensionPick[] = [];

  const usable: PensionPick[] = [];
  for (const e of all) {
    const p = toPick(e);
    /* ① 제도 — 연금 계좌에서 파생형은 아예 못 산다 */
    if (!profile.allowLeveraged && isBlockedForPension(e.name)) {
      p.rejected = "연금 계좌에서 못 사는 레버리지·인버스";
      rejected.push(p);
      continue;
    }
    /* ② 유동성 — 얇으면 큰 금액이 안 들어간다 */
    if (e.tradeValue < rules.minTradeValue) {
      p.rejected = `거래대금 ${e.tradeValue.toFixed(0)}억 < ${rules.minTradeValue}억`;
      rejected.push(p);
      continue;
    }
    /* ③ 품질 — 괴리율·추적오차. **없으면 버리지 않는다**(못 잰 것이지 나쁜 게 아니다) */
    if (e.deviation !== null && Math.abs(e.deviation) > rules.maxDeviation) {
      p.rejected = `괴리율 ${e.deviation.toFixed(2)}% — NAV 보다 비싸게 산다`;
      rejected.push(p);
      continue;
    }
    if (e.traceErr !== null && e.traceErr > rules.maxTraceErr) {
      p.rejected = `추적오차 ${e.traceErr.toFixed(2)}% — 지수를 못 따라간다`;
      rejected.push(p);
      continue;
    }
    usable.push(p);
  }

  /*
   * **묶음마다 하나씩.** 같은 묶음에서 둘을 담으면 분산이 아니다.
   * 묶음 안에서는 거래대금이 큰 것 — 연금은 오래 들고 갈 자리라 유동성과
   * 운용 규모가 성과보다 중요하다(작은 ETF 는 상장폐지·합병으로 사라진다).
   */
  const byGroup = new Map<EtfGroup, PensionPick[]>();
  for (const p of usable) {
    const arr = byGroup.get(p.group) ?? [];
    arr.push(p);
    byGroup.set(p.group, arr);
  }
  for (const [, arr] of byGroup) arr.sort((a, b) => b.tradeValue - a.tradeValue);

  /* 안전자산 — IRP 만 쓴다. 여러 개 담을 수 있게 묶음 안에서 위부터 */
  safe.push(...(byGroup.get("safe") ?? []).slice(0, rules.safeSlots));

  /*
   * 위험자산 — 묶음을 **정해진 순서로** 돈다. 국내 대표지수를 뼈대로 두고
   * 미국·해외로 넓힌 뒤 업종·금은 곁들인다. 순서를 고정하는 이유는 재현성이다:
   * 「그날 뭐가 제일 올랐나」로 고르면 매주 다른 판이 되고 그건 배분이 아니다.
   */
  const order: EtfGroup[] = ["kr-large", "us", "global", "kr-sector", "gold", "other"];
  for (const g of order) {
    if (risky.length >= rules.riskySlots) break;
    const top = (byGroup.get(g) ?? [])[0];
    if (top) risky.push(top);
  }

  return {
    risky,
    safe,
    rejected: rejected.slice(0, 40),
    note: `ETF ${all.length}종 중 담을 만한 것 ${usable.length}종.`,
  };
}

function toPick(e: EtfListRow): PensionPick {
  const g = groupOf(e.name);
  const bits: string[] = [];
  if (e.index) bits.push(e.index);
  if (e.deviation !== null) bits.push(`괴리 ${e.deviation.toFixed(2)}%`);
  if (e.traceErr !== null) bits.push(`추적오차 ${e.traceErr.toFixed(2)}%`);
  bits.push(`대금 ${Math.round(e.tradeValue).toLocaleString()}억`);

  return {
    code: e.code,
    name: e.name,
    price: e.price,
    changeRate: e.changeRate,
    tradeValue: e.tradeValue,
    sector: GROUP_LABEL[g],
    signalScore: null,
    signalLevel: null,
    leaderScore: 0,
    score: e.tradeValue,
    /* 활용법 집계가 「연금은 뭘 보고 담았나」를 셀 수 있게 남긴다 */
    used: ["ETF 전체시세", `ETF묶음:${GROUP_LABEL[g]}`],
    why: bits.join(" · "),
    group: g,
    groupLabel: GROUP_LABEL[g],
    safe: g === "safe",
    deviation: e.deviation,
    traceErr: e.traceErr,
  };
}

/* ------------------------------------------------------------------ 배분 */

export interface PensionOrder {
  pick: PensionPick;
  qty: number;
  price: number;
  amount: number;
  /** 목표 비중(%) */
  targetPct: number;
  reason: string;
}

/**
 * 목표 비중을 정하고 살 것을 만든다.
 *
 * **안전자산 몫을 먼저 채운다** (IRP). 나중에 채우려 하면 위험자산이 이미 자리를
 * 다 먹어 규정(70%)을 못 맞춘다. 순서 하나로 지켜지는 규칙이라 여기 적어 둔다.
 */
export function planPension(
  a: CisAccount,
  profile: AccountProfile,
  picks: { risky: PensionPick[]; safe: PensionPick[] },
  priceOf: (code: string) => number | null,
  rules: PensionRules = DEFAULT_PENSION_RULES,
): { orders: PensionOrder[]; skipped: { name: string; reason: string }[] } {
  const { equity } = equityOf(a, priceOf);
  const orders: PensionOrder[] = [];
  const skipped: { name: string; reason: string }[] = [];
  if (equity <= 0) return { orders, skipped: [{ name: "-", reason: "굴릴 돈이 없다" }] };

  const safePct = 100 - profile.riskCap; // IRP 30, 개인연금 0
  const build = (list: PensionPick[], totalPct: number, slots: number) => {
    if (list.length === 0 || totalPct <= 0) return;
    const each = Math.min(rules.maxPerEtf, totalPct / Math.min(slots, list.length));
    for (const p of list.slice(0, slots)) {
      if (a.positions.some((x) => x.code === p.code)) {
        skipped.push({ name: p.name, reason: "이미 담고 있다" });
        continue;
      }
      const price = priceOf(p.code) ?? p.price;
      if (price <= 0) {
        skipped.push({ name: p.name, reason: "값을 못 읽었다" });
        continue;
      }
      const qty = Math.floor((equity * each) / 100 / price);
      if (qty <= 0) {
        skipped.push({ name: p.name, reason: "한 주도 못 산다" });
        continue;
      }
      orders.push({
        pick: p,
        qty,
        price,
        amount: qty * price,
        targetPct: Number(each.toFixed(1)),
        reason: `${p.groupLabel} 몫 ${each.toFixed(1)}%`,
      });
    }
  };

  /* 안전자산 먼저 — 순서가 규정을 지킨다 */
  if (safePct > 0) build(picks.safe, safePct, rules.safeSlots);
  build(picks.risky, profile.riskCap, rules.riskySlots);

  return { orders, skipped };
}

/* ------------------------------------------------------------------ 정리 */

export interface PensionTrim {
  code: string;
  name: string;
  qty: number;
  price: number;
  reason: string;
}

/**
 * 연금의 「매도」 — **털지 않고 줄인다.**
 *
 * 개별주는 손절선에서 전량 나온다. 연금은 반대다: 지수를 담는 자리라 −7% 에 털면
 * 그 지수가 회복할 때 자리에 없다. 대신 두 가지만 한다.
 *
 *   ① 크게 밀린 것(−20% 아래)은 **절반으로** 줄인다. 판단이 틀렸을 수 있으니
 *      자리는 남기되 크기를 줄인다.
 *   ② 목표 비중에서 크게 벗어난 것은 **되돌린다**(리밸런싱). 오른 것을 조금 팔아
 *      비중을 맞춘다 — 이게 연금 계좌가 수익을 굳히는 방식이다.
 */
export function pensionTrims(
  a: CisAccount,
  priceOf: (code: string) => number | null,
  rules: PensionRules = DEFAULT_PENSION_RULES,
): PensionTrim[] {
  const { equity } = equityOf(a, priceOf);
  if (equity <= 0) return [];
  const out: PensionTrim[] = [];

  for (const p of a.positions) {
    const px = priceOf(p.code);
    if (px === null || px <= 0) continue;
    const pct = ((px - p.avg) / p.avg) * 100;
    const weight = ((px * p.qty) / equity) * 100;

    if (pct <= rules.trimBelow) {
      const half = Math.floor(p.qty / 2);
      if (half > 0) {
        out.push({
          code: p.code,
          name: p.name,
          qty: half,
          price: px,
          reason: `${pct.toFixed(1)}% — 절반으로 줄인다(털지는 않는다)`,
        });
        continue;
      }
    }
    if (weight > rules.maxPerEtf + rules.rebalanceBand) {
      const target = Math.floor((equity * rules.maxPerEtf) / 100 / px);
      const cut = p.qty - target;
      if (cut > 0) {
        out.push({
          code: p.code,
          name: p.name,
          qty: cut,
          price: px,
          reason: `비중 ${weight.toFixed(1)}% — ${rules.maxPerEtf}% 로 되돌린다`,
        });
      }
    }
  }
  return out;
}

export { GROUP_LABEL };
