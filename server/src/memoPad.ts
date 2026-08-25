import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, "..", "data", "memoPad.json");

/**
 * 메모장 (2026-08-26 — 「메모장 + 일기장 같은 거」).
 *
 * 복기 노트(매매 복기)·종목 메모(종목에 붙는 짧은 글)와 **다른 자리**다 —
 * 어디에도 안 붙는 생각을 적는 곳. 추적 관찰 중인 종목, 추세 가설, 시장 일기,
 * 배운 것 같은 **매매로 아직 안 간 글**이 갈 곳이 없어서 만들었다.
 *
 * 찾기가 핵심이다: 태그 + 제목·본문 검색. 적기만 하고 못 찾는 메모장은
 * 안 쓰게 된다(다들 그렇게 버려진다).
 */

export interface MemoEntry {
  id: string;
  /** 작성 시각 (ISO) */
  at: string;
  /** 마지막 수정 시각 (ISO) */
  updatedAt: string;
  title: string;
  body: string;
  /** 자유 태그 — 화면이 기본 갈래(추적관찰·추세 등)를 제안한다 */
  tags: string[];
  /** 고정 — 목록 맨 위 */
  pinned: boolean;
}

let cache: MemoEntry[] | null = null;

async function load(): Promise<MemoEntry[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(DATA_FILE, "utf-8")) as MemoEntry[];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(data: MemoEntry[]): Promise<void> {
  cache = data;
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function newId(): string {
  return `mm_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 고정 먼저, 그 안에서 최근 수정순 */
function sorted(rows: MemoEntry[]): MemoEntry[] {
  return [...rows].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/**
 * 목록 + 검색. q 는 제목·본문·태그를 다 본다(대소문자 무시).
 * 본문까지 통째로 내려보낸다 — 개인 메모라 양이 화면에 부담될 규모가 아니고,
 * 목록에서 바로 미리보기를 그리는 쪽이 편집기를 여닫는 것보다 빠르다.
 */
export async function listMemos(q = "", tag = ""): Promise<MemoEntry[]> {
  const rows = await load();
  const needle = q.trim().toLowerCase();
  return sorted(
    rows.filter((m) => {
      if (tag && !m.tags.includes(tag)) return false;
      if (!needle) return true;
      return (
        m.title.toLowerCase().includes(needle) ||
        m.body.toLowerCase().includes(needle) ||
        m.tags.some((t) => t.toLowerCase().includes(needle))
      );
    }),
  );
}

/** 붙어 있는 모든 태그와 개수 — 필터 칩을 그릴 재료 */
export async function listMemoTags(): Promise<{ tag: string; count: number }[]> {
  const rows = await load();
  const counts = new Map<string, number>();
  for (const m of rows) for (const t of m.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

export async function addMemo(input: {
  title: string;
  body: string;
  tags: string[];
}): Promise<MemoEntry> {
  const rows = await load();
  const now = new Date().toISOString();
  const memo: MemoEntry = {
    id: newId(),
    at: now,
    updatedAt: now,
    title: input.title.slice(0, 120),
    body: input.body.slice(0, 20_000),
    tags: input.tags.map((t) => t.trim()).filter(Boolean).slice(0, 10),
    pinned: false,
  };
  await persist([memo, ...rows]);
  return memo;
}

export async function updateMemo(
  id: string,
  patch: { title?: string; body?: string; tags?: string[]; pinned?: boolean },
): Promise<MemoEntry> {
  const rows = await load();
  const memo = rows.find((m) => m.id === id);
  if (!memo) throw new Error("메모를 찾지 못했습니다.");
  if (patch.title !== undefined) memo.title = patch.title.slice(0, 120);
  if (patch.body !== undefined) memo.body = patch.body.slice(0, 20_000);
  if (patch.tags !== undefined)
    memo.tags = patch.tags.map((t) => t.trim()).filter(Boolean).slice(0, 10);
  if (patch.pinned !== undefined) memo.pinned = patch.pinned;
  /*
   * 고정만 껐다 켠 것도 updatedAt 을 만진다 — 「최근 수정순」이 살아 있는 글 순서라
   * 그 편이 자연스럽다. 글 내용의 이력이 필요해지면 그때 나눈다.
   */
  memo.updatedAt = new Date().toISOString();
  await persist(rows);
  return memo;
}

export async function removeMemo(id: string): Promise<void> {
  const rows = await load();
  if (!rows.some((m) => m.id === id)) throw new Error("메모를 찾지 못했습니다.");
  await persist(rows.filter((m) => m.id !== id));
}
