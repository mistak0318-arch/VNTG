import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";

/**
 * 구독 중인 텔레그램 채널 읽기 (MTProto).
 *
 * 봇 API로는 불가능하다 — 봇은 자기가 초대된 방만 보고, 사용자의 구독 목록에는 접근할 수 없다.
 * 그래서 사용자 계정으로 로그인한 세션을 쓴다. `scripts/telegram-login.mjs` 참고.
 *
 * 주의해서 다룬 것:
 *   - 세션 문자열은 계정 전체 권한이다. .env 에만 두고 로그에도 찍지 않는다.
 *   - 채널을 빠르게 연달아 읽으면 FLOOD_WAIT 이 걸린다. 채널 사이에 간격을 두고,
 *     FLOOD_WAIT 을 받으면 그 회차는 조용히 포기한다 (다음 회차에 이어서 읽으면 되므로).
 *   - 마지막으로 읽은 메시지 id를 채널별로 기억해서 같은 걸 두 번 읽지 않는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const CHANNELS_FILE = join(DATA_DIR, "telegramChannels.json");
const OFFSET_FILE = join(DATA_DIR, "telegramOffsets.json");

export interface ChannelEntry {
  id: string;
  name: string;
  username: string | null;
  broadcast: boolean;
  participants: number | null;
  lastAt: string | null;
  /** 수집 대상인지. 처음 발견된 채널은 false로 들어온다 */
  enabled: boolean;
}

export interface ChannelMessage {
  channelId: string;
  channelName: string;
  messageId: number;
  at: string;
  text: string;
}

export function isReaderConfigured(): boolean {
  return Boolean(
    Number(process.env.TELEGRAM_API_ID) &&
      process.env.TELEGRAM_API_HASH?.trim() &&
      process.env.TELEGRAM_SESSION?.trim(),
  );
}

// ---------------------------------------------------------------- 채널 목록

export async function listChannels(): Promise<ChannelEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(CHANNELS_FILE, "utf-8")) as ChannelEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function saveChannels(rows: ChannelEntry[]): Promise<ChannelEntry[]> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CHANNELS_FILE, JSON.stringify(rows, null, 2), "utf-8");
  return rows;
}

/** 특정 채널들의 수집 여부만 바꾼다 */
export async function setChannelEnabled(
  updates: { id: string; enabled: boolean }[],
): Promise<ChannelEntry[]> {
  const rows = await listChannels();
  const map = new Map(updates.map((u) => [u.id, u.enabled]));
  const next = rows.map((r) => (map.has(r.id) ? { ...r, enabled: map.get(r.id)! } : r));
  return saveChannels(next);
}

// ---------------------------------------------------------------- 읽은 위치

type Offsets = Record<string, number>;

async function readOffsets(): Promise<Offsets> {
  try {
    return JSON.parse(await readFile(OFFSET_FILE, "utf-8")) as Offsets;
  } catch {
    return {};
  }
}

async function writeOffsets(o: Offsets): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(OFFSET_FILE, JSON.stringify(o, null, 2), "utf-8");
}

// ---------------------------------------------------------------- 클라이언트

/* eslint-disable @typescript-eslint/no-explicit-any */
let client: any = null;

/**
 * GramJS를 동적 import 한다.
 * 세션이 설정되지 않은 환경(예: 아직 로그인 전)에서도 서버가 떠야 하므로
 * 최상단 import 로 묶지 않는다.
 */
async function getClient(): Promise<any> {
  if (client) return client;
  if (!isReaderConfigured()) throw new Error("텔레그램 세션이 설정되지 않았습니다");

  const { TelegramClient } = await import("telegram");
  const { StringSession } = await import("telegram/sessions/index.js");

  client = new TelegramClient(
    new StringSession(process.env.TELEGRAM_SESSION!.trim()),
    Number(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH!.trim(),
    { connectionRetries: 2, baseLogger: undefined },
  );
  await client.connect();
  return client;
}

export async function disconnectReader(): Promise<void> {
  if (client) {
    await client.disconnect().catch(() => undefined);
    client = null;
  }
}

/** 구독 목록을 새로 읽어 기존 선택(enabled)은 유지한 채 병합한다 */
export async function refreshChannels(): Promise<ChannelEntry[]> {
  const c = await getClient();
  const dialogs = await c.getDialogs({ limit: 500 });
  void recordApiCall("telegram", "getDialogs", "ok");

  const prev = new Map((await listChannels()).map((p) => [p.id, p]));
  const rows: ChannelEntry[] = dialogs
    .filter((d: any) => d.isChannel || d.isGroup)
    .map((d: any) => ({
      id: String(d.id),
      name: d.title ?? d.name ?? "(이름 없음)",
      username: d.entity?.username ?? null,
      broadcast: Boolean(d.entity?.broadcast),
      participants: d.entity?.participantsCount ?? null,
      lastAt: d.message?.date ? new Date(d.message.date * 1000).toISOString() : null,
      // 처음 보는 채널은 꺼둔다 — 180개가 한꺼번에 켜지면 감당이 안 된다
      enabled: prev.get(String(d.id))?.enabled ?? false,
    }))
    .sort((a: ChannelEntry, b: ChannelEntry) => (b.lastAt ?? "").localeCompare(a.lastAt ?? ""));

  return saveChannels(rows);
}

/**
 * 켜져 있는 채널들의 새 메시지를 읽는다.
 *
 * @param maxPerChannel 채널당 최대 건수. 오래 안 돌렸다고 수천 건을 한 번에 끌어오면
 *                      AI 비용이 터지므로 상한을 둔다.
 */
export async function fetchNewMessages(
  opts: { maxPerChannel?: number; sinceHours?: number } = {},
): Promise<{ messages: ChannelMessage[]; channels: number; skipped: string[] }> {
  const { maxPerChannel = 40, sinceHours = 24 } = opts;
  const c = await getClient();

  const targets = (await listChannels()).filter((ch) => ch.enabled);
  const offsets = await readOffsets();
  const cutoff = Date.now() - sinceHours * 3600_000;

  const messages: ChannelMessage[] = [];
  const skipped: string[] = [];

  for (const ch of targets) {
    try {
      const history = await c.getMessages(ch.id, {
        limit: maxPerChannel,
        minId: offsets[ch.id] ?? 0,
      });
      void recordApiCall("telegram", "getMessages", "ok");

      let maxId = offsets[ch.id] ?? 0;
      for (const m of history) {
        if (m.id > maxId) maxId = m.id;
        const text = String(m.message ?? "").trim();
        if (!text) continue; // 사진·스티커만 있는 건 버린다
        const at = m.date ? m.date * 1000 : 0;
        if (at < cutoff) continue;
        messages.push({
          channelId: ch.id,
          channelName: ch.name,
          messageId: m.id,
          at: new Date(at).toISOString(),
          text,
        });
      }
      offsets[ch.id] = maxId;
    } catch (err) {
      // FLOOD_WAIT 등 — 이 회차만 건너뛴다. 오프셋을 안 올렸으므로 다음에 다시 읽는다.
      const msg = err instanceof Error ? err.message : String(err);
      void recordApiCall("telegram", "getMessages", "failed");
      skipped.push(`${ch.name}: ${msg.slice(0, 60)}`);
      if (/FLOOD_WAIT/i.test(msg)) break; // 한 번 걸리면 더 밀어붙이지 않는다
    }

    // 채널 사이 간격 — 몰아치면 계정 제한이 걸린다
    await new Promise((r) => setTimeout(r, 350));
  }

  await writeOffsets(offsets);
  return { messages, channels: targets.length, skipped };
}
