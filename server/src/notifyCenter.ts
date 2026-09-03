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
const CFG_FILE = join(DATA_DIR, "noticeConfig.json");

/**
 * **출처별 켬/끔** (2026-09-02).
 *
 * 저장에 없는 출처는 `NOTICE_SOURCES` 의 기본값을 따른다 — 나중에 출처가 늘어도
 * 옛 설정 파일이 그걸 「꺼짐」으로 만들지 않는다. 여기 목록에 한 줄 더하면
 * 화면까지 저절로 붙는다.
 */
export type NoticeConfig = Partial<Record<NoticeSource, boolean>>;

let cfgCache: NoticeConfig | null = null;

export async function getNoticeConfig(): Promise<Record<NoticeSource, boolean>> {
  if (!cfgCache) {
    try {
      cfgCache = JSON.parse(await fs.readFile(CFG_FILE, "utf-8")) as NoticeConfig;
    } catch {
      cfgCache = {};
    }
  }
  const out = {} as Record<NoticeSource, boolean>;
  for (const s of NOTICE_SOURCES) out[s.key] = cfgCache[s.key] ?? s.def;
  return out;
}

export async function saveNoticeConfig(patch: NoticeConfig): Promise<Record<NoticeSource, boolean>> {
  const cur = await getNoticeConfig();
  const next: NoticeConfig = {};
  for (const s of NOTICE_SOURCES) {
    next[s.key] = typeof patch[s.key] === "boolean" ? (patch[s.key] as boolean) : cur[s.key];
  }
  cfgCache = next;
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(CFG_FILE, JSON.stringify(next, null, 2), "utf-8");
  return getNoticeConfig();
}

/**
 * 세 갈래 (벤티지 요청: "각 종목들의 알람도, 중요한 알람도, 시스템 알람도").
 *
 *   stock  — 어느 종목에 대한 것. 누르면 그 종목 화면으로 간다
 *   market — 시장 전체에 대한 것. 장세 변곡·수급 급변 등
 *   system — 도구 자체에 대한 것. 신호등 재점검 시점·수집 실패·설정 충돌
 */
export type NoticeKind = "stock" | "market" | "system";

/**
 * **알림의 출처** (2026-09-02) — 벤티지: "알림센터 전용 설정 메뉴 좀 만들어줄래?
 * 알림센터에서 받을만한 것들 좀 추리고 on off 할수있는 구조로 가자"
 *
 * `kind`(stock/market/system) 는 **성격**이지 출처가 아니다. system 하나에 마감 뒤
 * 정리·표본·원장·신호등 분석이 다 들어 있어서, 그걸로는 「표본 알림만 끄기」가 안 된다.
 *
 * 끄고 켜려면 **어디서 왔는지**를 알아야 한다. 부르는 쪽이 자기 이름을 적는다.
 */
export type NoticeSource =
  | "stockSignal"
  | "disclosure"
  | "calendar"
  | "report"
  | "regime"
  | "sample"
  | "afterClose"
  | "listTrack"
  | "ledger"
  | "keyword"
  | "superSignal"
  | "live"
  | "stopWatch"
  | "etc";

/**
 * 화면이 그리는 목록 — **하드코딩하면 서버와 갈린다.**
 *
 * 「기본으로 켤까」도 여기 있다. 매매에 바로 쓰는 것(급변·공시·일정)은 켜고,
 * 진행 상황을 알리는 것(표본 만드는 중 같은)은 꺼 둔다 — 그건 설정 화면에서
 * 눌러 본 사람이 결과를 보러 오는 자리라 알림까지 필요하지 않다.
 */
/**
 * **묶음** (2026-09-02) — 벤티지: "알림영역에서 보여주는 카테고리도 좀 넣던지
 * 해야겠네. 근데 또 너무 많으면 안되니깐 적절하게"
 *
 * 출처가 열넷이 되면 설정 목록이 그냥 긴 줄이 된다. 셋으로 묶는다 —
 * **더 쪼개면 묶는 뜻이 없고, 덜 쪼개면 지금과 같다.**
 *
 *   내 종목   내가 담은 것에서 일어난 일 — 이게 제일 급하다
 *   시장      전체 시장·일정·리포트
 *   시스템    앱이 스스로 돌린 배치의 결과
 *
 * ⚠️ `NoticeKind`(stock/market/system)와 이름이 겹치지만 **다른 것**이다.
 * kind 는 알림 한 줄의 성격이고 이건 설정 화면의 묶음이다. 대개 같은 값이
 * 되지만 반드시 그런 것은 아니다 — 예를 들어 「신호등 분석 결과」는 성격이
 * system 인데 묶음은 「내 종목」에 두는 편이 찾기 쉽다.
 */
