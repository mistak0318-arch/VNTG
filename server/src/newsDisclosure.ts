import AdmZip from "adm-zip";
import { XMLParser } from "fast-xml-parser";
import { recordApiCall } from "./apiUsage.js";

/**
 * 뉴스(네이버 검색 API)와 공시(DART OpenAPI).
 *
 * - 뉴스 본문은 저장/표시하지 않는다 (저작권). 제목·언론사·시각·원문 링크만.
 * - DART는 자체 고유번호(corp_code)를 쓰므로 종목코드 ↔ corp_code 매핑을 받아 캐싱한다.
 * - 뉴스 탭과 종목 상세가 같은 함수·같은 캐시를 쓴다 (중복 호출 방지).
 */

const NAVER_NEWS_URL = "https://naverapihub.apigw.ntruss.com/search/v1/news";
const DART_BASE = "https://opendart.fss.or.kr/api";

export interface NewsItem {
  title: string;
  press: string;
  link: string; // 네이버 뉴스 링크 (없으면 원문)
  originalLink: string;
  publishedAt: string; // ISO
  major: boolean; // 주요 언론사 여부
  /** 기사 요약 미리보기 (네이버가 주는 발췌문. 저작권 때문에 본문 전체는 쓰지 않는다) */
  summary: string;
}

export interface DisclosureItem {
  reportName: string;
  filerName: string;
  receiptDate: string; // YYYYMMDD
  receiptNo: string;
  url: string; // DART 원문
}

/** 네이버 응답의 <b> 태그와 HTML 엔티티를 제거 */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&#39;/g, "'")
    .trim();
}

// ---------------------------------------------------------------- 언론사 사전

/**
 * 네이버 검색 API는 언론사명을 주지 않고 원문 링크만 준다.
 * 도메인 → 언론사명 사전을 두고, 증시 기사에서 신뢰도가 높은 곳을 major로 표시한다.
 * 사전에 없으면 도메인을 그대로 언론사명으로 쓰고 major=false.
 */
const PRESS_DIRECTORY: Array<[domain: string, name: string, major: boolean]> = [
  // 통신사
  ["yna.co.kr", "연합뉴스", true],
  ["yonhapnewstv.co.kr", "연합뉴스TV", true],
  ["einfomax.co.kr", "연합인포맥스", true],
  ["newsis.com", "뉴시스", true],
  ["news1.kr", "뉴스1", true],
  // 경제·증권 전문지
  ["hankyung.com", "한국경제", true],
  ["wowtv.co.kr", "한국경제TV", true],
  ["mk.co.kr", "매일경제", true],
  ["sedaily.com", "서울경제", true],
  ["edaily.co.kr", "이데일리", true],
  ["mt.co.kr", "머니투데이", true],
  ["mtn.co.kr", "머니투데이방송", true],
  ["fnnews.com", "파이낸셜뉴스", true],
  ["asiae.co.kr", "아시아경제", true],
  ["heraldcorp.com", "헤럴드경제", true],
  ["biz.chosun.com", "조선비즈", true],
  ["chosunbiz.com", "조선비즈", true],
  ["businesspost.co.kr", "비즈니스포스트", true],
  ["thebell.co.kr", "더벨", true],
  ["etoday.co.kr", "이투데이", true],
  ["ajunews.com", "아주경제", true],
  ["dt.co.kr", "디지털타임스", true],
  ["etnews.com", "전자신문", true],
  ["newspim.com", "뉴스핌", true],
  ["newstomato.com", "뉴스토마토", true],
  ["viva100.com", "브릿지경제", true],
  ["econovill.com", "이코노믹리뷰", true],
  ["fntimes.com", "한국금융신문", true],
  ["ebn.co.kr", "EBN", true],
  ["inews24.com", "아이뉴스24", true],
  ["zdnet.co.kr", "지디넷코리아", true],
  ["theguru.co.kr", "더구루", true],
  ["paxnetnews.com", "팍스넷뉴스", true],
  // 종합일간지
  ["chosun.com", "조선일보", true],
  ["joongang.co.kr", "중앙일보", true],
  ["donga.com", "동아일보", true],
  ["hani.co.kr", "한겨레", true],
  ["khan.co.kr", "경향신문", true],
  ["seoul.co.kr", "서울신문", true],
  ["kmib.co.kr", "국민일보", true],
  ["munhwa.com", "문화일보", true],
  ["segye.com", "세계일보", true],
  ["hankookilbo.com", "한국일보", true],
  ["naeil.com", "내일신문", true],
  // 방송
  ["kbs.co.kr", "KBS", true],
  ["imbc.com", "MBC", true],
  ["sbs.co.kr", "SBS", true],
  ["sbsbiz.co.kr", "SBS Biz", true],
  ["ytn.co.kr", "YTN", true],
  ["mbn.co.kr", "MBN", true],
  ["jtbc.co.kr", "JTBC", true],
  ["tvchosun.com", "TV조선", true],
  ["ichannela.com", "채널A", true],
  ["cbs.co.kr", "노컷뉴스", true],
  ["nocutnews.co.kr", "노컷뉴스", true],
  // 그 밖에 자주 등장하지만 주요로는 보지 않는 곳 (이름만 예쁘게)
  ["dailian.co.kr", "데일리안", false],
  ["tf.co.kr", "더팩트", false],
  ["ilyo.co.kr", "일요신문", false],
  ["sisajournal-e.com", "시사저널e", false],
  ["skyedaily.com", "스카이데일리", false],
  ["g-enews.com", "글로벌이코노믹", false],
  ["m-economynews.com", "M이코노미", false],
  ["news.mtn.co.kr", "머니투데이방송", true],
];

