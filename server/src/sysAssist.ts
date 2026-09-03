import type { KiwoomClient } from "./kiwoomClient.js";
import { getStockIndex, searchStocks } from "./stockListCache.js";
import { stockSummary } from "./stockSummary.js";
import { evaluateSignal, isNotTheme } from "./signalLight.js";
import { isIndexLikeTheme, themesOfStock } from "./naverThemes.js";
import { themeStrength } from "./themeStrength.js";
import { etfHoldersOf } from "./etfHolders.js";
import { getDisclosures, searchNews, breakingNews } from "./newsDisclosure.js";
import { searchChannels } from "./channelSearch.js";
import { searchMajorFeed } from "./majorFeed.js";
import { choiceFor } from "./aiConfig.js";
import { summarize } from "./summarize.js";
import { ASK_SYSTEM } from "./askMarket.js";
import { quarterFinance } from "./quarterFinance.js";
import { opinionBrief } from "./analystOpinion.js";
import { cachedBrief } from "./companyInfo.js";
import { listWatchlist } from "./watchlist.js";
import { getTrackedWatchlist } from "./watchTracking.js";
import { marketPulse } from "./marketPulse.js";
import { mainNews } from "./naverMainNews.js";
import { getSection } from "./marketOverview.js";
import { fetchAll as etfAll } from "./routes/etf.js";
import { askMarket, isAskConfigured, type AskResult, type AskTurn } from "./askMarket.js";
import { buildDigest } from "./aiSummary.js";
import { usMajorIndices } from "./usMajor.js";
import { getGlobalMarket } from "./globalMarket.js";
import { rateBoard } from "./rateBoard.js";
import { yahooChart } from "./yahooChart.js";
import { cisStats } from "./cisStats.js";
import { loadAccount } from "./cisAccount.js";
import { ACCOUNTS, type AccountId } from "./cisAccounts.js";
import { listDays } from "./cisJournal.js";
import { priceMap } from "./cisRun.js";
import { listSuperSignal } from "./superSignal.js";
import { addEvent, EVENT_KINDS, listEventsRange, upcomingEvents, type EventKind } from "./calendar.js";
import { todayDartEvents } from "./dartEvents.js";
import { listMemos } from "./memoPad.js";
import { listEntries } from "./tradeJournal.js";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pushNotice, stockLink } from "./notifyCenter.js";

const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "data");
/** 오늘 무엇을 물었나 — 한 줄에 하나 (jsonl). 되짚기가 읽는다 */
const MEMORY_FILE = join(DATA_DIR, "sysMemory.jsonl");
/** 벤티지가 설정에서 보탠 예시 질문 — 주제별 */
const TOPICS_FILE = join(DATA_DIR, "sysTopics.json");

/**
 * **시스 — 플로팅 도우미** (2026-09-03).
 *
 * 벤티지: "버튼 하나 만들어서 플로팅으로 AI 에게 물어보기 해서 「오늘 시장 왜이래?」
 * 「두산에너빌리티 뉴스 있어?」 이런거 물어보면 일반 모드에서는 뉴스랑 텔레랑 종목이랑 ETF
 * 관련 불러와서 보여주고(비용 0), AI 모드로 물어보면 API 써서 정리해서 보여주는 거."
 * 이어서: "두산에너빌리티 포함하는 ETF들 오늘 성적 어때? 지금 미장 선물 어때? 유가는? 금리는?
 * 금리 오늘 오르는 추세야? … CIS 일지 요즘 수익권이래? — **모든 케이스의 모든 조합을 대답할
 * 수 있는 최적의 구조**를 만들어 놔줘."
 *
 * ## 구조 — 주제 등록부 + 공통 섹션
 *
 * 질문 하나가 여러 주제를 건드린다(「두산에너빌리티 담은 ETF 오늘 성적」 = 종목 + ETF,
 * 「유가는? 금리는?」 = 거시 둘). 그래서 **주제(Topic)마다 「내가 걸리나」와 「걸리면 무엇을
 * 긁나」만 갖고**, 걸린 주제를 전부 병렬로 긁어 **같은 모양의 섹션(SysSection)** 으로 낸다.
 * 화면은 섹션 하나를 그리는 법만 알면 어떤 조합도 그린다. AI 모드는 섹션을 글로 눕혀
 * 문맥으로 넣는다. 주제를 하나 더 붙이는 일 = `TOPICS` 에 한 칸 추가.
 *
 * 섹션은 넷으로 이뤄진다 — 머리 숫자(facts) · 소제목 묶음(blocks) 안의 숫자/목록/줄글.
 * 종목·시장·ETF·거시·테마·CIS·관심종목·신호등 원장·일정·공시·뉴스·텔레그램 열넷이 전부
 * 이 모양이다. 매매 추천은 안 한다(askMarket 프롬프트).
 */

// ---------------------------------------------------------------- 공통 섹션 모델

export type SysTone = "up" | "down" | "good" | "warn" | "bad" | "muted";

export interface SysStockRef {
  code: string;
  name: string;
}

export interface SysFact {
  label: string;
  value: string;
  tone?: SysTone;
  hint?: string;
}

export interface SysItem {
  text: string;
  sub?: string;
  link?: string;
  /** 누르면 종목으로 */
  stock?: SysStockRef;
  tone?: SysTone;
}

export interface SysBlock {
  title?: string;
  facts?: SysFact[];
  items?: SysItem[];
  lines?: { text: string; tone?: SysTone }[];
  /** 긴 글 (엮어 둔 회사 소개, 일지 총평) */
  text?: string;
}

export interface SysSection {
  key: string;
  topic: string;
  title: string;
  /** 종목 섹션이면 — 제목을 눌러 종목으로 */
  stock?: SysStockRef;
  head?: SysFact[];
  blocks: SysBlock[];
  missing?: string[];
  ms: number;
  /** 조각별 걸린 시간(ms) — 「무엇이 느렸나」를 화면이 말할 수 있게 */
  took?: Record<string, number>;
  error?: string;
}

export interface SysIntent {
  /** 걸린 주제들 (사람이 읽는 이름) */
  topics: string[];
  stocks: SysStockRef[];
  themes: string[];
  note: string;
}

/**
 * **하겠다고 내미는 것** (2026-09-03 — 벤티지: "캘린더에 일정 넣거나 이런 것도 할 수 있으려나?").
 * 시스는 바로 쓰지 않는다. 알아들은 대로 카드를 내밀고 벤티지가 「넣기」를 눌러야 저장한다 —
 * 잘못 알아들은 걸 바로 넣으면 지우는 게 더 일이다.
 */
export interface SysProposal {
  id: string;
  kind: "addEvent";
  title: string;
  facts: SysFact[];
  payload: Record<string, unknown>;
}

/**
 * **되묻기** (2026-09-03 업그레이드 ②). 「하이닉스 어때?」처럼 종목만 있고 무엇을 볼지 없으면 바로
 * 긁지 않고 한 번 묻는다 — 「이닉스」 사건처럼 잘못 알아들은 채 4초를 긁는 것보다 낫다.
 * 화면이 선택지를 칩으로 그리고, 누르면 그 말을 붙여 다시 묻는다. 「다」를 두 번 연속 고르면
 * 화면이 `noClarify` 를 켜서 그 뒤로는 안 묻는다.
 */
export interface SysClarify {
  question: string;
  options: { label: string; send: string }[];
}

export interface SysPack {
  question: string;
  at: string;
  intent: SysIntent;
  sections: SysSection[];
  proposals?: SysProposal[];
  clarify?: SysClarify;
  ms: number;
}

export interface SysAnswer {
  pack: SysPack;
  ai: AskResult | null;
}

// ---------------------------------------------------------------- 유틸

const won = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}`;
const num = (v: number) => v.toLocaleString("ko-KR");
const pct = (v: number | null | undefined, d = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(d)}%`);
const toneOf = (v: number | null | undefined): SysTone | undefined => (v === null || v === undefined || v === 0 ? undefined : v > 0 ? "up" : "down");
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString("ko-KR", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
};
const LEVEL_KO: Record<string, string> = { green: "초록", yellow: "노랑", red: "빨강", unknown: "보류" };
const levelTone = (l: string): SysTone | undefined => (l === "green" ? "good" : l === "yellow" ? "warn" : l === "red" ? "bad" : undefined);

/**
 * 조각 하나에 시간제한 — 느린 원천 하나(텔레그램 실시간 훑기, 한투 컨센서스)가 섹션 전체를
 * 붙들지 않게. 넘기면 대체값으로 가고 `took` 에 「시간 초과」로 남는다.
 */
function part<T>(
  took: Record<string, number>,
  name: string,
  p: Promise<T>,
  fallback: T,
  ms = 12_000,
): Promise<T> {
  const t0 = Date.now();
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => {
      took[name] = -1;
      resolve(fallback);
    }, ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        if (took[name] === undefined) took[name] = Date.now() - t0;
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        if (took[name] === undefined) took[name] = Date.now() - t0;
        resolve(fallback);
      },
    );
  });
}

async function timed(topic: string, key: string, title: string, fn: () => Promise<Omit<SysSection, "key" | "topic" | "title" | "ms">>): Promise<SysSection> {
  const t0 = Date.now();
  try {
    const r = await fn();
    return { key, topic, title, ...r, ms: Date.now() - t0 };
  } catch (err) {
    return { key, topic, title, blocks: [], ms: Date.now() - t0, error: err instanceof Error ? err.message : String(err) };
  }
}

function newsItems(items: { title: string; press: string; link: string; publishedAt?: string; at?: string }[], n: number): SysItem[] {
  return items.slice(0, n).map((x) => ({ text: x.title, sub: `${x.press} · ${when(x.publishedAt ?? x.at ?? "")}`, link: x.link }));
}

/** 실시간 훑기 — 채널 일흔 곳, 한참 걸린다. **텔레그램을 콕 집어 물었을 때만** 쓴다 */
async function channelItemsLive(words: string[], minutes: number, n: number): Promise<SysItem[]> {
  const r = await searchChannels(words, minutes, n).catch(() => null);
  if (!r) return [];
  return r.hits.slice(0, n).map((h) => ({
    text: h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text,
    sub: `[${h.channelName}] ${when(h.at)}`,
    link: h.link || undefined,
  }));
}

/** 수집분(주요 채널 피드, 5분마다 쌓임) 안에서 — 수 ms. 종목·시장 섹션은 이걸 쓴다 */
async function channelItems(words: string[], minutes: number, n: number): Promise<SysItem[]> {
  const r = await searchMajorFeed(words, minutes, n).catch(() => null);
  if (!r) return [];
  return r.hits.map((h) => ({
    text: h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text,
    sub: `[${h.channel}] ${when(h.at)}`,
    link: h.link || undefined,
  }));
}

// ---------------------------------------------------------------- 해석

interface Ctx {
  client: KiwoomClient;
  q: string;
  compact: string;
  stocks: SysStockRef[];
  themes: string[];
  focus: SysStockRef | null;
}

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 줄여 부르는 이름 → 목록 이름. 예시 매칭에서 종목명으로 취급하는 데도 쓴다 */
const ALIAS_PUBLIC: Record<string, string> = { 삼전: "삼성전자", 하닉: "SK하이닉스", 하이닉스: "SK하이닉스", 현차: "현대차", 엘지: "LG", 네이버: "NAVER", 셀트: "셀트리온", 엔씨: "엔씨소프트", 두산에너: "두산에너빌리티", 한화에어로: "한화에어로스페이스", 포스코: "POSCO홀딩스", 카뱅: "카카오뱅크" };

