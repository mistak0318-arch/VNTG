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
  ENTRY_LABEL,
  entryGate,
  exitCalls,
  marketGate,
  modeOfSlot,
  pickCandidates,
  planBuys,
  trailStops,
  type Candidate,
  type EntryMode,
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
import { isSafeAsset, profileOf, rejectReason, type AccountId } from "./cisAccounts.js";
import { dropPhantomToday } from "./candleGuard.js";
import { noopProgress, type ProgressReporter } from "./reportProgress.js";

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

/**
 * 오늘 **시가**를 받는다 — 장중배팅이 「눌렸다 회복했나」를 재는 데 쓴다.
 *
 * ⚠️ ka10095(관심종목 시세)가 시가를 주는지 확인되지 않아 **추측하지 않고**
 * 일봉(ka10081)에서 가져온다. 종목마다 한 번씩이라 무거우므로 **점심의 후보
 * 몇 개에만** 쓴다 — 보유 전체에 쓰면 호출 한도에 걸린다.
 *
 * 오늘 봉이 껍데기(거래 없음)면 `dropPhantomToday` 가 걷어내므로, 그때는
 * 시가를 못 읽은 것으로 다뤄 **안 사는 쪽**이 된다.
 */
async function openPriceOf(client: KiwoomClient, code: string): Promise<number | null> {
  try {
    const { data } = await client.request<{ stk_dt_pole_chart_qry?: Row[] }>(
      "/api/dostk/chart",
      "ka10081",
      { stk_cd: alCode(code), base_dt: yyyymmdd(), upd_stkpc_tp: "1" },
    );
    const rows = Array.isArray(data.stk_dt_pole_chart_qry)
      ? (data.stk_dt_pole_chart_qry as Row[])
      : [];
    const kept = dropPhantomToday(rows);
    const first = kept[0];
    if (!first) return null;
    /* 오늘 것이 아니면 시가로 쓸 수 없다 — 어제 시가로 오늘을 재면 헛것을 본다 */
    if (String(first.dt ?? "") !== yyyymmdd()) return null;
    const o = Math.abs(toNum(first.open_pric));
    return o > 0 ? o : null;
  } catch {
    return null;
  }
}

function yyyymmdd(): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * **살 자리를 찾아 산다.** 하루 세 번 일지와 15분 루프가 **같은 이 함수**를 쓴다.
 *
 * 매수 판단이 두 군데 있으면 둘이 갈린다 — 루프에서 고친 규칙이 일지에는 안
 * 들어가고, 그러면 「어느 규칙이 나빴나」를 물을 수 없다. 한 곳이라야 한다.
 */
