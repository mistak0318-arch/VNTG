import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { configFingerprint, evaluateSignal } from "./signalLight.js";
import { fetchUniverse, SCREEN_UNIVERSES } from "./signalScreen.js";
import { regimeTrust } from "./regimeWatch.js";
import { pushNotice } from "./notifyCenter.js";
import { peekSnapshot } from "./marketSnapshot.js";

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
  /**
   * 편입일 종가 대비 N거래일 뒤 (%). **슈퍼신호등과 같은 기준**이라 견줄 수 있다.
   *
   * ⚠️ 「편입일 종가에 샀다면」이라는 **근사**다. 편입 판정은 16:30 이라 그 시각
   * 정규장은 끝나 있다 — NXT 애프터마켓이 열려 있어 살 수는 있지만 별도 호가라
   * 종가와 값이 다르다. 슈퍼신호등도 같은 근사를 쓰므로 **둘을 견주는 데는
   * 문제가 없다** (같은 자로 잰다).
   */
  returns?: { d1: number | null; d5: number | null; d20: number | null };
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

    /*
     * ⑤ **성적을 채운다** — 편입만 하고 뒤를 안 따라가면 원장을 쌓는 뜻이 없다.
     * 이 원장의 존재 이유가 「슈퍼신호등과 견주는 것」이라 견줄 숫자가 있어야 한다.
     *
     * `d20` 이 찬 종목은 건너뛰므로 날이 갈수록 조회가 준다.
     */
    job.step = "성적 채점 중";
    await gradeListTrack(client, 300).catch(() => 0);

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

/**
 * 아직 안 찬 성적을 채운다 — **종목당 일봉 한 번.**
 *
 * `d20` 이 찬 종목은 건너뛰므로 날이 갈수록 조회가 줄어든다. 새로 편입된 것과
 * 아직 스무 날이 안 지난 것만 본다.
 *
 * ⚠️ 슈퍼신호등과 **같은 기준**(편입일 종가 대비)이다. 자가 다르면 두 원장을
 * 견주는 의미가 사라진다.
 */
export async function gradeListTrack(client: KiwoomClient, limit = 200): Promise<number> {
  const store = await load();
  const pending = store.entries.filter((e) => e.addedPrice > 0 && e.returns?.d20 == null);
  if (pending.length === 0) return 0;

  const base = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  /* 같은 종목이 여러 목록에 있으면 일봉을 한 번만 받는다 */
  const barsOf = new Map<string, { date: string; close: number }[]>();
  let graded = 0;

  for (const e of pending.slice(0, limit)) {
    try {
      let rows = barsOf.get(e.code);
      if (!rows) {
        const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
          stk_cd: e.code,
          base_dt: base,
          upd_stkpc_tp: "1",
        });
        rows = ((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[])
          .map((r) => ({
            date: String(r.dt ?? ""),
            close: Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,]/g, ""))),
          }))
          .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
          .sort((a, b) => a.date.localeCompare(b.date));
        barsOf.set(e.code, rows);
        await new Promise((r) => setTimeout(r, 220));
      }
      const addedYmd = e.addedDate.replace(/-/g, "");
      const idx = rows.findIndex((r) => r.date === addedYmd);
      if (idx < 0) continue; // 편입일 봉이 아직 없다 — 다음에
      const pct = (n: number): number | null => {
        const bar = rows![idx + n];
        return bar ? ((bar.close - e.addedPrice) / e.addedPrice) * 100 : null;
      };
      e.returns = { d1: pct(1), d5: pct(5), d20: pct(20) };
      graded += 1;
    } catch {
      /* 이 종목만 건너뛴다 */
    }
  }
  if (graded > 0) await save(store);
  return graded;
}

/** 성적 한 줄 — 슈퍼신호등 채점표와 같은 모양이라 나란히 놓을 수 있다 */
export interface ListGradeRow {
  label: string;
  n: number;
  d1: { avg: number | null; n: number };
  d5: { avg: number | null; n: number };
  d20: { avg: number | null; n: number };
  win1: number | null;
}

function gradeRow(label: string, list: ListEntry[]): ListGradeRow {
  const agg = (pick: (r: NonNullable<ListEntry["returns"]>) => number | null) => {
    const vs = list
      .map((e) => (e.returns ? pick(e.returns) : null))
      .filter((v): v is number => v !== null && Number.isFinite(v));
    return {
      avg: vs.length > 0 ? Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100 : null,
      n: vs.length,
    };
  };
  const d1 = agg((r) => r.d1);
  const wins = list
    .map((e) => e.returns?.d1)
    .filter((v): v is number => v !== null && v !== undefined && Number.isFinite(v));
  return {
    label,
    n: list.length,
    d1,
    d5: agg((r) => r.d5),
    d20: agg((r) => r.d20),
    win1: wins.length > 0 ? Math.round((wins.filter((v) => v > 0).length / wins.length) * 100) : null,
  };
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
  /**
   * **성적표** — 목록별 + 전체. 슈퍼신호등 채점표와 같은 모양이다.
   *
   * 이 원장의 존재 이유가 「슈퍼신호등과 견주는 것」이라, 견줄 숫자가 없으면
   * 원장을 쌓는 뜻이 없다.
   */
  grade: ListGradeRow[];
  /**
   * 추적 중 종목의 **당일 상승/하락 수** — 사이드바 배지가 쓴다.
   *
   * 전종목 스냅샷을 **엿보기만** 한다(`peekSnapshot`) — 없으면 null 이다.
   * 조회를 새로 하지 않는다. 슈퍼신호등 배지와 같은 방식이라 두 메뉴가 같은
   * 자로 잰 숫자를 보여 준다.
   */
  up: number | null;
  down: number | null;
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
  /*
   * 성적표 — 전체 · 목록별 · 순위대별 · 지속성별.
   * **아직 안 찬 줄도 낸다** — 「표본이 없다」도 알아야 할 사실이다.
   */
  const E = store.entries;
  const grade: ListGradeRow[] = [
    gradeRow("전체", E),
    ...SCREEN_UNIVERSES.map((u) => gradeRow(u.label, E.filter((e) => e.list === u.key))),
    gradeRow("순위 100위 안", E.filter((e) => e.rank <= 100)),
    gradeRow("순위 101~500", E.filter((e) => e.rank > 100)),
    gradeRow("하루만 걸림", E.filter((e) => e.seenCount <= 1)),
    gradeRow("이틀 이상 반복", E.filter((e) => e.seenCount >= 2)),
    gradeRow("정상 장세 편입", E.filter((e) => e.regime && !e.regime.weak)),
    gradeRow("약한 장세 편입", E.filter((e) => e.regime?.weak === true)),
  ].filter((g) => g.n > 0);

  /* 배지 — 스냅샷을 엿보기만 한다(조회 0회). 없으면 null */
  const snap = peekSnapshot();
  let up: number | null = null;
  let down: number | null = null;
  if (snap) {
    up = 0;
    down = 0;
    /* 같은 종목이 여러 목록에 있으면 한 번만 센다 */
    const seen = new Set<string>();
    for (const e of E) {
      if (e.active === false || seen.has(e.code)) continue;
      seen.add(e.code);
      const r = snap.byCode.get(e.code)?.changeRate;
      if (typeof r !== "number") continue;
      if (r > 0) up += 1;
      else if (r < 0) down += 1;
    }
  }

  return {
    entries: store.entries,
    lastRunDate: store.lastRunDate,
    counts: store.lastCounts ?? {},
    byList,
    grade,
    up,
    down,
  };
}
