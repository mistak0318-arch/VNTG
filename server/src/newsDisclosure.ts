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
