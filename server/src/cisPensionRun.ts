import type { KiwoomClient } from "./kiwoomClient.js";
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
import { profileOf, rejectReason, type AccountId } from "./cisAccounts.js";
import { getCisConfig } from "./cisConfig.js";
import {
  DEFAULT_PENSION_RULES,
  groupOf,
  pensionTargets,
  pensionTopUps,
  pensionTrims,
  planPension,
  pickEtfs,
  type PensionPick,
} from "./cisPension.js";
import { marketGate } from "./cisTrader.js";
import { analyzeEtfs } from "./etfAnalysis.js";
import { analyzeHoldings } from "./etfHoldingsScore.js";
import { priceMap } from "./cisRun.js";
import { narrate, review, saveDay, writeSlot, loadDay, type JournalAction, type SlotEntry } from "./cisJournal.js";
import { polishJournal } from "./cisAi.js";
import { noopProgress, type ProgressReporter } from "./reportProgress.js";

/**
 * 연금 계좌를 굴린다 — **주 1회.**
 *
 * ## 왜 주 1회인가
 *
 * 연금은 십 년 단위로 굴리는 돈이고 중도 인출에 불이익이 있다. 그 자리에 단기
 * 매매를 넣으면 세금 이연의 이점을 매매비용으로 다 태운다. 트레이딩 계좌가
 * 1분·15분으로 도는 것과 정반대로, 여기는 **덜 손대는 것이 규칙**이다.
 *
 * ## 순서가 규칙이다
 *
 *   ① **줄인다**(리밸런싱·과대비중) — 자리를 먼저 비워야 새로 담을 수 있다.
 *   ② **안전자산 몫을 채운다**(IRP 30%) — 나중에 채우면 위험자산이 자리를
 *      다 먹어 규정을 못 맞춘다. 순서 하나로 지켜지는 규칙이다.
 *   ③ **위험자산을 채운다**.
 *
 * ## 무엇을 보고 고르나 — 설정에서 고른다
 *
 * 벤티지가 두 방법을 나란히 두자고 했다(`etfAnalysis` vs `etfHoldingsScore`).
 * 어느 쪽이 맞는지는 **성적으로만** 알 수 있으므로, 연금 계좌가 어느 것을 쓸지
 * 설정에 두고 그 선택을 일지에 적는다 — 나중에 「그때 무엇으로 골랐나」를
 * 물을 수 있어야 비교가 성립한다.
 */

export type PensionMethod = "theme" | "holdings" | "simple";

export const METHOD_LABEL: Record<PensionMethod, string> = {
  theme: "테마 분석 (이름을 테마에 잇는다)",
  holdings: "구성종목 분석 (담은 종목을 직접 본다)",
  simple: "품질만 (거래대금·괴리율·추적오차)",
};

/**
 * 고른 방법으로 후보를 만든다.
 *
 * ⚠️ 어느 방법이든 **계좌가 못 담는 것은 여기서 다시 거른다.** 분석기들은
 * 「좋은 ETF」를 고를 뿐 연금 제도를 모른다 — 레버리지·인버스가 섞여 들어온다.
 */
