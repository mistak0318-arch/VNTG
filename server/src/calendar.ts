import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, "..", "data", "calendar.json");

/**
 * 캘린더 — 증시 일정과 개인 일정을 한 곳에서 본다.
 *
 * 구글 캘린더 연동은 나중에 iCal 읽기 전용으로 붙일 예정이라(OAuth는 과함),
 * 지금은 직접 입력만 다룬다. 저장은 로컬 JSON.
 */

export type EventKind = "market" | "personal" | "earnings" | "holiday";

export const EVENT_KINDS: { key: EventKind; label: string }[] = [
  { key: "market", label: "증시 일정" },
  { key: "earnings", label: "실적 발표" },
  { key: "holiday", label: "휴장일" },
  { key: "personal", label: "개인 일정" },
];

/** 반복 주기 — date 를 앵커로 그 뒤로 되풀이된다 (2026-08-27 전면 개편) */
export type RepeatKind = "weekly" | "monthly" | "yearly";

export interface CalendarEvent {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm — 없으면 종일 일정 */
  time?: string;
  title: string;
  kind: EventKind;
  memo?: string;
  /** 어디서 왔는지. 직접 입력은 없음, 가져온 일정은 "ics:<url>" / "file:<이름>" */
  source?: string;
  /** 반복 — date 가 첫 회다. 조회 시 인스턴스로 전개된다 */
  repeat?: RepeatKind;
  /** 할 일 — 달력에 뜨되 체크로 끝내는 것. 반복과는 함께 못 쓴다 */
  todo?: boolean;
  /** 할 일 완료 */
  done?: boolean;
  /** (전개 인스턴스에만) 원본의 날짜 — 수정 폼이 앵커를 보여줄 때 쓴다 */
  anchor?: string;
}

/**
 * 반복 일정을 기간 [from, to] 의 실제 날짜들로 편다.
 *
 * 저장은 원본 한 건이고 조회가 전개한다 — 반복을 저장 시점에 복제하면
 * 「이 반복을 고친다」가 수십 건 수정이 된다. 인스턴스 id 는 `원본id@날짜`,
 * 수정·삭제는 어느 인스턴스로 와도 원본으로 간다(updateEvent 가 @ 앞을 쓴다).
 */
