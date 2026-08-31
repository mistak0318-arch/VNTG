import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * 알림함 — **앱 안에서 받는 곳** (2026-08-31).
 *
 * ## 왜 필요했나
 *
 * 지금까지 알림은 **텔레그램으로만** 나갔다. 그래서 폰을 안 보고 있으면 놓치고,
 * 지나간 알림을 다시 보려면 텔레그램을 뒤져야 했다. 무엇보다 **알림에서 그 종목
 * 화면으로 갈 수가 없었다** — 코드를 눈으로 읽어 다시 검색해야 했다.
 *
 * 벤티지 요청: "종 모양 알람 표시 딱 생겨가지고 내가 누르면 알람 리스트 확인하고
 * 누르면은 그 알람이 가리키는 방향으로 갈 수 있게".
 *
 * 그래서 알림마다 **`link`(앱 안의 해시 경로)** 를 들고 다닌다. 누르면 그리로 간다.
 *
 * ## 텔레그램을 대체하지 않는다
 *
 * 둘은 역할이 다르다. 텔레그램은 **밖에 있을 때 울리는 것**이고, 여기는 **앱을 열었을
 * 때 밀린 것을 훑는 곳**이다. 그래서 같은 사건이 양쪽에 다 간다.
 *
 * ## 겹침 막기
 *
 * 같은 사건이 1분마다 다시 들어오면 알림함이 곧 쓸모없어진다. `dedupeKey` 가 같은
 * 알림이 `dedupeHours` 안에 있으면 **새로 안 넣는다.** 대신 그 알림의 시각만 올려
 * 「아직 진행 중」임을 보인다 — 지우면 목록에서 사라져 오히려 놓친다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "notices.json");

/**
 * 세 갈래 (벤티지 요청: "각 종목들의 알람도, 중요한 알람도, 시스템 알람도").
 *
 *   stock  — 어느 종목에 대한 것. 누르면 그 종목 화면으로 간다
 *   market — 시장 전체에 대한 것. 장세 변곡·수급 급변 등
 *   system — 도구 자체에 대한 것. 신호등 재점검 시점·수집 실패·설정 충돌
 */
export type NoticeKind = "stock" | "market" | "system";

/** 급함의 정도 — 화면이 색과 정렬에 쓴다 */
export type NoticeLevel = "info" | "warn" | "urgent";

export interface Notice {
  id: string;
  /** 처음 생긴 시각 (ISO) */
  at: string;
  /** 같은 사건이 계속되면 여기만 올라간다 */
  lastAt: string;
  /** 겹쳐 들어온 횟수 — 1이면 한 번만 */
  hits: number;
  kind: NoticeKind;
  level: NoticeLevel;
  title: string;
  body?: string;
  /**
   * 누르면 갈 곳 — **앱 안의 해시 경로**다 (`#/stock/005930`).
   * 밖으로 나가는 주소는 안 넣는다. 알림함은 앱 안에서 도는 자리다.
   */
  link?: string;
  code?: string;
  name?: string;
  read: boolean;
  /** 같은 사건인지 가리는 열쇠 */
  dedupeKey?: string;
}

/**
 * 최근 것만 들고 있는다. 알림함은 **밀린 것을 훑는 곳**이지 원장이 아니다 —
 * 지난 기록은 각 화면(추적기·성적표)이 자기 형식으로 들고 있다.
 */
const KEEP = 500;

let cache: Notice[] | null = null;

async function load(): Promise<Notice[]> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, "utf-8")) as Notice[];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(list: Notice[]): Promise<void> {
  cache = list;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(FILE, JSON.stringify(list), "utf-8");
}

export interface PushInput {
  kind: NoticeKind;
  level?: NoticeLevel;
  title: string;
  body?: string;
  link?: string;
  code?: string;
  name?: string;
  dedupeKey?: string;
  /** 이 시간 안에 같은 열쇠가 있으면 새로 안 넣는다 (기본 6시간) */
  dedupeHours?: number;
}

/**
 * 알림 하나를 넣는다.
 *
 * 넣었으면 그 알림을, 겹쳐서 안 넣었으면 `null` 을 돌려준다 — 부르는 쪽이
 * 「텔레그램도 같이 보낼까」를 그 값으로 정할 수 있다.
 */
export async function pushNotice(input: PushInput): Promise<Notice | null> {
  const list = await load();
  const now = new Date().toISOString();

  if (input.dedupeKey) {
    const within = (input.dedupeHours ?? 6) * 3600_000;
    const prev = list.find(
      (n) =>
        n.dedupeKey === input.dedupeKey &&
        Date.now() - new Date(n.lastAt).getTime() < within,
    );
    if (prev) {
      /*
       * 같은 사건이 이어지는 중이다. **지우고 새로 넣지 않는다** — 목록에서 잠깐
       * 사라졌다 나타나면 그 사이에 훑던 사람은 못 본다. 시각과 횟수만 올린다.
       */
      prev.lastAt = now;
      prev.hits += 1;
      await persist(list);
      return null;
    }
  }

  const n: Notice = {
    id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: now,
    lastAt: now,
    hits: 1,
    kind: input.kind,
    level: input.level ?? "info",
    title: input.title,
    body: input.body,
    link: input.link,
    code: input.code,
    name: input.name,
    read: false,
    dedupeKey: input.dedupeKey,
  };
  list.unshift(n);
  await persist(list.slice(0, KEEP));
  return n;
}

export interface ListOpts {
  limit?: number;
  kind?: NoticeKind;
  unreadOnly?: boolean;
}

export async function listNotices(opts: ListOpts = {}): Promise<{
  items: Notice[];
  unread: number;
  /** 갈래별 안 읽은 수 — 종 옆 배지를 갈래로 나눠 보일 때 */
  unreadBy: Record<NoticeKind, number>;
}> {
  const list = await load();
  const unreadBy: Record<NoticeKind, number> = { stock: 0, market: 0, system: 0 };
  for (const n of list) if (!n.read) unreadBy[n.kind] += 1;

  let items = list;
  if (opts.kind) items = items.filter((n) => n.kind === opts.kind);
  if (opts.unreadOnly) items = items.filter((n) => !n.read);
  /* 최근 것이 위 — `lastAt` 으로 정렬해야 「이어지는 중」인 알림이 위로 온다 */
  items = [...items].sort((a, b) => b.lastAt.localeCompare(a.lastAt));

  return {
    items: items.slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 200)),
    unread: unreadBy.stock + unreadBy.market + unreadBy.system,
    unreadBy,
  };
}

/** `ids` 를 읽음으로. 안 주면 **전부** 읽음으로 */
export async function markRead(ids?: string[]): Promise<number> {
  const list = await load();
  const set = ids ? new Set(ids) : null;
  let n = 0;
  for (const x of list) {
    if (x.read) continue;
    if (set && !set.has(x.id)) continue;
    x.read = true;
    n += 1;
  }
  if (n > 0) await persist(list);
  return n;
}

/** 읽은 것만 비운다 — 안 읽은 것을 지우면 그 사건을 영영 놓친다 */
export async function clearRead(): Promise<number> {
  const list = await load();
  const keep = list.filter((n) => !n.read);
  const removed = list.length - keep.length;
  if (removed > 0) await persist(keep);
  return removed;
}