async function pickBy(
  client: KiwoomClient,
  method: PensionMethod,
  account: AccountId,
): Promise<{ risky: PensionPick[]; safe: PensionPick[]; note: string }> {
  const profile = profileOf(account);
  const rules = DEFAULT_PENSION_RULES;

  /* 안전자산은 어느 방법이든 `pickEtfs` 가 낸다 — 품질로만 고르는 게 맞는 자리다 */
  const base = await pickEtfs(client, profile, rules);
  if (method === "simple") return { risky: base.risky, safe: base.safe, note: base.note };

  const toPick = (r: {
    code: string;
    name: string;
    price: number;
    changeRate: number;
    score: number;
    why: string;
    deviation?: number | null;
    traceErr?: number | null;
    tradeValue?: number;
  }): PensionPick => {
    const g = groupOf(r.name);
    return {
      code: r.code,
      name: r.name,
      price: r.price,
      changeRate: r.changeRate,
      tradeValue: r.tradeValue ?? 0,
      sector: g,
      signalScore: null,
      signalLevel: null,
      leaderScore: 0,
      score: r.score,
      used: [method === "theme" ? "ETF 테마 분석" : "ETF 구성종목 분석", `ETF묶음:${g}`],
      why: r.why,
      group: g,
      groupLabel: g,
      safe: false,
      deviation: r.deviation ?? null,
      traceErr: r.traceErr ?? null,
    };
  };

  let scored: PensionPick[] = [];
  let note = "";
  if (method === "theme") {
    const a = await analyzeEtfs(client, { detail: 40 });
    scored = a.rows.map(toPick);
    note = a.note;
  } else {
    const a = await analyzeHoldings(client, { limit: 60 });
    /* 구성종목 분석은 값을 안 들고 있다 — 담을 때 지금 값을 다시 받는다 */
    scored = a.rows.map((r) =>
      toPick({ code: r.code, name: r.name, price: 0, changeRate: r.weighted ?? 0, score: r.score, why: r.why }),
    );
    note = a.note;
  }

  const allowed = scored.filter((p) => !rejectReason(profile, { name: p.name, etf: true }));

  /*
   * **묶음마다 하나씩.** 점수 순서로만 뽑으면 반도체 ETF 다섯 개가 나란히
   * 올라오는데 그건 분산이 아니라 몰빵이다(`cisPension` 과 같은 원칙).
   */
  const seen = new Set<string>();
  const risky: PensionPick[] = [];
  for (const p of allowed) {
    if (seen.has(p.group)) continue;
    seen.add(p.group);
    risky.push(p);
    if (risky.length >= rules.riskySlots) break;
  }

  return { risky, safe: base.safe, note };
}

export interface PensionRunResult {
  ok: boolean;
  account: AccountId;
  date: string;
  skipped?: string;
  method: PensionMethod;
  actions: JournalAction[];
  note: string;
}

/**
 * 한 번 굴린다.
 *
 * `force` 는 「이번 주에 이미 했다」를 무시한다 — 화면에서 손으로 눌렀을 때만이다.
 */
