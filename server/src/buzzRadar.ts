import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import type { ChannelMessage } from "./telegramReader.js";
import { peekSnapshot } from "./marketSnapshot.js";
import { listThemes } from "./customThemes.js";

/**
 * 밤사이 버즈 레이더 (2026-08-27) — **등록 없이도 「갑자기 커진 주제」를 잡는다.**
 *
 * ## 왜 만들었나
 *
 * 트럼프의 對중국 에너지 제재 발표가 밤사이 채널들을 뒤덮었고 다음날 2차전지·ESS 가
 * 급등했는데, 이 시스템은 조용했다. 키워드 알림은 **등록된 낱말만** 보고, AI 선별은
 * 요약이지 「평소보다 얼마나 큰 소리인가」를 재지 않기 때문이다.
 *
 * ## 어떻게 잡나
 *
 * 1) 이미 받아오는 채널 메시지 스트림(fetchNewMessages)에 **카운터만 얹는다** — 조회 0 증가.
 *    사전(내 테마·키움 테마명·전 종목명·이벤트어·개체어)에 매칭해 시간별로 센다.
 * 2) 최근 12시간 언급량을 **지난 7일 하루 평균의 절반(12시간 상당)** 과 비교한다.
 *    평소 4건이던 「ESS」가 밤새 34건이면 그게 버즈다.
 * 3) 강한 버즈는 시그널 방으로 쏘고, 장전 브리핑룸의 「밤사이 버즈」 카드가 전체를 보여 준다.
 *
 * 기준선이 없으면 판정도 없다 — **사흘치가 쌓이기 전에는 발송하지 않는다**
 * (카드에는 「기준선 수집 중」으로 카운트만 보여 준다).
 *
 * 저장: data/buzz/YYYY-MM-DD.json (일별 카운트·시각별·샘플), sent.json (발송 기록).
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "buzz");
const SENT_FILE = join(DIR, "sent.json");

/*
 * 수집 훅(fetchNewMessages)은 키움 클라이언트를 모른다 — 스케줄러가 시작할 때
 * 여기 묶어 두고, 사전(키움 테마명)만 이걸 쓴다. 없으면 테마명 없이 돈다.
 */
let boundClient: KiwoomClient | null = null;

/** 이벤트 어휘 — 시장을 움직이는 사건의 낱말들. 계속 보태 나간다 */
const EVENT_TERMS = [
  "제재", "관세", "수출통제", "수출규제", "금수", "무역전쟁",
  "규제", "완화", "부양책", "보조금", "감산", "증산",
  "수주", "계약", "공급계약", "증설", "착공", "인수", "합병", "분할", "상장폐지",
  "화재", "폭발", "파업", "리콜", "결함", "해킹", "유출",
  "승인", "허가", "FDA", "임상", "특허",
  "금리인하", "금리인상", "양적완화", "디폴트", "부도", "구조조정",
  "전쟁", "휴전", "미사일", "파병",
];

/** 개체 어휘 — 누가/어디가 움직였나. 이벤트어와 조합돼 맥락이 된다 */
const ENTITY_TERMS = [
  "트럼프", "바이든", "파월", "연준", "백악관",
  "중국", "미국", "일본", "대만", "러시아", "우크라이나", "이란", "인도", "유럽",
  "엔비디아", "테슬라", "애플", "TSMC", "오픈AI",
];

export interface BuzzTerm {
  term: string;
  kind: "theme" | "myTheme" | "stock" | "event" | "entity";
  /** 종목이면 코드, 테마면 대표(첫) 종목 코드들 */
  codes?: string[];
}

interface DayFile {
  /** term → 총 건수 */
  total: Record<string, number>;
  /** term → 시각(0~23, KST) → 건수 */
  byHour: Record<string, Record<string, number>>;
  /** term → 최근 샘플 (트리거 문구로 보여 준다) */
  samples: Record<string, { at: string; channel: string; text: string; link: string }[]>;
}

const EMPTY_DAY: DayFile = { total: {}, byHour: {}, samples: {} };

function kstNow(): Date {
  return new Date(Date.now() + 9 * 3600_000);
}

function dayStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- 사전

let dict: BuzzTerm[] | null = null;
let dictAt = 0;
let kiwoomThemes: { name: string; codes: string[] }[] = [];
let kiwoomThemesAt = 0;

