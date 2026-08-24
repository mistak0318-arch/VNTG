import { fetchNewMessages, type ChannelMessage } from "./telegramReader.js";
import { summarize } from "./summarize.js";

/**
 * 채널 메시지 **검색** — 「내 종목이 지금 어디서 언급되나」.
 *
 * ## 왜 정리(digest)와 따로인가
 *
 * 「동향」은 **채널 전체가 무슨 말을 하나**를 묶어 보는 것이다. 그건 시장을 훑을 때 쓴다.
 * 그런데 종목 하나를 파고들 때 궁금한 건 다르다 — **이 종목이 언급됐나, 뭐라고 하나.**
 * 정리본에는 그 종목이 안 뽑혔을 수 있고, 뽑혔어도 한 줄로 줄어 있다.
 *
 * 보드에 텔레그램을 띄우는 이유가 이쪽이다. 지금 보고 있는 종목으로 **자동으로 검색**되고,
 * 키워드를 바꿔 더 좁힐 수 있어야 값어치가 있다.
 *
 * ## 캐시가 필수다
 *
 * `fetchNewMessages` 는 **채널 일흔세 개를 훑는다.** 검색할 때마다 부르면 텔레그램이
 * FLOOD_WAIT 을 건다 — 그러면 검색만 막히는 게 아니라 **정기 수집까지 같이 막힌다.**
 *
 * 그래서 구간별로 받아 두고 **3분간 그대로 쓴다.** 검색어를 바꾸는 건 캐시 안에서 거르는
 * 일이라 호출이 아예 없다. 텔레그램 글이 3분 사이에 크게 달라지지도 않는다.
 */

interface Cached {
  at: number;
  messages: ChannelMessage[];
}

const cache = new Map<number, Cached>();
const TTL_MS = 3 * 60 * 1000;
/** 같은 구간을 동시에 여러 번 읽지 않는다 */
const inflight = new Map<number, Promise<ChannelMessage[]>>();

/**
 * 지금 어디까지 훑었나.
 *
 * 채널이 일흔 개가 넘어 한 번 도는 데 한참 걸린다. 화면이 「훑는 중」만 띄우고 있으면
 * 멈춘 건지 도는 건지 알 수가 없어서, 몇 번째 채널을 보고 있는지 내보낸다.
 *
 * **모듈 변수 하나로 둔다.** 검색은 한 번에 하나만 돌고(`inflight` 로 묶여 있다) 이 값은
 * 화면에 진행바를 그리는 데만 쓴다 — 정확한 상태 기계가 필요한 자리가 아니다.
 */
export interface SearchProgress {
  running: boolean;
  done: number;
  total: number;
  /** 지금 보고 있는 채널 */
  name: string;
  at: number;
}

let progress: SearchProgress = { running: false, done: 0, total: 0, name: "", at: 0 };

export function searchProgress(): SearchProgress {
  /*
   * 오래된 값은 **안 돈다고 본다.** 서버가 중간에 죽거나 예외가 finally 를 못 타면
   * `running: true` 가 영영 남아 화면에 진행바가 박힌다. 30초면 충분히 길다.
   */
  if (progress.running && Date.now() - progress.at > 30_000) return { ...progress, running: false };
  return progress;
}

async function load(minutes: number): Promise<ChannelMessage[]> {
  const hit = cache.get(minutes);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.messages;
  progress = { running: true, done: 0, total: 0, name: "채널 목록", at: Date.now() };

  const running = inflight.get(minutes);
  if (running) return running;

  const job = (async () => {
    /*
     * `useOffsets: false` — 오프셋을 쓰면 **이미 읽은 글을 건너뛴다.**
     * 정기 수집은 그게 맞지만 검색은 「그 구간 전체」를 봐야 한다.
     */
    const { messages } = await fetchNewMessages({
      sinceMinutes: minutes,
      useOffsets: false,
      onProgress: (done, total, name) => {
        progress = { running: true, done, total, name, at: Date.now() };
      },
    });
    cache.set(minutes, { at: Date.now(), messages });
    return messages;
  })().finally(() => {
    inflight.delete(minutes);
    progress = { ...progress, running: false };
  });

  inflight.set(minutes, job);
  return job;
}

export interface SearchHit extends ChannelMessage {
  /** 어느 말이 걸렸나 — 여러 개를 넣으면 걸린 것만 알려 준다 */
  matched: string[];
}

