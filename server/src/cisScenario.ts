import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cisBacktest, type CisBacktestResult } from "./cisBacktest.js";
import { ACCOUNTS, type AccountId } from "./cisAccounts.js";
import type { CisRules } from "./cisTrader.js";

/**
 * **시나리오 레이스** (2026-10-26 — 벤티지: "각각의 계좌별로, 각각의 캐릭터별로 좀 더
 * 구체화되고 다양한 시나리오를 적용해가지고 최적의 시나리오를 네가 세팅해서 가상 매매할
 * 수 있는 환경을 만들어봐 … AI가 이렇게 해서 얘는 이렇게 해서 길이 나오네? 이걸 보고
 * 싶은 거야. 이렇게 못하는 걸 보고 싶은 게 아니야").
 *
 * ## 무엇이 없었나
 *
 * 계좌마다 **설정이 하나뿐**이었다. 그래서 지면 「왜 졌는지」는 말할 수 있어도
 * **「어떤 설정이면 이겼는지」는 말하지 못했다.** 10/26 기준 넷이 전부 마이너스인데,
 * 그게 장 탓인지 규칙 탓인지 가를 길이 없었다.
 *
 * 여기서는 계좌마다 축을 달리한 시나리오 몇 개를 **같은 표본·같은 후보**에 대해 돌리고
 * 나란히 세운다. 이기는 줄이 있으면 그게 길이고, 없으면 **없다고 적는다.**
 *
 * ## ⚠️ 이 도구의 유일한 위험 — 과거에 맞추기
 *
 * `cisBacktest` 머리말에 이미 적혀 있다:
 *
 *   "손절·익절·보유기간을 훑어서 제일 좋은 것을 고르게 만든다. 그러면 표본에 맞춰진
 *    값이 1등으로 올라온다 — 120일 표본에서 「+7.95%, 압도적」이던 조합이 뒤쪽
 *    절반에서 **-19%p** 였다."
 *
 * 레이스는 정확히 그 함정 위에 서 있다. 그래서 **1등을 뽑는 조건을 세 겹**으로 둔다:
 *
 *   ① `split.bothPositive` — 표본을 앞뒤로 갈라 **둘 다 양수**여야 한다. 한쪽만 좋으면
 *      그건 그 구간의 성질이지 규칙의 값어치가 아니다
 *   ② 거래가 `MIN_TRADES` 이상 — 몇 번 이긴 것은 우연과 구별되지 않는다
 *   ③ 지금 설정보다 `MIN_EDGE` 이상 앞서야 한다 — 근소한 차이로 갈아타면
 *      **잡음을 따라다니게** 된다
 *
 * 셋 중 하나라도 못 넘으면 **안 바꾼다.** 바꾸지 않는 것도 결론이다.
 *
 * ## 벤티지가 손수 정한 축은 안 건드린다
 *
 * `maxPositions`(10)·`maxHoldDays`(12)는 2026-09-04 에 「약간은 적극적인 투자 모드로」
 * 라고 직접 정한 값이다. 자동화가 그걸 과거 성적만 보고 되돌리면, 벤티지는 **자기가
 * 정한 것이 언제 사라졌는지도 모르게** 된다. 탐색 축에서 뺀다 — 손절·익절·진입 문턱
 * 만으로도 길은 충분히 갈린다.
 */

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "cisScenario.json");

/** 이만큼은 거래가 있어야 성적을 믿는다 */
const MIN_TRADES = 25;
/**
 * **표본을 얼마나 볼까** — `cisBacktest` 의 기본값은 300 이다.
 *
 * 첫 레이스에서 **모든 줄의 거래가 정확히 300** 이었다. 표본이 2.8만 관측인데 1%만
 * 보고 순위를 매긴 셈이고, 그러면 앞뒤 분할도 그 300 안에서만 갈린다. 길을 못 찾은 게
 * 아니라 **길을 볼 만큼 안 본 것**이다.
 */
const SAMPLE_LIMIT = 20_000;
/** 지금 설정보다 이만큼(%p)은 앞서야 갈아탄다 */
const MIN_EDGE = 3;

export interface Scenario {
  id: string;
  label: string;
  /** **왜 이 축인가** — 숫자만 늘어놓으면 왜 이겼는지 못 읽는다 */
  why: string;
  rules: Partial<CisRules>;
}

