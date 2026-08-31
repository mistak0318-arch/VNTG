import type { KiwoomClient } from "./kiwoomClient.js";
import { getCisConfig } from "./cisConfig.js";
import { runSlot } from "./cisRun.js";
import { loadDay } from "./cisJournal.js";
import { today } from "./cisAccount.js";
import type { Slot } from "./cisJournal.js";

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
/** 이번 프로세스에서 이미 시도한 것 — 실패해도 1분마다 다시 때리지 않게 */
const tried = new Set<string>();

function nowHm(): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

function isWeekend(): boolean {
  const d = new Date(Date.now() + 9 * 3600_000);
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}

async function tick(client: KiwoomClient): Promise<void> {
  const cfg = await getCisConfig();
  if (!cfg.enabled || !cfg.auto) return;
  if (isWeekend()) return;

  const date = today();
  const hm = nowHm();
  const day = await loadDay(date);

  for (const slot of ["morning", "noon", "evening"] as Slot[]) {
    const at = cfg.times[slot];
    if (hm < at) continue; // 아직 그 시각이 아니다
    if (day[slot]) continue; // 이미 썼다
    const key = `${date}:${slot}`;
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      await runSlot(client, slot);
    } catch (e) {
      console.error(`[cis] ${slot} 실행 실패:`, e instanceof Error ? e.message : e);
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
