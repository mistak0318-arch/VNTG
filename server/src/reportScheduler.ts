import { buildAiSummary } from "./aiSummary.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { deliverReport } from "./reportDelivery.js";
import {
  EDITIONS,
  loadReport,
  saveReport,
  todayStr,
  type EditionKey,
  type PublishedReport,
} from "./reportStore.js";

/**
 * 리포트 발행 스케줄러.
 *
 * 07시(조간) / 12시(장중) / 18시(석간)에 AI 요약을 만들어 저장한다.
 * 나중에 텔레그램·메일 발송도 여기에 붙인다 (발행 → 저장 → 전송 순서).
 *
 * cron 라이브러리를 쓰지 않는 이유: 의존성을 늘리지 않고 setInterval 하나로 충분해서다.
 * 1분마다 "발행 시각이 지났는데 아직 오늘 그 판이 없으면 발행"하는 방식이라
 * 서버가 잠깐 꺼져 있었어도 다시 켜지면 놓친 판을 만들어낸다.
 */

const CHECK_INTERVAL_MS = 60_000;
let timer: ReturnType<typeof setInterval> | null = null;
let publishing = false;

/** 주말은 장이 없으므로 발행하지 않는다 (공휴일은 데이터가 비어 판단이 어려워 그대로 발행) */
function isWeekend(d: Date): boolean {
  const day = d.getDay();
  return day === 0 || day === 6;
}

export async function publishEdition(
  client: KiwoomClient,
  edition: EditionKey,
  date = todayStr(),
  deliver = true,
): Promise<PublishedReport> {
  const meta = EDITIONS.find((e) => e.key === edition)!;
  const summary = await buildAiSummary(client, edition);
  const report: PublishedReport = {
    date,
    edition,
    label: meta.label,
    publishedAt: new Date().toISOString(),
    summary,
  };
  await saveReport(report);
  console.log(`[report] ${date} ${meta.label} 발행 완료 (토큰 ${summary.inputTokens}/${summary.outputTokens})`);

  // 발행 직후 텔레그램·메일로 전송. 실패해도 저장분은 남으므로 나중에 재발송할 수 있다.
  if (deliver) await deliverReport(report).catch(() => undefined);
  return report;
}

async function tick(client: KiwoomClient): Promise<void> {
  if (publishing) return;
  const now = new Date();
  if (isWeekend(now)) return;

  const date = todayStr(now);
  for (const e of EDITIONS) {
    // 발행 시각이 지났는데 아직 저장분이 없으면 만든다
    if (now.getHours() < e.hour) continue;
    const existing = await loadReport(date, e.key);
    if (existing) continue;

    publishing = true;
    try {
      await publishEdition(client, e.key, date);
    } catch (err) {
      // 발행 실패가 서버를 죽이면 안 된다. 다음 tick에서 다시 시도한다.
      console.error(`[report] ${e.label} 발행 실패:`, err instanceof Error ? err.message : err);
    } finally {
      publishing = false;
    }
    break; // 한 번에 한 판만 (API 부하 분산)
  }
}

export function startReportScheduler(client: KiwoomClient): void {
  if (timer) return;
  // 서버가 막 뜬 직후엔 시세 캐시가 비어 있으므로 조금 기다렸다가 시작한다
  setTimeout(() => void tick(client), 30_000);
  timer = setInterval(() => void tick(client), CHECK_INTERVAL_MS);
  console.log("[report] 발행 스케줄러 시작 (07/12/18시)");
}
