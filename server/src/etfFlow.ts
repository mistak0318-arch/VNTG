/**
 * **ETF 분석 묶음 — 국내 ETF 자금흐름 · 레버리지/인버스 심리** (2026-09-17, 벤티지가 고른 넷 중 서버가 필요한 둘).
 *
 * 둘 다 재료는 **저장해 둔 일봉**(`dailyCloses` — 마감 뒤 정리가 ETF 도 채운다)이다. 캐시에 없는 ETF 만
 * ka10081 을 한 번 받아 그날 하루 들고 있는다(대개 대여섯 종목). 오늘 값은 ETF 전체시세(ka40004, 3분 캐시)의
 * 현재가·거래량으로 잇는다 — cumulativeRank 와 같은 원칙(장이 열린 뒤에만, 캐시에 오늘 봉이 없을 때만).
 *
 * 무엇을 고르나 — 코드를 박아 두지 않는다. 상장 폐지·이름 변경이 잦아서, **이름 규칙**으로 전체시세에서 그때그때
 * 거래대금 제일 큰 것을 고른다(레버리지·인버스·커버드콜·혼합은 뺀다). 그래서 「KODEX 반도체」가 「TIGER 반도체TOP10」
 * 으로 바뀌어도 화면은 산다. 신호등 점수에는 안 들어간다 — 보는 자리다.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { isTradingDay } from "./tradingDay.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { loadCloses, type DayBar } from "./dailyCloses.js";
import { etfAll, type EtfListRow } from "./routes/etf.js";
import { dropPhantomToday } from "./candleGuard.js";

const CHART = "/api/dostk/chart";

export type EtfFlowGroup = "지수" | "테마·업종" | "미국(국내상장)" | "자산·채권";

export interface EtfFlowRow {
  code: string;
  name: string;
  /** 무엇을 대표하나 — 「반도체」「금」 */
  label: string;
  group: EtfFlowGroup;
  price: number;
  /** 오늘 등락률(%) — 전체시세의 값 그대로 */
  d1: number | null;
  d5: number | null;
  d20: number | null;
  /** 최근 5일 평균 거래대금 ÷ 그 앞 20일 평균 (어제까지의 일봉) — 1.5 면 돈이 몰리는 중 */
  volRatio: number | null;
  /** 최근 5일 평균 거래대금(억원) */
  value5: number | null;
  /** 오늘 거래대금(억원) — 전체시세 어림 */
  todayValue: number;
}

interface Pick {
  group: EtfFlowGroup;
  label: string;
  re: RegExp;
}

