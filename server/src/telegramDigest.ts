import type { ChannelMessage } from "./telegramReader.js";

/**
 * 채널 메시지 → AI에 넣을 만한 것만 골라내기.
 *
 * 180개 채널이면 하루 수천 건이 나온다. 그대로 Claude에 보내면 호출당 $0.5가 넘고,
 * 정작 요약은 광고와 잡담에 파묻혀 나빠진다. 그래서 필터가 이 기능의 본체다.
 *
 * 순서:
 *   1. 명백한 쓰레기 제거 (광고·리딩방 홍보·초대링크)
 *   2. 같은 내용 묶기 — 채널끼리 퍼나르므로 중복이 매우 많다.
 *      **여러 채널이 같은 얘기를 하고 있다는 사실 자체가 가장 강한 신호**라
 *      묶으면서 버리는 게 아니라 "몇 개 채널이 다뤘는지"를 점수로 남긴다.
 *   3. 종목·키워드 매칭으로 점수화
 *   4. 상위 N건만 통과
 */

/** 리딩방·광고 패턴. 시황 정보가 아니라 판촉이다. */
const SPAM_PATTERNS: RegExp[] = [
  /무료\s*(입장|가입|체험|상담)/,
  /수익\s*인증/,
  /(리딩|픽|매매)\s*방/,
  /본방|입장링크|오픈채팅/,
  /t\.me\/joinchat/i,
  /카톡|카카오톡\s*문의/,
  /１:１|1:1\s*(상담|문의)/,
  /계좌\s*대여|대여계좌/,
  /수익률\s*\d{3,}\s*%/, // 세 자리 수익률 자랑
  /지금\s*바로\s*(신청|클릭)/,
  /광고|제휴\s*문의/,
];

/** 시황과 무관한 짧은 잡담 */
function isNoise(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return true; // "ㅋㅋ", "감사합니다" 류
  if (/^[?!.…\s~ㅋㅎㅜㅠ]+$/.test(t)) return true;
  return false;
}

function isSpam(text: string): boolean {
  return SPAM_PATTERNS.some((re) => re.test(text));
}

/**
 * 본문을 비교용으로 정규화.
 * 퍼나를 때 앞뒤에 채널명·이모지·링크를 덧붙이는 경우가 많아서 그걸 걷어낸다.
 */
