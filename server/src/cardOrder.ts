import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "cardOrder.json");

/**
 * 화면 카드 순서.
 *
 * 「시황 대시보드」의 카드가 코드에 적힌 순서대로만 나와서, 자주 보는 것이 아래에 있으면
 * 매번 스크롤해야 했다. 무엇을 위에 둘지는 **그날 무엇을 보느냐**에 달린 문제라
 * 코드가 정해 줄 수 없다.
 *
 * 저장은 **서버**다. 즐겨찾기와 같은 이유다 — 미니PC 에서 정한 배치를 폰에서 다시
 * 정하게 만들 이유가 없다. ([[menuPrefs]] 와 같은 판단)
 *
 * ## 저장된 순서는 절대 기준이 아니다
 *
 * 코드에 카드가 새로 생기면 저장분에 그 키가 없다. 그때 **빠뜨리면 새 기능이 화면에서
 * 사라진다.** 그래서 화면 쪽에서 「저장된 것 먼저, 모르는 것은 원래 자리대로 뒤에」로
 * 맞춘다. 여기서는 키 목록을 그대로 보관만 한다 — 어떤 카드가 있는지는 코드가 안다.
 */

/** 화면·구역 이름 → 카드 키 순서. 예: `{ "overview.summary": ["indices", ...] }` */
export type CardOrder = Record<string, string[]>;

function clean(raw: unknown): CardOrder {
  const out: CardOrder = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!Array.isArray(v)) continue;
      const keys = v.filter((x): x is string => typeof x === "string");
      // 같은 키가 두 번 들어오면 순서가 모호해진다 — 첫 번째만 남긴다
      out[k] = [...new Set(keys)];
    }
  }
  return out;
}

export async function getCardOrder(): Promise<CardOrder> {
  try {
    return clean(JSON.parse(await readFile(FILE, "utf-8")));
  } catch {
    return {};
  }
}

/**
 * **보낸 칸만 고친다 — 통째로 덮지 않는다** (2026-10-14).
 *
 * 벤티지: "상하단 메뉴 내가 위아래로 드래그 앤 드롭으로 수정하는데 창 껐다 키면
 * 초기화되네."
 *
 * 여태 이 함수는 받은 것을 **파일 전체로** 삼았다. 그런데 화면 쪽은 훅마다 제 스냅샷
 * (`all`)을 들고 `{...all, [내칸]: 값}` 을 통째로 보낸다. 훅이 하나뿐일 때는 맞았는데,
 * 10/14 에 줄 배치(`stockDetail.tabRows`)를 쓰는 훅이 하나 더 생기면서 깨졌다 —
 *
 *   ① 줄 배치 훅이 저장한다 → 파일에 `tabRows` 가 생긴다
 *   ② 탭 순서 훅은 **마운트 때 읽은 옛 스냅샷**을 들고 있다(거기엔 `tabRows` 가 없다)
 *   ③ 탭 순서를 한 번만 바꿔도 그 옛 스냅샷이 파일을 덮어 **줄 배치가 사라진다**
 *
 * 여기서 합치면 이 경합이 **구조적으로** 없어진다 — 보낸 사람이 자기 칸만 책임지면 되고,
 * 다른 기기·다른 탭이 동시에 고쳐도 서로 안 지운다. 화면 쪽도 이제 제 칸만 보낸다.
 *
 * ⚠️ 그래서 **칸을 지우는 길은 없다.** 지금은 지울 일이 없고(「원래대로」는 빈 배열을
 * 보낸다), 없는 길이 있는 길보다 안전하다. 필요해지면 그때 따로 만든다.
 */
export async function saveCardOrder(input: unknown): Promise<CardOrder> {
  const patch = clean(input);
  const next = { ...(await getCardOrder()), ...patch };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}
