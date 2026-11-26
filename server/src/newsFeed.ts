import { recent as recentChannel } from "./channelStore.js";
import { naverNews } from "./naverMainNews.js";

/**
 * **지금 — 뉴스와 채널을 한 줄로 섞는다** (2026-11-26 — 벤티지: "뉴스랑 텔레그램 동향이랑
 * 합쳐가지고 재구성 해보자. 두개가 따로 있을 필요가 없네").
 *
 * ## 따로 있으면 못 보는 것
 *
 * 둘은 **같은 사건을 다른 속도로** 말한다. 채널이 먼저 떠들고 뉴스가 받아 적는 날이 있고,
 * 공시가 먼저 뜨고 채널이 해석하는 날이 있다. 그런데 화면이 갈려 있으면 **어느 쪽이 먼저
 * 말했는지**를 볼 수가 없다 — 메뉴를 오가는 사이 시각이 머릿속에서 섞인다.
 *
 * 한 줄로 세우면 그게 **눈에 보인다.** 「22:03 채널 → 22:11 뉴스」면 채널이 빨랐던 것이고,
 * 그 간격이 곧 그 소식의 성격이다.
 *
 * ## 섞되 **출처를 지운 적이 없다**
 *
 * 채널은 빠르고 투기적이며, 뉴스는 느리고 공식적이다 — `topicPulse` 가 같은 이유로
 * 둘을 갈라 세는 것처럼, 여기서도 줄마다 어디서 온 것인지 달고 간다. 섞는 것은 **시각**
 * 하나뿐이고, 판단은 읽는 사람이 한다.
 *
 * ## 뉴스는 **네이버 증권 주요뉴스**다 (2026-11-27 고침)
 *
 * 벤티지: "이거 뉴스는 왜 1건 밖에 안 잡히지? 주요뉴스 위주로 잡아줬으면 좋겠는데"
 *
 * 처음엔 `breakingNews()` 를 썼는데, 그것은 **제목이 속보 머리표로 시작하는 기사만**
 * 남긴다(`/^[[「(]?(속보|단독|긴급)[]」)]/`). 밤사이 그런 제목은 한 건뿐이라 뉴스 칸이
 * 비었다. 거르는 자리를 잘못 고른 것이다 — 「속보라고 **써 붙인** 기사」와 「지금 중요한
 * 기사」는 같지 않다.
 *
 * 그래서 **사람이 고른 목록**으로 바꾼다. 네이버 증권 주요뉴스는 편집자가 추려 올리는
 * 자리라, 거르는 일을 이미 해 둔 것이다 — 먼저 거르고 본다는 순서 그대로다.
 *
 * ### 왜 「실시간 속보」는 안 쓰나 — 세어 보고 뺐다
 *
 * 2026-11-27 08:0x 실측(쪽당 20건):
 *
 *     주요 1쪽   1시간 7건 · 3시간 20건 · 6시간 20건 (가장 오래된 것 06:01)
 *     주요 2쪽   1시간 0건 · 3시간  4건 · 6시간  5건 (어제 19:36 까지)
 *     속보 1쪽   1시간 20건 — **한 쪽이 33분치다**
 *
 * 속보는 증권 기사가 들어오는 족족 쌓이는 소방호스다. 3시간 창을 덮으려면 여섯 쪽을
 * 긁어야 하고(120건), 그러면 정작 주요뉴스가 그 속에 묻힌다. 두 쪽만 긁으면 더 나쁘다 —
 * **창의 앞 두 시간은 속보가 없는 것처럼** 보이는데, 조용한 것이 아니라 안 가져온 것이다.
 *
 * 주요 1·2쪽은 어제 저녁까지 닿으므로 **6시간 창도 끝까지 덮는다.** 빠지는 구간이 없다.
 * 속보 전체를 훑고 싶으면 「뉴스·공시」 탭이 그대로 있다.
 *
 * ## 조회를 안 늘린다
 *
 * 주요뉴스는 `naverNews("main", 쪽)`(5분 캐시, 시황·AI 요약이 이미 쓰는 길)을, 채널은
 * `channelStore.recent`(파일)를 쓴다. 새로 긁는 것이 없다.
 */

