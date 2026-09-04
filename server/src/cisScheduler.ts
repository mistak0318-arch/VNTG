import type { KiwoomClient } from "./kiwoomClient.js";
import { getCisConfig } from "./cisConfig.js";
import { runSlot } from "./cisRun.js";
import { loadDay } from "./cisJournal.js";
import { today } from "./cisAccount.js";
import type { Slot } from "./cisJournal.js";
import { ACCOUNT_IDS, profileOf, styleOf } from "./cisAccounts.js";
import { runPension } from "./cisPensionRun.js";
import { listTrackLastRunDate } from "./listTrack.js";

/**
 * CIS 하루 세 번 자동 실행.
 *
 * ## 시각을 어떻게 맞추나
 *
 * cron 을 쓰지 않는다 — 이 서버의 다른 정기 작업들이 전부 `setInterval` + 「지금이
 * 그 시각을 지났나」 방식이고(`alertScheduler`, `closeBetLog`), 섞으면 시간대 처리가
 * 두 가지가 된다.
 *
 * **「지났나」로 보는 것이 중요하다.** 정각에 딱 맞추면 그 순간 서버가 재시작 중이면
 * 그날은 영영 안 쓴다. 지났고 아직 안 썼으면 쓴다 — 미니PC 가 아침에 켜져도 그날
 * 아침 일지가 남는다.
 *
 * ## 계좌마다 돈다 (2026-09-02)
 *
 * 예전엔 트레이딩 계좌 하나만 하루 세 번 돌았다. 종배 계좌가 생기면서 **매일 계좌 전부**를
 * 돈다 — 다만 한 틱에 하나만. 세 계좌를 몰아 돌리면 키움 호출이 한꺼번에 몰린다.
 *
 * ## 종배 계좌는 시각이 아니라 **원장**을 본다
 *
 * 벤티지: "얘는 신호등 돌아간 다음에 종배해야 하니깐 스케쥴러를 NXT 에서 종배하는 친구로
 * 만들어야 겠지?" 신호등 분석 원장은 마감 뒤 파이프라인이 16:30 무렵 쌓는다. 그런데
 * 그 파이프라인이 늦어지는 날이 있다(실적 캐시·표본 재작성이 앞에 있다). 시각만 보고
 * 17:00 에 돌리면 **어제 원장으로 종배**하게 된다 — 그래서 `eveningAt` 을 지났고
 * **오늘 원장이 실제로 쌓였을 때**만 돈다. 안 쌓였으면 실패로 세지 않고 다음 분에 다시
 * 본다. NXT 애프터마켓은 20:00 까지라 그 안에만 오면 된다.
 *
 * ## 주말·공휴일
 *
 * 주말은 건너뛴다. 공휴일 표는 없으므로 **거래가 없으면 후보가 안 나오고**
 * (`leaderScan.noTrade`) 일지에 「거래가 없어 쉰다」가 남는다 — 공휴일에도 자동으로
 * 맞는 셈이라 표를 만들지 않는다.
 */

const TICK_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
/**
 * 이번 프로세스에서 시도한 것.
 *
 * ⚠️ **성공했을 때만 잠근다** (2026-08-31). 예전엔 시도 **전에** 잠갔는데,
 * 그러면 아침 실행이 한 번 실패했을 때(키움 토큰 갱신 중, 네트워크 끊김…)
 * 그날은 영영 재시도하지 않았다. 켜 두고 하루를 관찰하려는데 아침이 조용히
 * 빠지면 그 하루가 통째로 없어진다.
 *
 * 대신 **무한히 다시 때리지도 않는다** — 몇 번 실패하면 그만둔다. 계속 실패하는
 * 것을 1분마다 부르면 키움 호출만 태운다.
 */
const tried = new Map<string, { fails: number; error?: string; at: string }>();
const MAX_TRY = 3;
/**
 * 종배가 원장을 기다리는 **마감선** (KST). NXT 애프터마켓은 20:00 에 닫힌다 —
 * 그 전에 한 번은 돌아서 「왜 안 샀나」를 일지에 남겨야 한다.
 */
const CLOSEBET_DEADLINE = "19:30";

/** 화면이 「왜 안 썼나」를 물을 수 있게 — 실패는 콘솔에만 두면 아무도 못 본다 */
export function cisSchedulerState(): { key: string; fails: number; error?: string; at: string }[] {
  return [...tried.entries()]
    .filter(([, v]) => v.fails > 0)
    .map(([key, v]) => ({ key, ...v }));
}

function nowHm(): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function isWeekend(): boolean {
  const d = new Date(Date.now() + 9 * 3600_000);
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}

function weekday(): number {
  return new Date(Date.now() + 9 * 3600_000).getUTCDay();
}

/**
 * 연금 계좌 — **주 1회.**
 *
 * 트레이딩 계좌가 1분·15분으로 도는 것과 정반대다. 연금은 십 년 단위로 굴리는
 * 돈이라 덜 손대는 것이 규칙이고, 자주 갈아타면 세금 이연의 이점을 매매비용으로
 * 다 태운다(`cisPensionRun` 머리 주석).
 *
 * 저녁 시각에 맞춰 돈다 — 종가가 확정된 뒤라야 그 주의 판이 보인다.
 */