export type NoticeGroup = "mine" | "news" | "signal" | "market" | "system";

/**
 * 알림함 **탭**이자 설정 **묶음** — 둘을 같은 것으로 둔다.
 *
 * 벤티지: "지금 알림 대분류가 4개인데 이걸 6개 정도로 만들면 효율적으로
 * 배치할 수 있지 않을까"
 *
 * 맞다. 예전 넷(전체·종목·시장·시스템)은 `NoticeKind` 를 그대로 쓴 것인데,
 * **「시스템」 하나에 마감 뒤 정리·표본·원장·신호등 분석이 다 들어갔다.**
 * 매일 도는 배치 소식에 신호등 편입이 묻힌다.
 *
 * 「전체」까지 여섯이다:
 *
 *   내 종목   급변·실시간·손절 — 지금 내 돈이 걸린 것
 *   공시·언급  DART 공시와 채널 키워드 — 밖에서 온 소식
 *   신호등    편입·이탈·분석·장세 — 이 앱이 판단한 것
 *   시장      일정·리포트
 *   시스템    배치 결과
 *
 * 「내 종목」과 「공시·언급」을 가른 이유는 **급함이 다르기** 때문이다. 급변은
 * 지금 봐야 하고 공시는 읽고 판단할 시간이 있다.
 *
 * 설정 묶음도 같은 다섯을 쓴다 — 탭과 설정이 다르면 「이 탭을 끄려면 어디를
 * 눌러야 하나」가 안 보인다.
 */
export const NOTICE_GROUPS: { key: NoticeGroup; label: string }[] = [
  { key: "mine", label: "내 종목" },
  { key: "news", label: "공시·언급" },
  { key: "signal", label: "신호등" },
  { key: "market", label: "시장" },
  { key: "system", label: "시스템" },
];

export const NOTICE_SOURCES: {
  key: NoticeSource;
  group: NoticeGroup;
  label: string;
  hint: string;
  def: boolean;
}[] = [
  {
    key: "stockSignal",
    group: "mine",
    label: "관심종목 급변",
    hint: "급변·거래량 급증·수급 전환·신고가·정배열·VI·체결강도·거래원 이탈 (5분마다)",
    def: true,
  },
  { key: "disclosure", group: "news", label: "관심종목 공시", hint: "DART 공시 — 뉴스보다 빠르다 (10분마다)", def: true },
  { key: "calendar", group: "market", label: "캘린더 일정", hint: "전날 18시·당일 8시", def: true },
  { key: "report", group: "market", label: "리포트 발행", hint: "조간·장중·석간 데일리 리포트", def: true },
  { key: "regime", group: "signal", label: "장세 점검", hint: "시장 폭·신고가가 문턱에 걸렸을 때", def: true },
  { key: "listTrack", group: "signal", label: "신호등 분석 결과", hint: "매일 편입·이탈 요약", def: true },
  {
    key: "afterClose",
    group: "system",
    label: "마감 뒤 정리",
    hint: "밤 배치가 시작할 때(무엇을 돌리는지)와 끝날 때(아홉 단계의 성공·실패 요약)",
    def: true,
  },
  {
    key: "sample",
    group: "system",
    label: "검증 표본",
    hint: "표본을 다시 만들 때 — 진행 상황이라 꺼 둬도 됩니다",
    def: false,
  },
  { key: "ledger", group: "system", label: "원장 선 긋기", hint: "기준이 바뀌어 원장을 새로 시작할 때", def: true },
  {
    key: "keyword",
    group: "news",
    label: "키워드 감지",
    hint: "텔레그램 채널에서 내 키워드·관심종목·태그 이름이 언급됐을 때 (5분마다)",
    def: true,
  },
  {
    key: "superSignal",
    group: "signal",
    label: "슈퍼신호등 편입·이탈",
    hint: "여러 목록에 동시에 걸린 초록이 새로 담기거나 빠질 때",
    def: true,
  },
  {
    key: "live",
    group: "mine",
    label: "실시간 (VI·체결강도)",
    hint: "변동성완화장치 발동과 체결강도 급변 — 실시간 소켓에서 바로 온다",
    def: true,
  },
  {
    key: "stopWatch",
    group: "mine",
    label: "손절선 감시",
    hint: "적어 둔 손절선이 깨졌을 때",
    def: true,
  },
  { key: "etc", group: "system", label: "그 밖에", hint: "출처를 안 적은 알림", def: true },
];

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
  /** 어디서 온 알림인가 (2026-09-02) — 옛 알림에는 없다 */
  source?: NoticeSource;
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

