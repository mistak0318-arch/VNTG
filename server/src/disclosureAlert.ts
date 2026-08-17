import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { todayDartEvents, type DartEvent } from "./dartEvents.js";
import { sendTelegram } from "./telegram.js";

/**
 * 관심종목 공시 알림.
 *
 * 공시는 **뉴스보다 빠르고 확실하다.** 유상증자·수주·실적은 기사로 나오기 전에 DART 에
 * 먼저 뜬다. 그런데 하루 2,000건이 쏟아지니 사람이 지켜볼 수가 없다.
 *
 * 「오늘 공시」 화면이 이미 내 종목만 걸러 내고 있으므로 그 판정을 그대로 쓴다 —
 * 같은 기준을 두 곳에 적으면 언젠가 어긋난다.
 *
 * DART 는 인증키당 하루 20,000건이다. 5분마다 돌려도 하루 1,152회(4호출 × 288)라
 * 6% 밖에 안 쓴다. 한도는 걱정할 게 아니다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "disclosureAlert.json");

export const INTERVAL_CHOICES = [5, 10, 15, 30, 60];

export interface DisclosureAlertConfig {
  enabled: boolean;
  intervalMin: number;
  /** 관심종목 공시를 보낼지 */
  watchedOnly: boolean;
  /** 내 테마 종목 공시도 보낼지 */
  includeThemes: boolean;
  /**
   * 내 종목이 아니어도 이 중요도 이상이면 보낸다. 0 이면 안 보낸다.
   * 상장폐지·유상증자 같은 건 남의 종목이라도 시장 전체에 영향이 있다.
   */
  marketWeightMin: number;
  weekdayOnly: boolean;
  startHour: number;
  endHour: number;
  maxPerRun: number;
}

export const DEFAULT_CONFIG: DisclosureAlertConfig = {
  enabled: false,
  intervalMin: 10,
  watchedOnly: true,
  includeThemes: true,
  marketWeightMin: 0,
  weekdayOnly: true,
  startHour: 8,
  endHour: 19,
  maxPerRun: 10,
};

interface Store {
  config: DisclosureAlertConfig;
  /** 이미 보낸 공시 접수번호 — 중복 발송을 막는다 */
  sent: string[];
  lastRunAt?: string;
}

async function read(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    return {
      config: { ...DEFAULT_CONFIG, ...(raw.config ?? {}) },
      sent: Array.isArray(raw.sent) ? raw.sent : [],
      lastRunAt: raw.lastRunAt,
    };
  } catch {
    return { config: DEFAULT_CONFIG, sent: [] };
  }
}

async function write(s: Store): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify({ ...s, sent: s.sent.slice(-1500) }, null, 2), "utf-8");
}

export async function getConfig(): Promise<DisclosureAlertConfig> {
  return (await read()).config;
}

export async function saveConfig(
  input: Partial<DisclosureAlertConfig>,
): Promise<DisclosureAlertConfig> {
  const s = await read();
  const interval = Number(input.intervalMin ?? s.config.intervalMin);
  s.config = {
    ...s.config,
    ...input,
    intervalMin: INTERVAL_CHOICES.includes(interval) ? interval : 10,
    marketWeightMin: Math.min(Math.max(Number(input.marketWeightMin ?? s.config.marketWeightMin), 0), 10),
    maxPerRun: Math.min(Math.max(Number(input.maxPerRun ?? s.config.maxPerRun), 1), 30),
    startHour: Math.min(Math.max(Number(input.startHour ?? s.config.startHour), 0), 23),
    endHour: Math.min(Math.max(Number(input.endHour ?? s.config.endHour), 1), 24),
  };
  await write(s);
  return s.config;
}

function withinWindow(c: DisclosureAlertConfig, now = new Date()): boolean {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  if (c.weekdayOnly && (kst.getUTCDay() === 0 || kst.getUTCDay() === 6)) return false;
  const h = kst.getUTCHours();
  return h >= c.startHour && h < c.endHour;
}

