import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getChannelConfig } from "./channelConfig.js";
import { fetchNewMessages, listChannels, type ChannelMessage } from "./telegramReader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SNAP_FILE = resolve(__dirname, "..", "data", "pinnedSnapshot.json");

/**
 * 고정 채널 원문.
 *
 * 어떤 채널은 성격이 다르다. **정해진 시각에 한 편의 완결된 시황**을 올리는 곳은
 * 다른 채널의 조각 정보와 같은 저울에 올리면 안 된다 — 점수가 낮다고 잘려 나가면
 * 정작 제일 읽을 만한 글을 놓친다.
 *
 * 그래서 이 글은 **선별도 AI 요약도 거치지 않고** 원문 그대로 리포트 맨 위에 올린다.
 * 이 채널의 값어치는 "이미 사람이 정리해 뒀다"는 것 자체다. 다시 요약하면 그게 사라진다.
 *
 * 판마다 보는 창이 다르다.
 *   조간   — 새벽에 올라온 전일 미장 시황
 *   장중   — 오전 브리핑
 *   석간   — 오후 브리핑
 */

export type Edition = "morning" | "intraday" | "closing" | "weekend";

export interface PinnedPost {
  channelName: string;
  username: string | null;
  at: string;
  text: string;
  link: string;
}

/**
 * 판별로 몇 시간을 거슬러 볼지.
 *
 * 조간(07:00)은 **밤사이 전체**를 봐야 한다 — 새벽 2~5시 글이 본편이라 창이 넓어야 한다.
 * 장중·석간은 직전 반나절이면 충분하다.
 */
function windowHours(edition: Edition): number {
  if (edition === "morning") return 12;
  if (edition === "weekend") return 48;
  return 8;
}

/*
 * ──────────────────────────────────────────────────────────────────
 * 스냅샷
 *
 * **리포트는 그날 아침의 기록이다. 열 때마다 달라지면 안 된다.**
 *
 * 예전엔 화면을 열 때마다 텔레그램에 새로 물었다. 그래서 세 가지가 났다.
 *   1. 조회 창이 「지금 기준」이라 시간이 가면 아침 글이 밀려나 **사라졌다**
 *   2. 조회가 실패하면 catch 가 조용히 빈 배열을 줘서 **섹션이 그냥 없어졌다**
 *   3. 조회가 응답 없이 매달리면 화면이 **「불러오는 중…」에서 안 넘어갔다**
 *
 * 한 번 받은 판은 파일에 적어 두고 그다음부터는 그걸 준다.
 * 하루 한 편만 올리는 채널이라 이게 맞다 — 새 글은 다음 판에서 잡힌다.
 * ──────────────────────────────────────────────────────────────────
 */

type Snapshot = Record<string, { at: string; posts: PinnedPost[] }>;

