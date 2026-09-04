import type { KiwoomClient } from "./kiwoomClient.js";
import { marketGauge, type GaugeVerdict } from "./closeBet.js";
import { listTrackSummary, type ListTrackRow } from "./listTrack.js";
import { evaluateSignal } from "./signalLight.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { marketGate, planBuys, type Candidate, type CisRules, type ExitCall, type MarketGate } from "./cisTrader.js";
import { buy, type CisAccount } from "./cisAccount.js";
import { screenCandidates, type ScreenNote } from "./cisAi.js";
import { isSafeAsset, profileOf, rejectReason, type AccountId } from "./cisAccounts.js";
import type { JournalAction } from "./cisJournal.js";
import { priceMap } from "./cisRun.js";
import { noopProgress, type ProgressReporter } from "./reportProgress.js";

/**
 * **CIS 트레이딩(종배)** — 종가배팅 전용 계좌의 매수 판단 (2026-09-02 밤).
 *
 * 벤티지: "CIS 일지에 CIS 트레이딩(종배) 라는거 하나 더 만들자. 얘는 신호등 결과 보고 상위
 * 종목에 대해서 종배를 하는애야. 대신 종배할때 해당 종목의 수급, 그리고 미국장 분위기
 * (미국 선물, 금리, 유가 등), 시장 분위기를 탐지하고 하는거지. … 종배 전용으로 테스트
 * 해보고 싶어서 그래. 신호등 + 시장 분위기 조합으로다가."
 *
 * ## 순서 — 신조 그대로, 문이 넷이다
 *
 *   ① 시장 분위기   `marketGate` — 시장 점수 + 장세 신뢰도. 닫히면 아무것도 안 본다.
 *   ② 미국장 분위기 `marketGauge`(종가배팅 연습기의 것 그대로) — 미국 선물 몸통 · 유가 ·
 *                   환율 · 10년·30년 금리(bp). 하나라도 「나쁨」이면 오늘은 안 산다.
 *                   금리는 **어제 미국 세션** 값이다 — 오늘 밤 것을 쓰면 미래를 보는 것이다.
 *   ③ 후보         **신호등 분석 원장**(오늘 16:30 무렵 쌓인 초록)에서 점수 상위 몇 개.
 *                   주도주 스캔을 안 쓴다 — 「오늘 뜨거운 것」이 아니라 「신호등이 좋다고 한 것」
 *                   에 종배하는 게 이 계좌의 물음이다.
 *   ④ 종목 문       잡주 → 신호등 다시 잼(빨강/탈락·경보 → 탈락) → **수급 축** 문턱.
 *                   벤티지가 「해당 종목의 수급」을 콕 집었다 — 신호등 점수가 높아도 수급 축이
 *                   약하면 안 산다.
 *
 * ## 파는 법은 여기 없다
 *
 * 다음 날 시가에 판다(`cisWatch`, 09:00 첫 틱). 그사이 손절은 -3%(프로필 `ruleOverrides`).
 * 벤티지: "종배하고 다음날 매도하는거니깐 매도 손절라인은 짧게 잡고."
 *
 * ## 언제 도나
 *
 * 스케줄러가 **오늘 원장이 쌓였는지**를 보고 17:00 이후에 돌린다(NXT 애프터마켓 ~20:00).
 * 벤티지: "얘는 신호등 돌아간 다음에 종배해야 하니깐."
 */

/** 원장에서 몇 개까지 다시 재나 — 종목당 신호등 조회가 여러 TR 이라 여기서 끊는다 */
const POOL = 15;
/** 수급 축 문턱 (0~100). 50 = 수급 기준 절반은 통과 */
const FLOW_MIN = 50;

export interface MacroGauge {
  ok: boolean;
  /** 「나쁨」이 하나도 없고 「주의」가 있으면 여기에 */
  warn: string[];
  bad: string[];
  verdicts: GaugeVerdict[];
  /** 사람이 읽는 한 줄 */
  summary: string;
  /** 일지에 넣을 줄들 */
  lines: string[];
  /** 어느 날 기준의 게이지인가 */
  date: string;
}