export interface ScenarioRow {
  id: string;
  label: string;
  why: string;
  rules: Partial<CisRules>;
  /** 규칙대로 굴린 평균 수익률(%) */
  avg: number | null;
  /**
   * **기준** — 같은 자리를 규칙 없이 20일 들고있었으면.
   *
   * 시나리오마다 **고르는 자리가 달라진다**(신호등 70점↑ 같은 문턱은 후보 자체를
   * 줄인다). 그러면 날것 수익률끼리 견주는 것은 **서로 다른 후보묶음**을 견주는 꼴이라
   * 뜻이 없다. 각자의 기준을 같이 내고 **그 위로 얼마나 올렸는지**로 줄을 세운다.
   */
  hold: number | null;
  /** avg − hold — 「아무것도 안 하는 것보다 얼마나 나은가」. 줄을 세우는 자는 이것이다 */
  excess: number | null;
  winRate: number | null;
  trades: number;
  payoff: number | null;
  /** 앞뒤 구간이 둘 다 양수인가 — 알아는 두되 문턱으로는 안 쓴다(아래 `bothBeatHold`) */
  bothPositive: boolean;
  /** 앞구간에서도 뒷구간에서도 홀드보다 나았나 — **이게 문턱이다** */
  bothBeatHold: boolean;
  /** 1등이 될 자격을 갖췄나 (위 세 겹) */
  eligible: boolean;
  /** 못 갖췄으면 왜 */
  why_not?: string;
}

export interface RaceResult {
  account: AccountId;
  accountName: string;
  at: string;
  /** 지금 쓰는 설정의 줄 — 늘 첫째다 */
  current: ScenarioRow | null;
  rows: ScenarioRow[];
  /** 갈아탈 만한 줄. 없으면 null 이고 `verdict` 가 까닭을 적는다 */
  winner: ScenarioRow | null;
  verdict: string;
}

/**
 * 계좌 성격에 맞춘 축.
 *
 * 숫자를 고르게 흩뿌리지 않는다 — **그 계좌에서 실제로 의심스러운 자리**만 흔든다.
 * 단기추세는 「손절이 좁아서 털리나, 넓어서 크게 잃나」가 핵심이고, 종가배팅은
 * 하룻밤짜리라 손절폭 말고는 흔들 것이 거의 없다.
 */
export function scenariosFor(account: AccountId): Scenario[] {
  if (account === "close") {
    /* 하룻밤 — 파는 자리가 다음 날 시가로 고정이라 손절폭과 진입 문턱만 남는다 */
    return [
      { id: "stop2", label: "손절 -2%", why: "하룻밤에 -3% 까지 두면 갭하락 한 번에 사흘치가 날아간다. 더 짧게 끊어 본다", rules: { stopPct: -2 } },
      { id: "stop5", label: "손절 -5%", why: "반대 의심 — -3% 가 **흔들림에 털리는** 폭이라면, 넓히는 쪽이 맞을 수도 있다", rules: { stopPct: -5 } },
      { id: "score70", label: "신호등 70점↑", why: "종배는 하루에 한 번뿐이라 **후보를 더 좁히는** 것이 수익률에 바로 온다", rules: { minScore: 70 } },
    ];
  }
  if (account === "pension" || account === "irp") {
    /* ETF·주 1회 — 자주 사고파는 축이 아니라 **얼마나 오래 들고 가나**가 전부다 */
    return [
      { id: "hold20", label: "20일 보유", why: "주 1회 계좌가 12일에 자르면 **리밸런스 주기보다 짧다** — 판단할 시간을 안 준 것", rules: { maxHoldDays: 20 } },
      { id: "hold60", label: "60일 보유", why: "연금은 분기 호흡이다. 한 분기를 통째로 들고 가는 쪽이 성격에 맞는지 본다", rules: { maxHoldDays: 60 } },
      { id: "stop10hold20", label: "손절 -10% · 20일", why: "길게 들려면 **손절도 넓어야** 한다. 좁은 손절 + 긴 보유는 서로 싸운다", rules: { stopPct: -10, maxHoldDays: 20 } },
    ];
  }
  /* 단기 추세 — 손절폭·익절·문턱 */
  return [
    { id: "stop4", label: "손절 -4%", why: "-17% 는 **한 번에 크게 잃은** 모양이다. 짧게 끊으면 승률은 낮아져도 낙폭이 준다", rules: { stopPct: -4 } },
    { id: "stop10", label: "손절 -10%", why: "반대 의심 — -7% 가 흔들림에 걸리는 폭이면, 넓히는 쪽이 손익비를 살린다", rules: { stopPct: -10 } },
    { id: "target25", label: "익절 +25%", why: "추세추종은 **이길 때 크게** 먹어야 성립한다. +15% 에 파는 것이 손익비를 깎고 있는지", rules: { targetPct: 25 } },
    { id: "trail8", label: "고점 -8% 되돌림", why: "고정 익절 대신 **추세가 꺾일 때까지** 들고 간다 — 신조 ③ 「진입 뒤에 추종」에 가장 가깝다", rules: { targetPct: 0, trailDropPct: 8 } },
    { id: "score70", label: "신호등 70점↑", why: "지는 이유가 **고르는 자리**에 있다면 규칙을 아무리 흔들어도 안 바뀐다. 문턱을 올려 가른다", rules: { minScore: 70 } },
  ];
}

