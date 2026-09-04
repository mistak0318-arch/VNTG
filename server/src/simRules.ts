import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 시뮬레이터 — **규칙의 모양과 창고** (2026-09-04).
 *
 * 벤티지: "특정 조건에 어떤 종목을 계속 굴려볼 수 있는 거지. 예를 들어 코스피 지수가
 * 빠지면 KODEX 200을 매수한다, 1억씩. 그리고 그다음 날 코스피가 올라갈 때 매도한다는
 * 매도 규칙도 만드는 거야. … 백테스트해서 돌려보고 실제 시장 흐름에서도 돌려보는
 * 실전 테스트 같은 거야. … 각각의 종목에 조건 걸고 정지·진행 이렇게 할 수 있게,
 * 각각의 조건의 성과도 볼 수 있는."
 *
 * ## 조건을 왜 이만큼만 두나
 *
 * 「무엇이든 쓸 수 있는 식」을 만들면 화면이 프로그래밍이 되고, 그러면 아무도 안 쓴다.
 * 여기는 **비교 한 줄**이 최소 단위다: `[무엇]의 [무엇이] [부등호] [값]`.
 * 여러 줄은 **모두 맞아야** 한다(AND). 「또는」은 없다 — 필요하면 규칙을 하나 더 만든다.
 * 규칙이 둘이면 성과도 따로 나와서 오히려 무엇이 통했는지가 보인다.
 *
 * ## 종가로 판정하고 종가에 산다
 *
 * ⚠️ 이 가정은 **현실에서 아슬아슬하다.** 종가를 보고 그 종가에 사는 것은 실제로는
 * 동시호가 안에서만 가능하고, 늘 되는 것도 아니다. 그래도 이렇게 두는 이유는
 * **판정과 체결이 같은 값이라야 성적이 규칙을 재는 것**이 되기 때문이다. 다른 값에
 * 체결시키면 성적에 슬리피지 추정이 섞여, 규칙이 좋은 건지 추정이 좋은 건지 못 가른다.
 * 이 한계는 화면에도 적는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "simRules.json");

/** 비교할 대상 */
export type CondSrc =
  /** 규칙이 지정한 그 종목 */
  | "stock"
  /** 바깥 변수 — `simSeries.SERIES` 의 key */
  | "series";

/** 무엇을 재나 */
export type CondMetric =
  /** 전일 대비 등락률(%) */
  | "chg1"
  /** N일 전 대비 등락률(%) */
  | "chgN"
  /** 종가 그 자체 */
  | "close"
  /** N일 이동평균 대비 몇 %(양수면 위) */
  | "vsMa";

export type CondOp = "lt" | "lte" | "gt" | "gte";

export interface Cond {
  src: CondSrc;
  /** `src:"series"` 일 때만 — SERIES 의 key */
  key?: string;
  metric: CondMetric;
  op: CondOp;
  value: number;
  /** `chgN`·`vsMa` 가 쓰는 날 수 */
  n?: number;
}

export interface SimRule {
  id: string;
  name: string;
  /** 굴릴 종목 */
  code: string;
  stockName: string;
  /** 시드 — 백테스트와 실전이 같은 값으로 시작한다 */
  seed: number;
  /** 한 번 살 때 얼마 (원). 예수금이 모자라면 남은 만큼만 */
  buyAmount: number;
  /** 사는 조건 — **모두** 맞아야 산다 */
  buy: Cond[];
  /** 파는 조건 — **모두** 맞으면 전량 판다 */
  sell: Cond[];
  /**
   * 이미 들고 있어도 또 살까. 끄면 한 자리만 잡고 팔 때까지 기다린다 —
   * 「빠지면 산다」류는 켜 두면 계속 물타기가 된다.
   */
  addOn: boolean;
  /** 진행/정지 — 실전 진행에만 걸린다(백테스트는 정지 중이어도 돌릴 수 있다) */
  enabled: boolean;
  createdAt: string;
  note?: string;
}