/** 키움 테마명 — 하루 한 번이면 충분하다 (ka90001 상·하위 등락 목록으로 이름을 모은다) */
async function refreshKiwoomThemes(client: KiwoomClient | null): Promise<void> {
  if (!client) return;
  if (Date.now() - kiwoomThemesAt < 24 * 3600_000) return;
  kiwoomThemesAt = Date.now(); // 실패해도 하루 뒤에 다시 — 매 틱 재시도로 조회를 낭비하지 않는다
  try {
    const common = { qry_tp: "0", stk_cd: "", date_tp: "1", thema_nm: "", stex_tp: "3" };
    const [top, bottom] = await Promise.all([
      client.request<Record<string, unknown>>("/api/dostk/thme", "ka90001", { ...common, flu_pl_amt_tp: "3" }),
      client.request<Record<string, unknown>>("/api/dostk/thme", "ka90001", { ...common, flu_pl_amt_tp: "4" }),
    ]);
    const rows = [
      ...((top.data.thema_grp ?? []) as Record<string, unknown>[]),
      ...((bottom.data.thema_grp ?? []) as Record<string, unknown>[]),
    ];
    const seen = new Map<string, { name: string; codes: string[] }>();
    for (const r of rows) {
      const name = String(r.thema_nm ?? "").trim();
      if (name.length >= 2 && !seen.has(name)) seen.set(name, { name, codes: [] });
    }
    if (seen.size > 0) kiwoomThemes = [...seen.values()];
  } catch {
    /* 테마명 없이도 종목명·이벤트어로 돈다 */
  }
}

/** 사전 구성 — 10분 캐시. 종목명은 스냅샷(캐시)에서, 짧은 이름(2자 이하)은 오탐이라 뺀다 */
async function buildDict(): Promise<BuzzTerm[]> {
  if (dict && Date.now() - dictAt < 10 * 60_000) return dict;
  await refreshKiwoomThemes(boundClient);
  const out: BuzzTerm[] = [];
  const seen = new Set<string>();
  const add = (t: BuzzTerm) => {
    if (t.term.length < 2 || seen.has(t.term)) return;
    seen.add(t.term);
    out.push(t);
  };

  for (const t of await listThemes().catch(() => []))
    add({ term: t.name, kind: "myTheme", codes: t.codes.slice(0, 5) });
  for (const t of kiwoomThemes) add({ term: t.name, kind: "theme" });
  const snap = peekSnapshot();
  if (snap) {
    for (const [code, row] of snap.byCode) {
      const name = row.name?.trim() ?? "";
      if (name.length >= 3) add({ term: name, kind: "stock", codes: [code] });
    }
  }
  for (const t of EVENT_TERMS) add({ term: t, kind: "event" });
  for (const t of ENTITY_TERMS) add({ term: t, kind: "entity" });

  dict = out;
  dictAt = Date.now();
  return out;
}

// ---------------------------------------------------------------- 카운팅

/** 같은 메시지를 두 번 세지 않기 — 스캔이 20분씩 겹쳐 읽는다. 날짜별 메모리 셋 */
const seenIds = new Map<string, Set<string>>();

async function readDay(day: string): Promise<DayFile> {
  try {
    const j = JSON.parse(await readFile(join(DIR, `${day}.json`), "utf-8")) as DayFile;
    return { total: j.total ?? {}, byHour: j.byHour ?? {}, samples: j.samples ?? {} };
  } catch {
    return { total: {}, byHour: {}, samples: {} };
  }
}

let recording = false;

/**
 * 메시지 묶음을 센다 — fetchNewMessages 가 부른다. 실패는 삼킨다(수집이 본업을 막으면 안 된다).
 * 파일은 일별 하나. 동시 호출이 겹치면 한쪽을 버리는 대신 순차화한다(recording).
 */