/** 원문 링크의 도메인으로 언론사명과 등급을 찾는다 */
function pressFromLink(originalLink: string): { press: string; major: boolean } {
  let host = "";
  try {
    host = new URL(originalLink).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return { press: "", major: false };
  }
  // 서브도메인까지 포함해 뒤에서부터 매칭 (biz.chosun.com이 chosun.com보다 먼저 잡히도록 긴 것 우선)
  let best: [string, string, boolean] | null = null;
  for (const entry of PRESS_DIRECTORY) {
    if (host === entry[0] || host.endsWith(`.${entry[0]}`)) {
      if (!best || entry[0].length > best[0].length) best = entry;
    }
  }
  if (best) return { press: best[1], major: best[2] };
  return { press: host, major: false };
}

/** 기사로 보기 어려운 홍보·리딩방 유인성 제목 */
const SPAM_PATTERNS = [
  /무료\s*(추천|상담|체험|공개|진단)/,
  /리딩\s*(방|서비스)?/,
  /수익률\s*(인증|공개|대박)/,
  /(급등주|추천주|대장주)\s*(무료|공개|포착|안내)/,
  /선착순/,
  /지금\s*바로\s*(확인|신청)/,
  /카톡|오픈톡|텔레그램\s*방/,
  /^\[?(부고|인사|동정|알림)\]?/,
];

function isSpamTitle(title: string): boolean {
  return SPAM_PATTERNS.some((re) => re.test(title));
}

/** 같은 기사가 여러 매체에 실릴 때 걸러내기 위한 제목 정규화 */
function normalizeTitle(title: string): string {
  return title
    .replace(/\[[^\]]*\]/g, "") // [특징주], [속보] 같은 머리표 제거
    .replace(/[^가-힣a-zA-Z0-9]/g, "")
    .toLowerCase();
}

// ---------------------------------------------------------------- 뉴스

const newsCache = new Map<string, { data: NewsItem[]; at: number }>();
const NEWS_TTL_MS = 5 * 60_000;

export interface NewsOptions {
  /** 주요 언론사만 (기본 true) */
  majorOnly?: boolean;
  /** 반환 건수 */
  limit?: number;
}

/**
 * 네이버에서 최대 100건을 한 번만 받아 캐싱하고, 필터는 그 위에서 적용한다.
 * 주요/전체 토글을 눌러도 API 호출이 늘지 않는다.
 */
async function fetchNewsRaw(query: string): Promise<NewsItem[]> {
  const hit = newsCache.get(query);
  if (hit && Date.now() - hit.at < NEWS_TTL_MS) return hit.data;

  const id = process.env.NAVER_CLIENT_ID;
  const secret = process.env.NAVER_CLIENT_SECRET;
  if (!id || !secret) {
    throw new Error("NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 환경변수가 설정되지 않았습니다.");
  }

  const url = `${NAVER_NEWS_URL}?query=${encodeURIComponent(query)}&display=100&sort=date`;
  const res = await fetch(url, {
    headers: { "X-NCP-APIGW-API-KEY-ID": id, "X-NCP-APIGW-API-KEY": secret },
  });
  if (!res.ok) {
    void recordApiCall("naver", "search/news", res.status === 429 ? "rateLimited" : "failed");
    throw new Error(`네이버 뉴스 검색 실패: HTTP ${res.status} ${await res.text()}`);
  }
  void recordApiCall("naver", "search/news", "ok");
  const body = (await res.json()) as { items?: Array<Record<string, string>> };
  const items = (body.items ?? []).map((it) => {
    const { press, major } = pressFromLink(it.originallink ?? "");
    return {
      title: stripTags(it.title ?? ""),
      press,
      major,
      link: it.link || it.originallink || "",
      originalLink: it.originallink ?? "",
      publishedAt: it.pubDate ? new Date(it.pubDate).toISOString() : "",
      summary: stripTags(it.description ?? ""),
    };
  });

  newsCache.set(query, { data: items, at: Date.now() });
  return items;
}

