import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **한투에서 받은 것은 디스크에도 남긴다** (2026-10-14).
 *
 * 벤티지: "종목 여러 개 했는데 키움 쪽은 잘되는데 한투가 문제인 듯" —
 * 화면에 「한투 조회가 몰려 있습니다 — 앞에 20건(약 8초)」.
 *
 * 한투는 키움보다 빡빡해서 **전부 한 줄로 세워 400ms 씩** 띄운다(초당 2.5건,
 * `hantooClient`). 종목 하나에 목표주가·재무비율·추정실적이 붙으니 종목 넷만 열어도
 * 열몇 건이 줄을 서고, 스물을 넘기면 아예 돌려보낸다. 그 자체는 맞는 설계다 —
 * 한투가 막히는 것보다 기다리는 쪽이 낫다.
 *
 * 문제는 **그 줄을 자꾸 다시 서게 만든 것**이다. 각 모듈의 캐시는 6시간짜리인데
 * **메모리에만** 있다. 서버가 뜰 때마다 비므로, 배포가 잦은 날에는 같은 종목을 하루에도
 * 여러 번 새로 받는다. 10/14 에만 열다섯 번 배포했으니 벤티지는 계속 **첫 조회**를 맞았다.
 *
 * 디스크에 얹으면 그 반복이 없어진다. 6시간 안에 한 번 받은 것은 재시작해도 그대로다.
 *
 * ## 한 파일에 모은다
 *
 * 종류(`kind`)와 종목코드로 칸을 나눠 한 파일에 둔다. 종류마다 파일을 만들면 작은 파일이
 * 흩어지고, 무엇보다 **지울 때 흩어진 것을 다 찾아야** 한다.
 *
 * ## ⚠️ 쓰기는 모아서 한 번
 *
 * 값 하나 받을 때마다 파일을 쓰면 종목 스무 개를 여는 동안 스무 번 쓴다. 5초 모았다가
 * 한 번 쓴다. 쓰다 죽어도 반쪽 파일이 남지 않게 **임시 파일에 쓰고 바꿔 끼운다**.
 *
 * ## ⚠️ 무한정 쌓지 않는다
 *
 * 이 서버는 메모리로 죽어 본 적이 있다(10/07). 칸이 3,000 을 넘으면 오래된 것부터 버린다 —
 * 종목 수가 2,900 쯤이라 종류 하나는 다 들어가고, 그 이상은 어차피 안 쓰는 것들이다.
 */
const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "hantooCache.json");
const MAX_ENTRIES = 3000;
const WRITE_DELAY_MS = 5000;

type Entry = { at: number; data: unknown };
let mem: Map<string, Entry> | null = null;
let loading: Promise<Map<string, Entry>> | null = null;
let dirty = false;
let timer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<Map<string, Entry>> {
  if (mem) return mem;
  if (loading) return loading;
  loading = (async () => {
    try {
      const raw = JSON.parse(await readFile(FILE, "utf-8")) as Record<string, Entry>;
      mem = new Map(Object.entries(raw).filter(([, v]) => v && typeof v.at === "number"));
    } catch {
      /* 파일이 없거나 깨졌으면 빈 창고 — 다시 받으면 된다 */
      mem = new Map();
    }
    loading = null;
    return mem;
  })();
  return loading;
}

function schedule(): void {
  if (timer) return;
  timer = setTimeout(() => {
    timer = null;
    void flush();
  }, WRITE_DELAY_MS);
  timer.unref?.();
}

async function flush(): Promise<void> {
  if (!dirty || !mem) return;
  dirty = false;
  try {
    if (mem.size > MAX_ENTRIES) {
      const old = [...mem.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, mem.size - MAX_ENTRIES);
      for (const [k] of old) mem.delete(k);
    }
    await mkdir(dirname(FILE), { recursive: true });
    const tmp = `${FILE}.tmp`;
    await writeFile(tmp, JSON.stringify(Object.fromEntries(mem)), "utf-8");
    await rename(tmp, FILE);
  } catch {
    /* 못 써도 메모리 캐시는 산다 — 다음에 다시 쓴다 */
  }
}

/** 6시간 안에 받아 둔 것이 있으면 준다. 없으면 null */
export async function hantooCacheGet<T>(kind: string, code: string, ttlMs: number): Promise<T | null> {
  const m = await load();
  const hit = m.get(`${kind}:${code}`);
  if (!hit || Date.now() - hit.at >= ttlMs) return null;
  return hit.data as T;
}

export async function hantooCachePut(kind: string, code: string, data: unknown): Promise<void> {
  const m = await load();
  m.set(`${kind}:${code}`, { at: Date.now(), data });
  dirty = true;
  schedule();
}
