import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateMarket } from "./marketSignal.js";
import { peekSnapshot } from "./marketSnapshot.js";
import { listThemes } from "./customThemes.js";
import { evaluateSignal } from "./signalLight.js";

/**
 * 복기 노트 — 하루를 적고, 쌓아서 나를 고친다.
 *
 * 매매일지를 자유 서술로만 두면 **다시 안 읽는 일기**가 된다. 그러면 반성은 남고
 * 개선은 안 남는다. 그래서 두 가지를 지킨다.
 *
 *  1) **나중에 셀 수 있게 적는다.** 실수와 감정을 태그로 고르게 해서, 몇 달 뒤에
 *     "내가 제일 자주 하는 실수"와 "어떤 상태일 때 성적이 나빴나"를 숫자로 낸다.
 *     자유 서술은 그 옆에 붙는 것이지 본체가 아니다.
 *
 *  2) **결과와 과정을 갈라 적는다.** 벌었는지가 아니라 *내 규칙대로 했는지*를 따로 묻는다.
 *     규칙을 어겼는데 번 날이 제일 위험하다 — 그날 배운 게 다음에 크게 잃게 만든다.
 *
 * 그날의 시장·테마·거래는 **자동으로 채운다.** 손으로 적게 하면 안 적는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "journal.json");

/**
 * 실수 태그.
 *
 * 목록을 주는 이유는 **자유 입력이면 매번 다르게 적혀서 못 세기** 때문이다.
 * "뇌동매매"와 "충동적으로 삼"을 같은 것으로 묶을 방법이 없다.
 */
export const MISTAKE_TAGS = [
  { key: "chase", label: "추격매수", hint: "이미 오른 걸 못 참고 따라 샀다" },
  { key: "noCut", label: "손절 미이행", hint: "정한 선을 넘었는데 안 팔았다" },
  { key: "impulse", label: "뇌동매매", hint: "계획에 없던 종목을 즉흥적으로" },
  { key: "oversize", label: "과다 비중", hint: "한 종목에 너무 크게 걸었다" },
  { key: "noThesis", label: "근거 없이 매수", hint: "왜 사는지 한 줄로 못 쓰겠는 걸 샀다" },
  { key: "newsOnly", label: "뉴스만 보고", hint: "수급·차트 확인 없이 재료만 보고" },
  { key: "earlyExit", label: "조급한 익절", hint: "목표 전에 무서워서 팔았다" },
  { key: "revenge", label: "복수매매", hint: "잃은 걸 만회하려고 바로 다시" },
  { key: "againstMarket", label: "시장 역행", hint: "시장 신호등이 빨간데 크게 샀다" },
  { key: "overtrade", label: "과매매", hint: "할 게 없는 날인데 계속 사고팔았다" },
] as const;

/** 그날의 상태. 성적과 엮으면 "어떤 상태일 때 지는가"가 나온다 */
export const MOOD_TAGS = [
  { key: "calm", label: "평온" },
  { key: "confident", label: "자신감" },
  { key: "greedy", label: "조급·욕심" },
  { key: "fearful", label: "불안·공포" },
  { key: "bored", label: "지루함" },
  { key: "tilted", label: "흔들림" },
] as const;

/** 자동으로 채워 넣는 그날의 맥락 — 손으로 적게 하면 안 적는다 */
export interface DayContext {
  /** 시장 신호등 */
  marketLevel: string;
  marketScore: number;
  marketSummary: string;
  /** 그날 시장 폭 / 지수 추세 — 문장 그대로 */
  breadth: string | null;
  trend: string | null;
  /** 그날 내 테마 상위·하위 */
  topThemes: { name: string; changeRate: number }[];
  bottomThemes: { name: string; changeRate: number }[];
}

/**
 * 그날의 매매 한 건 — **직접 적는다.**
 *
 * 처음엔 모의투자에서 끌어왔는데 그건 틀렸다. 모의투자는 시나리오를 짜 보는 자리고,
 * 실제 매매는 증권사 계좌에서 일어난다. 복기해야 하는 건 후자다.
 *
 * 종목을 코드까지 골라 주면 **그 순간의 신호등을 함께 박제한다** — 이게 이 HTS 를
 * 쓰는 이유다. "왜 샀나"를 사람이 적고, "그때 지표가 뭐였나"는 기계가 적는다.
 */
