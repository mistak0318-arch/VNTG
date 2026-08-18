import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchNewMessages, isReaderConfigured, type ChannelMessage } from "./telegramReader.js";
import { listWatchlist } from "./watchlist.js";
import { listThemes } from "./customThemes.js";
import { sendTelegram } from "./telegram.js";
import { hhmmKst } from "./telegramDigest.js";

/**
 * 내 관심 키워드 — 걸리면 바로 알린다.
 *
 * 「동향」은 **모아서 정리하는** 자리다. 여러 채널이 겹친 주제를 뽑아 하루 몇 번 보낸다.
 * 그런데 내 종목 얘기가 한 채널에만 떠도 그건 알아야 한다 — 겹치기를 기다리면 늦는다.
 * 그래서 이건 **거르지 않고 곧바로** 보낸다. 성격이 반대라 따로 둔다.
 *
 * 키워드는 세 곳에서 온다.
 *   관심종목(AI_HTS) 이름 — 이미 담아 둔 것을 또 적을 이유가 없다
 *   내 테마 이름         — 테마 자체가 언급되는 것도 신호다
 *   직접 등록            — 종목이 아닌 것(정책·인물·제품명)은 손으로 적어야 한다
 *
 * **같은 메시지를 두 번 보내지 않는다.** 보낸 것의 키를 남겨 둔다 — 알림이 중복되면
 * 그때부터 안 보게 되고, 그러면 기능이 없는 것과 같다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "keywordAlert.json");

export const INTERVAL_CHOICES = [3, 5, 10, 20, 30, 60];

export interface KeywordConfig {
  enabled: boolean;
  /** 몇 분마다 훑을지 */
  intervalMin: number;
  /** 직접 등록한 키워드 */
  keywords: string[];
  /** 관심종목(AI_HTS) 이름을 키워드로 쓸지 */
  useWatchlist: boolean;
  /** 내 테마 이름을 키워드로 쓸지 */
  useThemes: boolean;
  /** 장중에만 돌릴지 */
  weekdayOnly: boolean;
  startHour: number;
  endHour: number;
  /** 한 번에 보낼 최대 건수 — 쏟아지면 안 읽는다 */
  maxPerRun: number;
}

export const DEFAULT_CONFIG: KeywordConfig = {
  enabled: false,
  intervalMin: 10,
  keywords: [],
  useWatchlist: true,
  useThemes: false,
  weekdayOnly: true,
  startHour: 8,
  endHour: 20,
  maxPerRun: 8,
};

interface Store {
  config: KeywordConfig;
  /** 이미 보낸 메시지 키 — 중복 발송을 막는다 */
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
  // 보낸 키는 최근 것만 — 무한히 쌓을 이유가 없다
  await writeFile(FILE, JSON.stringify({ ...s, sent: s.sent.slice(-800) }, null, 2), "utf-8");
}

export async function getConfig(): Promise<KeywordConfig> {
  return (await read()).config;
}

export async function saveConfig(input: Partial<KeywordConfig>): Promise<KeywordConfig> {
  const s = await read();
  const interval = Number(input.intervalMin ?? s.config.intervalMin);
  s.config = {
    ...s.config,
    ...input,
    intervalMin: INTERVAL_CHOICES.includes(interval) ? interval : 10,
    // 너무 짧은 키워드는 아무 데나 걸린다 — "LG" 하나로 온 채널이 다 걸린다
    keywords: (input.keywords ?? s.config.keywords)
      .map((k) => k.trim())
      .filter((k) => k.length >= 2)
      .slice(0, 100),
    maxPerRun: Math.min(Math.max(Number(input.maxPerRun ?? s.config.maxPerRun), 1), 30),
    startHour: Math.min(Math.max(Number(input.startHour ?? s.config.startHour), 0), 23),
    endHour: Math.min(Math.max(Number(input.endHour ?? s.config.endHour), 1), 24),
  };
  await write(s);
  return s.config;
}