export async function runPension(
  client: KiwoomClient,
  account: AccountId,
  force = false,
  progress: ProgressReporter = noopProgress,
): Promise<PensionRunResult> {
  const date = today();
  const cfg = await getCisConfig();
  const method = cfg.pensionMethod;
  const profile = profileOf(account);

  if (!cfg.enabled) {
    return { ok: false, account, date, skipped: "항해가 멈춰 있다 (설정에서 켠다)", method, actions: [], note: "" };
  }
  if (profile.cadence === "daily") {
    return { ok: false, account, date, skipped: "연금 계좌가 아니다", method, actions: [], note: "" };
  }

  /* 이번 주에 이미 굴렸나 — 저녁 일지가 있는 날을 그 주의 기록으로 본다 */
  const existing = await loadDay(date, account);
  if (existing.evening && !force) {
    return { ok: false, account, date, skipped: `${date} 은 이미 굴렸다`, method, actions: [], note: "" };
  }

  const a: CisAccount = await loadAccount(account);
  if (!a.startedAt) a.startedAt = date;
  const actions: JournalAction[] = [];

  /* ── ① 값 ── */
  progress.start("price");
  const held = a.positions.map((p) => p.code);
  const px = await priceMap(client, held);
  const priceOf = (code: string) => px.get(code) ?? null;
  progress.done("price", `${px.size}/${held.length}종목`);

  /*
   * ── ①-b **시장 점검** (2026-09-04) ──
   *
   * 벤티지: "연금은 일주일에 월. 수. 금. 포트 점검하고 시장 점검하고."
   *
   * 연금에는 여태 시장 문이 **아예 없었다.** 트레이딩 계좌는 「오늘 사도 되는 장인가」를
   * 묻고 시작하는데, 연금은 요일만 맞으면 담았다. 십 년 굴리는 돈이라 시장 타이밍을
   * 재는 것은 맞지 않지만, **무너지는 날 새로 담을 이유도 없다.**
   *
   * 그래서 문을 이렇게 건다: 닫히면 **새로 담지 않고, 정리와 리밸런싱은 그대로 한다.**
   * 파는 쪽을 막으면 규정(위험 한도)을 못 지키게 되고, 비중 되돌리기는 시장이 나쁠수록
   * 더 필요한 일이다. 막는 것은 「새 자리를 여는 것」 하나다.
   */
  progress.start("market");
  const gate = await marketGate(client, cfg.rules).catch(() => null);
  /*
   * ⚠️ **모르면 안 사는 쪽이다** (2026-09-04 전수 점검에서 고침).
   *
   * 처음엔 `gate?.ok !== false` 라고 썼다. 그러면 문을 **못 읽었을 때**(null) 값이
   * `true` 가 되어 **시장을 모르는 채 새로 담는다.** `marketGate` 는 제 안에서
   * "못 읽었으면 안 사는 쪽이다 — 모르는 시장에서 사는 것이 가장 비싸다"고 정해 놓았는데,
   * 부르는 쪽에서 그 원칙을 뒤집고 있었다. 「모른다」는 「괜찮다」가 아니다.
   */
  const canOpen = gate?.ok === true;
  progress.done("market", gate ? gate.reason : "시장 판단을 못 읽었다 — 새로 담지 않는다");

  /* ── ② 줄인다 — 자리를 먼저 비운다 ── */
  progress.start("exit");
  const trims = pensionTrims(a, priceOf, profile);
  for (const t of trims) {
    const pos = a.positions.find((p) => p.code === t.code);
    if (!pos) continue;
    const r = sell(a, t.code, pos.funding, t.qty, t.price, t.reason, ["연금 리밸런싱"], "evening", date);
    if (r.ok) {
      actions.push({
        side: "sell",
        code: t.code,
        name: t.name,
        qty: t.qty,
        price: t.price,
        funding: pos.funding,
        why: t.reason,
        used: ["연금 리밸런싱"],
        pnl: r.pnl,
      });
    }
  }

  /*
   * ── ②-b **모자란 자리 채우기** (2026-09-04) ──
   *
   * 리밸런싱이 여태 위로만 열려 있었다 — 커진 것은 잘랐지만 빠져서 목표보다 작아진
   * 자리를 다시 채우지 않았다. 그러면 오른 것만 잘리고 내린 것은 그대로라 비중이
   * 아래로만 흐른다. 「싼 것을 더 담는다」가 리밸런싱의 반쪽인데 그게 없었다.
   *
   * 시장 문이 닫혀도 한다 — **이미 정한 자리를 목표까지 되돌리는 것**이지 새 자리를
   * 여는 것이 아니다. 둘은 다른 판단이다.
   */
  const topUps = pensionTopUps(a, priceOf, profile);
  for (const o of topUps) {
    const r = buy(
      a,
      {
        code: o.pick.code,
        name: o.pick.name,
        qty: o.qty,
        price: o.price,
        funding: "cash",
        why: o.reason,
        used: ["연금 리밸런싱"],
        stop: null,
        target: null,
        slot: "evening",
        safe: profile.riskCap < 100 ? o.pick.safe : undefined,
      },
      priceOf,
      date,
    );
    if (r.ok) {
      actions.push({
        side: "buy",
        code: o.pick.code,
        name: o.pick.name,
        qty: r.qty,
        price: o.price,
        funding: "cash",
        why: o.reason,
        used: ["연금 리밸런싱"],
      });
    }
  }
  progress.done("exit", `정리 ${trims.length}건 · 채움 ${topUps.length}건`);

  /* ── ③ 담을 것 고르기 ── */
  progress.start("scan");
  const picks = await pickBy(client, method, account);
  progress.done("scan", `위험 ${picks.risky.length} · 안전 ${picks.safe.length}`);
  progress.skip("signal", "ETF 는 신호등을 쓰지 않는다");
  progress.skip("ai");

  /* 담을 값은 **지금 값**이라야 한다 */
  const codes = [...picks.risky, ...picks.safe].map((p) => p.code);
  const cpx = await priceMap(client, codes);
  const buyPriceOf = (code: string) => cpx.get(code) ?? px.get(code) ?? null;

  const planned = canOpen
    ? planPension(a, profile, picks, buyPriceOf)
    : {
        orders: [] as ReturnType<typeof planPension>["orders"],
        skipped: [
          {
            name: "-",
            reason: gate
              ? `시장 문이 닫혔다 — ${gate.reason}`
              : "시장 판단을 못 읽어 새로 담지 않았다 (정리·리밸런싱은 했다)",
          },
        ],
      };
  for (const o of planned.orders) {
    const r = buy(
      a,
      {
        code: o.pick.code,
        name: o.pick.name,
        qty: o.qty,
        price: o.price,
        /* 연금은 **예수금만** — 신용·미수가 제도상 안 된다(buyingPower 도 막는다) */
        funding: "cash",
        why: `${o.reason} — ${o.pick.why}`,
        used: o.pick.used,
        /* 연금은 손절로 털지 않는다 — 계획선을 안 세운다(pensionTrims 가 줄인다) */
        stop: null,
        target: null,
        slot: "evening",
        safe: profile.riskCap < 100 ? o.pick.safe : undefined,
      },
      buyPriceOf,
      date,
    );
    if (r.ok) {
      actions.push({
        side: "buy",
        code: o.pick.code,
        name: o.pick.name,
        qty: r.qty,
        price: o.price,
        funding: "cash",
        why: `${o.reason} — ${o.pick.why}`,
        used: o.pick.used,
      });
    }
  }

  /* ── ④ 평가액·글 ── */
  progress.start("write");
  const after = await priceMap(client, a.positions.map((p) => p.code));
  const afterOf = (code: string) => after.get(code) ?? buyPriceOf(code);
  markToMarket(a, afterOf, date);
  const { equity, debt } = equityOf(a, afterOf);
  const prev = a.equityCurve.filter((r) => r.date < date).slice(-1)[0]?.equity ?? null;

  let text = narrate("evening", {
    mode: "close",
    loopBuys: false,
    interval: [],
    gateNotes: [],
    market: null,
    candidates: [],
    plans: [],
    exits: [],
    actions,
    equity,
    prevEquity: prev,
    positions: a.positions.length,
    cash: Math.round(a.cash),
    debt,
  });

  /*
   * **무엇으로 골랐는지 적는다.** 두 방법을 나란히 두기로 한 이상, 나중에
   * 「그때 무엇으로 골랐나」를 물을 수 있어야 비교가 성립한다.
   */
  text =
    `## 연금 주간 배분\n\n` +
    `${profile.name} · 고른 기준: **${METHOD_LABEL[method]}**\n\n` +
    (profile.riskCap < 100
      ? `위험자산 한도 ${profile.riskCap}% — 안전자산 몫을 먼저 채웠다.\n\n`
      : "") +
    text.replace(/^## [^\n]*\n/, "");

  if (planned.skipped.length > 0) {
    text +=
      "\n\n### 안 담은 것\n" + planned.skipped.map((s) => `- ${s.name} — ${s.reason}`).join("\n");
  }

  const polished = await polishJournal("evening", text, cfg.rules);

  const used = new Set<string>();
  for (const p of [...picks.risky, ...picks.safe]) for (const u of p.used) used.add(u);
  if (trims.length > 0) used.add("연금 리밸런싱");

  const entry: SlotEntry = {
    slot: "evening",
    at: new Date().toISOString(),
    text: polished.text,
    market: null,
    candidates: [],
    plans: planned.orders.map((o) => ({
      name: o.pick.name,
      code: o.pick.code,
      qty: o.qty,
      price: o.price,
      funding: "cash",
      stop: 0,
      target: 0,
      why: o.reason,
    })),
    actions,
    exits: trims.map((t) => ({ name: t.name, code: t.code, kind: "trim", reason: t.reason })),
    used: [...used],
    equity,
    cash: Math.round(a.cash),
    debt,
  };

  await saveAccount(a);
  const day = await writeSlot(entry, account, date, force);
  day.review = review(day, prev);
  await saveDay(day);
  progress.done("write", `${actions.length}건 체결`);

  return { ok: true, account, date, method, actions, note: picks.note };
}