export interface JournalTrade {
  id: string;
  kind: "buy" | "sell";
  code: string;
  name: string;
  price: number;
  qty: number;
  /** 왜 샀나 / 왜 팔았나 */
  note: string;
  /** 기록 시점의 신호등 (코드를 골랐을 때만) */
  level?: string;
  score?: number;
  passed?: string[];
}

export interface JournalEntry {
  /** YYYY-MM-DD (KST) — 하루에 하나 */
  date: string;
  updatedAt: string;

  /** 오늘 무엇을 했나 (짧게) */
  what: string;
  /** 왜 그렇게 했나 — 그때의 판단 */
  why: string;
  /**
   * 내 규칙대로 했나. 결과와 별개로 묻는다.
   * 규칙을 어겼는데 번 날이 제일 위험하다.
   */
  followedRules: boolean | null;
  /** 어긴 규칙이 있으면 무엇을 */
  brokenRule: string;

  /** 그날 실제로 한 매매 */
  trades: JournalTrade[];

  mistakes: string[];
  mood: string;
  /** 오늘 배운 것 한 줄 — 이게 다음 달의 나를 바꾼다 */
  lesson: string;
  /** 내일 할 것 */
  tomorrow: string;

  context: DayContext | null;
}

async function readAll(): Promise<JournalEntry[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf-8")) as JournalEntry[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: JournalEntry[]): Promise<void> {
  rows.sort((a, b) => a.date.localeCompare(b.date));
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(rows, null, 2), "utf-8");
}

export async function listEntries(limit = 90): Promise<JournalEntry[]> {
  const rows = await readAll();
  return rows.slice(-limit).reverse();
}