/** 지금 쓰이는 키워드 전체 — 어디서 왔는지 함께 */
export async function resolveKeywords(
  cfg?: KeywordConfig,
): Promise<{ word: string; from: "직접" | "관심종목" | "내 테마" }[]> {
  const c = cfg ?? (await getConfig());
  const out: { word: string; from: "직접" | "관심종목" | "내 테마" }[] = [];
  const seen = new Set<string>();
  const push = (word: string, from: "직접" | "관심종목" | "내 테마") => {
    const w = word.trim();
    if (w.length < 2 || seen.has(w)) return;
    seen.add(w);
    out.push({ word: w, from });
  };

  for (const k of c.keywords) push(k, "직접");
  if (c.useWatchlist) for (const w of await listWatchlist().catch(() => [])) push(w.name, "관심종목");
  if (c.useThemes) for (const t of await listThemes().catch(() => [])) push(t.name, "내 테마");

  /*
   * **긴 것부터** 돌려준다.
   *
   * 안 그러면 "반도체"가 먼저 걸리고 "반도체 소부장 (후공정)"이 또 걸려서 한 메시지에
   * 두 키워드가 붙는다. 아래 matchMessage 의 중복 제거는 "이미 잡힌 것에 포함되면 건너뛴다"
   * 인데, 그게 성립하려면 긴 것이 먼저 와야 한다.
   */
  return out.sort((a, b) => b.word.length - a.word.length);
}

function withinWindow(c: KeywordConfig, now = new Date()): boolean {
  const kst = new Date(now.getTime() + 9 * 3600_000);
  if (c.weekdayOnly && (kst.getUTCDay() === 0 || kst.getUTCDay() === 6)) return false;
  const h = kst.getUTCHours();
  return h >= c.startHour && h < c.endHour;
}

export interface KeywordHit {
  /** 채널+메시지 — 중복 판정 키 */
  key: string;
  channelName: string;
  at: string;
  text: string;
  link: string;
  /** 걸린 키워드들 */
  words: string[];
}

function keyOf(m: ChannelMessage): string {
  // 채널 안에서 messageId 는 유일하다. 링크가 없는 비공개 채널도 이걸로 갈린다
  return `${m.channelId}|${m.messageId}`;
}