/**
 * 질문에서 종목을 찾는다 — 전종목 이름을 질문에 대고 본다(2,700개 × includes, 수 ms).
 * 세 글자 이상은 그대로, 두 글자 이름은 앞뒤가 띄어쓰기·조사·문장 끝일 때만.
 * 겹치면 긴 쪽만(「한화」 vs 「한화에어로스페이스」). 본주가 있으면 우선주는 뺀다. 6자리 코드도.
 */
async function findStocks(client: KiwoomClient, q: string): Promise<SysStockRef[]> {
  const index = await getStockIndex(client).catch(() => new Map());
  const compact = q.replace(/\s+/g, "");
  const found: { code: string; name: string; start: number; end: number }[] = [];
  for (const m of q.matchAll(/\b(\d{6})\b/g)) {
    const e = index.get(m[1]);
    if (e) found.push({ code: e.code, name: e.name, start: m.index ?? 0, end: (m.index ?? 0) + 6 });
  }
  /*
   * **앞 글자 경계** — 「하이닉스」 안의 「이닉스」(진짜 있는 종목)가 잡히면 안 된다. 이름 바로 앞이
   * 한글·영숫자면 다른 말의 일부다. 뒤는 조사가 붙으므로 안 본다(「삼성전자랑」).
   */
  const boundaryOk = (at: number) => at === 0 || !/[가-힣A-Za-z0-9]/.test(compact[at - 1] ?? "");
  for (const e of index.values()) {
    const name = e.name.trim();
    if (name.length < 2 || /스팩|SPAC/i.test(name)) continue;
    const nc = name.replace(/\s+/g, "");
    let at = -1;
    if (name.length >= 3) {
      let from = 0;
      while (from <= compact.length) {
        const i = compact.indexOf(nc, from);
        if (i < 0) break;
        if (boundaryOk(i)) {
          at = i;
          break;
        }
        from = i + 1;
      }
    } else if (new RegExp(`(^|[\\s,.?!·])${esc(name)}($|[\\s,.?!·은는이가의도를을])`).test(q)) at = compact.indexOf(nc);
    if (at < 0) continue;
    found.push({ code: e.code, name: e.name, start: at, end: at + nc.length });
  }
  /*
   * **줄여 부르는 이름** — 「하이닉스」(SK하이닉스)·「두산에너」·「한화에어로」처럼 앞뒤를 뗀 말은
   * 목록에 그대로 없다. 못 찾은 토큰을 종목 검색(이름 포함)에 물어 **딱 하나**로 좁혀지면 그것.
   * 흔한 낱말(「전자」)은 여럿이 나와 버려진다.
   */
  const ALIAS = ALIAS_PUBLIC;
  const tokens = q.replace(/[?!.,·]/g, " ").split(/\s+/).map((w) => w.replace(/(은|는|이|가|을|를|의|도|랑|이랑|에서|에|로|으로)$/, "")).filter((w) => w.length >= 2 && !STOP.has(w));
  for (const tok of tokens) {
    const want = ALIAS[tok] ?? tok;
    if (found.some((f) => f.name.replace(/\s+/g, "").includes(want.replace(/\s+/g, "")))) continue;
    if (want.length < 3 && !ALIAS[tok]) continue;
    const hits = (await searchStocks(client, want).catch(() => [])).filter((h) => !/스팩|SPAC/i.test(h.name) && !/우(B|C)?$/.test(h.name));
    const exact = hits.find((h) => h.name.replace(/\s+/g, "") === want.replace(/\s+/g, ""));
    const pick = exact ?? (hits.length === 1 ? hits[0] : null);
    if (!pick) continue;
    const at = compact.indexOf(tok.replace(/\s+/g, ""));
    if (at < 0) continue;
    found.push({ code: pick.code, name: pick.name, start: at, end: at + tok.length });
  }
  found.sort((a, b) => b.end - b.start - (a.end - a.start));
  const kept: typeof found = [];
  for (const f of found) {
    if (kept.some((k) => k.code === f.code)) continue;
    if (kept.some((k) => f.start >= k.start && f.end <= k.end)) continue;
    kept.push(f);
  }
  const names = new Set(kept.map((k) => k.name));
  return kept
    .filter((k) => !(/우(B|C)?$/.test(k.name) && names.has(k.name.replace(/우(B|C)?$/, ""))))
    .sort((a, b) => a.start - b.start)
    .slice(0, 3)
    .map((k) => ({ code: k.code, name: k.name }));
}

async function findThemes(q: string, stocks: SysStockRef[]): Promise<string[]> {
  const compact = q.replace(/\s+/g, "");
  const { themes } = await themeStrength("kr").catch(() => ({ themes: [] }));
  const out: string[] = [];
  for (const t of themes) {
    const n = t.name.replace(/\s+/g, "");
    if (n.length >= 3 && compact.includes(n) && !stocks.some((s) => s.name.replace(/\s+/g, "") === n)) out.push(t.name);
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------- 주제들

interface Topic {
  key: string;
  title: string;
  match: (c: Ctx) => boolean;
  gather: (c: Ctx) => Promise<SysSection[]>;
  /** 종목 없이 이 주제만 걸렸을 때 지금 보는 종목을 대상으로 삼나 (뉴스·텔레·공시) */
  wantsFocus?: boolean;
  /** 이런 질문이면 이 주제다 — 정규식 대신 **예시**로. 설정에서 벤티지가 더 보탠다 (업그레이드 ④) */
  examples?: string[];
}

/*
 * ## 예시 질문으로 걸기 (2026-09-03 업그레이드 ④ — 벤티지: "정규식 말고 예시 질문 서너 개로
 * 걸리게 바꿔줘 — 정규식은 내가 못 고쳐")
 *
 * 주제마다 예시 질문 몇 개를 두고, 질문의 낱말이 그 주제 예시의 **고유 낱말**과 겹치면 건다.
 * 고유 = 다른 주제 예시엔 없는 낱말(「일정」은 일정 주제 고유, 「오늘」은 여러 주제에 있어 못 쓴다).
 * 정규식은 남겨 둔다(둘 중 하나면 걸림) — 예시는 벤티지가 설정에서 보태는 손잡이다.
 */
let topicsCustom: Record<string, string[]> | null = null;
async function loadTopicsCustom(): Promise<Record<string, string[]>> {
  if (topicsCustom) return topicsCustom;
  try {
    const raw = JSON.parse(await readFile(TOPICS_FILE, "utf-8")) as Record<string, unknown>;
    topicsCustom = {};
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v)) topicsCustom[k] = v.map(String).filter(Boolean);
  } catch {
    topicsCustom = {};
  }
  return topicsCustom;
}
export async function getTopicExamples(): Promise<{ key: string; title: string; builtin: string[]; custom: string[] }[]> {
  const custom = await loadTopicsCustom();
  return TOPICS.map((t) => ({ key: t.key, title: t.title, builtin: t.examples ?? [], custom: custom[t.key] ?? [] }));
}
export async function saveTopicExamples(input: Record<string, string[]>): Promise<void> {
  const next: Record<string, string[]> = {};
  for (const t of TOPICS) {
    const v = input[t.key];
    if (Array.isArray(v)) next[t.key] = v.map((s) => String(s).trim()).filter((s) => s.length >= 2).slice(0, 30);
  }
  topicsCustom = next;
  exampleVocab = null;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TOPICS_FILE, JSON.stringify(next, null, 2), "utf-8");
}
/** 주제 → 고유 낱말 집합 (예시가 바뀌면 다시 만든다) */
let exampleVocab: Map<string, Set<string>> | null = null;
function tokensOf(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[?!.,·]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/(은|는|이|가|을|를|의|도|랑|이랑|에서|에|로|으로|들|요)$/, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w));
}
async function vocab(): Promise<Map<string, Set<string>>> {
  if (exampleVocab) return exampleVocab;
  const custom = await loadTopicsCustom();
  const per = new Map<string, Set<string>>();
  const count = new Map<string, number>();
  for (const t of TOPICS) {
    const set = new Set<string>();
    for (const ex of [...(t.examples ?? []), ...(custom[t.key] ?? [])]) for (const w of tokensOf(ex)) set.add(w);
    per.set(t.key, set);
    for (const w of set) count.set(w, (count.get(w) ?? 0) + 1);
  }
  /* 둘 이상의 주제에 나오는 낱말은 아무것도 못 가른다 — 「종목」「신호등」이 그렇다 */
  for (const set of per.values()) for (const w of [...set]) if ((count.get(w) ?? 0) >= 2) set.delete(w);
  /* 종목에 딸린 말은 주제를 못 가른다 — 「하이닉스 시세 수급」의 수급이 시장을 부르면 안 된다 */
  for (const set of per.values()) for (const w of [...set]) if (STOCK_WORDS.has(w)) set.delete(w);
  exampleVocab = per;
  return per;
}
/** 종목 뒤에 붙는 말들 — 예시 매칭에서 뺀다 (종목 섹션의 세 갈래가 이걸 쓴다) */
const STOCK_WORDS = new Set(["종목", "시세", "수급", "신호등", "뉴스", "공시", "텔레", "실적", "목표가", "테마", "etf", "차트", "주가", "가격", "회사", "소개", "메모", "정보", "상세", "분석"]);
let vocabCache: Map<string, Set<string>> | null = null;
let vocabStocks: string[] = [];
function matchesExamples(key: string, q: string): boolean {
  const set = vocabCache?.get(key);
  if (!set || set.size === 0) return false;
  /* 예시에 적힌 종목명(「하이닉스 뉴스 있어?」의 하이닉스)은 주제가 아니라 종목이다 */
  return tokensOf(q).some((w) => set.has(w) && !vocabStocks.some((s) => s.includes(w) || w.includes(s)));
}

