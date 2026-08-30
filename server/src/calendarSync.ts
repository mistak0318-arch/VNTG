import { listSubs } from "./calendarSubscription.js";
import { fetchIcs, parseIcs } from "./calendarImport.js";
import { replaceBySource } from "./calendar.js";

/**
 * 구독 캘린더 자동 동기화 (2026-08-30 요청 — 「한 번 가져오고 마는 건가?」).
 *
 * ## 무엇이 문제였나
 *
 * 구조는 **처음부터 「계속 가져오기」였다** — 구독 주소를 저장해 두고, 동기화할
 * 때마다 그 주소를 다시 읽어 `replaceBySource` 로 통째로 갈아끼운다(중복이 안 쌓이고
 * 직접 입력한 일정은 안 건드린다).
 *
 * 그런데 **그걸 부르는 것이 화면의 「지금 동기화」 단추뿐**이었다. 스케줄러가 없으니
 * 구글 캘린더에 일정을 넣어도 단추를 누르기 전까지는 안 들어온다 — 「가져오기」라고
 * 이름 붙여 놓고 실제로는 수동이었던 셈이다.
 *
 * ## 얼마나 자주
 *
 * 남의 서버를 긁는 것이라 자주 부를 이유가 없다. 캘린더 일정은 분 단위로 바뀌는
 * 것이 아니고, 대개 **며칠 전에** 넣는다. 30분이면 충분하고도 남는다.
 *
 * 다만 **처음 한 번은 서버가 뜨고 조금 뒤에** 돈다 — 켜자마자 돌면 다른 초기화와
 * 겹쳐 느려지고, 어차피 사람이 화면을 열기까지는 시간이 있다.
 */

const PERIOD_MS = 30 * 60_000;
const FIRST_DELAY_MS = 90_000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastAt = 0;
let lastResult: { label: string; added: number; error?: string }[] = [];

export interface SyncStatus {
  /** 마지막으로 돈 시각 */
  lastAt: string | null;
  /** 그때 결과 — 화면이 「언제 · 몇 건」을 말할 수 있게 */
  results: { label: string; added: number; error?: string }[];
  /** 구독 개수 */
  subs: number;
  periodMinutes: number;
}

export async function syncSubscriptions(): Promise<SyncStatus["results"]> {
  const subs = await listSubs();
  const out: SyncStatus["results"] = [];
  for (const s of subs) {
    try {
      const text = await fetchIcs(s.url);
      const parsed = parseIcs(text, `ics:${s.url}`, "personal");
      const r = await replaceBySource(`ics:${s.url}`, parsed);
      out.push({ label: s.label, added: r.added });
    } catch (e) {
      out.push({ label: s.label, added: 0, error: e instanceof Error ? e.message : "실패" });
    }
  }
  lastAt = Date.now();
  lastResult = out;
  return out;
}

export async function syncStatus(): Promise<SyncStatus> {
  return {
    lastAt: lastAt > 0 ? new Date(lastAt).toISOString() : null,
    results: lastResult,
    subs: (await listSubs()).length,
    periodMinutes: PERIOD_MS / 60_000,
  };
}

export function startCalendarSyncScheduler(): void {
  if (timer) return;
  const tick = async () => {
    /* 구독이 없으면 아무것도 안 한다 — 빈 목록을 도는 것도 로그만 더럽힌다 */
    if ((await listSubs().catch(() => [])).length === 0) return;
    await syncSubscriptions().catch(() => undefined);
  };
  setTimeout(() => void tick(), FIRST_DELAY_MS);
  timer = setInterval(() => void tick(), PERIOD_MS);
  console.log("[calendar] 구독 자동 동기화 시작 (30분 주기)");
}