export async function buyRound(
  client: KiwoomClient,
  a: CisAccount,
  account: AccountId,
  slot: Slot,
  mode: EntryMode,
  date: string,
  progress: ProgressReporter = noopProgress,
): Promise<{
  gate: Awaited<ReturnType<typeof marketGate>>;
  candidates: Candidate[];
  plans: ReturnType<typeof planBuys>["plans"];
  actions: JournalAction[];
  gateNotes: { name: string; ok: boolean; reason: string }[];
  screenNotes: ScreenNote[];
  aiError?: string;
}> {
  const cfg = await getCisConfig();
  const rules = cfg.rules;
  const profile = profileOf(account);
  const actions: JournalAction[] = [];
  const candidates: Candidate[] = [];
  const gateNotes: { name: string; ok: boolean; reason: string }[] = [];
  let screenNotes: ScreenNote[] = [];
  let aiError: string | undefined;

  progress.start("market");
  const gate = await marketGate(client, rules);
  progress.done("market", gate.reason);
  if (!gate.ok) {
    progress.skip("scan", "시장 문이 닫혔다");
    progress.skip("signal");
    return { gate, candidates, plans: [], actions, gateNotes, screenNotes };
  }

  progress.start("scan");
  const picked = await pickCandidates(client, rules);
  progress.done("scan", `후보 ${picked.candidates.length}종목`);
  progress.skip("signal", "후보 스캔에 포함됨");

  /*
   * **계좌가 못 담는 것을 먼저 뺀다.** 연금 계좌는 ETF 만, 레버리지·인버스는
   * 불가다 — 제도가 그렇다. 모의라도 못 사는 것을 샀다고 적으면 이 장부가
   * 현실과 다른 이야기가 된다.
   */
  const allowed = picked.candidates.filter((c) => !rejectReason(profile, { name: c.name }));

  /* AI 는 여기서 **경고만** 단다. 거부권은 설정에서 켰을 때만 */
  progress.start("ai");
  const screened = await screenCandidates(allowed, rules);
  screenNotes = screened.notes;
  aiError = screened.error;
  const afterVeto =
    screened.vetoed.length > 0
      ? allowed.filter((c) => !screened.vetoed.includes(c.code))
      : allowed;

  /* 살 값은 **지금 값**이라야 한다 — 스캔이 든 값은 몇 분 전 것일 수 있다 */
  const cpx = await priceMap(client, afterVeto.map((c) => c.code));
  const buyPriceOf = (code: string) => cpx.get(code) ?? null;

  /*
   * **이 자리로 들어갈 만한가**를 후보마다 묻는다. 시간대가 아니라 자리의
   * 성질이 정한다 — 조건이 안 서면 그 시간대엔 그 종목을 안 산다.
   * 통과 못 한 이유도 남긴다. 「왜 안 샀나」가 「왜 샀나」만큼 중요하다.
   */
  for (const c of afterVeto) {
    const now = buyPriceOf(c.code);
    /* 전일 종가는 등락률에서 역산한다 — TR 을 더 부르지 않는다 */
    const prevClose = now !== null && c.changeRate !== -100 ? now / (1 + c.changeRate / 100) : null;
    /* 시가는 장중배팅에만 필요하다 — 필요할 때만 일봉을 부른다 */
    const open = mode === "intra" ? await openPriceOf(client, c.code) : null;
    const g = entryGate(mode, c, now, open, prevClose, rules);
    gateNotes.push({ name: c.name, ok: g.ok, reason: g.reason });
    if (g.ok) {
      candidates.push({ ...c, mode, why: `${c.why} · ${ENTRY_LABEL[mode]}: ${g.reason}` });
    }
  }

  const planned = planBuys(a, candidates, buyPriceOf, rules);
  for (const p of planned.plans) {
    const used = [...p.candidate.used, `진입:${ENTRY_LABEL[mode]}`];
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
        slot,
        /* 퇴직연금 30% 몫인지 **살 때 정해 박는다** — 나중에 다시 판정하지 않는다 */
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

  return { gate, candidates, plans: planned.plans, actions, gateNotes, screenNotes, aiError };
}

/** 결과 — 화면이 「방금 뭘 했나」를 그대로 보여 준다 */
export interface RunResult {
  ok: boolean;
  account: AccountId;
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
  account: AccountId = "trade",
  force = false,
  /**
   * 진행률 손잡이. 스케줄러처럼 화면이 없는 경로에서는 `noopProgress` 다.
   * 주도주 스캔과 종목별 신호등이 각각 수십 초라, 손으로 눌렀을 때 어디쯤인지
   * 안 보이면 멈춘 줄 안다.
   */
  progress: ProgressReporter = noopProgress,
): Promise<RunResult> {
  const date = today();
  const cfg = await getCisConfig();
  if (!cfg.enabled) return { ok: false, account, slot, date, skipped: "CIS 모드가 꺼져 있다" };

  const existing = await loadDay(date, account);
  if (existing[slot] && !force) {
    return { ok: false, account, slot, date, skipped: `${date} ${slot} 은 이미 썼다`, day: existing };
  }

  const profile = profileOf(account);
  const a = await loadAccount(account);
  if (!a.startedAt) a.startedAt = date;

  const rules = cfg.rules;
  const actions: JournalAction[] = [];
  let screenNotes: ScreenNote[] = [];
  let aiError: string | undefined;

  /* ── ① 값 받기 ─────────────────────────────────────────── */
  progress.start("price");
  const held = a.positions.map((p) => p.code);
  const px = await priceMap(client, held);
  progress.done("price", `${px.size}/${held.length}종목`);
  const priceOf = (code: string) => px.get(code) ?? null;

  /* ── ② 팔 것 먼저 ──────────────────────────────────────── */
  progress.start("exit");
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

  progress.done("exit", exits.length > 0 ? `${exits.length}건 정리` : "정리할 것 없음");

  /* ── ③ 손절선 끌어올리기 ───────────────────────────────── */
  const trailed = trailStops(a, priceOf, rules);

  /* ── ④ 살 것 ───────────────────────────────────────────── */
  /*
   * ⚠️ **루프가 매수를 맡으면 여기서는 안 산다** (2026-08-31).
   *
   * 15분 스캔이 켜져 있으면 살 자리는 그쪽이 이미 찾아 샀다. 여기서 또 사면
   * 같은 자리를 두 번 사거나, 루프가 안 산 것을 「아침이라서」 사게 된다.
   * 그때 이 일지는 **루프의 판단과 다른 이야기**를 적게 된다.
   *
   * 루프가 꺼져 있으면(하루 세 번만 쓰는 설정) 여기가 매수를 맡는다.
   */
  const mode = modeOfSlot(slot);
  const loopBuys = cfg.watch && cfg.buyScanMin > 0;
  let gate: Awaited<ReturnType<typeof marketGate>> | null = null;
  let candidates: Candidate[] = [];
  let plans: ReturnType<typeof planBuys>["plans"] = [];
  let gateNotes: { name: string; ok: boolean; reason: string }[] = [];

  if (loopBuys) {
    /* 시장 판단은 글에 필요하므로 그것만 부른다 — 스캔은 안 돈다(호출을 아낀다) */
    progress.start("market");
    gate = await marketGate(client, rules);
    progress.done("market", gate.reason);
    progress.skip("scan", `매수는 ${cfg.buyScanMin}분 루프가 맡는다`);
    progress.skip("signal");
  } else {
    const r = await buyRound(client, a, account, slot, mode, date, progress);
    gate = r.gate;
    candidates = r.candidates;
    plans = r.plans;
    gateNotes = r.gateNotes;
    screenNotes = r.screenNotes;
    aiError = r.aiError;
    actions.push(...r.actions);
  }

  /* ── ⑤ 평가액 찍기 ─────────────────────────────────────── */
  const after = await priceMap(client, a.positions.map((p) => p.code));
  const afterOf = (code: string) => after.get(code) ?? px.get(code) ?? null;
  markToMarket(a, afterOf, date);
  const { equity, debt } = equityOf(a, afterOf);

  /* ── ⑥ 글 ──────────────────────────────────────────────── */
  const prev = a.equityCurve.filter((r) => r.date < date).slice(-1)[0]?.equity ?? null;

  /*
   * **그사이에 뭘 했나** (2026-08-31 — "장중 3번의 복기는 그사이에 대한 복기와
   * 시장상황에 대해서 판단할 내용을 적어두는거").
   *
   * 직전 시간대를 쓴 뒤로 루프가 사고판 것을 모은다. 체결에 시각(at)을 남긴
   * 이유가 이것이다 — 날짜만 있으면 구간을 못 자른다.
   */
  const prevSlot: Slot | null = slot === "noon" ? "morning" : slot === "evening" ? "noon" : null;
  const since = prevSlot ? existing[prevSlot]?.at ?? null : null;
  const interval = since
    ? a.fills.filter((f) => f.at && f.at > since && !actions.some((x) => x.code === f.code && x.side === f.side))
    : [];
  let text = narrate(slot, {
    mode,
    loopBuys,
    interval: interval.map((f) => ({
      side: f.side,
      name: f.name,
      qty: f.qty,
      price: f.price,
      pnl: f.pnl,
      why: f.why,
      at: f.at ?? "",
    })),
    gateNotes,
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

  if (!gate?.ok) {
    progress.skip("scan", "시장 문이 닫혔다");
    progress.skip("signal");
  }
  progress.start("ai");
  const polished = await polishJournal(slot, text, rules);
  if (polished.error && !aiError) aiError = polished.error;
  progress.done("ai", polished.ai ? "AI 가 다듬었다" : "규칙이 쓴 글 그대로");

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

  progress.start("write");
  await saveAccount(a);
  const day = await writeSlot(entry, account, date, force);

  /* 저녁이면 총평까지 — 아침 계획과 대조한다 */
  if (slot === "evening") {
    day.review = review(day, prev);
    await saveDay(day);
  }

  progress.done("write", `${actions.length}건 체결`);
  return { ok: true, account, slot, date, entry, day, screenNotes, aiError };
}
