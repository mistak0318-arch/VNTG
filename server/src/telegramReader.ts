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
  /** 원문으로 바로 가는 t.me 링크 (만들 수 없으면 빈 문자열) */
  link: string;
}

/**
 * 메시지 원문 링크.
 *
 * 공개 채널은 `t.me/이름/글번호`, 비공개는 `t.me/c/내부id/글번호` 형식이다.
 * 비공개 쪽 내부 id 는 앞의 `-100` 을 뗀 숫자다 — 안 떼면 링크가 열리지 않는다.
 * 내가 구독 중인 채널이어야 열리므로 남에게 공유하는 용도로는 못 쓴다.
 */
function messageLink(ch: ChannelEntry, messageId: number): string {
  if (!messageId) return "";
  if (ch.username) return `https://t.me/${ch.username}/${messageId}`;
  const inner = String(ch.id).replace(/^-100/, "").replace(/^-/, "");
  return /^\d+$/.test(inner) ? `https://t.me/c/${inner}/${messageId}` : "";
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

/**
 * 우리가 알림을 보내는 방들의 id.
 *
 * 이걸 수집 대상에서 빼지 않으면 봇이 보낸 리포트·시그널을 다음 회차에 다시 읽어들이고,
 * 그게 또 요약에 들어가 다음 리포트에 반영되는 되먹임이 생긴다.
 * 텔레그램 id는 앞에 -100 이 붙는 형태가 섞여 있어 숫자 부분만 비교한다.
 */
function ownChatIds(): Set<string> {
  const keys = [
    "TELEGRAM_CHAT_ID",
    "TELEGRAM_CHAT_ID_REPORT",
    "TELEGRAM_CHAT_ID_SIGNAL",
    "TELEGRAM_CHAT_ID_LOG",
    "TELEGRAM_CHAT_ID_CHANNEL",
  ];
  const out = new Set<string>();
  for (const k of keys) {
    const v = process.env[k]?.trim();
    if (v) out.add(v.replace(/^-100/, "").replace(/^-/, ""));
  }
  return out;
}

function isOwnChat(id: string, own: Set<string>): boolean {
  return own.has(String(id).replace(/^-100/, "").replace(/^-/, ""));
}

/** 구독 목록을 새로 읽어 기존 선택(enabled)은 유지한 채 병합한다 */
export async function refreshChannels(): Promise<ChannelEntry[]> {
  const c = await getClient();
  const dialogs = await c.getDialogs({ limit: 500 });
  void recordApiCall("telegram", "getDialogs", "ok");

  const own = ownChatIds();
  const prev = new Map((await listChannels()).map((p) => [p.id, p]));
  const rows: ChannelEntry[] = dialogs
    .filter((d: any) => d.isChannel || d.isGroup)
    // 우리가 쓰는 알림방은 목록에서 아예 뺀다 (되먹임 방지)
    .filter((d: any) => !isOwnChat(String(d.id), own))
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
 * 켜져 있는 채널들의 메시지를 읽는다.
 *
 * 읽는 방식이 두 가지다. 섞으면 안 된다:
 *
 *   useOffsets=true  (스케줄러용) — 채널별 "마지막으로 읽은 id" 다음부터. 같은 메시지를
 *                     두 번 요약하지 않으므로 07/12/18시 정기 발행에 맞다.
 *   useOffsets=false (수동 실행용) — 오프셋을 보지도 쓰지도 않고 **최근 sinceMinutes 전체**를
 *                     다시 읽는다. 사용자가 버튼을 누르는 이유는 "지금 이 시점의 최신"을
 *                     보고 싶어서지, "지난번 이후 새로 온 것"을 보려는 게 아니다.
 *
 * 수동 실행이 오프셋을 올려버리면 그 다음 정기 발행이 빈 채로 나가므로,
 * 수동 모드에서는 오프셋 파일을 건드리지 않는다.
 *
 * @param maxPerChannel 채널당 최대 건수. 오래 안 돌렸다고 수천 건을 한 번에 끌어오면
 *                      AI 비용이 터지므로 상한을 둔다.
 */
export async function fetchNewMessages(
  opts: { maxPerChannel?: number; sinceMinutes?: number; useOffsets?: boolean } = {},
): Promise<{ messages: ChannelMessage[]; channels: number; fetched: number; skipped: string[] }> {
  const { maxPerChannel = 40, sinceMinutes = 60, useOffsets = true } = opts;
  const c = await getClient();

  const enabled = (await listChannels()).filter((ch) => ch.enabled);
  const offsets = useOffsets ? await readOffsets() : {};
  const cutoff = Date.now() - sinceMinutes * 60_000;

  /*
   * **어느 채널에 새 글이 있는지 먼저 한 번에 알아낸다.**
   *
   * 채널마다 getMessages 를 부르면 73개 채널 = 73회 호출이고, 간격까지 두면 한 회차에 26초다.
   * 5분마다 돌리면 하루 2만 회가 넘어 FLOOD_WAIT 이 걸린다.
   *
   * getDialogs 는 **한 번의 호출로** 모든 대화의 마지막 메시지 id를 준다. 그걸 저장해 둔
   * 오프셋과 비교하면 조회할 채널이 보통 한 자릿수로 줄어든다.
   * 실패하면 예전처럼 전수 조회로 넘어간다 — 덜 효율적일 뿐 결과는 같다.
   */
  let targets = enabled;
  if (useOffsets) {
    try {
      const dialogs = await c.getDialogs({ limit: 500 });
      void recordApiCall("telegram", "getDialogs", "ok");
      const topId = new Map<string, number>();
      for (const d of dialogs) {
        const id = Number(d.message?.id ?? 0);
        if (id > 0) topId.set(String(d.id), id);
      }
      // 마지막 글 id 를 아는 채널 중, 우리가 읽은 위치보다 뒤에 있는 것만
      const fresh = enabled.filter((ch) => {
        const top = topId.get(ch.id);
        if (top === undefined) return true; // 모르면 확인해 본다
        return top > (offsets[ch.id] ?? 0);
      });
      targets = fresh;
    } catch {
      void recordApiCall("telegram", "getDialogs", "failed");
      // 대화 목록을 못 받으면 전수 조회로 (안전한 쪽)
    }
  }

  const messages: ChannelMessage[] = [];
  const skipped: string[] = [];

  for (const ch of targets) {
    try {
      const history = await c.getMessages(ch.id, {
        limit: maxPerChannel,
        ...(useOffsets ? { minId: offsets[ch.id] ?? 0 } : {}),
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
          link: messageLink(ch, m.id),
        });
      }
      if (useOffsets) offsets[ch.id] = maxId;
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

  if (useOffsets) await writeOffsets(offsets);
  // 최신 메시지가 위로 오게 — 화면에서도 요약에서도 "지금"이 먼저다
  messages.sort((a, b) => b.at.localeCompare(a.at));
  // channels 는 "대상 채널 수"라 켜둔 전체를 알려주는 게 맞다 (조회한 수는 fetched)
  return { messages, channels: enabled.length, fetched: targets.length, skipped };
}
