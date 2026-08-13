import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "calendarSubs.json");

/**
 * iCal 구독 주소 목록.
 * 구글 캘린더 "비공개 주소(ICAL)"를 넣어두면 동기화할 때마다 읽어온다.
 * 주소 자체가 사실상 비밀번호이므로 화면에는 앞부분만 보여준다.
 */
export interface Subscription {
  url: string;
  label: string;
}

let cache: Subscription[] | null = null;

export async function listSubs(): Promise<Subscription[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, "utf-8")) as Subscription[];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(items: Subscription[]): Promise<void> {
  cache = items;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(items, null, 2), "utf-8");
}

export async function addSub(url: string, label: string): Promise<Subscription[]> {
  const clean = url.trim();
  if (!/^https?:\/\//i.test(clean)) throw new Error("http(s) 주소를 입력하세요.");
  const items = await listSubs();
  if (items.some((s) => s.url === clean)) return items;
  const next = [...items, { url: clean, label: label.trim() || "구글 캘린더" }];
  await persist(next);
  return next;
}

export async function removeSub(url: string): Promise<Subscription[]> {
  const items = await listSubs();
  const next = items.filter((s) => s.url !== url);
  await persist(next);
  return next;
}

/** 주소 전체를 노출하지 않기 위한 마스킹 */
export function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}/…${url.slice(-8)}`;
  } catch {
    return "(잘못된 주소)";
  }
}
