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

export async function runMoneyNowBriefing(client: KiwoomClient): Promise<void> {
  const d = new Date(Date.now() + 9 * 3600_000);
  const minute = d.getUTCHours() * 60 + d.getUTCMinutes();
  const date = d.toISOString().slice(0, 10);
  if (!isTradingDay(new Date(`${date}T12:00:00+09:00`))) return;
  /* 그 시각부터 10분 안이면 보낸다 — 1분 틱이 한 번 밀려도 놓치지 않게 */
  const hit = TIMES.find((t) => minute >= t && minute < t + 10);
  if (hit === undefined) return;
  const key = `moneyNowBrief:${hit}`;
  if (await doneToday(key)) return;
  await markToday(key);
  try {
    const m = await moneyNow(client, { fresh: true });
    await sendTelegram(moneyNowText(m), "report");
  } catch (e) {
    console.warn("[moneyNow] 브리핑 실패 —", e instanceof Error ? e.message : e);
  }
}
