import { noopProgress, type ProgressReporter } from "./reportProgress.js";
import { pushNotice } from "./notifyCenter.js";
import { warmResearch } from "./webResearch.js";
import { buildAiSummary } from "./aiSummary.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { captureBreadth } from "./breadthStore.js";
import { captureSectorFlow } from "./sectorFlowStore.js";
import { deliverReport } from "./reportDelivery.js";
import { getSchedule, slotsForDay } from "./reportSchedule.js";
import {
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
  // 판 정보는 설정에서 찾는다. 없는 id로 불려도(즉시발행 등) 키를 라벨로 써서 진행한다.
  const schedule = await getSchedule();
  const slot = schedule.slots.find((s) => s.id === edition);
  const meta = { key: edition, label: slot?.label ?? edition };
  // 프롬프트는 kind가 정한다 — 사용자가 만든 판도 넷 중 하나로 매핑된다
  const summary = await buildAiSummary(client, slot?.kind ?? "intraday");
  const report: PublishedReport = {
    date,
    edition,
    label: meta.label,
    publishedAt: new Date().toISOString(),
    summary,
  };
  await saveReport(report);
  console.log(`[report] ${date} ${meta.label} 발행 완료 (토큰 ${summary.inputTokens}/${summary.outputTokens})`);

  /*
   * **알림 센터에도 남긴다** (2026-09-01).
   *
   * 벤티지: "데일리 리포트도 만들어졌으면 알람 줘야 하고, 시스템적으로 돌아가는
   * 배치들은 다 되면 나한테 알람 주는 구조로 만들어줘. 알람 메뉴 만들었잖아."
   *
   * 여태 텔레그램으로만 갔다. 텔레그램은 자리를 비운 사이에 오고 알림 센터는
   * 화면에 남는다 — 서로를 대신하지 못한다. 텔레그램을 놓치면 영영 못 보고,
   * 화면만 있으면 자리에 없을 때 모른다.
   */
  await pushNotice({
      source: "report",
    kind: "market",
    level: "info",
    title: `${meta.label} 발행`,
    /* 본문 첫 줄만 — 알림에 리포트 전체를 넣으면 목록이 못 쓰게 된다 */
    body:
      summary.digest ??
      summary.text
        ?.split("\n")
        .find((l) => l.trim())
        ?.slice(0, 120),
    /* 데일리 리포트 탭 키는 `report` — 옛 `#/dailyReport` 는 없는 탭이었다 (2026-09-03) */
    link: "#/report",
    /* 같은 날 같은 판은 한 번만 — 재발행하면 그건 새 소식이 아니다 */
    dedupeKey: `report:${date}:${edition}`,
    dedupeHours: 20,
  }).catch(() => undefined);

  // 발행 직후 텔레그램·메일로 전송. 실패해도 저장분은 남으므로 나중에 재발송할 수 있다.
  if (deliver) await deliverReport(report, client).catch(() => undefined);
  return report;
}

/**
 * 설정에 없는 일회성 판을 발행한다 (즉시발행).
 * 정기 판과 파일이 겹치지 않도록 호출자가 id를 정해 넘긴다.
 */
export async function publishAdhoc(
  client: KiwoomClient,
  opts: { id: string; label: string; kind: string; deliver?: boolean },
  progress: ProgressReporter = noopProgress,
): Promise<PublishedReport> {
  const date = todayStr();
  const summary = await buildAiSummary(client, opts.kind, progress);
  const report: PublishedReport = {
    date,
    edition: opts.id,
    label: opts.label,
    publishedAt: new Date().toISOString(),
    summary,
  };
  progress.start("save");
  await saveReport(report);
  console.log(`[report] ${date} ${opts.label} 즉시발행 (토큰 ${summary.inputTokens}/${summary.outputTokens})`);
  if (opts.deliver) await deliverReport(report, client).catch(() => undefined);
  progress.done("save", opts.deliver ? "저장·발송 완료" : "저장 완료");
  return report;
}

