import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
// server/src/watchlist.ts -> server/data/watchlist.json
const DATA_FILE = resolve(__dirname, "..", "data", "watchlist.json");

export interface WatchItem {
  code: string; // 6자리 종목코드
  name: string;
  addedAt: string; // ISO 8601
  addedPrice: number; // 편입가
  memo: string;
  /**
   * @deprecated 한 그룹만 담던 옛 필드. 읽기만 하고 새로 쓰지 않는다.
   * groups 로 옮기는 마이그레이션에만 쓴다.
   */
  group?: string;
  /**
   * 소속 그룹들 — **한 종목이 여러 그룹에 담긴다.**
   *
   * 한 종목은 성격이 하나가 아니다. 삼성전자는 반도체이면서 대형주이고 배당주다.
   * 그걸 한 그룹에만 넣게 하면 어느 관점으로 볼지를 담을 때 미리 정해야 하는데,
   * 그 결정은 담는 시점에 할 수 있는 게 아니다.
   */
  groups: string[];
  /**
   * **그룹 안에서의 자리** — 그룹 이름 → 순번.
   *
   * ## 왜 그룹마다 따로인가
   *
   * 한 종목이 여러 그룹에 든다. 「반도체」에서는 맨 위에 두고 싶은 종목이 「배당주」에서는
   * 아래여도 된다 — 순서는 **그 바구니를 어떻게 보느냐**의 문제라 바구니마다 다르다.
   * 종목에 순번 하나만 달면 그룹을 옮길 때마다 다른 그룹의 배치가 흔들린다.
   *
   * 값이 없는 종목은 **맨 아래**로 간다(새로 담은 것). 자리를 정한 적이 없다는 뜻이다.
   */
  order?: Record<string, number>;
  /**
   * **구분선인가.**
   *
   * 키움 HTS 관심종목처럼 종목 사이에 빈 줄을 넣어 묶음을 가른다. 그룹을 새로 만들 만큼은
   * 아닌데 눈으로는 갈라 보고 싶은 때가 있다 — 「지금 보는 것」과 「기다리는 것」처럼.
   *
   * 구분선은 종목이 아니므로 `code` 가 `--` 로 시작한다(`--1`, `--2`…). 시세를 조회하지
   * 않고 화면에서도 값 칸을 비운다.
   */
  divider?: boolean;
  /**
   * **지금 이 종목과 나의 관계.**
   *
   * ## 왜 그룹으로는 안 되나
   *
   * 그룹으로 흉내 낼 수는 있다. 그런데 **상태는 그룹과 다른 축**이다 — 같은 종목이
   * 「반도체」이면서 동시에 「진입 대기」일 수 있다. 그걸 그룹으로 하면 종목을 옮길
   * 때마다 원래 분류가 흔들리고, 결국 어느 그룹이 성격이고 어느 그룹이 상태인지
   * 사람이 외우고 있어야 한다.
   *
   * ## 네 가지면 충분하다
   *
   *   `watching`  관찰 중 — 담아 두고 보는 중. **기본값**
   *   `ready`     진입 대기 — 조건이 오면 산다. 트리거를 기다리는 자리
   *   `holding`   보유 중 — 실제로 들고 있다
   *   `closed`    청산 — 팔았지만 계속 보고 싶은 것(복기 대상)
   *
   * 더 잘게 나눌 수 있지만 늘릴수록 **고르기 귀찮아서 안 고르게 된다.** 안 고르면
   * 이 칸은 없는 것과 같다.
   *
   * ⚠️ **보유 수량과는 다른 값이다.** 실제 보유·손익은 복기 노트의 매수·매도에서
   * 선입선출로 계산한다(`openPositions`). 여기 `holding` 은 **내가 그렇게 표시해 둔 것**뿐이라,
   * 둘이 어긋날 수 있다. 그 어긋남 자체가 「노트를 안 적었다」는 신호다.
   */
  status?: WatchStatus;
}

export type WatchStatus = "watching" | "ready" | "holding" | "closed";

/** 화면에서 쓰는 이름과 설명 — 서버가 갖고 있어야 화면 여러 곳이 같은 말을 쓴다 */
export const WATCH_STATUSES: { key: WatchStatus; label: string; hint: string }[] = [
  { key: "watching", label: "관찰", hint: "담아 두고 보는 중" },
  { key: "ready", label: "대기", hint: "조건이 오면 산다 — 트리거를 기다리는 자리" },
  { key: "holding", label: "보유", hint: "실제로 들고 있다" },
  { key: "closed", label: "청산", hint: "팔았지만 계속 보고 싶은 것" },
];

