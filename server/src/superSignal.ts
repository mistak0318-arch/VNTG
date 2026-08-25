import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { evaluateSignal } from "./signalLight.js";
import { fetchUniverse, SCREEN_UNIVERSES, type Candidate } from "./signalScreen.js";
import {
  ensureInGroup,
  listWatchlist,
  removeWatchItem,
  SUPER_GROUP,
  updateWatchItem,
} from "./watchlist.js";

/**
 * 슈퍼신호등 — **여러 목록에 동시에 걸린 초록** (2026-08-25).
 *
 * 신호등 찾기의 모집단이 일곱 가지가 되면서 자연스러운 다음 물음이 생겼다:
 * 「거래대금도 몰리고, 등락률도 상위고, 외국인도 연속으로 사는 종목」 — 목록
 * **하나**에 걸린 초록보다 **여럿**에 걸린 초록이 진짜 아닐까. 그 교집합을
 * 매일 장 마감 뒤 자동으로 뽑아 며칠이고 따라가 보는 자리다. 추적기의 상위판이다.
 *
 * ## 규칙
 *
 *   모집단   일곱 목록 전부, 각 300개 기준 (짧은 목록은 주는 만큼 — ka10062 등은
 *            100건 안팎이 상한이다. 그건 그 목록의 사정이지 우리가 부풀릴 일이 아니다)
 *   교집합   **3개 목록 이상**에 등장. 7개 전부는 사실상 공집합이고, 2개는 거래대금·
 *            등락률처럼 서로 붙어 다니는 짝이 많아 흔하다. 셋부터 이야기가 된다
 *   문턱     신호등 **초록**만. 슈퍼라는 말에 노랑이 섞이면 이름이 거짓말이 된다
 *   시각     평일 15:45 — 추적기(15:40)가 같은 종목들의 신호등을 먼저 평가해
 *            15분 캐시를 데워 두므로, 5분 뒤에 돌면 대부분 캐시로 끝난다
 *
 * ## 무엇을 기록하나
 *
 * 편입일·편입가(그날 종가)·걸린 목록들·점수. 그리고 **며칠째 다시 걸리는지**
 * (`seenCount`) — 하루 반짝 교집합과 사흘째 계속 걸리는 종목은 다른 이야기다.
 * 수익률은 화면에서 지금 스냅샷과 견줘 계산한다(편입가 대비) — 추적기처럼
 * 지평별(1/5/20일) 통계까지는 표본이 쌓인 뒤의 일이다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "superSignal.json");

/** 교집합 문턱 — 몇 개 목록에 걸려야 「슈퍼」인가 */
const MIN_LISTS = 3;
/** 하루에 평가할 교집합 상한 — 종목당 조회 여러 번이라 폭주를 막는다 */
const MAX_EVAL = 40;

export interface SuperEntry {
  code: string;
  name: string;
  /** 편입일 (YYYY-MM-DD) */
  addedDate: string;
  /** 편입일 가격 — 그날 모집단 조회가 준 값 */
  addedPrice: number;
  /** 편입 당시 신호등 점수 */
  score: number;
  /** 걸린 목록 (SCREEN_UNIVERSES key) — 마지막으로 걸린 날 기준 */
  lists: string[];
  /** 며칠째 교집합에 걸렸나 — 지속성이 곧 신호다 */
  seenCount: number;
  lastSeenDate: string;
}

interface Store {
  entries: SuperEntry[];
  lastRunDate: string | null;
}

const EMPTY: Store = { entries: [], lastRunDate: null };

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    return {
      entries: Array.isArray(raw.entries) ? raw.entries : [],
      lastRunDate: typeof raw.lastRunDate === "string" ? raw.lastRunDate : null,
    };
  } catch {
    return { ...EMPTY };
  }
}

async function save(s: Store): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s, null, 2), "utf-8");
}

function todayStr(d = new Date()): string {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return k.toISOString().slice(0, 10);
}

