import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 장중 수급 변화.
 *
 * 화면에 있던 건 "오늘 외국인 +801억" 하나였다. 그런데 그 숫자만 보면
 * **오전에 팔다 오후에 산 날**과 **하루 종일 판 날**이 똑같이 생겼다. 방향이 바뀐
 * 지점을 못 보면 "왜 올랐나"에 답할 수가 없다.
 *
 * `ka10051` 은 **누적만** 준다 — 시각별 시계열이 없다. 그래서 시장 폭(breadthStore)과
 * 같은 방식으로 **우리가 직접 표본을 쌓는다.** 수급 화면이 어차피 1분마다 갱신되므로
 * **추가 호출은 없다.** 갱신될 때마다 그 값을 시각과 함께 적어 두면 그게 곧 시계열이다.
 *
 * 한계는 정직하게 적어 둔다:
 *   · **서버가 켜져 있는 동안만** 쌓인다. 꺼져 있던 구간은 비어 있다
 *   · 오늘부터 쌓인다. 과거는 만들 수 없다 (`base_dt` 같은 게 없다)
 *
 * 그래도 이게 맞다. 없는 TR 을 짐작해 부르는 것보다, 이미 받고 있는 값을 버리지 않는
 * 편이 낫다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "flowIntraday.json");

/** 화면에 그릴 세 주체. 나머지는 선이 너무 많아져 읽히지 않는다 */
export interface FlowSample {
  /** HHmm (한국시간) */
  t: string;
  foreign: number;
  institution: number;
  individual: number;
}

export interface FlowIntradayDay {
  date: string;
  kospi: FlowSample[];
  kosdaq: FlowSample[];
}

/** 며칠치까지 들고 있을지 — 장중 표본이라 하루치가 두껍다 */
const KEEP_DAYS = 10;
/** 이보다 촘촘하면 파일만 커지고 그림은 그대로다 */
const MIN_GAP_MS = 60_000;

function kstNow(): Date {
  return new Date(Date.now() + 9 * 3600_000);
}

function today(): string {
  const d = kstNow();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function hhmm(): string {
  const d = kstNow();
  return `${String(d.getUTCHours()).padStart(2, "0")}${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** 장중에만 쌓는다 — 장 끝난 뒤 같은 값을 반복해 적으면 그래프가 평평한 꼬리를 문다 */
function withinSession(): boolean {
  const d = kstNow();
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return m >= 9 * 60 && m <= 15 * 60 + 40;
}

async function read(): Promise<FlowIntradayDay[]> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as FlowIntradayDay[];
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

let lastAt = 0;

interface Flow {
  foreign?: number;
  institution?: number;
  individual?: number;
}

/**
 * 수급이 갱신될 때 불린다. 실패해도 조용히 넘어간다 —
 * 기록 하나 때문에 수급 화면이 멈추면 안 된다.
 */
export async function recordFlow(kospi: Flow, kosdaq: Flow): Promise<void> {
  if (!withinSession()) return;
  if (Date.now() - lastAt < MIN_GAP_MS) return;
  lastAt = Date.now();

  try {
    const rows = await read();
    const date = today();
    let day = rows.find((r) => r.date === date);
    if (!day) {
      day = { date, kospi: [], kosdaq: [] };
      rows.unshift(day);
    }
    const t = hhmm();
    const push = (arr: FlowSample[], f: Flow) => {
      // 같은 분에 두 번 들어오면 덮어쓴다 — 줄이 겹쳐 보이는 걸 막는다
      const s: FlowSample = {
        t,
        foreign: Number(f.foreign) || 0,
        institution: Number(f.institution) || 0,
        individual: Number(f.individual) || 0,
      };
      const at = arr.findIndex((x) => x.t === t);
      if (at >= 0) arr[at] = s;
      else arr.push(s);
    };
    push(day.kospi, kospi);
    push(day.kosdaq, kosdaq);

    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(FILE, JSON.stringify(rows.slice(0, KEEP_DAYS)), "utf-8");
  } catch {
    /* 조용히 넘어간다 */
  }
}

export async function listFlowIntraday(date?: string): Promise<FlowIntradayDay | null> {
  const rows = await read();
  if (rows.length === 0) return null;
  return rows.find((r) => r.date === (date ?? today())) ?? rows[0];
}

/** 어느 날짜가 쌓여 있는지 — 화면에서 날짜를 고를 수 있게 */
export async function flowIntradayDates(): Promise<string[]> {
  return (await read()).map((r) => r.date);
}