export async function searchNews(query: string, opts: NewsOptions = {}): Promise<NewsItem[]> {
  const { majorOnly = true, limit = 30 } = opts;
  const raw = await fetchNewsRaw(query);

  const seen = new Set<string>();
  const out: NewsItem[] = [];
  for (const item of raw) {
    if (isSpamTitle(item.title)) continue;
    if (majorOnly && !item.major) continue;
    const key = normalizeTitle(item.title);
    if (key.length > 0 && seen.has(key)) continue; // 같은 기사 중복 제거
    seen.add(key);
    out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** 주요 언론사 필터를 켰을 때 몇 건이 걸러졌는지 UI에 알려주기 위한 집계 */
export async function newsCounts(query: string): Promise<{ major: number; all: number }> {
  const raw = (await fetchNewsRaw(query)).filter((i) => !isSpamTitle(i.title));
  const seen = new Set<string>();
  let major = 0;
  let all = 0;
  for (const item of raw) {
    const key = normalizeTitle(item.title);
    if (key.length > 0 && seen.has(key)) continue;
    seen.add(key);
    all += 1;
    if (item.major) major += 1;
  }
  return { major, all };
}

// ---------------------------------------------------------------- DART corp_code 매핑

let corpMap: { map: Map<string, string>; at: number } | null = null;
const CORP_MAP_TTL_MS = 24 * 3600 * 1000;
let corpMapPending: Promise<Map<string, string>> | null = null;

/** 종목코드(6자리) -> DART corp_code 매핑. 전체 목록 ZIP을 받아 하루 캐싱한다. */
async function getCorpMap(): Promise<Map<string, string>> {
  if (corpMap && Date.now() - corpMap.at < CORP_MAP_TTL_MS) return corpMap.map;
  if (corpMapPending) return corpMapPending;

  corpMapPending = (async () => {
    const key = process.env.DART_API_KEY;
    if (!key) throw new Error("DART_API_KEY 환경변수가 설정되지 않았습니다.");

    const res = await fetch(`${DART_BASE}/corpCode.xml?crtfc_key=${key}`);
    if (!res.ok) {
      void recordApiCall("dart", "corpCode.xml", "failed");
      throw new Error(`DART 고유번호 조회 실패: HTTP ${res.status}`);
    }
    void recordApiCall("dart", "corpCode.xml", "ok");

    const buf = Buffer.from(await res.arrayBuffer());
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith(".xml"));
    if (!entry) throw new Error("DART 고유번호 ZIP에 XML이 없습니다.");

    const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });
    const parsed = parser.parse(entry.getData().toString("utf-8")) as {
      result?: { list?: Array<{ corp_code?: string; stock_code?: string }> };
    };
    const list = parsed.result?.list ?? [];

    const map = new Map<string, string>();
    for (const item of list) {
      const stock = String(item.stock_code ?? "").trim();
      const corp = String(item.corp_code ?? "").trim();
      // 상장사만 (비상장은 stock_code가 비어 있음)
      if (stock && corp) map.set(stock, corp);
    }
    corpMap = { map, at: Date.now() };
    corpMapPending = null;
    return map;
  })().catch((err) => {
    corpMapPending = null;
    throw err;
  });

  return corpMapPending;
}

/** 종목코드로 DART 고유번호를 찾는다. 상장사가 아니면 undefined */
export async function getCorpCode(stockCode: string): Promise<string | undefined> {
  const map = await getCorpMap();
  return map.get(stockCode);
}

// ---------------------------------------------------------------- 공시

const disclosureCache = new Map<string, { data: DisclosureItem[]; at: number }>();
const DISCLOSURE_TTL_MS = 10 * 60_000;

