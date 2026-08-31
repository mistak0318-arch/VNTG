import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";
import { getCorpCode, getDisclosures, searchNews } from "./newsDisclosure.js";
import { stockProfile } from "./stockProfile.js";
import { themesOfStock } from "./naverThemes.js";
import { quarterFinance } from "./quarterFinance.js";
import { opinionBrief } from "./analystOpinion.js";
import { summarize } from "./summarize.js";

/**
 * 종목 정보 — **「이 회사가 뭐 하는 데더라」를 매번 검색하지 않게.**
 *
 * ## 왜 전 종목을 미리 채우지 않나
 *
 * 2,300종목을 한 번 채워 넣을 수는 있다. 하지만 「최근 동향」은 매주 바뀌어
 * **한 달 뒤면 거짓말**이 되고, 낡았다는 걸 화면이 알 방법도 없다.
 * **틀린 정보가 확신에 차서 떠 있는 게 없는 것보다 나쁘다.**
 *
 * 그래서 성격을 갈라 놓는다:
 *
 * | 무엇 | 성격 | 어디서 | 언제 |
 * |---|---|---|---|
 * | 설립·대표·본사·홈페이지 | 정적 | DART 기업개황 | 탭 열 때 (30일 캐시) |
 * | 표준산업분류 | 정적 | 한투 주식기본조회 | 탭 열 때 (같은 캐시) |
 * | 왜 이 테마인가 | 준정적 | **이미 있다** — 네이버 테마 편입 사유 | 조회 0회 |
 * | 최근 동향·이익 방향·목표주가 | 동적 | **이미 있다** — 뉴스·공시·분기재무·컨센서스 | **버튼 누를 때만** |
 *
 * 즉 새로 만든 것은 거의 없다. 조각들이 앱 안에 흩어져 있었을 뿐이고,
 * 이 파일이 하는 일은 **한 자리에 모으는 것**이다.
 *
 * ## ⚠️ AI 엮기는 자동이 아니라 버튼이다
 *
 * 벤티지 (2026-09-01): "버튼 하나 줘서 AI로 기업 정보 긁어오기 이런걸로 해가지고
 * 선택권을 줘. 그래야 토큰 아끼지."
 *
 * 종목을 열 때마다 저절로 부르면 **훑어보기만 해도 토큰이 나간다.** 종목발굴에서
 * 방향키로 백 종목을 넘기는 게 이 앱을 쓰는 방식인데, 그때마다 AI 가 돌면 안 된다.
 * 그래서 `companyBrief` 는 `run: true` 일 때만 실제로 부르고, 부른 결과는
 * **종목 + 날짜**로 캐시해서 같은 날 다시 눌러도 안 부른다.
 *
 * ## null 은 null 로 둔다
 *
 * DART 가 `ir_url: ""` 를 주는 것처럼 「없음」이 빈 문자열로 오는 자리가 많다.
 * 그걸 그대로 두면 화면이 빈 링크를 그린다. 여기서 전부 null 로 눕히고,
 * **못 받은 것과 빈 것을 구별하지 않는다** — 둘 다 화면에서는 「모른다」다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FACTS_FILE = join(DATA_DIR, "companyFacts.json");
const BRIEF_FILE = join(DATA_DIR, "companyBriefs.json");

const DART_BASE = "https://opendart.fss.or.kr/api";

/** 설립일·대표자는 하루 이틀에 안 바뀐다. 한 달에 한 번이면 충분하다 */
const FACTS_TTL_MS = 30 * 24 * 3600 * 1000;

/* ------------------------------------------------------------------ */
/* 정적 사실                                                            */
/* ------------------------------------------------------------------ */