const pct = (v: number | null | undefined) => (typeof v === "number" ? Math.round(v * 100) / 100 : null);

function rowOf(s: Scenario, r: CisBacktestResult | null): ScenarioRow {
  const base: ScenarioRow = {
    id: s.id,
    label: s.label,
    why: s.why,
    rules: s.rules,
    avg: null,
    hold: null,
    excess: null,
    winRate: null,
    trades: 0,
    payoff: null,
    bothPositive: false,
    bothBeatHold: false,
    eligible: false,
    why_not: "표본이 없어 못 쟀다",
  };
  if (!r) return base;
  const st = r.summary.ruled;
  const trades = r.trades.length;
  const avg = pct(st.avg);
  const hold = pct(r.summary.hold.avg);
  const excess = avg !== null && hold !== null ? pct(avg - hold) : null;
  const beat = r.split.bothBeatHold;
  let why_not: string | undefined;
  if (trades < MIN_TRADES) why_not = `거래 ${trades}건 — ${MIN_TRADES}건은 돼야 우연과 구별된다`;
  else if (!beat) why_not = "표본 앞뒤 중 한쪽에서는 홀드를 못 이겼다 — 그 구간의 성질이지 규칙의 값어치가 아니다";
  return {
    ...base,
    avg,
    /* `Stat.win` 은 이긴 비율(%)이다 — 이름이 짧아 헷갈리기 쉽다 */
    winRate: pct(st.win),
    trades,
    payoff: pct(r.summary.payoff),
    hold,
    excess,
    bothPositive: r.split.bothPositive,
    bothBeatHold: beat,
    eligible: !why_not,
    why_not,
  };
}

/** 한 계좌의 레이스 — 조회 0회(표본 + 일봉 캐시) */
export async function runRace(account: AccountId): Promise<RaceResult> {
  const prof = ACCOUNTS[account];
  /*
   * ⚠️ **ETF 전용 계좌는 이 표본으로 못 재다** (2026-10-27 실측).
   *
   * 표본은 37,301관측 · 1,396종목 · 116거래일(4/07~9/23)인데 **ETF 가 한 종목도 없다.**
   * 그런데도 여태다는 연금·IRP 에 줄을 그렸고, `ruleOverrides` 도 없어 **단기추세와
   * 톨씨 같은 숫자**가 찍혔다 — 그건 그 계좌의 성적이 아니라 전종목 성적을 베낌 것이다.
   *
   * 없는 수를 지어내는 것보다 **못 재다고 적는 쪽**이 낫다. ETF 일봉 수집이 넣어지면
   * 그때 여는다(메모: ETF 714/859 일봉 없음 — 수집 범위 확대는 별도 과제).
   */
  if (prof.etfOnly) {
    return {
      account,
      accountName: prof.name,
      at: new Date().toISOString(),
      current: null,
      rows: [],
      winner: null,
      verdict:
        "ETF 전용 계좌인데 **표본에 ETF 가 없다** — 못 재는 것이지 지금 설정이 좋다는 뜻이 아니다. " +
        "ETF 일봉이 쌓이면 그때 돌린다.",
    };
  }
  const baseRules: Partial<CisRules> = prof.ruleOverrides ?? {};
  const cur = await cisBacktest(baseRules, undefined, SAMPLE_LIMIT).catch(() => null);
  const current = rowOf({ id: "current", label: "지금 설정", why: "바꾸기 전의 자리 — 모든 비교의 기준", rules: baseRules }, cur);

  const rows: ScenarioRow[] = [];
  for (const s of scenariosFor(account)) {
    /* 계좌의 기본 규칙 **위에** 시나리오를 얹는다 — 종배의 하룻밤 성격 같은 것을 지운 채 비교하면 뜻이 없다 */
    const r = await cisBacktest({ ...baseRules, ...s.rules }, undefined, SAMPLE_LIMIT).catch(() => null);
    rows.push(rowOf(s, r));
  }

  /* 자격을 갖춘 줄 중에서, 지금보다 MIN_EDGE 이상 앞선 1등 */
  const curEdge = current.excess ?? 0;
  const ranked = rows
    .filter((r) => r.eligible && r.excess !== null)
    .sort((a, b) => (b.excess ?? 0) - (a.excess ?? 0));
  const top = ranked[0] ?? null;
  const edge = top && top.excess !== null ? top.excess - curEdge : 0;
  const winner = top && edge >= MIN_EDGE ? top : null;

  let verdict: string;
  if (!current.avg && rows.every((r) => r.avg === null)) verdict = "표본이 아직 없어 레이스를 못 돌렸다.";
  else if (winner) verdict = `「${winner.label}」이 지금보다 ${edge.toFixed(1)}%p 앞선다 — ${winner.why}`;
  else if (top) verdict = `앞선 줄은 「${top.label}」(${edge.toFixed(1)}%p)이지만 ${MIN_EDGE}%p 문턱에 못 미친다 — 잡음을 따라다니지 않는다. 지금 설정을 둔다.`;
  else verdict = "세 겹(앞뒤 둘 다 홀드 위 · 거래 25건 · 3%p 차이)을 넘은 줄이 없다. 지금 설정을 둔다.";

  return { account, accountName: prof.name, at: new Date().toISOString(), current, rows, winner, verdict };
}