/** 진행 상황 — 화면 진행바용. 하나만 돈다 */
export interface SuperJob {
  status: "idle" | "running" | "done" | "error";
  /** 지금 무엇을 하고 있나 */
  step: string;
  done: number;
  total: number;
  /** 이번 실행에서 새로 담은 수 */
  added: number;
  error?: string;
  at: string;
}

let job: SuperJob = { status: "idle", step: "", done: 0, total: 0, added: 0, at: "" };

export function superJob(): SuperJob {
  return job;
}

/**
 * 교집합을 뽑아 담는다. 하루 한 번이 원칙이지만 `force` 로 다시 돌 수 있다
 * (그날 이미 담은 종목은 중복으로 안 담기므로 다시 돌아도 해가 없다).
 */
export async function runSuperSignal(client: KiwoomClient, force = false): Promise<Store> {
  const store = await load();
  const today = todayStr();
  if (!force && store.lastRunDate === today) return store;
  if (job.status === "running") return store;

  job = { status: "running", step: "목록 받는 중", done: 0, total: SCREEN_UNIVERSES.length, added: 0, at: new Date().toISOString() };

  try {
    /*
     * 일곱 목록을 **차례로** 받는다. 병렬로 쏘면 초당 5회 제한에 걸린다.
     * 각 목록 안의 연속조회 간격은 fetchUniverse 가 이미 지킨다.
     */
    const byCode = new Map<string, { c: Candidate; lists: string[] }>();
    for (const u of SCREEN_UNIVERSES) {
      job.step = `${u.label} 받는 중`;
      const rows = await fetchUniverse(client, u.key, "000", 300).catch(() => [] as Candidate[]);
      for (const c of rows) {
        const hit = byCode.get(c.code);
        if (hit) {
          hit.lists.push(u.key);
          // 가격은 값이 있는 쪽을 남긴다 (몇 목록은 현재가를 안 준다)
          if (hit.c.price === 0 && c.price > 0) hit.c = c;
        } else {
          byCode.set(c.code, { c, lists: [u.key] });
        }
      }
      job.done += 1;
      await new Promise((r) => setTimeout(r, 400));
    }

    const inter = [...byCode.values()]
      .filter((x) => x.lists.length >= MIN_LISTS)
      .sort((a, b) => b.lists.length - a.lists.length)
      .slice(0, MAX_EVAL);

    job.step = "신호등 평가 중";
    job.total = inter.length;
    job.done = 0;

    const have = new Map(store.entries.map((e) => [e.code, e]));
    let added = 0;
    for (const x of inter) {
      try {
        const sig = await evaluateSignal(client, x.c.code);
        if (sig.level === "green") {
          const prev = have.get(x.c.code);
          if (prev) {
            // 이미 추적 중 — 오늘 또 걸렸다는 사실이 정보다
            if (prev.lastSeenDate !== today) prev.seenCount += 1;
            prev.lastSeenDate = today;
            prev.lists = x.lists;
            // 그룹에서 빠져 있으면 다시 담는다(기능 추가 전 편입분도 이 길로 들어온다)
            await ensureInGroup(
              { code: prev.code, name: prev.name, addedPrice: prev.addedPrice },
              SUPER_GROUP,
            ).catch(() => undefined);
          } else {
            const entry: SuperEntry = {
              code: x.c.code,
              name: x.c.name,
              addedDate: today,
              addedPrice: x.c.price,
              score: sig.score,
              lists: x.lists,
              seenCount: 1,
              lastSeenDate: today,
            };
            store.entries.push(entry);
            have.set(entry.code, entry);
            added += 1;
            /*
             * 관심종목 「슈퍼신호등」 그룹에도 담는다 (사용자 요청) — 관심종목이
             * 실시간·손절감시·뉴스 검색의 축이라, 거기 있어야 나머지가 따라붙는다.
             * 이미 다른 그룹에 담긴 종목이면 그룹만 더한다(편입가·메모는 그대로).
             */
            await ensureInGroup(
              {
                code: entry.code,
                name: entry.name,
                addedPrice: entry.addedPrice,
                memo: `슈퍼신호등 자동 편입 (${today} · 목록 ${entry.lists.length}곳 · ${entry.score}점)`,
              },
              SUPER_GROUP,
            ).catch(() => undefined);
          }
        }
      } catch {
        /* 한 종목 실패가 전체를 막지 않게 */
      }
      job.done += 1;
      job.added = added;
      await new Promise((r) => setTimeout(r, 260));
    }

    // 오래된 것부터 정리 — 관찰 목록이지 박물관이 아니다
    store.entries.sort((a, b) => b.addedDate.localeCompare(a.addedDate));
    store.entries = store.entries.slice(0, 200);
    store.lastRunDate = today;
    await save(store);
    job = { ...job, status: "done", step: "완료" };
  } catch (err) {
    job = { ...job, status: "error", error: err instanceof Error ? err.message : "실패" };
  }
  return store;
}

