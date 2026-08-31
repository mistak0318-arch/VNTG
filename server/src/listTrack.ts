import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { configFingerprint, evaluateSignal } from "./signalLight.js";
import { fetchUniverse, SCREEN_UNIVERSES } from "./signalScreen.js";
import { regimeTrust } from "./regimeWatch.js";
import { pushNotice } from "./notifyCenter.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "listTrack.json");

/**
 * 목록별 신호등 추적 (2026-08-31 — 「신호등 분석」).
 *
 * ## 왜 만들었나
 *
 * 슈퍼신호등을 재구성으로 검증했더니 **앞문(교집합)이 값을 안 했다** — 교집합만
 * 초과 +0.28%p, 초록만 +1.40%p, 둘 다 +1.36%p. 그런데 그건 **근사**였다:
 * 일곱 목록 중 여섯만 되살렸고, 순위도 표본 500 안에서 매겼다.
 *
 * 근사로는 여기까지다. **실제로 두 원장을 나란히 쌓아야** 답이 난다:
 *
 *   이 원장     각 목록 상위 500 → 초록이면 편입 (교집합 안 봄)
 *   슈퍼신호등   같은 목록들 → 3곳 이상 교집합 → 초록이면 편입
 *
 * 몇 달 뒤 두 원장의 성적을 견주면 「교집합이 값을 하나」에 **근사가 아닌 답**이
 * 나온다. 그게 이 모듈의 존재 이유다.
 *
 * ## ⚠️ 왜 superSignal 을 일반화하지 않았나
 *
 * `superSignal.ts` 는 1,400줄이고 매일 15:45 에 도는 핵심이다. 거기를 일반화하다
 * 망가지면 손해가 크다. **구조는 같게, 파일은 따로** 간다 — 코드가 조금 겹치는
 * 대신 한쪽을 고쳐도 다른 쪽이 안 흔들린다.
 *
 * ## 편입·이탈 규칙은 슈퍼신호등과 **똑같다**
 *
 * 그래야 두 원장의 차이가 **「교집합을 봤나 안 봤나」 하나**로 좁혀진다.
 * 규칙이 다르면 무엇 때문에 갈렸는지 알 수 없다.
 *
 *   편입  그 목록 상위 500 안에 있고 신호등이 초록
 *   이탈  이틀 연속 초록 미만 (하루 노랑을 스치고 돌아오는 종목이 흔하다)
 */

/** 목록 하나에서 편입된 종목 */
export interface ListEntry {
  code: string;
  name: string;
  /** 어느 목록에서 왔나 (SCREEN_UNIVERSES key) */
  list: string;
  /** 편입일 (YYYY-MM-DD) */
  addedDate: string;
  addedPrice: number;
  /** 편입 당시 신호등 점수 */
  score: number;
  /** 그 목록에서 몇 위였나 — 순위가 성적을 가르는지 물으려면 있어야 한다 */
  rank: number;
  /** 편입 당시 기준의 지문 — 기준이 바뀌면 그 전후가 갈린다 */
  configHash?: string;
  /** 편입 당시 장세 */
  regime?: { breadth: number | null; newHigh: number | null; weak: boolean };
  /** 이 목록에 며칠째 이어서 걸렸나 */
  seenCount: number;
  lastSeenDate: string;
  /** 이탈했나 — 기록은 지우지 않는다 */
  active?: boolean;
  exitedDate?: string;
  /** 초록 미달이 며칠째인가 — 이틀 연속이면 이탈 */
  missStreak?: number;
}

interface Store {
  entries: ListEntry[];
  lastRunDate: string | null;
  /** 지난 실행에서 목록마다 몇 개를 봤나 — 「왜 이것뿐이지」에 답한다 */
  lastCounts?: Record<string, { universe: number; green: number }>;
}

const EMPTY: Store = { entries: [], lastRunDate: null };

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    return {
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      lastRunDate: raw.lastRunDate ?? null,
      lastCounts: raw.lastCounts,
    };
  } catch {
    return { ...EMPTY };
  }
}

async function save(s: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s), "utf-8");
}

