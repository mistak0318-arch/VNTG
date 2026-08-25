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
  /무료\s*(입장|가입|체험|상담|추천)/,
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
  // 2026-08-25 보강 — 리딩방 판촉의 다른 얼굴들
  /VIP\s*(방|채널|반)/i,
  /선착순\s*\d+/,
  /입장\s*코드/,
  /(무료|공개)\s*방송/,
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

/**
 * 낱말 5개짜리 지문 여러 개 (2026-08-25).
 *
 * 앞 60자 지문 하나로는 **앞머리를 단 퍼나르기를 못 잡았다** — 채널들이 남의 글을
 * 나를 때 「★단독★」이나 자기 채널명을 앞에 붙이는데, 그러면 앞 60자가 달라져
 * 같은 얘기가 딴 묶음이 됐다. coverage(몇 채널이 다뤘나)가 가장 강한 신호인데
 * 그 수가 낮게 세지는 것이다.
 *
 * 낱말 5개 연속 조각을 **한 칸씩 밀며** 뜬다 — 앞에 뭘 붙여도 몸통 조각들은
 * 글자 그대로 같아서 겹친다. 조각 두 개 이상 겹쳐야 같은 얘기로 본다
 * (한 개는 「오늘 코스피 마감 시황 정리」 같은 상투구로도 겹친다).
 */
function shingles(text: string): string[] {
  const words = normalize(text)
    .split(" ")
    .filter((w) => w.length > 1);
  if (words.length < 5) return words.length > 0 ? [words.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i + 5 <= words.length && out.length < 24; i++) {
    out.push(words.slice(i, i + 5).join(" "));
  }
  return out;
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
  /*
   * 2026-08-25 보강 — 지라시방에서 실제로 주가를 흔드는데 목록에 없던 것들.
   * CB·블록딜은 **물량이 쏟아진다는 예고**라 채널에서 제일 먼저 도는 부류다.
   */
  [/전환사채|신주인수권|CB\s*발행|BW\s*발행/, 5],
  [/블록딜|시간외\s*대량/, 5],
  [/목표주가|투자의견|커버리지/, 3],
  [/무상증자\s*권리락|권리락/, 3],
  [/상장폐지|거래정지|불성실공시/, 6],
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
  /**
   * 본문에서 찾아낸 종목 — 관심종목뿐 아니라 **내 테마에 담긴 종목**까지 본다.
   * 비어 있으면 못 찾은 것이다 (화면에서 "알 수 없음"으로 표시한다).
   */
  stocks: string[];
  /** 위 종목들이 속한 내 테마 이름 */
  themes: string[];
  score: number;
}

/**
 * 메시지에서 종목·테마를 알아보기 위한 사전.
 *
 * 텔레그램 메시지는 "누가 언제"만으로는 판단이 안 된다. **무엇에 대한 얘기인지**가
 * 붙어야 읽을지 말지가 정해진다. 그런데 그 정보는 이미 우리 손에 있다 —
 * 내 테마에 어떤 종목이 담겼는지 우리가 정의해 뒀으니까.
 */
export interface TagIndex {
  /** 찾을 종목 이름들 (긴 것부터 — "삼성전자우"가 "삼성전자"보다 먼저 걸려야 한다) */
  names: string[];
  /** 종목 이름 → 그 종목이 속한 내 테마 이름들 */
  themeOf: Map<string, string[]>;
}