/* 이름 규칙 — 대표 하나씩. 순서는 화면 순서 */
const PICKS: Pick[] = [
  { group: "지수", label: "코스피200", re: /^KODEX 200$|^TIGER 200$/ },
  { group: "지수", label: "코스닥150", re: /^KODEX 코스닥\s?150$|^TIGER 코스닥\s?150$/ },
  { group: "지수", label: "코스피 고배당", re: /고배당|배당성장/ },
  { group: "테마·업종", label: "반도체", re: /반도체/ },
  { group: "테마·업종", label: "소프트웨어·AI", re: /소프트웨어|인공지능|AI테크|AI플랫폼/ },
  { group: "테마·업종", label: "2차전지", re: /2차전지|이차전지/ },
  { group: "테마·업종", label: "자동차", re: /자동차/ },
  { group: "테마·업종", label: "바이오", re: /바이오|헬스케어/ },
  { group: "테마·업종", label: "은행", re: /은행/ },
  { group: "테마·업종", label: "증권", re: /증권/ },
  { group: "테마·업종", label: "조선", re: /조선/ },
  { group: "테마·업종", label: "방산", re: /방산|방위/ },
  { group: "테마·업종", label: "원전·전력", re: /원자력|원전|전력기기|전력/ },
  { group: "테마·업종", label: "게임·엔터", re: /게임|엔터|미디어|K-POP/ },
  { group: "테마·업종", label: "건설", re: /건설/ },
  { group: "테마·업종", label: "철강", re: /철강/ },
  { group: "테마·업종", label: "화학", re: /화학/ },
  { group: "테마·업종", label: "로봇", re: /로봇/ },
  { group: "테마·업종", label: "인터넷", re: /인터넷/ },
  { group: "미국(국내상장)", label: "나스닥100", re: /나스닥\s?100/ },
  { group: "미국(국내상장)", label: "S&P500", re: /S&P\s?500/ },
  { group: "미국(국내상장)", label: "미국 반도체", re: /미국반도체|필라델피아/ },
  { group: "미국(국내상장)", label: "미국 빅테크", re: /빅테크|테크TOP|미국테크/ },
  { group: "자산·채권", label: "금", re: /골드|금현물|KRX금/ },
  { group: "자산·채권", label: "은", re: /은선물|은현물/ },
  { group: "자산·채권", label: "달러", re: /달러선물/ },
  { group: "자산·채권", label: "원유", re: /WTI원유|원유선물/ },
  { group: "자산·채권", label: "구리", re: /구리/ },
  { group: "자산·채권", label: "미국 장기채", re: /미국채\s?30년|미국30년|미국채30/ },
  { group: "자산·채권", label: "미국 10년채", re: /미국채\s?10년|미국10년/ },
  { group: "자산·채권", label: "국고채", re: /국고채\s?10년|국고채10|국고채30/ },
  { group: "자산·채권", label: "리츠", re: /리츠|부동산인프라/ },
  { group: "자산·채권", label: "머니마켓(대기자금)", re: /머니마켓|MMF|CD금리|KOFR/ },
];
/** 대표에서 빼는 것 — 방향·구조가 다른 상품. 환헤지(H)는 구조가 아니라 안 뺀다(원유·은은 전부 (H)다) */
const NOT_PLAIN = /레버리지|인버스|2X|곱|커버드콜|혼합|채권혼합|월배당/;

/**
 * **이름에서 테마 뼈대를 뽑는다** (2026-10-12 — 벤티지: "대표 200개로 하면 안 되나.
 * 아니면 개수 제한을 꼭 둬야 하는 건가?").
 *
 * 개수 제한은 비용 때문이 아니었다. 위 `PICKS` 가 **손으로 적은 서른 줄**이라, 거기 없는
 * 테마는 ETF 가 있어도 영영 화면에 안 나왔다 — 초전도체·우주항공 같은 것들이 그렇다.
 * 「30여 개」는 기술적 한계가 아니라 **내가 적다 만 목록의 길이**였다.
 *
 * 그래서 목록은 그대로 두고 **자동 발견을 얹는다.** 손으로 적은 것을 지우지 않는 까닭은,
 * 거기 담긴 것이 이름 규칙이 아니라 **분류**(지수인가 자산인가)와 **부르는 이름**이기
 * 때문이다. 자동으로는 「KODEX 200」이 지수인지 테마인지 알 길이 없다.
 *
 * 뽑는 법: 첫 낱말(운용사)을 떼고, 흔한 꼬리말을 걷어낸 나머지를 테마로 본다.
 *   `TIGER 반도체TOP10` → `반도체` · `KODEX 2차전지산업` → `2차전지`
 * 완벽하지 않다 — 「바이오헬스케어」와 「바이오」는 안 묶인다. 그래도 **없는 것보다 낫고**,
 * 틀리면 한 줄이 둘로 보일 뿐이라 값을 왜곡하지는 않는다.
 */
const TAIL = /(TOP\s?\d+|플러스|액티브|산업|테마|코어|그룹|지수|밸류체인|소부장|포커스|셀렉트|프리미어|Plus|Active)+$/i;
function coreName(name: string): string {
  const afterBrand = name.replace(/^\S+\s+/, "");
  return afterBrand
    .replace(/\(.*?\)/g, "")
    .replace(/\s+/g, "")
    .replace(TAIL, "")
    .trim();
}

/** 자동으로 얹을 줄 수 — 거래대금 큰 것부터. 표가 읽히는 길이를 넘기면 줄만 늘고 신호는 안 는다 */
const AUTO_MAX = 24;
/** 이만큼도 안 도는 ETF 는 「돈이 몰린다」를 말할 거리가 못 된다 (억원) */
const AUTO_MIN_VALUE = 20;

