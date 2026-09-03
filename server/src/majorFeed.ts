import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fetchNewMessages, isReaderConfigured, listChannels } from "./telegramReader.js";
import type { ChannelMessage } from "./telegramReader.js";

/**
 * 주요 채널 피드 (2026-08-27) — **골라 둔 채널의 글은 빠짐없이, 원문 그대로.**
 *
 * 동향(digest)은 AI 가 고르고 줄인 요약이다 — 회사에서 텔레그램이 막힌 사용자에게는
 * 「읽어볼 만한 채널 몇 곳은 한 글자도 빼지 말고 다 보여 달라」는 요구가 따로 있다.
 * 그 채널들(ChannelEntry.major)만 5분마다 통째로 읽어 JSONL 로 쌓는다.
 *
 * 화면은 **받은 방과 똑같은 구조**다(2026-08-27 재편) — 주요 채널 하나가 방 하나.
 * 방 목록에 안읽음 말풍선이 뜨고, 누르면 그 채널의 대화방이 열린다.
 * 읽음도 채널별로 적는다(reads: { 채널id: 시각 }).
 *
 * ## 오프셋을 안 쓰는 이유
 *
 * telegramOffsets 는 정기 발행(digest)의 「읽은 위치」다. 여기서 그걸 올려 버리면
 * 다음 발행이 빈 채로 나간다. 대신 매번 최근 구간(겹치게)을 읽고 **메시지 id 로
 * 중복을 걸러** 같은 글이 두 번 쌓이지 않게 한다.
 *
 * ## 사이드바 N 배지에 안 넣는다 (사용자 요청)
 *
 * 모든 글을 긁어오는 방이라 늘 새 글이 있다 — 배지로 알리면 항상 켜져 있어
 * 신호가 죽는다. 안읽음 말풍선은 이 메뉴 안에서만 보여 준다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FEED_FILE = join(DATA_DIR, "majorFeed.jsonl");
const READ_FILE = join(DATA_DIR, "majorFeed.read.json");

export interface MajorMsg {
  /** `${channelId}_${messageId}` — 중복 방지 키 */
  id: string;
  channelId: string;
  at: string;
  /** 채널 표시 이름 */
  channel: string;
  text: string;
  link: string;
}

/** 파일에 이미 있는 id — 겹치게 읽어도 한 번만 쌓이게 */
let knownIds: Set<string> | null = null;

