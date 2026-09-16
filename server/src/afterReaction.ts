import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloses } from "./dailyCloses.js";
import { todayListEntries } from "./listTrack.js";
import { loadStockMarks } from "./stockMarks.js";

/**
 * **신호 뒤 애프터에서 어떻게 갔나** (2026-09-16 — 벤티지가 업그레이드 방향에서 고름: 12월 검증 재료).
 *
 * 마감 뒤 정리를 15:55 로 당긴 이유가 「애프터장(16:00~20:00)에서 신호를 쓰려고」다. 그러면 답해야 할 물음이
 * 하나 생긴다 — **정규장 종가에 낸 신호를 애프터에서 사는 게 값을 하나?** 지금은 아무도 안 잰다.
 *
 * 20:10 마무리 회차가 일봉을 애프터까지 포함해 다시 받으면 하루치 재료가 다 모인다:
 *   `c`  정규장 종가(15:30)  ·  `ca` 애프터 종가(20:00)
 * 그날 새로 초록에 편입된 종목(신호등 분석 원장 `addedDate === 오늘`)과 그 종목의 마크(🧲 쌍끌이·외인3칸·
 * 신고가)를 붙여 **하루 한 줄씩** `data/afterReaction.jsonl` 에 쌓는다. 12월 동결 해제 때 「신호 뒤 애프터
 * 반응」을 숫자로 답할 수 있게.
 *
 * 조회 0회 — 전부 파일이다. `ca` 가 없는 날(마무리가 안 돈 날)은 그 줄에 `ca: null` 로 남긴다 — 「모른다」다.
 */

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "afterReaction.jsonl");

export interface ReactionRow {
  day: string;
  code: string;
  name: string;
  lists: string[];
  score: number;
  twin: boolean | null;
  fgn3: boolean | null;
  newHigh250: boolean | null;
  c: number | null;
  ca: number | null;
  /** 애프터 종가 / 정규장 종가 − 1 (%) — ca 가 없으면 null */
  afterPct: number | null;
}

export async function recordAfterReaction(): Promise<{ day: string; rows: number; withAfter: number; avgAfterPct: number | null }> {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const ymd = today.replace(/-/g, "");
  const entries = await todayListEntries(today);
  if (entries.length === 0) return { day: today, rows: 0, withAfter: 0, avgAfterPct: null };

  const [closes, marks] = await Promise.all([loadCloses(), loadStockMarks().catch(() => null)]);
  const bars = closes.bars ?? {};
  /* 같은 날 두 번 돌면(재시도) 이미 적은 종목은 건너뛴다 */
  const already = new Set<string>();
  try {
    for (const line of (await readFile(FILE, "utf-8")).split("\n")) {
      if (!line.trim()) continue;
      const r = JSON.parse(line) as ReactionRow;
      if (r.day === today) already.add(r.code);
    }
  } catch {
    /* 처음이면 파일이 없다 */
  }

  const rows: ReactionRow[] = [];
  for (const e of entries) {
    if (already.has(e.code)) continue;
    const bar = (bars[e.code] ?? []).find((b) => b.d === ymd) ?? null;
    const m = marks?.marks[e.code] ?? null;
    const c = bar && bar.c > 0 ? bar.c : null;
    const ca = bar && typeof bar.ca === "number" && bar.ca > 0 ? bar.ca : null;
    rows.push({
      day: today,
      code: e.code,
      name: e.name,
      lists: e.lists,
      score: e.score,
      twin: m?.twin ?? null,
      fgn3: m?.fgn3 ?? null,
      newHigh250: m?.newHigh250 ?? null,
      c,
      ca,
      afterPct: c !== null && ca !== null ? Math.round(((ca - c) / c) * 10000) / 100 : null,
    });
  }
  if (rows.length > 0) {
    await mkdir(dirname(FILE), { recursive: true });
    await appendFile(FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
  }
  const withAfter = rows.filter((r) => r.afterPct !== null);
  const avg = withAfter.length > 0 ? Math.round((withAfter.reduce((a, r) => a + (r.afterPct ?? 0), 0) / withAfter.length) * 100) / 100 : null;
  return { day: today, rows: rows.length, withAfter: withAfter.length, avgAfterPct: avg };
}

/** 쌓인 것 요약 — 화면·리포트용. 종목 코드는 안 싣고 수·평균만 */
export async function afterReactionSummary(days = 30): Promise<{ days: number; rows: number; withAfter: number; avgAfterPct: number | null; twinAvg: number | null; twinN: number }> {
  let all: ReactionRow[] = [];
  try {
    all = (await readFile(FILE, "utf-8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as ReactionRow);
  } catch {
    return { days: 0, rows: 0, withAfter: 0, avgAfterPct: null, twinAvg: null, twinN: 0 };
  }
  const cutoff = new Date(Date.now() + 9 * 3600_000 - days * 86_400_000).toISOString().slice(0, 10);
  const recent = all.filter((r) => r.day >= cutoff);
  const w = recent.filter((r) => r.afterPct !== null);
  const twin = w.filter((r) => r.twin === true);
  const avg = (xs: ReactionRow[]) => (xs.length > 0 ? Math.round((xs.reduce((a, r) => a + (r.afterPct ?? 0), 0) / xs.length) * 100) / 100 : null);
  return { days: new Set(recent.map((r) => r.day)).size, rows: recent.length, withAfter: w.length, avgAfterPct: avg(w), twinAvg: avg(twin), twinN: twin.length };
}