function daysAgoYyyymmdd(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${m}${day}`;
}

export async function getDisclosures(stockCode: string, days = 180): Promise<DisclosureItem[]> {
  const key = `${stockCode}:${days}`;
  const hit = disclosureCache.get(key);
  if (hit && Date.now() - hit.at < DISCLOSURE_TTL_MS) return hit.data;

  const apiKey = process.env.DART_API_KEY;
  if (!apiKey) throw new Error("DART_API_KEY 환경변수가 설정되지 않았습니다.");

  const map = await getCorpMap();
  const corpCode = map.get(stockCode);
  if (!corpCode) return []; // DART에 없는 종목 (ETF/ETN 등)

  const url =
    `${DART_BASE}/list.json?crtfc_key=${apiKey}&corp_code=${corpCode}` +
    `&bgn_de=${daysAgoYyyymmdd(days)}&page_count=100`;
  const res = await fetch(url);
  if (!res.ok) {
    void recordApiCall("dart", "list.json", "failed");
    throw new Error(`DART 공시 조회 실패: HTTP ${res.status}`);
  }
  void recordApiCall("dart", "list.json", "ok");

  const body = (await res.json()) as {
    status?: string;
    message?: string;
    list?: Array<Record<string, string>>;
  };
  // status 013 = 조회된 데이터가 없음 (정상 상황)
  if (body.status === "013") return [];
  if (body.status !== "000") {
    throw new Error(`DART 오류(${body.status}): ${body.message ?? ""}`);
  }

  const items = (body.list ?? []).map((it) => ({
    reportName: (it.report_nm ?? "").trim(),
    filerName: (it.flr_nm ?? "").trim(),
    receiptDate: it.rcept_dt ?? "",
    receiptNo: it.rcept_no ?? "",
    url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${it.rcept_no ?? ""}`,
  }));

  disclosureCache.set(key, { data: items, at: Date.now() });
  return items;
}


// ---------------------------------------------------------------- 섹터별 뉴스

/**
 * 투자자 관점으로 뉴스를 고른다.
 *
 * 단순 최신순은 쓸모가 없다. 실제로 판단에 쓰이는 건
 *  (1) 시장을 움직이는 사건이냐  (2) 여러 매체가 동시에 다뤘느냐
 *  (3) 내가 들고 있는 종목 얘기냐  — 이 셋이다.
 * 그래서 점수를 매겨 정렬하고, 중복 기사는 지우는 대신 "보도량"으로 환산한다.
 */
export interface NewsSector {
  key: string;
  label: string;
  /** 여러 질의를 던져 합친다. 한 단어로는 원하는 기사가 안 걸린다. */
  queries: string[];
  hints: string[];
}

export const NEWS_SECTORS: NewsSector[] = [
  {
    key: "market",
    label: "증시",
    queries: ["코스피 마감 시황", "특징주 급등", "외국인 기관 순매수"],
    hints: ["코스피", "코스닥", "증시", "지수", "상한가", "특징주", "외국인", "기관", "수급"],
  },
  {
    key: "global",
    label: "글로벌",
    queries: ["뉴욕증시 마감", "연준 FOMC 금리", "환율 달러"],
    hints: ["뉴욕", "나스닥", "다우", "S&P", "연준", "FOMC", "월가", "환율", "달러", "엔화", "위안"],
  },
  {
    key: "policy",
    label: "정책·금융",
    queries: ["한국은행 기준금리", "금융위원회 규제", "정부 지원 대책"],
    hints: ["금융위", "금감원", "한국은행", "기준금리", "정부", "규제", "세제", "국회", "대책"],
  },
  {
    key: "industry",
    label: "산업·기업",
    queries: ["기업 실적 발표 영업이익", "반도체 수주 계약", "신규 투자 증설"],
    hints: ["실적", "영업이익", "수주", "계약", "공급", "반도체", "수출", "증설", "인수", "합병"],
  },
  {
    key: "realestate",
    label: "부동산",
    queries: ["부동산 대책 아파트", "분양 청약 시장"],
    hints: ["부동산", "아파트", "분양", "전세", "청약", "재건축", "임대", "주택"],
  },
];

/**
 * 제목에 등장하면 주가에 직접 영향이 큰 단어들.
 * 값이 클수록 "장 열리면 바로 반응할" 사건에 가깝다.
 */
