import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 표 칸 너비 — **화면 이름 → 칸 키 → 픽셀.**
 *
 * ## 왜 서버에 두나
 *
 * 카드 배치·탭 순서와 같은 층이다. 「거래대금 상위에서 종목명 칸을 좁히고 회전율을
 * 넓힌다」는 **그 사람이 그 표를 어떻게 읽는가**의 문제라, 기기가 바뀌어도 따라와야 한다.
 *
 * ⚠️ 글자 크기·테마와는 층이 다르다. 그건 **화면의 사정**이라 기기마다 달라야 맞고
 * (`vntg.appearance` 는 그래서 로컬이다), 이건 **읽는 방식**이라 따라와야 맞는다.
 *
 * ## 저장 모양
 *
 * ```
 * { "rank.trade-value": { "stk_nm": 90, "trde_prica": 130 }, ... }
 * ```
 *
 * 없는 칸은 그냥 없다 — 값이 없으면 화면이 기본 너비를 쓴다. 그래서 칸이 새로 생겨도
 * 저장분이 안 깨진다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(here, "..", "data", "columnWidths.json");

export type ColumnWidths = Record<string, Record<string, number>>;

/** 사람이 보낸 값이라 통째로 믿지 않는다 — 숫자가 아닌 것, 말이 안 되는 폭은 버린다 */
function clean(input: unknown): ColumnWidths {
  if (!input || typeof input !== "object") return {};
  const out: ColumnWidths = {};
  for (const [scope, cols] of Object.entries(input as Record<string, unknown>)) {
    if (!cols || typeof cols !== "object") continue;
    const one: Record<string, number> = {};
    for (const [key, v] of Object.entries(cols as Record<string, unknown>)) {
      const n = Number(v);
      /*
       * 40px 보다 좁으면 글자가 한 자도 안 들어가고, 600px 보다 넓으면 그 칸 하나가
       * 표를 통째로 밀어낸다. **되돌릴 방법이 화면에 있어도** 그 사이에 못 쓰게 된다.
       */
      if (Number.isFinite(n) && n >= 40 && n <= 600) one[key] = Math.round(n);
    }
    if (Object.keys(one).length > 0) out[scope] = one;
  }
  return out;
}

export async function getColumnWidths(): Promise<ColumnWidths> {
  try {
    return clean(JSON.parse(await readFile(FILE, "utf-8")));
  } catch {
    return {};
  }
}

export async function saveColumnWidths(input: unknown): Promise<ColumnWidths> {
  const next = clean(input);
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
