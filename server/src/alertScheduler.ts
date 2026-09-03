import { formatAlerts, getAlertConfig, scanAlerts, type FiredAlert } from "./alertRules.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { logEvents } from "./eventLog.js";
import { pruneLiveAlerts, runLiveAlerts } from "./liveAlerts.js";
import { pruneStopWatch, runStopWatch } from "./stopWatch.js";
import { getActiveSuper } from "./superSignal.js";
import { hasDedicatedChannel, sendTelegram } from "./telegram.js";
import { pushNotice, stockLink } from "./notifyCenter.js";
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

  /*
   * 슈퍼신호등 전용 방이 있으면 슈퍼 종목 건은 그 방으로 (2026-08-26) —
   * 슈퍼 방이 그 종목들의 이벤트 허브다. 묶음 메시지라 종목 단위로 갈라 보낸다.
   */
  let superCodes = new Set<string>();
  if (hasDedicatedChannel("super")) {
    const list = await getActiveSuper().catch(() => [] as { code: string }[]);
    superCodes = new Set(list.map((s) => s.code));
  }
  const superOnes = alerts.filter((a) => superCodes.has(a.code));
  const rest = alerts.filter((a) => !superCodes.has(a.code));

  /*
   * ## **알림 센터에도 남긴다** (2026-09-02)
   *
   * 벤티지: "알림센터 전용 설정 메뉴 좀 만들어줄래?"
   *
   * 만들면서 보니 **관심종목 급변은 텔레그램으로만 가고 있었다.** 알림 센터에는
   * 한 줄도 안 남는다 — 텔레그램을 놓치면 그 신호는 영영 못 본다.
   *
   * 텔레그램은 자리를 비운 사이에 오고 알림 센터는 화면에 남는다. 서로를
   * 대신하지 못한다(마감 뒤 정리·캘린더와 같은 이유).
   *
   * **한 줄로 묶는다.** 종목마다 따로 넣으면 급변이 몰리는 날 알림함이 수십 줄로
   * 덮인다 — 텔레그램 메시지가 한 통인 것과 같은 이유다. 종목 이름만 나열하고
   * 자세한 것은 눌러서 본다.
   */
  if (alerts.length > 0) {
    const head = alerts
      .slice(0, 6)
      .map((a) => `${a.name} ${a.ruleLabel}`)
      .join(" · ");
    await pushNotice({
      source: "stockSignal",
      kind: "stock",
      level: "info",
      title: `관심종목 시그널 ${alerts.length}건`,
      body: head + (alerts.length > 6 ? ` 외 ${alerts.length - 6}건` : ""),
      /* 관심종목 탭 키는 `watchAi` 다 — 옛 `#/watchlist` 는 없는 탭이라 눌러도 아무 일이 없었다 (2026-09-03) */
      link: alerts.length === 1 ? stockLink(alerts[0].code, alerts[0].name) : "#/watchAi",
      /* 같은 종목·같은 규칙이 이어지면 한 줄에 겹친다 — 5분마다 도는 자리다 */
      dedupeKey: `stockSignal:${alerts.map((a) => `${a.code}:${a.rule}`).sort().join(",")}`,
      dedupeHours: 2,
    }).catch(() => undefined);
  }

  let ok = true;
  let error: string | undefined;
  if (superOnes.length > 0) {
    const r = await sendTelegram(formatAlerts(superOnes), "super");
    ok = ok && r.ok;
    error = error ?? r.error;
  }
  if (rest.length > 0) {
    const r = await sendTelegram(formatAlerts(rest), "signal");
    ok = ok && r.ok;
    error = error ?? r.error;
  }
  return { alerts, sent: ok, error };
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
