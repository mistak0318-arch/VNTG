import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
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

/**
 * 붙임 파일 (2026-08-28) — 차트 캡처·리포트 PDF·설명 영상.
 *
 * **파일은 디스크에, 메모에는 이름표만** 둔다. 메모 JSON 에 통째로 넣으면
 * (base64) 파일 하나에 메모 목록 전체가 무거워져서, 목록을 여는 것만으로
 * 수십 MB 를 읽게 된다.
 */
export interface MemoFile {
  id: string;
  /** 올릴 때의 파일 이름 — 내려받을 때 이 이름으로 준다 */
  name: string;
  /** image/png · application/pdf · video/mp4 … */
  mime: string;
  size: number;
  at: string;
}

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
  /** 붙임 파일 — 없으면 빈 배열(옛 메모에는 이 칸이 없다) */
  files?: MemoFile[];
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
  const memo = rows.find((m) => m.id === id);
  if (!memo) throw new Error("메모를 찾지 못했습니다.");
  /* 메모를 지우면 붙임 파일도 같이 지운다 — 안 그러면 주인 없는 파일이 쌓인다 */
  for (const f of memo.files ?? []) await unlink(filePath(f.id)).catch(() => undefined);
  await persist(rows.filter((m) => m.id !== id));
}

/* ------------------------------------------------------------------ */
/* 붙임 파일                                                            */
/* ------------------------------------------------------------------ */

const FILE_DIR = resolve(__dirname, "..", "data", "memoFiles");

/**
 * 파일이 놓이는 자리.
 *
 * ⚠️ **id 로만 이름을 짓는다.** 올린 이름을 그대로 쓰면 `../` 같은 것이 섞여
 * 엉뚱한 곳에 쓸 수 있고, 한글·공백 때문에 다루기도 나쁘다. 원래 이름은 메모의
 * 이름표에만 남겨 두고 내려받을 때 되살린다.
 */
function filePath(id: string): string {
  return resolve(FILE_DIR, id.replace(/[^a-zA-Z0-9_]/g, ""));
}

/** 한 파일 25MB · 메모 하나에 20개까지 — 개인용이라 넉넉하되 무한은 아니다 */
export const MEMO_FILE_MAX = 25 * 1024 * 1024;
const MEMO_FILE_COUNT = 20;

export async function addMemoFile(
  memoId: string,
  file: { name: string; mime: string; buf: Buffer },
): Promise<MemoFile> {
  const rows = await load();
  const memo = rows.find((m) => m.id === memoId);
  if (!memo) throw new Error("메모를 찾지 못했습니다.");
  if (file.buf.length > MEMO_FILE_MAX) throw new Error("파일이 25MB 를 넘습니다.");
  memo.files ??= [];
  if (memo.files.length >= MEMO_FILE_COUNT) throw new Error(`한 메모에 ${MEMO_FILE_COUNT}개까지입니다.`);

  const f: MemoFile = {
    id: `mf_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`,
    name: file.name.slice(0, 200),
    mime: file.mime || "application/octet-stream",
    size: file.buf.length,
    at: new Date().toISOString(),
  };
  await mkdir(FILE_DIR, { recursive: true });
  await writeFile(filePath(f.id), file.buf);
  memo.files.push(f);
  memo.updatedAt = new Date().toISOString();
  await persist(rows);
  return f;
}

/** 내려받기·미리보기가 읽는다. 원래 이름과 형식을 같이 준다 */
export async function readMemoFile(
  memoId: string,
  fileId: string,
): Promise<{ meta: MemoFile; buf: Buffer }> {
  const rows = await load();
  const memo = rows.find((m) => m.id === memoId);
  const meta = memo?.files?.find((f) => f.id === fileId);
  if (!meta) throw new Error("파일을 찾지 못했습니다.");
  return { meta, buf: await readFile(filePath(fileId)) };
}

export async function removeMemoFile(memoId: string, fileId: string): Promise<void> {
  const rows = await load();
  const memo = rows.find((m) => m.id === memoId);
  if (!memo?.files) throw new Error("파일을 찾지 못했습니다.");
  memo.files = memo.files.filter((f) => f.id !== fileId);
  memo.updatedAt = new Date().toISOString();
  await persist(rows);
  await unlink(filePath(fileId)).catch(() => undefined);
}
