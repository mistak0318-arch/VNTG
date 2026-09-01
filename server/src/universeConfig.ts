import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { SCREEN_UNIVERSES } from "./signalScreen.js";

/**
 * **어느 모집단을 쓸까 — 사람이 고른다** (2026-09-01).
 *
 * 벤티지: "신호등의 각 그룹군에 관해서 전부 설정으로 옮기는 거야. 신호등에 넣을 수
 * 있는 그룹을 내가 고르는 거고, 고르고 나면 신호등 찾기에서 그게 보이는 거지.
 * 당연히 신호등 분석의 지금 돌리기는 신호등 찾기에서 보이는 그룹군에 대해서만
 * 돌아가는 거고. 그럼 신호등에 들어갈 그룹을 더 확장하기도 편하잖아."
 *
 * ## 무엇이 문제였나
 *
 * 모집단이 코드에 고정 열셋이었고, **신호등 분석이 그걸 전부 돌았다.** 목록당
 * 500종목이라 합집합 1,200~1,800개를 평가하느라 **40분**이 걸렸다. 안 쓰는
 * 목록까지 다 도는 셈이다.
 *
 * 그리고 기간이 코드에 박혀 있었다 — `ka10034` 의 `dt:"1"` 이 진짜로 하루치였고,
 * 그건 우리 실측 결론(「연속보다 기간별 누적」)과 정면으로 어긋났다.
 *
 * ## 어떻게 바뀌나
 *
 *   `SCREEN_UNIVERSES`  **카탈로그** — 코드가 아는 목록 전부
 *   `universeConfig`    **선택** — 그중 무엇을 켜고, 각각 며칠로 볼까
 *
 * 켠 것만 신호등 찾기 화면에 뜨고, 신호등 분석도 켠 것만 돈다. 목록을 하나 더
 * 만들면 카탈로그에만 넣으면 되고, 쓸지 말지는 사람이 정한다.
 *
 * ## ⚠️ 저장이 없으면 카탈로그 기본값이다
 *
 * 처음 켰을 때 아무것도 안 보이면 안 된다. 저장분이 없으면 **전부 켠 것으로**
 * 본다 — 예전과 같은 동작이라 바뀐 것을 모르는 사람도 그대로 쓴다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "universeConfig.json");

export interface UniverseChoice {
  key: string;
  enabled: boolean;
  /** 기간(거래일) — 목록이 `spans` 를 열어 뒀을 때만 뜻이 있다 */
  span?: number;
}

export interface UniverseConfig {
  items: UniverseChoice[];
}

let cache: UniverseConfig | null = null;

/**
 * 저장분 + 카탈로그를 합친다.
 *
 * ⚠️ **카탈로그가 기준이다.** 저장분에만 있고 카탈로그에 없는 key 는 버린다 —
 * 목록을 코드에서 지웠는데 설정이 그걸 붙들고 있으면, 없는 목록을 돌리려다
 * 조용히 실패한다.
 */
function merge(saved: Partial<UniverseConfig> | null): UniverseConfig {
  const by = new Map((saved?.items ?? []).map((i) => [i.key, i]));
  return {
    items: SCREEN_UNIVERSES.map((u) => {
      const s = by.get(u.key);
      /* 목록이 허락한 기간만 받는다 — 아무 값이나 두면 뜻 모르는 응답이 온다 */
      const span =
        u.spans && s?.span && u.spans.includes(s.span) ? s.span : (u.defaultSpan ?? undefined);
      return {
        key: u.key,
        /* 저장분이 없으면 켠 것으로 — 처음 켰을 때 빈 화면이 되면 안 된다 */
        enabled: s ? s.enabled !== false : true,
        span,
      };
    }),
  };
}

export async function getUniverseConfig(): Promise<UniverseConfig> {
  if (cache) return cache;
  try {
    cache = merge(JSON.parse(await readFile(FILE, "utf-8")) as Partial<UniverseConfig>);
  } catch {
    cache = merge(null);
  }
  return cache;
}

/**
 * 저장.
 *
 * ⚠️ **하나도 안 켜면 되돌린다.** 전부 끄면 신호등 찾기가 빈 화면이 되고 분석은
 * 아무것도 안 담는데, 화면에는 「저장됨」만 뜬다 — 무엇이 잘못됐는지 알 수 없다.
 * 그건 설정이 아니라 사고다.
 */
export async function saveUniverseConfig(input: Partial<UniverseConfig>): Promise<UniverseConfig> {
  const next = merge(input);
  if (!next.items.some((i) => i.enabled)) {
    throw new Error("모집단을 하나 이상 켜야 합니다 — 전부 끄면 신호등이 아무것도 못 찾습니다.");
  }
  cache = next;
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 1), "utf-8");
  return next;
}

/**
 * 켜진 목록 — **카탈로그 정보를 붙여서** 돌려준다.
 *
 * 부르는 쪽(신호등 찾기·분석)이 label·hint 를 또 찾지 않아도 되게 한다.
 */
export async function enabledUniverses(): Promise<
  { key: string; label: string; hint: string; span?: number; spans?: number[] }[]
> {
  const cfg = await getUniverseConfig();
  const on = new Map(cfg.items.filter((i) => i.enabled).map((i) => [i.key, i]));
  return SCREEN_UNIVERSES.filter((u) => on.has(u.key)).map((u) => ({
    key: u.key,
    label: u.label,
    hint: u.hint,
    span: on.get(u.key)?.span,
    spans: u.spans,
  }));
}
