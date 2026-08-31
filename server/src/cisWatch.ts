import type { KiwoomClient } from "./kiwoomClient.js";
import { equityOf, loadAccount, markToMarket, saveAccount, sell, today } from "./cisAccount.js";
import { ACCOUNT_IDS, profileOf, type AccountId } from "./cisAccounts.js";
import { getCisConfig } from "./cisConfig.js";
import { exitCalls, trailStops } from "./cisTrader.js";
import { buyRound, priceMap } from "./cisRun.js";
import { modeOfSlot } from "./cisTrader.js";
import type { Slot } from "./cisJournal.js";

/**
 * 상시 감시 — **시스가 장중 내내 보고 있다.**
 *
 * ## 왜 하루 세 번으로 부족한가 (2026-08-31)
 *
 * 벤티지: "되도록이면 시장을 계속보면서 하는 CIS 모드였으면 해서."
 *
 * 손절선은 12시 30분에만 있는 게 아니다. 10시에 손절선을 뚫고 12시에 되돌아오면,
 * 세 번만 보는 계좌는 **그 손절을 없었던 일로 적는다.** 실제로는 그 자리에서
 * 팔렸을 것이고, 그러면 이 장부가 현실과 다른 이야기가 된다.
 *
 * ## 무엇을 얼마나 자주 보나
 *
 * 병목은 AI 비용이 아니라 **키움 호출 한도**다. 그래서 갈래를 나눈다:
 *
 *   - **매도 감시 1분** — 보유 종목 시세는 ka10095 **한 번**이면 100종목까지
 *     온다. 하루 390분을 다 돌아도 390회다. 싸다.
 *   - **매수는 여기서 안 한다** — 후보 스캔(주도주+종목별 신호등)이 무거워
 *     1분마다 돌리면 초당 5회 한도에 걸린다. 그리고 후보가 1분 사이에 바뀌지도
 *     않는다. 자주 보면 조건 경계에서 들락날락할 뿐이다.
 *
 * 매수는 하루 세 번(시가·장중·종가배팅)이 맡고, 여기는 **팔 자리만** 본다.
 * 「사는 것은 신중하게, 파는 것은 즉시」가 이 계좌의 규칙이다.
 *
 * ## AI 는 여기 없다
 *
 * 이 루프는 규칙만 돈다 — 비용 0, 지연 0. AI 는 하루 세 번 글을 쓸 때만 부른다.
 * 1분마다 LLM 을 부르면 월 수백 달러가 나가는데, 그렇게 해서 얻는 것이 없다:
 * 손절선을 뚫었나는 뺄셈이다.
 */

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let lastRun = 0;
/** 계좌별로 마지막 매수 스캔 시각 — 주기를 지키는 데 쓴다 */
const lastBuyScan = new Map<AccountId, number>();
let lastBuyScanAt = 0;

/** 방금 무엇을 했나 — 화면과 다음 일지가 읽는다 */
export interface WatchEvent {
  at: string;
  account: AccountId;
  kind: "sell" | "trail" | "buy";
  name: string;
  code: string;
  qty?: number;
  price?: number;
  pnl?: number;
  reason: string;
}

/**
 * 최근 사건들. **메모리에만 둔다** — 체결은 이미 계좌 원장(fills)에 남고,
 * 여기 있는 것은 「손절선을 올렸다」처럼 원장에 안 남는 관리 행위와
 * 화면이 바로 보여줄 최근 기록이다. 서버가 다시 뜨면 비어도 된다.
 */
const events: WatchEvent[] = [];
const MAX_EVENTS = 300;

export function watchEvents(account?: AccountId, limit = 50): WatchEvent[] {
  const rows = account ? events.filter((e) => e.account === account) : events;
  return rows.slice(-limit).reverse();
}

/**
 * 장이 열려 있나 (KST).
 *
 * ⚠️ **공휴일 표가 없다.** 주말만 거르고, 공휴일에는 시세가 안 움직여
 * 팔 자리가 안 생기므로 자연히 아무것도 안 한다 — 없는 데이터를 지어내
 * 표를 만드느니 그 성질에 기댄다.
 *
 * NXT 애프터마켓(15:40~20:00)까지 본다. 종가배팅으로 담은 것이 그 시간에
 * 움직이면 손절선이 거기서도 지켜져야 한다.
 */