async function pensionTick(client: KiwoomClient): Promise<void> {
  const cfg = await getCisConfig();
  /* 월·수·금 (2026-09-04) — 요일 목록으로 바뀌었다. 옛 설정은 `getCisConfig` 가 옮긴다 */
  if (!cfg.pensionDays.includes(weekday())) return;
  if (nowHm() < cfg.times.evening) return;

  const date = today();
  for (const id of ACCOUNT_IDS) {
    if (profileOf(id).cadence === "daily") continue;
    const key = `${date}:pension:${id}`;
    const st = tried.get(key);
    if (st && (st.fails === 0 || st.fails >= MAX_TRY)) continue;
    try {
      const r = await runPension(client, id);
      if (r.ok || r.skipped?.includes("이미")) {
        tried.set(key, { fails: 0, at: new Date().toISOString() });
      } else {
        tried.set(key, { fails: (st?.fails ?? 0) + 1, error: r.skipped, at: new Date().toISOString() });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[cis] 연금 ${id} 실패:`, msg);
      tried.set(key, { fails: (st?.fails ?? 0) + 1, error: msg, at: new Date().toISOString() });
    }
    return; // 한 번에 하나만 — 무거운 조회가 몰리지 않게
  }
}

async function tick(client: KiwoomClient): Promise<void> {
  const cfg = await getCisConfig();
  if (!cfg.enabled || !cfg.auto) return;
  if (isWeekend()) return;

  await pensionTick(client);

  const date = today();
  const hm = nowHm();

  for (const id of ACCOUNT_IDS) {
    const profile = profileOf(id);
    if (profile.cadence !== "daily") continue;
    const day = await loadDay(date, id);

    for (const slot of ["morning", "noon", "evening"] as Slot[]) {
      /* 저녁은 계좌가 제 시각을 가질 수 있다 — 종배 계좌는 원장이 쌓인 뒤 */
      const at = slot === "evening" && profile.eveningAt ? profile.eveningAt : cfg.times[slot];
      if (hm < at) continue; // 아직 그 시각이 아니다
      if (day[slot]) continue; // 이미 썼다

      /*
       * 종배 계좌의 저녁 — **오늘 원장이 쌓였나.** 안 쌓였으면 실패가 아니라 「아직」이다.
       * 실패로 세면 세 번 만에 잠겨서 정작 원장이 쌓인 뒤엔 안 돈다.
       */
      if (slot === "evening" && styleOf(id) === "closeBet") {
        const last = await listTrackLastRunDate().catch(() => null);
        /*
         * **마감선** (2026-09-04 — 벤티지: "종가배팅은 왜 일지도 안 쓰고 거래도 안 하는 거야").
         *
         * 여태는 원장이 안 쌓이면 `continue` 하고 끝이었다. 마감 뒤 파이프라인이 늦거나
         * 한 번 엎어지면 **종배는 그날 아무 흔적도 안 남겼다** — 화면엔 「아직 안 썼습니다」
         * 뿐이라, 안 산 것인지 못 산 것인지 사람이 알 길이 없었다. 조용한 고장이 이
         * 장부에서 가장 비싸다.
         *
         * 그래서 기다리되 **끝까지 기다리지는 않는다.** NXT 애프터마켓이 20:00 에 닫히니
         * 그 전(19:30)까지 원장이 안 쌓이면 그냥 돌린다 — `closeBetRound` 가 원장 날짜를
         * 보고 「오늘 원장이 없어 종배 안 함」이라고 **일지에 적는다.**
         */
        if (last !== date && hm < CLOSEBET_DEADLINE) continue;
      }

      const key = `${date}:${id}:${slot}`;
      const st = tried.get(key);
      if (st && (st.fails === 0 || st.fails >= MAX_TRY)) continue;
      try {
        const r = await runSlot(client, slot, id);
        /*
         * 성공했을 때만 잠근다. `ok:false` 라도 「이미 썼다」면 잠근다 — 그건
         * 실패가 아니라 할 일이 없는 것이다.
         */
        if (r.ok || r.skipped?.includes("이미")) {
          tried.set(key, { fails: 0, at: new Date().toISOString() });
        } else {
          tried.set(key, {
            fails: (st?.fails ?? 0) + 1,
            error: r.skipped,
            at: new Date().toISOString(),
          });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`[cis] ${id} ${slot} 실행 실패:`, msg);
        tried.set(key, { fails: (st?.fails ?? 0) + 1, error: msg, at: new Date().toISOString() });
      }
      /* 한 번에 하나만 — 몰아 돌리면 키움 호출이 한꺼번에 몰린다 */
      return;
    }
  }
}

export function startCisScheduler(client: KiwoomClient): void {
  if (timer) return;
  /* 켜자마자 한 번 본다 — 서버가 낮에 재시작돼도 그날 것을 따라잡는다 */
  void tick(client);
  timer = setInterval(() => void tick(client), TICK_MS);
}

/** 설정을 바꿔 시각이 당겨졌을 때 다시 시도할 수 있게 */
export function resetCisTried(): void {
  tried.clear();
}