/**
 * **자동 채택이 건들 수 있는 열쇠** (2026-10-27).
 *
 * 벤티지: "완전 자동화로 가자. 내가 안 고를게." 그렇다고 **아무 값이나** 바꾸면 안 된다.
 * 레이스가 바꿀 수 있는 것은 **파는 법**뿐이다 — 얼마를 걸지(비중·종목 수)와
 * 무엇을 사는지(문턱)는 손대지 않는다.
 *
 *   ✓ stopPct · targetPct · trailDropPct     파는 자리
 *   ✗ maxPositions · maxHoldDays             **9/4 적극 모드** — 벤티지가 손수 정했다(되돌리지 말 것)
 *   ✗ maxPerStock                            한 자리를 키우는 것은 갑하락 한 방의 크기다
 *   ✗ minScore                                신호등 문턱은 12월 말까지 동결 — 레이스가 보여주기만 한다
 */
export const ADOPTABLE_KEYS = ["stopPct", "targetPct", "trailDropPct"] as const;

function adoptableOf(rules: Partial<CisRules>): Partial<CisRules> {
  const out: Partial<CisRules> = {};
  for (const k of ADOPTABLE_KEYS) {
    if (rules[k] !== undefined) (out as Record<string, unknown>)[k] = rules[k];
  }
  return out;
}

export interface Adoption {
  /** 어느 줄을 택했나 */
  from: string;
  label: string;
  /** 실제로 옮긴 값 — 허용된 열쇠만 */
  rules: Partial<CisRules>;
  /** 홀드 대비 몇 %p 앞섬는가 */
  edge: number;
  why: string;
  at: string;
}

export interface RaceStore {
  at: string;
  races: Partial<Record<AccountId, RaceResult>>;
  /** 자동으로 갈아끼운 규칙. 비어 있으면 어느 계좌도 안 바뀜다는 뜻이다 */
  adopted: Partial<Record<AccountId, Adoption>>;
}

export async function runAllRaces(): Promise<RaceStore> {
  const races: Partial<Record<AccountId, RaceResult>> = {};
  /* 지난번 채택은 이어받는다 — 이번에 1등이 없다고 예전 값으로 되돌리면 규칙이 들날개가 된다 */
  const prev = await readRaces();
  const adopted: Partial<Record<AccountId, Adoption>> = { ...(prev?.adopted ?? {}) };
  for (const id of Object.keys(ACCOUNTS) as AccountId[]) {
    const r = await runRace(id);
    races[id] = r;
    if (!r.winner) continue;
    const rules = adoptableOf(r.winner.rules);
    /*
     * 허용 열쇠가 하나도 없는 1등은 **알리기만 하고 안 바꾼다.** 예를 들어 「신호등 70점↑」은
     * 문턱이라 동결 대상이다 — 이긴 것과 옮길 수 있는 것은 다른 물음이다.
     */
    if (Object.keys(rules).length === 0) continue;
    adopted[id] = {
      from: r.winner.id,
      label: r.winner.label,
      rules,
      edge: r.winner.excess ?? 0,
      why: r.winner.why,
      at: new Date().toISOString(),
    };
  }
  const store: RaceStore = { at: new Date().toISOString(), races, adopted };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store, null, 1), "utf-8");
  return store;
}

/**
 * 이 계좌에 레이스가 옮긴 규칙. 없으면 빈 객체다.
 *
 * ⚠️ 읽는 쪽에서 **한 번 더 거른다.** 파일은 손으로도 고칠 수 있고, 그 파일이
 * `maxPositions` 를 들고 있으면 적극 모드가 조용히 뒤집힌다. 쓸 때 거르는 게 아니라
 * 「들어올 때·내보낼 때 둘 다」 거르는 것이 안전장치다.
 */
export async function adoptedRulesFor(account: string): Promise<Partial<CisRules>> {
  const st = await readRaces();
  const a = st?.adopted?.[account as AccountId];
  return a ? adoptableOf(a.rules) : {};
}

export async function readRaces(): Promise<RaceStore | null> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as RaceStore;
  } catch {
    return null;
  }
}