interface Store {
  rules: SimRule[];
}

let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf8")) as Partial<Store>;
    cache = { rules: Array.isArray(raw.rules) ? raw.rules : [] };
  } catch {
    cache = { rules: [] };
  }
  return cache;
}

async function save(s: Store): Promise<void> {
  cache = s;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s, null, 2), "utf8");
}

export async function listRules(): Promise<SimRule[]> {
  return (await load()).rules;
}

export async function getRule(id: string): Promise<SimRule | null> {
  return (await load()).rules.find((r) => r.id === id) ?? null;
}

const newId = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 값의 범위는 **여기서** 막는다 — 화면을 믿지 않는다 */
function clean(input: Partial<SimRule>, base?: SimRule): SimRule {
  const conds = (list: unknown): Cond[] =>
    (Array.isArray(list) ? list : [])
      .map((c) => c as Partial<Cond>)
      .filter((c) => c && typeof c.metric === "string")
      .slice(0, 6)
      .map((c) => ({
        src: c.src === "series" ? "series" : "stock",
        key: typeof c.key === "string" ? c.key : undefined,
        metric: (["chg1", "chgN", "close", "vsMa"] as CondMetric[]).includes(c.metric as CondMetric)
          ? (c.metric as CondMetric)
          : "chg1",
        op: (["lt", "lte", "gt", "gte"] as CondOp[]).includes(c.op as CondOp) ? (c.op as CondOp) : "lt",
        value: Number.isFinite(Number(c.value)) ? Number(c.value) : 0,
        n: Number.isFinite(Number(c.n)) ? Math.max(1, Math.min(250, Math.round(Number(c.n)))) : undefined,
      }));

  const num = (v: unknown, dflt: number, min: number, max: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : dflt;
  };

  return {
    id: base?.id ?? newId(),
    name: String(input.name ?? base?.name ?? "이름 없는 규칙").slice(0, 40),
    code: String(input.code ?? base?.code ?? "").replace(/\D/g, "").slice(0, 6),
    stockName: String(input.stockName ?? base?.stockName ?? "").slice(0, 40),
    seed: num(input.seed ?? base?.seed, 100_000_000, 1_000_000, 100_000_000_000),
    buyAmount: num(input.buyAmount ?? base?.buyAmount, 10_000_000, 100_000, 100_000_000_000),
    buy: input.buy !== undefined ? conds(input.buy) : (base?.buy ?? []),
    sell: input.sell !== undefined ? conds(input.sell) : (base?.sell ?? []),
    addOn: input.addOn !== undefined ? Boolean(input.addOn) : (base?.addOn ?? false),
    enabled: input.enabled !== undefined ? Boolean(input.enabled) : (base?.enabled ?? false),
    createdAt: base?.createdAt ?? new Date().toISOString(),
    note: typeof input.note === "string" ? input.note.slice(0, 300) : base?.note,
  };
}

/**
 * **저장하지 않고** 규칙 하나를 만든다 — 만들다 말고 시험해 볼 때.
 * 창고에 안 넣는 이유: 시험한 것이 전부 목록에 쌓이면 「진행 중인 규칙」이 뭔지 흐려진다.
 */
export function draftRule(input: Partial<SimRule>): SimRule {
  return clean(input);
}

export async function upsertRule(input: Partial<SimRule>): Promise<SimRule> {
  const s = await load();
  const idx = input.id ? s.rules.findIndex((r) => r.id === input.id) : -1;
  const next = clean(input, idx >= 0 ? s.rules[idx] : undefined);
  if (idx >= 0) s.rules[idx] = next;
  else s.rules.unshift(next);
  await save(s);
  return next;
}

export async function removeRule(id: string): Promise<boolean> {
  const s = await load();
  const before = s.rules.length;
  s.rules = s.rules.filter((r) => r.id !== id);
  if (s.rules.length === before) return false;
  await save(s);
  return true;
}
