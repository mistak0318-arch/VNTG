import { buzzBoard, type BuzzBoardRow } from "./buzzRadar.js";
import { keywordFlow, type KeywordHit } from "./newsKeywords.js";
import { getBuzzConfig } from "./buzzScore.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getStockIndex } from "./stockListCache.js";

/**
 * 지금 시장의 화제 — **네 화면이 같은 말을 하게** (2026-08-30 요청).
 *
 * ## 왜 서버에서 만드나
 *
 * 장전 브리핑룸·마켓 브리핑·시황 대시보드·데일리 리포트가 각자 문장을 지으면
 * **같은 시각에 네 화면이 다른 말을 한다.** 「지금 관세로 시끄럽다」와 「조용하다」가
 * 나란히 떠 있으면 어느 쪽도 못 믿는다. 그래서 문장은 한 곳에서 만들고 화면은
 * 그걸 자기 크기에 맞게 잘라 쓴다.
 *
 * ## 두 귀를 하나로 합친다
 *
 * 채널(빠르다·투기적)과 뉴스(느리다·공식적)는 **편향 방향이 반대**라 따로 보면
 * 각자의 편향을 그대로 먹는다. 여기서는 낱말별로 양쪽 점수를 합치고,
 * **둘 다 뜬 것을 맨 위로** 올린다 — 빠른 쪽이 먼저 말하고 느린 쪽이 확인해 준
 * 것이라 질이 다르다.
 *
 * ## 화면마다 다르게 쓰라고 창을 나눈다
 *
 *   장전 브리핑룸 — 밤사이(12시간). 「자는 동안 무슨 일이 있었나」
 *   마켓 브리핑   — 지금(3시간).   「장중에 무엇이 도는가」
 *   시황 대시보드 — 지금(3시간).   카드 한 장이라 한 줄만
 *   데일리 리포트 — 발행 시점(6시간). 글로 읽는 것이라 근거를 더 붙인다
 */

export type PulseWindow = "overnight" | "now" | "today";

export interface PulseItem {
  term: string;
  kind: string;
  /** 어디서 떴나 */
  where: "both" | "channel" | "news";
  /** 채널 언급 수 (없으면 0) */
  buzzCount: number;
  /** 뉴스 건수 */
  newsCount: number;
  /** 몇 개 방 / 몇 개 매체 */
  sources: number;
  /** 두 귀를 합친 뜻밖의 정도 */
  score: number;
  /** 채널 쪽 평소 대비 배율 */
  buzzRatio: number;
  newsRatio: number;
  /** 처음 나온 말인가 (뉴스 쪽 판정) */
  fresh: boolean;
  codes: string[];
  /** 한 줄 근거 — 실제 문장이나 기사 제목 */
  quote: string | null;
  quoteFrom: string | null;
}

export interface TopicPulse {
  /**
   * 코드 → 종목명 (2026-09-09 — 벤티지 "종목코드가 보이네. 종목명이 보여야지.
   * 코드로는 무슨 종목인지 모르잖어").
   *
   * 여태 코드만 보냈다. 화면은 그걸 그대로 찍었고, 누를 때 종목명 자리에 **낱말**(term)을
   * 넘겨서 「관세」 같은 게 종목 이름으로 들어가기도 했다. 이름은 서버가 이미 전종목
   * 캐시로 알고 있으므로(`getStockIndex`) 여기서 붙여 보낸다 — 화면이 종목마다 따로
   * 물어보면 카드 하나에 조회가 여덟 번 난다.
   */
  names?: Record<string, string>;
  window: PulseWindow;
  /** 창 길이(시간) */
  hours: number;
  /** 「지금 무슨 일인가」 한 문장. 조용하면 조용하다고 말한다 */
  headline: string;
  /** 그 문장의 근거 한 줄 */
  detail: string;
  /** 뜨거운가 — 화면이 강조 여부를 정하는 데 쓴다 */
  hot: boolean;
  items: PulseItem[];
  /** 믿어도 되나 */
  health: {
    channelReady: boolean;
    newsReady: boolean;
    baselineDays: number;
    /** 창 안 채널 언급 수 */
    channelTotal: number;
    /** 창 안 기사 수 */
    newsArticles: number;
  };
  at: string;
}

const HOURS: Record<PulseWindow, number> = { overnight: 12, now: 3, today: 6 };

