import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateSignal, getConfig, type CheckKey } from "./signalLight.js";
import { fetchUniverse, type Candidate } from "./signalScreen.js";
import { getSharesMap } from "./stockListCache.js";
import { getMarketSnapshot } from "./marketSnapshot.js";

/**
 * 조건 검색 — **증권사 조건검색식처럼.**
 *
 * 벤티지: "조건은 신호등에 있는 조건들 그거를 쓸 수 있도록 하자. 그래서 이건
 * 가중치가 아니라 그걸 통과하냐 마느냐. AND 조건, OR 조건 이렇게 해 가지고 아예
 * 그냥 필터를 걸어 가지고 그 리스트만 볼 수 있게 하는 거야."
 *
 * ## 신호등과 무엇이 다른가
 *
 * 신호등은 **점수**다 — 여러 기준을 가중평균해 70점이면 초록. 좋은 점은 한두
 * 기준이 나빠도 나머지가 좋으면 걸린다는 것이고, 나쁜 점은 **「정배열인 것만」을
 * 못 고른다**는 것이다. 점수 안에 묻혀 버린다.
 *
 * 조건 검색은 **이분법**이다 — 통과냐 아니냐. 「정배열 AND 영업이익 증가」를
 * 그대로 쓴다. 둘은 반대 성격이라 한쪽이 다른 쪽을 대신할 수 없다.
 *
 * ## 조건식의 모양
 *
 *   그룹 안은 AND 이거나 OR, **그룹끼리는 늘 AND**
 *
 *     (정배열 OR 신고가) AND (영업이익 증가) AND (공매도 식는 중)
 *
 * 완전한 괄호 중첩은 안 된다. 하지만 「A or B」를 몇 덩어리 이어 붙이는 것으로
 * 실제 쓰는 조건식은 거의 다 표현된다 — 증권사 조건식도 대개 이 모양이다.
 *
 * ## 조회를 아끼는 방법
 *
 * ⚠️ 조건이 신호등 기준이므로 **판정하려면 그 기준을 평가해야 한다.** 종목당
 * 조회가 나간다는 뜻이다. 세 가지로 막는다:
 *
 *   ① **사전 필터를 먼저** — 시장·시가총액은 전종목 스냅샷으로 거른다(조회 0회).
 *      500종목이 80종목으로 줄면 그만큼 안 부른다
 *   ② **조건에 쓰인 기준만** 켠 설정으로 평가한다. 「정배열」만 물으면 일봉 하나면
 *      되고, 「영업이익」을 안 물으면 DART 를 안 부른다
 *   ③ **점수는 따로** — 결과 목록에 점수를 매기는 것은 화면에서 눌러야 돈다
 *      (벤티지: "신호등 점수 매기기 딱 누르면"). 필터만 볼 때는 안 매긴다
 */

export interface Cond {
  key: CheckKey;
  /** 통과를 원하나(true), 미달을 원하나(false) */
  want: boolean;
}

export interface CondGroup {
  join: "and" | "or";
  conds: Cond[];
}

export interface CondQuery {
  /** 어느 목록에서 — `SCREEN_UNIVERSES` 의 key */
  universe: string;
  /** 000 전체 · 001 코스피 · 101 코스닥 */
  market: string;
  limit: number;
  /** 시가총액(억원) 하한·상한 — 조회 0회로 미리 거른다 */
  capMin?: number | null;
  capMax?: number | null;
  groups: CondGroup[];
}

export interface CondHit {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  /** 시가총액(억원) — 못 내면 null */
  marketCap: number | null;
  /** 어느 조건을 통과했나 — 화면이 「왜 걸렸는지」를 말할 수 있게 */
  matched: string[];
  stale?: boolean;
}

export interface CondJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  /** 사전 필터로 걸러지고 남은 수 — 「500 중 80을 봤다」를 말하려면 필요하다 */
  prefiltered: number;
  results: CondHit[];
  query: CondQuery;
  startedAt: string;
  error?: string;
}

/* ------------------------------------------------------------------ */
/* 조건식 저장 — 증권사 조건검색처럼 이름을 붙여 두고 불러 쓴다          */
/* ------------------------------------------------------------------ */

