import type { KiwoomClient } from "./kiwoomClient.js";
import { getCisConfig } from "./cisConfig.js";
import { runSlot } from "./cisRun.js";
import { loadDay } from "./cisJournal.js";
import { today } from "./cisAccount.js";
import type { Slot } from "./cisJournal.js";
import { ACCOUNT_IDS, profileOf } from "./cisAccounts.js";
import { runPension } from "./cisPensionRun.js";

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
  if (weekday() !== cfg.pensionDay) return;
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
  const day = await loadDay(date);

  for (const slot of ["morning", "noon", "evening"] as Slot[]) {
    const at = cfg.times[slot];
    if (hm < at) continue; // 아직 그 시각이 아니다
    if (day[slot]) continue; // 이미 썼다
    const key = `${date}:${slot}`;
    const st = tried.get(key);
    if (st && (st.fails === 0 || st.fails >= MAX_TRY)) continue;
    try {
      const r = await runSlot(client, slot);
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
      console.error(`[cis] ${slot} 실행 실패:`, msg);
      tried.set(key, { fails: (st?.fails ?? 0) + 1, error: msg, at: new Date().toISOString() });
    }
    /* 한 번에 하나만 — 세 개를 몰아 돌리면 키움 호출이 한꺼번에 몰린다 */
    return;
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