export interface CompanyFacts {
  code: string;
  /** DART 정식 명칭 — "삼성전자(주)". 화면 제목은 종목명을 쓰고 이건 참고용 */
  corpName: string | null;
  corpNameEng: string | null;
  /** 대표자. "각자 대표이사 최문호, 김장우" 처럼 수식어가 붙어 오기도 한다 */
  ceo: string | null;
  /** 설립일 YYYYMMDD */
  establishedAt: string | null;
  /** 결산월 — "12" */
  accountMonth: string | null;
  address: string | null;
  /** 프로토콜이 없이 오기도 한다("www.kakaocorp.com") — 화면에서 붙인다 */
  homepage: string | null;
  irUrl: string | null;
  /** 유가증권 / 코스닥 / 코넥스 / 기타 */
  marketName: string | null;
  /** 표준산업분류 코드. 자리수가 제각각이다(264 · 28202 · 63120) */
  indutyCode: string | null;

  /* 한투 주식기본조회 — 지수업종 4단계. DART 는 코드만 주고 이름을 안 준다 */
  sectorLarge: string | null;
  sectorMid: string | null;
  sectorSmall: string | null;
  /** 표준산업분류 **이름** — "반도체 제조업" */
  industry: string | null;

  fetchedAt: string;
}

/** DART `corp_cls` 한 글자를 사람 말로 */
function marketOf(cls: string): string | null {
  if (cls === "Y") return "유가증권";
  if (cls === "K") return "코스닥";
  if (cls === "N") return "코넥스";
  if (cls === "E") return "기타";
  return null;
}

/** 빈 문자열·"-" 를 null 로 눕힌다 */
function t(v: unknown): string | null {
  const s = String(v ?? "").trim();
  return s && s !== "-" ? s : null;
}

type FactsStore = Record<string, CompanyFacts>;

let factsCache: FactsStore | null = null;

async function loadFacts(): Promise<FactsStore> {
  if (factsCache) return factsCache;
  try {
    factsCache = JSON.parse(await readOrEmpty(FACTS_FILE)) as FactsStore;
  } catch {
    factsCache = {};
  }
  return factsCache;
}

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await fs.readFile(file, "utf-8");
  } catch {
    return "{}";
  }
}

async function saveFacts(): Promise<void> {
  if (!factsCache) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FACTS_FILE, JSON.stringify(factsCache, null, 1), "utf-8");
}

/**
 * DART 기업개황 + 한투 표준산업분류.
 *
 * 둘 다 없어도 예외를 던지지 않는다 — 종목 화면이 이것 때문에 죽으면 안 된다.
 * 한투 쪽만 실패하면 DART 것만이라도 돌려준다(그 반대도 마찬가지).
 */
export async function companyFacts(code: string, force = false): Promise<CompanyFacts | null> {
  const store = await loadFacts();
  const hit = store[code];
  if (!force && hit && Date.now() - new Date(hit.fetchedAt).getTime() < FACTS_TTL_MS) return hit;

  /* 두 곳을 나란히 부른다. 한쪽이 넘어져도 다른 쪽은 살린다 */
  const [dart, profile] = await Promise.all([fetchDartCompany(code), stockProfile(code).catch(() => null)]);

  if (!dart && !profile) {
    // 아무것도 못 받았으면 **낡은 것이라도** 돌려준다. 빈 화면보다 낫다
    return hit ?? null;
  }

  const facts: CompanyFacts = {
    code,
    corpName: dart?.corpName ?? null,
    corpNameEng: dart?.corpNameEng ?? null,
    ceo: dart?.ceo ?? null,
    establishedAt: dart?.establishedAt ?? null,
    accountMonth: dart?.accountMonth ?? null,
    address: dart?.address ?? null,
    homepage: dart?.homepage ?? null,
    irUrl: dart?.irUrl ?? null,
    marketName: dart?.marketName ?? null,
    indutyCode: dart?.indutyCode ?? null,
    sectorLarge: profile?.sectorLarge ?? null,
    sectorMid: profile?.sectorMid ?? null,
    sectorSmall: profile?.sectorSmall ?? null,
    industry: profile?.industry ?? null,
    fetchedAt: new Date().toISOString(),
  };

  store[code] = facts;
  await saveFacts().catch(() => undefined);
  return facts;
}

interface DartCompany {
  corpName: string | null;
  corpNameEng: string | null;
  ceo: string | null;
  establishedAt: string | null;
  accountMonth: string | null;
  address: string | null;
  homepage: string | null;
  irUrl: string | null;
  marketName: string | null;
  indutyCode: string | null;
}