/** 메시지에서 걸린 키워드를 찾는다 */
export function matchMessage(
  text: string,
  words: { word: string; from: string }[],
): string[] {
  const hits: string[] = [];
  for (const w of words) {
    if (!text.includes(w.word)) continue;
    // 이미 잡힌 더 긴 키워드에 포함되면 중복이다 (삼성전자 / 삼성전자우)
    if (hits.some((h) => h.includes(w.word))) continue;
    hits.push(w.word);
  }
  return hits;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * 알림 한 건의 모양.
 *
 * 「동향」 발송과 같은 얼개를 쓴다 — 줄머리 아이콘으로 종류를 가르고, 원문으로 갈 링크를 단다.
 * 다만 **걸린 키워드를 맨 위에 둔다.** 왜 이게 나한테 왔는지가 먼저 보여야 한다.
 */
function toMessage(h: KeywordHit): string {
  const head = [
    `🔔 <b>${esc(h.words.join(", "))}</b>`,
    `📡 ${esc(h.channelName)} · ${hhmmKst(h.at)}`,
  ].join("\n");
  const body = esc(h.text.replace(/\n{3,}/g, "\n\n").slice(0, 700));
  const link = h.link ? `\n\n🔗 <a href="${h.link}">원문 보기 →</a>` : "";
  return `${head}\n━━━━━━━━━━━━\n${body}${link}`;
}

export interface RunResult {
  scanned: number;
  matched: number;
  sent: number;
  /** 이미 보낸 것이라 건너뛴 수 */
  skipped: number;
  hits: KeywordHit[];
  error?: string;
}

/**
 * 한 번 훑는다.
 *
 * @param send 실제로 텔레그램에 보낼지. 화면에서 미리 볼 때는 false.
 * @param force 시간창·주기를 무시하고 돈다 (사용자가 버튼을 눌렀을 때)
 */
export async function runKeywordScan(
  opts: { send?: boolean; force?: boolean; sinceMinutes?: number } = {},
): Promise<RunResult> {
  const { send = false, force = false } = opts;
  const store = await read();
  const cfg = store.config;
  const empty: RunResult = { scanned: 0, matched: 0, sent: 0, skipped: 0, hits: [] };

  if (!isReaderConfigured()) return { ...empty, error: "텔레그램 세션 미설정" };
  if (!force && !cfg.enabled) return { ...empty, error: "꺼져 있습니다" };
  if (!force && !withinWindow(cfg)) return { ...empty, error: "발송 시간대가 아닙니다" };

  const words = await resolveKeywords(cfg);
  if (words.length === 0) return { ...empty, error: "등록된 키워드가 없습니다" };

  /*
   * 훑는 구간은 **주기보다 넉넉히** 잡는다. 정확히 주기만큼만 보면 경계에 걸친 메시지를
   * 놓친다. 중복은 sent 키로 막으므로 겹쳐 보는 게 안전하다.
   */
  const sinceMinutes = opts.sinceMinutes ?? cfg.intervalMin * 2;
  const { messages } = await fetchNewMessages({ sinceMinutes, useOffsets: false });

  const sent = new Set(store.sent);
  const hits: KeywordHit[] = [];
  let skipped = 0;

  for (const m of messages) {
    const matched = matchMessage(m.text, words);
    if (matched.length === 0) continue;
    const key = keyOf(m);
    if (sent.has(key)) {
      skipped += 1;
      continue;
    }
    hits.push({
      key,
      channelName: m.channelName,
      at: m.at,
      text: m.text,
      link: m.link,
      words: matched,
    });
  }

  // 최신순으로 보여 주고, 한 번에 너무 많이 보내지 않는다
  hits.sort((a, b) => b.at.localeCompare(a.at));
  const picked = hits.slice(0, cfg.maxPerRun);

  let sentCount = 0;
  if (send) {
    for (const h of picked) {
      /*
       * 키워드 알림은 **따로 받는 방**으로 보낸다.
       *
       * 「구독 채널 요약」과 같은 방을 쓰고 있었는데, 성격이 다르다 — 채널 요약은 하루
       * 몇 번 몰아 읽는 것이고 키워드는 뜨는 즉시 봐야 하는 것이다. 한 방에 섞이면
       * 급한 게 묻힌다. TELEGRAM_CHAT_ID_KEYWORD 가 없으면 예전처럼 기본 방으로 간다.
       */
      await sendTelegram(toMessage(h), "keyword").catch(() => undefined);
      store.sent.push(h.key);
      sentCount += 1;
      await new Promise((r) => setTimeout(r, 400));
    }
    store.lastRunAt = new Date().toISOString();
    await write(store);
  }

  return {
    scanned: messages.length,
    matched: hits.length,
    sent: sentCount,
    skipped,
    hits: picked,
  };
}

// ---------------------------------------------------------------- 스케줄러

let busy = false;
let lastAt = 0;

/** 설정한 주기로 돈다. 서버 시작 때 한 번 걸어 둔다 */
export function startKeywordScheduler(): void {
  const tick = async () => {
    if (busy) return;
    const cfg = await getConfig();
    if (!cfg.enabled || !isReaderConfigured()) return;
    if (!withinWindow(cfg)) return;
    if (Date.now() - lastAt < cfg.intervalMin * 60_000) return;

    busy = true;
    try {
      const r = await runKeywordScan({ send: true });
      lastAt = Date.now();
      if (r.sent > 0) {
        console.log(`[keyword] ${r.sent}건 발송 (원본 ${r.scanned} · 걸림 ${r.matched})`);
      }
    } catch (err) {
      console.error("[keyword] 실패:", err instanceof Error ? err.message : err);
    } finally {
      busy = false;
    }
  };
  setTimeout(() => void tick(), 60_000);
  setInterval(() => void tick(), 60_000);
  console.log("[keyword] 관심 키워드 스캐너 시작");
}
