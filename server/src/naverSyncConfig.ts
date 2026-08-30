import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "naverSync.json");

/**
 * 네이버에서 스스로 긁어오는 일들의 **스위치와 주기** (2026-08-30 요청 —
 * 「동기화 목록을 설정에 넣고, 바로 실행도, 주기도, 끄기도」).
 *
 * ## 왜 이 파일에는 작업이 안 들어오나
 *
 * 여기는 **설정과 기록만** 갖는다. 실제로 긁는 함수(`collectNewsKeywords` 등)를 여기서
 * 부르면, 그 모듈들이 다시 이 파일의 `isEnabled` 를 부르면서 **서로 물고 도는 참조**가
 * 된다. ESM 이 견디긴 하지만 기동 순서에 따라 한쪽이 빈 채로 잡히는 사고가 난다.
 *
 * 그래서 방향을 한쪽으로 고정했다:
 *   - 긁는 모듈 → 이 파일 (켜졌나? 주기가 몇 분인가? 다 돌았다고 적어 둔다)
 *   - 손으로 돌리는 길(routes/naverSync.ts) → 이 파일 + 긁는 모듈 **양쪽**
 *
 * ## 주기를 줄 수 있는 것과 없는 것
 *
 * 뉴스 키워드만 「몇 분마다」가 뜻이 있다. 테마 DB·ETF 는 **하루 중 정해진 시각**에
 * 도는 일이라(장 마감 뒤, 미국 마감 뒤) 「몇 분마다」로 바꿔 놓으면 의미가 없거나
 * 같은 것을 하루에 수십 번 받게 된다. 그런 것은 켜기/끄기와 「지금 실행」만 준다 —
 * 못 하는 것을 할 수 있는 것처럼 보여 주는 쪽이 더 나쁘다.
 *
 * ⚠️ 인포스탁(infostock.co.kr)은 여기에 **영원히 들어오지 않는다.** 예전에 자동
 * 요청으로 상대 서버를 세운 적이 있다.
 */

export type NaverJobKey =
  | "newsKeywords"
  | "themesKr"
  | "themesUs"
  | "themesEtf"
  | "etfHolders";

export const NAVER_JOBS: {
  key: NaverJobKey;
  label: string;
  what: string;
  when: string;
  /** 「몇 분마다」가 뜻이 있는 일인가 */
  periodic: boolean;
}[] = [
  {
    key: "newsKeywords",
    label: "뉴스 키워드 흐름",
    what: "네이버 금융 뉴스 목록에서 제목을 모아 키워드 급증을 잰다",
    when: "평일 08~17시 3분 · 06~24시 10분 · 그 밖 30분",
    periodic: true,
  },
  {
    key: "themesKr",
    label: "테마 DB (국내)",
    what: "네이버 금융 테마 분류와 편입 종목",
    when: "일요일 04시 (주 1회)",
    periodic: false,
  },
  {
    key: "themesUs",
    label: "테마 DB (미국)",
    what: "네이버 해외 업종 분류와 편입 종목",
    when: "매일 07시 (미국 마감 뒤)",
    periodic: false,
  },
  {
    key: "themesEtf",
    label: "ETF 목록",
    what: "네이버 ETF 시세 목록",
    when: "매일 16시 (장 마감 뒤)",
    periodic: false,
  },
  {
    key: "etfHolders",
    label: "ETF 보유 역인덱스",
    what: "ETF 구성종목을 뒤집어 「이 종목을 담은 ETF」를 만든다",
    when: "매일 16시 이후 1회",
    periodic: false,
  },
];

export interface JobState {
  /** 마지막으로 다 돈 시각 (ISO) */
  at?: string;
  /** 사람이 읽을 결과 한 줄 */
  msg?: string;
  ok?: boolean;
}

interface Store {
  /** 없으면 켜진 것으로 본다 — 설정 파일이 없어도 예전처럼 돌아야 한다 */
  off: NaverJobKey[];
  /** 주기를 손으로 정한 것만. 없으면 저마다의 기본 */
  periodMin: Partial<Record<NaverJobKey, number>>;
  state: Partial<Record<NaverJobKey, JobState>>;
}

const EMPTY: Store = { off: [], periodMin: {}, state: {} };
let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    cache = {
      off: Array.isArray(raw.off) ? (raw.off as NaverJobKey[]) : [],
      periodMin: raw.periodMin ?? {},
      state: raw.state ?? {},
    };
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

async function persist(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(cache, null, 2), "utf-8");
}

/**
 * 이 일이 스스로 돌아도 되나.
 *
 * ⚠️ 「지금 실행」은 이걸 보지 않는다 — 꺼 둔 것도 **손으로는 돌릴 수 있어야** 한다.
 * 끈다는 건 「알아서 하지 마라」이지 「쓰지 마라」가 아니다.
 */
export async function isEnabled(key: NaverJobKey): Promise<boolean> {
  return !(await load()).off.includes(key);
}

/** 손으로 정한 주기(분). 없으면 null — 부르는 쪽이 제 기본을 쓴다 */
export async function periodOverrideMs(key: NaverJobKey): Promise<number | null> {
  const m = (await load()).periodMin[key];
  return typeof m === "number" && m > 0 ? m * 60_000 : null;
}

export async function markRun(key: NaverJobKey, ok: boolean, msg: string): Promise<void> {
  const s = await load();
  s.state[key] = { at: new Date().toISOString(), ok, msg };
  await persist();
}

export async function readConfig(): Promise<{
  jobs: (typeof NAVER_JOBS)[number][];
  off: NaverJobKey[];
  periodMin: Partial<Record<NaverJobKey, number>>;
  state: Partial<Record<NaverJobKey, JobState>>;
}> {
  const s = await load();
  return { jobs: NAVER_JOBS, off: s.off, periodMin: s.periodMin, state: s.state };
}

export async function setEnabled(key: NaverJobKey, on: boolean): Promise<void> {
  const s = await load();
  s.off = on ? s.off.filter((k) => k !== key) : [...new Set([...s.off, key])];
  await persist();
}

/** 분 단위. null 이면 「저마다의 기본으로 되돌린다」 */
export async function setPeriodMin(key: NaverJobKey, min: number | null): Promise<void> {
  const s = await load();
  if (min === null) delete s.periodMin[key];
  else s.periodMin[key] = Math.max(1, Math.min(24 * 60, Math.round(min)));
  await persist();
}
