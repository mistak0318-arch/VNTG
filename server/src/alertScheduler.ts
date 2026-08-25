import { formatAlerts, getAlertConfig, scanAlerts, type FiredAlert } from "./alertRules.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { logEvents } from "./eventLog.js";
import { pruneLiveAlerts, runLiveAlerts } from "./liveAlerts.js";
import { pruneStopWatch, runStopWatch } from "./stopWatch.js";
import { sendTelegram } from "./telegram.js";
import { listWatchlist } from "./watchlist.js";

/**
 * 관심종목 시그널 스케줄러.
 *
 * 장중에만 돈다. 장 끝난 뒤에 "급등했습니다"를 받아봐야 쓸모가 없고,
 * 밤새 같은 알림이 반복되면 그 방을 안 보게 된다.
 *
 * 검사 간격은 설정값(기본 10분)을 따르되 tick 자체는 1분마다 돌면서
 * "마지막 검사 후 간격이 지났나"만 본다. 설정을 바꿔도 재시작이 필요 없게.
 */

const TICK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
let lastScanAt = 0;
let scanning = false;

/** 한국 시각 기준 장중인가 — 09:00~15:30 평일 */
function isMarketHours(now = new Date()): boolean {
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  const day = kst.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = kst.getHours() * 60 + kst.getMinutes();
  return minutes >= 9 * 60 && minutes <= 15 * 60 + 30;
}

/**
 * 한 번 검사하고, 발동한 게 있으면 시그널 방으로 보낸다.
 * 수동 실행(설정 화면의 "지금 검사")도 이 함수를 쓴다.
 */
export async function runAlertScan(
  client: KiwoomClient,
  opts: { dryRun?: boolean; send?: boolean } = {},
): Promise<{ alerts: FiredAlert[]; sent: boolean; error?: string }> {
  const watch = await listWatchlist();
  const alerts = await scanAlerts(
    client,
    // 편입가까지 넘긴다 — 알림에 「내것」 줄을 적으려면 필요하다
    watch.map((w) => ({ code: w.code, name: w.name, addedPrice: w.addedPrice })),
    { dryRun: opts.dryRun },
  );
  if (alerts.length === 0) return { alerts, sent: false };

  if (opts.send === false) return { alerts, sent: false };

  const res = await sendTelegram(formatAlerts(alerts), "signal");
  return { alerts, sent: res.ok, error: res.error };
}

async function tick(client: KiwoomClient): Promise<void> {
  if (!isMarketHours()) return;

  /*
   * **손절 감시는 시그널 간격을 안 따른다.**
   *
   * 다른 시그널은 「봐라」는 말이라 10분 뒤에 봐도 손해가 안 난다. 그런데 손절선은
   * 내가 미리 정해 둔 규칙이고, 깨진 걸 10분 뒤에 알면 그만큼 더 잃는다.
   * 조회를 안 쓰고 실시간·스냅샷에 있는 값만 보므로 1분마다 돌려도 공짜다.
   *
   * `scanning` 잠금 **밖**에 둔다 — 시그널 검사가 오래 걸리는 동안 손절 감시가
   * 통째로 쉬면 안 된다.
   */
  pruneStopWatch();
  pruneLiveAlerts();
  try {
    const stop = await runStopWatch(client);
    if (stop.breaks.length > 0) {
      console.log(`[alert] 손절선 ${stop.breaks.length}건 — ${stop.breaks.map((b) => b.name).join(", ")}`);
      /* 이벤트 로그 — 브리핑 타임라인이 읽는다. 손절 이탈은 늘 「내 자리」라 watch 다 */
      void logEvents(
        stop.breaks.map((b) => ({
          kind: "stop" as const,
          code: b.code,
          name: b.name,
          summary: `손절선 ${b.stop.toLocaleString("ko-KR")} 이탈 — 지금 ${b.price.toLocaleString("ko-KR")} (${b.lossPct.toFixed(1)}%)`,
          watch: true,
        })),
      );
    }
  } catch (err) {
    console.error("[alert] 손절 감시 실패:", err instanceof Error ? err.message : err);
  }

  /*
   * VI·체결강도 급변도 조회를 안 쓴다 — 이미 물고 있는 실시간에서 꺼낸다.
   * VI 는 몇 초 뒤에 알면 이미 풀려 있으므로 10분 간격을 기다릴 수 없다.
   */
  try {
    const live = await runLiveAlerts();
    if (live.alerts.length > 0) {
      console.log(`[alert] 실시간 ${live.alerts.length}건 — ${live.alerts.map((a) => a.name).join(", ")}`);
      /*
       * 체결강도만 적는다. **VI 는 안 적는다** — 실시간 저장소가 전 종목 VI 를 이미
       * 들고 있어서(`getVi`) 타임라인이 거기서 직접 읽는다. 두 곳에 적으면 두 번 나온다.
       */
      void logEvents(
        live.alerts
          .filter((a) => a.kind === "strength")
          .map((a) => ({
            kind: "strength" as const,
            code: a.code,
            name: a.name,
            summary: a.detail,
            watch: true,
          })),
      );
    }
  } catch (err) {
    console.error("[alert] 실시간 알림 실패:", err instanceof Error ? err.message : err);
  }

  if (scanning) return;

  const cfg = await getAlertConfig();
  if (!cfg.enabled) return;
  if (Date.now() - lastScanAt < cfg.intervalMin * 60_000) return;

  scanning = true;
  lastScanAt = Date.now();
  try {
    const { alerts, sent, error } = await runAlertScan(client);
    if (alerts.length > 0) {
      console.log(`[alert] 시그널 ${alerts.length}건 ${sent ? "발송" : `발송 실패: ${error}`}`);
      /* 시그널도 타임라인에 — 규칙 이름이 곧 배지다. 관심종목만 검사하므로 전부 watch */
      void logEvents(
        alerts.map((a) => ({
          kind: "signal" as const,
          rule: a.ruleLabel,
          code: a.code,
          name: a.name,
          summary: a.detail,
          watch: true,
        })),
      );
    }
  } catch (err) {
    // 시그널 실패가 서버를 죽이면 안 된다. 다음 tick에서 다시 시도한다.
    console.error("[alert] 검사 실패:", err instanceof Error ? err.message : err);
  } finally {
    scanning = false;
  }
}

export function startAlertScheduler(client: KiwoomClient): void {
  if (timer) return;
  timer = setInterval(() => void tick(client), TICK_MS);
  console.log("[alert] 관심종목 시그널 · 손절 감시 스케줄러 시작 (장중 09:00~15:30)");
}
