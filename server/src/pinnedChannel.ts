import { getChannelConfig } from "./channelConfig.js";
import { fetchNewMessages, listChannels, type ChannelMessage } from "./telegramReader.js";

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

/**
 * @param edition 어느 판인가 — 보는 창이 달라진다
 * @param limit   몇 편까지
 */
export async function pinnedPosts(edition: Edition, limit = 3): Promise<PinnedPost[]> {
  const { pinned } = await getChannelConfig();
  if (pinned.length === 0) return [];

  try {
    const all = await listChannels();
    /*
     * username 으로 찾는다. 채널 id 는 숫자라 사람이 못 알아보고 세션을 다시 만들면
     * 헷갈리는데, `@ehdwl` 같은 이름은 안 바뀐다.
     */
    const want = new Set(pinned);
    const targets = all.filter((c) => c.username && want.has(c.username.toLowerCase()));
    if (targets.length === 0) return [];

    const byId = new Map(targets.map((c) => [c.id, c]));
    /*
     * **오프셋을 쓰지 않는다.** 선별 스캐너가 이미 읽어 간 글이면 오프셋이 앞서 있어
     * 아무것도 안 나온다. 고정 채널은 "새 글"이 아니라 "그 시간대의 글"을 봐야 한다.
     */
    const { messages } = await fetchNewMessages({
      sinceMinutes: windowHours(edition) * 60,
      maxPerChannel: 20,
      useOffsets: false,
    });

    return messages
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
  } catch {
    // 고정 채널 하나 때문에 리포트가 멈추면 안 된다
    return [];
  }
}