/** 구분선 코드인가 — 시세 조회에서 걸러 낼 때 쓴다 */
export function isDivider(code: string): boolean {
  return code.startsWith("--");
}

export const DEFAULT_GROUP = "기본";

/**
 * 슈퍼신호등 그룹 (2026-08-25) — **지울 수 없다.**
 *
 * 슈퍼신호등(여러 목록에 동시에 걸린 초록)이 매일 15:45 자동으로 여기 담는다.
 * 사람이 지워 버리면 자동 편입이 갈 곳을 잃으므로 기본 그룹처럼 보호한다.
 * 종목을 빼는 건 자유다 — 보호하는 건 그룹 자체뿐이다.
 */
export const SUPER_GROUP = "슈퍼신호등";
/** 교차 신호(주도주 ∩ 슈퍼신호등) 자동 편입 그룹 — 슈퍼신호등과 같은 보호를 받는다 */
export const CROSS_GROUP = "슈퍼신호등+교차";

/**
 * **점수대 자동 그룹** (2026-09-01) — 90/80/70/60점대.
 *
 * 벤티지: "관심종목에 90점대,80점대,70점대,60점대 그룹 추가해서 신호등 분석이랑
 * 슈퍼신호등 메뉴에 있는 것들 여기에 동기화 되게 하자. 관심종목에서도 관리하게끔."
 *
 * ## 왜 필요한가
 *
 * 신호등 점수는 **찾기 화면을 열어야만** 보였다. 그 화면을 닫으면 「오늘 87점이던
 * 그 종목」이 어디에도 안 남는다 — 관심종목에는 이름만 있고 점수가 없었다.
 * 점수대로 갈라 두면 관심종목 한 화면에서 **지금 무엇이 몇 점대인지** 보인다.
 *
 * ## ⚠️ 사람이 못 건드린다
 *
 * 벤티지: "관심종목에서 저 그룹들은 내가 삭제하거나 그룹을 수정하거나 할수는
 * 없어야 겠지?"
 *
 * 맞다. **동기화가 이름으로 찾기 때문**이다. 「90점대」를 「고득점」으로 바꾸면
 * 다음 동기화가 「90점대」를 새로 만들고, 화면에 같은 뜻의 그룹이 둘이 된다.
 * 삭제도 마찬가지 — 지워도 다음 동기화에 되살아나므로 지운 사람만 헷갈린다.
 *
 * 종목을 손으로 넣거나 빼는 것도 뜻이 없다. **다음 동기화가 덮는다.** 화면이
 * 그 사실을 말해 줘야 한다(자물쇠 표시).
 */
export const SCORE_BANDS = [90, 80, 70, 60] as const;

export type ScoreBand = (typeof SCORE_BANDS)[number];

/** 점수 → 그룹 이름. 60점 미만은 그룹이 없다(담지 않는다) */
export function bandGroupOf(score: number): string | null {
  for (const b of SCORE_BANDS) if (score >= b) return `${b}점대`;
  return null;
}

export const BAND_GROUPS: string[] = SCORE_BANDS.map((b) => `${b}점대`);

/**
 * 자동으로 채워지고 **사람이 못 고치는** 그룹들 — 화면이 자물쇠를 그린다.
 *
 * ⚠️ 화면이 이 목록을 **하드코딩하면 안 된다.** 서버가 그룹을 늘렸을 때(점수대
 * 넷이 그랬다) 화면만 모르는 상태가 되고, 사용자는 고칠 수 있는 줄 알고 고치다가
 * 서버 오류를 본다. `/api/watchlist/groups` 가 같이 실어 보낸다.
 */
export const AUTO_GROUPS: string[] = [SUPER_GROUP, CROSS_GROUP, ...BAND_GROUPS];

/** 자동으로 채워지고 **사람이 못 고치는** 그룹인가 — 화면이 자물쇠를 그린다 */
export function isAutoGroup(name: string): boolean {
  return AUTO_GROUPS.includes(name);
}

/** 그룹 이름 목록 (종목이 하나도 없는 빈 그룹도 유지하기 위해 따로 저장) */
const GROUPS_FILE = resolve(__dirname, "..", "data", "watchGroups.json");

let cache: WatchItem[] | null = null;

