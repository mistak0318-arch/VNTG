import type { KiwoomClient } from "./kiwoomClient.js";
import { alCode } from "./alCode.js";
import {
  buy,
  equityOf,
  loadAccount,
  markToMarket,
  saveAccount,
  sell,
  today,
  type CisAccount,
} from "./cisAccount.js";
import { getCisConfig } from "./cisConfig.js";
import {
  exitCalls,
  marketGate,
  pickCandidates,
  planBuys,
  trailStops,
  type Candidate,
} from "./cisTrader.js";
import {
  loadDay,
  narrate,
  review,
  saveDay,
  writeSlot,
  type CisDay,
  type JournalAction,
  type Slot,
  type SlotEntry,
} from "./cisJournal.js";
import { polishJournal, screenCandidates, type ScreenNote } from "./cisAi.js";

/**
 * 하루를 실행한다 — 아침·점심·저녁.
 *
 * ## 순서가 규칙이다
 *
 * 어느 시간대든 **팔 것을 먼저 보고 그다음에 산다.** 반대로 하면 자리가 없어
 * 좋은 후보를 놓치고, 정작 팔았어야 할 것은 하루 더 들고 간다. 그리고 매수는
 * **아침에만** 한다 — 장중 추격이 이 전략의 최대 손실원이라 코드로 막는다.
 *
 * ## 값은 어디서 오나
 *
 * 보유 종목은 ka10095 로 한 번에 받는다(관심종목 시세). 후보의 값은 주도주 스캔이
 * 이미 들고 있다. **없는 값으로는 아무것도 하지 않는다** — 값을 못 읽은 종목은
 * 그날 판단에서 조용히 빠지고, 그 사실이 일지에 남는다.
 */

type Row = Record<string, unknown>;
const STKINFO = "/api/dostk/stkinfo";

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 지금 값을 한 번에 받는다.
 *
 * ⚠️ **0 은 값이 아니라 「못 읽었다」로 다룬다.** 0 을 값으로 넣으면 손절 판정이
 * 전 종목 발동해 계좌가 통째로 청산된다 — 개장 전이나 조회 실패에 매일 그럴 수 있다.
 * 이 감사에서 반복해 나온 실수라 여기서는 처음부터 null 로 돌린다.
 */
export async function priceMap(
  client: KiwoomClient,
  codes: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const uniq = [...new Set(codes)].filter(Boolean);
  if (uniq.length === 0) return out;
  /* ka10095 는 한 번에 여러 종목을 주지만 무한하지 않다 — 50개씩 끊는다 */
  for (let i = 0; i < uniq.length; i += 50) {
    const part = uniq.slice(i, i + 50);
    try {
      const { data } = await client.request<Row>(STKINFO, "ka10095", {
        stk_cd: part.map((c) => alCode(c)).join("|"),
      });
      const rows = Array.isArray(data.atn_stk_infr) ? (data.atn_stk_infr as Row[]) : [];
      for (const q of rows) {
        const code = String(q.stk_cd ?? "").replace(/_(AL|NX)$/i, "");
        const px = Math.abs(toNum(q.cur_prc));
        if (code && px > 0) out.set(code, px);
      }
    } catch {
      /* 이 묶음만 없는 채로 간다 — 하나 실패했다고 하루를 접지 않는다 */
    }
  }
  return out;
}

/** 결과 — 화면이 「방금 뭘 했나」를 그대로 보여 준다 */
export interface RunResult {
  ok: boolean;
  slot: Slot;
  date: string;
  skipped?: string;
  entry?: SlotEntry;
  day?: CisDay;
  screenNotes?: ScreenNote[];
  aiError?: string;
}

/**
 * 한 시간대를 돌린다.
 *
 * `force` 는 사람이 화면에서 「다시 쓰기」를 눌렀을 때만이다. 자동 실행이 이미 쓴
 * 시간대를 덮으면, 아침 계획이 저녁의 변명으로 바뀐다(`cisJournal` 머리 주석).
 */
