import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/src/watchlist.ts -> server/data/watchlist.json
const DATA_FILE = resolve(__dirname, "..", "data", "watchlist.json");

export interface WatchItem {
  code: string; // 6자리 종목코드
  name: string;
  addedAt: string; // ISO 8601
  addedPrice: number; // 편입가
  memo: string;
  /**
   * @deprecated 한 그룹만 담던 옛 필드. 읽기만 하고 새로 쓰지 않는다.
   * groups 로 옮기는 마이그레이션에만 쓴다.
   */
  group?: string;
  /**
   * 소속 그룹들 — **한 종목이 여러 그룹에 담긴다.**
   *
   * 한 종목은 성격이 하나가 아니다. 삼성전자는 반도체이면서 대형주이고 배당주다.
   * 그걸 한 그룹에만 넣게 하면 어느 관점으로 볼지를 담을 때 미리 정해야 하는데,
   * 그 결정은 담는 시점에 할 수 있는 게 아니다.
   */
  groups: string[];
}

export const DEFAULT_GROUP = "기본";

/** 그룹 이름 목록 (종목이 하나도 없는 빈 그룹도 유지하기 위해 따로 저장) */
const GROUPS_FILE = resolve(__dirname, "..", "data", "watchGroups.json");

let cache: WatchItem[] | null = null;

async function load(): Promise<WatchItem[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    /*
     * 두 번의 구조 변경을 다 받아 준다.
     *   group 없음        → 기본 그룹 (그룹 개념 도입 전)
     *   group 만 있음     → groups 로 옮긴다 (다중 그룹 도입 전)
     * 옛 파일을 그대로 열어도 종목이 사라지지 않아야 한다.
     */
    cache = Array.isArray(parsed)
      ? (parsed as WatchItem[]).map((w) => ({
          ...w,
          groups:
            Array.isArray(w.groups) && w.groups.length > 0
              ? w.groups
              : [w.group?.trim() || DEFAULT_GROUP],
        }))
      : [];
  } catch {
    // 파일이 아직 없으면 빈 목록으로 시작
    cache = [];
  }
  return cache;
}

async function persist(items: WatchItem[]): Promise<void> {
  cache = items;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(items, null, 2), "utf-8");
}

export async function listWatchlist(): Promise<WatchItem[]> {
  return [...(await load())];
}

export async function addWatchItem(item: {
  code: string;
  name: string;
  addedPrice: number;
  memo?: string;
  /** 하나만 줘도 되고 여러 개를 줘도 된다 */
  group?: string;
  groups?: string[];
}): Promise<WatchItem[]> {
  const items = await load();
  if (items.some((w) => w.code === item.code)) {
    return [...items]; // 이미 있으면 그대로 둔다 (편입가를 덮어쓰지 않음)
  }
  const next: WatchItem[] = [
    ...items,
    {
      code: item.code,
      name: item.name,
      addedAt: new Date().toISOString(),
      addedPrice: item.addedPrice,
      memo: item.memo ?? "",
      groups: normalizeGroups(item.groups ?? (item.group ? [item.group] : [])),
    },
  ];
  await persist(next);
  return next;
}

export async function removeWatchItem(code: string): Promise<WatchItem[]> {
  const items = await load();
  const next = items.filter((w) => w.code !== code);
  await persist(next);
  return next;
}

export async function updateWatchItem(
  code: string,
  patch: { memo?: string; addedPrice?: number; group?: string; groups?: string[] },
): Promise<WatchItem[]> {
  const items = await load();
  const next = items.map((w) =>
    w.code === code
      ? {
          ...w,
          memo: patch.memo ?? w.memo,
          addedPrice: patch.addedPrice ?? w.addedPrice,
          groups:
            patch.groups !== undefined
              ? normalizeGroups(patch.groups)
              : patch.group !== undefined
                ? normalizeGroups([patch.group])
                : w.groups,
        }
      : w,
  );
  await persist(next);
  return next;
}

/**
 * 그룹 하나를 넣거나 뺀다.
 *
 * 표에서 칩 하나를 눌러 토글하는 자리에 쓴다 — 전체 목록을 다시 보내게 하면
 * 화면이 최신 상태를 들고 있어야 해서, 두 창을 띄워 놓으면 서로 덮어쓴다.
 */
export async function toggleWatchGroup(code: string, group: string): Promise<WatchItem[]> {
  const g = group.trim();
  if (!g) return load();
  const items = await load();
  const next = items.map((w) => {
    if (w.code !== code) return w;
    const has = w.groups.includes(g);
    return { ...w, groups: normalizeGroups(has ? w.groups.filter((x) => x !== g) : [...w.groups, g]) };
  });
  await persist(next);
  return next;
}

