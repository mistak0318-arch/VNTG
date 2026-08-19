import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "menuPrefs.json");

/**
 * 사이드바 메뉴 설정 — **서버에 둔다.**
 *
 * 예전엔 localStorage 였다. "기기마다 다른 게 자연스럽다"고 적어 뒀는데 실제로 써 보니 아니었다 —
 * 미니PC 에서 즐겨찾기를 정해 놓고 폰으로 열면 처음부터 다시 정해야 했다.
 * **한 사람이 여러 기기로 같은 서버를 보는 구조**라 설정도 서버에 있는 게 맞다.
 *
 * 화면 외관(테마·글꼴·글자 크기)은 그대로 기기별로 둔다. 그건 화면 크기와 눈에 딸린 것이라
 * 폰과 PC 가 같아야 할 이유가 없다.
 */

export interface MenuPrefs {
  order: string[];
  hidden: string[];
  labels: Record<string, string>;
  groupOf: Record<string, string>;
  extraGroups: string[];
  favorites: string[];
}

export const EMPTY_MENU_PREFS: MenuPrefs = {
  order: [],
  hidden: [],
  labels: {},
  groupOf: {},
  extraGroups: [],
  favorites: [],
};

/** 화면이 보낸 것을 그대로 믿지 않는다 — 모양만 맞춰 받는다 */
function clean(raw: unknown): MenuPrefs {
  const r = (raw ?? {}) as Partial<MenuPrefs>;
  const strArr = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  const strMap = (v: unknown) => {
    const out: Record<string, string> = {};
    if (v && typeof v === "object") {
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (typeof val === "string") out[k] = val;
      }
    }
    return out;
  };
  return {
    order: strArr(r.order),
    hidden: strArr(r.hidden),
    labels: strMap(r.labels),
    groupOf: strMap(r.groupOf),
    extraGroups: strArr(r.extraGroups),
    favorites: strArr(r.favorites),
  };
}

/**
 * `saved` 를 같이 준다.
 *
 * 예전 설정은 기기의 localStorage 에만 있었다. 서버가 비어 있는 채로 화면이 그걸 받아
 * 덮어쓰면 **쓰던 즐겨찾기가 그 자리에서 사라진다.** 「아직 저장된 적 없음」과
 * 「저장했는데 비어 있음」은 다른 상태라서, 화면이 그 둘을 구분할 수 있어야 한다.
 */
export async function getMenuPrefs(): Promise<MenuPrefs & { saved: boolean }> {
  try {
    return { ...clean(JSON.parse(await readFile(FILE, "utf-8"))), saved: true };
  } catch {
    return { ...EMPTY_MENU_PREFS, saved: false };
  }
}

export async function saveMenuPrefs(input: unknown): Promise<MenuPrefs> {
  const next = clean(input);
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