function kstDate(d = new Date()): string {
  return new Date(d.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 그날의 맥락을 모은다.
 *
 * 시장 신호등·테마·거래는 이미 우리가 들고 있는 것이다. 사용자가 다시 적을 이유가 없고,
 * 무엇보다 **손으로 적으면 기억으로 적게 된다** — 그러면 복기의 근거가 흔들린다.
 */
export async function captureContext(client: KiwoomClient, date: string): Promise<DayContext | null> {
  const [market, themes] = await Promise.all([
    evaluateMarket(client).catch(() => null),
    listThemes().catch(() => []),
  ]);
  const snap = peekSnapshot();

  const rated = themes
    .map((t) => {
      const rates = t.codes
        .map((c) => snap?.byCode.get(c)?.changeRate)
        .filter((x): x is number => typeof x === "number");
      return {
        name: t.name,
        changeRate: rates.length > 0 ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      };
    })
    .filter((t): t is { name: string; changeRate: number } => t.changeRate !== null)
    .sort((a, b) => b.changeRate - a.changeRate);


  return {
    marketLevel: market?.level ?? "unknown",
    marketScore: market?.score ?? 0,
    marketSummary: market?.summary ?? "",
    // 시장 폭 한 줄 — "지수는 올랐는데 내 종목은 죽은 날"이 복기에서 제일 중요하다
    breadth: market?.checks.find((c) => c.key === "breadth")?.value ?? null,
    trend: market?.checks.find((c) => c.key === "trend")?.value ?? null,
    topThemes: rated.slice(0, 3),
    bottomThemes: rated.slice(-3).reverse(),
  };
}

/**
 * 새로 들어온 매매에만 신호등을 붙인다.
 *
 * 이미 붙어 있는 건 그대로 둔다 — 사흘 뒤에 노트를 고치면서 신호등이 오늘 값으로
 * 덮이면, 그건 매수 시점의 근거가 아니라 오늘의 값이 된다.
 */
async function withSignals(
  client: KiwoomClient,
  next: JournalTrade[],
  prev: JournalTrade[],
): Promise<JournalTrade[]> {
  const before = new Map(prev.map((t) => [t.id, t]));
  return Promise.all(
    next.map(async (t) => {
      const old = before.get(t.id);
      if (old?.level) return { ...t, level: old.level, score: old.score, passed: old.passed };
      if (!/^\d{6}$/.test(t.code)) return t;
      const sig = await evaluateSignal(client, t.code).catch(() => null);
      if (!sig) return t;
      return {
        ...t,
        level: sig.level,
        score: sig.score,
        passed: sig.checks.filter((c) => c.pass === true).map((c) => c.label),
      };
    }),
  );
}

export async function saveEntry(
  client: KiwoomClient,
  input: Partial<JournalEntry> & { date?: string },
): Promise<JournalEntry[]> {
  const date = input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : kstDate();
  const rows = await readAll();
  const prev = rows.find((r) => r.date === date);

  /*
   * 맥락은 **처음 적을 때 한 번만** 잡는다. 며칠 뒤에 노트를 고치면서 오늘 시장이
   * 덮여 버리면, 그날을 복기하는 게 아니라 오늘을 적는 게 된다.
   */
  /*
   * 시장 맥락은 처음 적을 때 한 번만 잡는다 — 며칠 뒤 노트를 고치면서 오늘 시장이
   * 덮이면 그날을 복기하는 게 아니라 오늘을 적는 게 된다.
   *
   * 다만 **매매 내역은 매번 다시 잡는다.** 아침에 노트를 쓰고 오후에 사고파는 게
   * 보통이라, 처음 저장 때 고정하면 그날 매매가 영영 안 들어온다.
   */
  const context = prev?.context ?? (await captureContext(client, date).catch(() => null));

  const entry: JournalEntry = {
    date,
    updatedAt: new Date().toISOString(),
    what: (input.what ?? prev?.what ?? "").slice(0, 1000),
    why: (input.why ?? prev?.why ?? "").slice(0, 1000),
    followedRules: input.followedRules ?? prev?.followedRules ?? null,
    brokenRule: (input.brokenRule ?? prev?.brokenRule ?? "").slice(0, 300),
    trades: await withSignals(client, input.trades ?? prev?.trades ?? [], prev?.trades ?? []),
    mistakes: input.mistakes ?? prev?.mistakes ?? [],
    mood: input.mood ?? prev?.mood ?? "",
    lesson: (input.lesson ?? prev?.lesson ?? "").slice(0, 500),
    tomorrow: (input.tomorrow ?? prev?.tomorrow ?? "").slice(0, 500),
    context,
  };

  const next = rows.filter((r) => r.date !== date);
  next.push(entry);
  await writeAll(next);
  return listEntries();
}

export async function removeEntry(date: string): Promise<JournalEntry[]> {
  await writeAll((await readAll()).filter((r) => r.date !== date));
  return listEntries();
}

// ---------------------------------------------------------------- 트래킹

/**
 * 쌓인 노트에서 나를 읽는다.
 *
 * **이게 노트를 일기와 가르는 지점이다.** 하루치는 반성이지만, 석 달치를 세면
 * 내가 어떤 사람인지가 나온다 — 제일 자주 하는 실수, 어떤 상태일 때 규칙을 어기는지,
 * 규칙을 지킨 날과 어긴 날의 성적 차이.
 */
export interface JournalStats {
  /** 기록한 날 수 */
  days: number;
  /** 연속 기록 일수 — 습관이 붙었는지 */
  streak: number;
  /** 규칙 준수율(%) */
  ruleRate: number | null;
  /** 실수 태그별 횟수, 잦은 순 */
  mistakes: { key: string; label: string; count: number }[];
  /** 상태별 — 그날 규칙을 지킨 비율까지 같이 본다 */
  moods: { key: string; label: string; count: number; ruleRate: number | null }[];
  /**
   * 규칙을 지킨 날 vs 어긴 날의 그날 매수 종목 성적.
   * "규칙을 어겼는데 번 날"이 보이면 그게 제일 위험한 신호다.
   */
  ruleEdge: {
    keptDays: number;
    keptAvgReturn: number | null;
    brokeDays: number;
    brokeAvgReturn: number | null;
  };
  /** 최근에 적은 배운 것들 — 다시 읽으라고 */
  lessons: { date: string; lesson: string }[];
}

const MISTAKE_LABEL = new Map(MISTAKE_TAGS.map((t) => [t.key as string, t.label]));
const MOOD_LABEL = new Map(MOOD_TAGS.map((t) => [t.key as string, t.label]));

export async function journalStats(): Promise<JournalStats> {
  const rows = await readAll();

  // 연속 기록 — 오늘(또는 어제)부터 거꾸로 하루씩
  const dates = new Set(rows.map((r) => r.date));
  let streak = 0;
  const cur = new Date(Date.now() + 9 * 3600_000);
  if (!dates.has(cur.toISOString().slice(0, 10))) cur.setDate(cur.getDate() - 1);
  while (dates.has(cur.toISOString().slice(0, 10))) {
    streak += 1;
    cur.setDate(cur.getDate() - 1);
  }

  const judged = rows.filter((r) => r.followedRules !== null);
  const kept = judged.filter((r) => r.followedRules);

  const mistakeCount = new Map<string, number>();
  for (const r of rows) for (const m of r.mistakes) mistakeCount.set(m, (mistakeCount.get(m) ?? 0) + 1);

  const moodAgg = new Map<string, { count: number; judged: number; kept: number }>();
  for (const r of rows) {
    if (!r.mood) continue;
    const a = moodAgg.get(r.mood) ?? { count: 0, judged: 0, kept: 0 };
    a.count += 1;
    if (r.followedRules !== null) {
      a.judged += 1;
      if (r.followedRules) a.kept += 1;
    }
    moodAgg.set(r.mood, a);
  }

  /*
   * 실현 수익률을 **매수한 날에 귀속**시킨다.
   *
   * 노트에 적힌 매수·매도를 종목별로 선입선출(FIFO)로 맞춘다. 판 날이 아니라 **산 날**에
   * 붙이는 이유는, 여기서 재는 게 "그날의 판단이 좋았나"이기 때문이다 — 규칙을 지키고
   * 산 종목이 결국 어떻게 됐는지를 봐야 규칙의 값어치가 나온다.
   *
   * 아직 안 판 것은 세지 않는다. 결과가 없는 걸 성적에 넣으면 물려 있는 게 실패로 잡힌다.
   */
  const lots = new Map<string, { date: string; price: number; qty: number }[]>();
  const realized = new Map<string, number[]>(); // 매수일 → 실현 수익률들
  for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) {
    for (const t of r.trades ?? []) {
      const key = t.code || t.name;
      if (!key || t.price <= 0 || t.qty <= 0) continue;
      if (t.kind === "buy") {
        const arr = lots.get(key) ?? [];
        arr.push({ date: r.date, price: t.price, qty: t.qty });
        lots.set(key, arr);
        continue;
      }
      let left = t.qty;
      const arr = lots.get(key) ?? [];
      while (left > 0 && arr.length > 0) {
        const lot = arr[0];
        const take = Math.min(left, lot.qty);
        const rate = ((t.price - lot.price) / lot.price) * 100;
        const got = realized.get(lot.date) ?? [];
        // 수량만큼 가중하지 않고 건별로 넣는다 — 승률·평균을 보려는 것이므로
        got.push(rate);
        realized.set(lot.date, got);
        lot.qty -= take;
        left -= take;
        if (lot.qty <= 0) arr.shift();
      }
      lots.set(key, arr);
    }
  }
  const returnOn = (date: string) => realized.get(date) ?? [];
  const keptReturns = kept.flatMap((r) => returnOn(r.date));
  const brokeReturns = judged.filter((r) => !r.followedRules).flatMap((r) => returnOn(r.date));
  const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

  return {
    days: rows.length,
    streak,
    ruleRate: judged.length > 0 ? (kept.length / judged.length) * 100 : null,
    mistakes: [...mistakeCount.entries()]
      .map(([key, count]) => ({ key, label: MISTAKE_LABEL.get(key) ?? key, count }))
      .sort((a, b) => b.count - a.count),
    moods: [...moodAgg.entries()]
      .map(([key, a]) => ({
        key,
        label: MOOD_LABEL.get(key) ?? key,
        count: a.count,
        ruleRate: a.judged > 0 ? (a.kept / a.judged) * 100 : null,
      }))
      .sort((a, b) => b.count - a.count),
    ruleEdge: {
      keptDays: kept.length,
      keptAvgReturn: avg(keptReturns),
      brokeDays: judged.length - kept.length,
      brokeAvgReturn: avg(brokeReturns),
    },
    lessons: rows
      .filter((r) => r.lesson.trim())
      .slice(-12)
      .reverse()
      .map((r) => ({ date: r.date, lesson: r.lesson })),
  };
}