async function load(): Promise<WatchItem[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    /*
     * 두 번의 구조 변경을 다 받아 준다.
     *   group 없음        → 기본 그룹 (그룹 개념 도입 전)
     *   group 만 있음     → groups 로 옮긴다 (다중 그룹 도입 전)
     * 옛 파일을 그대로 열어도 종목이 사라지지 않아야 한다.
     */
    cache = Array.isArray(parsed)
      ? (parsed as WatchItem[]).map((w) => ({
          ...w,
          groups:
            Array.isArray(w.groups) && w.groups.length > 0
              ? w.groups
              : [w.group?.trim() || DEFAULT_GROUP],
        }))
      : [];
  } catch {
    // 파일이 아직 없으면 빈 목록으로 시작
    cache = [];
  }
  return cache;
}

async function persist(items: WatchItem[]): Promise<void> {
  cache = items;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(items, null, 2), "utf-8");
}

export async function listWatchlist(): Promise<WatchItem[]> {
  return [...(await load())];
}

export async function addWatchItem(item: {
  code: string;
  name: string;
  addedPrice: number;
  memo?: string;
  /** 하나만 줘도 되고 여러 개를 줘도 된다 */
  group?: string;
  groups?: string[];
}): Promise<WatchItem[]> {
  const items = await load();
  /*
   * 이미 담긴 종목이면 **그룹과 메모만 고친다.**
   *
   * 예전엔 여기서 목록을 그대로 돌려주고 끝냈다. 편입가를 덮어쓰지 않으려던 것인데,
   * 그 바람에 **여러 그룹에 담는 기능이 통째로 죽어 있었다** — 화면은 「관심종목 그룹
   * 고치기」라고 띄우고 그룹을 골라도 서버가 조용히 무시하니, 누르는 사람 입장에서는
   * 아무 일도 안 일어나는 것으로 보인다. 실제로 그 증상으로 두 번 돌아왔다.
   *
   * 지키려던 것(편입가·담은 날짜)은 그대로 두고 고치려던 것만 고친다.
   * 그룹을 빈 배열로 보내는 건 「어느 그룹에도 안 두겠다」가 아니라 화면에서
   * **빼겠다는 뜻**이라 라우트가 지우기로 보내므로, 여기서는 빈 배열을 무시한다.
   */
  const had = items.find((w) => w.code === item.code);
  if (had) {
    const picked = normalizeGroups(item.groups ?? (item.group ? [item.group] : []));
    const next = items.map((w) =>
      w.code === item.code
        ? {
            ...w,
            name: item.name || w.name,
            memo: item.memo ?? w.memo,
            groups: picked.length > 0 ? picked : w.groups,
          }
        : w,
    );
    await persist(next);
    return next;
  }
  const next: WatchItem[] = [
    ...items,
    {
      code: item.code,
      name: item.name,
      addedAt: new Date().toISOString(),
      addedPrice: item.addedPrice,
      memo: item.memo ?? "",
      groups: normalizeGroups(item.groups ?? (item.group ? [item.group] : [])),
    },
  ];
  await persist(next);
  return next;
}

export async function removeWatchItem(code: string): Promise<WatchItem[]> {
  const items = await load();
  const next = items.filter((w) => w.code !== code);
  await persist(next);
  return next;
}

export async function updateWatchItem(
  code: string,
  patch: {
    memo?: string;
    addedPrice?: number;
    group?: string;
    groups?: string[];
    status?: WatchStatus;
  },
): Promise<WatchItem[]> {
  const items = await load();
  const valid = new Set(WATCH_STATUSES.map((s) => s.key));
  const next = items.map((w) =>
    w.code === code
      ? {
          ...w,
          memo: patch.memo ?? w.memo,
          addedPrice: patch.addedPrice ?? w.addedPrice,
          // 모르는 값이 오면 무시한다 — 화면이 못 그리는 상태를 저장해 두면 안 된다
          status: patch.status && valid.has(patch.status) ? patch.status : w.status,
          groups:
            patch.groups !== undefined
              ? normalizeGroups(patch.groups)
              : patch.group !== undefined
                ? normalizeGroups([patch.group])
                : w.groups,
        }
      : w,
  );
  await persist(next);
  return next;
}

/**
 * 그룹 하나를 넣거나 뺀다.
 *
 * 표에서 칩 하나를 눌러 토글하는 자리에 쓴다 — 전체 목록을 다시 보내게 하면
 * 화면이 최신 상태를 들고 있어야 해서, 두 창을 띄워 놓으면 서로 덮어쓴다.
 */