const IMPACT_WEIGHTS: [RegExp, number][] = [
  [/상한가|하한가|급등|급락|폭등|폭락/, 6],
  [/신고가|신저가|52주/, 5],
  [/어닝\s*서프라이즈|호실적|실적\s*(개선|쇼크)|영업이익.*(증가|감소|흑자|적자)/, 5],
  [/수주|공급\s*계약|대규모\s*계약|납품/, 5],
  [/유상증자|무상증자|자사주|배당|액면분할|주식병합/, 4],
  [/인수|합병|매각|지분\s*(취득|매입)/, 4],
  [/목표주가|투자의견|상향|하향/, 4],
  [/기준금리|금리\s*(인상|인하|동결)/, 4],
  [/FOMC|CPI|고용지표|물가/, 3],
  [/외국인.*순매수|기관.*순매수|프로그램.*순매수/, 3],
  [/공매도|대차잔고/, 3],
  [/상장|IPO|공모/, 2],
  [/실적\s*발표|컨센서스/, 2],
];

function impactScore(title: string): number {
  let score = 0;
  for (const [re, w] of IMPACT_WEIGHTS) if (re.test(title)) score += w;
  return score;
}

/**
 * 같은 사건인지 판정하기 위한 "사건 서명".
 *
 * 한국어 헤드라인은 표현이 제각각이라 단어 겹침만으로는 안 묶인다.
 * (예: "코스피 3.56% 급등, 6800선 회복" vs "[마감시황] 코스피, 외국인 순매수에 3%대 상승")
 * 그래서 주체(코스피/코스닥/종목명) + 방향(급등/급락) + 등락률 정수부를 뽑아 서명으로 쓴다.
 */
const SUBJECTS = ["코스피", "코스닥", "나스닥", "다우", "S&P", "환율", "국제유가", "금값", "비트코인"];
const DIRECTIONS: [RegExp, string][] = [
  [/급등|폭등|강세|상승|오름|반등|회복/, "up"],
  [/급락|폭락|약세|하락|내림|조정/, "down"],
  [/순매수/, "buy"],
  [/순매도/, "sell"],
];

function eventSignature(title: string): string | null {
  const subject = SUBJECTS.find((x) => title.includes(x));
  if (!subject) return null;
  const dir = DIRECTIONS.find(([re]) => re.test(title))?.[1];
  if (!dir) return null;
  // "3.56%" / "3%대" → 3 (반올림 아닌 정수부. 매체마다 소수점 표기가 달라서)
  const pct = /(\d+(?:\.\d+)?)\s*%/.exec(title);
  const bucket = pct ? String(Math.floor(Number(pct[1]))) : "-";
  return `${subject}|${dir}|${bucket}`;
}

/** 제목을 단어 집합으로 — 서명이 안 나올 때 쓰는 보조 판정 */
function tokenSet(title: string): Set<string> {
  const cleaned = title.replace(/\[[^\]]*\]/g, " ").replace(/[^가-힣a-zA-Z0-9]/g, " ");
  return new Set(cleaned.split(/\s+/).filter((t) => t.length >= 2));
}

/** 길이 차이에 덜 민감한 겹침 비율 (작은 쪽 기준) */
function overlap(a: Set<string>, b: Set<string>): { ratio: number; count: number } {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  const min = Math.min(a.size, b.size);
  return { ratio: min === 0 ? 0 : inter / min, count: inter };
}

export interface ScoredNews extends NewsItem {
  /** 같은 사건을 다룬 매체 수 — 많을수록 시장이 주목한 뉴스 */
  coverage: number;
  /** 함께 보도한 다른 언론사 */
  alsoPress: string[];
  /** 내 관심종목 중 이 기사에 언급된 것 */
  mentions: string[];
  score: number;
}

export interface SectorNews {
  key: string;
  label: string;
  items: ScoredNews[];
}

/**
 * 비슷한 기사를 한 덩어리로 묶는다.
 * 대표 기사는 주요 언론사 > 제목이 구체적인 것(길이) 순으로 고른다.
 */
function cluster(items: NewsItem[]): { rep: NewsItem; members: NewsItem[] }[] {
  const groups: { rep: NewsItem; sig: string | null; tokens: Set<string>; members: NewsItem[] }[] = [];

  for (const it of items) {
    const sig = eventSignature(it.title);
    const tk = tokenSet(it.title);

    // 1순위: 사건 서명이 같으면 같은 사건
    // 2순위: 서명이 없으면 단어 겹침으로 (작은 쪽 기준 55% 이상 & 3단어 이상)
    const hit = groups.find((g) => {
      if (sig && g.sig) return g.sig === sig;
      const o = overlap(g.tokens, tk);
      return o.ratio >= 0.55 && o.count >= 3;
    });

    if (hit) {
      hit.members.push(it);
      const better =
        (it.major && !hit.rep.major) ||
        (it.major === hit.rep.major && it.title.length > hit.rep.title.length);
      if (better) {
        hit.rep = it;
        hit.tokens = tk;
      }
    } else {
      groups.push({ rep: it, sig, tokens: tk, members: [it] });
    }
  }
  return groups.map((g) => ({ rep: g.rep, members: g.members }));
}