const RE = {
  /*
   * 시장은 **명시어**가 있을 때만 — 「오늘 어때」「장 」같은 헐거운 말로 걸면 「관심종목 오늘
   * 어때?」「원장 잘 가?」에 시장 카드가 덤으로 붙는다. 아무것도 못 알아들었을 때의 기본값이
   * 시장이므로(gather), 「왜 이래?」만 쳐도 시장으로 간다.
   */
  market: /(시장|코스피|코스닥|증시|장세|장 ?분위기|국내 ?지수|외국인 ?수급|외인 ?수급|기관 ?수급|수급 (어|어느|어디|방향)|섹터|업종|테마 (뭐|어디|어떤)|주도주)/i,
  etf: /(etf|이티에프)/i,
  usFut: /(미장|미국 ?(선물|지수|장|증시)|나스닥|다우|s&p|에스앤피|vix|공포지수|필라델피아|반도체 ?지수)/i,
  night: /(야간 ?선물|야간)/,
  oil: /(유가|원유|wti|브렌트|석유|천연가스|가스 ?가격)/i,
  metal: /(금값|금 ?시세|골드|은값|은 ?시세|구리|알루미늄|리튬|원자재)/,
  fx: /(환율|달러|원화|엔화|위안)/,
  rates: /(금리|국채|채권|국고채|tnx|연준|fomc)/i,
  crypto: /(비트코인|이더리움|코인|암호화폐|가상화폐)/,
  cis: /(cis|시스 ?일지|일지|계좌|수익권|모의 ?투자|페이퍼|종배 ?계좌|연금 ?계좌|irp|트레이딩 ?계좌)/i,
  watch: /(관심 ?종목|내 종목|담은 종목|내가 담은|워치)/,
  ledger: /(슈퍼 ?신호등|신호등 ?원장|원장|무지개|신호등 (뭐|어떤|초록|상위|잘)|초록 (뭐|종목))/,
  calendar: /(일정|캘린더|이벤트|발표 (언제|있)|실적 ?발표|이번 ?주|다음 ?주|내일 (뭐|일정)|스케줄)/,
  /** 일정 넣기 — 「9/10 14시 FOMC 일정 넣어줘」「내일 오후 2시 미팅 캘린더에 추가」 */
  addEvent: /((일정|캘린더|스케줄).{0,12}(넣|추가|등록|잡아|적어))|((넣어|추가해|등록해|잡아|적어).{0,6}(일정|캘린더))/,
  memo: /(메모|메모장|일기|적어 ?둔|적어둔|적었|기록해 ?둔)/,
  journal: /(복기|매매 ?일지|매매일지)/,
  disclosure: /(공시)/,
  news: /(뉴스|기사|헤드라인|속보|무슨 일|소식)/,
  telegram: /(텔레|텔레그램|채널|톡방|방에서|리딩)/,
};

