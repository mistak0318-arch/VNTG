/**
 * KRX 공시 — KIND 「오늘의 공시」를 통째로 긁는다 (2026-09-10).
 *
 * 벤티지: "우리 KRX 공시는 안 받아오나? 공매도 과열종목 지정 이런 거. 오늘 우리기술 공매도
 * 과열 금지 종목 공시 떴는데 안 보이네" → "공시를 받아와야 하는 거 아냐?" → "KIND 오늘의
 * 공시에 필요한 공시는 다 가져와야지 어떤 건 가져오고 어떤 건 안 가져오면 안 되지 않아?"
 *
 * 우리 공시 탭은 DART 뿐이었다. 공매도 과열종목·단기과열·투자경고·투자주의·관리종목·거래정지
 * 같은 **시장조치**는 DART 가 아니라 거래소(KIND)가 낸다 — 시장본부·시장감시위원회 명의로
 * 매일 20:00 전후에 쏟아진다. 키움 종목목록(ka10099)의 auditInfo 는 관리·경고·주의·거래정지·
 * 단기과열까지는 주지만 **공매도 과열은 없다**(실측 2026-09-10). 그래서 KIND 를 받되,
 * **골라 받지 않는다** — 그날 KIND 에 올라온 줄은 전부 저장하고, 종류(`kind`)만 붙인다.
 * 화면이 무엇을 보여줄지 고른다.
 *
 * KIND 는 공식 API 가 없다. 「오늘의 공시」 화면이 부르는 POST 를 그대로 부른다
 * (`todaydisclosure.do`, method=searchTodayDisclosureSub, 100건씩). 응답은 HTML 표라 `<tr>` 를
 * 잘라 읽는다. ⚠️ 종목코드가 **5자리로 잘려 온다**(companysummary_open('03282') = 우리기술
 * 032820). 이름으로 종목목록에서 찾고, 못 찾으면 5자리 접두 + 끝자리 0(보통주)으로 맞춘다.
 *
 * 하루치를 `server/data/krxNotices/YYYY-MM-DD.json` 에 둔다. 07~22시 KST 10분마다 오늘을 다시
 * 받고(같은 날 안에서 늘어나므로 통째로 덮어쓴다), 켜질 때 어제도 한 번 받는다.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getStockIndex } from "./stockListCache.js";

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "krxNotices");
const KIND_URL = "https://kind.krx.co.kr/disclosure/todaydisclosure.do";

export type NoticeKind =
  | "shortOverheat" // 공매도 과열종목 지정
  | "overheat" // 단기과열종목 지정(단일가매매)
  | "overheatNotice" // 단기과열 지정예고
  | "warning" // 투자경고종목 지정
  | "warningNotice" // 투자경고 지정예고
  | "danger" // 투자위험종목 지정
  | "caution" // [투자주의] 소수계좌·특정계좌 등
  | "managed" // 관리종목 지정
  | "halt" // 매매거래정지
  | "release" // 해제
  | "market" // 그 밖의 거래소 명의 공시
  | "company"; // 회사가 낸 공시

/** 시장조치로 치는 종류 — 종목 머리의 꼬리표는 이것만 */
export const MEASURE_KINDS: NoticeKind[] = [
  "shortOverheat",
  "overheat",
  "overheatNotice",
  "warning",
  "warningNotice",
  "danger",
  "caution",
  "managed",
  "halt",
];

export interface KrxNotice {
  date: string; // YYYY-MM-DD (KST)
  time: string; // HH:mm
  code: string | null;
  name: string;
  title: string;
  /** 제출인 — 코스닥시장본부 / 유가증권시장본부 / 시장감시위원회 / 회사명 */
  by: string;
  kind: NoticeKind;
  /** KIND 공시 번호 — 뷰어 링크용 */
  acptNo: string | null;
  /** 코스피 / 코스닥 (KIND 아이콘의 alt) */
  market: string | null;
}

export const KIND_LABEL: Record<NoticeKind, string> = {
  shortOverheat: "공매도 과열",
  overheat: "단기과열",
  overheatNotice: "단기과열 예고",
  warning: "투자경고",
  warningNotice: "투자경고 예고",
  danger: "투자위험",
  caution: "투자주의",
  managed: "관리종목",
  halt: "거래정지",
  release: "해제",
  market: "거래소",
  company: "공시",
};

/** 거래소 명의인가 — 시장조치는 여기서만 나온다 */
const MARKET_BY = /시장본부|시장감시위원회|한국거래소/;