const KIND_LABEL: Record<string, string> = {
  myTheme: "내 테마",
  theme: "테마",
  stock: "종목",
  event: "사건",
  entity: "인물·국가",
  new: "새 낱말",
};

/**
 * 두 귀의 점수를 합친다.
 *
 * 그냥 더하면 한쪽만 아주 큰 것이 이긴다. **양쪽에 다 뜬 것에 웃돈**을 준다 —
 * 이 시스템이 「양쪽」을 값지게 보는 이유가 바로 그것이라 점수에도 반영해야
 * 화면 순서와 설명이 어긋나지 않는다.
 */
function combine(buzzZ: number, newsZ: number): number {
  const both = buzzZ > 0 && newsZ > 0;
  return (Math.max(buzzZ, 0) + Math.max(newsZ, 0)) * (both ? 1.35 : 1);
}

/**
 * 화면에 실을 **코드 → 종목명**. 조회는 안 는다 — 전종목 캐시를 읽을 뿐이다.
 * 못 읽으면 빈 지도다(화면이 코드를 그대로 보여 준다 — 없는 것보다 낫다).
 */
async function nameMapOf(items: PulseItem[], client?: KiwoomClient): Promise<Record<string, string>> {
  const codes = new Set<string>();
  for (const it of items) for (const c of it.codes) codes.add(c);
  if (codes.size === 0 || !client) return {};
  try {
    const idx = await getStockIndex(client);
    const out: Record<string, string> = {};
    for (const c of codes) {
      const hit = idx.get(c);
      if (hit?.name) out[c] = hit.name;
    }
    return out;
  } catch {
    return {};
  }
}

export async function topicPulse(window: PulseWindow = "now", client?: KiwoomClient): Promise<TopicPulse> {
  const hours = HOURS[window];
  const cfg = await getBuzzConfig();

  const [board, flow] = await Promise.all([
    buzzBoard(hours).catch(() => null),
    keywordFlow(hours * 60).catch(() => null),
  ]);

  const byTerm = new Map<string, PulseItem>();

  for (const r of (board?.rows ?? []) as BuzzBoardRow[]) {
    if (r.recent < 2) continue;
    byTerm.set(r.term, {
      term: r.term,
      kind: r.kind,
      where: "channel",
      buzzCount: r.recent,
      newsCount: 0,
      sources: r.channels,
      score: Math.max(r.z, 0),
      buzzRatio: r.ratio,
      newsRatio: 0,
      fresh: false,
      codes: r.codes,
      quote: null,
      quoteFrom: null,
    });
  }

  for (const h of (flow?.hits ?? []) as KeywordHit[]) {
    const prev = byTerm.get(h.term);
    const quote = h.samples[0];
    if (prev) {
      prev.where = "both";
      prev.newsCount = h.recent;
      prev.newsRatio = h.ratio;
      prev.fresh = h.fresh;
      prev.sources = Math.max(prev.sources, h.presses);
      prev.score = combine(prev.score, Math.max(h.z, 0));
      prev.quote = quote?.title ?? prev.quote;
      prev.quoteFrom = quote?.press ?? prev.quoteFrom;
      if (prev.codes.length === 0) prev.codes = h.codes;
    } else {
      byTerm.set(h.term, {
        term: h.term,
        kind: h.kind,
        where: "news",
        buzzCount: 0,
        newsCount: h.recent,
        sources: h.presses,
        score: Math.max(h.z, 0),
        buzzRatio: 0,
        newsRatio: h.ratio,
        fresh: h.fresh,
        codes: h.codes,
        quote: quote?.title ?? null,
        quoteFrom: quote?.press ?? null,
      });
    }
  }

  const items = [...byTerm.values()].sort((a, b) => b.score - a.score).slice(0, 12);
  const strong = items.filter((i) => i.score >= cfg.zMin);
  const baselineDays = Math.max(board?.baselineDays ?? 0, flow?.baselineDays ?? 0);

  const health = {
    channelReady: board?.reader ?? false,
    newsReady: (flow?.articles ?? 0) > 0,
    baselineDays,
    channelTotal: board?.total ?? 0,
    newsArticles: flow?.articles ?? 0,
  };

  const when = window === "overnight" ? "밤사이" : window === "today" ? "오늘" : `최근 ${hours}시간`;

  /* ── 문장 ────────────────────────────────────────────────────────────
   * 「조용하다」도 문장으로 말한다. 「없음」이라고만 하면 고장인지 조용한 건지
   * 모르고, 그러면 사람이 화면을 안 믿게 된다.
   */
  if (baselineDays < 2) {
    return {
      window,
      hours,
      headline: `${when} 화제를 아직 가늠할 수 없습니다`,
      detail:
        `평소를 알아야 「갑자기 커졌다」를 말할 수 있는데 기준선이 ${baselineDays}일뿐입니다. ` +
        `며칠 쌓이면 이 자리에서 알려 드립니다.`,
      hot: false,
      items,
      names: await nameMapOf(items, client),
      health,
      at: new Date().toISOString(),
    };
  }

  if (strong.length === 0) {
    const near = items[0];
    return {
      window,
      hours,
      headline: `${when}, 특별히 커진 화제는 없습니다`,
      detail: near
        ? `가장 눈에 띈 것은 「${near.term}」(${describeCounts(near)})이지만 평소 범위 안입니다.`
        : "채널도 뉴스도 조용합니다.",
      hot: false,
      items,
      names: await nameMapOf(items, client),
      health,
      at: new Date().toISOString(),
    };
  }

  const lead = strong[0];
  const rest = strong.slice(1, 3);
  const both = strong.filter((i) => i.where === "both");

  const headline =
    `${when} 시장은 「${lead.term}」` +
    (lead.fresh ? " 얘기가 처음 올라왔습니다" : `${josa(lead.term, "로")} 시끄럽습니다`) +
    (rest.length > 0 ? ` — ${rest.map((r) => `「${r.term}」`).join("·")}도 같이 커졌습니다` : "");

  const bits: string[] = [describeCounts(lead)];
  if (lead.where === "both") {
    bits.push("**채널과 뉴스 양쪽**에서 같이 떴습니다");
  } else if (lead.where === "channel") {
    bits.push("아직 채널에서만 도는 얘기입니다");
  } else {
    bits.push("뉴스에만 나온 얘기입니다");
  }
  if (both.length > 1) bits.push(`양쪽에서 뜬 것이 ${both.length}건`);

  return {
    window,
    hours,
    headline,
    detail: bits.join(" · "),
    hot: true,
    items,
    names: await nameMapOf(items, client),
    health,
    at: new Date().toISOString(),
  };
}

