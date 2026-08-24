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
}

/** 구분선 코드인가 — 시세 조회에서 걸러 낼 때 쓴다 */
export function isDivider(code: string): boolean {
  return code.startsWith("--");
}

export const DEFAULT_GROUP = "기본";

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
  patch: { memo?: string; addedPrice?: number; group?: string; groups?: string[] },
): Promise<WatchItem[]> {
  const items = await load();
  const next = items.map((w) =>
    w.code === code
      ? {
          ...w,
          memo: patch.memo ?? w.memo,
          addedPrice: patch.addedPrice ?? w.addedPrice,
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
  const merged = new Set<string>([DEFAULT_GROUP, ...groups, ...used]);
  return [...merged];
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
  const groups = await loadGroups();
  await persistGroups(groups.filter((g) => g !== name));

  const items = await load();
  // 그룹을 지우면 그 그룹만 빠진다. 다른 그룹에도 담겨 있으면 종목은 남는다
  await persist(
    items.map((w) => ({ ...w, groups: normalizeGroups(w.groups.filter((g) => g !== name)) })),
  );
  return listGroups();
}
