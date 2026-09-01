import { mkdir, readFile, writeFile } from "node:fs/promises";
import { getStockIndex } from "./stockListCache.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { bareCode, getMarketSnapshot, type SnapshotStock } from "./marketSnapshot.js";

/**
 * 수동 테마 (내가 만드는 테마).
 *
 * 키움 테마 분류는 시장의 현재 관심사를 못 따라간다 — 새로 뜨는 주제가 늦게 들어오고,
 * 분류가 너무 넓거나(반도체) 너무 좁다(FPCB). 무엇보다 **내가 보는 관점과 다르다.**
 *
 * 등락률은 **시가총액 가중평균**으로 낸다. 단순평균은 소형주 한 종목이 테마 전체를
 * 흔들어서 "이 테마가 오늘 강했나"를 잘못 말하게 된다.
 * 시총을 모르는 종목은 가중치에서 빼되 구성종목 수에는 남긴다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "customThemes.json");

export interface CustomTheme {
  id: string;
  name: string;
  memo: string;
  /** 6자리 종목코드 */
  codes: string[];
  color: string;
  createdAt: string;
  updatedAt?: string;
  /**
   * 어디서 온 테마인가.
   *
   * manual    — 내가 직접 만든 것. 이게 이 기능의 본체다.
   * infostock — 인포스탁 테마표에서 옮겨 담은 것. 출발점으로는 좋지만 내 관점은 아니다.
   *
   * 구분해 두는 이유는 두 가지다. 화면에서 섞이면 내 테마를 못 찾고,
   * AI 리포트에 수십 개가 통째로 들어가면 "내가 직접 정의한 관점"이라는 무게가 사라진다.
   */
  source?: "manual" | "infostock";
}

/** 화면·리포트에서 쓰는 계산된 형태 */
export interface EvaluatedTheme extends CustomTheme {
  /** 시총 가중평균 등락률(%) */
  changeRate: number | null;
  /** 단순평균 — 가중평균과 크게 다르면 대형주가 끌고 있다는 뜻이라 같이 보여준다 */
  simpleRate: number | null;
  stocks: {
    code: string;
    name: string;
    changeRate: number;
    marketCap: number | null;
    /**
     * 오늘 거래대금(억원) — 2026-08-30.
     *
     * 이게 없어서 **내 테마를 거래대금으로 볼 수 없었다.** 시총은 「이 판이 얼마나
     * 큰가」이고 거래대금은 「오늘 돈이 도는가」인데, 뒤쪽이 오히려 더 자주 필요하다.
     * 스냅샷에 이미 있는 값이라 실어 보내기만 하면 된다(조회 0회).
     */
    tradeValue: number | null;
    /** 이 종목이 테마 등락률에 기여한 비중(%) */
    weight: number | null;
    found: boolean;
  }[];
  risingCount: number;
  fallingCount: number;
  /** 스냅샷에서 못 찾은 종목 수 (상장폐지·코드 오류) */
  missing: number;
}

const PALETTE = ["#f5c542", "#4d9de0", "#35c46a", "#e0655b", "#a97bd6", "#4dc0c0"];