/**
 * 미국장 분위기 — 종가배팅 연습기(`closeBet.marketGauge`)의 판정을 그대로 쓴다.
 * 문턱은 그쪽에 있다(선물 몸통 ±0.2% · 유가 2/4% · 환율 0.5/1% · 10년물 3/6bp · 30년물 4/8bp).
 * 여기서 새 문턱을 만들지 않는다 — 두 곳이 다른 말을 하면 그때부터 무엇도 못 믿는다.
 */
export async function macroGauge(): Promise<MacroGauge> {
  const { day, verdicts } = await marketGauge();
  const bad = verdicts.filter((v) => v.level === "bad").map((v) => `${v.label} ${v.value}`);
  const warn = verdicts.filter((v) => v.level === "warn").map((v) => `${v.label} ${v.value}`);
  const ok = bad.length === 0 && verdicts.length > 0;
  const lines = verdicts.map(
    (v) =>
      `${v.level === "bad" ? "✕" : v.level === "warn" ? "△" : "○"} ${v.label} ${v.value}` +
      (v.price ? ` (${v.price})` : "") +
      ` — ${v.why}`,
  );
  const summary =
    verdicts.length === 0
      ? "미국장 게이지를 못 읽었다 — 오늘은 안 산다"
      : !ok
        ? `미국장 분위기 나쁨: ${bad.join(" · ")} — 오늘은 종배하지 않는다`
        : warn.length > 0
          ? `미국장 분위기 통과 (주의: ${warn.join(" · ")})`
          : "미국장 분위기 좋음";
  return { ok, warn, bad, verdicts, summary, lines, date: day.date };
}