/**
 * 대표 고르기 — 거래대금 제일 큰 것. **장 전엔 오늘 거래대금이 전부 0** 이라 동률이 나서 엉뚱한 게 뽑혔다
 * (9/17 07시: 반도체 → IBK K-AI반도체코어테크). 그래서 오늘·어제 중 큰 쪽으로 잰다 — 어제는 일봉 캐시(c×v).
 */
function pickOne(rows: EtfListRow[], p: Pick, lastValue: (code: string) => number, saved: string | undefined): EtfListRow | null {
  const m = rows.filter((r) => p.re.test(r.name));
  if (m.length === 0) return null;
  const plain = m.filter((r) => !NOT_PLAIN.test(r.name));
  const pool = plain.length > 0 ? plain : m;
  /* 장 전(거래대금 전부 0)이면 **장중에 저장해 둔 어제의 대표**를 그대로 — 일봉 캐시에 없는 ETF 는 어제 값도 모르니까 */
  if (pool.every((r) => r.tradeValue === 0) && saved) {
    const hit = pool.find((r) => r.code === saved);
    if (hit) return hit;
  }
  const size = (r: EtfListRow) => Math.max(r.tradeValue, lastValue(r.code));
  return pool.sort((a, b) => size(b) - size(a))[0];
}

/* 장중에 고른 대표를 파일에 남긴다 — 다음 날 장 전에 쓴다 */
const PICKS_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "etfFlowPicks.json");
let savedPicks: Record<string, string> | null = null;
async function loadSavedPicks(): Promise<Record<string, string>> {
  if (savedPicks) return savedPicks;
  try {
    savedPicks = JSON.parse(await readFile(PICKS_FILE, "utf-8")) as Record<string, string>;
  } catch {
    savedPicks = {};
  }
  return savedPicks;
}
async function savePicks(picks: Record<string, string>): Promise<void> {
  savedPicks = picks;
  try {
    await mkdir(dirname(PICKS_FILE), { recursive: true });
    await writeFile(PICKS_FILE, JSON.stringify(picks), "utf-8");
  } catch {
    /* 못 남겨도 화면은 산다 */
  }
}

/* ── 일봉 — 캐시 먼저, 없으면 하루 한 번 받는다 ── */
const fetched = new Map<string, { day: string; bars: DayBar[] }>();

function kstDay(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}
function marketOpened(): boolean {
  const k = new Date(Date.now() + 9 * 3600_000);
  const dow = k.getUTCDay();
  /* 휴장일도 「안 열림」 — 한글날 10시에 asOf=오늘·전 종목 0% 로 나오던 것 (2026-09-18 전수검증 A17) */
  if (!isTradingDay(new Date(`${k.toISOString().slice(0, 10)}T12:00:00+09:00`))) return false;
  return dow !== 0 && dow !== 6 && k.getUTCHours() * 60 + k.getUTCMinutes() >= 9 * 60;
}
function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