function newId(): string {
  return `ct_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

async function load(): Promise<CustomTheme[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf-8")) as CustomTheme[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    /*
     * **씨앗에서 시작한다** (2026-09-01).
     *
     * ⚠️ 실파일(`customThemes.json`)은 이제 추적하지 않는다. 서버가 등락률을
     * 갱신하며 계속 쓰는 파일이라, 추적하면 배포 때마다 충돌한다 — 실제로
     * 미니PC 배포가 그것 때문에 막혔다:
     *
     *   error: Your local changes to the following files would be overwritten
     *          by merge: server/data/customThemes.json
     *
     * 대신 **씨앗**(`customThemes.seed.json`)만 보낸다. 새 PC 에서 실파일이 없으면
     * 여기서 시작하고, 그 뒤로는 각자의 것이 된다 — 해외 관심종목과 같은 규칙이다.
     */
    try {
      const seed = JSON.parse(
        await readFile(join(DATA_DIR, "customThemes.seed.json"), "utf-8"),
      ) as CustomTheme[];
      return Array.isArray(seed) ? seed : [];
    } catch {
      return [];
    }
  }
}

async function persist(items: CustomTheme[]): Promise<CustomTheme[]> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(items, null, 2), "utf-8");
  return items;
}

/** 종목코드 정리 — `_AL` 제거, 6자리만, 중복 제거, 순서 유지 */
function cleanCodes(codes: unknown): string[] {
  if (!Array.isArray(codes)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const c of codes) {
    const code = bareCode(String(c ?? ""));
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

// ---------------------------------------------------------------- CRUD

export async function listThemes(): Promise<CustomTheme[]> {
  return load();
}

export async function createTheme(input: {
  name: string;
  memo?: string;
  codes?: string[];
  color?: string;
  source?: "manual" | "infostock";
}): Promise<CustomTheme[]> {
  const name = String(input.name ?? "").trim();
  if (!name) throw new Error("테마 이름을 입력하세요.");

  const items = await load();
  if (items.some((t) => t.name === name)) throw new Error("같은 이름의 테마가 이미 있습니다.");

  items.push({
    id: newId(),
    name,
    memo: String(input.memo ?? "").trim(),
    codes: cleanCodes(input.codes),
    // 색을 안 주면 이미 쓰지 않은 색을 먼저 고른다
    color:
      input.color ??
      PALETTE.find((c) => !items.some((t) => t.color === c)) ??
      PALETTE[items.length % PALETTE.length],
    createdAt: new Date().toISOString(),
    source: input.source ?? "manual",
  });
  return persist(items);
}

export async function updateTheme(
  id: string,
  patch: Partial<Pick<CustomTheme, "name" | "memo" | "codes" | "color">>,
): Promise<CustomTheme[]> {
  const items = await load();
  const idx = items.findIndex((t) => t.id === id);
  if (idx < 0) throw new Error("테마를 찾을 수 없습니다.");

  const name = patch.name !== undefined ? String(patch.name).trim() : items[idx].name;
  if (!name) throw new Error("테마 이름을 입력하세요.");
  if (items.some((t, i) => i !== idx && t.name === name)) {
    throw new Error("같은 이름의 테마가 이미 있습니다.");
  }

  items[idx] = {
    ...items[idx],
    name,
    memo: patch.memo !== undefined ? String(patch.memo).trim() : items[idx].memo,
    codes: patch.codes !== undefined ? cleanCodes(patch.codes) : items[idx].codes,
    color: patch.color ?? items[idx].color,
    updatedAt: new Date().toISOString(),
  };
  return persist(items);
}

export async function removeTheme(id: string): Promise<CustomTheme[]> {
  const items = await load();
  return persist(items.filter((t) => t.id !== id));
}

/** 종목 추가/제거 — 화면에서 한 종목씩 다룰 때 */
export async function toggleStock(id: string, code: string): Promise<CustomTheme[]> {
  const items = await load();
  const t = items.find((x) => x.id === id);
  if (!t) throw new Error("테마를 찾을 수 없습니다.");
  const c = bareCode(code);
  t.codes = t.codes.includes(c) ? t.codes.filter((x) => x !== c) : [...t.codes, c];
  t.updatedAt = new Date().toISOString();
  return persist(items);
}

// ---------------------------------------------------------------- 계산

/**
 * 시가총액 가중평균 등락률.
 *
 * 단순평균을 쓰면 시총 500억짜리가 +20% 갔을 때 테마가 통째로 올라간 것처럼 보인다.
 * 실제로 돈이 어디로 갔는지는 시총 가중이 맞다.
 */
function evaluate(
  theme: CustomTheme,
  byCode: Map<string, SnapshotStock>,
  /**
   * 종목코드 → 이름. **스냅샷이 못 담는 종목의 이름을 메운다.**
   *
   * 스냅샷은 **업종 구성종목을 모아** 만드는데, 키움이 일부 업종코드에 구성종목을 안 주고
   * ETF·ETN·리츠는 업종에 아예 안 잡힌다. 그래서 내 테마에 넣은 종목 일부가 스냅샷에
   * 없었고, 그때 이름 자리에 **종목코드가 그대로 찍혔다** — 「종목코드를 못 찾는다」의 정체다.
   *
   * 종목 목록(`ka10099`)은 상장 종목을 다 갖고 있고 하루 캐싱되므로 이름은 여기서 채운다.
   * 등락률까지는 못 채운다(그건 시세라 따로 받아야 한다) — 그래서 가중평균에서는 빠진다.
   */
  nameOf?: Map<string, string>,
): EvaluatedTheme {
  const stocks = theme.codes.map((code) => {
    const s = byCode.get(code);
    return {
      code,
      name: s?.name ?? nameOf?.get(code) ?? code,
      changeRate: s?.changeRate ?? 0,
      marketCap: s?.marketCap ?? null,
      tradeValue: s?.tradeValue ?? null,
      weight: null as number | null,
      found: Boolean(s),
    };
  });

  const found = stocks.filter((s) => s.found);
  const weighted = found.filter((s) => (s.marketCap ?? 0) > 0);
  const totalCap = weighted.reduce((sum, s) => sum + (s.marketCap ?? 0), 0);

  for (const s of weighted) {
    s.weight = totalCap > 0 ? ((s.marketCap ?? 0) / totalCap) * 100 : null;
  }

  const changeRate =
    totalCap > 0
      ? weighted.reduce((sum, s) => sum + s.changeRate * ((s.marketCap ?? 0) / totalCap), 0)
      : null;
  const simpleRate =
    found.length > 0 ? found.reduce((sum, s) => sum + s.changeRate, 0) / found.length : null;

  return {
    ...theme,
    changeRate,
    simpleRate,
    // 비중이 큰 종목이 위로 오게 — 무엇이 테마를 끌었는지 바로 보이도록
    stocks: stocks.sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)),
    risingCount: found.filter((s) => s.changeRate > 0).length,
    fallingCount: found.filter((s) => s.changeRate < 0).length,
    missing: stocks.length - found.length,
  };
}

export async function evaluateThemes(
  client: KiwoomClient,
  force = false,
): Promise<{ themes: EvaluatedTheme[]; snapshotAt: number; coverage: string; traded: boolean }> {
  const [themes, snap] = await Promise.all([load(), getMarketSnapshot(client, force)]);
  /*
   * 스냅샷이 못 담은 종목의 **이름만이라도** 채운다. 하루 캐싱된 목록이라 조회가 안 는다.
   * 실패해도 예전처럼 코드가 찍힐 뿐이라 화면은 선다.
   */
  const nameOf = await getStockIndex(client)
    .then((idx) => new Map([...idx].map(([code, e]) => [code, e.name])))
    .catch(() => undefined);
  const evaluated = themes
    .map((t) => evaluate(t, snap.byCode, nameOf))
    .sort((a, b) => (b.changeRate ?? -999) - (a.changeRate ?? -999));

  return {
    themes: evaluated,
    snapshotAt: snap.at,
    coverage: `${snap.totalSectors - snap.failedSectors}/${snap.totalSectors} 업종 · ${snap.byCode.size}종목`,
    // 개장 전이면 이 등락률은 직전 거래일 종가 기준이다 — 리포트가 그걸 밝혀야 한다
    traded: snap.traded,
  };
}

/**
 * AI 리포트에 넣을 형태.
 * 키움 테마보다 **앞에** 놓는다 — 내 관점으로 시장을 보게 하는 게 이 기능의 목적이다.
 */
export function toCustomThemeDigest(
  themes: EvaluatedTheme[],
  opts: { previousClose?: boolean } = {},
): string {
  const usable = themes.filter((t) => t.changeRate !== null && t.stocks.length > 0);
  if (usable.length === 0) return "";

  /**
   * 인포스탁에서 옮겨온 테마는 수십 개라 전부 넣으면 리포트가 테마 나열로 끝난다.
   * 내가 만든 테마는 전부 넣고, 옮겨온 것은 그날 움직임이 컸던 쪽만 추린다
   * (오른 것만 보면 빠진 곳을 놓치므로 위아래 양쪽에서).
   */
  const mine = usable.filter((t) => (t.source ?? "manual") === "manual");
  const rest = usable.filter((t) => (t.source ?? "manual") !== "manual");
  const picked = [...mine, ...rest.slice(0, 5), ...rest.slice(-3)];

  // 위아래에서 뽑다 보면 테마가 적을 때 겹친다
  const seen = new Set<string>();
  const selected = picked.filter((t) => !seen.has(t.id) && seen.add(t.id));

  const lines = selected.map((t) => {
    const rate = `${t.changeRate! > 0 ? "+" : ""}${t.changeRate!.toFixed(2)}%`;
    // 비중 상위 3종목을 근거로 붙인다
    const lead = t.stocks
      .filter((s) => s.found)
      .slice(0, 3)
      .map((s) => `${s.name} ${s.changeRate > 0 ? "+" : ""}${s.changeRate.toFixed(1)}%`)
      .join(", ");
    // 옮겨온 테마가 "내가 만든 것"인 척하면 AI가 무게를 잘못 준다
    const src = (t.source ?? "manual") === "manual" ? "" : " [출처: 인포스탁]";
    const memo = t.memo && (t.source ?? "manual") === "manual" ? ` — ${t.memo}` : "";
    return `${t.name} ${rate} (▲${t.risingCount}/▼${t.fallingCount}) ${lead}${src}${memo}`;
  });

  /*
   * 개장 전에는 등락률이 직전 거래일 종가 기준이다. 그 사실을 헤더에 못박지 않으면
   * 모델이 "오늘 반도체 테마가 +3% 올랐다"고 써 버린다 — 장이 열리지도 않았는데.
   */
  const header = opts.previousClose
    ? "[내가 만든 테마 — **직전 거래일 종가 기준**. 오늘 값이 아니므로 인용할 때 반드시 '전일'이라고 밝힐 것. 사용자가 직접 정의한 관점이므로 키움 테마보다 우선해서 다룰 것]"
    : "[내가 만든 테마 — 사용자가 직접 정의한 관점이므로 키움 테마보다 우선해서 다룰 것]";

  return `\n${header}\n${lines.join("\n")}`;
}

/* ------------------------------------------------------------------ */
/* 태그 — 종목 쪽에서 본 같은 데이터 (2026-09-01)                        */
/* ------------------------------------------------------------------ */

/**
 * **「내 테마」를 종목 쪽에서 보면 태그다.**
 *
 * 벤티지: "내 테마라는 이름을 태그라는 이름으로 바꿀까? 각 종목 상세에 메모
 * 적잖아. 그 위에 #태그 칸 하나 두어서 태그를 적는 거지. 그 태그가 자동으로
 * 그룹이 돼서 태그 그룹으로 들어가고 (마치 테마를 내가 태그로 만드는 거야).
 * #반도 이런 식으로 쓰면 비슷한 태그 목록 보여줘서 바로 추가하게 하고."
 *
 * ## 저장소를 새로 만들지 않는다
 *
 * `CustomTheme` 이 이미 `name` + `codes` 다 — **그게 곧 태그다.** 태그 이름이
 * 테마 이름이고, 그 태그가 붙은 종목이 구성종목이다. 새 저장소를 만들면 같은
 * 것이 두 벌이 되고, 한쪽에서 지운 게 다른 쪽에 남는다.
 *
 * 바뀌는 것은 **부르는 이름과 들어가는 문**뿐이다. 여태 「테마를 만들고 종목을
 * 넣는」 길만 있었는데, 이제 **종목을 보다가 태그를 붙이는** 길이 생긴다.
 *
 * ## 왜 종목 쪽 입력이 중요한가
 *
 * 종목을 보다가 「이건 로봇이네」 싶을 때 그 자리에서 붙일 수 있어야 한다.
 * 별도 화면으로 가야 하면 안 하게 된다 — 실제로 28개를 만든 뒤로 잘 안 늘었다.
 */

/** 이 종목에 붙은 태그 이름들 */
export async function tagsOf(code: string): Promise<string[]> {
  const bare = bareCode(code);
  return (await listThemes())
    .filter((t) => t.codes.includes(bare))
    .map((t) => t.name);
}

/**
 * 태그 이름 후보 — `#반도` 를 치면 「반도체」·「반도체 소부장」을 돌려준다.
 *
 * ⚠️ **이게 없으면 태그가 부서진다.** 「반도체」·「반도체장비」·「반도체_소부장」이
 * 따로 생겨서 같은 뜻의 그룹이 셋이 된다. 태그 체계가 망하는 건 대부분 이것
 * 때문이라, 자동완성은 곁다리가 아니라 **본체**다.
 *
 * 종목 수가 많은 것부터 준다 — 이미 많이 쓴 태그가 그 사람의 분류다.
 */
export async function suggestTags(
  q: string,
  limit = 8,
): Promise<{ name: string; count: number }[]> {
  const needle = q.replace(/^#/, "").trim().toLowerCase();
  const all = (await listThemes()).map((t) => ({ name: t.name, count: t.codes.length }));
  const hit = needle
    ? all.filter((t) => t.name.toLowerCase().includes(needle))
    : all;
  return hit.sort((a, b) => b.count - a.count).slice(0, limit);
}

/**
 * 종목에 태그를 붙인다 — **없는 태그면 만든다.**
 *
 * 「태그를 먼저 만들고 종목을 넣으세요」는 쓰는 사람의 흐름이 아니다. 종목을
 * 보다가 이름을 치면 그걸로 끝나야 한다.
 */
export async function addTag(code: string, name: string): Promise<CustomTheme[]> {
  const clean = name.replace(/^#/, "").trim();
  if (!clean) throw new Error("태그 이름이 비어 있습니다");
  const bare = bareCode(code);
  const list = await listThemes();
  const had = list.find((t) => t.name === clean);
  if (had) {
    if (had.codes.includes(bare)) return list;
    return updateTheme(had.id, { codes: [...had.codes, bare] });
  }
  return createTheme({ name: clean, codes: [bare] });
}

/** 종목에서 태그를 뗀다. 그 태그가 비면 **지우지 않는다** — 이름은 남겨 둔다 */
export async function removeTag(code: string, name: string): Promise<CustomTheme[]> {
  const bare = bareCode(code);
  const list = await listThemes();
  const had = list.find((t) => t.name === name.replace(/^#/, "").trim());
  if (!had || !had.codes.includes(bare)) return list;
  return updateTheme(had.id, { codes: had.codes.filter((c) => c !== bare) });
}