export async function recordBuzz(messages: ChannelMessage[]): Promise<void> {
  if (messages.length === 0 || recording) return;
  recording = true;
  try {
    const d = await buildDict();
    const today = dayStr(kstNow());
    let ids = seenIds.get(today);
    if (!ids) {
      ids = new Set();
      seenIds.set(today, ids);
      // 어제 셋은 버린다 — 메모리를 하루치만 쓴다
      for (const k of seenIds.keys()) if (k !== today) seenIds.delete(k);
    }

    const fresh = messages.filter((m) => {
      const id = `${m.channelId}_${m.messageId}`;
      if (ids.has(id)) return false;
      ids.add(id);
      return true;
    });
    if (fresh.length === 0) return;

    const file = await readDay(today);
    /*
     * 매칭 비용 통제 — 실측 150건×사전 3,200개 ≈ 84ms (2026-08-27).
     * 평상시 스캔(수십 건)은 한 번에 끝나지만, 첫 소급 수집처럼 수백~수천 건이
     * 몰리면 초 단위로 이벤트 루프를 막아 **다른 API 응답까지 세운다.**
     * 30건마다 루프를 양보하고, 본문은 앞 600자만 본다(핵심은 앞에 있다).
     */
    let processed = 0;
    for (const m of fresh) {
      processed += 1;
      if (processed % 30 === 0) await new Promise((r) => setImmediate(r));
      const text = m.text.slice(0, 600);
      const hour = String(new Date(new Date(m.at).getTime() + 9 * 3600_000).getUTCHours());
      for (const t of d) {
        if (!text.includes(t.term)) continue;
        file.total[t.term] = (file.total[t.term] ?? 0) + 1;
        const bh = (file.byHour[t.term] = file.byHour[t.term] ?? {});
        bh[hour] = (bh[hour] ?? 0) + 1;
        const samples = (file.samples[t.term] = file.samples[t.term] ?? []);
        samples.unshift({
          at: m.at,
          channel: m.channelName,
          text: text.replace(/\s+/g, " ").slice(0, 120),
          link: m.link,
        });
        if (samples.length > 3) samples.length = 3;
      }
    }
    await mkdir(DIR, { recursive: true });
    await writeFile(join(DIR, `${today}.json`), JSON.stringify(file), "utf-8");
  } catch {
    /* 버즈 기록 실패가 수집을 막으면 안 된다 */
  } finally {
    recording = false;
  }
}

// ---------------------------------------------------------------- 판정

export interface BuzzHit {
  term: string;
  kind: BuzzTerm["kind"];
  /** 최근 12시간 건수 */
  recent: number;
  /** 지난 7일 12시간 상당 평균 */
  baseline: number;
  /** recent / baseline — 몇 배로 커졌나 */
  ratio: number;
  codes: string[];
  samples: { at: string; channel: string; text: string; link: string }[];
}

export interface BuzzResult {
  hits: BuzzHit[];
  /** 기준선으로 쓴 지난 날 수 — 3 미만이면 아직 판정하지 않는다 */
  baselineDays: number;
  /** 기준선이 모자랄 때도 「지금 많이 말해지는 것」은 보여 준다 */
  topToday: { term: string; kind: BuzzTerm["kind"]; recent: number }[];
  windowHours: number;
  at: string;
}

/** 최근 windowHours 시간의 건수 — 오늘·어제 파일의 시각 버킷에서 모은다 */
function recentCount(term: string, today: DayFile, yesterday: DayFile, windowHours: number): number {
  const now = kstNow();
  let sum = 0;
  for (let i = 0; i < windowHours; i += 1) {
    const t = new Date(now.getTime() - i * 3600_000);
    const file = dayStr(t) === dayStr(now) ? today : yesterday;
    sum += file.byHour[term]?.[String(t.getUTCHours())] ?? 0;
  }
  return sum;
}

