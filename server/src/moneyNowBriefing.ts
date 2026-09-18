/**
 * **돈의 흐름 텔레그램 브리핑 — 하루 네 번** (2026-09-17, 벤티지가 고름).
 *
 * 09:35 · 11:30 · 13:30 · 15:05 — 직장인이 폰을 보는 그 시각에 「지금」 탭의 결론만 다섯 줄로 리포트 방에.
 * 09:35 는 첫 잠정치(09:30) 직후, 11:30 은 점심 전, 13:30 은 13:20 잠정치 직후, 15:05 는 종배 전이다.
 * 하루 한 번씩만(dayMark) — 재시작해도 두 번 안 간다. 주말·휴장은 안 보낸다.
 */
import type { KiwoomClient } from "./kiwoomClient.js";
import { doneToday, markToday } from "./dayMark.js";
import { sendTelegram } from "./telegram.js";
import { isTradingDay } from "./tradingDay.js";
import { moneyNow, moneyNowText } from "./moneyNow.js";

const TIMES = [9 * 60 + 35, 11 * 60 + 30, 13 * 60 + 30, 15 * 60 + 5];
let running = false;

export async function runMoneyNowBriefing(client: KiwoomClient): Promise<void> {
  if (running) return; // 계산이 1분을 넘겨 다음 틱과 겹치면 두 번 간다 — 도장이 뒤로 갔으니 여기서 막는다
  const d = new Date(Date.now() + 9 * 3600_000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const date = d.toISOString().slice(0, 10);
  if (!isTradingDay(new Date(`${date}T12:00:00+09:00`))) return;
  /* 그 시각부터 10분 안이면 보낸다 — 1분 틱이 한 번 밀려도 놓치지 않게 */
  const hit = TIMES.find((t) => minute >= t && minute < t + 10);
  if (hit === undefined) return;
  const key = `moneyNowBrief:${hit}`;
  if (await doneToday(key)) return;
  /*
   * (2026-09-18 전수검증 A9) 도장은 **보낸 뒤에** 찍는다 — 먼저 찍으면 잔고 오류·텔레그램 429 한 번에 그 회차가
   * 그날 통째로 빠졌다. 실패하면 10분 창 안의 다음 틱이 다시 해 본다.
   */
  running = true;
  try {
    const m = await moneyNow(client, { fresh: true });
    await sendTelegram(moneyNowText(m), "report");
    await markToday(key);
  } catch (e) {
    console.warn("[moneyNow] 브리핑 실패 — 다음 틱에 다시", e instanceof Error ? e.message : e);
  } finally {
    running = false;
  }
}
