import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateSignal, getConfig, type CheckKey } from "./signalLight.js";
import { fetchUniverse, type Candidate } from "./signalScreen.js";
import { getSharesMap } from "./stockListCache.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { condField, isOwnField, ownValues } from "./condFields.js";

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
  key: string;
  /**
   * **무엇과 견주나** (2026-09-01 개정).
   *
   * 처음엔 `want: boolean` 하나였다 — 「통과냐 미달이냐」. 그런데 그 「통과」의
   * 문턱이 **신호등 설정을 그대로 따라갔다.** 벤티지: "각 조건들에 대해서 세밀한
   * 값을 내가 만들고 그걸 저장해야 내 조건이 되는 거잖아. 체크만 하는 건 의미가
   * 없다고 생각하지 않아."
   *
   * 맞는 말이다. 조건검색식이라면 **「60일 신고가 ≥ 100」** 을 그대로 쓸 수 있어야
   * 한다 — 신호등 문턱이 99 든 97 이든 상관없이.
   *
   *   gte   값 이상이어야 한다
   *   lte   값 이하여야 한다
   *   pass  신호등 기준을 통과 (문턱은 설정을 따른다)
   *   fail  신호등 기준에 미달
   *
   * `pass`/`fail` 을 남겨 둔 이유: 「정배열」처럼 **값이 뜻을 갖지 않는** 기준이
   * 있다. 그건 통과/미달로만 물을 수 있다.
   */
  op: "gte" | "lte" | "pass" | "fail";
  /** `gte`·`lte` 일 때 견줄 값. 그 외에는 안 쓴다 */
  value?: number;
  /** @deprecated 옛 저장분 호환 — `op` 가 없으면 이걸로 읽는다 */
  want?: boolean;
}

/** 옛 조건식(체크박스 시절)을 새 모양으로 — 저장해 둔 식이 죽지 않게 */
function normalizeCond(c: Cond): Cond {
  if (c.op) return c;
  return { key: c.key, op: c.want === false ? "fail" : "pass" };
}

/**
 * 조건 한 줄 — **기준 · 견줄 방법 · 값 · 다음 줄과의 연결자.**
 *
 * 벤티지: "어느 하나 조건을 선택하고 그 조건에 대한 상세 값을 넣은 다음에
 * 그 다음 조건을 넣고 그 사이에 AND 냐 OR 이냐 이렇게 할 수 있게끔 하는 거지.
 * 그 묶음이 하나의 조건식이 되는 거고."
 *
 * 예전엔 **그룹 안의 모든 조건이 같은 AND/OR 을 공유**했다. 그래서
 * 「A AND B OR C」를 못 썼다 — 그룹 하나는 전부 AND 이거나 전부 OR 이었다.
 * 자유도가 낮았다.
 */
export interface CondLine {
  /** 신호등 기준 키, 또는 조건 전용 필드 키(`q` 로 시작) */
  key: string;
  /**
   *   gte   잰 값이 `value` 이상
   *   lte   잰 값이 `value` 이하
   *   pass  신호등 기준을 통과 (문턱은 설정을 따른다)
   *   fail  신호등 기준에 미달
   *
   * `pass`/`fail` 을 남긴 이유: 「정배열」처럼 **값이 뜻을 갖지 않는** 기준이 있다.
   */
  op: "gte" | "lte" | "pass" | "fail";
  value?: number;
  /**
   * **다음 줄과 어떻게 잇나.** 마지막 줄에는 뜻이 없다.
   * 없으면 `and` 로 본다 — 조건을 더할 때 좁아지는 쪽이 예상에 가깝다.
   */
  join?: "and" | "or";
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
  /**
   * 조건식 — **위에서부터 차례로** 잇는다.
   *
   *   A AND B OR C  →  (A AND B) OR C
   *
   * 괄호는 없다. 증권사 조건검색도 대개 순차 평가이고, 괄호를 넣는 순간
   * **화면이 그 구조를 보여줄 방법**부터 만들어야 한다 — 안 보이는 괄호는
   * 안 쓰느니만 못하다. 필요해지면 그때 넣는다.
   */
  lines: CondLine[];
  /** @deprecated 옛 저장분(그룹 + 체크박스) — 있으면 `lines` 로 옮겨 읽는다 */
  groups?: { join: "and" | "or"; conds: { key: CheckKey; want?: boolean }[] }[];
}

/**
 * 옛 조건식을 새 모양으로 편다 — 저장해 둔 식이 죽지 않게.
 * 그룹 안은 그 그룹의 join 으로, 그룹끼리는 AND 로 이어 붙인다(옛 규칙 그대로).
 */