async function fetchDartCompany(code: string): Promise<DartCompany | null> {
  const key = process.env.DART_API_KEY?.trim();
  if (!key) return null;
  try {
    const corp = await getCorpCode(code);
    if (!corp) return null;

    const res = await fetch(`${DART_BASE}/company.json?crtfc_key=${key}&corp_code=${corp}`);
    if (!res.ok) {
      void recordApiCall("dart", "company.json", "failed");
      return null;
    }
    void recordApiCall("dart", "company.json", "ok");

    const j = (await res.json()) as Record<string, string>;
    // status 000 이 아니면 message 에 이유가 온다. 조용히 넘긴다
    if (String(j.status ?? "") !== "000") return null;

    return {
      corpName: t(j.corp_name),
      corpNameEng: t(j.corp_name_eng),
      ceo: t(j.ceo_nm),
      establishedAt: t(j.est_dt),
      accountMonth: t(j.acc_mt),
      address: t(j.adres),
      homepage: t(j.hm_url),
      irUrl: t(j.ir_url),
      marketName: marketOf(String(j.corp_cls ?? "").trim()),
      indutyCode: t(j.induty_code),
    };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* AI 엮기 — 버튼을 눌렀을 때만                                          */
/* ------------------------------------------------------------------ */

export interface CompanyBrief {
  code: string;
  name: string;
  /** 만든 날 YYYY-MM-DD (KST) — 같은 날이면 다시 안 부른다 */
  day: string;
  at: string;
  text: string;
  model: string | null;
  /** 무엇을 엮었는지. 화면이 「무엇을 근거로 썼나」를 보여 줄 수 있게 */
  sources: string[];
  inputTokens: number;
  outputTokens: number;
}

type BriefStore = Record<string, CompanyBrief>;

let briefCache: BriefStore | null = null;

async function loadBriefs(): Promise<BriefStore> {
  if (briefCache) return briefCache;
  try {
    briefCache = JSON.parse(await readOrEmpty(BRIEF_FILE)) as BriefStore;
  } catch {
    briefCache = {};
  }
  return briefCache;
}

async function saveBriefs(): Promise<void> {
  if (!briefCache) return;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(BRIEF_FILE, JSON.stringify(briefCache, null, 1), "utf-8");
}

/**
 * 모델이 남긴 부스러기를 턴다.
 *
 * 두 가지가 화면에 날것으로 보였다 (2026-09-01 첫 실행):
 *
 *   · `**1. 무슨 회사인가**` — 마크다운 굵게 기호. 화면은 마크다운을 안 그린다.
 *     프롬프트로도 막지만 모델이 습관처럼 붙이므로 여기서 한 번 더 턴다.
 *   · `**3.` — 출력 상한에 걸려 3번 제목만 남고 본문이 잘린 꼬리.
 *     **반쪽짜리 항목은 없느니만 못하다** — 있는 줄 알고 읽으려다 없는 걸 발견하게 된다.
 */
function cleanText(raw: string): string {
  let s = raw
    .replace(/\*\*/g, "")
    .replace(/^#{1,6}\s*/gm, "")
    .trim();

  /*
   * 마지막 줄이 제목만 남았으면(번호 + 몇 글자, 문장 부호 없이 끝남) 떼어낸다.
   * 「3. 이익은 어느 쪽으로」 까지만 있고 본문이 없는 상태가 그것이다.
   */
  const lines = s.split("\n");
  while (lines.length > 0) {
    const last = lines[lines.length - 1].trim();
    if (last === "" || /^\d+\.?\s*\S{0,20}$/.test(last)) {
      lines.pop();
      continue;
    }
    break;
  }
  s = lines.join("\n").trim();
  return s;
}

function kstDay(): string {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  return kst.toISOString().slice(0, 10);
}

/** 이미 만들어 둔 것 — 조회 0회. 화면이 열릴 때 이걸로 먼저 그린다 */
export async function cachedBrief(code: string): Promise<CompanyBrief | null> {
  const store = await loadBriefs();
  return store[code] ?? null;
}

/**
 * 조각을 모아 한 문단으로 엮는다.
 *
 * ⚠️ **부르는 쪽이 `run` 을 켜야만 실제로 돈다.** 안 켜면 캐시만 본다.
 *
 * 같은 날 이미 엮은 것이 있으면 그것을 돌려준다(`force` 로 넘길 수 있다).
 * 날이 바뀌면 「최근 동향」이 낡으므로 다시 엮을 값어치가 생긴다.
 */
export async function companyBrief(
  code: string,
  name: string,
  opts: { run?: boolean; force?: boolean; price?: number | null } = {},
): Promise<{ brief: CompanyBrief | null; ran: boolean; error?: string }> {
  const store = await loadBriefs();
  const today = kstDay();
  const hit = store[code] ?? null;

  if (!opts.run) return { brief: hit, ran: false };
  if (hit && hit.day === today && !opts.force) return { brief: hit, ran: false };

  /*
   * 재료를 모은다. **하나가 실패해도 나머지로 엮는다** — 목표주가가 없는 종목,
   * 테마에 안 들어간 종목, 공시가 뜸한 종목이 다 정상이다.
   */
  const [facts, themes, disclosures, news, quarters, opinion] = await Promise.all([
    companyFacts(code).catch(() => null),
    themesOfStock(code).catch(() => []),
    getDisclosures(code, 90).catch(() => []),
    searchNews(name).catch(() => []),
    quarterFinance(code, 4).catch(() => []),
    opinionBrief(code, opts.price ?? null).catch(() => null),
  ]);

  const sources: string[] = [];
  const parts: string[] = [];

  if (facts) {
    sources.push("DART 기업개황");
    const line = [
      facts.corpName ? `정식명 ${facts.corpName}` : null,
      facts.industry ? `표준산업분류 ${facts.industry}` : null,
      [facts.sectorLarge, facts.sectorMid, facts.sectorSmall].filter(Boolean).length
        ? `지수업종 ${[facts.sectorLarge, facts.sectorMid, facts.sectorSmall].filter(Boolean).join(" > ")}`
        : null,
      facts.establishedAt ? `설립 ${facts.establishedAt.slice(0, 4)}년` : null,
      facts.ceo ? `대표 ${facts.ceo}` : null,
      facts.marketName ? `시장 ${facts.marketName}` : null,
    ]
      .filter(Boolean)
      .join(" · ");
    if (line) parts.push(`[회사 기본]\n${line}`);
  }

  if (themes.length > 0) {
    sources.push("네이버 테마 편입 사유");
    const lines = themes
      .slice(0, 6)
      .map((th) => `- ${th.name}${th.desc ? `: ${th.desc}` : ""}`)
      .join("\n");
    parts.push(`[속한 테마와 편입 사유]\n${lines}`);
  }

  if (quarters.length > 0) {
    sources.push("분기 재무");
    const lines = quarters
      .slice(0, 4)
      .map(
        (q) =>
          `- ${q.label}: 매출 ${q.revenue ?? "-"}억 · 영업이익 ${q.operatingProfit ?? "-"}억` +
          `${q.margin !== null ? ` (이익률 ${q.margin}%)` : ""}` +
          `${q.yoy !== null ? ` · 전년동기 대비 ${q.yoy > 0 ? "+" : ""}${q.yoy}%` : ""}`,
      )
      .join("\n");
    parts.push(`[최근 분기 실적]\n${lines}`);
  }

  if (opinion) {
    sources.push("증권사 컨센서스");
    parts.push(
      `[목표주가]\n증권사 ${opinion.brokerCount}곳` +
        `${opinion.upside !== null ? ` · 현재가 대비 ${opinion.upside > 0 ? "+" : ""}${opinion.upside}%` : ""}` +
        `${opinion.recentMove > 0 ? " · 최근 상향 우세" : opinion.recentMove < 0 ? " · 최근 하향 있음" : ""}`,
    );
  }

  if (disclosures.length > 0) {
    sources.push("DART 공시 90일");
    const lines = disclosures
      .slice(0, 12)
      .map((d) => `- ${d.receiptDate} ${d.reportName}`)
      .join("\n");
    parts.push(`[최근 공시]\n${lines}`);
  }

  if (news.length > 0) {
    sources.push("뉴스");
    const lines = news
      .slice(0, 12)
      .map((n) => `- ${n.title}`)
      .join("\n");
    parts.push(`[최근 뉴스 제목]\n${lines}`);
  }

  if (parts.length === 0) {
    return { brief: hit, ran: false, error: "엮을 재료를 하나도 못 모았습니다" };
  }

  /*
   * 프롬프트.
   *
   * ⚠️ **투자 판단을 시키지 않는다.** 벤티지가 못을 박았다 —
   * "어차피 알고리즘에 기댈 건 아니었어. 분석은 내 몫이야. 보조도구로써 가치있는
   * 정보를 전달한다고 생각하면 되." 그래서 「사라/팔아라」도, 목표가도 안 만든다.
   * 하는 일은 **흩어진 사실을 읽기 좋게 잇는 것**뿐이다.
   *
   * 그리고 재료 밖의 것을 지어내지 말라고 명시한다 — 모델이 아는 회사면
   * 학습 지식으로 채우려 드는데, 그게 바로 「낡은 정보가 확신에 차서 떠 있는」
   * 상태를 만든다.
   */
  const prompt =
    `아래는 한국 주식 「${name}(${code})」에 대해 수집한 사실들이다.\n\n` +
    `${parts.join("\n\n")}\n\n` +
    `이 재료만 가지고 다음 세 가지를 한국어로 정리해라.\n\n` +
    `1. 무슨 회사인가 — 두세 문장. 어떤 제품·서비스로 돈을 버는지가 핵심이다.\n` +
    `2. 왜 지금 거론되는가 — 테마 편입 사유·공시·뉴스를 엮어 두세 문장.\n` +
    `   특별한 게 없으면 "특별한 이슈는 안 보인다"고 그대로 써라.\n` +
    `3. 이익은 어느 쪽으로 가고 있나 — 분기 실적 흐름을 한두 문장. 숫자를 인용해라.\n\n` +
    `규칙:\n` +
    `- 위 재료에 없는 사실을 지어내지 마라. 모르는 것은 "자료 없음"이라고 써라.\n` +
    `- 매수·매도 의견이나 목표주가를 만들지 마라. 사실 정리만 한다.\n` +
    `- **굵게** 나 ## 같은 마크다운 기호를 쓰지 마라. 화면이 그대로 글자로 보여 준다.\n` +
    `- 각 항목은 "1. 무슨 회사인가" 처럼 번호와 제목으로 시작하고, 그 아래 문단을 쓴다.\n` +
    `- 세 항목을 **반드시 다 쓴다.** 길이가 모자라면 각 항목을 줄여서라도 3번까지 끝내라.\n` +
    `- 전체 700자 이내.`;

  /*
   * ⚠️ **상한을 넉넉히 준다** (2026-09-01).
   *
   * 900 으로 뒀다가 첫 실행에서 **정확히 900 을 채우고 3번이 통째로 잘렸다** —
   * 화면에 `**3.` 만 남았다. 한글은 한 글자가 토큰 하나를 넘게 먹어서
   * 「700자 이내」가 900토큰에 안 들어간다.
   *
   * 잘리는 것은 길어지는 것보다 나쁘다. 세 항목 중 하나가 통째로 없는데
   * 화면에는 「엮었습니다」로 보이기 때문이다. 2,000 이면 700자가 넉넉히 들어가고,
   * 모델이 알아서 짧게 끝내면 그만큼만 청구된다(상한은 한도지 목표가 아니다).
   */
  const r = await summarize(prompt, 2000, "company");
  if (!r.text) {
    return { brief: hit, ran: false, error: r.error ?? "AI 응답이 비었습니다" };
  }

  const brief: CompanyBrief = {
    code,
    name,
    day: today,
    at: new Date().toISOString(),
    text: cleanText(r.text),
    model: r.usedModel ?? null,
    sources,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
  };
  store[code] = brief;
  await saveBriefs().catch(() => undefined);
  return { brief, ran: true };
}