/** 이 공시를 나한테 보낼 이유가 있나 */
function shouldSend(e: DartEvent, c: DisclosureAlertConfig): "관심종목" | "내 테마" | "중요" | null {
  if (c.watchedOnly && e.watched) return "관심종목";
  if (c.includeThemes && e.themes.length > 0) return "내 테마";
  if (c.marketWeightMin > 0 && e.weight >= c.marketWeightMin) return "중요";
  return null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 알림 한 건.
 *
 * **왜 나한테 왔는지를 맨 위에** 둔다 — 관심종목이라서인지, 테마가 걸려서인지,
 * 시장 전체에 중요해서인지에 따라 읽는 무게가 다르다.
 */
function toMessage(e: DartEvent, reason: string): string {
  const tag =
    reason === "관심종목" ? "⭐ 관심종목" : reason === "내 테마" ? `🎯 ${e.themes[0]}` : "🔥 주요 공시";
  const head = [
    `📄 <b>${tag}</b>`,
    `<b>${esc(e.corpName)}</b> · ${e.market}${e.amended ? " · 정정" : ""}`,
  ].join("\n");
  return `${head}\n━━━━━━━━━━━━\n${esc(e.title)}\n\n🔗 <a href="${e.url}">DART 원문 →</a>`;
}

export interface DisclosureRunResult {
  scanned: number;
  matched: number;
  sent: number;
  skipped: number;
  hits: { event: DartEvent; reason: string }[];
  error?: string;
}

export async function runDisclosureScan(
  opts: { send?: boolean; force?: boolean } = {},
): Promise<DisclosureRunResult> {
  const { send = false, force = false } = opts;
  const store = await read();
  const c = store.config;
  const empty: DisclosureRunResult = { scanned: 0, matched: 0, sent: 0, skipped: 0, hits: [] };

  if (!force && !c.enabled) return { ...empty, error: "꺼져 있습니다" };
  if (!force && !withinWindow(c)) return { ...empty, error: "발송 시간대가 아닙니다" };

  // 「오늘 공시」와 같은 판정을 쓴다. force 로 캐시를 무시해야 새 공시가 잡힌다
  const { events } = await todayDartEvents(true);
  const sent = new Set(store.sent);
  const hits: { event: DartEvent; reason: string }[] = [];
  let skipped = 0;

  for (const e of events) {
    const reason = shouldSend(e, c);
    if (!reason) continue;
    // 접수번호가 곧 공시의 고유 키다 (url 끝에 들어 있다)
    const key = e.url.split("rcpNo=")[1] ?? e.url;
    if (sent.has(key)) {
      skipped += 1;
      continue;
    }
    hits.push({ event: e, reason });
  }

  const picked = hits.slice(0, c.maxPerRun);
  let sentCount = 0;
  if (send) {
    for (const h of picked) {
      await sendTelegram(toMessage(h.event, h.reason), "disclosure").catch(() => undefined);
      store.sent.push(h.event.url.split("rcpNo=")[1] ?? h.event.url);
      sentCount += 1;
      await new Promise((r) => setTimeout(r, 400));
    }
    store.lastRunAt = new Date().toISOString();
    await write(store);
  }

  return { scanned: events.length, matched: hits.length, sent: sentCount, skipped, hits: picked };
}

// ---------------------------------------------------------------- 스케줄러

let busy = false;
let lastAt = 0;

export function startDisclosureScheduler(): void {
  const tick = async () => {
    if (busy) return;
    const c = await getConfig();
    if (!c.enabled) return;
    if (!withinWindow(c)) return;
    if (Date.now() - lastAt < c.intervalMin * 60_000) return;

    busy = true;
    try {
      const r = await runDisclosureScan({ send: true });
      lastAt = Date.now();
      if (r.sent > 0) console.log(`[disclosure] ${r.sent}건 발송 (전체 ${r.scanned})`);
    } catch (err) {
      console.error("[disclosure] 실패:", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  setTimeout(() => void tick(), 90_000);
  setInterval(() => void tick(), 60_000);
  console.log("[disclosure] 관심종목 공시 감시 시작");
}