function marketOpen(): boolean {
  const d = new Date(Date.now() + 9 * 3600_000);
  const w = d.getUTCDay();
  if (w === 0 || w === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 8 * 60 && m <= 20 * 60; // 08:00 프리마켓 ~ 20:00 애프터마켓
}

/** 지금이 어느 시간대에 속하나 — 감시가 만든 체결도 구간에 담긴다 */
function slotNow(times: { morning: string; noon: string; evening: string }): Slot {
  const d = new Date(Date.now() + 9 * 3600_000);
  const hm = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  if (hm < times.noon) return "morning";
  if (hm < times.evening) return "noon";
  return "evening";
}

async function watchAccount(client: KiwoomClient, id: AccountId): Promise<void> {
  const a = await loadAccount(id);
  if (a.positions.length === 0) return;

  const cfg = await getCisConfig();
  const px = await priceMap(client, a.positions.map((p) => p.code));
  /* ⚠️ 못 읽은 값은 null 이다. 0 으로 두면 전 종목 손절이 발동한다 */
  const priceOf = (code: string) => px.get(code) ?? null;
  if (px.size === 0) return; // 하나도 못 읽었으면 아무 판단도 하지 않는다

  const date = today();
  const slot = slotNow(cfg.times);
  const profile = profileOf(id);
  let changed = false;

  /*
   * 연금 계좌는 여기서 **아무것도 안 판다.**
   *
   * 지수를 담는 자리라 손절로 털면 회복할 때 자리에 없다(`cisPension` 참고).
   * 줄이는 판단은 주 단위 리밸런싱의 몫이지 1분 감시의 몫이 아니다 —
   * 1분마다 비중을 재면 하루에도 몇 번씩 사고팔게 된다.
   */
  if (profile.cadence !== "daily") {
    markToMarket(a, priceOf, date);
    await saveAccount(a);
    return;
  }

  /*
   * ① **흔들림을 새긴다.** 1분 감시가 남기는 유일한 상시 기록이다.
   *
   * 사건이 없어도 이건 갱신된다 — 오히려 사건이 없는 날에 값진 기록이다.
   * 「오늘 하루 -6.2% 까지 밀렸다가 +1% 로 끝났다」는 종가만 봐서는 절대 모른다.
   *
   * ⚠️ 새 기록일 때만 시각을 갱신한다. 매분 덮으면 「언제 그랬나」가 지금이 된다.
   */
  const nowIso = new Date().toISOString();
  for (const p of a.positions) {
    const now = priceOf(p.code);
    if (now === null || now <= 0 || p.avg <= 0) continue;
    const pct = Number((((now - p.avg) / p.avg) * 100).toFixed(2));
    if (p.worstPct === undefined || pct < p.worstPct) {
      p.worstPct = pct;
      p.worstAt = nowIso;
      changed = true;
    }
    if (p.bestPct === undefined || pct > p.bestPct) {
      p.bestPct = pct;
      p.bestAt = nowIso;
      changed = true;
    }
  }

  /* ② 팔 자리 */
  for (const e of exitCalls(a, priceOf, cfg.rules, date)) {
    const r = sell(
      a,
      e.position.code,
      e.position.funding,
      e.position.qty,
      e.price,
      `${e.reason} (장중 감시)` +
        (e.position.worstPct !== undefined
          ? ` · 보유 중 ${e.position.worstPct}% ~ ${e.position.bestPct}% 를 오갔다`
          : ""),
      [`매도규칙:${e.kind}`, "장중 감시"],
      slot,
      date,
    );
    if (r.ok) {
      changed = true;
      events.push({
        at: new Date().toISOString(),
        account: id,
        kind: "sell",
        name: e.position.name,
        code: e.position.code,
        qty: e.position.qty,
        price: e.price,
        pnl: r.pnl,
        reason: e.reason,
      });
    }
  }

  /* ③ 손절선 올리기 — 이익을 손실로 바꾸지 않는다 */
  for (const t of trailStops(a, priceOf, cfg.rules)) {
    changed = true;
    events.push({
      at: new Date().toISOString(),
      account: id,
      kind: "trail",
      name: t.name,
      code: t.code,
      reason: `손절선을 본전 ${t.to.toLocaleString()}원으로 올렸다`,
    });
  }

  /*
   * ④ 평가액은 **바뀐 게 있을 때만** 찍는다. 1분마다 저장하면 하루 390번
   * 파일을 쓰고, 곡선도 톱니가 된다(markToMarket 이 같은 날은 덮지만 저장은 매번).
   */
  if (changed) {
    markToMarket(a, priceOf, date);
    await saveAccount(a);
  }

  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
}

/**
 * **살 자리를 찾는다** — 몇 분마다 (2026-08-31, 기본 15분).
 *
 * 매도(1분)와 나눈 이유: 후보 스캔은 주도주 스캔과 종목별 신호등을 부르는
 * 무거운 일이라 1분마다 돌리면 초당 5회 한도에 걸린다. 그리고 **후보가 1분
 * 사이에 바뀌지 않는다** — 자주 보면 조건 경계에서 샀다 팔았다만 한다.
 *
 * 진입 모드는 **시각이 정한다**: 아침엔 시가배팅, 장중엔 장중배팅,
 * 마감 무렵엔 종가배팅. 조건이 안 서면 아무것도 안 산다.
 *
 * ⚠️ 매수 판단은 `buyRound` 한 곳에 있다 — 하루 세 번 일지도 같은 함수를
 * 쓴다. 두 군데 있으면 둘이 갈리고, 그러면 「어느 규칙이 나빴나」를 못 묻는다.
 */
async function buyScan(client: KiwoomClient, id: AccountId, everyMin: number): Promise<void> {
  const now = Date.now();
  const last = lastBuyScan.get(id) ?? 0;
  if (now - last < everyMin * 60_000) return;
  lastBuyScan.set(id, now);
  lastBuyScanAt = now;

  const cfg = await getCisConfig();
  const a = await loadAccount(id);
  /* 자리가 꽉 찼으면 스캔 자체를 안 돈다 — 무거운 조회를 헛되이 부르지 않는다 */
  if (a.positions.length >= cfg.rules.maxPositions) return;

  const date = today();
  const slot = slotNow(cfg.times);
  const r = await buyRound(client, a, id, slot, modeOfSlot(slot), date);
  if (r.actions.length === 0) return;

  for (const act of r.actions) {
    events.push({
      at: new Date().toISOString(),
      account: id,
      kind: "buy",
      name: act.name,
      code: act.code,
      qty: act.qty,
      price: act.price,
      reason: act.why,
    });
  }
  const px = await priceMap(client, a.positions.map((p) => p.code));
  markToMarket(a, (c) => px.get(c) ?? null, date);
  await saveAccount(a);
}

async function tick(client: KiwoomClient): Promise<void> {
  const cfg = await getCisConfig();
  if (!cfg.enabled || !cfg.watch) return;
  if (!marketOpen()) return;
  lastRun = Date.now();
  for (const id of ACCOUNT_IDS) {
    try {
      await watchAccount(client, id);
    } catch (e) {
      console.error(`[cis-watch] ${id} 감시 실패:`, e instanceof Error ? e.message : e);
    }
    /*
     * 연금 계좌는 여기서 안 산다 — 주 단위로 담는 자리라 15분마다 볼 이유가 없고,
     * ETF 배분은 `cisPension` 이 따로 맡는다.
     */
    if (cfg.buyScanMin > 0 && profileOf(id).cadence === "daily") {
      try {
        await buyScan(client, id, cfg.buyScanMin);
      } catch (e) {
        console.error(`[cis-watch] ${id} 매수 스캔 실패:`, e instanceof Error ? e.message : e);
      }
    }
  }
}

export function startCisWatch(client: KiwoomClient): void {
  if (timer) return;
  timer = setInterval(() => void tick(client), TICK_MS);
}

/** 화면이 「지금 보고 있나」를 묻는다 */
export function watchStatus(): {
  open: boolean;
  lastRun: string | null;
  lastBuyScan: string | null;
  events: number;
} {
  return {
    open: marketOpen(),
    lastRun: lastRun ? new Date(lastRun).toISOString() : null,
    lastBuyScan: lastBuyScanAt ? new Date(lastBuyScanAt).toISOString() : null,
    events: events.length,
  };
}

/**
 * 두 시각 사이의 사건 — 일지가 「그사이에 뭘 했나」를 적을 때 쓴다.
 * 계좌 원장(fills)이 본체이고 이건 관리 행위(손절선 올림)를 보태는 자리다.
 */
export function eventsBetween(account: AccountId, fromISO: string | null): WatchEvent[] {
  return events.filter((e) => e.account === account && (!fromISO || e.at > fromISO));
}

/** 계좌를 초기화할 때 사건도 같이 지운다 — 안 그러면 없는 계좌의 기록이 남는다 */
export function clearWatchEvents(account: AccountId): void {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].account === account) events.splice(i, 1);
  }
}