export interface ListTrackJob {
  status: "idle" | "running" | "done" | "error";
  step: string;
  done: number;
  total: number;
  added: number;
  error?: string;
  at: string;
  /** 목록별로 몇 개를 봤고 몇 개가 초록이었나 */
  counts?: Record<string, { universe: number; green: number }>;
}

let job: ListTrackJob = { status: "idle", step: "", done: 0, total: 0, added: 0, at: "" };
export const listTrackJob = (): ListTrackJob => job;

const todayStr = (): string =>
  new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

/**
 * 목록별로 상위 N 을 받아 신호등을 재고, 초록이면 원장에 담는다.
 *
 * ⚠️ **합집합으로 한 번만 평가한다.** 같은 종목이 여러 목록에 있는데 목록마다
 * 다시 재면 조회가 몇 배로 늘어난다 — 신호등 점수는 목록과 무관한 값이다.
 */
export async function runListTrack(
  client: KiwoomClient,
  opts: { limit?: number; force?: boolean } = {},
): Promise<Store> {
  const store = await load();
  const today = todayStr();
  if (!opts.force && store.lastRunDate === today) return store;
  if (job.status === "running") return store;

  const limit = Math.min(Math.max(opts.limit ?? 500, 50), 500);
  job = {
    status: "running",
    step: "목록 받는 중",
    done: 0,
    total: SCREEN_UNIVERSES.length,
    added: 0,
    at: new Date().toISOString(),
  };

  try {
    /* ① 일곱 목록을 차례로 받는다 — 병렬로 쏘면 초당 5회 제한에 걸린다 */
    const byList = new Map<string, { code: string; name: string; price: number; rank: number }[]>();
    for (const u of SCREEN_UNIVERSES) {
      job.step = `${u.label} 받는 중`;
      try {
        const rows = await fetchUniverse(client, u.key, "000", limit);
        byList.set(
          u.key,
          rows.map((c, i) => ({ code: c.code, name: c.name, price: c.price, rank: i + 1 })),
        );
      } catch {
        /* 한 목록이 실패해도 나머지는 간다 — 「장중 기관」은 장 끝나면 빈다 */
        byList.set(u.key, []);
      }
      job.done += 1;
      await new Promise((r) => setTimeout(r, 400));
    }

    /*
     * ② **합집합으로 한 번만 평가한다.** 목록마다 다시 재면 같은 종목을 최대
     * 일곱 번 평가하게 된다 — 신호등 점수는 어느 목록에서 왔는지와 무관하다.
     */
    const union = new Map<string, { name: string; price: number }>();
    for (const rows of byList.values()) {
      for (const r of rows) if (!union.has(r.code)) union.set(r.code, { name: r.name, price: r.price });
    }

    const cfgHash = await configFingerprint().catch(() => undefined);
    const reg = await regimeTrust().catch(() => null);

    job.step = "신호등 평가 중";
    job.total = union.size;
    job.done = 0;

    /** 초록인 종목 → 점수 */
    const green = new Map<string, number>();
    for (const [code] of union) {
      try {
        const sig = await evaluateSignal(client, code);
        if (sig.level === "green") green.set(code, sig.score);
      } catch {
        /* 이 종목만 건너뛴다 */
      }
      job.done += 1;
      /* 초당 5회 제한 — 신호등 평가는 종목당 여러 조회다 */
      await new Promise((r) => setTimeout(r, 220));
    }

    /* ③ 목록별로 편입·갱신 — 같은 종목이 여러 목록이면 목록마다 한 줄이다 */
    const counts: Record<string, { universe: number; green: number }> = {};
    const have = new Map(store.entries.map((e) => [`${e.list}:${e.code}`, e]));
    let added = 0;

    for (const u of SCREEN_UNIVERSES) {
      const rows = byList.get(u.key) ?? [];
      let g = 0;
      for (const r of rows) {
        const score = green.get(r.code);
        if (score === undefined) continue;
        g += 1;
        const key = `${u.key}:${r.code}`;
        const prev = have.get(key);
        if (prev) {
          /* 이미 있는 것 — 이어진 것으로 센다 */
          prev.seenCount += 1;
          prev.lastSeenDate = today;
          prev.missStreak = 0;
          if (prev.active === false) {
            prev.active = true;
            prev.exitedDate = undefined;
          }
        } else {
          const entry: ListEntry = {
            code: r.code,
            name: union.get(r.code)?.name ?? r.name,
            list: u.key,
            addedDate: today,
            addedPrice: r.price,
            score,
            rank: r.rank,
            configHash: cfgHash,
            regime: reg
              ? { breadth: reg.breadth, newHigh: reg.newHigh, weak: reg.weak }
              : undefined,
            seenCount: 1,
            lastSeenDate: today,
            active: true,
          };
          store.entries.push(entry);
          have.set(key, entry);
          added += 1;
        }
      }
      counts[u.key] = { universe: rows.length, green: g };
    }

    /*
     * ④ 이탈 — **이틀 연속** 초록 미만. 슈퍼신호등과 같은 규칙이다.
     * 하루 노랑을 스치고 돌아오는 종목이 흔해서 하루로는 안 뺀다.
     */
    for (const e of store.entries) {
      if (e.active === false) continue;
      if (e.lastSeenDate === today) continue;
      e.missStreak = (e.missStreak ?? 0) + 1;
      if (e.missStreak >= 2) {
        e.active = false;
        e.exitedDate = today;
      }
    }

    store.lastRunDate = today;
    store.lastCounts = counts;
    await save(store);

    job = { ...job, status: "done", step: "완료", added, counts };

    /*
     * **끝나면 알린다** (2026-08-31 요청 — "신호등 분석 다하면 알림으로 알려주고").
     *
     * 한 행동에 대해 충분히 적는다 — 무엇을 했나 · 얼마나 봤나 · 무엇이 나왔나 ·
     * 어디로 가면 되나. 「완료」만 있으면 통보지 정보가 아니다.
     */
    const top = Object.entries(counts)
      .map(([k, v]) => {
        const label = SCREEN_UNIVERSES.find((u) => u.key === k)?.label ?? k;
        return `${label} ${v.green}/${v.universe}`;
      })
      .join(" · ");
    await pushNotice({
      kind: "system",
      level: "info",
      title: `신호등 분석 완료 — 초록 ${green.size}종목 · 새 편입 ${added}`,
      body:
        `일곱 목록 각 상위 ${limit}종목 → 합집합 ${union.size}종목을 평가했습니다.\n` +
        `${top}\n` +
        (reg?.weak ? `⚠️ 오늘은 신호등이 잘 안 듣는 장세입니다 (${reg.why}).\n` : "") +
        `→ 신호등 분석 화면에서 목록별로 볼 수 있습니다.`,
      link: "#/listTrack",
      dedupeKey: "listTrack:done",
      dedupeHours: 20,
    }).catch(() => undefined);

    return store;
  } catch (err) {
    job = { ...job, status: "error", error: err instanceof Error ? err.message : "실패" };
    return store;
  }
}

export interface ListTrackSummary {
  entries: ListEntry[];
  lastRunDate: string | null;
  counts: Record<string, { universe: number; green: number }>;
  /** 목록별 요약 — 추적 중·이탈·평균 점수 */
  byList: {
    key: string;
    label: string;
    active: number;
    exited: number;
    avgScore: number | null;
  }[];
}

export async function listTrackSummary(): Promise<ListTrackSummary> {
  const store = await load();
  const byList = SCREEN_UNIVERSES.map((u) => {
    const mine = store.entries.filter((e) => e.list === u.key);
    const act = mine.filter((e) => e.active !== false);
    const scores = act.map((e) => e.score).filter((v) => Number.isFinite(v));
    return {
      key: u.key,
      label: u.label,
      active: act.length,
      exited: mine.length - act.length,
      avgScore: scores.length > 0 ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    };
  });
  return {
    entries: store.entries,
    lastRunDate: store.lastRunDate,
    counts: store.lastCounts ?? {},
    byList,
  };
}
