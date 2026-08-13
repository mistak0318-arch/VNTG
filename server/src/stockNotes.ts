import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, "..", "data", "stockNotes.json");

/**
 * 종목 메모.
 *
 * 핵심은 "그때 얼마였는지"를 같이 박아두는 것이다. 메모만 남기면 나중에
 * 무슨 생각이었는지는 알아도 그 판단이 맞았는지 알 수 없다.
 * 작성 시점의 가격을 함께 저장해 두면 현재가와 비교해 판단을 복기할 수 있다.
 */

export interface StockNote {
  id: string;
  /** 작성 시각 (ISO) */
  at: string;
  /** 작성 시점의 주가 — 조회 실패 시 0 */
  price: number;
  /** 작성 시점의 등락률 */
  changeRate: number;
  text: string;
}

export interface StockNoteFile {
  /** 종목코드 -> 메모 목록 (최신순) */
  [code: string]: { name: string; notes: StockNote[] };
}

let cache: StockNoteFile | null = null;

async function load(): Promise<StockNoteFile> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(DATA_FILE, "utf-8")) as StockNoteFile;
  } catch {
    cache = {};
  }
  return cache;
}

async function persist(data: StockNoteFile): Promise<void> {
  cache = data;
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(data, null, 2), "utf-8");
}

function newId(): string {
  return `nt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export async function listNotes(code: string): Promise<{ name: string; notes: StockNote[] }> {
  const data = await load();
  return data[code] ?? { name: "", notes: [] };
}

/** 전체 메모 (최근 작성순) — 리포트·AI 요약에서 쓰려고 */
export async function listAllNotes(
  limit = 30,
): Promise<{ code: string; name: string; note: StockNote }[]> {
  const data = await load();
  const flat = Object.entries(data).flatMap(([code, v]) =>
    v.notes.map((note) => ({ code, name: v.name, note })),
  );
  return flat.sort((a, b) => b.note.at.localeCompare(a.note.at)).slice(0, limit);
}

/**
 * 메모 추가. 작성 시점 가격을 키움에서 조회해 함께 저장한다.
 * 시세 조회가 실패해도 메모는 저장한다 (메모가 더 중요하다).
 */
export async function addNote(
  client: KiwoomClient,
  code: string,
  name: string,
  text: string,
): Promise<{ name: string; notes: StockNote[] }> {
  if (!text.trim()) throw new Error("메모 내용을 입력하세요.");

  let price = 0;
  let changeRate = 0;
  try {
    const { data } = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10001", {
      stk_cd: code,
    });
    price = Math.abs(toNum(data.cur_prc));
    changeRate = toNum(data.flu_rt);
  } catch {
    // 장 마감 후나 조회 실패 시에도 메모 자체는 남긴다
  }

  const data = await load();
  const entry = data[code] ?? { name, notes: [] };
  entry.name = name || entry.name;
  entry.notes = [
    { id: newId(), at: new Date().toISOString(), price, changeRate, text: text.trim() },
    ...entry.notes,
  ];
  data[code] = entry;
  await persist(data);
  return entry;
}

export async function updateNote(
  code: string,
  id: string,
  text: string,
): Promise<{ name: string; notes: StockNote[] }> {
  const data = await load();
  const entry = data[code];
  if (!entry) throw new Error("메모가 없습니다.");
  // 가격·시각은 그대로 둔다. 그때의 기록이라는 게 이 기능의 핵심이라서.
  entry.notes = entry.notes.map((n) => (n.id === id ? { ...n, text: text.trim() } : n));
  await persist(data);
  return entry;
}

export async function removeNote(code: string, id: string): Promise<{ name: string; notes: StockNote[] }> {
  const data = await load();
  const entry = data[code];
  if (!entry) return { name: "", notes: [] };
  entry.notes = entry.notes.filter((n) => n.id !== id);
  if (entry.notes.length === 0) delete data[code];
  await persist(data);
  return data[code] ?? { name: entry.name, notes: [] };
}