/** 제목으로 종류를 가른다 — 해제가 먼저다(「투자경고종목 지정해제」는 경고가 아니다) */
export function classify(title: string, by: string): NoticeKind {
  const t = title.replace(/\s+/g, "");
  const exchange = MARKET_BY.test(by);
  if (exchange && /해제/.test(t)) return "release";
  if (/공매도과열/.test(t)) return "shortOverheat";
  if (/단기과열/.test(t)) return /예고/.test(t) ? "overheatNotice" : "overheat";
  if (/투자위험/.test(t)) return "danger";
  if (/투자경고종목지정예고/.test(t)) return "warningNotice";
  if (/투자경고/.test(t)) return "warning";
  if (/\[투자주의\]|투자주의/.test(t)) return "caution";
  if (exchange && /관리종목/.test(t)) return "managed";
  if (/매매거래정지|거래정지/.test(t)) return "halt";
  return exchange ? "market" : "company";
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'");
}

async function fetchPage(date: string, page: number): Promise<string> {
  const form = new URLSearchParams({
    method: "searchTodayDisclosureSub",
    currentPageSize: "100",
    pageIndex: String(page),
    orderMode: "0",
    orderStat: "D",
    forward: "todaydisclosure_sub",
    chose: "S",
    todayFlag: "N",
    selDate: date,
    marketType: "",
  });
  const res = await fetch(KIND_URL, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "user-agent": "Mozilla/5.0",
      referer: KIND_URL,
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    void recordApiCall("krx", "kind/today", "failed");
    throw new Error(`KIND HTTP ${res.status}`);
  }
  void recordApiCall("krx", "kind/today", "ok");
  return res.text();
}