function expandRepeats(items: CalendarEvent[], from: string, to: string): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const e of items) {
    if (!e.repeat) {
      if (e.date >= from && e.date <= to) out.push(e);
      continue;
    }
    const [ay, am, ad] = e.date.split("-").map(Number);
    const anchorDow = new Date(Date.UTC(ay, am - 1, ad)).getUTCDay();
    // 기간을 하루씩 걷는다 — 조회 창이 한 달~석 달이라 이게 제일 단순하고 안 틀린다
    const start = new Date(`${from < e.date ? e.date : from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    for (let d = start; d <= end; d = new Date(d.getTime() + 86400_000)) {
      const ds = d.toISOString().slice(0, 10);
      const [, m, day] = ds.split("-").map(Number);
      const hit =
        e.repeat === "weekly"
          ? d.getUTCDay() === anchorDow
          : e.repeat === "monthly"
            ? day === ad // 31일 앵커는 없는 달을 자연히 건너뛴다
            : m === am && day === ad;
      if (!hit) continue;
      out.push(ds === e.date ? e : { ...e, id: `${e.id}@${ds}`, date: ds, anchor: e.date });
    }
  }
  return out;
}

let cache: CalendarEvent[] | null = null;

/** 매년 반복되는 국내 증시 고정 일정. 처음 실행할 때 씨앗으로 넣어둔다. */
function seedEvents(year: number): CalendarEvent[] {
  const mk = (date: string, title: string, kind: EventKind, memo = ""): CalendarEvent => ({
    id: `seed_${date}_${title}`,
    date,
    title,
    kind,
    memo,
  });
  // 네 번째 목요일 = 선물옵션 동시만기(쿼드러플 위칭)
  const quad: string[] = [];
  for (const m of [3, 6, 9, 12]) {
    const d = new Date(Date.UTC(year, m - 1, 1));
    let count = 0;
    while (d.getUTCMonth() === m - 1) {
      if (d.getUTCDay() === 4) {
        count += 1;
        if (count === 2) break; // 두 번째 목요일
      }
      d.setUTCDate(d.getUTCDate() + 1);
    }
    quad.push(d.toISOString().slice(0, 10));
  }
  return [
    ...quad.map((d) => mk(d, "선물옵션 동시만기", "market", "변동성이 커지는 날")),
    mk(`${year}-01-01`, "신정 휴장", "holiday"),
    mk(`${year}-05-01`, "근로자의날 휴장", "holiday"),
    mk(`${year}-12-31`, "연말 휴장", "holiday"),
  ];
}

async function load(): Promise<CalendarEvent[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    cache = Array.isArray(parsed) ? (parsed as CalendarEvent[]) : [];
  } catch {
    // 처음 실행이면 올해 고정 일정을 넣어둔다
    cache = seedEvents(new Date().getFullYear());
    await persist(cache);
  }
  return cache;
}

async function persist(items: CalendarEvent[]): Promise<void> {
  cache = items;
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(items, null, 2), "utf-8");
}

function newId(): string {
  return `ev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** month는 "YYYY-MM" — 지정하면 반복 일정을 그 달의 인스턴스로 편다. 없으면 원본 전체 */
export async function listEvents(month?: string): Promise<CalendarEvent[]> {
  const items = await load();
  const filtered = month ? expandRepeats(items, `${month}-01`, `${month}-31`) : items;
  return [...filtered].sort((a, b) => (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")));
}

/** 오늘 이후로 다가오는 일정 (알림·리포트용) */
export async function upcomingEvents(days = 14): Promise<CalendarEvent[]> {
  const items = await load();
  /*
   * ⚠️ KST 로 잰다 (2026-08-27). toISOString 은 UTC 라 **자정~아침 9시 사이에는
   * 어제 날짜**가 나온다 — 그 시간대에 "다가오는 일정"에 어제 것이 끼고,
   * 정작 오늘 것이 리포트에서 하루 늦게 빠지는 미묘한 어긋남이 있었다.
   */
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const until = new Date(Date.now() + 9 * 3600_000 + days * 86400_000).toISOString().slice(0, 10);
  return expandRepeats(items, today, until).sort((a, b) =>
    (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")),
  );
}

export async function addEvent(e: Omit<CalendarEvent, "id">): Promise<CalendarEvent[]> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(e.date)) throw new Error("날짜 형식이 올바르지 않습니다.");
  if (!e.title.trim()) throw new Error("일정 제목을 입력하세요.");
  const items = await load();
  await persist([...items, { ...e, id: newId(), title: e.title.trim() }]);
  return listEvents();
}

export async function updateEvent(id: string, patch: Partial<CalendarEvent>): Promise<CalendarEvent[]> {
  const baseId = id.split("@")[0]; // 반복 인스턴스로 와도 원본을 고친다
  const items = await load();
  await persist(
    items.map((e) => (e.id === baseId ? { ...e, ...patch, id: e.id, anchor: undefined } : e)),
  );
  return listEvents();
}

export async function removeEvent(id: string): Promise<CalendarEvent[]> {
  const baseId = id.split("@")[0]; // 반복 인스턴스를 지우면 반복 전체가 지워진다
  const items = await load();
  await persist(items.filter((e) => e.id !== baseId));
  return listEvents();
}


// ---------------------------------------------------------------- 외부 가져오기

/**
 * 같은 source로 들어온 기존 일정을 지우고 새로 넣는다.
 * 구독 주소를 다시 동기화해도 중복이 쌓이지 않고, 직접 입력한 일정은 건드리지 않는다.
 */
export async function replaceBySource(
  source: string,
  incoming: Omit<CalendarEvent, "id">[],
): Promise<{ events: CalendarEvent[]; added: number; removed: number }> {
  const items = await load();
  const kept = items.filter((e) => e.source !== source);
  const removed = items.length - kept.length;
  const added = incoming.map((e) => ({ ...e, id: newId(), source }));
  await persist([...kept, ...added]);
  return { events: await listEvents(), added: added.length, removed };
}

/** 가져온 일정 전체 삭제 (직접 입력분은 유지) */
export async function clearSource(source: string): Promise<CalendarEvent[]> {
  const items = await load();
  await persist(items.filter((e) => e.source !== source));
  return listEvents();
}

/** 등록된 소스 목록과 각 건수 */
export async function listSources(): Promise<{ source: string; count: number }[]> {
  const items = await load();
  const m = new Map<string, number>();
  for (const e of items) {
    if (!e.source) continue;
    m.set(e.source, (m.get(e.source) ?? 0) + 1);
  }
  return [...m.entries()].map(([source, count]) => ({ source, count }));
}
