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
  /** 소속 그룹. 기존 데이터 호환을 위해 없으면 기본 그룹으로 본다 */
  group?: string;
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
    // 그룹 개념 도입 전 데이터는 group이 없으므로 기본 그룹으로 채운다
    cache = Array.isArray(parsed)
      ? (parsed as WatchItem[]).map((w) => ({ ...w, group: w.group || DEFAULT_GROUP }))
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
  group?: string;
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
      group: item.group?.trim() || DEFAULT_GROUP,
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
  patch: { memo?: string; addedPrice?: number; group?: string },
): Promise<WatchItem[]> {
  const items = await load();
  const next = items.map((w) =>
    w.code === code
      ? {
          ...w,
          memo: patch.memo ?? w.memo,
          addedPrice: patch.addedPrice ?? w.addedPrice,
          group: patch.group?.trim() || w.group || DEFAULT_GROUP,
        }
      : w,
  );
  await persist(next);
  return next;
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
  const used = new Set(items.map((w) => w.group || DEFAULT_GROUP));
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
  await persist(items.map((w) => (w.group === from ? { ...w, group: clean } : w)));
  return listGroups();
}

/** 그룹을 지우면 소속 종목은 기본 그룹으로 옮긴다 (종목이 사라지지 않게) */
export async function removeGroup(name: string): Promise<string[]> {
  if (name === DEFAULT_GROUP) throw new Error("기본 그룹은 삭제할 수 없습니다.");
  const groups = await loadGroups();
  await persistGroups(groups.filter((g) => g !== name));

  const items = await load();
  await persist(items.map((w) => (w.group === name ? { ...w, group: DEFAULT_GROUP } : w)));
  return listGroups();
}