/**
 * 받침에 맞는 조사를 고른다.
 *
 * 「관세(으)로」처럼 괄호로 얼버무리면 기계가 쓴 티가 난다. 한글은 마지막 글자의
 * **받침 유무**로 조사가 갈리고, 계산은 유니코드 자리만 보면 된다:
 *
 *     (코드 − 0xAC00) % 28 === 0  →  받침 없음
 *
 * 「으로/로」만 예외가 하나 있다 — 받침이 **ㄹ**이면 「로」다(전력으로 ✗ / 전기로 ✓,
 * 「서울로」). 그 받침의 번호가 8이다.
 *
 * 한글이 아닌 글자로 끝나면(ETF, HBM 같은 약어) 받침을 알 수 없으므로 **받침 없음**
 * 쪽을 쓴다 — 「ETF로」가 「ETF으로」보다 자연스럽다.
 */
function josa(word: string, kind: "로" | "이" | "은" | "을"): string {
  const last = word.trim().slice(-1);
  const code = last.charCodeAt(0);
  const hangul = code >= 0xac00 && code <= 0xd7a3;
  const jong = hangul ? (code - 0xac00) % 28 : 0;

  switch (kind) {
    case "로":
      return jong === 0 || jong === 8 ? "로" : "으로";
    case "이":
      return jong === 0 ? "가" : "이";
    case "은":
      return jong === 0 ? "는" : "은";
    case "을":
      return jong === 0 ? "를" : "을";
  }
}

/** 「채널 16건(4개 방) · 뉴스 5건(3개 매체)」처럼 근거를 적는다 */
function describeCounts(i: PulseItem): string {
  const parts: string[] = [];
  if (i.buzzCount > 0) {
    parts.push(`채널 ${i.buzzCount}건${i.sources > 0 ? `(${i.sources}곳)` : ""}`);
  }
  if (i.newsCount > 0) parts.push(`뉴스 ${i.newsCount}건`);
  const ratio = Math.max(i.buzzRatio, i.newsRatio);
  if (ratio >= 2) parts.push(`평소의 ${ratio.toFixed(1)}배`);
  return parts.join(" · ") || `${KIND_LABEL[i.kind] ?? i.kind}`;
}
