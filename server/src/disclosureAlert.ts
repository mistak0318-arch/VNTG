import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { todayDartEvents, type DartEvent } from "./dartEvents.js";
import { sendTelegram, stockNameHtml } from "./telegram.js";
import { pushNotice, stockLink } from "./notifyCenter.js";
import { superRoute } from "./superSignal.js";

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
  /*
   * ⚠️ **내 테마(태그) 갈래는 없앴다** (2026-09-02).
   *
   * 벤티지: "태그에 전체 테마 같은 걸 넣을 텐데 전체를 다 받을 수는 없지."
   *
   * 태그는 원래 「묶어서 보려고」 만든 것이라 크기에 제한이 없다. 업종 하나를
   * 통째로 담은 태그가 하나만 있어도 그 업종 공시가 전부 알림이 된다 —
   * 관심종목은 손으로 담은 수십 개지만 태그는 그렇지 않다.
   *
   * 「보낼지 말지」를 설정으로 두지 않고 갈래를 아예 지운 이유는, 꺼 두더라도
   * 나중에 누가 켜면 같은 일이 되풀이되기 때문이다. 공시는 관심종목과 중요도,
   * 두 자로만 고른다.
   */
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
function shouldSend(e: DartEvent, c: DisclosureAlertConfig): "관심종목" | "중요" | null {
  if (c.watchedOnly && e.watched) return "관심종목";
  /* 내 테마(태그) 갈래는 없앴다 — 위 `DisclosureAlertConfig` 주석 참고 */
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
  const tag = reason === "관심종목" ? "⭐ 관심종목" : "🔥 주요 공시";
  // 종목코드가 있으면 회사명이 개별종목분석 딥링크가 된다 (HTS_WEB_URL 설정 시)
  const nameHtml = e.stockCode
    ? stockNameHtml(e.stockCode, e.corpName)
    : `<b>${esc(e.corpName)}</b>`;
  const head = [
    `📄 <b>${tag}</b>`,
    `${nameHtml} · ${e.market}${e.amended ? " · 정정" : ""}`,
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
      /* 슈퍼신호등 종목의 공시는 슈퍼 전용 방으로 (전용 방이 있을 때만) */
      const ch = h.event.stockCode
        ? await superRoute(h.event.stockCode, "disclosure").catch(() => "disclosure" as const)
        : ("disclosure" as const);
      await sendTelegram(toMessage(h.event, h.reason), ch).catch(() => undefined);
      store.sent.push(h.event.url.split("rcpNo=")[1] ?? h.event.url);
      sentCount += 1;
      await new Promise((r) => setTimeout(r, 400));
    }
    /*
     * ## **알림 센터에도 남긴다** (2026-09-02)
     *
     * 공시도 텔레그램으로만 가고 있었다 — 알림 센터에는 한 줄도 안 남는다.
     * 공시는 뉴스보다 빠르고 확실한 신호라 놓치면 손해가 큰데, 텔레그램을
     * 못 보면 그걸로 끝이었다.
     *
     * **한 줄로 묶는다.** 공시가 몰리는 날 종목마다 넣으면 알림함이 덮인다 —
     * 종목 이름만 나열하고 자세한 것은 눌러서 본다.
     */
    if (picked.length > 0) {
      /*
       * ## 제목이 **이유를 그대로** 말해야 한다 (2026-09-02)
       *
       * 벤티지: "내 관심종목에는 SNT에너지가 없는데 관심종목 공시 떴다고 알람이 오네."
       *
       * 여기 제목이 `관심종목 공시` 로 **박혀 있었다.** 그런데 `shouldSend` 는 세
       * 가지 이유로 고른다 — 관심종목·내 테마·중요도. 텔레그램 쪽(`toMessage`)은
       * ⭐🎯🔥 로 이유를 구분해 보내는데 알림 센터만 전부 「관심종목」이라고 했다.
       *
       * 그래서 태그에 걸려 잡힌 종목이 관심종목으로 둔갑했고, 받는 사람은 자기
       * 관심종목 목록을 의심하게 된다 — **알림이 틀린 곳을 가리키면 없느니만 못하다.**
       * 이유가 섞였으면 어느 하나로 뭉뚱그리지 않고 그냥 「공시」라고 한다.
       */
      const TAG: Record<string, string> = { 관심종목: "⭐", 중요: "🔥" };
      const reasons = [...new Set(picked.map((h) => h.reason))];
      const head = picked
        .slice(0, 6)
        .map((h) => `${TAG[h.reason] ?? ""}${h.event.corpName} ${h.event.title}`)
        .join(" · ");
      await pushNotice({
        source: "disclosure",
        kind: "stock",
        level: "info",
        title:
          reasons.length === 1
            ? `${reasons[0]} 공시 ${picked.length}건`
            : `공시 ${picked.length}건`,
        body: head.slice(0, 300) + (picked.length > 6 ? ` 외 ${picked.length - 6}건` : ""),
        /*
         * **한 종목이면 그 종목으로** (2026-09-04 — 벤티지: "공시 같은 알람은 바로가기
         * 누르면 이상한 데로 가네").
         *
         * 여태 무조건 「뉴스·공시」 탭으로 보냈다. 탭 이름은 맞았지만 **아무 맥락도
         * 안 실려 있었다** — 「⭐한미사이언스 유상증자」를 눌렀는데 뉴스 탭 첫 화면이
         * 뜨고, 거기서 다시 종목을 찾아야 했다. 알림이 데려다 놓는 자리는 「그 소식」이라야
         * 한다. 목록의 첫 화면은 그 소식이 아니다.
         *
         * 여럿이면 뉴스·공시 탭이 맞다 — 한 종목으로 데려가면 나머지가 숨는다.
         */
        ...(() => {
          const codes = [...new Set(picked.map((h) => h.event.stockCode).filter(Boolean))];
          const one = codes.length === 1 ? picked.find((h) => h.event.stockCode)! : null;
          return one
            ? { link: stockLink(one.event.stockCode!, one.event.corpName), code: one.event.stockCode!, name: one.event.corpName }
            : { link: "#/news" };
        })(),
        dedupeKey: `disclosure:${picked.map((h) => h.event.url).sort().join(",").slice(0, 200)}`,
        dedupeHours: 6,
      }).catch(() => undefined);
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