export function linesOf(q: CondQuery): CondLine[] {
  if (q.lines?.length) return q.lines;
  const out: CondLine[] = [];
  const gs = q.groups ?? [];
  gs.forEach((g, gi) => {
    g.conds.forEach((c, i) => {
      out.push({
        key: c.key,
        op: c.want === false ? "fail" : "pass",
        /* 그룹 안은 그 join, 그룹의 마지막 줄은 다음 그룹과 AND */
        join: i < g.conds.length - 1 ? g.join : gi < gs.length - 1 ? "and" : undefined,
      });
    });
  });
  return out;
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
    /* 조건식이 같은지는 **펼친 줄**로 본다 — 옛 형식이 섞여 있어도 맞춰진다 */
    const key = JSON.stringify(linesOf(query));
    const hit = list.find((p) => JSON.stringify(linesOf(p.query)) === key);
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
  /* 조건 전용 필드는 신호등 기준이 아니다 — 켜 봐야 없는 기준을 켜는 셈이다 */
  for (const l of linesOf(q)) if (!isOwnField(l.key)) s.add(l.key as CheckKey);
  return s;
}

/** 조건식에 쓰인 **조건 전용** 키 (분기 실적 등) */
function usedOwnKeys(q: CondQuery): Set<string> {
  const s = new Set<string>();
  for (const l of linesOf(q)) if (isOwnField(l.key)) s.add(l.key);
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

  /* 조건 전용 필드가 쓰였나 — 안 쓰였으면 그쪽 조회는 아예 안 나간다 */
  const ownKeys = usedOwnKeys(q);

  for (const c of pool) {
    try {
      const sig = await evaluateSignal(client, c.code, { config: cfg });
      /* 분기 실적 등 — 한 번 부르고 그 응답으로 다섯 필드를 다 낸다 */
      const own = await ownValues(c.code, ownKeys);
      /**
       * 조건 하나를 판정한다.
       *
       * ⚠️ **못 잰 것은 통과가 아니다.** 데이터가 없어서 null 인 것을 통과로 치면
       * 「영업이익 증가」 조건이 재무를 못 받은 종목을 다 걸러 온다.
       * 「모른다」와 「맞다」는 다른 말이다.
       */
      const judge = (l: CondLine): boolean => {
        /*
         * **조건 전용 필드** (2026-09-01) — 분기 실적처럼 신호등에 없는 것.
         * 신호등의 `profitGrowth` 는 연간 DART 라 8월에도 마지막 줄이 작년이다.
         */
        if (isOwnField(l.key)) {
          if (l.op === "pass" || l.op === "fail") {
            const f = own.flag.get(l.key);
            if (f === undefined) return false;
            return l.op === "pass" ? f : !f;
          }
          const v = own.num.get(l.key);
          if (v === undefined || !Number.isFinite(v) || l.value === undefined) return false;
          return l.op === "gte" ? v >= l.value : v <= l.value;
        }
        const hit = sig.checks.find((x) => x.key === l.key);
        if (!hit) return false;
        if (l.op === "pass") return hit.pass === true;
        if (l.op === "fail") return hit.pass === false;
        /* 값 비교 — 잰 값이 없으면 판정하지 않는다 */
        const v = hit.raw;
        if (v === undefined || !Number.isFinite(v) || l.value === undefined) return false;
        return l.op === "gte" ? v >= l.value : v <= l.value;
      };

      /**
       * 화면에 「무슨 조건에 걸렸나」를 적기 위한 이름.
       *
       * ⚠️ **신호등 라벨을 쓰지 않는다** (2026-09-01). 신호등의 이름은 채점표의
       * 항목 이름이라 「덩치 (클수록 안 움직인다)」처럼 채점 방향이 붙어 있고,
       * 조건식에서는 뜻이 없거나 방해가 된다. 그리고 단위가 없어서 「덩치 ≥ 3000」이
       * 3천억인지 3천만원인지 알 수가 없었다.
       */
      const labelOf = (l: CondLine): string => {
        const fd = condField(l.key);
        const nm = fd?.label ?? sig.checks.find((x) => x.key === l.key)?.label ?? l.key;
        if (l.op === "pass") return nm;
        if (l.op === "fail") return `${nm} 미달`;
        const unit = fd?.unit ? fd.unit : "";
        return `${nm} ${l.op === "gte" ? "≥" : "≤"} ${l.value?.toLocaleString("ko-KR")}${unit}`;
      };

      /*
       * **위에서부터 차례로 잇는다** — `A AND B OR C` = `(A AND B) OR C`.
       *
       * 괄호는 없다. 화면이 보여줄 수 없는 구조는 안 만든다 — 안 보이는 괄호는
       * 안 쓰느니만 못하다.
       *
       * ⚠️ **중간에 끊지 않는다.** AND 로 이미 거짓이 돼도 뒤에 OR 이 오면 살아날
       * 수 있다. 그리고 「무슨 조건에 걸렸나」를 적으려면 전부 재야 한다.
       */
      const matched: string[] = [];
      const lines = linesOf(q);
      let ok = false;
      lines.forEach((l, i) => {
        const hit = judge(l);
        if (hit) matched.push(labelOf(l));
        if (i === 0) {
          ok = hit;
          return;
        }
        ok = lines[i - 1].join === "or" ? ok || hit : ok && hit;
      });

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
