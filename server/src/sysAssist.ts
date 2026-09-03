import type { KiwoomClient } from "./kiwoomClient.js";
import { getStockIndex } from "./stockListCache.js";
import { stockSummary } from "./stockSummary.js";
import { evaluateSignal, isNotTheme } from "./signalLight.js";
import { isIndexLikeTheme, themesOfStock } from "./naverThemes.js";
import { themeStrength } from "./themeStrength.js";
import { etfHoldersOf } from "./etfHolders.js";
import { getDisclosures, searchNews, breakingNews } from "./newsDisclosure.js";
import { searchChannels } from "./channelSearch.js";
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
import { upcomingEvents } from "./calendar.js";
import { todayDartEvents } from "./dartEvents.js";

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
  error?: string;
}

export interface SysIntent {
  /** 걸린 주제들 (사람이 읽는 이름) */
  topics: string[];
  stocks: SysStockRef[];
  themes: string[];
  note: string;
}

export interface SysPack {
  question: string;
  at: string;
  intent: SysIntent;
  sections: SysSection[];
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

async function channelItems(words: string[], minutes: number, n: number): Promise<SysItem[]> {
  const r = await searchChannels(words, minutes, n).catch(() => null);
  if (!r) return [];
  return r.hits.slice(0, n).map((h) => ({
    text: h.text.length > 400 ? `${h.text.slice(0, 400)}…` : h.text,
    sub: `[${h.channelName}] ${when(h.at)}`,
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
  for (const e of index.values()) {
    const name = e.name.trim();
    if (name.length < 2 || /스팩|SPAC/i.test(name)) continue;
    const nc = name.replace(/\s+/g, "");
    let at = -1;
    if (name.length >= 3) at = compact.indexOf(nc);
    else if (new RegExp(`(^|[\\s,.?!·])${esc(name)}($|[\\s,.?!·은는이가의도를을])`).test(q)) at = compact.indexOf(nc);
    if (at < 0) continue;
    found.push({ code: e.code, name: e.name, start: at, end: at + nc.length });
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
  disclosure: /(공시)/,
  news: /(뉴스|기사|헤드라인|속보|무슨 일|소식)/,
  telegram: /(텔레|텔레그램|채널|톡방|방에서|리딩)/,
};

const STOP = new Set(["오늘", "지금", "요즘", "어때", "어떄", "있어", "뭐래", "뭐야", "왜", "이래", "관련", "대해", "알려줘", "보여줘", "어떤", "성적", "수익권", "추세", "뉴스", "기사", "텔레", "텔레그램", "채널", "공시", "그리고", "그래서", "근데", "좀", "한번"]);
function keywordsOf(q: string): string[] {
  return q
    .replace(/[?!.,·]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/(은|는|이|가|을|를|의|도|에|에서|으로|로|이랑|랑|들|은요|는요)$/, ""))
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .slice(0, 6);
}

/* ── 종목 ── */
async function stockSection(client: KiwoomClient, s: SysStockRef): Promise<SysSection> {
  return timed("stock", `stock:${s.code}`, s.name, async () => {
    const [sum, sig, themes, strength, holders, news, disc, chan, quarters, watch, brief] = await Promise.all([
      stockSummary(client, s.code).catch(() => null),
      evaluateSignal(client, s.code).catch(() => null),
      themesOfStock(s.code).catch(() => []),
      themeStrength("kr").catch(() => ({ themes: [] })),
      etfHoldersOf(s.code).catch(() => ({ holders: [] })),
      searchNews(s.name, { limit: 10 }).catch(() => []),
      getDisclosures(s.code, 30).catch(() => []),
      channelItems([s.name, s.code], 2 * 24 * 60, 8),
      quarterFinance(s.code, 4).catch(() => []),
      listWatchlist().catch(() => []),
      cachedBrief(s.code).catch(() => null),
    ]);
    const price = sum?.facts.price ?? null;
    const opinion = await opinionBrief(s.code, price).catch(() => null);
    const missing: string[] = [];
    if (!sum) missing.push("시세·수급");
    if (!sig) missing.push("신호등");
    const strengthOf = new Map(strength.themes.map((t) => [t.name, t.changeRate]));
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
    const etfs = holders.holders.filter((h) => !isNotTheme(h.name) && (h.weight ?? 0) <= 50).slice(0, 4);
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
    blocks.push(chan.length ? { title: `텔레그램 ${chan.length} (이틀)`, items: chan } : { title: "텔레그램", lines: [{ text: "이틀 안에 이 종목 언급 없음", tone: "muted" }] });
    if (brief?.text) blocks.push({ title: "엮어 둔 회사 소개", text: brief.text });
    return { stock: s, head, blocks, missing };
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
async function calendarSection(): Promise<SysSection> {
  return timed("calendar", "calendar", "다가오는 일정 (2주)", async () => {
    const ev = await upcomingEvents(14);
    return { blocks: [{ items: ev.slice(0, 15).map((e) => ({ text: e.title, sub: `${e.date}${e.time ? ` ${e.time}` : ""}${e.kind ? ` · ${e.kind}` : ""}${e.todo ? (e.done ? " · 완료" : " · 할 일") : ""}` })) }] };
  });
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
    const items = await channelItems(words.length ? words : ["매수", "급등", "주목", "실적", "공시"], words.length ? 24 * 60 : 3 * 60, 12);
    return { blocks: [items.length ? { items } : { lines: [{ text: "걸린 글이 없다 — 수집 중인 채널 안에서만 찾는다", tone: "muted" }] }] };
  });
}

const MACRO_KEYS: MacroKey[] = ["usFut", "night", "oil", "metal", "fx", "rates", "crypto"];

const TOPICS: Topic[] = [
  { key: "stock", title: "종목", match: (c) => c.stocks.length > 0, gather: (c) => Promise.all(c.stocks.map((s) => stockSection(c.client, s))) },
  { key: "etf", title: "ETF", match: (c) => RE.etf.test(c.q), gather: (c) => etfSection(c.client, c.stocks).then((s) => [s]) },
  ...MACRO_KEYS.map<Topic>((k) => ({ key: `macro:${k}`, title: MACRO_TITLE[k], match: (c) => RE[k].test(c.q), gather: () => macroSection(k).then((s) => [s]) })),
  { key: "theme", title: "테마", match: (c) => c.themes.length > 0, gather: (c) => Promise.all(c.themes.map(themeSection)) },
  {
    key: "cis",
    title: "CIS 일지",
    match: (c) => RE.cis.test(c.q),
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
  { key: "watch", title: "관심종목", match: (c) => RE.watch.test(c.q), gather: (c) => watchSection(c.client).then((s) => [s]) },
  { key: "ledger", title: "신호등 원장", match: (c) => RE.ledger.test(c.q), gather: (c) => ledgerSection(c.client).then((s) => [s]) },
  { key: "calendar", title: "일정", match: (c) => RE.calendar.test(c.q), gather: () => calendarSection().then((s) => [s]) },
  { key: "disclosure", title: "공시", match: (c) => RE.disclosure.test(c.q) && c.stocks.length === 0, gather: () => disclosureSection().then((s) => [s]), wantsFocus: true },
  { key: "news", title: "뉴스", match: (c) => RE.news.test(c.q) && c.stocks.length === 0 && !RE.market.test(c.q), gather: (c) => newsSection(keywordsOf(c.q).filter((w) => !c.themes.includes(w))).then((s) => [s]), wantsFocus: true },
  { key: "telegram", title: "텔레그램", match: (c) => RE.telegram.test(c.q) && c.stocks.length === 0, gather: (c) => telegramSection(keywordsOf(c.q)).then((s) => [s]), wantsFocus: true },
  { key: "market", title: "시장", match: (c) => RE.market.test(c.q), gather: (c) => marketSection(c.client).then((s) => [s]) },
];

// ---------------------------------------------------------------- 수집

export async function gather(client: KiwoomClient, question: string, focus?: SysStockRef | null): Promise<SysPack> {
  const t0 = Date.now();
  const q = question.trim();
  const stocks = await findStocks(client, q);
  const themes = await findThemes(q, stocks);
  const ctx: Ctx = { client, q, compact: q.replace(/\s+/g, ""), stocks, themes, focus: focus ?? null };

  let hit = TOPICS.filter((t) => t.match(ctx));
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
  if (hit.length === 0) hit = TOPICS.filter((t) => t.key === "market");

  const sections = (await Promise.all(hit.map((t) => t.gather(ctx)))).flat();
  if (ctx.stocks.length) notes.push(`종목 ${ctx.stocks.map((s) => s.name).join("·")}`);
  if (themes.length) notes.push(`테마 ${themes.join("·")}`);
  const others = hit.filter((t) => t.key !== "stock" && t.key !== "theme").map((t) => t.title);
  if (others.length) notes.push(others.join("·"));

  return {
    question,
    at: new Date().toISOString(),
    intent: { topics: hit.map((t) => t.key), stocks: ctx.stocks, themes, note: notes.join(" · ") },
    sections,
    ms: Date.now() - t0,
  };
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
  return out.join("\n\n");
}

export function isSysAiReady(): boolean {
  return isAskConfigured();
}

/** 일반 모드 + (AI 모드면) 묶음을 문맥으로 물어본 답 */
export async function askSys(
  client: KiwoomClient,
  question: string,
  opts: { ai?: boolean; history?: AskTurn[]; focus?: SysStockRef | null; useSearch?: boolean } = {},
): Promise<SysAnswer> {
  const pack = await gather(client, question, opts.focus);
  if (!opts.ai) return { pack, ai: null };

  /* 시장을 물으면 「시황 질문하기」가 쓰던 요약도 같이 — 종목·거시만 물으면 묶음으로 충분하다 */
  let context = `=== 시스가 모은 것 (${new Date().toLocaleString("ko-KR", { hour12: false })}) — 해석: ${pack.intent.note} ===\n${packToText(pack)}`;
  if (pack.intent.topics.includes("market")) {
    const digest = await buildDigest(client).catch(() => "");
    if (digest) context += `\n\n=== 시장 요약 ===\n${digest}`;
  }
  const ai = await askMarket(client, question, opts.history ?? [], {
    useSearch: opts.useSearch !== false,
    useMarketData: false,
    context,
    purpose: "sys",
  });
  return { pack, ai };
}