/** 화면용 — 지금 가격을 스냅샷에서 붙여 편입가 대비를 낸다 */
export async function listSuperSignal(client: KiwoomClient): Promise<{
  entries: (SuperEntry & { price: number | null; changeRate: number | null; sinceAdded: number | null })[];
  lastRunDate: string | null;
  minLists: number;
}> {
  const store = await load();
  const snap = await getMarketSnapshot(client).catch(() => null);
  const entries = store.entries.map((e) => {
    const s = snap?.byCode.get(e.code);
    const price = s?.price ?? null;
    return {
      ...e,
      price,
      changeRate: s?.changeRate ?? null,
      sinceAdded:
        price !== null && e.addedPrice > 0 ? ((price - e.addedPrice) / e.addedPrice) * 100 : null,
    };
  });
  return { entries, lastRunDate: store.lastRunDate, minLists: MIN_LISTS };
}

export async function removeSuperEntry(code: string): Promise<void> {
  const store = await load();
  store.entries = store.entries.filter((e) => e.code !== code);
  await save(store);

  /*
   * 관심종목 쪽도 정리한다 — 슈퍼신호등 그룹에만 있던 종목이면 통째로 빼고,
   * 다른 그룹에도 담겨 있으면 슈퍼신호등 그룹만 뗀다(사람이 담은 건 사람 것이다).
   */
  try {
    const items = await listWatchlist();
    const w = items.find((i) => i.code === code);
    if (!w) return;
    if (w.groups.length === 1 && w.groups[0] === SUPER_GROUP) {
      await removeWatchItem(code);
    } else if (w.groups.includes(SUPER_GROUP)) {
      await updateWatchItem(code, { groups: w.groups.filter((g) => g !== SUPER_GROUP) });
    }
  } catch {
    /* 관심종목 정리는 부수 작업 — 실패해도 슈퍼 목록에서는 빠졌다 */
  }
}

/**
 * 평일 15:45 에 알아서 돈다 — 추적기(15:40)가 신호등 캐시를 데운 5분 뒤.
 * 그 시각을 지나 서버를 켠 날도 그날 안이면 한 번 돈다 (lastRunDate 가 막는다).
 */
export function startSuperSignalScheduler(client: KiwoomClient): void {
  const tick = async () => {
    const now = new Date();
    const k = new Date(now.getTime() + 9 * 3600_000);
    const day = k.getUTCDay();
    if (day === 0 || day === 6) return;
    const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
    if (mins < 15 * 60 + 45 || mins > 23 * 60) return;
    await runSuperSignal(client).catch(() => undefined);
  };
  void tick();
  setInterval(() => void tick(), 60_000);
  console.log("[superSignal] 슈퍼신호등 시작 — 평일 15:45 교집합 편입");
}
