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

/**
 * 숨긴 테마의 **이름도 같이** 들고 있는다 (2026-08-31 요청 —
 * 「테마 하나가 네이버에서 사라지면 화면에 표시해주자」).
 *
 * 예전엔 열쇠(`kr:12`)만 저장했다. 그러면 네이버 분류에서 그 테마가 아주 사라졌을 때
 * **되살리기 목록에도 안 뜬다** — 숨김은 남아 있는데 무엇을 숨겼는지도, 어떻게
 * 되돌리는지도 알 수 없었다. 「전체 되살리기」밖에 길이 없었다.
 *
 * 이름을 같이 적어 두면 사라진 뒤에도 「무엇이었는지」를 화면이 말할 수 있다.
 *
 * 저장 형식은 **둘 다 읽는다** — 옛 파일은 `["kr:12", …]`, 새 파일은
 * `[{key,name}, …]`. 옛 항목은 이름이 없으니 화면이 열쇠를 대신 적는다.
 */
let cache: Map<string, string | undefined> | null = null;

export async function listHidden(): Promise<string[]> {
  await loadCache();
  return [...cache!.keys()];
}

/** 열쇠 → 숨길 때의 이름 (없을 수 있다 — 옛 형식) */
export async function hiddenNames(): Promise<Map<string, string | undefined>> {
  await loadCache();
  return new Map(cache!);
}

async function loadCache(): Promise<void> {
  if (cache) return;
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as (string | { key: string; name?: string })[];
    cache = new Map();
    for (const it of Array.isArray(raw) ? raw : []) {
      if (typeof it === "string") cache.set(it, undefined);
      else if (it && typeof it.key === "string") cache.set(it.key, it.name);
    }
  } catch {
    cache = new Map();
  }
}

/** 빠른 조회용 — themeStrength 가 테마마다 부른다 */
export async function hiddenSet(): Promise<Set<string>> {
  await loadCache();
  return new Set(cache!.keys());
}

async function persist(): Promise<void> {
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(
    FILE,
    JSON.stringify(
      [...cache!.entries()].map(([key, name]) => ({ key, name })),
      null,
      2,
    ),
    "utf-8",
  );
}

export async function setHidden(
  keys: string[],
  hidden: boolean,
  /** 숨길 때의 이름 — 나중에 그 테마가 사라져도 무엇이었는지 말할 수 있게 */
  names: Record<string, string> = {},
): Promise<string[]> {
  await loadCache();
  for (const k of keys) {
    const clean = k.trim();
    if (!clean) continue;
    if (hidden) cache!.set(clean, names[clean] ?? cache!.get(clean));
    else cache!.delete(clean);
  }
  await persist();
  return [...cache!.keys()];
}

/** 전부 되살리기 — 하나씩 누르다 지치는 경우가 있다 */
export async function clearHidden(): Promise<string[]> {
  await loadCache();
  cache!.clear();
  await persist();
  return [];
}