/**
 * **종목 딥링크** (2026-09-03) — 알림의 「바로가기」가 그 종목 분석 화면으로 가게.
 * 화면 라우터(`useHashRoute`) 형식이 `#/{tab}?code=&name=` 이다. 예전엔 `#/watchlist` 처럼
 * **앱에 없는 탭**으로 보내서 눌러도 아무 일이 없었다 — 벤티지: "아무 반응도 없어 지금."
 */
export function stockLink(code: string, name: string): string {
  const q = new URLSearchParams({ code, name });
  return `#/stockAnalysis?${q.toString()}`;
}

export interface PushInput {
  kind: NoticeKind;
  /** 어디서 온 알림인가 — 안 주면 `etc`. 설정에서 이 단위로 끈다 */
  source?: NoticeSource;
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
  /*
   * **꺼 놓은 출처는 담지 않는다.**
   *
   * 담아 두고 화면에서 가리는 방법도 있지만 그러면 「읽지 않음」 배지가 계속
   * 붙는다 — 끈 것이 배지로 셈해지면 끈 뜻이 없다. 아예 안 담는다.
   *
   * ⚠️ 텔레그램은 여기서 안 막는다. 부르는 쪽이 따로 보내고, 방마다 켜고 끄는
   * 자리가 이미 있다 — 두 곳에서 같은 것을 막으면 왜 안 오는지 못 찾는다.
   */
  const src = input.source ?? "etc";
  const cfg = await getNoticeConfig();
  if (!cfg[src]) return null;

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
  /** 묶음으로 거른다 (2026-09-02) — 화면 탭이 이걸 쓴다 */
  group?: NoticeGroup;
  unreadOnly?: boolean;
}

/**
 * 이 알림이 어느 묶음인가.
 *
 * ⚠️ **옛 알림에는 `source` 가 없다**(2026-09-02 이전 것). 그때는 `kind` 로
 * 물러선다 — 없는 것을 「그 밖에」로 몰면 옛 알림이 통째로 한 탭에 쌓인다.
 */
function groupOf(n: Notice): NoticeGroup {
  if (n.source) {
    const hit = NOTICE_SOURCES.find((s) => s.key === n.source);
    if (hit) return hit.group;
  }
  return n.kind === "stock" ? "mine" : n.kind === "market" ? "market" : "system";
}

export async function listNotices(opts: ListOpts = {}): Promise<{
  items: Notice[];
  unread: number;
  /** 갈래별 안 읽은 수 — 종 옆 배지를 갈래로 나눠 보일 때 */
  unreadBy: Record<NoticeKind, number>;
  /** 묶음별 안 읽은 수 — 탭 옆 배지 */
  unreadByGroup: Record<NoticeGroup, number>;
}> {
  const list = await load();
  const unreadBy: Record<NoticeKind, number> = { stock: 0, market: 0, system: 0 };
  const unreadByGroup = {} as Record<NoticeGroup, number>;
  for (const g of NOTICE_GROUPS) unreadByGroup[g.key] = 0;
  for (const n of list) {
    if (n.read) continue;
    unreadBy[n.kind] += 1;
    unreadByGroup[groupOf(n)] += 1;
  }

  let items = list;
  if (opts.kind) items = items.filter((n) => n.kind === opts.kind);
  if (opts.group) items = items.filter((n) => groupOf(n) === opts.group);
  if (opts.unreadOnly) items = items.filter((n) => !n.read);
  /* 최근 것이 위 — `lastAt` 으로 정렬해야 「이어지는 중」인 알림이 위로 온다 */
  items = [...items].sort((a, b) => b.lastAt.localeCompare(a.lastAt));

  return {
    items: items.slice(0, Math.min(Math.max(opts.limit ?? 50, 1), 200)),
    unread: unreadBy.stock + unreadBy.market + unreadBy.system,
    unreadBy,
    unreadByGroup,
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