/** 빈 배열이면 기본 그룹으로 — 어디에도 안 속한 종목은 목록에서 사라진다 */
function normalizeGroups(input: string[]): string[] {
  const out = [...new Set(input.map((g) => g.trim()).filter(Boolean))];
  return out.length > 0 ? out : [DEFAULT_GROUP];
}


// ---------------------------------------------------------------- 그룹 관리

let groupCache: string[] | null = null;

async function loadGroups(): Promise<string[]> {
  if (groupCache) return groupCache;
  try {
    const raw = await readFile(GROUPS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    groupCache = Array.isArray(parsed) ? (parsed as string[]) : [DEFAULT_GROUP];
  } catch {
    groupCache = [DEFAULT_GROUP];
  }
  return groupCache;
}

async function persistGroups(groups: string[]): Promise<void> {
  groupCache = groups;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(GROUPS_FILE), { recursive: true });
  await writeFile(GROUPS_FILE, JSON.stringify(groups, null, 2), "utf-8");
}

/** 저장된 그룹 + 실제 종목이 쓰고 있는 그룹을 합쳐서 반환 (기본 그룹은 항상 맨 앞) */
export async function listGroups(): Promise<string[]> {
  const [groups, items] = await Promise.all([loadGroups(), load()]);
  const used = new Set(items.flatMap((w) => w.groups));
  const merged = new Set<string>([DEFAULT_GROUP, ...groups, ...used]);
  return [...merged];
}

export async function addGroup(name: string): Promise<string[]> {
  const clean = name.trim();
  if (!clean) throw new Error("그룹 이름이 비어 있습니다.");
  const groups = await loadGroups();
  if (!groups.includes(clean)) await persistGroups([...groups, clean]);
  return listGroups();
}

export async function renameGroup(from: string, to: string): Promise<string[]> {
  const clean = to.trim();
  if (!clean) throw new Error("그룹 이름이 비어 있습니다.");
  if (from === DEFAULT_GROUP) throw new Error("기본 그룹은 이름을 바꿀 수 없습니다.");

  const groups = await loadGroups();
  await persistGroups(groups.map((g) => (g === from ? clean : g)));

  // 그 그룹에 속한 종목도 같이 옮긴다
  const items = await load();
  await persist(
    items.map((w) => ({ ...w, groups: normalizeGroups(w.groups.map((g) => (g === from ? clean : g))) })),
  );
  return listGroups();
}

/**
 * 그룹 순서 바꾸기.
 *
 * 그룹이 늘면 자주 보는 게 뒤로 밀린다 — 만든 순서대로 늘어서기 때문이다.
 * 화면에서 끌어 옮길 수 있어야 하는데, **순서는 저장돼야** 다음에 열어도 그대로다.
 *
 * 화면이 보낸 순서를 그대로 믿지 않는다. 화면이 모르는 그룹(다른 창에서 방금 만든 것)이
 * 있을 수 있으므로 **보내온 것 먼저, 빠진 것은 뒤에** 붙인다 — 그래야 그룹이 사라지지 않는다.
 * 기본 그룹은 늘 맨 앞이다.
 */
export async function reorderGroups(order: string[]): Promise<string[]> {
  const current = await listGroups();
  const known = new Set(current);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const g of order) {
    if (g === DEFAULT_GROUP || !known.has(g) || seen.has(g)) continue;
    seen.add(g);
    next.push(g);
  }
  // 화면이 몰랐던 그룹은 뒤에 남긴다
  for (const g of current) {
    if (g === DEFAULT_GROUP || seen.has(g)) continue;
    next.push(g);
  }
  await persistGroups(next);
  return listGroups();
}

/** 그룹을 지우면 소속 종목은 기본 그룹으로 옮긴다 (종목이 사라지지 않게) */
export async function removeGroup(name: string): Promise<string[]> {
  if (name === DEFAULT_GROUP) throw new Error("기본 그룹은 삭제할 수 없습니다.");
  const groups = await loadGroups();
  await persistGroups(groups.filter((g) => g !== name));

  const items = await load();
  // 그룹을 지우면 그 그룹만 빠진다. 다른 그룹에도 담겨 있으면 종목은 남는다
  await persist(
    items.map((w) => ({ ...w, groups: normalizeGroups(w.groups.filter((g) => g !== name)) })),
  );
  return listGroups();
}