async function readFeed(): Promise<MajorMsg[]> {
  try {
    const text = await readFile(FEED_FILE, "utf-8");
    const out: MajorMsg[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as MajorMsg);
      } catch {
        /* 깨진 줄만 버린다 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function ensureKnown(): Promise<Set<string>> {
  if (knownIds) return knownIds;
  knownIds = new Set((await readFeed()).map((m) => m.id));
  return knownIds;
}

/** 새 글만 골라 붙인다. 4천 건이 넘으면 최근 2,500건으로 줄인다 */
export async function archiveMajor(messages: ChannelMessage[]): Promise<number> {
  const known = await ensureKnown();
  const fresh: MajorMsg[] = [];
  for (const m of messages) {
    const id = `${m.channelId}_${m.messageId}`;
    if (known.has(id)) continue;
    known.add(id);
    fresh.push({
      id,
      channelId: m.channelId,
      at: m.at,
      channel: m.channelName,
      text: m.text,
      link: m.link,
    });
  }
  if (fresh.length === 0) return 0;
  // 시간순으로 붙인다 — fetch 는 최신순으로 주므로 뒤집는다
  fresh.sort((a, b) => a.at.localeCompare(b.at));
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(FEED_FILE, `${fresh.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");

  /*
   * 오래된 글을 덜어낸다.
   *
   * ⚠️ 예전엔 **건수로만** 잘랐다(4000 넘으면 최근 2500건). 그런데 이건 방이 몇 개인지,
   * 그 방들이 얼마나 떠드는지에 따라 **며칠치인지가 매번 달라진다** — 조용한 주에는
   * 2주가 남고 시끄러운 주에는 사흘이 남는다. 「원문 보기」로 지난주 이야기를 찾으려는
   * 사람에게 그건 있다 없다 하는 기능이다 (2026-08-31 요청 — 「몇일~한달치는 저장할 수
   * 있지 않나」).
   *
   * 그래서 **날짜로 자르고**, 그래도 너무 많으면 건수로 한 번 더 막는다. 글자만
   * 담는 파일이라 한 달치도 몇 MB 수준이다.
   */
  const KEEP_DAYS = 45;
  const HARD_MAX = 40_000; // 방이 아주 많을 때의 안전판
  if (known.size > 4000) {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString();
    const all = (await readFeed())
      .filter((m) => m.at >= cutoff)
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-HARD_MAX);
    await writeFile(FEED_FILE, `${all.map((r) => JSON.stringify(r)).join("\n")}\n`, "utf-8");
    knownIds = new Set(all.map((m) => m.id));
  }
  return fresh.length;
}

// ---------------------------------------------------------------- 읽음 (채널별)

async function readReads(): Promise<Record<string, string>> {
  try {
    const j = JSON.parse(await readFile(READ_FILE, "utf-8")) as Record<string, string>;
    return typeof j === "object" && j !== null ? j : {};
  } catch {
    return {};
  }
}

/**
 * 링크로 **전문**을 찾아 준다 (2026-08-31).
 *
 * 버즈가 남기는 조각은 수집 단계에서 이미 잘려 있다. 이 아카이브에는 주요 채널의
 * 글이 **자른 데 없이** 들어 있으므로, 같은 글이 여기 있으면 그쪽을 보여 주는 것이
 * 맞다 — 「원문 보기」인데 잘린 것을 보여 주면 이름값을 못 한다.
 *
 * 주요 채널로 고르지 않은 방의 글은 여기 없다. 그때는 버즈가 가진 조각을 쓴다.
 */
/**
 * 수집분 안에서 찾기 (2026-09-03, 시스 도우미) — **텔레그램에 안 나간다.** 파일만 읽는다.
 *
 * `channelSearch.searchChannels` 는 채널 일흔 곳을 실시간으로 훑어 한참 걸린다(벤티지: "긁는 중이라고만
 * 나와… 한참 기다리니깐 나오네"). 종목 하나 물을 때마다 그걸 돌릴 수는 없다. 주요 채널 피드는 5분마다
 * 쌓이고 있으니 여기서 찾으면 수 ms 다. 대신 **주요 채널만** 본다는 한계를 화면이 적는다.
 */
export async function searchMajorFeed(
  words: string[],
  minutes = 24 * 60,
  limit = 10,
): Promise<{ hits: MajorMsg[]; total: number; newest: string | null }> {
  const q = words.map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 2);
  const feed = await readFeed();
  const since = Date.now() - minutes * 60_000;
  const recent = feed.filter((m) => new Date(m.at).getTime() >= since);
  const hits = q.length
    ? recent.filter((m) => {
        const t = m.text.toLowerCase();
        return q.some((w) => t.includes(w));
      })
    : recent;
  hits.sort((a, b) => b.at.localeCompare(a.at));
  return { hits: hits.slice(0, limit), total: recent.length, newest: feed.length ? feed[feed.length - 1].at : null };
}

export async function fullTextByLinks(links: string[]): Promise<Map<string, string>> {
  const want = new Set(links.filter(Boolean));
  const out = new Map<string, string>();
  if (want.size === 0) return out;
  for (const m of await readFeed()) {
    if (m.link && want.has(m.link)) out.set(m.link, m.text);
  }
  return out;
}

export async function markMajorRead(channelId: string): Promise<void> {
  const reads = await readReads();
  reads[channelId] = new Date().toISOString();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(READ_FILE, JSON.stringify(reads, null, 2), "utf-8");
}

// ---------------------------------------------------------------- 방 목록·대화방

/** 방 목록 — 받은 방과 같은 모양: 미리보기 + 안읽음 말풍선. 최근 글 순 */
export async function majorRooms(): Promise<
  { id: string; name: string; lastAt: string | null; preview: string; unread: number; total: number }[]
> {
  const majors = (await listChannels()).filter((c) => c.major);
  const feed = await readFeed();
  const reads = await readReads();
  const byCh = new Map<string, MajorMsg[]>();
  for (const m of feed) {
    const arr = byCh.get(m.channelId);
    if (arr) arr.push(m);
    else byCh.set(m.channelId, [m]);
  }
  return majors
    .map((c) => {
      const msgs = (byCh.get(c.id) ?? []).sort((a, b) => a.at.localeCompare(b.at));
      const last = msgs[msgs.length - 1];
      const readAt = reads[c.id] ?? "";
      return {
        id: c.id,
        name: c.name,
        lastAt: last?.at ?? null,
        preview: last ? last.text.replace(/\s+/g, " ").trim().slice(0, 60) : "",
        unread: msgs.filter((m) => m.at > readAt).length,
        total: msgs.length,
      };
    })
    .sort((a, b) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));
}

/** 대화방 — 그 채널의 글, 시간순 마지막 limit 건 + 읽음 처리 전의 읽은 위치 */
export async function majorRoomMessages(
  channelId: string,
  limit = 200,
): Promise<{ name: string; messages: MajorMsg[]; readAt: string }> {
  const ch = (await listChannels()).find((c) => c.id === channelId);
  const all = (await readFeed())
    .filter((m) => m.channelId === channelId)
    .sort((a, b) => a.at.localeCompare(b.at));
  return {
    name: ch?.name ?? all[all.length - 1]?.channel ?? channelId,
    messages: all.slice(-Math.min(Math.max(limit, 20), 500)),
    readAt: (await readReads())[channelId] ?? "",
  };
}

// ---------------------------------------------------------------- 수집 루프

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

async function tick(): Promise<void> {
  if (running || !isReaderConfigured()) return;
  const majors = (await listChannels()).filter((c) => c.major);
  if (majors.length === 0) return;
  running = true;
  try {
    /*
     * 처음(파일이 비었을 때)은 12시간을 거슬러 채워 넣는다 — 빈 방은 쓸모를 못 보여준다.
     * 그 뒤로는 20분씩 겹쳐 읽는다(5분 주기 — 경계에 걸친 글은 중복 필터가 거른다).
     */
    const empty = (await ensureKnown()).size === 0;
    const { messages } = await fetchNewMessages({
      onlyIds: majors.map((c) => c.id),
      useOffsets: false, // 정기 발행의 읽은 위치를 건드리면 안 된다
      sinceMinutes: empty ? 12 * 60 : 20,
      maxPerChannel: empty ? 60 : 30,
    });
    const added = await archiveMajor(messages);
    if (added > 0) console.log(`[major] 주요 채널 ${majors.length}곳 → 새 글 ${added}건`);
  } catch (err) {
    console.error("[major] 수집 실패:", err instanceof Error ? err.message : err);
  } finally {
    running = false;
  }
}

export function startMajorFeedLoop(): void {
  if (timer) return;
  setTimeout(() => void tick(), 60_000); // 서버 기동 직후 텔레그램 연결을 기다린다
  timer = setInterval(() => void tick(), 5 * 60_000);
  console.log("[major] 주요 채널 피드 루프 시작 (5분 주기)");
}