async function barsOf(client: KiwoomClient, code: string): Promise<DayBar[]> {
  const cached = (await loadCloses()).bars?.[code];
  if (cached && cached.length >= 30) return cached;
  const today = kstDay();
  const hit = fetched.get(code);
  if (hit && hit.day === today) return hit.bars;
  const res = await client.request<Record<string, unknown>>(CHART, "ka10081", { stk_cd: code, base_dt: today, upd_stkpc_tp: "1" });
  const rows = dropPhantomToday((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]);
  const bars: DayBar[] = rows
    .map((r) => ({ d: String(r.dt ?? ""), o: Math.abs(n(r.open_pric)), h: Math.abs(n(r.high_pric)), l: Math.abs(n(r.low_pric)), c: Math.abs(n(r.cur_prc)), v: Math.abs(n(r.trde_qty)) }))
    .filter((b) => /^\d{8}$/.test(b.d) && b.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
  fetched.set(code, { day: today, bars });
  await new Promise((r) => setTimeout(r, 260));
  return bars;
}

/** 오늘을 뺀 어제까지의 일봉 — 거래대금 배수는 완결된 날로만 */
function settled(bars: DayBar[]): DayBar[] {
  const today = kstDay();
  return bars.length > 0 && bars[bars.length - 1].d === today ? bars.slice(0, -1) : bars;
}

function ratePct(last: number, base: number | undefined): number | null {
  return base && base > 0 ? Math.round(((last - base) / base) * 10000) / 100 : null;
}

function valueStats(bars: DayBar[]): { volRatio: number | null; value5: number | null } {
  const b = settled(bars);
  if (b.length < 25) return { volRatio: null, value5: null };
  const val = (x: DayBar) => x.c * x.v;
  const last5 = b.slice(-5).reduce((s, x) => s + val(x), 0) / 5;
  const prev20 = b.slice(-25, -5).reduce((s, x) => s + val(x), 0) / 20;
  return { volRatio: prev20 > 0 ? Math.round((last5 / prev20) * 100) / 100 : null, value5: Math.round(last5 / 1e8) };
}

/**
 * 한 줄 만들기 — 손으로 적은 대표와 자동으로 찾은 것이 **같은 셈**을 쓰게 한다.
 * 두 벌로 적으면 언젠가 한쪽만 고쳐져서 같은 표 안에서 다른 말을 하게 된다.
 */
async function makeRow(
  client: KiwoomClient,
  r: EtfListRow,
  label: string,
  group: EtfFlowGroup,
  asOf: "오늘" | "어제",
): Promise<EtfFlowRow> {
  let bars: DayBar[] = [];
  try {
    bars = await barsOf(client, r.code);
  } catch {
    /* 못 받으면 오늘 값만 — null 은 「모른다」 */
  }
  const cs = bars.map((b) => b.c);
  if (marketOpened() && bars.length > 0 && bars[bars.length - 1].d !== kstDay() && r.price > 0) cs.push(r.price);
  const last = cs.length > 0 ? cs[cs.length - 1] : r.price;
  const { volRatio, value5 } = valueStats(bars);
  const sb = settled(bars);
  const yday = sb.length >= 2 ? ratePct(sb[sb.length - 1].c, sb[sb.length - 2].c) : null;
  return {
    code: r.code,
    name: r.name,
    label,
    group,
    price: r.price,
    d1: asOf === "오늘" ? r.changeRate : yday,
    d5: cs.length >= 6 ? ratePct(last, cs[cs.length - 6]) : null,
    d20: cs.length >= 21 ? ratePct(last, cs[cs.length - 21]) : null,
    volRatio,
    value5,
    todayValue: r.tradeValue,
  };
}

/* ── ① 자금흐름 ── */
let flowCache: { at: number; rows: EtfFlowRow[] } | null = null;
let flowJob: Promise<{ at: number; rows: EtfFlowRow[] }> | null = null;

export async function etfFlow(client: KiwoomClient, opts: { fresh?: boolean } = {}): Promise<{ at: number; rows: EtfFlowRow[]; note: string; asOf: "오늘" | "어제" }> {
  const NOTE = "대표 ETF 는 이름 규칙으로 그때그때 거래대금 제일 큰 것을 고릅니다(레버리지·인버스·커버드콜 제외). 배수는 어제까지의 일봉, 오늘 등락·거래대금은 전체시세. 장 전에는 어제 등락.";
  /* 장 전(09:00 전·주말)에는 전체시세 등락이 전부 0 이라 「어제」를 보인다 — 0% 스물은 정보가 아니다 */
  const asOf: "오늘" | "어제" = marketOpened() ? "오늘" : "어제";
  /* 카드 ↻ 는 30초 지난 캐시만 버린다 — 연타로 전체시세(15쪽)를 되받지 않게 */
  const fresh = Boolean(opts.fresh) && (!flowCache || Date.now() - flowCache.at > 30_000);
  if (!fresh && flowCache && Date.now() - flowCache.at < 5 * 60_000) return { ...flowCache, note: NOTE, asOf };
  if (flowJob) return { ...(await flowJob), note: NOTE, asOf };
  flowJob = (async () => {
    const all = await etfAll(client, { fresh });
    const barsCache = (await loadCloses()).bars ?? {};
    const lastValue = (code: string): number => {
      const b = barsCache[code];
      const x = b && b.length > 0 ? b[b.length - 1] : null;
      return x ? Math.round((x.c * x.v) / 1e8) : 0;
    };
    const rows: EtfFlowRow[] = [];
    const used = new Set<string>();
    const saved = await loadSavedPicks();
    const picked: Record<string, string> = {};
    for (const p of PICKS) {
      const r = pickOne(all.filter((x) => !used.has(x.code)), p, lastValue, saved[p.label]);
      if (!r) continue;
      used.add(r.code);
      picked[p.label] = r.code;
      rows.push(await makeRow(client, r, p.label, p.group, asOf));
    }

    /*
     * **손으로 안 적은 테마를 얹는다** (2026-10-12). 위 `PICKS` 가 안 집은 ETF 중에서
     * 이름의 뼈대(`coreName`)로 묶고, 묶음마다 거래대금 제일 큰 것 하나씩.
     * 이미 나온 뼈대는 건너뛴다 — 「반도체」가 두 줄이 되면 안 된다.
     */
    const seenCore = new Set(rows.map((r) => coreName(r.name)));
    const restByCore = new Map<string, EtfListRow>();
    for (const r of all) {
      if (used.has(r.code) || NOT_PLAIN.test(r.name)) continue;
      const core = coreName(r.name);
      if (!core || core.length < 2 || seenCore.has(core)) continue;
      const size = Math.max(r.tradeValue, lastValue(r.code));
      if (size < AUTO_MIN_VALUE) continue;
      const had = restByCore.get(core);
      if (!had || Math.max(had.tradeValue, lastValue(had.code)) < size) restByCore.set(core, r);
    }
    const autos = [...restByCore.entries()]
      .sort((a, b) => Math.max(b[1].tradeValue, lastValue(b[1].code)) - Math.max(a[1].tradeValue, lastValue(a[1].code)))
      .slice(0, AUTO_MAX);
    for (const [core, r] of autos) {
      used.add(r.code);
      /* 분류는 자동으로 못 가린다 — 지수·자산은 손으로 적은 쪽이 맡고, 나머지는 테마로 본다 */
      rows.push(await makeRow(client, r, core, "테마·업종", asOf));
    }
    /* 장중 거래대금으로 고른 것만 남긴다 — 장 전의 동률 추첨을 저장하면 그게 다음 날 「어제」가 된다 */
    if (asOf === "오늘" && rows.some((r) => r.todayValue > 0)) await savePicks(picked);
    flowCache = { at: Date.now(), rows };
    return flowCache;
  })().finally(() => {
    flowJob = null;
  });
  return { ...(await flowJob), note: NOTE, asOf };
}

/* ── ①-2 전체 보기 ── */

/**
 * **거래대금 상위 전부** (2026-10-12 — 벤티지: "대표 200개로 하면 안 되나").
 *
 * 대표 보기는 테마마다 한 줄이라 **같은 테마의 다른 ETF 가 더 세게 움직여도 안 보인다.**
 * 그걸 보려면 그냥 늘어놓고 정렬해 보는 길이 있어야 한다.
 *
 * ## 요청 안에서 200번을 받지 않는다
 *
 * 배수를 내려면 ETF 하나에 일봉 25일이 필요한데, 일봉 원장은 **보통주만** 담겨 있어
 * ETF 는 대개 조회로 받아야 한다. 200개를 요청 안에서 받으면 52초를 붙잡는다 —
 * 10/09 에 체결강도로 똑같은 실수를 했고 화면 전체가 같이 멈췄다.
 *
 * 그래서 **아는 것부터 그려 주고 모르는 것은 뒤에서 채운다.** 받아 둔 것은 그날 안에
 * 다시 안 받으므로, 한 번 열어 두면 그 뒤로는 바로 뜬다. 화면에는 「몇 개 채우는 중」을
 * 같이 준다 — 비어 있는 칸을 설명 없이 두면 고장으로 읽힌다.
 *
 * 레버리지·인버스·커버드콜은 **전체 보기에서도 뺀다.** 거래대금으로 줄 세우면 그것들이
 * 앞자리를 다 차지하는데, 이 화면이 묻는 것은 「돈이 어느 테마로」이지 「어느 방향으로」가
 * 아니다. 방향 베팅은 레버리지·인버스 심리 쪽이 따로 답한다.
 */
export const ETF_ALL_LIMIT = 200;

/** 이미 들고 있는 일봉만 — 없으면 null 을 내고 **받으러 가지 않는다** */
function knownBars(code: string, ledger: Record<string, DayBar[]>): DayBar[] | null {
  const c = ledger[code];
  if (c && c.length >= 30) return c;
  const hit = fetched.get(code);
  return hit && hit.day === kstDay() ? hit.bars : null;
}

let fillJob: Promise<void> | null = null;
async function fillBars(client: KiwoomClient, codes: string[]): Promise<void> {
  if (fillJob) return;
  fillJob = (async () => {
    for (const code of codes) {
      await barsOf(client, code).catch(() => []);
    }
  })().finally(() => {
    fillJob = null;
  });
}

export async function etfFlowAll(
  client: KiwoomClient,
  limit = ETF_ALL_LIMIT,
): Promise<{ rows: EtfFlowRow[]; pending: number; note: string; asOf: "오늘" | "어제" }> {
  const asOf: "오늘" | "어제" = marketOpened() ? "오늘" : "어제";
  const all = await etfAll(client);
  const ledger = (await loadCloses()).bars ?? {};
  const lastValue = (code: string): number => {
    const b = ledger[code];
    const x = b && b.length > 0 ? b[b.length - 1] : null;
    return x ? Math.round((x.c * x.v) / 1e8) : 0;
  };
  const size = (r: EtfListRow) => Math.max(r.tradeValue, lastValue(r.code));
  const top = all
    .filter((r) => !NOT_PLAIN.test(r.name))
    .sort((a, b) => size(b) - size(a))
    .slice(0, limit);

  const rows: EtfFlowRow[] = [];
  const missing: string[] = [];
  for (const r of top) {
    const bars = knownBars(r.code, ledger);
    if (!bars) missing.push(r.code);
    const b = bars ?? [];
    const cs = b.map((x) => x.c);
    /* 장중이면 오늘 값을 끝에 얹는다 — 일봉은 어제까지라 5·20일이 하루 묵는다 */
    if (marketOpened() && b.length > 0 && b[b.length - 1].d !== kstDay() && r.price > 0) cs.push(r.price);
    const last = cs.length > 0 ? cs[cs.length - 1] : r.price;
    const { volRatio, value5 } = valueStats(b);
    const sb = settled(b);
    const yday = sb.length >= 2 ? ratePct(sb[sb.length - 1].c, sb[sb.length - 2].c) : null;
    rows.push({
      code: r.code,
      name: r.name,
      label: coreName(r.name) || r.name,
      group: "테마·업종",
      price: r.price,
      d1: asOf === "오늘" ? r.changeRate : yday,
      d5: cs.length >= 6 ? ratePct(last, cs[cs.length - 6]) : null,
      d20: cs.length >= 21 ? ratePct(last, cs[cs.length - 21]) : null,
      volRatio,
      value5,
      todayValue: r.tradeValue,
    });
  }
  if (missing.length > 0) void fillBars(client, missing);
  return {
    rows,
    pending: missing.length,
    asOf,
    note:
      `거래대금 상위 ${limit}개(레버리지·인버스·커버드콜 제외). 배수는 어제까지의 일봉으로, ` +
      "아직 안 받은 ETF 는 배수 칸이 빕니다 — 뒤에서 채우는 중이라 잠시 뒤 다시 보면 들어옵니다.",
  };
}

/* ── ② 레버리지·인버스 심리 ── */
export interface SentimentDay {
  d: string;
  /** 레버리지 거래대금(억) */
  lev: number;
  /** 인버스 + 곱버스 거래대금(억) */
  inv: number;
  /** inv ÷ lev — 1 을 넘으면 하락 베팅 돈이 더 많다 */
  ratio: number | null;
}
export interface SentimentSide {
  market: "코스피" | "코스닥";
  names: { lev: string; inv: string[] };
  days: SentimentDay[];
  today: SentimentDay | null;
  /** 20일 평균 비율 — 오늘이 이보다 한참 위면 하락 베팅 과열 */
  avg20: number | null;
}

const SENT_PICKS = {
  코스피: { lev: /^KODEX 레버리지$/, inv: [/^KODEX 인버스$/, /^KODEX 200선물인버스2X$/] },
  코스닥: { lev: /^KODEX 코스닥\s?150\s?레버리지$/, inv: [/^KODEX 코스닥\s?150\s?선물인버스$/] },
} as const;

let sentCache: { at: number; sides: SentimentSide[] } | null = null;

/* (2026-09-18 전수검증 A16) 동시 호출이 전체시세 15쪽을 두 번 조회하지 않게 — etfFlow 와 같은 in-flight 잠금 */
let sentJob: Promise<{ at: number; sides: SentimentSide[]; note: string }> | null = null;
export async function etfSentiment(client: KiwoomClient, opts: { fresh?: boolean } = {}): Promise<{ at: number; sides: SentimentSide[]; note: string }> {
  if (sentJob) return sentJob;
  sentJob = etfSentimentCompute(client, opts).finally(() => {
    sentJob = null;
  });
  return sentJob;
}

async function etfSentimentCompute(client: KiwoomClient, opts: { fresh?: boolean } = {}): Promise<{ at: number; sides: SentimentSide[]; note: string }> {
  const NOTE =
    "개인이 방향에 거는 돈 — 인버스·곱버스 거래대금을 레버리지 거래대금으로 나눈 것. 비율이 20일 평균을 크게 넘으면 하락 베팅이 몰린 것이라 역발상 재료, 반대로 레버리지만 뜨거우면 상승 추격 과열. 어제까지는 일봉, 오늘은 전체시세 어림.";
  const fresh = Boolean(opts.fresh) && (!sentCache || Date.now() - sentCache.at > 30_000);
  if (!fresh && sentCache && Date.now() - sentCache.at < 5 * 60_000) return { ...sentCache, note: NOTE };
  const all = await etfAll(client, { fresh });
  const sides: SentimentSide[] = [];
  for (const market of ["코스피", "코스닥"] as const) {
    const p = SENT_PICKS[market];
    const lev = all.find((r) => p.lev.test(r.name)) ?? null;
    const invs = p.inv.map((re) => all.find((r) => re.test(r.name))).filter((r): r is EtfListRow => Boolean(r));
    if (!lev || invs.length === 0) continue;
    const levBars = settled(await barsOf(client, lev.code).catch(() => [] as DayBar[]));
    const invBars = await Promise.all(invs.map((r) => barsOf(client, r.code).catch(() => [] as DayBar[])));
    const byDay = new Map<string, SentimentDay>();
    for (const b of levBars.slice(-20)) byDay.set(b.d, { d: b.d, lev: Math.round((b.c * b.v) / 1e8), inv: 0, ratio: null });
    for (const bars of invBars) for (const b of settled(bars)) {
      const row = byDay.get(b.d);
      if (row) row.inv += Math.round((b.c * b.v) / 1e8);
    }
    const days = [...byDay.values()].sort((a, b) => a.d.localeCompare(b.d));
    for (const d of days) d.ratio = d.lev > 0 ? Math.round((d.inv / d.lev) * 100) / 100 : null;
    const ratios = days.map((d) => d.ratio).filter((x): x is number => x !== null);
    const avg20 = ratios.length > 0 ? Math.round((ratios.reduce((s, x) => s + x, 0) / ratios.length) * 100) / 100 : null;
    const today: SentimentDay | null = marketOpened()
      ? { d: kstDay(), lev: lev.tradeValue, inv: invs.reduce((s, r) => s + r.tradeValue, 0), ratio: lev.tradeValue > 0 ? Math.round((invs.reduce((s, r) => s + r.tradeValue, 0) / lev.tradeValue) * 100) / 100 : null }
      : null;
    sides.push({ market, names: { lev: lev.name, inv: invs.map((r) => r.name) }, days, today, avg20 });
  }
  sentCache = { at: Date.now(), sides };
  return { ...sentCache, note: NOTE };
}