export interface SearchResult {
  query: string[];
  minutes: number;
  /** 훑은 원문 수 */
  scanned: number;
  hits: SearchHit[];
  error: string | null;
}

/**
 * 여러 말 중 **하나라도** 들어 있으면 걸린다(OR).
 *
 * 종목은 이름 하나로 안 잡힌다 — 「한화에어로」·「한화에어로스페이스」·「012450」이 다
 * 같은 종목인데 채널마다 다르게 쓴다. 그래서 부르는 쪽이 여러 말을 넘긴다.
 */
export async function searchChannels(
  words: string[],
  minutes = 720,
  limit = 60,
): Promise<SearchResult> {
  const query = words.map((w) => w.trim()).filter((w) => w.length >= 2);
  if (query.length === 0) {
    return { query, minutes, scanned: 0, hits: [], error: "두 글자 이상으로 찾아 주세요." };
  }

  try {
    const messages = await load(minutes);
    const lowered = query.map((q) => q.toLowerCase());
    const hits: SearchHit[] = [];
    for (const m of messages) {
      const text = m.text.toLowerCase();
      const matched = query.filter((_, i) => text.includes(lowered[i]));
      if (matched.length > 0) hits.push({ ...m, matched });
    }
    // 최신이 위 — 텔레그램의 무기는 신속성이다
    hits.sort((a, b) => b.at.localeCompare(a.at));
    return { query, minutes, scanned: messages.length, hits: hits.slice(0, limit), error: null };
  } catch (err) {
    return {
      query,
      minutes,
      scanned: 0,
      hits: [],
      error: err instanceof Error ? err.message : "채널을 읽지 못했습니다.",
    };
  }
}


/**
 * 검색 결과를 **AI 가 정리한다.**
 *
 * 원문 그대로 보는 게 기본이다 — 채널 말투와 숫자가 그대로 있어야 판단이 된다.
 * 그런데 걸린 게 마흔 건이면 다 못 읽는다. 그때 「무슨 말이 돌고 있나」를 몇 줄로 줄인다.
 *
 * ⚠️ **원문을 대신하지 않는다.** 정리는 훑어보라고 있는 것이고, 눈에 걸리는 게 있으면
 * 아래 원문을 봐야 한다. AI 는 숫자를 잘못 옮기고 뉘앙스를 지운다 —
 * 이 앱에서 AI 정리를 늘 「원문 옆에」 두는 이유다.
 *
 * 호출당 비용이 있으므로 **누를 때만** 돈다. 자동으로 걸지 않는다.
 */
export async function summarizeHits(
  words: string[],
  minutes: number,
): Promise<{ text: string | null; count: number; error: string | null; model: string | null }> {
  const found = await searchChannels(words, minutes, 80);
  if (found.error) return { text: null, count: 0, error: found.error, model: null };
  if (found.hits.length === 0) {
    return { text: null, count: 0, error: "정리할 글이 없습니다.", model: null };
  }

  const body = found.hits
    .map((h) => `[${h.channelName} ${h.at.slice(5, 16).replace("T", " ")}]\n${h.text}`)
    .join("\n\n---\n\n");

  const prompt = [
    `아래는 텔레그램 채널들에서 「${words.join(", ")}」 가 언급된 글 ${found.hits.length}건이다.`,
    `최근 ${minutes}분 구간이다.`,
    "",
    "다음 순서로 한국어로 정리하라.",
    "1. 지금 무슨 말이 돌고 있나 — 두세 줄",
    "2. 근거로 나온 숫자·일정 — 있는 것만. 없으면 없다고 적는다",
    "3. 엇갈리는 의견 — 사는 쪽과 파는 쪽이 갈리면 둘 다 적는다",
    "",
    "규칙: 원문에 없는 것을 지어내지 않는다. 추천이나 목표가를 만들지 않는다.",
    "같은 말이 여러 채널에 있으면 몇 곳에서 나왔는지 적는다(퍼지는 중이라는 뜻이다).",
    "",
    "---",
    body,
  ].join("\n");

  const res = await summarize(prompt, 1200, "channel");
  return {
    text: res.text,
    count: found.hits.length,
    error: res.error ?? null,
    model: res.usedModel ?? null,
  };
}
