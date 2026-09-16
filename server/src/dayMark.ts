import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **「오늘 이미 했다」를 파일에** (2026-09-16 전체 점검).
 *
 * 점검에서 같은 병이 여섯 군데 나왔다 — 하루 한 번 표시가 `let doneDay = ""` 같은 **메모리 변수**뿐이라
 * 서버가 재시작되면(배포 한 번마다) 같은 일을 또 하거나(저녁 정합성 텔레그램·VI 알림·되짚기), 반대로
 * 실패 전에 도장을 찍어 둬서 그날은 영영 안 하는 것(시스 되짚기). 각자 파일을 만들면 파일이 여섯 개가
 * 되므로 한 곳에서 맡는다.
 *
 *   `doneToday("recap")`        오늘 했나
 *   `markToday("recap")`        오늘 했다고 적는다 — **일이 끝난 뒤에** 부를 것
 *   `once("econ:…:2026-09-16")` 열쇠 하나짜리 — 처음이면 true 를 돌려주며 적는다
 *
 * 날짜가 바뀐 열쇠는 읽을 때 걷어낸다. 실패해도 조용히 「안 했다」로 본다 — 파일이 깨졌다고 배치가
 * 멈추면 안 되고, 두 번 하는 쪽이 영영 안 하는 쪽보다 낫다.
 */

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "dayMarks.json");

type Marks = Record<string, string>; // key → 날짜(YYYY-MM-DD) 또는 열쇠에 날짜가 든 once 는 "1"

let cache: Marks | null = null;
let saving: Promise<void> | null = null;

function today(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

async function load(): Promise<Marks> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, "utf-8")) as Marks;
  } catch {
    cache = {};
  }
  /* 사흘 넘은 once 열쇠·어제 날짜는 걷어낸다 — 파일이 자라지 않게 */
  const keep = today();
  const cutoff = new Date(Date.now() + 9 * 3600_000 - 3 * 86_400_000).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(cache)) {
    const dated = k.match(/(\d{4}-\d{2}-\d{2})$/)?.[1];
    if (dated ? dated < cutoff : v !== keep) delete cache[k];
  }
  return cache;
}

/** 직렬 저장 — 동시에 두 번 부르면 뒤 것이 앞 것을 기다린다(같은 파일을 겹쳐 쓰지 않게) */
async function save(): Promise<void> {
  const prev = saving ?? Promise.resolve();
  saving = prev.then(async () => {
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(cache ?? {}), "utf-8");
  });
  try {
    await saving;
  } catch (e) {
    console.error("[dayMark] 못 씀 —", e instanceof Error ? e.message : e);
  }
}

/** 오늘 이미 했나 */
export async function doneToday(key: string): Promise<boolean> {
  return (await load())[key] === today();
}

/** 오늘 했다고 적는다 — 일이 **끝난 뒤에** */
export async function markToday(key: string): Promise<void> {
  (await load())[key] = today();
  await save();
}

/** 열쇠 하나짜리 — 처음이면 true(그리고 적는다), 이미 있으면 false. 열쇠 끝에 날짜를 붙여 두면 사흘 뒤 걷힌다 */
export async function once(key: string): Promise<boolean> {
  const m = await load();
  if (m[key]) return false;
  m[key] = "1";
  await save();
  return true;
}
