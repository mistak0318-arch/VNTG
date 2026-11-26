import { recent as recentChannel } from "./channelStore.js";
import { breakingNews, type BreakingCategory } from "./newsDisclosure.js";

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
 * ## 조회를 안 늘린다
 *
 * 뉴스는 `breakingNews`(속보 묶음, 자체 캐시)를, 채널은 `channelStore.recent`(파일)를
 * 쓴다. 둘 다 이미 다른 화면이 부르던 것이라 새로 긁는 것이 없다.
 */

export type FeedKind = "news" | "channel";

export interface FeedItem {
  kind: FeedKind;
  /** ISO 시각 — 섞는 유일한 기준 */
  at: string;
  title: string;
  /** 뉴스는 언론사, 채널은 방 이름 */
  from: string;
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
  const [news, ch] = await Promise.all([
    breakingNews().catch(() => ({ categories: [] as BreakingCategory[], fetchedAt: "" })),
    recentChannel(minutes).catch(() => ({ messages: [], scanned: 0, newest: null })),
  ]);

  const cutoff = Date.now() - minutes * 60_000;
  const items: FeedItem[] = [];

  for (const cat of news.categories) {
    for (const it of cat.items) {
      const t = Date.parse(it.publishedAt);
      if (!Number.isFinite(t) || t < cutoff) continue;
      items.push({
        kind: "news",
        at: it.publishedAt,
        title: head(it.title, 120),
        from: it.press,
        link: it.link,
        body: head(it.summary ?? "", 160),
        category: cat.label,
        major: it.major,
      });
    }
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
