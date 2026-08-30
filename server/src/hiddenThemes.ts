import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "hiddenThemes.json");

/**
 * 안 볼 테마 목록 (2026-08-30 요청 — 「지워야 할 것들이 보이네」).
 *
 * ## 왜 지우지 않고 숨기나
 *
 * 국내·미국 테마 분류는 **네이버에서 긁어온 것**이라 우리 것이 아니다. 지운다 해도
 * 다음 동기화에 그대로 다시 들어온다. 「항상 동기화한다고 생각하면 내가 숨겨버리는
 * 게 맞다」는 판단이 정확하다.
 *
 * 그래서 **원본은 그대로 두고 가리개만 우리가 갖는다.** 원본이 바뀌어도 가리개는
 * 남고, 언제든 되살릴 수 있다.
 *
 * ## 어디에 걸리나
 *
 * [themeStrength](./themeStrength.ts) **한 곳**에서 거른다. 그 함수가 테마 DB·테마 MAP·
 * 신호등의 테마 렌즈·마켓 렌즈·종목 렌즈·테마 링크 **여덟 곳의 원천**이라, 거기서
 * 빼면 전부 따라온다. 화면마다 따로 거르면 언젠가 한 곳이 빠지고, 그러면 「숨겼는데
 * 저기서는 보이는」 상태가 된다 — 그게 제일 나쁘다.
 *
 * 되살리는 화면만 `includeHidden` 으로 원본을 본다.
 *
 * 저장: data/hiddenThemes.json — 열쇠는 `kr:12` / `us:XLK` 처럼 시장이 붙은 것이다
 * (이름으로 저장하면 네이버가 이름을 바꿨을 때 가리개가 헛돈다).
 */

let cache: Set<string> | null = null;

export async function listHidden(): Promise<string[]> {
  if (!cache) {
    try {
      const raw = JSON.parse(await readFile(FILE, "utf-8")) as string[];
      cache = new Set(Array.isArray(raw) ? raw : []);
    } catch {
      cache = new Set();
    }
  }
  return [...cache];
}

/** 빠른 조회용 — themeStrength 가 테마마다 부른다 */
export async function hiddenSet(): Promise<Set<string>> {
  await listHidden();
  return cache!;
}

async function persist(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify([...cache!], null, 2), "utf-8");
}

export async function setHidden(keys: string[], hidden: boolean): Promise<string[]> {
  await listHidden();
  for (const k of keys) {
    const clean = k.trim();
    if (!clean) continue;
    if (hidden) cache!.add(clean);
    else cache!.delete(clean);
  }
  await persist();
  return [...cache!];
}

/** 전부 되살리기 — 하나씩 누르다 지치는 경우가 있다 */
export async function clearHidden(): Promise<string[]> {
  await listHidden();
  cache!.clear();
  await persist();
  return [];
}
