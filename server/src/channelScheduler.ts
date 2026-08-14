import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildChannelReport,
  toPickedHeader,
  toPickedHtml,
  toPickedMessages,
} from "./channelReport.js";
import { getChannelConfig, withinWindow } from "./channelConfig.js";
import { sendMail } from "./mailer.js";
import { sendTelegram } from "./telegram.js";
import { isReaderConfigured } from "./telegramReader.js";

/**
 * 구독 채널 요약 정기 발행.
 *
 * 리포트와 같은 07/12/18시에 낸다. 다만 리포트 스케줄러에 얹지 않고 따로 돈다 —
 * 한쪽이 실패했다고 다른 쪽까지 못 나가면 안 되고, 채널 요약은 주말에도 의미가 있어서다
 * (주말에도 채널은 돌아가고, 월요일 장에 반영될 이야기가 미리 나온다).
 *
 * 수집 구간은 **지난 발행 이후**로 잡는다. 고정 12시간으로 하면
 * 발행이 한 번 밀렸을 때 그 사이 메시지를 통째로 놓친다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const STATE_FILE = join(DATA_DIR, "channelSchedule.json");

const TICK_MS = 60_000;

/** 리포트와 같은 시각 */
export const CHANNEL_EDITIONS = [
  { key: "morning", hour: 7, label: "조간" },
  { key: "midday", hour: 12, label: "장중" },
  { key: "evening", hour: 18, label: "석간" },
] as const;

export type ChannelEditionKey = (typeof CHANNEL_EDITIONS)[number]["key"];

interface ScheduleState {
  /** `YYYY-MM-DD|edition` → 발행 시각 ISO */
  published: Record<string, string>;
  /** 마지막 발행 시각 — 다음 수집 구간의 시작점 */
  lastRunAt?: string;
}

let timer: ReturnType<typeof setInterval> | null = null;
/** 선별 자동 발송을 마지막으로 보낸 시각 */
let lastPickAt = 0;
let pickBusy = false;

/**
 * 선별 자동 발송.
 *
 * AI를 쓰지 않으므로 **토큰 비용이 0**이다. 그래서 자주 돌려도 되는데, 관건은 텔레그램
 * 호출량이었다 — getDialogs 로 새 글이 있는 채널만 읽도록 바꾼 뒤로는 5분 주기도 감당된다.
 *
 * 오프셋을 쓴다(useOffsets=true). 5분마다 같은 메시지를 다시 보내면 알림이 무의미해지므로
 * **지난번 이후 새로 온 것만** 보내야 한다.
 */
async function tickPickAuto(): Promise<void> {
  if (pickBusy) return;
  const { pickAuto: cfg } = await getChannelConfig();
  if (!cfg.enabled || !isReaderConfigured()) return;
  if (!withinWindow(cfg)) return;
  if (Date.now() - lastPickAt < cfg.intervalMin * 60_000) return;

  pickBusy = true;
  try {
    const report = await buildChannelReport({
      useAi: false,
      send: false, // 발송은 아래에서 설정대로 나눠 보낸다
      sinceMinutes: cfg.windowHours * 60,
      useOffsets: true,
    });
    lastPickAt = Date.now();

    // 새로 걸린 게 없으면 조용히 넘어간다 — 빈 알림이 오면 그때부터 안 보게 된다
    if (report.items.length === 0) return;

    /*
     * 텔레그램은 **건별로** 보낸다. 25건을 한 덩어리로 붙이면 벽이 되어 읽히지 않고,
     * 원문으로 갈 방법도 없다. 머리글(채널·시각) + 본문 + 원문 링크로 하나씩 보낸다.
     * 연달아 쏘면 텔레그램이 막으므로 사이에 간격을 둔다.
     */
    if (cfg.telegram) {
      await sendTelegram(toPickedHeader(report), "channel").catch(() => undefined);
      for (const msg of toPickedMessages(report, 15)) {
        await sendTelegram(msg, "channel").catch(() => undefined);
        await new Promise((r) => setTimeout(r, 400));
      }
    }
    const html = toPickedHtml(report);
    if (cfg.mail) {
      // 텔레그램 HTML 은 줄바꿈이 그대로지만 메일은 <br/> 이어야 한다
      const mailHtml = html.replace(/\n/g, "<br/>");
      await sendMail(`[VNTG] 채널 선별 ${report.usedCount}건`, mailHtml).catch(() => undefined);
    }
    console.log(`[channel] 선별 자동 발송 ${report.usedCount}건 (원본 ${report.rawCount})`);
  } catch (err) {
    console.error("[channel] 선별 자동 발송 실패:", err instanceof Error ? err.message : err);
  } finally {
    pickBusy = false;
  }
}
let running = false;