export async function runSlot(
  client: KiwoomClient,
  slot: Slot,
  force = false,
): Promise<RunResult> {
  const date = today();
  const cfg = await getCisConfig();
  if (!cfg.enabled) return { ok: false, slot, date, skipped: "CIS 모드가 꺼져 있다" };

  const existing = await loadDay(date);
  if (existing[slot] && !force) {
    return { ok: false, slot, date, skipped: `${date} ${slot} 은 이미 썼다`, day: existing };
  }

  const a = await loadAccount();
  if (!a.startedAt) a.startedAt = date;

  const rules = cfg.rules;
  const actions: JournalAction[] = [];
  let screenNotes: ScreenNote[] = [];
  let aiError: string | undefined;

  /* ── ① 값 받기 ─────────────────────────────────────────── */
  const held = a.positions.map((p) => p.code);
  const px = await priceMap(client, held);
  const priceOf = (code: string) => px.get(code) ?? null;

  /* ── ② 팔 것 먼저 ──────────────────────────────────────── */
  const exits = exitCalls(a, priceOf, rules, date);
  for (const e of exits) {
    const r = sell(
      a,
      e.position.code,
      e.position.funding,
      e.position.qty,
      e.price,
      e.reason,
      /* 팔 때도 **무엇을 보고 팔았나**를 남긴다 — 활용법 집계가 매도도 세야 한다 */
      [`매도규칙:${e.kind}`],
      slot,
      date,
    );
    if (r.ok) {
      actions.push({
        side: "sell",
        code: e.position.code,
        name: e.position.name,
        qty: e.position.qty,
        price: e.price,
        funding: e.position.funding,
        why: e.reason,
        used: [`매도규칙:${e.kind}`],
        pnl: r.pnl,
      });
    }
  }

  /* ── ③ 손절선 끌어올리기 ───────────────────────────────── */
  const trailed = trailStops(a, priceOf, rules);

  /* ── ④ 살 것 (아침만) ──────────────────────────────────── */
  let gate = null;
  let candidates: Candidate[] = [];
  let plans: ReturnType<typeof planBuys>["plans"] = [];

  if (slot === "morning") {
    gate = await marketGate(client, rules);
    if (gate.ok) {
      const picked = await pickCandidates(client, rules);
      candidates = picked.candidates;

      /* AI 는 여기서 **경고만** 단다. 거부권은 설정에서 켰을 때만 */
      const screened = await screenCandidates(candidates, rules);
      screenNotes = screened.notes;
      aiError = screened.error;
      if (screened.vetoed.length > 0) {
        candidates = candidates.filter((c) => !screened.vetoed.includes(c.code));
      }

      /* 후보의 값은 스캔이 들고 있지만, 살 값은 **지금 값**이라야 한다 */
      const cpx = await priceMap(client, candidates.map((c) => c.code));
      const buyPriceOf = (code: string) => cpx.get(code) ?? px.get(code) ?? null;

      const planned = planBuys(a, candidates, buyPriceOf, rules);
      plans = planned.plans;
      for (const p of plans) {
        const r = buy(
          a,
          {
            code: p.candidate.code,
            name: p.candidate.name,
            qty: p.qty,
            price: p.price,
            funding: p.funding,
            why: p.candidate.why,
            used: p.candidate.used,
            stop: p.stop,
            target: p.target,
            slot,
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
            used: p.candidate.used,
          });
        }
      }
    }
  }

  /* ── ⑤ 평가액 찍기 ─────────────────────────────────────── */
  const after = await priceMap(client, a.positions.map((p) => p.code));
  const afterOf = (code: string) => after.get(code) ?? px.get(code) ?? null;
  markToMarket(a, afterOf, date);
  const { equity, debt } = equityOf(a, afterOf);

  /* ── ⑥ 글 ──────────────────────────────────────────────── */
  const prev = a.equityCurve.filter((r) => r.date < date).slice(-1)[0]?.equity ?? null;
  let text = narrate(slot, {
    market: gate,
    candidates,
    plans,
    exits,
    actions,
    equity,
    prevEquity: prev,
    positions: a.positions.length,
    cash: Math.round(a.cash),
    debt,
  });
  if (trailed.length > 0) {
    text +=
      "\n\n### 손절선 올림\n" +
      trailed
        .map((t) => `- ${t.name} — ${t.from ? `${t.from.toLocaleString()}원` : "없음"} → 본전 ${t.to.toLocaleString()}원`)
        .join("\n");
  }
  if (screenNotes.some((n) => n.verdict !== "ok")) {
    text +=
      "\n\n### AI 경고\n" +
      screenNotes
        .filter((n) => n.verdict !== "ok")
        .map((n) => `- **${n.name}** (${n.verdict}) — ${n.note}`)
        .join("\n");
    if (cfg.ai.screenVeto) {
      text += "\n\n> 거부권이 켜져 있어 `avoid` 로 표시된 종목은 사지 않았다. 이 계좌는 지금 재현 불가능하다.";
    }
  }

  const polished = await polishJournal(slot, text, rules);
  if (polished.error && !aiError) aiError = polished.error;

  /* 이 시간대에 실제로 쓴 화면·지표를 모은다 (활용법 집계의 원재료) */
  const used = new Set<string>();
  if (gate) used.add("시장 신호등");
  for (const c of candidates) for (const u of c.used) used.add(u);
  for (const act of actions) for (const u of act.used) used.add(u);
  if (screenNotes.length > 0) used.add("AI 후보 검토");

  const entry: SlotEntry = {
    slot,
    at: new Date().toISOString(),
    text: polished.text,
    market: gate,
    candidates,
    plans: plans.map((p) => ({
      name: p.candidate.name,
      code: p.candidate.code,
      qty: p.qty,
      price: p.price,
      funding: p.funding,
      stop: p.stop,
      target: p.target,
      why: p.candidate.why,
    })),
    actions,
    exits: exits.map((e) => ({
      name: e.position.name,
      code: e.position.code,
      kind: e.kind,
      reason: e.reason,
    })),
    used: [...used],
    equity,
    cash: Math.round(a.cash),
    debt,
  };

  await saveAccount(a);
  const day = await writeSlot(entry, date, force);

  /* 저녁이면 총평까지 — 아침 계획과 대조한다 */
  if (slot === "evening") {
    day.review = review(day, prev);
    await saveDay(day);
  }

  return { ok: true, slot, date, entry, day, screenNotes, aiError };
}