export async function evaluateBuzz(windowHours = 12): Promise<BuzzResult> {
  const d = await buildDict();
  const kindOf = new Map(d.map((t) => [t.term, t]));
  const now = kstNow();
  const today = await readDay(dayStr(now));
  const yesterday = await readDay(dayStr(new Date(now.getTime() - 86400_000)));

  /* 기준선 — 지난 7일(오늘 제외) 총 건수의 하루 평균 ÷ 2 (12시간 상당) */
  const pastDays: DayFile[] = [];
  for (let i = 1; i <= 7; i += 1) {
    const day = dayStr(new Date(now.getTime() - i * 86400_000));
    const f = await readDay(day);
    if (Object.keys(f.total).length > 0) pastDays.push(f);
  }
  const baselineDays = pastDays.length;

  /* 지금 창에서 한 번이라도 언급된 항목만 후보로 — 사전 전체를 돌 필요가 없다 */
  const candidates = new Set<string>([...Object.keys(today.total), ...Object.keys(yesterday.total)]);
  const hits: BuzzHit[] = [];
  const topToday: { term: string; kind: BuzzTerm["kind"]; recent: number }[] = [];

  for (const term of candidates) {
    const info = kindOf.get(term);
    if (!info) continue;
    const recent = recentCount(term, today, yesterday, windowHours);
    if (recent === 0) continue;
    topToday.push({ term, kind: info.kind, recent });
    if (baselineDays < 3) continue; // 기준선이 서기 전에는 판정하지 않는다

    const avgDaily = pastDays.reduce((a, f) => a + (f.total[term] ?? 0), 0) / baselineDays;
    const baseline = Math.max(avgDaily * (windowHours / 24), 0.5);
    const ratio = recent / baseline;
    /* 문턱 — 절대량과 배수를 같이 본다. 평소 0건이던 게 2건 온 것까지 울리면 소음이 된다 */
    if (recent >= 6 && ratio >= 3) {
      hits.push({
        term,
        kind: info.kind,
        recent,
        baseline: Math.round(baseline * 10) / 10,
        ratio: Math.round(ratio * 10) / 10,
        codes: info.codes ?? [],
        samples: (today.samples[term] ?? yesterday.samples[term] ?? []).slice(0, 2),
      });
    }
  }

  hits.sort((a, b) => b.ratio - a.ratio);
  topToday.sort((a, b) => b.recent - a.recent);
  return {
    hits: hits.slice(0, 12),
    baselineDays,
    topToday: topToday.slice(0, 10),
    windowHours,
    at: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------- 발송 스케줄러

async function readSent(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(SENT_FILE, "utf-8")) as Record<string, string>;
  } catch {
    return {};
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const result = await evaluateBuzz();
    if (result.hits.length === 0) return;

    const sent = await readSent();
    const today = dayStr(kstNow());
    /* 아주 강한 것만 쏜다 — 카드는 12개를 보여 주지만 방을 울리는 건 하루 몇 번이어야 한다 */
    const strong = result.hits.filter((h) => h.recent >= 10 && h.ratio >= 4);
    const fresh = strong.filter((h) => !sent[`${today}|${h.term}`]);
    if (fresh.length === 0) return;

    const { sendTelegram } = await import("./telegram.js");
    for (const h of fresh.slice(0, 3)) {
      const codeNote =
        h.codes.length > 0 && h.kind === "myTheme" ? `\n관련: 내 테마 구성 ${h.codes.length}종목` : "";
      const sample = h.samples[0]
        ? `\n트리거: ${h.samples[0].text.slice(0, 80)} (${h.samples[0].channel})`
        : "";
      const msg =
        `🌋 <b>버즈 감지 — ${h.term}</b>\n` +
        `최근 ${result.windowHours}시간 <b>${h.recent}건</b> (평소 ${h.baseline}건 · ${h.ratio}배)` +
        codeNote +
        sample +
        `\n\n장전 브리핑룸의 「밤사이 버즈」에서 전체를 보세요.`;
      await sendTelegram(msg, "buzz").catch(() => undefined);
      sent[`${today}|${h.term}`] = new Date().toISOString();
    }
    /* 발송 기록은 30일만 */
    const cutoff = dayStr(new Date(Date.now() - 30 * 86400_000 + 9 * 3600_000));
    for (const k of Object.keys(sent)) if (k.slice(0, 10) < cutoff) delete sent[k];
    await mkdir(DIR, { recursive: true });
    await writeFile(SENT_FILE, JSON.stringify(sent, null, 2), "utf-8");

    /* 버즈 일별 파일도 30일 지나면 정리 */
    for (const f of await readdir(DIR).catch(() => [] as string[])) {
      if (/^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f.slice(0, 10) < cutoff) {
        await unlink(join(DIR, f)).catch(() => undefined);
      }
    }
  } catch (err) {
    console.error("[buzz] 판정 실패:", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

export function startBuzzScheduler(client: KiwoomClient): void {
  if (timer) return;
  boundClient = client;
  setTimeout(() => void tick(), 3 * 60_000); // 수집이 한 바퀴 돈 뒤에
  timer = setInterval(() => void tick(), 30 * 60_000);
  console.log("[buzz] 버즈 레이더 시작 (30분 주기 판정 · 기준선 3일 후 발송)");
}