export async function toggleWatchGroup(code: string, group: string): Promise<WatchItem[]> {
  const g = group.trim();
  if (!g) return load();
  const items = await load();
  const next = items.map((w) => {
    if (w.code !== code) return w;
    const has = w.groups.includes(g);
    return { ...w, groups: normalizeGroups(has ? w.groups.filter((x) => x !== g) : [...w.groups, g]) };
  });
  await persist(next);
  return next;
}

/**
 * 그룹에 **반드시 들어 있게** 한다 — 자동 편입(슈퍼신호등)용.
 * 이미 담긴 종목이면 그룹만 더하고 편입가·메모·다른 그룹은 안 건드린다.
 * toggle 을 쓰면 이미 있을 때 **빠져 버리므로** 따로 둔다.
 */
export async function ensureInGroup(
  item: { code: string; name: string; addedPrice: number; memo?: string },
  group: string,
): Promise<void> {
  const items = await load();
  const had = items.find((w) => w.code === item.code);
  if (had && had.groups.includes(group)) return; // 이미 그대로 — 캐시도 건드릴 것 없다
  if (!had) {
    await addWatchItem({ ...item, groups: [group] });
  } else {
    await persist(
      items.map((w) =>
        w.code === item.code ? { ...w, groups: normalizeGroups([...w.groups, group]) } : w,
      ),
    );
  }
  /*
   * ⚠️ 자동 편입도 목록 변경이다 (2026-08-26) — 트래킹 캐시를 비워야 한다.
   * 사용자 편집 경로는 라우트가 invalidate 를 부르는데, 슈퍼신호등·교차 자동 편입은
   * 이 함수로 직접 들어와서 캐시가 옛 목록을 물고 있었다. 마감 후엔 캐시가
   * **다음 개장까지** 살아서, 15:45 편입분이 관심종목 화면(그룹 개수 포함)에
   * 밤새 안 보였다 — 「슈퍼신호등이 15개 넘는데 15개로 나온다」의 원인.
   * (watchTracking 이 이 파일을 import 하므로 순환을 피해 동적 import)
   */
  const { invalidateTrackingCache } = await import("./watchTracking.js");
  invalidateTrackingCache();
}

/**
 * **그룹에서만 뺀다** (2026-08-31).
 *
 * 슈퍼신호등에서 이탈한 종목이 관심종목의 「슈퍼신호등」 그룹에 계속 남아 목록이
 * 쌓이기만 했다("이탈 로직이 슈퍼신호등 메뉴에서만 적용되니깐 내 관심종목
 * 리스트는 계속 쌓이고만 있네").
 *
 * ⚠️ **종목을 통째로 지우지 않는다.** `removeWatchItem` 을 쓰면 그 종목이 벤티지가
 * 직접 담은 다른 그룹에도 있을 때 그것까지 날아간다. 그룹만 뺀다.
 *
 * ⚠️ 마지막 그룹이었으면 **관심종목에서 빠진다.** `normalizeGroups` 가 빈 배열을
 * 기본 그룹으로 되돌리므로, 그 경우엔 항목 자체를 지워야 뜻이 맞는다 —
 * 안 그러면 이탈한 종목이 기본 그룹으로 옮겨 앉는다.
 */
export async function removeFromGroup(code: string, group: string): Promise<boolean> {
  const items = await load();
  const had = items.find((w) => w.code === code);
  if (!had || !had.groups.includes(group)) return false;

  const left = had.groups.filter((g) => g !== group);
  const next =
    left.length > 0
      ? items.map((w) => (w.code === code ? { ...w, groups: left } : w))
      : items.filter((w) => w.code !== code);
  await persist(next);

  /* 자동 편입과 같은 이유로 트래킹 캐시를 비운다 — ensureInGroup 주석 참고 */
  const { invalidateTrackingCache } = await import("./watchTracking.js");
  invalidateTrackingCache();
  return true;
}

/** 빈 배열이면 기본 그룹으로 — 어디에도 안 속한 종목은 목록에서 사라진다 */
function normalizeGroups(input: string[]): string[] {
  const out = [...new Set(input.map((g) => g.trim()).filter(Boolean))];
  return out.length > 0 ? out : [DEFAULT_GROUP];
}


// ---------------------------------------------------------------- 그룹 관리

let groupCache: string[] | null = null;