/** HTML 표 한 쪽 → 줄. 다 담는다 — 고르는 건 화면 몫 */
function parseRows(html: string, date: string): { rows: KrxNotice[]; total: number } {
  const trs = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  const rows: KrxNotice[] = [];
  let total = 0;
  for (const tr of trs) {
    const tds = tr.match(/<td[^>]*>[\s\S]*?<\/td>/g) ?? [];
    if (tds.length < 4) continue;
    total += 1;
    const text = (i: number) => unescapeHtml(tds[i].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    const time = text(0);
    const by = text(3);
    const title = text(2);
    const name = (/title='([^']*)'/.exec(tds[1])?.[1] ?? text(1)).trim();
    const short = /companysummary_open\('(\d+)'\)/.exec(tds[1])?.[1] ?? null;
    const acptNo = /openDisclsViewer\('(\d+)'/.exec(tds[2])?.[1] ?? null;
    const mk = /alt='(코스피|코스닥|유가증권|코넥스)'/.exec(tds[1])?.[1] ?? null;
    rows.push({
      date,
      time,
      code: short,
      name,
      title,
      by,
      kind: classify(title, by),
      acptNo,
      market: mk === "유가증권" ? "코스피" : mk,
    });
  }
  return { rows, total };
}

function fileOf(date: string): string {
  return join(DIR, `${date}.json`);
}

/** 하루치를 KIND 에서 받아 파일에 둔다. 코드는 종목목록으로 6자리로 맞춘다 */
export async function collectDay(client: KiwoomClient, date: string): Promise<KrxNotice[]> {
  const all: KrxNotice[] = [];
  for (let page = 1; page <= 40; page += 1) {
    const html = await fetchPage(date, page);
    const { rows, total } = parseRows(html, date);
    all.push(...rows);
    if (total < 100) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  const index = await getStockIndex(client).catch(() => new Map());
  const byName = new Map<string, string>();
  for (const [code, e] of index) byName.set(String(e.name).replace(/\s+/g, ""), code);
  for (const n of all) {
    const exact = byName.get(n.name.replace(/\s+/g, ""));
    if (exact) {
      n.code = exact;
      continue;
    }
    if (n.code && n.code.length === 5) {
      /* 5자리 접두 — 보통주(끝 0)를 우선 */
      const prefix = n.code;
      const cands = [...index.keys()].filter((c) => c.startsWith(prefix));
      n.code = cands.find((c) => c.endsWith("0")) ?? cands[0] ?? null;
    }
  }
  /* 같은 종목·같은 제목·같은 시각은 한 번 — KIND 가 정정으로 두 번 낼 때가 있다 */
  const seen = new Set<string>();
  const out = all.filter((n) => {
    const k = `${n.code ?? n.name}:${n.time}:${n.title}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  await mkdir(DIR, { recursive: true });
  await writeFile(fileOf(date), JSON.stringify(out, null, 1), "utf8");
  return out;
}

async function readDay(date: string): Promise<KrxNotice[]> {
  try {
    return JSON.parse(await readFile(fileOf(date), "utf8")) as KrxNotice[];
  } catch {
    return [];
  }
}

export function kstDate(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600_000 - offsetDays * 86400_000).toISOString().slice(0, 10);
}

/** 최근 `days` 일 — 최신순. `code` 를 주면 그 종목만, `measuresOnly` 면 시장조치만 */
export async function recentNotices(days = 30, code?: string, measuresOnly = false): Promise<KrxNotice[]> {
  let names: string[] = [];
  try {
    names = (await readdir(DIR)).filter((f) => f.endsWith(".json")).sort().reverse();
  } catch {
    return [];
  }
  const cutoff = kstDate(days);
  const out: KrxNotice[] = [];
  for (const f of names) {
    const day = f.slice(0, 10);
    if (day < cutoff) break;
    const rows = await readDay(day);
    for (const r of rows) {
      if (code && r.code !== code) continue;
      if (measuresOnly && !MEASURE_KINDS.includes(r.kind) && r.kind !== "release") continue;
      out.push(r);
    }
  }
  return out.sort((a, b) => `${b.date} ${b.time}`.localeCompare(`${a.date} ${a.time}`));
}

/**
 * 종목의 **지금 걸려 있는** 조치 — 최근 30일에서 종류별 마지막 공시가 「해제」로 안 지워진 것.
 * 예고는 예고대로 남긴다(예고가 곧 지정은 아니지만 알아야 한다).
 */
/**
 * 종류마다 **얼마나 가나** (2026-09-10). 투자주의·공매도 과열·예고는 다음 거래일 하루짜리라
 * 해제 공시가 따로 안 나온다 — 30일 동안 걸린 척하면 안 된다. 경고·위험·관리·정지는 해제 공시가
 * 올 때까지(30일 창 안에서).
 */
const VALID_DAYS: Partial<Record<NoticeKind, number>> = {
  caution: 2,
  shortOverheat: 2,
  overheatNotice: 2,
  warningNotice: 2,
  overheat: 5,
};

export async function activeMeasures(code: string): Promise<KrxNotice[]> {
  const rows = await recentNotices(30, code, true);
  const latest = new Map<NoticeKind, KrxNotice>();
  const today = kstDate(0);
  const ageDays = (d: string) => Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${d}T00:00:00Z`).getTime()) / 86400_000);
  for (const r of [...rows].reverse()) {
    const limit = VALID_DAYS[r.kind];
    /* 주말을 건너뛰도록 하루 여유 — 금요일 지정은 월요일까지 */
    if (limit !== undefined && ageDays(r.date) > limit + (new Date(`${today}T00:00:00+09:00`).getUTCDay() === 1 ? 2 : 0)) continue;
    if (r.kind === "release") {
      /* 「투자경고종목 지정해제」처럼 제목이 말하는 종류를 지운다 */
      const t = r.title.replace(/\s+/g, "");
      for (const k of [...latest.keys()]) if (t.includes(KIND_LABEL[k].replace(/\s+/g, ""))) latest.delete(k);
      continue;
    }
    latest.set(r.kind, r);
  }
  return [...latest.values()];
}

let timer: ReturnType<typeof setInterval> | null = null;
let last: { at: string; count: number; error: string | null } | null = null;

export function collectorStatus() {
  return last;
}

/**
 * **과거 30일 백필** (2026-09-10 — 벤티지 "우리기술 08-21·08-27·09-01 공시가 안 보여"). 수집을
 * 어젯밤에 시작해 그 전 날짜 파일이 없었다. 없는 날만 하루씩(주말 건너뜀, 0.8초 간격) 받는다.
 * 켜질 때 한 번, 뒤에서.
 */
async function backfill(client: KiwoomClient, days = 30): Promise<void> {
  for (let i = 2; i <= days; i += 1) {
    const day = kstDate(i);
    const dow = new Date(`${day}T00:00:00+09:00`).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    try {
      await readFile(fileOf(day), "utf8");
      continue; // 이미 있다
    } catch {
      /* 없으면 받는다 */
    }
    await collectDay(client, day).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 800));
  }
}

export function startKrxNoticeCollector(client: KiwoomClient): void {
  if (timer) return;
  const run = async (alsoYesterday = false) => {
    const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
    /* 켜질 때는 시각과 무관하게 한 번 — 밤에 켜져도 어제 20시 시장조치는 있어야 한다 */
    if (!alsoYesterday && (h < 7 || h >= 22)) return;
    try {
      if (alsoYesterday) await collectDay(client, kstDate(1)).catch(() => undefined);
      const rows = await collectDay(client, kstDate(0));
      last = { at: new Date().toISOString(), count: rows.length, error: null };
    } catch (e) {
      last = { at: new Date().toISOString(), count: 0, error: e instanceof Error ? e.message : String(e) };
    }
  };
  setTimeout(() => void run(true).then(() => backfill(client)), 45_000);
  timer = setInterval(() => void run(false), 10 * 60_000);
}
