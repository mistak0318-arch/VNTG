import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 시황 질문 기록.
 *
 * 질문은 **한 번 쓰고 버리는 게 아니다.** 두 달 전에 "지금 반도체가 왜 빠지나" 하고
 * 물었던 답을, 지금 같은 일이 벌어졌을 때 다시 읽어 보면 그때 내가 무엇을 몰랐는지가
 * 보인다. 복기 노트가 매매에 대해 하는 일을, 이건 생각에 대해 한다.
 *
 * 비용도 같이 적는다 — 어떤 질문이 비싼지 알아야 묻는 방식을 고칠 수 있다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "askHistory.json");

/** 너무 쌓이면 파일이 무거워진다. 500건이면 몇 달치다 */
const MAX = 500;

export interface AskRecord {
  id: string;
  at: string;
  question: string;
  answer: string | null;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** 검색어 — 무엇을 찾아보고 답했는지가 답만큼 중요하다 */
  searches: string[];
  sources: { title: string; url: string }[];
  error?: string;
}

async function read(): Promise<AskRecord[]> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as AskRecord[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

async function write(rows: AskRecord[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(rows.slice(0, MAX), null, 2), "utf-8");
}

/** 최신순 */
export async function listAsk(limit = 100): Promise<AskRecord[]> {
  return (await read()).slice(0, limit);
}

export async function addAsk(r: Omit<AskRecord, "id" | "at">): Promise<AskRecord> {
  const rows = await read();
  const rec: AskRecord = {
    ...r,
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
  };
  rows.unshift(rec);
  await write(rows);
  return rec;
}

export async function removeAsk(id: string): Promise<void> {
  await write((await read()).filter((x) => x.id !== id));
}