async function readState(): Promise<ScheduleState> {
  try {
    const parsed = JSON.parse(await readFile(STATE_FILE, "utf-8")) as ScheduleState;
    return { published: parsed.published ?? {}, lastRunAt: parsed.lastRunAt };
  } catch {
    return { published: {} };
  }
}

async function writeState(s: ScheduleState): Promise<void> {
  // 기록이 무한히 커지지 않게 최근 30일치만
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const published: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.published)) {
    if (k.slice(0, 10) >= cutoff) published[k] = v;
  }
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STATE_FILE, JSON.stringify({ ...s, published }, null, 2), "utf-8");
}

/** 한국 시각 기준 오늘 날짜와 시 */
function kstNow(now = new Date()): { date: string; hour: number } {
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  const date = `${kst.getFullYear()}-${String(kst.getMonth() + 1).padStart(2, "0")}-${String(
    kst.getDate(),
  ).padStart(2, "0")}`;
  return { date, hour: kst.getHours() };
}

/**
 * 마지막 발행 이후 몇 시간이 지났는지.
 * 처음 돌리는 거면 12시간으로 시작하고, 너무 오래 쉬었으면 72시간으로 자른다
 * (며칠 치를 한꺼번에 끌어오면 AI 비용이 터진다).
 */
/** 마지막 발행 이후 지난 만큼을 훑는다. 첫 실행이면 12시간 */
function sinceMinutesFrom(lastRunAt?: string): number {
  if (!lastRunAt) return 12 * 60;
  const minutes = (Date.now() - new Date(lastRunAt).getTime()) / 60_000;
  return Math.min(Math.max(Math.ceil(minutes), 5), 72 * 60);
}

async function tick(): Promise<void> {
  if (running) return;
  // 세션이 없으면 아무것도 하지 않는다. 여기서 발행 기록을 남기면
  // 나중에 로그인해도 그날치는 영영 안 나온다.
  if (!isReaderConfigured()) return;

  const { date, hour } = kstNow();
  const state = await readState();

  for (const e of CHANNEL_EDITIONS) {
    if (hour < e.hour) continue;
    const key = `${date}|${e.key}`;
    if (state.published[key]) continue;

    running = true;
    try {
      const report = await buildChannelReport({
        send: true,
        useAi: true,
        sinceMinutes: sinceMinutesFrom(state.lastRunAt),
      });

      if (report.summary) {
        console.log(
          `[channel] ${date} ${e.label} 발행 — 원본 ${report.rawCount}건 → 선별 ${report.usedCount}건 (토큰 ${report.inputTokens}/${report.outputTokens})`,
        );
      } else {
        console.log(`[channel] ${date} ${e.label} 건너뜀 — ${report.error ?? "요약 없음"}`);
      }

      // 요약이 안 나왔어도 발행 시도는 했다고 기록한다.
      // 안 그러면 1분마다 계속 재시도하면서 채널을 계속 읽는다.
      state.published[key] = new Date().toISOString();
      state.lastRunAt = new Date().toISOString();
      await writeState(state);
    } catch (err) {
      console.error("[channel] 발행 실패:", err instanceof Error ? err.message : err);
    } finally {
      running = false;
    }
    break; // 한 번에 한 판만
  }
}

export function startChannelScheduler(): void {
  if (timer) return;
  // 서버가 막 뜬 직후엔 텔레그램 연결이 아직이므로 조금 기다린다
  setTimeout(() => {
    void tick();
    void tickPickAuto();
  }, 45_000);
  timer = setInterval(() => {
    void tick();
    void tickPickAuto();
  }, TICK_MS);
  console.log("[channel] 구독 채널 스케줄러 시작 (AI 정리 07/12/18시 · 선별 자동발송은 설정에 따름)");
}