const STOP = new Set([
  "오늘", "지금", "요즘", "어때", "어떄", "있어", "있나", "있는지", "있음", "뭐래", "뭐야", "뭐", "왜", "이래", "관련", "대해", "알려줘", "보여줘", "찾아줘", "찾아", "찾아봐",
  "어떤", "성적", "수익권", "추세", "뉴스", "기사", "텔레", "텔레그램", "채널", "공시", "그리고", "그래서", "근데", "좀", "한번", "적어", "적어둔", "적었", "적은", "기록",
  "메모", "일지", "복기", "노트", "일정", "캘린더", "시세", "가격", "주가", "얼마", "어디", "어느", "거", "것", "둔", "해줘", "줘", "해봐", "하자", "정도", "부터", "까지",
]);
function keywordsOf(q: string): string[] {
  return q
    .replace(/[?!.,·]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/(은|는|이|가|을|를|의|도|에|에서|으로|로|이랑|랑|들|은요|는요)$/, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .slice(0, 6);
}

/* ── 종목 ── */
/** 종목 섹션의 세 갈래 — 되묻기 선택지와 같다. null 이면 전부 */
type StockPart = "quote" | "news" | "fund";
function stockPartsOf(q: string): Set<StockPart> | null {
  const parts = new Set<StockPart>();
  if (/(시세|주가|가격|수급|신호등|차트|얼마|외인|외국인|기관|체결)/.test(q)) parts.add("quote");
  if (/(뉴스|기사|공시|텔레|소식|무슨 일|왜|이유)/.test(q)) parts.add("news");
  if (/(실적|목표가|테마|etf|회사|소개|뭐 하는|사업|이익)/i.test(q)) parts.add("fund");
  if (/(다|전부|전체|모두|다 봐|다봐|싹)\s*$|\b(다|전부|전체|모두)\b/.test(q)) return null;
  return parts.size ? parts : null;
}

async function stockSection(client: KiwoomClient, s: SysStockRef, parts: Set<StockPart> | null = null): Promise<SysSection> {
  const want = (p: StockPart) => parts === null || parts.has(p);
  const off = <T,>(v: T): Promise<T> => Promise.resolve(v);
  return timed("stock", `stock:${s.code}`, s.name, async () => {
    const took: Record<string, number> = {};
    const [sum, sig, themes, strength, holders, news, disc, chan, quarters, watch, brief] = await Promise.all([
      part(took, "시세·수급", stockSummary(client, s.code), null),
      want("quote") ? part(took, "신호등", evaluateSignal(client, s.code), null, 20_000) : off(null),
      want("fund") ? part(took, "테마", themesOfStock(s.code), []) : off([] as Awaited<ReturnType<typeof themesOfStock>>),
      want("fund") ? part(took, "테마 강도", themeStrength("kr").then((r) => r.themes), []) : off([] as Awaited<ReturnType<typeof themeStrength>>["themes"]),
      want("fund") ? part(took, "담은 ETF", etfHoldersOf(s.code).then((r) => r.holders), []) : off([] as Awaited<ReturnType<typeof etfHoldersOf>>["holders"]),
      want("news") ? part(took, "뉴스", searchNews(s.name, { limit: 10 }), []) : off([] as Awaited<ReturnType<typeof searchNews>>),
      want("news") ? part(took, "공시", getDisclosures(s.code, 30), []) : off([] as Awaited<ReturnType<typeof getDisclosures>>),
      want("news") ? part(took, "텔레그램(수집분)", channelItems([s.name, s.code], 2 * 24 * 60, 8), []) : off([] as SysItem[]),
      want("fund") ? part(took, "분기 실적", quarterFinance(s.code, 4), []) : off([] as Awaited<ReturnType<typeof quarterFinance>>),
      part(took, "관심종목", listWatchlist(), []),
      want("fund") ? part(took, "회사 소개", cachedBrief(s.code), null) : off(null),
    ]);
    const price = sum?.facts.price ?? null;
    const opinion = want("fund") ? await part(took, "컨센서스", opinionBrief(s.code, price), null, 8_000) : null;
    const missing: string[] = [];
    if (!sum) missing.push("시세·수급");
    if (!sig) missing.push("신호등");
    const strengthOf = new Map(strength.map((t) => [t.name, t.changeRate]));
    const w = watch.find((x) => x.code === s.code);

    const head: SysFact[] = [];
    if (sum) {
      head.push({ label: "현재가", value: `${num(sum.facts.price)} (${pct(sum.facts.changeRate)})`, tone: toneOf(sum.facts.changeRate) });
      if (sum.facts.tradeValue !== null) head.push({ label: "대금", value: `${num(sum.facts.tradeValue)}억` });
      if (sum.facts.marketCap !== null) head.push({ label: "시총", value: `${(sum.facts.marketCap / 10000).toFixed(1)}조` });
      if (sum.facts.strength !== null) head.push({ label: "체결강도", value: String(sum.facts.strength), tone: sum.facts.strength >= 120 ? "up" : sum.facts.strength <= 80 ? "down" : undefined });
      for (const f of sum.main) head.push({ label: f.label, value: `${won(f.amount)}백만`, tone: toneOf(f.amount) });
    }
    if (w) head.push({ label: "관심", value: `${w.groups?.join("·") || "기본"}${w.status ? ` · ${w.status}` : ""}`, tone: "muted" });

    const blocks: SysBlock[] = [];
    if (sig) {
      const good = sig.checks.filter((c) => c.grade !== null && c.grade >= 100 && c.weight > 0).map((c) => `${c.label} ${c.value}`);
      const bad = sig.checks.filter((c) => c.grade !== null && c.grade <= 0 && c.weight > 0).map((c) => `${c.label} ${c.value}`);
      blocks.push({
        title: `신호등 ${LEVEL_KO[sig.level] ?? sig.level} ${sig.score}점`,
        facts: [
          ...sig.axes.map((a) => ({ label: a.label, value: String(a.score ?? "-"), tone: levelTone(a.level) })),
          ...(sig.vetoedBy?.length ? [{ label: "탈락", value: sig.vetoedBy.join(", "), tone: "bad" as SysTone }] : []),
        ],
        lines: [
          ...(good.length ? [{ text: `＋ ${good.join(" · ")}`, tone: "good" as SysTone }] : []),
          ...(bad.length ? [{ text: `－ ${bad.join(" · ")}`, tone: "bad" as SysTone }] : []),
        ],
      });
    }
    const th = themes.filter((t) => !isIndexLikeTheme(t.name)).slice(0, 6);
    const etfs = holders.filter((h) => !isNotTheme(h.name) && (h.weight ?? 0) <= 50).slice(0, 4);
    if (th.length || etfs.length) {
      blocks.push({
        title: "테마 · 담은 ETF",
        facts: [
          ...th.map((t) => ({ label: t.name, value: pct(strengthOf.get(t.name) ?? null), tone: toneOf(strengthOf.get(t.name) ?? null), hint: t.desc })),
          ...etfs.map((e) => ({ label: `${e.name} ${e.weight ?? "-"}%`, value: pct(e.changeRate), tone: toneOf(e.changeRate) })),
        ],
      });
    }
    if (quarters.length || opinion) {
      blocks.push({
        title: "실적 · 목표가",
        facts: [
          ...quarters.slice(0, 4).map((q) => ({
            label: q.label,
            value: `영익 ${q.operatingProfit ?? "-"}억 (${q.margin ?? "-"}%${q.yoy !== null ? `, YoY ${pct(q.yoy, 0)}` : ""})`,
            tone: toneOf(q.yoy),
          })),
          ...(opinion
            ? [{ label: `증권사 ${opinion.brokerCount}곳`, value: `여력 ${pct(opinion.upside, 0)}${opinion.recentMove > 0 ? " · 최근 상향" : opinion.recentMove < 0 ? " · 최근 하향" : ""}`, tone: toneOf(opinion.upside) }]
            : []),
        ],
      });
    }
    if (news.length) blocks.push({ title: `뉴스 ${Math.min(news.length, 8)}`, items: newsItems(news, 8) });
    if (disc.length) blocks.push({ title: "공시 (30일)", items: disc.slice(0, 6).map((d) => ({ text: d.reportName, sub: d.receiptDate })) });
    if (want("news")) {
      blocks.push(
        chan.length
          ? { title: `텔레그램 ${chan.length} (주요 채널 수집분 · 이틀)`, items: chan }
          : { title: "텔레그램", lines: [{ text: "주요 채널 수집분 이틀 안에 이 종목 언급 없음 — 전 채널 실시간은 「텔레」를 붙여 물어봐", tone: "muted" }] },
      );
    }
    if (parts !== null) blocks.push({ lines: [{ text: `${[...parts].map((p) => ({ quote: "시세·수급·신호등", news: "뉴스·공시·텔레", fund: "실적·목표가·테마·ETF" })[p]).join(" + ")}만 긁었다 — 다 보려면 「${s.name} 다」`, tone: "muted" }] });
    if (brief?.text) blocks.push({ title: "엮어 둔 회사 소개", text: brief.text });
    for (const [k, v] of Object.entries(took)) if (v === -1) missing.push(`${k}(시간 초과)`);
    return { stock: s, head, blocks, missing, took };
  });
}

/* ── 시장 ── */
async function marketSection(client: KiwoomClient): Promise<SysSection> {
  return timed("market", "market", "시장", async () => {
    const [pulse, strength, news, idx, chan] = await Promise.all([
      marketPulse(client).catch(() => null),
      themeStrength("kr").catch(() => ({ themes: [] })),
      mainNews(8).catch(() => []),
      getSection("indices", client).catch(() => null),
      channelItems(["코스피", "증시", "시장", "지수"], 6 * 60, 6),
    ]);
    const rows = Array.isArray((idx as { data?: unknown } | null)?.data) ? ((idx as { data: { name: string; price: number; changeRate: number }[] }).data ?? []) : [];
    const head: SysFact[] = rows.slice(0, 4).map((r) => ({ label: r.name, value: `${num(r.price)} (${pct(r.changeRate)})`, tone: toneOf(r.changeRate) }));
    const blocks: SysBlock[] = [];
    if (pulse) {
      const f = pulse.flow;
      blocks.push({
        title: pulse.signal ? `시장 신호등 ${LEVEL_KO[pulse.signal.level] ?? pulse.signal.level} ${pulse.signal.score}점` : "수급",
        lines: [
          ...(pulse.signal ? [{ text: pulse.signal.summary }] : []),
          { text: `${pulse.phase.label} — ${pulse.phase.note}` },
          ...(pulse.turn.turning ? [{ text: `방향 전환: ${pulse.turn.note}`, tone: "warn" as SysTone }] : []),
        ],
        facts: [
          { label: `5일 누적(${f.days5}일치)`, value: "" , tone: "muted" },
          { label: "외국인", value: `${won(f.foreign5)}억 · ${f.foreignStreak >= 0 ? `${f.foreignStreak}일 순매수` : `${-f.foreignStreak}일 순매도`}`, tone: toneOf(f.foreign5) },
          { label: "기관", value: `${won(f.inst5)}억 · ${f.instStreak >= 0 ? `${f.instStreak}일 순매수` : `${-f.instStreak}일 순매도`}`, tone: toneOf(f.inst5) },
          { label: "개인", value: `${won(f.individual5)}억`, tone: toneOf(f.individual5) },
          ...[...new Map(pulse.risks.map((r) => [r.label, r])).values()].map((r) => ({ label: "⚠", value: r.label, tone: (r.level === "danger" ? "bad" : "warn") as SysTone, hint: r.detail })),
        ],
      });
      if (pulse.external.length) blocks.push({ title: "바깥", facts: pulse.external.map((e) => ({ label: e.label, value: `${e.value}${e.changeRate !== null ? ` (${pct(e.changeRate)})` : ""}`, tone: toneOf(e.changeRate), hint: e.note })) });
    }
    const live = strength.themes.filter((t) => !isIndexLikeTheme(t.name) && (t.tradeValue ?? 0) >= 200);
    const up = [...live].sort((a, b) => b.changeRate - a.changeRate).slice(0, 6);
    const down = [...live].sort((a, b) => a.changeRate - b.changeRate).slice(0, 5);
    if (up.length) {
      blocks.push({
        title: "테마 (돈이 도는 것만)",
        facts: [
          ...up.map((t) => ({ label: t.name, value: pct(t.changeRate), tone: "up" as SysTone, hint: `상승 폭 ${t.breadth}% · ${t.streak}일 연속` })),
          ...down.map((t) => ({ label: t.name, value: pct(t.changeRate), tone: "down" as SysTone, hint: `상승 폭 ${t.breadth}%` })),
        ],
      });
    }
    if (news.length) blocks.push({ title: "주요 뉴스", items: newsItems(news, 8) });
    if (chan.length) blocks.push({ title: `텔레그램 ${chan.length} (6시간)`, items: chan });
    return { head, blocks };
  });
}

/* ── ETF ── */
async function etfSection(client: KiwoomClient, stocks: SysStockRef[]): Promise<SysSection> {
  return timed("etf", "etf", "ETF", async () => {
    const all = await etfAll(client).catch(() => []);
    const plain = all.filter((r) => r.tradeValue >= 30 && !/레버리지|인버스|2X|채권|단기|금리|단일종목|커버드콜|국고채|CD|KOFR|SOFR/i.test(r.name));
    const blocks: SysBlock[] = [];
    for (const s of stocks) {
      const h = await etfHoldersOf(s.code).catch(() => ({ holders: [] }));
      const list = h.holders.filter((x) => !isNotTheme(x.name) && (x.weight ?? 0) <= 50).slice(0, 8);
      const rated = list.filter((x) => x.changeRate !== null);
      const avg = rated.length ? rated.reduce((n, x) => n + (x.changeRate ?? 0), 0) / rated.length : null;
      blocks.push({
        title: `${s.name} 담은 ETF${avg !== null ? ` — 오늘 평균 ${pct(avg)}` : ""}`,
        facts: list.length
          ? list.map((x) => ({ label: `${x.name} ${x.weight ?? "-"}%`, value: pct(x.changeRate), tone: toneOf(x.changeRate), hint: x.index }))
          : [{ label: "없음", value: "거래대금 상위 ETF 의 Top10 구성에서 못 찾음", tone: "muted" }],
      });
    }
    blocks.push({ title: "오늘 오르는 ETF", facts: [...plain].sort((a, b) => b.changeRate - a.changeRate).slice(0, 8).map((e) => ({ label: e.name, value: pct(e.changeRate), tone: "up" as SysTone, hint: `대금 ${e.tradeValue}억` })) });
    blocks.push({ title: "빠지는 ETF", facts: [...plain].sort((a, b) => a.changeRate - b.changeRate).slice(0, 6).map((e) => ({ label: e.name, value: pct(e.changeRate), tone: "down" as SysTone, hint: `대금 ${e.tradeValue}억` })) });
    return { blocks };
  });
}

/* ── 거시 ── */
type MacroKey = "usFut" | "night" | "oil" | "metal" | "fx" | "rates" | "crypto";
const MACRO_TITLE: Record<MacroKey, string> = { usFut: "미국 선물", night: "야간선물", oil: "유가·에너지", metal: "금속·원자재", fx: "환율", rates: "금리", crypto: "암호화폐" };
const MACRO_TREND: Record<MacroKey, { label: string; symbol: string; rate?: boolean }[]> = {
  usFut: [{ label: "US 500 선물", symbol: "ES=F" }, { label: "US Tech 100 선물", symbol: "NQ=F" }],
  night: [],
  oil: [{ label: "WTI", symbol: "CL=F" }],
  metal: [{ label: "금", symbol: "GC=F" }],
  fx: [{ label: "달러/원", symbol: "KRW=X" }],
  rates: [{ label: "미국 10년", symbol: "^TNX", rate: true }],
  crypto: [{ label: "비트코인", symbol: "BTC-USD" }],
};

/** 「오르는 추세야?」 — 오늘 5분봉과 5일 종가로 한 줄 */
async function trendLine(label: string, symbol: string, isRate: boolean): Promise<{ text: string; tone?: SysTone }> {
  const [day, week] = await Promise.all([yahooChart(symbol, "1d").catch(() => null), yahooChart(symbol, "5d").catch(() => null)]);
  const closes = (day?.candles ?? []).map((c) => c.close).filter((v) => Number.isFinite(v) && v > 0);
  const f = (v: number) => (isRate ? `${v.toFixed(3)}%` : v >= 1000 ? num(Math.round(v)) : v.toFixed(2));
  const parts: string[] = [];
  let tone: SysTone | undefined;
  if (closes.length >= 2) {
    const first = closes[0];
    const last = closes[closes.length - 1];
    const d = last - first;
    const flat = Math.abs(d) < (isRate ? 0.005 : first * 0.0005);
    tone = flat ? undefined : d > 0 ? "up" : "down";
    parts.push(`오늘 ${f(first)} → ${f(last)} ${flat ? "보합" : d > 0 ? "오름" : "내림"} (고 ${f(Math.max(...closes))} · 저 ${f(Math.min(...closes))})`);
    if (day?.prevClose) parts.push(`전일 ${f(day.prevClose)}`);
  }
  const byDay = new Map<string, number>();
  for (const c of week?.candles ?? []) if (Number.isFinite(c.close) && c.close > 0) byDay.set(c.t.slice(0, 10), c.close);
  const days = [...byDay.values()].slice(-5);
  if (days.length >= 3) {
    let up = 0;
    let down = 0;
    for (let i = 1; i < days.length; i += 1) {
      if (days[i] > days[i - 1]) up += 1;
      else if (days[i] < days[i - 1]) down += 1;
    }
    const word = up === days.length - 1 ? "계속 오르는 중" : down === days.length - 1 ? "계속 내리는 중" : up > down ? "오르는 쪽" : down > up ? "내리는 쪽" : "엇갈림";
    parts.push(`${days.length}일 ${days.map(f).join(" → ")} — ${word}`);
  }
  return { text: `${label}: ${parts.join(" · ") || "값을 못 받았다"}`, tone };
}

async function macroSection(k: MacroKey): Promise<SysSection> {
  return timed(`macro`, `macro:${k}`, MACRO_TITLE[k], async () => {
    const needUs = k === "usFut" || k === "night" || k === "rates";
    const [us, global, rates, trends] = await Promise.all([
      needUs ? usMajorIndices().catch(() => null) : Promise.resolve(null),
      k !== "night" && k !== "rates" ? getGlobalMarket().catch(() => []) : Promise.resolve([]),
      k === "rates" ? rateBoard().catch(() => []) : Promise.resolve([]),
      Promise.all(MACRO_TREND[k].map((t) => trendLine(t.label, t.symbol, Boolean(t.rate)))),
    ]);
    const usRows = us?.rows ?? [];
    const g = (x: (typeof global)[number]): SysFact => ({ label: x.label, value: x.price === null ? "-" : `${x.isRate ? `${x.price}%` : num(x.price)} (${pct(x.changeRate)})`, tone: toneOf(x.changeRate), hint: x.kind ? `${x.kind}` : undefined });
    /* %p 는 부동소수 찌꺼기가 그대로 보인다(-0.005000000000000782) — 셋째 자리까지 */
    const pp = (v: number | null) => (v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%p`);
    const u = (r: (typeof usRows)[number]): SysFact => ({
      label: r.label,
      value: r.price === null ? "-" : r.isRate ? `${r.price}% (${pp(r.change)})` : `${num(r.price)} (${pct(r.changeRate)})`,
      tone: r.isRate ? toneOf(r.change) : toneOf(r.changeRate),
      hint: r.signal?.why,
    });
    let facts: SysFact[] = [];
    if (k === "usFut") facts = [...global.filter((x) => x.group === "미국 지수선물").map(g), ...usRows.filter((r) => /반도체|SOX/i.test(r.label) && !r.isRate).map(u)];
    else if (k === "night") facts = us?.nightFutures ? [u(us.nightFutures)] : [];
    else if (k === "oil") facts = global.filter((x) => ["wti", "brent", "natgas"].includes(x.key)).map(g);
    else if (k === "metal") facts = global.filter((x) => ["gold", "silver", "copper", "alum", "lithium"].includes(x.key)).map(g);
    else if (k === "fx") facts = global.filter((x) => x.group === "환율").map(g);
    else if (k === "crypto") facts = global.filter((x) => x.group === "암호화폐").map(g);
    else if (k === "rates") {
      facts = [
        ...usRows.filter((r) => r.isRate).map(u),
        ...rates.map((r) => ({
          label: r.name,
          value: r.rate === null ? "-" : `${r.rate}% (${pp(r.change)})`,
          tone: toneOf(r.change),
          hint: r.group === "해외" && r.asOf ? `${r.asOf} 종가` : r.group,
        })),
      ];
    }
    const blocks: SysBlock[] = [{ facts: facts.length ? facts : [{ label: "값을 못 받았다", value: "", tone: "muted" }] }];
    if (us && (k === "usFut" || k === "night")) {
      blocks.unshift({
        lines: [
          { text: `미장 전광판 ${LEVEL_KO[us.boardSignal.level]}: ${us.boardSignal.summary}`, tone: levelTone(us.boardSignal.level) },
          ...(us.curveNote ? [{ text: us.curveNote, tone: "muted" as SysTone }] : []),
        ],
      });
    }
    if (us && k === "rates" && us.curveNote) blocks.unshift({ lines: [{ text: us.curveNote, tone: "muted" }] });
    if (trends.length) blocks.push({ title: "추세 (야후 · 오늘 5분봉 · 5일 종가)", lines: trends });
    return { blocks };
  });
}

/* ── 테마 ── */
async function themeSection(name: string): Promise<SysSection> {
  return timed("theme", `theme:${name}`, `테마 ${name}`, async () => {
    const { themes } = await themeStrength("kr").catch(() => ({ themes: [] }));
    const t = themes.find((x) => x.name === name);
    if (!t) return { blocks: [], missing: ["테마 강도 없음"] };
    return {
      head: [
        { label: "오늘", value: pct(t.changeRate), tone: toneOf(t.changeRate) },
        { label: "상승/하락", value: `${t.up}/${t.down}` },
        { label: "폭", value: `${t.breadth}%` },
        { label: "연속", value: `${t.streak}일` },
        { label: "5일 중", value: `${t.hit5.n}/${t.hit5.of}일 상승` },
      ],
      blocks: [],
    };
  });
}

/* ── CIS 일지 ── */
async function cisSection(client: KiwoomClient, id: AccountId): Promise<SysSection> {
  const p = ACCOUNTS[id];
  return timed("cis", `cis:${id}`, p.name, async () => {
    const [st, acc, days] = await Promise.all([cisStats(id), loadAccount(id), listDays(3, id).catch(() => [])]);
    const prices = await priceMap(client, acc.positions.map((x) => x.code)).catch(() => new Map<string, number>());
    let unreal = 0;
    const pos: SysFact[] = acc.positions.map((x) => {
      const px = prices.get(x.code) ?? null;
      const r = px && x.avg > 0 ? ((px - x.avg) / x.avg) * 100 : null;
      if (px) unreal += (px - x.avg) * x.qty;
      return { label: x.name, value: `${r === null ? "시세 없음" : pct(r)} · ${x.openedAt.slice(5)}~${x.stop !== null ? ` · 손절 ${num(x.stop)}` : ""}`, tone: toneOf(r), hint: x.why };
    });
    const last = days[0];
    const review = last?.review?.text ?? last?.evening?.text ?? last?.noon?.text ?? last?.morning?.text ?? null;
    const curve = st.curve.slice(-6);
    const weekAgo = curve.length >= 2 ? curve[0].equity : null;
    const head: SysFact[] = [
      { label: "시드 대비", value: pct(st.totalReturn), tone: toneOf(st.totalReturn) },
      { label: "평가액", value: `${num(Math.round(st.equity / 10000))}만`, hint: `시드 ${num(p.seed / 10000)}만 · ${st.days}일째` },
      ...(weekAgo ? [{ label: `최근 ${curve.length - 1}일`, value: pct(((st.equity - weekAgo) / weekAgo) * 100), tone: toneOf(st.equity - weekAgo) }] : []),
      { label: "실현", value: `${won(st.realized / 10000)}만`, tone: toneOf(st.realized) },
      { label: "평가손익", value: `${won(unreal / 10000)}만`, tone: toneOf(unreal) },
      { label: "승률", value: `${st.winRate}% (${st.wins}/${st.trades})` },
      { label: "MDD", value: `-${st.mdd}%`, tone: st.mdd >= 10 ? "bad" : undefined },
      ...(st.payoff !== null ? [{ label: "손익비", value: st.payoff.toFixed(2), tone: (st.payoff >= 2 ? "good" : st.payoff < 1 ? "bad" : undefined) as SysTone | undefined }] : []),
    ];
    const blocks: SysBlock[] = [];
    blocks.push({ title: `보유 ${acc.positions.length}`, facts: pos.length ? pos : [{ label: "없음", value: "현금 100%", tone: "muted" }] });
    if (st.best || st.worst) blocks.push({ facts: [...(st.best ? [{ label: "최고", value: `${st.best.name} ${won(st.best.pnl / 10000)}만 (${st.best.date.slice(5)})`, tone: "up" as SysTone }] : []), ...(st.worst ? [{ label: "최악", value: `${st.worst.name} ${won(st.worst.pnl / 10000)}만 (${st.worst.date.slice(5)})`, tone: "down" as SysTone }] : [])] });
    if (st.violations.length) blocks.push({ title: "규칙 위반", lines: st.violations.slice(0, 3).map((v) => ({ text: `${v.text} ×${v.count}`, tone: "warn" as SysTone })) });
    if (review) blocks.push({ title: `최근 일지 (${last?.date ?? ""})`, text: review.length > 700 ? `${review.slice(0, 700)}…` : review });
    return { head, blocks };
  });
}

/* ── 관심종목 ── */
async function watchSection(client: KiwoomClient): Promise<SysSection> {
  return timed("watch", "watch", "관심종목", async () => {
    const rows = (await getTrackedWatchlist(client)).filter((r) => !r.divider);
    const up = rows.filter((r) => r.changeRate > 0).length;
    const down = rows.filter((r) => r.changeRate < 0).length;
    const profit = rows.filter((r) => (r.returnRate ?? 0) > 0).length;
    const both = rows.filter((r) => r.foreign5 > 0 && r.inst5 > 0);
    const byRate = [...rows].sort((a, b) => b.changeRate - a.changeRate);
    const byRet = [...rows].sort((a, b) => (a.returnRate ?? 0) - (b.returnRate ?? 0));
    const item = (r: (typeof rows)[number]): SysItem => ({ text: r.name, sub: `당일 ${pct(r.changeRate)} · 편입가 대비 ${pct(r.returnRate)}`, stock: { code: r.code, name: r.name }, tone: toneOf(r.changeRate) });
    return {
      head: [
        { label: "종목", value: String(rows.length) },
        { label: "오늘", value: `▲${up} ▼${down}` },
        { label: "수익 중", value: `${profit}/${rows.length}` },
        { label: "쌍끌이 5일", value: String(both.length), tone: "up" },
      ],
      blocks: [
        { title: "오늘 많이 오른 것", items: byRate.slice(0, 5).map(item) },
        { title: "오늘 많이 빠진 것", items: byRate.slice(-4).reverse().map(item) },
        { title: "편입가 대비 손실 큰 것", items: byRet.slice(0, 4).filter((r) => (r.returnRate ?? 0) < 0).map(item) },
        ...(both.length ? [{ title: "외국인·기관 쌍끌이", items: both.slice(0, 8).map(item) }] : []),
      ],
    };
  });
}

/* ── 신호등 원장 (슈퍼신호등) ── */
async function ledgerSection(client: KiwoomClient): Promise<SysSection> {
  return timed("ledger", "ledger", "슈퍼신호등 원장", async () => {
    const r = await listSuperSignal(client);
    const active = r.entries.filter((e) => e.active !== false);
    const rated = active.filter((e) => e.sinceAdded !== null);
    const avg = rated.length ? rated.reduce((n, e) => n + (e.sinceAdded ?? 0), 0) / rated.length : null;
    const winners = rated.filter((e) => (e.sinceAdded ?? 0) > 0).length;
    const item = (e: (typeof active)[number]): SysItem => ({
      text: `${e.rainbow ? "🌈 " : ""}${e.name}${e.isNew ? " (N)" : ""}`,
      sub: `편입 후 ${pct(e.sinceAdded)} · 오늘 ${pct(e.changeRate)} · ${e.daysSince}일째${e.theme ? ` · ${e.theme.name} ${pct(e.theme.changeRate)}` : ""}${e.etfBack ? ` · ETF뒷배 ${pct(e.etfBack.rate)}` : ""}`,
      stock: { code: e.code, name: e.name },
      tone: toneOf(e.sinceAdded),
    });
    const sorted = [...active].sort((a, b) => (b.sinceAdded ?? -999) - (a.sinceAdded ?? -999));
    return {
      head: [
        { label: "활성", value: String(active.length), hint: `마지막 편입 ${r.lastRunDate ?? "-"}` },
        { label: "무지개", value: String(active.filter((e) => e.rainbow).length) },
        { label: "편입 후 평균", value: pct(avg), tone: toneOf(avg) },
        { label: "수익 중", value: `${winners}/${rated.length}` },
        { label: "오늘 신규", value: String(active.filter((e) => e.isNew).length) },
      ],
      blocks: [
        { title: "잘 가는 것", items: sorted.slice(0, 6).map(item) },
        { title: "밀리는 것", items: sorted.slice(-4).reverse().map(item) },
      ],
    };
  });
}

/* ── 일정 ── */
const kindLabel = (k: string) => EVENT_KINDS.find((x) => x.key === k)?.label ?? k;
function kstToday(): Date {
  return new Date(Date.now() + 9 * 3600_000);
}
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/** 검색어가 있으면 **앞뒤 반년**에서 찾고, 없으면 다가오는 2주 */
async function calendarSection(words: string[], month: string | null): Promise<SysSection> {
  const searching = words.length > 0 || month !== null;
  return timed("calendar", "calendar", searching ? `일정 검색 「${[...words, month ?? ""].filter(Boolean).join(" ")}」` : "다가오는 일정 (2주)", async () => {
    let ev;
    if (searching) {
      const t = kstToday();
      const from = ymd(new Date(t.getTime() - 180 * 86400_000));
      const to = ymd(new Date(t.getTime() + 365 * 86400_000));
      const all = await listEventsRange(from, to);
      const low = words.map((w) => w.toLowerCase());
      ev = all.filter((e) => {
        const hay = `${e.title} ${e.memo ?? ""} ${kindLabel(e.kind)} ${(e as { country?: string }).country ?? ""}`.toLowerCase();
        const wordOk = low.length === 0 || low.some((w) => hay.includes(w));
        const monthOk = month === null || e.date.startsWith(month);
        return wordOk && monthOk;
      });
    } else {
      ev = await upcomingEvents(14);
    }
    const today = ymd(kstToday());
    return {
      head: searching ? [{ label: "건", value: String(ev.length) }] : undefined,
      blocks: [
        ev.length
          ? {
              items: ev.slice(0, 20).map((e) => ({
                text: e.title,
                sub: `${e.date}${e.time ? ` ${e.time}` : ""} · ${kindLabel(e.kind)}${e.todo ? (e.done ? " · 완료" : " · 할 일") : ""}${e.memo ? ` — ${e.memo.slice(0, 60)}` : ""}`,
                tone: (e.date < today ? "muted" : e.date === today ? "good" : undefined) as SysTone | undefined,
              })),
            }
          : { lines: [{ text: searching ? "그런 일정이 없다 (앞 반년 ~ 뒤 1년)" : "2주 안에 잡힌 일정이 없다", tone: "muted" }] },
      ],
    };
  });
}

/* ── 메모장 ── */
async function memoSection(words: string[]): Promise<SysSection> {
  return timed("memo", "memo", words.length ? `메모 검색 「${words.join(" ")}」` : "최근 메모", async () => {
    const all = await listMemos("");
    const low = words.map((w) => w.toLowerCase());
    const hit = low.length
      ? all.filter((m) => {
          const hay = `${m.title} ${m.body} ${m.tags.join(" ")} ${(m.stocks ?? []).map((s) => s.name).join(" ")}`.toLowerCase();
          return low.some((w) => hay.includes(w));
        })
      : all;
    return {
      head: [{ label: "건", value: `${hit.length}${low.length ? ` / ${all.length}` : ""}` }],
      blocks: [
        hit.length
          ? {
              items: hit.slice(0, 12).map((m) => {
                const body = m.body.replace(/\s+/g, " ");
                const at = low.length ? Math.max(0, ...low.map((w) => body.toLowerCase().indexOf(w)).filter((i) => i >= 0)) : 0;
                const snippet = body.slice(Math.max(0, at - 40), at + 160);
                return {
                  text: `${m.pinned ? "📌 " : ""}${m.title || "(제목 없음)"}`,
                  sub: `${m.at.slice(0, 10)}${m.tags.length ? ` · #${m.tags.join(" #")}` : ""}${(m.stocks ?? []).length ? ` · ${(m.stocks ?? []).map((s) => s.name).join("·")}` : ""} — ${snippet}`,
                  stock: (m.stocks ?? [])[0],
                };
              }),
            }
          : { lines: [{ text: "그런 메모가 없다", tone: "muted" }] },
      ],
    };
  });
}

/* ── 복기 노트 ── */
async function journalSection(words: string[]): Promise<SysSection> {
  return timed("journal", "journal", words.length ? `복기 노트 검색 「${words.join(" ")}」` : "최근 복기 노트", async () => {
    const all = await listEntries(365);
    const low = words.map((w) => w.toLowerCase());
    const text = (e: (typeof all)[number]) =>
      [e.what, e.why, e.lesson, e.tomorrow, e.brokenRule, e.mood, ...(e.mistakes ?? []), ...(e.watchReasons ?? []), ...(e.trades ?? []).map((t) => (t as unknown as { name?: string }).name ?? ""), ...(e.picks ?? []).map((p) => (p as unknown as { name?: string }).name ?? "")]
        .filter(Boolean)
        .join(" ");
    const hit = low.length ? all.filter((e) => low.some((w) => text(e).toLowerCase().includes(w))) : all.slice(0, 5);
    return {
      head: [{ label: "건", value: `${hit.length}${low.length ? ` / ${all.length}` : ""}` }],
      blocks: [
        hit.length
          ? {
              items: hit.slice(0, 10).map((e) => ({
                text: `${e.date} ${e.stance === "watch" ? "관망" : "매매"}${e.followedRules === false ? " · 규칙 어김" : ""}${e.mood ? ` · ${e.mood}` : ""}`,
                sub: [e.what && `한 것: ${e.what}`, e.why && `왜: ${e.why}`, e.lesson && `배운 것: ${e.lesson}`, e.tomorrow && `내일: ${e.tomorrow}`, e.mistakes?.length && `실수: ${e.mistakes.join(", ")}`]
                  .filter(Boolean)
                  .join(" / ")
                  .slice(0, 260),
                tone: (e.followedRules === false ? "warn" : undefined) as SysTone | undefined,
              })),
            }
          : { lines: [{ text: "그런 복기가 없다 (1년)", tone: "muted" }] },
      ],
    };
  });
}

/* ── 일정 넣기 — 제안만 만든다. 저장은 act() 가 「넣기」를 눌렀을 때 ── */
const WEEKDAY: Record<string, number> = { 일: 0, 월: 1, 화: 2, 수: 3, 목: 4, 금: 5, 토: 6 };
function parseEventProposal(q: string): SysProposal | null {
  const now = kstToday();
  let s = q;
  let date: string | null = null;
  const take = (re: RegExp, f: (m: RegExpMatchArray) => void) => {
    const m = s.match(re);
    if (m) {
      f(m);
      s = s.replace(m[0], " ");
    }
  };
  /* 날짜 — 구체적인 것부터 */
  take(/(\d{4})[-./년]\s?(\d{1,2})[-./월]\s?(\d{1,2})일?/, (m) => {
    date = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  });
  if (!date) take(/(\d{1,2})\s?[/월]\s?(\d{1,2})일?/, (m) => {
    const mo = Number(m[1]);
    const d = Number(m[2]);
    let y = now.getUTCFullYear();
    if (mo < now.getUTCMonth() + 1 - 1) y += 1; // 지난달보다 이전이면 내년
    date = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  });
  if (!date) take(/(오늘|내일|모레|글피)/, (m) => {
    const add = { 오늘: 0, 내일: 1, 모레: 2, 글피: 3 }[m[1]] ?? 0;
    date = ymd(new Date(now.getTime() + add * 86400_000));
  });
  if (!date) take(/(이번 ?주|다음 ?주|담주)?\s?([일월화수목금토])요일/, (m) => {
    const target = WEEKDAY[m[2]];
    const cur = now.getUTCDay();
    let diff = (target - cur + 7) % 7;
    if (/다음|담주/.test(m[1] ?? "")) diff += diff === 0 ? 7 : 7 - (diff > 0 ? 0 : 0);
    if (diff === 0 && !/이번/.test(m[1] ?? "")) diff = 7;
    date = ymd(new Date(now.getTime() + diff * 86400_000));
  });
  if (!date) take(/(\d{1,2})일(?!\s?(동안|간|치))/, (m) => {
    const d = Number(m[1]);
    const mo = now.getUTCMonth() + 1;
    const y = now.getUTCFullYear();
    const cand = new Date(Date.UTC(y, mo - 1, d));
    const next = cand.getTime() < now.getTime() - 86400_000 ? new Date(Date.UTC(y, mo, d)) : cand;
    date = ymd(next);
  });
  if (!date) return null;

  /* 시각 */
  let time: string | undefined;
  take(/(\d{1,2}):(\d{2})/, (m) => {
    time = `${m[1].padStart(2, "0")}:${m[2]}`;
  });
  if (!time) take(/(오전|오후|아침|저녁|밤|새벽)?\s?(\d{1,2})\s?시\s?(반|(\d{1,2})\s?분)?/, (m) => {
    let h = Number(m[2]);
    const ap = m[1] ?? "";
    if (/오후|저녁|밤/.test(ap) && h < 12) h += 12;
    if (/새벽/.test(ap) && h === 12) h = 0;
    const mi = m[3] === "반" ? 30 : m[4] ? Number(m[4]) : 0;
    time = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  });

  /* 제목 — 명령어·조사를 걷어낸 나머지 */
  const title = s
    .replace(/(캘린더|일정|스케줄)(에|으로|로)?/g, " ")
    .replace(/(넣어|추가해|등록해|잡아|적어)\s?(줘|주라|줄래|주세요|줘요)?/g, " ")
    .replace(/(넣|추가|등록)\s?(해줘|해|하자|해 ?주라)?/g, " ")
    .replace(/\b(좀|그리고|해줘|줘|하자|할게|에|로|으로)\b/g, " ")
    .replace(/[,.!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!title) return null;

  const kind: EventKind = /실적/.test(title) ? "earnings" : /fomc|cpi|고용|pce|gdp|금통위|지표/i.test(title) ? "indicator" : /휴장/.test(title) ? "holiday" : /회의|미팅|면담/.test(title) ? "meeting" : "personal";
  const country = /fomc|cpi|연준|fed|미국/i.test(title) ? "미국" : undefined;
  return {
    id: `ev-${Date.now()}`,
    kind: "addEvent",
    title: "이렇게 넣을까?",
    facts: [
      { label: "날짜", value: date },
      { label: "시각", value: time ?? "종일", tone: time ? undefined : "muted" },
      { label: "제목", value: title },
      { label: "종류", value: kindLabel(kind), tone: "muted" },
      ...(country ? [{ label: "나라", value: country, tone: "muted" as SysTone }] : []),
    ],
    payload: { date, time, title, kind, country },
  };
}

/** 「넣기」를 눌렀을 때 — 제안을 실제로 저장한다 */
export async function act(kind: string, payload: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  if (kind === "addEvent") {
    const date = String(payload.date ?? "");
    const title = String(payload.title ?? "").trim();
    const time = payload.time ? String(payload.time) : undefined;
    const k = String(payload.kind ?? "personal") as EventKind;
    await addEvent({
      date,
      title,
      time,
      kind: EVENT_KINDS.some((x) => x.key === k) ? k : "personal",
      source: "sys",
      ...(payload.country ? { country: String(payload.country) } : {}),
    } as Omit<import("./calendar.js").CalendarEvent, "id">);
    return { ok: true, message: `${date}${time ? ` ${time}` : ""} 「${title}」 넣었다 — 캘린더에서 확인` };
  }
  return { ok: false, message: `모르는 일: ${kind}` };
}

/* ── 공시 (오늘) ── */
async function disclosureSection(): Promise<SysSection> {
  return timed("disclosure", "disclosure", "오늘 공시", async () => {
    const { day, events } = await todayDartEvents();
    const sorted = [...events].sort((a, b) => Number(b.watched) - Number(a.watched) || b.weight - a.weight);
    return {
      head: [{ label: day, value: `${events.length}건 · 관심 ${events.filter((e) => e.watched).length}` }],
      blocks: [{ items: sorted.slice(0, 15).map((e) => ({ text: `${e.watched ? "⭐ " : ""}${e.corpName} — ${e.title}${e.amended ? " (정정)" : ""}`, sub: e.themes.join("·") || e.market, link: e.url, stock: /^\d{6}$/.test(e.stockCode) ? { code: e.stockCode, name: e.corpName } : undefined })) }],
    };
  });
}

/* ── 뉴스 (종목 없이) ── */
async function newsSection(keywords: string[]): Promise<SysSection> {
  return timed("news", "news", keywords.length ? `뉴스 「${keywords.join(" ")}」` : "주요 뉴스", async () => {
    if (keywords.length) {
      const items = await searchNews(keywords.join(" "), { limit: 12 }).catch(() => []);
      return { blocks: [{ items: newsItems(items, 12) }] };
    }
    const [main, brk] = await Promise.all([mainNews(10).catch(() => []), breakingNews().catch(() => null)]);
    const blocks: SysBlock[] = [{ title: "주요", items: newsItems(main, 10) }];
    for (const c of brk?.categories ?? []) if (c.items.length) blocks.push({ title: c.label, items: newsItems(c.items, 5) });
    return { blocks };
  });
}

/* ── 텔레그램 ── */
async function telegramSection(words: string[]): Promise<SysSection> {
  return timed("telegram", "telegram", words.length ? `텔레그램 「${words.join(" · ")}」` : "텔레그램 최근", async () => {
    /*
     * 콕 집어 물었으니 **전 채널 실시간**으로 — 단 25초 안에. 넘기면 수집분으로 물러선다.
     * 화면은 그동안 채널 진행(/api/channels/search-progress)을 보여 준다.
     */
    const took: Record<string, number> = {};
    const w = words.length ? words : ["매수", "급등", "주목", "실적", "공시"];
    const minutes = words.length ? 24 * 60 : 3 * 60;
    let items = await part(took, "실시간", channelItemsLive(w, minutes, 12), [], 25_000);
    let note = "전 채널 실시간";
    if (items.length === 0) {
      items = await channelItems(w, minutes, 12);
      note = took["실시간"] === -1 ? "실시간 훑기가 25초를 넘겨 주요 채널 수집분으로" : "실시간에 없어 주요 채널 수집분으로";
    }
    return {
      blocks: [items.length ? { title: note, items } : { lines: [{ text: "걸린 글이 없다 — 수집 중인 채널 안에서만 찾는다", tone: "muted" }] }],
      took,
    };
  });
}

const MACRO_KEYS: MacroKey[] = ["usFut", "night", "oil", "metal", "fx", "rates", "crypto"];

const MACRO_EXAMPLES: Record<MacroKey, string[]> = {
  usFut: ["지금 미장 선물 어때?", "나스닥 선물 오르고 있어?", "VIX 얼마야?"],
  night: ["야간선물 어떻게 끝났어?", "코스피 야간선물 봐줘"],
  oil: ["유가는?", "WTI 오늘 어때?", "원유 가격 추세"],
  metal: ["금값 어때?", "구리 가격 올라?"],
  fx: ["환율 지금 얼마야?", "달러 오르는 추세야?"],
  rates: ["금리 오늘 오르는 추세야?", "미국 10년물 금리 어때?", "국채 금리 봐줘"],
  crypto: ["비트코인 얼마야?", "코인 오늘 어때?"],
};

const TOPICS: Topic[] = [
  {
    key: "stock",
    title: "종목",
    match: (c) => c.stocks.length > 0,
    gather: (c) => {
      const parts = stockPartsOf(c.q);
      return Promise.all(c.stocks.map((s) => stockSection(c.client, s, parts)));
    },
    examples: ["두산에너빌리티 시세좀", "하이닉스 뉴스 있어?", "삼성전자 실적 어때?"],
  },
  { key: "etf", title: "ETF", match: (c) => RE.etf.test(c.q) || matchesExamples("etf", c.q), gather: (c) => etfSection(c.client, c.stocks).then((s) => [s]), examples: ["두산에너빌리티 담은 ETF들 오늘 성적 어때?", "반도체 ETF 오늘 어때?", "오늘 오르는 ETF 뭐야?"] },
  ...MACRO_KEYS.map<Topic>((k) => ({ key: `macro:${k}`, title: MACRO_TITLE[k], match: (c) => RE[k].test(c.q) || matchesExamples(`macro:${k}`, c.q), gather: () => macroSection(k).then((s) => [s]), examples: MACRO_EXAMPLES[k] })),
  { key: "theme", title: "테마", match: (c) => c.themes.length > 0, gather: (c) => Promise.all(c.themes.map(themeSection)) },
  {
    key: "cis",
    title: "CIS 일지",
    match: (c) => RE.cis.test(c.q) || matchesExamples("cis", c.q),
    examples: ["CIS 일지 요즘 수익권이래?", "종배 계좌 어때?", "시스 계좌 보유 뭐 있어?"],
    gather: (c) => {
      const ids = (Object.keys(ACCOUNTS) as AccountId[]).filter((id) => {
        const q = c.q;
        if (/종배/.test(q)) return id === "close";
        if (/연금|pension/i.test(q)) return id === "pension";
        if (/irp/i.test(q)) return id === "irp";
        if (/트레이딩/.test(q) && !/종배/.test(q)) return id === "trade";
        return true;
      });
      return Promise.all(ids.map((id) => cisSection(c.client, id)));
    },
  },
  { key: "watch", title: "관심종목", match: (c) => RE.watch.test(c.q) || matchesExamples("watch", c.q), gather: (c) => watchSection(c.client).then((s) => [s]), examples: ["관심종목 오늘 어때?", "내 종목 중에 오늘 많이 빠진 거", "관심종목 쌍끌이 뭐 있어?"] },
  { key: "ledger", title: "신호등 원장", match: (c) => RE.ledger.test(c.q) || matchesExamples("ledger", c.q), gather: (c) => ledgerSection(c.client).then((s) => [s]), examples: ["슈퍼신호등 원장 잘 가?", "신호등 초록 종목 뭐 있어?", "무지개 종목 있어?"] },
  {
    key: "calendar",
    title: "일정",
    match: (c) => (RE.calendar.test(c.q) || matchesExamples("calendar", c.q)) && !RE.addEvent.test(c.q),
    examples: ["9월 일정 뭐 있어?", "이번주 일정", "FOMC 언제야?", "실적 발표 일정 알려줘"],
    gather: (c) => {
      const m = c.q.match(/(\d{1,2})월/);
      const month = m ? `${kstToday().getUTCFullYear()}-${m[1].padStart(2, "0")}` : null;
      const words = keywordsOf(c.q).filter((w) => !/^(일정|캘린더|스케줄|이벤트|이번주|다음주|이번|다음|언제|있어|뭐|뭐야|\d+월)$/.test(w) && !c.stocks.some((s) => s.name === w));
      return calendarSection([...words, ...c.stocks.map((s) => s.name)], month).then((s) => [s]);
    },
  },
  { key: "memo", title: "메모", match: (c) => RE.memo.test(c.q) || matchesExamples("memo", c.q), gather: (c) => memoSection([...keywordsOf(c.q).filter((w) => !/^(메모|메모장|일기)$/.test(w)), ...c.stocks.map((s) => s.name)]).then((s) => [s]), examples: ["하이닉스 메모 적어 둔 거 있나?", "메모장에서 원전 찾아줘", "최근 메모 뭐 있어?"] },
  { key: "journal", title: "복기 노트", match: (c) => RE.journal.test(c.q) || matchesExamples("journal", c.q), gather: (c) => journalSection([...keywordsOf(c.q).filter((w) => !/^(복기|복기노트|노트|매매일지|일지)$/.test(w)), ...c.stocks.map((s) => s.name)]).then((s) => [s]), examples: ["복기 노트에서 손절 관련 찾아줘", "지난주 복기 뭐라고 적었지?", "매매일지에서 규칙 어긴 날"] },
  { key: "disclosure", title: "공시", match: (c) => (RE.disclosure.test(c.q) || matchesExamples("disclosure", c.q)) && c.stocks.length === 0, gather: () => disclosureSection().then((s) => [s]), wantsFocus: true, examples: ["오늘 공시 뭐 있어?", "관심종목 공시 떴어?"] },
  { key: "news", title: "뉴스", match: (c) => (RE.news.test(c.q) || matchesExamples("news", c.q)) && c.stocks.length === 0 && !RE.market.test(c.q), gather: (c) => newsSection(keywordsOf(c.q).filter((w) => !c.themes.includes(w))).then((s) => [s]), wantsFocus: true, examples: ["오늘 주요 뉴스", "속보 있어?", "원전 관련 기사 찾아줘"] },
  { key: "telegram", title: "텔레그램", match: (c) => (RE.telegram.test(c.q) || matchesExamples("telegram", c.q)) && c.stocks.length === 0, gather: (c) => telegramSection(keywordsOf(c.q)).then((s) => [s]), wantsFocus: true, examples: ["텔레 요즘 뭐래?", "채널에서 반도체 얘기 찾아줘"] },
  { key: "market", title: "시장", match: (c) => RE.market.test(c.q) || matchesExamples("market", c.q), gather: (c) => marketSection(c.client).then((s) => [s]), examples: ["오늘 시장 왜 이래?", "코스피 어때?", "외국인 수급 어느 쪽이야?", "오늘 주도 테마 뭐야?"] },
];

// ---------------------------------------------------------------- 수집

/** 해석만 — 수 ms. 화면이 「무엇을 긁는 중인지」를 먼저 띄우려고 따로 부른다 */
export async function interpret(
  client: KiwoomClient,
  question: string,
  focus?: SysStockRef | null,
): Promise<{ ctx: Ctx; hit: Topic[]; intent: SysIntent }> {
  const q = question.trim();
  const stocks = await findStocks(client, q);
  const themes = await findThemes(q, stocks);
  const ctx: Ctx = { client, q, compact: q.replace(/\s+/g, ""), stocks, themes, focus: focus ?? null };
  vocabCache = await vocab();
  vocabStocks = [...stocks.map((s) => s.name.replace(/\s+/g, "").toLowerCase()), ...Object.keys(ALIAS_PUBLIC)];

  let hit = TOPICS.filter((t) => t.match(ctx));
  /* 「일지」는 CIS 일지지만 「복기」가 같이 있으면 복기 노트 얘기다 */
  if (RE.journal.test(q) && !/cis|시스/i.test(q)) hit = hit.filter((t) => t.key !== "cis");
  const notes: string[] = [];
  /*
   * 종목이 없는데 「뉴스 있어?」「공시 떴어?」처럼 종목에 딸린 것만 물으면 — 지금 보고 있는
   * 종목 얘기다. 아무것도 못 알아들었으면 시장으로 친다.
   */
  if (stocks.length === 0 && focus && hit.length > 0 && hit.every((t) => t.wantsFocus)) {
    ctx.stocks = [focus];
    notes.push(`지금 보고 있는 ${focus.name} 얘기로 들었어`);
    hit = TOPICS.filter((t) => t.match(ctx));
  }
  if (hit.length === 0 && !RE.addEvent.test(q)) hit = TOPICS.filter((t) => t.key === "market");

  if (ctx.stocks.length) notes.push(`종목 ${ctx.stocks.map((s) => s.name).join("·")}`);
  if (themes.length) notes.push(`테마 ${themes.join("·")}`);
  const others = hit.filter((t) => t.key !== "stock" && t.key !== "theme").map((t) => t.title);
  if (others.length) notes.push(others.join("·"));
  return { ctx, hit, intent: { topics: hit.map((t) => t.key), stocks: ctx.stocks, themes, note: notes.join(" · ") } };
}

export async function gather(
  client: KiwoomClient,
  question: string,
  focus?: SysStockRef | null,
  opts: { noClarify?: boolean } = {},
): Promise<SysPack> {
  const t0 = Date.now();
  const { ctx, hit, intent } = await interpret(client, question, focus);

  /* ② 되묻기 — 종목만 있고 무엇을 볼지 없으면 */
  if (!opts.noClarify && ctx.stocks.length > 0 && hit.every((t) => t.key === "stock") && stockPartsOf(ctx.q) === null && !/(다|전부|전체|모두)\s*[?!.]?$/.test(ctx.q)) {
    const n = ctx.stocks.map((s) => s.name).join("·");
    return {
      question,
      at: new Date().toISOString(),
      intent,
      sections: [],
      clarify: {
        question: `${n} — 뭘 볼까?`,
        options: [
          { label: "시세·수급·신호등", send: `${n} 시세 수급 신호등` },
          { label: "뉴스·공시·텔레", send: `${n} 뉴스 공시 텔레` },
          { label: "실적·목표가·테마·ETF", send: `${n} 실적 목표가 테마 ETF` },
          { label: "다", send: `${n} 다` },
        ],
      },
      ms: Date.now() - t0,
    };
  }
  /* 일정 넣기 — 긁는 게 아니라 제안이다. 종목이 같이 있으면 종목 섹션도 같이 온다 */
  const proposals: SysProposal[] = [];
  if (RE.addEvent.test(ctx.q)) {
    const p = parseEventProposal(ctx.q);
    if (p) {
      proposals.push(p);
      intent.topics.push("addEvent");
      intent.note = `${intent.note ? `${intent.note} · ` : ""}일정 넣기`;
    }
  }
  const only = proposals.length && hit.every((t) => t.key === "market") ? [] : hit;
  const sections = (await Promise.all(only.map((t) => t.gather(ctx)))).flat();
  const pack: SysPack = { question, at: new Date().toISOString(), intent, sections, proposals: proposals.length ? proposals : undefined, ms: Date.now() - t0 };
  void remember(pack).catch(() => undefined);
  return pack;
}

// ---------------------------------------------------------------- ① 기억과 되짚기

interface MemoryRow {
  at: string;
  q: string;
  topics: string[];
  /** 물었을 때의 가격 — 되짚기가 「그 뒤로 얼마나」를 잰다 */
  stocks: { code: string; name: string; price: number | null; changeRate: number | null }[];
}

/** 오늘 무엇을 물었나 — 한 줄씩 붙인다. 화면·되짚기가 읽는다 */
async function remember(pack: SysPack): Promise<void> {
  const stocks = pack.sections
    .filter((s) => s.stock)
    .map((s) => {
      const px = s.head?.find((f) => f.label === "현재가")?.value ?? "";
      const m = px.match(/^([\d,]+)\s*\(([-+]?[\d.]+)%\)/);
      return { code: s.stock!.code, name: s.stock!.name, price: m ? Number(m[1].replace(/,/g, "")) : null, changeRate: m ? Number(m[2]) : null };
    });
  const row: MemoryRow = { at: pack.at, q: pack.question, topics: pack.intent.topics, stocks };
  await mkdir(DATA_DIR, { recursive: true });
  await appendFile(MEMORY_FILE, `${JSON.stringify(row)}\n`, "utf-8");
}

async function readMemory(day: string): Promise<MemoryRow[]> {
  try {
    const text = await readFile(MEMORY_FILE, "utf-8");
    const out: MemoryRow[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as MemoryRow;
        if (new Date(new Date(r.at).getTime() + 9 * 3600_000).toISOString().slice(0, 10) === day) out.push(r);
      } catch {
        /* 깨진 줄 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export interface SysRecap {
  day: string;
  asked: number;
  /** 물어본 종목마다 — 그때 → 지금 */
  stocks: { code: string; name: string; askedAt: string; then: number | null; now: number | null; move: number | null; foreign: number | null; inst: number | null; line: string }[];
  topics: string[];
}

/**
 * **오늘 되짚기** (2026-09-03 업그레이드 ① — "저녁에 「오늘 네가 물어본 두산에너빌리티, 그 뒤로 +2%
 * 더 갔고 외인은 계속 팔았어」처럼 먼저 말 걸게").
 * 물었을 때 가격 → 지금 가격, 오늘 외인·기관 순매수. 종목 최대 여섯(많이 물은 순).
 */
export async function recapToday(client: KiwoomClient): Promise<SysRecap> {
  const day = ymd(kstToday());
  const rows = await readMemory(day);
  const first = new Map<string, { code: string; name: string; askedAt: string; then: number | null; count: number }>();
  for (const r of rows) {
    for (const s of r.stocks) {
      const hit = first.get(s.code);
      if (hit) hit.count += 1;
      else first.set(s.code, { code: s.code, name: s.name, askedAt: r.at, then: s.price, count: 1 });
    }
  }
  const picked = [...first.values()].sort((a, b) => b.count - a.count).slice(0, 6);
  const prices = picked.length ? await priceMap(client, picked.map((p) => p.code)).catch(() => new Map<string, number>()) : new Map<string, number>();
  const stocks: SysRecap["stocks"] = [];
  for (const p of picked) {
    const now = prices.get(p.code) ?? null;
    const sum = await stockSummary(client, p.code).catch(() => null);
    const foreign = sum?.main.find((m) => /외국인/.test(m.label))?.amount ?? null;
    const inst = sum?.main.find((m) => /기관/.test(m.label))?.amount ?? null;
    const move = now !== null && p.then ? ((now - p.then) / p.then) * 100 : null;
    const at = new Date(p.askedAt);
    const hhmm = `${String((at.getUTCHours() + 9) % 24).padStart(2, "0")}:${String(at.getUTCMinutes()).padStart(2, "0")}`;
    const line =
      `${p.name}: ${hhmm}에 물었을 때 ${p.then ? num(p.then) : "?"} → 지금 ${now !== null ? num(now) : "?"}` +
      `${move !== null ? ` (${move > 0 ? "+" : ""}${move.toFixed(1)}%)` : ""}` +
      `${foreign !== null || inst !== null ? ` · 오늘 외인 ${foreign !== null ? won(foreign) : "-"} / 기관 ${inst !== null ? won(inst) : "-"}백만` : ""}`;
    stocks.push({ code: p.code, name: p.name, askedAt: p.askedAt, then: p.then, now, move, foreign, inst, line });
  }
  return { day, asked: rows.length, stocks, topics: [...new Set(rows.flatMap((r) => r.topics))] };
}

let recapTimer: ReturnType<typeof setInterval> | null = null;
let recapSentDay = "";
/** 마감 뒤 15:50 KST 평일에 한 번 — 오늘 물어본 종목이 있을 때만 알림함으로 */
export function startSysScheduler(client: KiwoomClient): void {
  if (recapTimer) return;
  recapTimer = setInterval(async () => {
    const k = kstToday();
    const day = ymd(k);
    if (recapSentDay === day) return;
    if (k.getUTCDay() === 0 || k.getUTCDay() === 6) return;
    const hm = k.getUTCHours() * 60 + k.getUTCMinutes();
    if (hm < 15 * 60 + 50 || hm > 16 * 60 + 30) return;
    recapSentDay = day;
    try {
      const r = await recapToday(client);
      if (r.stocks.length === 0) return;
      await pushNotice({
        source: "sys",
        kind: "stock",
        level: "info",
        title: `시스 되짚기 — 오늘 물어본 ${r.stocks.length}종목, 그 뒤로`,
        body: r.stocks.map((s) => s.line).join("\n"),
        link: r.stocks.length === 1 ? stockLink(r.stocks[0].code, r.stocks[0].name) : "#/watchAi",
        dedupeKey: `sys:recap:${day}`,
        dedupeHours: 20,
      });
    } catch {
      /* 되짚기가 실패해도 다음 날 다시 */
    }
  }, 60_000);
  console.log("[sys] 되짚기 스케줄러 시작 (평일 15:50)");
}

// ---------------------------------------------------------------- AI

/** 섹션을 모델이 읽을 글로 — 화면 카드와 같은 재료다 */
export function packToText(p: SysPack): string {
  const out: string[] = [];
  for (const s of p.sections) {
    const L: string[] = [`### ${s.title}${s.stock ? ` (${s.stock.code})` : ""}`];
    if (s.error) L.push(`(못 받음: ${s.error})`);
    if (s.head?.length) L.push(s.head.map((f) => `${f.label} ${f.value}`.trim()).join(" · "));
    for (const b of s.blocks) {
      if (b.title) L.push(`[${b.title}]`);
      if (b.facts?.length) L.push(b.facts.map((f) => `${f.label} ${f.value}`.trim()).join(" · "));
      if (b.lines?.length) L.push(...b.lines.map((l) => `- ${l.text}`));
      if (b.items?.length) L.push(...b.items.map((i) => `- ${i.sub ? `${i.sub} ` : ""}${i.text.replace(/\s+/g, " ").slice(0, 220)}`));
      if (b.text) L.push(b.text);
    }
    if (s.missing?.length) L.push(`(못 받은 것: ${s.missing.join(", ")})`);
    out.push(L.join("\n"));
  }
  for (const pr of p.proposals ?? []) out.push(`### 제안: ${pr.title}\n${pr.facts.map((f) => `${f.label} ${f.value}`).join(" · ")}\n(사용자가 「넣기」를 눌러야 저장된다)`);
  return out.join("\n\n");
}

export function isSysAiReady(): boolean {
  return isAskConfigured();
}

/** 일반 모드 + (AI 모드면) 묶음을 문맥으로 물어본 답 */
/**
 * ③ **판단 거리 두기** (2026-09-03 업그레이드) — 답 끝에 늘 세 줄. 매수·매도 추천은 계속 안 하되
 * 「내가 본 재료 중 어느 게 제일 무거운지」는 말한다.
 */
const SYS_SUFFIX = `<sys_rules>
답의 맨 끝에 다음 세 줄을 **반드시** 붙이십시오(제목 그대로, 각 한 줄):
- 제일 무거운 재료: (위 재료 중 지금 이 종목·시장을 움직이는 데 가장 무거운 것 하나와 이유)
- 이 답이 틀릴 수 있는 이유: (데이터 지연·표본 부족·해석의 빈틈 등 구체적으로)
- 내가 확인 안 한 것: (이 답을 믿기 전에 사용자가 직접 봐야 할 것 하나)
매수·매도 추천은 여전히 하지 않습니다.
</sys_rules>`;

export async function askSys(
  client: KiwoomClient,
  question: string,
  opts: { ai?: boolean; history?: AskTurn[]; focus?: SysStockRef | null; useSearch?: boolean; noClarify?: boolean } = {},
): Promise<SysAnswer> {
  /* AI 모드는 되묻지 않는다 — 질문 자체가 「정리해 달라」는 뜻이라 다 긁어 넘긴다 */
  const pack = await gather(client, question, opts.focus, { noClarify: opts.noClarify || opts.ai });
  if (!opts.ai) return { pack, ai: null };

  /* 시장을 물으면 「시황 질문하기」가 쓰던 요약도 같이 — 종목·거시만 물으면 묶음으로 충분하다 */
  let context = `=== 시스가 모은 것 (${new Date().toLocaleString("ko-KR", { hour12: false })}) — 해석: ${pack.intent.note} ===\n${packToText(pack)}`;
  if (pack.intent.topics.includes("market")) {
    const digest = await buildDigest(client).catch(() => "");
    if (digest) context += `\n\n=== 시장 요약 ===\n${digest}`;
  }

  /*
   * 어느 모델로 — Claude 면 웹 검색까지(askMarket). 다른 provider(Gemini·OpenAI)를 골랐으면
   * 검색 도구가 없으니 **묶음만으로** 답한다(summarize 경로). 벤티지: "왜 클로드밖에 못 고르는 거야?"
   */
  const choice = await choiceFor("sys");
  if (choice && choice.provider !== "anthropic") {
    const history = (opts.history ?? []).slice(-8).map((t) => `${t.role === "user" ? "사용자" : "답"}: ${t.text}`).join("\n\n");
    const prompt =
      `${ASK_SYSTEM.replace(/<search_first>[\s\S]*<\/search_first>/, "").replace(/2\. web_search 도구[^\n]*\n/, "")}\n\n` +
      `⚠️ 이 모델에는 웹 검색이 없습니다. 아래 [시스가 모은 것]에 없는 사실은 모른다고 하십시오.\n\n${SYS_SUFFIX}\n\n` +
      `${context}\n\n${history ? `=== 앞선 대화 ===\n${history}\n\n` : ""}=== 질문 ===\n${question}`;
    const r = await summarize(prompt, 2500, "sys");
    return {
      pack,
      ai: {
        text: r.text,
        searches: [],
        sources: [],
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        model: r.usedModel ?? choice.model,
        error: r.error,
      },
    };
  }

  const ai = await askMarket(client, question, opts.history ?? [], {
    useSearch: opts.useSearch !== false,
    useMarketData: false,
    context,
    purpose: "sys",
    systemSuffix: SYS_SUFFIX,
  });
  return { pack, ai };
}