export function buildTagIndex(
  themes: { name: string; codes: string[] }[],
  nameOfCode: Map<string, string>,
): TagIndex {
  const themeOf = new Map<string, string[]>();
  for (const t of themes) {
    for (const code of t.codes) {
      const name = nameOfCode.get(code);
      if (!name || name.length < 2) continue;
      const arr = themeOf.get(name);
      if (arr) {
        if (!arr.includes(t.name)) arr.push(t.name);
      } else {
        themeOf.set(name, [t.name]);
      }
    }
  }
  // 긴 이름부터 매칭해야 "삼성전자우"를 "삼성전자"로 잘못 잡지 않는다
  const names = [...themeOf.keys()].sort((a, b) => b.length - a.length);
  return { names, themeOf };
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
  /** 내 테마 사전. 안 주면 종목·테마 표기 없이 예전처럼 동작한다 */
  tags: TagIndex = { names: [], themeOf: new Map() },
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
  interface Group {
    rep: ChannelMessage;
    firstAt: string;
    channels: Set<string>;
  }
  const groups = new Map<number, Group>();
  /** 조각 지문 → 묶음 번호. 앞머리를 단 퍼나르기도 몸통 조각으로 걸린다 */
  const byShingle = new Map<string, number>();
  /** 앞 60자 지문 → 묶음 번호 — 조각으로 못 잡는 아주 짧은 글의 안전망 */
  const byPrefix = new Map<string, number>();
  let nextGid = 1;

  for (const m of clean) {
    const fps = shingles(m.text);
    const prefix = fingerprint(m.text);
    if (fps.length === 0 && !prefix) continue;

    // 조각 두 개 이상 겹치는 묶음을 찾는다 (조각이 하나뿐인 짧은 글은 한 개로도)
    const votes = new Map<number, number>();
    for (const fp of fps) {
      const gid = byShingle.get(fp);
      if (gid) votes.set(gid, (votes.get(gid) ?? 0) + 1);
    }
    const need = fps.length <= 1 ? 1 : 2;
    let gid = 0;
    let best = 0;
    for (const [g, v] of votes) {
      if (v >= need && v > best) {
        gid = g;
        best = v;
      }
    }
    if (!gid && prefix) gid = byPrefix.get(prefix) ?? 0;

    if (gid) {
      const g = groups.get(gid)!;
      g.channels.add(m.channelName);
      if (m.at > g.rep.at) g.rep = m;
      if (m.at < g.firstAt) g.firstAt = m.at;
    } else {
      gid = nextGid++;
      groups.set(gid, { rep: m, firstAt: m.at, channels: new Set([m.channelName]) });
    }
    // 이 글의 지문을 그 묶음에 등록 — 다음 퍼나르기가 여기로 붙는다
    for (const fp of fps) if (!byShingle.has(fp)) byShingle.set(fp, gid);
    if (prefix && !byPrefix.has(prefix)) byPrefix.set(prefix, gid);
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

    /*
     * 내 테마에 담긴 종목까지 찾는다. 관심종목은 이미 담은 것이고, 테마 종목은
     * **아직 안 담았지만 내가 보고 있는 판**이다 — 그쪽 소식이 오히려 새롭다.
     * 긴 이름부터 훑고 이미 잡힌 이름에 포함되는 건 건너뛴다("삼성전자"가
     * "삼성전자우"를 잡아낸 뒤 또 걸리지 않게).
     */
    const stocks: string[] = [];
    for (const name of tags.names) {
      if (!text.includes(name)) continue;
      if (stocks.some((s) => s.includes(name))) continue;
      stocks.push(name);
      if (stocks.length >= 4) break;
    }
    for (const m of mentions) if (!stocks.some((s) => s.includes(m))) stocks.push(m);

    const themes = [...new Set(stocks.flatMap((s) => tags.themeOf.get(s) ?? []))].slice(0, 3);
    // 내 테마가 걸리면 관심종목만큼은 아니어도 올려준다
    const themeBonus = themes.length > 0 ? 6 : 0;

    // 여러 채널이 동시에 다루면 크게 가산 — 로그를 써서 10개와 20개 차이가 과대평가되지 않게
    const coverageScore = Math.log2(coverage + 1) * 5;

    const score = (coverageScore + impact + watchBonus + themeBonus) * recencyFactor(g.rep.at);

    // 아무 신호도 없는 글은 버린다 — 채널 하나에만 뜬 잡담
    if (coverage === 1 && impact === 0 && mentions.length === 0 && themes.length === 0) continue;

    items.push({
      text: text.slice(0, 400), // 긴 글은 잘라서 토큰을 아낀다
      at: g.rep.at,
      firstAt: g.firstAt,
      channelName: g.rep.channelName,
      link: g.rep.link,
      channels: [...g.channels].slice(0, 5),
      coverage,
      mentions,
      stocks: stocks.slice(0, 4),
      themes,
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
      // 220 → 180자. 텔레그램 메시지는 앞머리에 요지가 오므로 뒤쪽은 대개 부연이다
      return `${time}${since} ${head}${mark} ${it.text.replace(/\n+/g, " ").slice(0, 180)}`;
    })
    .join("\n");
}