async function tick(client: KiwoomClient): Promise<void> {
  if (publishing) return;
  const now = new Date();
  const weekend = isWeekend(now);

  // 시장 폭은 리포트와 무관하게 매 tick 시도한다.
  // 소급 조회가 불가능한 데이터라 하루라도 빠지면 영영 메울 수 없다 —
  // 리포트 발행이 실패하는 날에도 이건 남아야 하므로 위에 둔다.
  // 주말엔 breadthStore가 자체적으로 저장을 막지만, 호출 자체를 아낀다
  if (!weekend) {
    await captureBreadth(client).catch((err: unknown) => {
      console.error("[breadth] 저장 실패:", err instanceof Error ? err.message : err);
      return null;
    });

    // 업종별 수급도 같이 남긴다. 이쪽은 base_dt로 소급이 되므로 하루 빠져도 메울 수 있지만,
    // 매일 받아두면 백필을 다시 돌릴 일이 없다 (하루치 2호출).
    await captureSectorFlow(client).catch((err: unknown) => {
      console.error("[sectorFlow] 저장 실패:", err instanceof Error ? err.message : err);
      return null;
    });
  }

  const date = todayStr(now);

  /*
   * 어떤 판을 언제 낼지는 이제 설정에서 온다 (data/reportSchedule.json).
   * 요일 조건(평일/주말/매일)도 설정에 있으므로 여기서 주말을 따로 가르지 않는다.
   */
  const schedule = await getSchedule();
  const plan = slotsForDay(schedule, now);
  const mins = now.getHours() * 60 + now.getMinutes();

  for (const e of plan) {
    // 발행 시각이 지났는데 아직 저장분이 없으면 만든다
    if (mins < e.hour * 60 + e.minute) continue;
    const existing = await loadReport(date, e.id);
    if (existing) continue;

    publishing = true;
    try {
      await publishEdition(client, e.id, date, e.deliver);
    } catch (err) {
      // 발행 실패가 서버를 죽이면 안 된다. 다음 tick에서 다시 시도한다.
      console.error(`[report] ${e.label} 발행 실패:`, err instanceof Error ? err.message : err);
    } finally {
      publishing = false;
    }
    break; // 한 번에 한 판만 (API 부하 분산)
  }
}

/**
 * 정기 발행 15분 전에 웹 리서치를 미리 채운다.
 *
 * 리서치는 몇 분이 걸린다. 발행 시각에 시작하면 리포트가 그만큼 늦고, 발행 경로는
 * 이제 기다리지 않으므로 **아예 리서치 없이 나가 버린다.** 미리 데워 두면 정기 발행은
 * 항상 캐시를 받는다. 캐시가 아직 신선하면 warmResearch 가 아무것도 안 하므로
 * 호출이 늘지 않는다.
 */
async function warmTick(): Promise<void> {
  if (process.env.RESEARCH_ENABLED === "0") return;
  const schedule = await getSchedule().catch(() => null);
  if (!schedule) return;

  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  const due = schedule.slots.some((slot) => {
    if (!slot.enabled) return false;
    const lead = slot.hour * 60 + slot.minute - 15;
    return mins >= lead && mins < lead + 5; // 5분 창 — CHECK_INTERVAL 보다 넓게
  });
  if (!due) return;

  // 조간은 간밤 해외가 본체라 검색을 더 준다
  await warmResearch(now.getHours() < 9 ? 5 : 3);
}

export function startReportScheduler(client: KiwoomClient): void {
  if (timer) return;
  // 서버가 막 뜬 직후엔 시세 캐시가 비어 있으므로 조금 기다렸다가 시작한다
  setTimeout(() => void tick(client), 30_000);
  timer = setInterval(() => void tick(client), CHECK_INTERVAL_MS);
  setInterval(() => void warmTick().catch(() => undefined), CHECK_INTERVAL_MS);
  void getSchedule().then((s) => {
    const on = s.slots.filter((x) => x.enabled);
    const times = on.map((x) => `${x.label} ${x.hour}:${String(x.minute).padStart(2, "0")}`).join(", ");
    console.log(`[report] 발행 스케줄러 시작 — ${on.length}판 (${times || "없음"})`);
  });
}
