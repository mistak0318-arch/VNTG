import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    return [];
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
function evaluate(theme: CustomTheme, byCode: Map<string, SnapshotStock>): EvaluatedTheme {
  const stocks = theme.codes.map((code) => {
    const s = byCode.get(code);
    return {
      code,
      name: s?.name ?? code,
      changeRate: s?.changeRate ?? 0,
      marketCap: s?.marketCap ?? null,
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
): Promise<{ themes: EvaluatedTheme[]; snapshotAt: number; coverage: string }> {
  const [themes, snap] = await Promise.all([load(), getMarketSnapshot(client, force)]);
  const evaluated = themes
    .map((t) => evaluate(t, snap.byCode))
    .sort((a, b) => (b.changeRate ?? -999) - (a.changeRate ?? -999));

  return {
    themes: evaluated,
    snapshotAt: snap.at,
    coverage: `${snap.totalSectors - snap.failedSectors}/${snap.totalSectors} 업종 · ${snap.byCode.size}종목`,
  };
}

/**
 * AI 리포트에 넣을 형태.
 * 키움 테마보다 **앞에** 놓는다 — 내 관점으로 시장을 보게 하는 게 이 기능의 목적이다.
 */
export function toCustomThemeDigest(themes: EvaluatedTheme[]): string {
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

  return `\n[내가 만든 테마 — 사용자가 직접 정의한 관점이므로 키움 테마보다 우선해서 다룰 것]\n${lines.join("\n")}`;
}