async function loadGroups(): Promise<string[]> {
  if (groupCache) return groupCache;
  try {
    const raw = await readFile(GROUPS_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    groupCache = Array.isArray(parsed) ? (parsed as string[]) : [DEFAULT_GROUP];
  } catch {
    groupCache = [DEFAULT_GROUP];
  }
  return groupCache;
}

async function persistGroups(groups: string[]): Promise<void> {
  groupCache = groups;
  const { mkdir } = await import("node:fs/promises");
  await mkdir(dirname(GROUPS_FILE), { recursive: true });
  await writeFile(GROUPS_FILE, JSON.stringify(groups, null, 2), "utf-8");
}

/** 저장된 그룹 + 실제 종목이 쓰고 있는 그룹을 합쳐서 반환 (기본 그룹은 항상 맨 앞) */
export async function listGroups(): Promise<string[]> {
  const [groups, items] = await Promise.all([loadGroups(), load()]);
  const used = new Set(items.flatMap((w) => w.groups));
  /*
   * **자동 그룹은 비어 있어도 보인다.** 자동 편입이 갈 자리가 눈에 있어야 한다.
   *
   * 점수대 그룹에서 실제로 걸렸다 (2026-09-01): 90점짜리가 하나도 없던 날
   * 「90점대」 그룹이 목록에서 통째로 사라졌다. 그러면 사용자는 그 그룹이
   * **없는 건지 비어 있는 건지** 알 수가 없다 — 「오늘은 90점대가 없구나」와
   * 「그런 그룹은 원래 없구나」는 전혀 다른 말이다.
   */
  const merged = new Set<string>([DEFAULT_GROUP, ...groups, ...used, ...AUTO_GROUPS]);
  /*
   * ## **자동 그룹을 앞으로 몬다** (2026-09-01)
   *
   * 벤티지: "같이 쭈루룩 있으니깐 헷갈리네. 내가 한 건 확실하게 내가 한 것들,
   * 그리고 자동으로 쌓이는 그룹은 따로 있는 거지."
   *
   * 예전 순서는 「저장된 순서 → 종목이 쓰는 순서 → 자동 그룹」이라 **섞여 나왔다** —
   * 기본 / 반도체_핵심 / 🌟슈퍼신호등 / 🔒70점대 / ⚡교차 / 🔒80점대 …
   * 손으로 만든 것과 서버가 채우는 것이 번갈아 나오니 어느 쪽인지 매번 읽어야 한다.
   *
   * 셋으로 가른다: **기본 → 자동(고정 순서) → 내가 만든 것.**
   * 자동 안의 순서는 `AUTO_GROUPS` 가 정한다(슈퍼 → 교차 → 90 → 60점대) —
   * 점수대는 높은 쪽이 위다.
   */
  const all = [...merged];
  const mine = all.filter((g) => g !== DEFAULT_GROUP && !AUTO_GROUPS.includes(g));
  return [DEFAULT_GROUP, ...AUTO_GROUPS.filter((g) => merged.has(g)), ...mine];
}

export async function addGroup(name: string): Promise<string[]> {
  const clean = name.trim();
  if (!clean) throw new Error("그룹 이름이 비어 있습니다.");
  const groups = await loadGroups();
  if (!groups.includes(clean)) await persistGroups([...groups, clean]);
  return listGroups();
}

export async function renameGroup(from: string, to: string): Promise<string[]> {
  const clean = to.trim();
  if (!clean) throw new Error("그룹 이름이 비어 있습니다.");
  if (from === DEFAULT_GROUP) throw new Error("기본 그룹은 이름을 바꿀 수 없습니다.");
  if (from === SUPER_GROUP)
    throw new Error("슈퍼신호등 그룹은 이름을 바꿀 수 없습니다 — 자동 편입이 이 이름을 찾습니다.");
  if (from === CROSS_GROUP)
    throw new Error("슈퍼신호등+교차 그룹은 이름을 바꿀 수 없습니다 — 자동 편입이 이 이름을 찾습니다.");
  /*
   * 점수대 그룹도 같다. 이름을 바꾸면 다음 동기화가 원래 이름으로 새로 만들어
   * **같은 뜻의 그룹이 둘**이 된다 — 바꾼 사람만 헷갈린다.
   */
  if (BAND_GROUPS.includes(from))
    throw new Error(`${from} 그룹은 이름을 바꿀 수 없습니다 — 신호등이 이 이름으로 자동 동기화합니다.`);

  const groups = await loadGroups();
  await persistGroups(groups.map((g) => (g === from ? clean : g)));

  // 그 그룹에 속한 종목도 같이 옮긴다
  const items = await load();
  await persist(
    items.map((w) => ({ ...w, groups: normalizeGroups(w.groups.map((g) => (g === from ? clean : g))) })),
  );
  return listGroups();
}

/**
 * 그룹 안에서 **종목 순서를 바꾼다.**
 *
 * 화면이 지금 보이는 순서를 통째로 보내면 그대로 번호를 매긴다. 한 칸씩 올리고 내리는
 * 계산을 서버가 다시 하지 않아도 되고, 드래그로 여러 칸을 옮겨도 같은 길로 저장된다.
 */
export async function reorderWatch(group: string, codes: string[]): Promise<WatchItem[]> {
  const items = await load();
  const at = new Map(codes.map((c, i) => [c, i]));
  for (const it of items) {
    const i = at.get(it.code);
    if (i === undefined) continue;
    it.order = { ...(it.order ?? {}), [group]: i };
  }
  await persist(items);
  return items;
}

/**
 * 구분선을 **그 그룹에 하나 넣는다.**
 *
 * 종목 사이에 빈 줄을 넣어 묶음을 가른다. 그룹을 새로 만들 만큼은 아닌데 눈으로는 갈라
 * 보고 싶은 때가 있다 — 「지금 보는 것」과 「기다리는 것」처럼.
 *
 * 코드는 겹치지 않게 시각으로 만든다. 사람이 볼 값이 아니라 자리를 잡아 두는 표다.
 */
export async function addDivider(group: string, label = ""): Promise<WatchItem[]> {
  const items = await load();
  const code = `--${Date.now().toString(36)}`;
  items.push({
    code,
    name: label,
    addedAt: new Date().toISOString(),
    addedPrice: 0,
    memo: "",
    groups: [group],
    divider: true,
    /* 맨 아래에 붙는다 — 넣고 나서 원하는 자리로 옮긴다 */
    order: { [group]: Number.MAX_SAFE_INTEGER },
  });
  await persist(items);
  return items;
}

/**
 * 그룹 순서 바꾸기.
 *
 * 그룹이 늘면 자주 보는 게 뒤로 밀린다 — 만든 순서대로 늘어서기 때문이다.
 * 화면에서 끌어 옮길 수 있어야 하는데, **순서는 저장돼야** 다음에 열어도 그대로다.
 *
 * 화면이 보낸 순서를 그대로 믿지 않는다. 화면이 모르는 그룹(다른 창에서 방금 만든 것)이
 * 있을 수 있으므로 **보내온 것 먼저, 빠진 것은 뒤에** 붙인다 — 그래야 그룹이 사라지지 않는다.
 * 기본 그룹은 늘 맨 앞이다.
 */
export async function reorderGroups(order: string[]): Promise<string[]> {
  const current = await listGroups();
  const known = new Set(current);
  const seen = new Set<string>();
  const next: string[] = [];
  for (const g of order) {
    if (g === DEFAULT_GROUP || !known.has(g) || seen.has(g)) continue;
    seen.add(g);
    next.push(g);
  }
  // 화면이 몰랐던 그룹은 뒤에 남긴다
  for (const g of current) {
    if (g === DEFAULT_GROUP || seen.has(g)) continue;
    next.push(g);
  }
  await persistGroups(next);
  return listGroups();
}

/** 그룹을 지우면 소속 종목은 기본 그룹으로 옮긴다 (종목이 사라지지 않게) */
export async function removeGroup(name: string): Promise<string[]> {
  if (name === DEFAULT_GROUP) throw new Error("기본 그룹은 삭제할 수 없습니다.");
  if (name === SUPER_GROUP)
    throw new Error("슈퍼신호등 그룹은 삭제할 수 없습니다 — 자동 편입이 담기는 자리입니다.");
  if (name === CROSS_GROUP)
    throw new Error("슈퍼신호등+교차 그룹은 삭제할 수 없습니다 — 교차 신호 자동 편입이 담기는 자리입니다.");
  /* 지워도 다음 동기화에 되살아난다 — 지운 사람만 헷갈린다 */
  if (BAND_GROUPS.includes(name))
    throw new Error(`${name} 그룹은 삭제할 수 없습니다 — 신호등 점수가 자동으로 담기는 자리입니다.`);
  const groups = await loadGroups();
  await persistGroups(groups.filter((g) => g !== name));

  const items = await load();
  // 그룹을 지우면 그 그룹만 빠진다. 다른 그룹에도 담겨 있으면 종목은 남는다
  await persist(
    items.map((w) => ({ ...w, groups: normalizeGroups(w.groups.filter((g) => g !== name)) })),
  );
  return listGroups();
}