export interface CloseBetResult {
  gate: MarketGate;
  macro: MacroGauge | null;
  candidates: Candidate[];
  plans: ReturnType<typeof planBuys>["plans"];
  actions: JournalAction[];
  gateNotes: { name: string; ok: boolean; reason: string }[];
  sieved: { name: string; reason: string }[];
  screenNotes: ScreenNote[];
  aiError?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 저녁 한 번의 종배 판단.
 *
 * 돌려주는 모양은 `buyRound` 와 같다 — 일지를 쓰는 쪽(`runSlot`)이 두 계좌를 같은 틀로
 * 적는다. 다른 것은 `macro` 하나다.
 */
export async function closeBetRound(
  client: KiwoomClient,
  a: CisAccount,
  account: AccountId,
  date: string,
  rules: CisRules,
  progress: ProgressReporter = noopProgress,
  /**
   * **시험용** — 시장 문·미국장 문을 무시하고 종목 경로만 돌린다 (`tools/sigtune/closeBetDry.mts`).
   * 밤에는 시장 점수가 0 이라 문에서 멈추는데, 그러면 원장→신호등→수급 경로를 시험할 수 없다.
   * 실전 경로(`cisRun`)는 이 값을 절대 넘기지 않는다.
   */
  dry: { ignoreGates: boolean } = { ignoreGates: false },
): Promise<CloseBetResult> {
  const profile = profileOf(account);
  const actions: JournalAction[] = [];
  const candidates: Candidate[] = [];
  const gateNotes: { name: string; ok: boolean; reason: string }[] = [];
  const sieved: { name: string; reason: string }[] = [];
  let screenNotes: ScreenNote[] = [];
  let aiError: string | undefined;

  /* ① 시장 분위기 */
  progress.start("market");
  const gate = await marketGate(client, rules);
  if (!gate.ok && !dry.ignoreGates) {
    progress.done("market", gate.reason);
    progress.skip("scan", "시장 문이 닫혔다");
    progress.skip("signal");
    return { gate, macro: null, candidates, plans: [], actions, gateNotes, sieved, screenNotes };
  }

  /* ② 미국장 분위기 — 못 읽으면 안 사는 쪽 (모르는 자리에 들어가는 게 가장 비싸다) */
  const macro = await macroGauge().catch(
    (): MacroGauge => ({
      ok: false,
      warn: [],
      bad: ["게이지 조회 실패"],
      verdicts: [],
      summary: "미국장 게이지를 못 읽었다 — 오늘은 안 산다",
      lines: [],
      date: "",
    }),
  );
  progress.done("market", `${gate.reason} · ${macro.summary}`);
  if (!macro.ok && !dry.ignoreGates) {
    progress.skip("scan", "미국장 분위기가 막았다");
    progress.skip("signal");
    return { gate, macro, candidates, plans: [], actions, gateNotes, sieved, screenNotes };
  }

  /* ③ 후보 — 오늘 원장의 초록, 점수 상위 */
  progress.start("scan");
  const lt = await listTrackSummary();

  /*
   * ⚠️ **오늘 원장인가** (2026-09-04에 추가).
   *
   * 여태 이 검사는 **스케줄러에만** 있었다. 그래서 두 가지가 동시에 잘못돼 있었다:
   *   ① 스케줄러가 조용히 `continue` 해서 그날 일지가 통째로 비었다 — 안 산 것인지
   *      못 산 것인지 화면에서 알 수 없었다
   *   ② 손으로 「지금 쓰기」를 누르면 검사를 안 거치고 **어제 원장**으로 종배했다
   *
   * ②가 더 나쁘다. 종배는 「오늘 신호등이 좋다고 한 것」에 거는 것인데 어제 것으로
   * 걸면 그건 다른 전략이고, 성적이 섞여 무엇을 시험한 것인지 알 수 없게 된다.
   * 그래서 **판단하는 자리**로 검사를 옮긴다 — 어느 길로 들어오든 같은 문을 지난다.
   */
  if (lt.lastRunDate !== date && !dry.ignoreGates) {
    const why =
      lt.lastRunDate === null
        ? "신호등 분석 원장이 아직 한 번도 안 돌았다"
        : `신호등 분석 원장이 ${lt.lastRunDate} 것이다 (오늘 ${date} 것이 아니다)`;
    progress.done("scan", why);
    progress.skip("signal");
    return {
      gate: {
        ...gate,
        ok: false,
        reason:
          `${why} — 종배는 **오늘 초록**에 거는 계좌라 어제 원장으로는 사지 않는다. ` +
          "마감 뒤 파이프라인(신호등 분석)이 끝나면 그때 산다.",
      },
      macro,
      candidates,
      plans: [],
      actions,
      gateNotes,
      sieved,
      screenNotes,
    };
  }
  type Pooled = ListTrackRow & { lists: number };
  const pool: Pooled[] = [];
  const best = new Map<string, Pooled>();
  for (const e of lt.entries) {
    if (e.active === false) continue;
    const prev = best.get(e.code);
    if (!prev) best.set(e.code, { ...e, lists: 1 });
    else {
      prev.lists += 1;
      if (e.score > prev.score) Object.assign(prev, e, { lists: prev.lists });
    }
  }
  /* 잡주 거르개 — 스냅샷은 이미 받아 둔 것이라 조회가 안 는다. 못 받으면 안 거른다 */
  const capOf = new Map<string, number | null>();
  const valOf = new Map<string, number | null>();
  try {
    const snap = await getMarketSnapshot(client);
    for (const [code, r] of snap.byCode) {
      capOf.set(code, r.marketCap ?? null);
      valOf.set(code, r.tradeValue ?? null);
    }
  } catch {
    /* 시총·대금 문턱만 못 건다 */
  }

  /*
   * **싼 문을 먼저, 상위 뽑기는 그다음** (2026-09-03 마른 실행에서 배움).
   * 원장은 대금 100억 세계인데 이 계좌 규칙은 500억이라, 점수 상위 15 를 먼저 뽑으면
   * 여덟이 대금 문턱에서 잘리고 신호등 조회(종목당 여러 TR)만 헛돈다. 시총·대금·계좌
   * 제한은 스냅샷만으로 판정되니 그걸로 먼저 거르고, 남은 것에서 상위를 뽑는다.
   */
  const liquid: typeof pool = [];
  const ranked = [...best.values()].sort((x, y) => y.score - x.score);
  for (const e of ranked) {
    const cap = capOf.get(e.code);
    if (rules.minMarketCap > 0 && cap != null && cap < rules.minMarketCap) {
      sieved.push({ name: e.name, reason: `시총 ${Math.round(cap).toLocaleString("ko-KR")}억 < ${rules.minMarketCap}억` });
      continue;
    }
    const tv = valOf.get(e.code);
    if (rules.minTradeValue > 0 && tv != null && tv > 0 && tv < rules.minTradeValue) {
      sieved.push({ name: e.name, reason: `거래대금 ${Math.round(tv).toLocaleString("ko-KR")}억 < ${rules.minTradeValue}억` });
      continue;
    }
    const blocked = rejectReason(profile, { name: e.name });
    if (blocked) {
      sieved.push({ name: e.name, reason: blocked });
      continue;
    }
    liquid.push(e);
  }
  pool.push(...liquid.slice(0, POOL));
  progress.done("scan", `원장 초록 ${best.size} → 잡주 거르고 ${liquid.length} → 상위 ${pool.length}`);

  /* ④ 종목 문 — 신호등 다시 잼 → 수급 축 */
  progress.start("signal");
  for (const e of pool) {
    const tv = valOf.get(e.code);

    let sig: Awaited<ReturnType<typeof evaluateSignal>>;
    try {
      sig = await evaluateSignal(client, e.code);
    } catch {
      sieved.push({ name: e.name, reason: "신호등 조회 실패" });
      continue;
    } finally {
      await sleep(220);
    }
    if (sig.level === "red") {
      const veto = sig.vetoedBy ?? [];
      sieved.push({ name: e.name, reason: veto.length > 0 ? `신호등 탈락 — ${veto.join("·")}` : "신호등 빨강" });
      continue;
    }
    const hot = (sig.alerts?.hot ?? []).map((x) => x.label);
    const late = (sig.alerts?.late ?? []).map((x) => x.label);
    if (rules.rejectAlerts && (hot.length > 0 || late.length > 0)) {
      const parts: string[] = [];
      if (hot.length > 0) parts.push(`🔥쏠림 ${hot.join("·")}`);
      if (late.length > 0) parts.push(`⏳늦음 ${late.join("·")}`);
      sieved.push({ name: e.name, reason: `${parts.join(" / ")} — 체에 걸림` });
      continue;
    }
    if (sig.level !== "green") {
      sieved.push({ name: e.name, reason: `오늘 다시 재니 ${sig.level === "yellow" ? "노랑" : "판단 불가"} (${sig.score}점)` });
      continue;
    }
    if (sig.score < rules.minScore) {
      sieved.push({ name: e.name, reason: `신호등 ${sig.score}점 < ${rules.minScore}` });
      continue;
    }
    /* 수급 축 — 벤티지가 콕 집은 문. 점수는 셋의 평균이라 수급이 비어도 높을 수 있다 */
    const flow = sig.axes.find((x) => x.key === "flow")?.score ?? null;
    if (flow === null) {
      sieved.push({ name: e.name, reason: "수급을 못 쟀다 — 모르면 안 산다" });
      continue;
    }
    if (flow < FLOW_MIN) {
      sieved.push({ name: e.name, reason: `수급 축 ${flow}점 < ${FLOW_MIN} — 수급이 안 받친다` });
      continue;
    }

    const chg = e.changeRate ?? 0;
    candidates.push({
      code: e.code,
      name: e.name,
      price: e.price ?? e.addedPrice,
      changeRate: chg,
      tradeValue: tv ?? 0,
      sector: "",
      signalScore: sig.score,
      signalLevel: sig.level,
      leaderScore: 0,
      /* 순위는 신호등 점수 — 이 계좌의 물음이 「신호등 상위에 종배하면」이다 */
      score: sig.score,
      used: ["신호등 분석 원장", `신호등:green(${sig.score})`, `수급축:${flow}`, "미국장 분위기", "시장 신호등"],
      why:
        `원장 ${e.lists}목록 ${e.seenCount}일째 · 신호등 ${sig.score}점 · 수급 축 ${flow} · ` +
        `오늘 ${chg > 0 ? "+" : ""}${chg.toFixed(1)}%`,
      mode: "close",
    });
  }
  candidates.sort((x, y) => y.score - x.score);
  progress.done("signal", `문을 지난 ${candidates.length} · 걸린 ${sieved.length}`);

  /* AI 는 경고만 — 거부권은 설정에서 켰을 때만 */
  progress.start("ai");
  const screened = await screenCandidates(candidates, rules);
  screenNotes = screened.notes;
  aiError = screened.error;
  const afterVeto =
    screened.vetoed.length > 0 ? candidates.filter((c) => !screened.vetoed.includes(c.code)) : candidates;

  /* 살 값은 지금 값 — NXT 애프터마켓 호가. 못 읽으면 원장 값으로 */
  const cpx = await priceMap(client, afterVeto.map((c) => c.code));
  const buyPriceOf = (code: string) => cpx.get(code) ?? null;
  for (const c of afterVeto) {
    gateNotes.push({
      name: c.name,
      ok: true,
      reason: `${c.why} · 종가배팅: 미국장 ${macro.warn.length > 0 ? "주의" : "좋음"}`,
    });
  }

  const planned = planBuys(a, afterVeto, buyPriceOf, rules);
  for (const p of planned.plans) {
    const used = [...p.candidate.used, "진입:종가배팅"];
    const r = buy(
      a,
      {
        code: p.candidate.code,
        name: p.candidate.name,
        qty: p.qty,
        price: p.price,
        funding: p.funding,
        why: p.candidate.why,
        used,
        stop: p.stop,
        target: p.target,
        slot: "evening",
        safe: profile.riskCap < 100 ? isSafeAsset(p.candidate.name) : undefined,
      },
      buyPriceOf,
      date,
    );
    if (r.ok) {
      actions.push({
        side: "buy",
        code: p.candidate.code,
        name: p.candidate.name,
        qty: r.qty,
        price: p.price,
        funding: p.funding,
        why: p.candidate.why,
        used,
      });
    }
  }
  progress.done("ai", `${planned.plans.length}건 계획`);

  return { gate, macro, candidates: afterVeto, plans: planned.plans, actions, gateNotes, sieved, screenNotes, aiError };
}

/**
 * **종배 청산** — 어제(또는 그 전에) 산 것을 지금 값에 판다.
 *
 * 감시 루프가 다음 날 09:00 첫 틱에 부른다(시가 근처). 감시가 꺼져 있으면 하루 세 번
 * 일지의 점심·저녁이 같은 함수로 뒤처리한다 — 종배가 이틀 들고 가는 일은 없어야 한다.
 */
export function closeBetExits(a: CisAccount, priceOf: (code: string) => number | null, date: string): ExitCall[] {
  const out: ExitCall[] = [];
  for (const p of a.positions) {
    if (p.openedAt >= date) continue;
    const px = priceOf(p.code);
    if (px === null || px <= 0) continue;
    const pct = ((px - p.avg) / p.avg) * 100;
    out.push({
      position: p,
      price: px,
      kind: "gap",
      reason: `종배 청산 — 다음 날 시가 근처 (${pct > 0 ? "+" : ""}${pct.toFixed(1)}%)`,
    });
  }
  return out;
}