/**
 * 발행이 오래될수록 점수를 깎는다.
 * halfLife가 작을수록 최신 기사에 유리하다 — 화면 성격에 따라 다르게 준다.
 */
function recencyFactor(iso: string, halfLifeHours = 6): number {
  if (!iso) return 0.5;
  const hours = (Date.now() - new Date(iso).getTime()) / 3600_000;
  if (hours < 0) return 1;
  return 1 / (1 + hours / halfLifeHours);
}

export async function sectorNews(
  opts: {
    majorOnly?: boolean;
    perSector?: number;
    watchNames?: string[];
    /**
     * importance: 오늘 중요했던 것 (리포트용)
     * recent: 최신 위주로 보되 중요도도 반영 (뉴스 탭용)
     */
    sort?: "importance" | "recent";
  } = {},
): Promise<{ sectors: SectorNews[]; fetchedAt: string }> {
  const { majorOnly = true, perSector = 25, watchNames = [], sort = "importance" } = opts;
  // 최신 위주로 볼 땐 감쇠를 세게 줘서 몇 시간 지난 기사가 위로 못 올라오게 한다
  const halfLife = sort === "recent" ? 1.5 : 6;

  const raw = await Promise.all(
    NEWS_SECTORS.map(async (sec) => {
      // 질의 여러 개를 합친다. 캐시가 질의 단위라 재호출 부담은 크지 않다.
      const lists = await Promise.all(
        sec.queries.map((q) =>
          searchNews(q, { majorOnly, limit: 40 }).catch(() => [] as NewsItem[]),
        ),
      );
      return { sec, items: lists.flat() };
    }),
  );

  // 어느 섹터에 넣을지 먼저 확정 (힌트 점수)
  const claimed = new Map<string, string>();
  for (const { sec, items } of raw) {
    for (const it of items) {
      const key = normalizeTitle(it.title);
      if (!key || claimed.has(key)) continue;
      let best = sec.key;
      let bestScore = 0;
      for (const s of NEWS_SECTORS) {
        const sc = s.hints.filter((h) => it.title.includes(h)).length;
        if (sc > bestScore) {
          bestScore = sc;
          best = s.key;
        }
      }
      claimed.set(key, best);
    }
  }

  const sectors: SectorNews[] = raw.map(({ sec, items }) => {
    const mine = items.filter((it) => claimed.get(normalizeTitle(it.title)) === sec.key);
    const groups = cluster(mine);

    const scored: ScoredNews[] = groups.map((g) => {
      const presses = [...new Set(g.members.map((m) => m.press).filter(Boolean))];
      const mentions = watchNames.filter((n) => g.rep.title.includes(n));

      // 보도량은 로그로 눌러서 "한 사건이 화면을 독점"하지 않게
      const coverageScore = Math.log2(presses.length + 1) * 4;
      const impact = impactScore(g.rep.title);
      const watchBonus = mentions.length > 0 ? 12 : 0; // 내 종목 얘기는 최우선
      const majorBonus = g.rep.major ? 2 : 0;
      const score =
        (coverageScore + impact + majorBonus + watchBonus) * recencyFactor(g.rep.publishedAt, halfLife);

      return {
        ...g.rep,
        coverage: presses.length,
        alsoPress: presses.filter((p) => p !== g.rep.press).slice(0, 4),
        mentions,
        score: Math.round(score * 10) / 10,
      };
    });

    scored.sort((a, b) => b.score - a.score);
    return { key: sec.key, label: sec.label, items: scored.slice(0, perSector) };
  });

  /**
   * "핵심" — 분야를 가리지 않고 오늘 가장 중요한 것만 모은다.
   * 분야별로 나눠 보면 정작 제일 중요한 기사가 다른 탭에 묻히는 문제가 있어서
   * 전 분야를 점수순으로 합친 목록을 맨 앞에 둔다.
   */
  const top = sectors
    .flatMap((s) => s.items)
    .sort((a, b) => b.score - a.score)
    .slice(0, perSector);

  return {
    sectors: [{ key: "top", label: "핵심", items: top }, ...sectors],
    fetchedAt: new Date().toISOString(),
  };

}
