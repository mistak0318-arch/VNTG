import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 텔레그램 발신 아카이브 (2026-08-27) — **VNTG 방들을 브라우저에서 본다.**
 *
 * 사용자가 원한 것: "6개 방을 폰으로 일일이 들어가 보기 어렵다. 브라우저에서
 * 텔레그램 보듯이 — 방 목록 + 새 메시지 말풍선, 클릭하면 대화방, 중요한 건 별표."
 *
 * ## 왜 「1분 스캔」이 아니라 발신 아카이브인가
 *
 * 그 방들의 메시지는 **전부 우리 서버가 보낸 것**이다. 텔레그램을 읽으러 갈 필요가
 * 없다 — sendTelegram 이 성공하는 순간 여기에도 한 줄 남기면, 스캔 비용 0에
 * 지연도 0이다. (봇은 자기 방을 읽는 API 도 마땅치 않다 — getUpdates 는 웹훅과
 * 배타적이고 봇 메시지는 안 준다.)
 *
 * ## 저장
 *
 * 이벤트 로그(eventLog)와 같은 문법 — 방별 JSONL append, 실패는 삼킨다(기록이
 * 발송을 막으면 주객전도). 읽음 표시는 방별 시각 하나(reads.json), 별표는
 * stars.json 에 메시지 사본째 담는다(원본 파일이 정리돼도 별은 남아야 한다).
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "tgArchive");
const READS = join(DIR, "reads.json");
const STARS = join(DIR, "stars.json");

/** 방(채널) 이름 — 화면 표기. telegram.ts 의 TelegramChannel 과 같은 키 */
export const ROOM_LABELS: Record<string, string> = {
  report: "리포트",
  signal: "시그널",
  channel: "채널 선별",
  disclosure: "공시",
  keyword: "키워드",
  super: "슈퍼신호등",
  log: "로그",
};
/** 방 나열 순서 — 시장 흐름을 읽는 순서대로. 로그는 맨 뒤(운영 소음) */
export const ROOM_ORDER = ["signal", "super", "channel", "keyword", "disclosure", "report", "log"];

export interface TgMsg {
  /** at + 순번 — 별표가 이 id 로 메시지를 가리킨다 */
  id: string;
  at: string;
  text: string;
}

export interface TgStar extends TgMsg {
  channel: string;
  starredAt: string;
}

let seq = 0;

/**
 * 방별 줄 수 — 트림 판단용 (2026-08-27 전수 점검).
 * append 만 하던 파일이라 로그 방처럼 잦은 방은 무한히 자랐다. 처음 한 번 세고,
 * 그 뒤로는 더할 때마다 올리다가 3천 줄을 넘으면 최근 2천 줄로 줄인다.
 */
const lineCount = new Map<string, number>();

async function trimIfNeeded(channel: string): Promise<void> {
  let n = lineCount.get(channel);
  if (n === undefined) {
    n = (await readJsonl(channel)).length;
  } else {
    n += 1;
  }
  lineCount.set(channel, n);
  if (n <= 3000) return;
  const keep = (await readJsonl(channel)).slice(-2000);
  await writeFile(
    join(DIR, `${channel}.jsonl`),
    `${keep.map((r) => JSON.stringify(r)).join("\n")}\n`,
    "utf-8",
  );
  lineCount.set(channel, keep.length);
}

/** 발신 성공 직후 한 줄 — 실패는 삼킨다 */
export async function archiveOutgoing(channel: string, html: string): Promise<void> {
  try {
    await mkdir(DIR, { recursive: true });
    seq = (seq + 1) % 1000;
    const at = new Date().toISOString();
    const row: TgMsg = { id: `${Date.now().toString(36)}_${seq}`, at, text: html };
    await appendFile(join(DIR, `${channel}.jsonl`), `${JSON.stringify(row)}\n`, "utf-8");
    await trimIfNeeded(channel);
  } catch {
    /* 기록 실패가 발송을 막으면 안 된다 */
  }
}

async function readJsonl(channel: string): Promise<TgMsg[]> {
  try {
    const text = await readFile(join(DIR, `${channel}.jsonl`), "utf-8");
    const out: TgMsg[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim(); // CRLF 로 저장된 파일도 읽힌다 (\r 이 남으면 parse 가 터진다)
      if (!t) continue;
      try {
        out.push(JSON.parse(t) as TgMsg);
      } catch {
        /* 깨진 줄만 버린다 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function readReads(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(READS, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** 방 목록 — 마지막 메시지 미리보기 + 안 읽은 수(말풍선) */
export async function roomsSummary(): Promise<
  { channel: string; label: string; lastAt: string | null; preview: string; unread: number; total: number }[]
> {
  const reads = await readReads();
  const out = [];
  for (const ch of ROOM_ORDER) {
    const msgs = await readJsonl(ch);
    const last = msgs[msgs.length - 1];
    const readAt = reads[ch] ?? "";
    out.push({
      channel: ch,
      label: ROOM_LABELS[ch] ?? ch,
      lastAt: last?.at ?? null,
      preview: last ? stripHtml(last.text).slice(0, 60) : "",
      unread: msgs.filter((m) => m.at > readAt).length,
      total: msgs.length,
    });
  }
  return out;
}

export async function roomMessages(channel: string, limit = 80): Promise<TgMsg[]> {
  const msgs = await readJsonl(channel);
  return msgs.slice(-Math.min(Math.max(limit, 10), 300));
}

/** 이 방을 어디까지 읽었나 — 「여기까지 읽음」 구분선이 이 시각으로 갈린다 */
export async function readAtOf(channel: string): Promise<string> {
  const reads = await readReads();
  return reads[channel] ?? "";
}

/** 방을 열면 읽음 — 그 시각 이전은 전부 읽은 것으로 */
export async function markRead(channel: string): Promise<void> {
  const reads = await readReads();
  reads[channel] = new Date().toISOString();
  await mkdir(DIR, { recursive: true });
  await writeFile(READS, JSON.stringify(reads, null, 2), "utf-8");
}

async function readStars(): Promise<TgStar[]> {
  try {
    const j = JSON.parse(await readFile(STARS, "utf-8")) as unknown;
    return Array.isArray(j) ? (j as TgStar[]) : [];
  } catch {
    return [];
  }
}

/** 별표 토글 — 메시지 사본째 담는다(아카이브가 정리돼도 별은 남는다) */
export async function toggleStar(channel: string, msg: TgMsg): Promise<{ starred: boolean }> {
  const stars = await readStars();
  const i = stars.findIndex((s) => s.channel === channel && s.id === msg.id);
  if (i >= 0) {
    stars.splice(i, 1);
  } else {
    stars.push({ ...msg, channel, starredAt: new Date().toISOString() });
  }
  await mkdir(DIR, { recursive: true });
  await writeFile(STARS, JSON.stringify(stars, null, 2), "utf-8");
  return { starred: i < 0 };
}

export async function listStars(): Promise<TgStar[]> {
  const stars = await readStars();
  return [...stars].sort((a, b) => b.starredAt.localeCompare(a.starredAt));
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