function normalize(text: string): string {
  return text
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[#*_~`>\[\]()]/g, "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** 앞부분 지문으로 같은 글인지 판단 — 완전 일치만 보면 퍼나르기를 못 잡는다 */
function fingerprint(text: string): string {
  const n = normalize(text);
  return n.slice(0, 60);
}

/** 중요도 가중치 — 뉴스 점수화와 같은 사고방식 */
const IMPACT_WEIGHTS: [RegExp, number][] = [
  [/상한가|하한가|급등|급락|폭등|폭락/, 6],
  [/신고가|신저가|52주/, 5],
  [/유상증자|무상증자|자사주|액면분할|감자/, 5],
  [/수주|계약\s*체결|공급\s*계약|납품/, 5],
  [/실적|영업이익|어닝|매출액/, 4],
  [/공시|정정공시/, 4],
  [/인수|합병|M&A|지분\s*취득/, 4],
  [/금리|FOMC|CPI|고용지표|연준|파월/, 4],
  [/외국인|기관|수급|순매수|순매도/, 3],
  [/승인|허가|임상|FDA/, 4],
  [/관세|수출|규제|정책/, 3],
];

export interface ScoredChannelItem {
  /** 대표 메시지 */
  text: string;
  /** 가장 최근에 언급된 시각 — 화면과 감쇠는 이걸 쓴다 */
  at: string;
  /** 이 얘기가 처음 돈 시각. at 과 벌어져 있으면 계속 회자되는 중이라는 뜻 */
  firstAt: string;
  /** 이 내용을 다룬 채널들 */
  channels: string[];
  /** 대표 메시지가 올라온 채널 */
  channelName: string;
  /** 원문으로 가는 링크 (없을 수 있다) */
  link: string;
  /** 몇 개 채널이 다뤘는지 — 이게 가장 강한 신호 */
  coverage: number;
  /** 언급된 관심종목 */
  mentions: string[];
  score: number;
}

/**
 * ISO 시각을 **한국 시각 HH:MM** 으로.
 *
 * `at` 은 toISOString() 으로 만든 UTC 문자열이라 `slice(11,16)` 하면 UTC 시:분이 나온다.
 * 그래서 13:31 에 올라온 메시지가 화면에 04:31 로 찍혔고, 새벽 것만 보인다고 오해하게 됐다.
 */
export function hhmmKst(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const kst = new Date(d.getTime() + 9 * 3600_000);
  return `${String(kst.getUTCHours()).padStart(2, "0")}:${String(kst.getUTCMinutes()).padStart(2, "0")}`;
}

/** 발행이 오래될수록 깎는다 (기본 반감기 3시간) */
function recencyFactor(iso: string, halfLifeHours = 3): number {
  if (!iso) return 0.5;
  const hours = (Date.now() - new Date(iso).getTime()) / 3600_000;
  if (hours < 0) return 1;
  return 1 / (1 + hours / halfLifeHours);
}

/**
 * 메시지 뭉치를 점수순으로 정리한다.
 *
 * @param watchNames 관심종목 이름 — 여기 걸리면 크게 가산한다
 * @param limit 통과시킬 최대 건수. AI 비용의 상한선 역할
 */
export function scoreMessages(
  messages: ChannelMessage[],
  watchNames: string[] = [],
  limit = 60,
): ScoredChannelItem[] {
  // 1) 쓰레기 걸러내기
  const clean = messages.filter((m) => !isSpam(m.text) && !isNoise(m.text));

  /*
   * 2) 같은 내용 묶기.
   *
   * 대표를 "가장 이른 것"으로 잡았더니 신선도가 망가졌다. 00:55에 한 번 돌고
   * 09:30에 다시 돈 얘기가 00:55로 표시되고, 감쇠 계산도 그 시각으로 해서
   * 클러스터 전체가 낡은 것으로 깎였다 — 오전 10시에 열어도 새벽 것만 보였다.
   *
   * 그래서 시각을 둘로 나눈다.
   *   firstAt — 처음 돈 시각 (언제부터 있던 얘기인지)
   *   at      — 가장 최근 언급 (화면 표시와 감쇠는 이쪽)
   * 본문은 가장 최근 것을 쓴다. 같은 사건이라도 나중 글에 진행 상황이 더 담긴다.
   */
  const groups = new Map<
    string,
    { rep: ChannelMessage; firstAt: string; channels: Set<string> }
  >();
  for (const m of clean) {
    const key = fingerprint(m.text);
    if (!key) continue;
    const g = groups.get(key);
    if (g) {
      g.channels.add(m.channelName);
      if (m.at > g.rep.at) g.rep = m;
      if (m.at < g.firstAt) g.firstAt = m.at;
    } else {
      groups.set(key, { rep: m, firstAt: m.at, channels: new Set([m.channelName]) });
    }
  }

  // 3) 점수화
  const items: ScoredChannelItem[] = [];
  for (const g of groups.values()) {
    const text = g.rep.text;
    const coverage = g.channels.size;

    let impact = 0;
    for (const [re, w] of IMPACT_WEIGHTS) if (re.test(text)) impact += w;

    const mentions = watchNames.filter((n) => n.length >= 2 && text.includes(n));
    const watchBonus = mentions.length > 0 ? 12 : 0;

    // 여러 채널이 동시에 다루면 크게 가산 — 로그를 써서 10개와 20개 차이가 과대평가되지 않게
    const coverageScore = Math.log2(coverage + 1) * 5;

    const score = (coverageScore + impact + watchBonus) * recencyFactor(g.rep.at);

    // 아무 신호도 없는 글은 버린다 — 채널 하나에만 뜬 잡담
    if (coverage === 1 && impact === 0 && mentions.length === 0) continue;

    items.push({
      text: text.slice(0, 400), // 긴 글은 잘라서 토큰을 아낀다
      at: g.rep.at,
      firstAt: g.firstAt,
      channelName: g.rep.channelName,
      link: g.rep.link,
      channels: [...g.channels].slice(0, 5),
      coverage,
      mentions,
      score,
    });
  }

  /*
   * 점수순으로 상위를 고르되, **내보낼 때는 최신순으로 다시 세운다.**
   * 무엇을 넣을지는 중요도가 정하고, 어떤 순서로 읽을지는 시간이 정하는 게 맞다.
   * 점수순 그대로 두면 오전에 열어도 새벽 글이 맨 위에 온다.
   */
  return items
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** AI 프롬프트에 넣을 텍스트로 — 토큰을 아끼려고 압축한다 */
export function toDigestText(items: ScoredChannelItem[]): string {
  if (items.length === 0) return "";
  return items
    .map((it) => {
      const head = it.coverage > 1 ? `[${it.coverage}개 채널]` : "";
      const mark = it.mentions.length > 0 ? `[관심:${it.mentions.join(",")}]` : "";
      const time = hhmmKst(it.at);
      // 처음 돈 시각과 30분 이상 벌어져 있으면 계속 회자되는 중이라는 뜻이라 같이 준다
      const since =
        new Date(it.at).getTime() - new Date(it.firstAt).getTime() > 30 * 60_000
          ? `(${hhmmKst(it.firstAt)}부터)`
          : "";
      return `${time}${since} ${head}${mark} ${it.text.replace(/\n+/g, " ").slice(0, 220)}`;
    })
    .join("\n");
}