export type FeedKind = "news" | "channel";

export interface FeedItem {
  kind: FeedKind;
  /** ISO 시각 — 섞는 유일한 기준 */
  at: string;
  title: string;
  /** 뉴스는 언론사, 채널은 방 이름 */
  from: string;
  /**
   * 채널만 — 방의 **id**. 고른 방을 이 기기에 적어 둘 때 이름이 아니라 이것으로 적는다
   * (2026-11-26 — 벤티지: "여기에 나오는 텔레그램 채널 내가 고를 수 있게").
   * 방 이름은 운영자가 바꾼다 — 이름으로 적어 두면 그날 고른 방이 **조용히** 풀린다.
   */
  fromId?: string;
  link: string;
  /** 뉴스 요약 · 채널 본문(잘라서) */
  body: string;
  /** 뉴스만 — 속보 갈래 */
  category?: string;
  /** 뉴스만 — 주요 언론사인가 */
  major?: boolean;
}

export interface NewsFeed {
  items: FeedItem[];
  /** 어디까지 훑었나 — 「조용하다」와 「못 봤다」를 가른다 */
  newsCount: number;
  channelCount: number;
  minutes: number;
  at: string;
}

/** 채널 글은 길다 — 한 줄에 들어갈 만큼만 자르고, 자른 사실을 말한다 */
function head(text: string, n: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

/**
 * 채널 글의 **첫 줄을 제목으로** 쓴다. 텔레그램 글은 첫 줄이 제목 노릇을 하는 경우가
 * 많고(머리말·종목명), 아니면 그냥 본문 앞부분이라 어느 쪽이든 손해가 없다.
 */
function titleOf(text: string): string {
  const first = text.split("\n").map((l) => l.trim()).find((l) => l.length > 0) ?? "";
  return head(first || text, 80);
}

export async function newsFeed(minutes = 180, limit = 120): Promise<NewsFeed> {
  /*
   * 주요뉴스 두 쪽. 두 쪽인 것은 **6시간 창까지 덮기** 위해서다(1쪽만으로는 두어 시간치).
   * 한 쪽이 실패해도 나머지로 그린다 — 뉴스가 통째로 비는 것보다 낫다.
   */
  const [p1, p2, ch] = await Promise.all([
    naverNews("main", 1).catch(() => ({ items: [], hasMore: false })),
    naverNews("main", 2).catch(() => ({ items: [], hasMore: false })),
    recentChannel(minutes).catch(() => ({ messages: [], scanned: 0, newest: null })),
  ]);

  const cutoff = Date.now() - minutes * 60_000;
  const items: FeedItem[] = [];

  const seenLink = new Set<string>();
  for (const it of [...p1.items, ...p2.items]) {
    const t = Date.parse(it.at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    /* 두 쪽이 겹칠 때가 있다(그 사이에 새 기사가 올라오면 한 칸씩 밀린다) */
    if (!it.link || seenLink.has(it.link)) continue;
    seenLink.add(it.link);
    items.push({
      kind: "news",
      at: it.at,
      title: head(it.title, 120),
      from: it.press,
      link: it.link,
      body: head(it.summary ?? "", 160),
      /* 사람이 추려 올린 목록이라 전부 주요다 — 갈래를 따로 달지 않는다 */
      major: true,
    });
  }
  const newsCount = items.length;

  for (const m of ch.messages) {
    const t = Date.parse(m.at);
    if (!Number.isFinite(t) || t < cutoff) continue;
    items.push({
      kind: "channel",
      at: m.at,
      title: titleOf(m.text),
      from: m.channelName,
      fromId: m.channelId,
      link: m.link,
      body: head(m.text, 200),
    });
  }
  const channelCount = items.length - newsCount;

  /* 최신이 위 — 「지금」을 보는 자리다 */
  items.sort((a, b) => b.at.localeCompare(a.at));

  return {
    items: items.slice(0, limit),
    newsCount,
    channelCount,
    minutes,
    at: new Date().toISOString(),
  };
}