export interface CondPreset {
  id: string;
  name: string;
  query: CondQuery;
  savedAt: string;
  /** 마지막으로 돌린 때 · 그때 몇 개 걸렸나 — 「이 식이 요즘 쓸모 있나」가 보인다 */
  lastRunAt?: string;
  lastHits?: number;
}

const here = dirname(fileURLToPath(import.meta.url));
const PRESET_FILE = join(here, "..", "data", "condPresets.json");

let presetCache: CondPreset[] | null = null;

export async function listPresets(): Promise<CondPreset[]> {
  if (presetCache) return presetCache;
  try {
    presetCache = JSON.parse(await readFile(PRESET_FILE, "utf-8")) as CondPreset[];
  } catch {
    presetCache = [];
  }
  return presetCache;
}

async function savePresets(list: CondPreset[]): Promise<void> {
  presetCache = list;
  await mkdir(dirname(PRESET_FILE), { recursive: true });
  await writeFile(PRESET_FILE, JSON.stringify(list, null, 1), "utf-8");
}

/**
 * 저장 — **같은 이름이면 덮어쓴다.**
 *
 * 증권사 조건검색이 그렇게 동작하고, 무엇보다 「조금 고쳐서 다시 저장」이 이
 * 기능을 쓰는 방식이다. 그때마다 같은 이름이 둘씩 쌓이면 목록이 곧 못 쓰게 된다.
 */
export async function savePreset(name: string, query: CondQuery): Promise<CondPreset[]> {
  const trimmed = name.trim().slice(0, 40);
  if (!trimmed) throw new Error("이름을 넣어야 합니다");
  const list = [...(await listPresets())];
  const at = list.findIndex((p) => p.name === trimmed);
  const item: CondPreset = {
    id: at >= 0 ? list[at].id : `cp_${Math.random().toString(36).slice(2, 10)}`,
    name: trimmed,
    query,
    savedAt: new Date().toISOString(),
    lastRunAt: at >= 0 ? list[at].lastRunAt : undefined,
    lastHits: at >= 0 ? list[at].lastHits : undefined,
  };
  if (at >= 0) list[at] = item;
  else list.unshift(item);
  await savePresets(list.slice(0, 50));
  return presetCache!;
}

export async function removePreset(id: string): Promise<CondPreset[]> {
  const list = (await listPresets()).filter((p) => p.id !== id);
  await savePresets(list);
  return list;
}

/** 돌린 뒤 결과 수를 적어 둔다 — 「요즘 아무것도 안 걸리는 식」이 보인다 */
async function touchPreset(query: CondQuery, hits: number): Promise<void> {
  try {
    const list = await listPresets();
    const key = JSON.stringify(query.groups);
    const hit = list.find((p) => JSON.stringify(p.query.groups) === key);
    if (!hit) return;
    hit.lastRunAt = new Date().toISOString();
    hit.lastHits = hits;
    await savePresets(list);
  } catch {
    /* 기록 실패가 검색을 막지 않는다 */
  }
}

const jobs = new Map<string, CondJob>();

export function getCondJob(id: string): CondJob | undefined {
  return jobs.get(id);
}

function prune(): void {
  if (jobs.size < 20) return;
  const old = [...jobs.entries()]
    .sort((a, b) => a[1].startedAt.localeCompare(b[1].startedAt))
    .slice(0, 10);
  for (const [id] of old) jobs.delete(id);
}

/** 조건식이 실제로 쓰는 기준들 — 이것만 켠 설정으로 평가한다 */
function usedKeys(q: CondQuery): Set<CheckKey> {
  const s = new Set<CheckKey>();
  for (const g of q.groups) for (const c of g.conds) s.add(c.key);
  return s;
}

export function startCondSearch(client: KiwoomClient, q: CondQuery): string {
  const id = `cond_${Math.random().toString(36).slice(2, 12)}`;
  const job: CondJob = {
    status: "running",
    total: 0,
    done: 0,
    prefiltered: 0,
    results: [],
    query: q,
    startedAt: new Date().toISOString(),
  };
  jobs.set(id, job);
  prune();
  void run(client, q, job).catch((err) => {
    job.status = "error";
    job.error = err instanceof Error ? err.message : "알 수 없는 오류";
  });
  return id;
}

