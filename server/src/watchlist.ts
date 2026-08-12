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
}

let cache: WatchItem[] | null = null;

async function load(): Promise<WatchItem[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    cache = Array.isArray(parsed) ? (parsed as WatchItem[]) : [];
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
  patch: { memo?: string; addedPrice?: number },
): Promise<WatchItem[]> {
  const items = await load();
  const next = items.map((w) =>
    w.code === code
      ? {
          ...w,
          memo: patch.memo ?? w.memo,
          addedPrice: patch.addedPrice ?? w.addedPrice,
        }
      : w,
  );
  await persist(next);
  return next;
}
