import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "uiPrefs.json");

/**
 * 화면 설정 **전부** — 키 하나에 값 하나.
 *
 * ## 왜 범용으로 만드나
 *
 * 설정마다 저장소를 따로 만들고 있었다(`menuPrefs`, `cardOrder`, `boardPrefs`…).
 * 그러면 **새 설정을 만들 때마다 서버 파일·라우트·타입을 또 만들어야 해서**, 급할 때는
 * 그냥 `localStorage` 에 넣게 된다. 실제로 그렇게 열네 개가 로컬에만 쌓였다.
 *
 * 사용자는 한 명이고 기기만 여러 대다. **설정은 전역이 기본**이어야 하고,
 * 그러려면 새 설정을 넣는 일이 로컬에 넣는 것만큼 쉬워야 한다.
 *
 * ## 값을 해석하지 않는다
 *
 * 화면이 넣은 문자열을 **그대로** 보관한다. 서버가 모양을 검사하면 화면을 고칠 때마다
 * 서버도 같이 고쳐야 하는데, 이건 그 종류의 데이터가 아니다 — 이 값을 쓰는 건 화면뿐이다.
 * 대신 **크기만 막는다**. 값 하나가 64KB 를 넘으면 설정이 아니라 데이터다.
 *
 * ⚠️ **여기에 넣으면 안 되는 것**: 「지금 이 창이 뭘 보고 있나」.
 * 보드는 창마다 다른 구성을 띄우는 화면이라 그건 창(sessionStorage)에 있어야 한다.
 * 설정과 지금 상태를 한 곳에 두면 반드시 서로 덮어쓴다.
 */

export type UiPrefs = Record<string, string>;

/** 값 하나가 이보다 크면 설정이 아니다 */
const MAX_VALUE = 64 * 1024;
/** 키가 무한정 늘어나는 것도 막는다 */
const MAX_KEYS = 200;

function clean(raw: unknown): UiPrefs {
  const out: UiPrefs = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !k || k.length > 120) continue;
    if (typeof v !== "string" || v.length > MAX_VALUE) continue;
    out[k] = v;
    if (Object.keys(out).length >= MAX_KEYS) break;
  }
  return out;
}

/**
 * `saved` 를 같이 준다 — 「아직 저장된 적 없음」과 「저장했는데 비어 있음」은 다른 상태다.
 * 화면이 그걸 갈라 봐야 예전 로컬 설정을 잃지 않고 한 번 올릴 수 있다.
 */
export async function getUiPrefs(): Promise<{ values: UiPrefs; saved: boolean }> {
  try {
    return { values: clean(JSON.parse(await readFile(FILE, "utf-8"))), saved: true };
  } catch {
    return { values: {}, saved: false };
  }
}

/**
 * **덮어쓰지 않고 합친다.**
 *
 * 창이 여럿이면 각자 자기가 바꾼 것만 보낸다. 통째로 갈아치우면 다른 창이 방금 바꾼
 * 설정이 사라진다 — 보드에서 겪은 것과 같은 함정이다.
 *
 * 값이 `null` 이면 그 키를 지운다(설정을 되돌린 것).
 */
export async function patchUiPrefs(input: unknown): Promise<UiPrefs> {
  const { values } = await getUiPrefs();
  if (input && typeof input === "object") {
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (typeof k !== "string" || !k || k.length > 120) continue;
      if (v === null) {
        delete values[k];
        continue;
      }
      if (typeof v === "string" && v.length <= MAX_VALUE) values[k] = v;
    }
  }
  const next = clean(values);
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
