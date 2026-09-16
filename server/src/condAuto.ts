import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getCondJob, linesOf, listPresets, startCondSearch, touchPresetAuto, type CondPreset } from "./condSearch.js";
import { pushNotice, stockLink } from "./notifyCenter.js";
import { sendTelegram, stockNameHtml } from "./telegram.js";

/**
 * **저장한 조건식을 마감 뒤에 알아서 돌린다** (2026-09-16 — 벤티지가 업그레이드 방향에서 고름).
 *
 * 전종목 마크가 생기면서 가능해진 것이다. 마크만으로 짠 조건식은 **키움 조회가 0회**라 2,600종목을 몇 초에
 * 훑는다 — 그러니 사람이 화면을 열 필요 없이 마감 뒤 정리 ⑧(전종목 마크) 바로 뒤에 돌려, **어제는 없었는데
 * 오늘 새로 걸린 종목**만 알려 줄 수 있다. 애프터장(16:00~20:00)에서 바로 쓴다.
 *
 * ## 규칙
 *   · `auto` 로 켠 식만. 화면에서 ⏰ 로 켜고 끈다
 *   · **마크·스냅샷 조건만** 든 식만 돌린다 — 신호등 기준이 하나라도 들어 있으면 종목당 조회가 나가므로
 *     자동으로는 안 돌리고 「손으로 돌리세요」라고 적는다. 밤에 조회를 몰래 쓰지 않는다
 *   · 어제 걸렸던 종목은 안 알린다. 새로 걸린 것만 — 그게 「신호」다. 빠진 것은 수만 적는다
 *   · 텔레그램은 시그널 방, 알림함은 식마다 한 줄. 새로 걸린 게 없으면 조용하다
 *
 * ## 「모른다」
 *   마크 파일이 없거나 어제 것이면 돌리지 않는다 — 어제 마크로 「오늘 새로 걸렸다」고 하면 거짓말이다.
 */

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "condAuto.json");

interface AutoState {
  /** presetId → 마지막으로 돌린 날과 그때 걸린 코드 */
  [presetId: string]: { day: string; codes: string[]; names: Record<string, string> };
}

async function loadState(): Promise<AutoState> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as AutoState;
  } catch {
    return {};
  }
}
async function saveState(s: AutoState): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s), "utf-8");
}

/** 조회 없이 돌 수 있는 식인가 — 마크(mk*)·스냅샷 사전필터만 */
export function isZeroCallQuery(p: CondPreset): boolean {
  const keys = linesOf(p.query).map((l) => l.key);
  return keys.length > 0 && keys.every((k) => k.startsWith("mk"));
}

/** 작업이 끝날 때까지 기다린다 — 마크 전용이면 몇 초, 상한 3분 */
async function waitJob(id: string, maxMs = 3 * 60_000): Promise<ReturnType<typeof getCondJob> | null> {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    const j = getCondJob(id);
    if (!j) return null;
    if (j.status !== "running") return j;
    await new Promise((r) => setTimeout(r, 500));
  }
  return getCondJob(id);
}

export interface AutoRunResult {
  ran: number;
  skipped: string[];
  newHits: { preset: string; added: { code: string; name: string }[]; removed: number; total: number }[];
}

/**
 * 켜 둔 식을 전부 돌리고 새로 걸린 종목을 알린다. **마감 뒤 정리 ⑧ 전종목 마크 다음**에 부른다.
 * @param marksDay 방금 만든 마크가 어느 날 것인가(YYYYMMDD) — 오늘이 아니면 돌리지 않는다
 */
export async function runAutoPresets(client: KiwoomClient, marksDay: string, opts: { send?: boolean } = {}): Promise<AutoRunResult> {
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const out: AutoRunResult = { ran: 0, skipped: [], newHits: [] };
  if (marksDay.replace(/-/g, "") !== today.replace(/-/g, "")) {
    out.skipped.push(`마크가 오늘 것이 아니라(${marksDay}) 안 돌림`);
    return out;
  }
  const presets = (await listPresets()).filter((p) => p.auto);
  if (presets.length === 0) return out;
  const state = await loadState();

  for (const p of presets) {
    if (!isZeroCallQuery(p)) {
      out.skipped.push(`「${p.name}」 — 신호등 기준이 들어 있어 조회가 나간다. 자동으로는 안 돌림(손으로)`);
      continue;
    }
    /* 마크 전용이면 모집단은 마크 파일 전부 — 화면에서 고른 한도와 무관 */
    const id = startCondSearch(client, { ...p.query, universe: "all", limit: 3000 });
    const job = await waitJob(id);
    if (!job || job.status !== "done") {
      out.skipped.push(`「${p.name}」 — ${job?.error ?? "끝나지 않음"}`);
      continue;
    }
    out.ran += 1;
    const codes = job.results.map((r) => r.code);
    const names: Record<string, string> = {};
    for (const r of job.results) names[r.code] = r.name;
    const prev = state[p.id];
    const prevSet = new Set(prev && prev.day !== today ? prev.codes : prev?.day === today ? prev.codes : []);
    /* 같은 날 두 번 돌면(재시도) 이미 알린 것을 또 알리지 않는다 — 어제 것과 오늘 이미 알린 것 둘 다 뺀다 */
    const added = codes.filter((c) => !prevSet.has(c)).map((c) => ({ code: c, name: names[c] ?? c }));
    const removed = prev && prev.day !== today ? prev.codes.filter((c) => !codes.includes(c)).length : 0;
    state[p.id] = { day: today, codes: prev?.day === today ? [...new Set([...prev.codes, ...codes])] : codes, names };
    await touchPresetAuto(p.id, codes.length, added.length).catch(() => undefined);
    out.newHits.push({ preset: p.name, added, removed, total: codes.length });
  }
  await saveState(state).catch((e) => console.error("[condAuto] 상태 못 씀 —", e instanceof Error ? e.message : e));

  if (opts.send === false) return out;
  const worth = out.newHits.filter((h) => h.added.length > 0);
  if (worth.length === 0) return out;

  const lines = worth.map(
    (h) =>
      `🧾 <b>${h.preset}</b> — 새로 ${h.added.length}종목 (전체 ${h.total}${h.removed ? ` · 빠짐 ${h.removed}` : ""})\n` +
      h.added
        .slice(0, 20)
        .map((s) => `• ${stockNameHtml(s.code, s.name)}`)
        .join("\n") +
      (h.added.length > 20 ? `\n… 외 ${h.added.length - 20}` : ""),
  );
  await sendTelegram(`⏰ <b>조건식 자동 실행</b> (마감 뒤 · 조회 0회)\n\n${lines.join("\n\n")}`, "signal").catch(() => undefined);
  for (const h of worth) {
    await pushNotice({
      source: "condAuto",
      kind: "stock",
      level: "info",
      title: `조건식 「${h.preset}」 새로 ${h.added.length}종목`,
      body: h.added.map((s) => s.name).join(", "),
      link: h.added.length === 1 ? stockLink(h.added[0].code, h.added[0].name) : "#/condSearch",
      dedupeKey: `condAuto:${h.preset}:${today}`,
      dedupeHours: 12,
    }).catch(() => undefined);
  }
  return out;
}