/** 한국 날짜 — 판을 하루 단위로 가른다 */
function kstDate(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

async function readSnap(): Promise<Snapshot> {
  try {
    return JSON.parse(await readFile(SNAP_FILE, "utf-8")) as Snapshot;
  } catch {
    return {};
  }
}

async function writeSnap(snap: Snapshot): Promise<void> {
  // 오래된 판은 버린다 — 60일이면 충분하고, 안 버리면 파일이 계속 자란다
  const cut = new Date(Date.now() - 60 * 24 * 3600_000).toISOString().slice(0, 10);
  for (const k of Object.keys(snap)) if (k.slice(0, 10) < cut) delete snap[k];
  await mkdir(dirname(SNAP_FILE), { recursive: true });
  await writeFile(SNAP_FILE, JSON.stringify(snap, null, 2), "utf-8");
}

/**
 * 매달리지 않게 시간을 끊는다.
 *
 * 텔레그램 조회는 응답이 안 올 때가 있다. 그러면 화면이 「불러오는 중…」에서
 * 영영 안 넘어간다 — **못 받은 것보다 안 끝나는 게 나쁘다.**
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    p,
    new Promise<T>((_, rej) => setTimeout(() => rej(new Error("텔레그램 조회 시간 초과")), ms)),
  ]);
}

/**
 * @param edition 어느 판인가 — 보는 창이 달라진다
 * @param limit   몇 편까지
 * @param force   저장된 판을 무시하고 다시 받는다
 */
/**
 * 고정 채널이 **어디서 막혔나**.
 *
 * ## 왜 필요한가
 *
 * `fetchPinned` 는 네 갈래로 **조용히 빈 배열**을 돌려준다 —
 * 채널을 안 걸었거나, 계정이 그 채널을 못 보거나, 오류가 났거나, 그냥 글이 없거나.
 * 화면에서는 넷이 똑같이 「비어 있음」으로 보여서 **무엇을 고쳐야 할지 알 수가 없다.**
 * 실제로 「계속 안 불러진다」는 말만 나오고 원인을 못 짚었다.
 *
 * ## 마지막 성공 시각이 핵심이다
 *
 * 「3시간 전에 마지막으로 읽음」이면 지금 잠깐 조용한 것이고,
 * 「어제 이후 없음」이면 세션이 끊긴 것이다. 그 둘을 가르는 건 시각뿐이다.
 *
 * 메모리에만 둔다 — 서버를 다시 띄우면 비는 게 맞다. 「방금 띄웠는데 어제 성공했다」는
 * 기록은 지금 상태를 말해 주지 않는다.
 */
export type PinnedStage =
  | "채널 미등록"
  | "계정이 그 채널을 못 봄"
  | "조회 실패"
  | "그 시간대에 글 없음"
  | "정상";

export interface PinnedHealth {
  /** 마지막으로 시도한 시각 */
  triedAt: string | null;
  /** 마지막으로 **글을 실제로 가져온** 시각 */
  okAt: string | null;
  /** 그때 몇 건이었나 */
  okCount: number;
  /** 마지막 결과가 어느 단계였나 */
  stage: PinnedStage | null;
  /** 걸어 둔 채널 */
  pinned: string[];
  /** 세션이 볼 수 있는 채널 중 걸린 것 */
  visible: string[];
  detail: string;
}

const health: PinnedHealth = {
  triedAt: null,
  okAt: null,
  okCount: 0,
  stage: null,
  pinned: [],
  visible: [],
  detail: "",
};

export function pinnedHealth(): PinnedHealth {
  return { ...health };
}

export async function pinnedPosts(
  edition: Edition,
  limit = 3,
  force = false,
): Promise<PinnedPost[]> {
  const key = `${kstDate()}|${edition}`;
  const snap = await readSnap();
  // 저장된 판이 있으면 그걸 준다 — 리포트는 그날의 기록이다
  if (!force && snap[key]?.posts?.length) return snap[key].posts.slice(0, limit);

  const fresh = await fetchPinned(edition, limit);
  if (fresh.length > 0) {
    snap[key] = { at: new Date().toISOString(), posts: fresh };
    await writeSnap(snap).catch(() => undefined);
  }
  return fresh;
}

async function fetchPinned(edition: Edition, limit: number): Promise<PinnedPost[]> {
  const { pinned } = await getChannelConfig();
  health.triedAt = new Date().toISOString();
  health.pinned = pinned;
  if (pinned.length === 0) {
    health.stage = "채널 미등록";
    health.detail = "설정 › 텔레그램 › 고정 채널에서 채널을 먼저 걸어야 합니다.";
    return [];
  }

  try {
    const all = await listChannels();
    /*
     * username 으로 찾는다. 채널 id 는 숫자라 사람이 못 알아보고 세션을 다시 만들면
     * 헷갈리는데, `@ehdwl` 같은 이름은 안 바뀐다.
     */
    const want = new Set(pinned);
    const targets = all.filter((c) => c.username && want.has(c.username.toLowerCase()));
    health.visible = targets.map((c) => c.username ?? String(c.id));
    if (targets.length === 0) {
      health.stage = "계정이 그 채널을 못 봄";
      health.detail =
        `건 채널: ${pinned.join(", ")} · 세션이 보는 채널 ${all.length}개 중 없음. ` +
        "그 계정이 채널에 들어가 있는지, 이름이 맞는지 보세요.";
      return [];
    }

    const byId = new Map(targets.map((c) => [c.id, c]));
    /*
     * **오프셋을 쓰지 않는다.** 선별 스캐너가 이미 읽어 간 글이면 오프셋이 앞서 있어
     * 아무것도 안 나온다. 고정 채널은 "새 글"이 아니라 "그 시간대의 글"을 봐야 한다.
     */
    const { messages } = await withTimeout(
      fetchNewMessages({
        sinceMinutes: windowHours(edition) * 60,
        maxPerChannel: 20,
        useOffsets: false,
      }),
      20_000,
    );

    const picked = messages
      .filter((m: ChannelMessage) => byId.has(m.channelId))
      // 한 줄짜리 잡담은 시황이 아니다. 완결된 글만 남긴다
      .filter((m) => m.text.trim().length >= 80)
      .sort((a, b) => b.at.localeCompare(a.at))
      .slice(0, limit)
      .map((m) => ({
        channelName: m.channelName,
        username: byId.get(m.channelId)?.username ?? null,
        at: m.at,
        text: m.text,
        link: m.link,
      }));

    if (picked.length === 0) {
      health.stage = "그 시간대에 글 없음";
      health.detail =
        `채널은 보이는데(${health.visible.join(", ")}) 최근 ${windowHours(edition)}시간 안에 ` +
        "80자 넘는 글이 없습니다. 한 줄짜리 잡담은 시황이 아니라 걸러냅니다.";
    } else {
      health.stage = "정상";
      health.okAt = new Date().toISOString();
      health.okCount = picked.length;
      health.detail = "";
    }
    return picked;
  } catch (e) {
    // 고정 채널 하나 때문에 리포트가 멈추면 안 된다 — 다만 왜 실패했는지는 남긴다
    health.stage = "조회 실패";
    health.detail = e instanceof Error ? e.message : String(e);
    return [];
  }
}