async function run(client: KiwoomClient, q: CondQuery, job: CondJob): Promise<void> {
  /* ① 모집단 */
  const uni: Candidate[] = await fetchUniverse(client, q.universe, q.market, q.limit);

  /*
   * ② **사전 필터 — 조회 0회.**
   *
   * 시가총액은 상장주식수(하루 캐시) × 현재가로 낸다. 스냅샷에 없는 종목은
   * 시총을 **모르는 것**이지 0 이 아니므로, 시총 조건이 걸려 있으면 빼고
   * 없으면 그대로 둔다 — 모른다고 버리면 신규 상장이 늘 빠진다.
   */
  const shares = await getSharesMap(client).catch(() => new Map<string, number>());
  const snap = await getMarketSnapshot(client).catch(() => null);
  const capOf = (c: Candidate): number | null => {
    const sh = shares.get(c.code);
    const px = c.price > 0 ? c.price : (snap?.byCode.get(c.code)?.price ?? 0);
    return sh && sh > 0 && px > 0 ? Math.round((sh * px) / 100_000_000) : null;
  };

  const wantsCap = q.capMin != null || q.capMax != null;
  const pool = uni.filter((c) => {
    if (!wantsCap) return true;
    const cap = capOf(c);
    if (cap === null) return false;
    if (q.capMin != null && cap < q.capMin) return false;
    if (q.capMax != null && cap > q.capMax) return false;
    return true;
  });
  job.prefiltered = pool.length;
  job.total = pool.length;

  /*
   * ③ **조건에 쓰인 기준만 켠 설정**으로 평가한다.
   *
   * 「정배열」만 물으면 일봉 하나면 되고, 「영업이익」을 안 물으면 DART 를 안
   * 부른다. 신호등이 이미 `need` 로 필요한 것만 조회하므로, 켠 기준을 줄이는
   * 것만으로 조회가 줄어든다.
   */
  const base = await getConfig();
  const keys = usedKeys(q);
  const cfg = {
    ...base,
    checks: base.checks.map((c) => ({ ...c, enabled: keys.has(c.key) })),
  };

  for (const c of pool) {
    try {
      const sig = await evaluateSignal(client, c.code, { config: cfg });
      const passOf = (k: CheckKey): boolean | null =>
        sig.checks.find((x) => x.key === k)?.pass ?? null;

      /* 그룹 안은 join, 그룹끼리는 AND */
      const matched: string[] = [];
      let ok = true;
      for (const g of q.groups) {
        if (g.conds.length === 0) continue;
        const hits = g.conds.filter((cond) => {
          const p = passOf(cond.key);
          /*
           * ⚠️ **못 잰 기준은 통과가 아니다.** 데이터가 없어서 null 인 것을
           * 통과로 치면 「영업이익 증가」 조건이 재무를 못 받은 종목을 다 걸러
           * 온다. 「모른다」와 「맞다」는 다른 말이다.
           */
          return p !== null && p === cond.want;
        });
        for (const h of hits) {
          const label = sig.checks.find((x) => x.key === h.key)?.label ?? h.key;
          matched.push(h.want ? label : `${label} 미달`);
        }
        const groupOk = g.join === "and" ? hits.length === g.conds.length : hits.length > 0;
        if (!groupOk) {
          ok = false;
          break;
        }
      }

      if (ok) {
        job.results.push({
          code: c.code,
          name: c.name,
          price: c.price,
          changeRate: c.changeRate,
          tradeValue: c.tradeValue,
          marketCap: capOf(c),
          matched,
          stale: c.stale,
        });
      }
    } catch {
      /* 한 종목 실패가 전체를 막지 않게 */
    }
    job.done += 1;
    /* 신호등 하나가 여러 TR 을 부르므로 간격을 둔다 — 초당 5회 제한 */
    await new Promise((r) => setTimeout(r, 240));
  }

  job.status = "done";
  void touchPreset(q, job.results.length);
}
