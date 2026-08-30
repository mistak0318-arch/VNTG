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

/**
 * 일정 종류.
 *
 * `event`(이벤트)·`conference`(학회)는 2026-08-28 에 늘렸다 — CES·GTC 같은 행사와
 * 학회 발표가 「증시」에도 「개인」에도 안 맞았다. 둘 다 종목이 움직이는 자리라
 * 뭉뚱그리면 달력에서 안 보인다.
 *
 * ⚠️ 이미 저장된 일정은 옛 넷 중 하나다. **키를 바꾸거나 지우면 안 된다.**
 */
/**
 * 일정의 갈래.
 *
 * 2026-08-30 에 증권사 리서치 캘린더(미래에셋) 양식을 참고해 넷을 더했다. 그 양식은
 * 일정마다 **분류 태그를 왼쪽에 붙여 세로로 정렬**하는데, 그러면 「오늘 회의가 몇
 * 개인가」가 훑기만 해도 보인다. 우리 갈래는 그보다 성겼다 — 「증시 일정」 하나에
 * 지표 발표·중앙은행 회의·국채 입찰·선물 만기가 다 뭉쳐 있었다.
 *
 *   indicator 공개  지표·통계 발표 (고용보고서·CPI·PMI)
 *   meeting   회의  중앙은행·정상회담 (FOMC·ECB·금통위)
 *   bond      채권  국채 입찰·발행
 *   deriv     파생  선물·옵션 만기
 *
 * `weekly` 는 성격이 다르다 — **날짜 하나에 붙는 일정이 아니라 그 주 전체의 요약**이다.
 * 리서치 캘린더가 일요일 칸을 통째로 「이번 주 핵심」에 쓰는 것과 같다. 그 주 일요일에
 * 달아 두면 주간 화면이 맨 앞에 펼친다. 새 저장소를 만들지 않은 이유는, 그러면
 * CSV·수정·삭제·동기화를 전부 두 벌로 만들어야 하기 때문이다.
 */
export type EventKind =
  | "market"
  | "personal"
  | "earnings"
  | "holiday"
  | "event"
  | "conference"
  | "indicator"
  | "meeting"
  | "bond"
  | "deriv"
  | "weekly";

export const EVENT_KINDS: { key: EventKind; label: string }[] = [
  { key: "weekly", label: "주간 핵심" },
  { key: "market", label: "증시 일정" },
  { key: "indicator", label: "지표 공개" },
  { key: "meeting", label: "회의" },
  { key: "earnings", label: "실적 발표" },
  { key: "bond", label: "채권" },
  { key: "deriv", label: "파생" },
  { key: "holiday", label: "휴장일" },
  { key: "event", label: "이벤트" },
  { key: "conference", label: "학회" },
  { key: "personal", label: "개인 일정" },
];

/**
 * 나라.
 *
 * 리서치 캘린더가 일정마다 국가를 붙이는 이유는, **같은 「고용보고서」라도 미국 것과
 * 한국 것이 시장에 주는 무게가 다르기 때문**이다. 목록에서 국가가 정렬돼 있으면
 * 「오늘 미국 것이 몇 개인가」가 바로 보인다.
 *
 * 목록에 없는 나라도 그냥 적을 수 있다 — 여기 있는 것은 **고를 수 있는 후보**일 뿐이다.
 */
export const COUNTRIES = [
  "한국",
  "미국",
  "중국",
  "일본",
  "유로존",
  "영국",
  "독일",
  "대만",
  "인도",
  "글로벌",
] as const;

/** 반복 주기 — date 를 앵커로 그 뒤로 되풀이된다 (2026-08-27 전면 개편) */
export type RepeatKind = "weekly" | "monthly" | "yearly";

export interface CalendarEvent {
  id: string;
  /** YYYY-MM-DD */
  date: string;
  /** HH:mm — 없으면 종일 일정 */
  time?: string;
  /**
   * HH:mm — 끝나는 시각 (2026-08-28).
   *
   * 없으면 **한 시간짜리로 본다** (화면에서만. 저장은 비운 채로 둔다) — 시작만 적는
   * 일정이 대부분이고, 길이를 0 으로 두면 주간 시간표에서 선 하나로 보여 안 읽힌다.
   * `time` 이 없으면(종일) 이 값도 의미가 없다.
   */
  endTime?: string;
  title: string;
  kind: EventKind;
  memo?: string;
  /** 어디서 왔는지. 직접 입력은 없음, 가져온 일정은 "ics:<url>" / "file:<이름>" */
  source?: string;
  /**
   * 원본 쪽 고유 열쇠 (2026-08-30). ICS 는 UID, CSV 는 「날짜|제목」.
   *
   * 내가 고친 일정을 동기화가 덮어쓰지 않게 하려면, 들어오는 원본과 갖고 있는 것을
   * **짝지을 수단**이 있어야 한다. 제목으로 짝지으면 제목을 고친 순간 짝이 끊긴다.
   */
  srcKey?: string;
  /**
   * 내가 손으로 고쳤나 (2026-08-30 요청 — 「어느 소스에서 왔던 내가 수정할 수 있게」).
   *
   * ⚠️ 예전엔 가져온 일정을 고쳐도 **다음 동기화에 원래대로 돌아갔다.** `replaceBySource`
   * 가 그 출처의 것을 통째로 지우고 다시 넣기 때문이다. 손으로 올리는 파일은 그나마
   * 다시 올릴 때만 그랬지만, 구독 캘린더에 자동 동기화(30분)를 붙이면서 **고쳐도
   * 삼십 분이면 사라지는** 상태가 됐다 — 고칠 수 없는 것과 같다.
   *
   * 이 표시가 붙은 것은 동기화가 건드리지 않는다.
   */
  edited?: boolean;
  /** 반복 — date 가 첫 회다. 조회 시 인스턴스로 전개된다 */
  repeat?: RepeatKind;
  /** 할 일 — 달력에 뜨되 체크로 끝내는 것. 반복과는 함께 못 쓴다 */
  todo?: boolean;
  /** 할 일 완료 */
  done?: boolean;
  /** (전개 인스턴스에만) 원본의 날짜 — 수정 폼이 앵커를 보여줄 때 쓴다 */
  anchor?: string;
  /**
   * 어느 나라 일정인가 (2026-08-30).
   *
   * 비우면 화면이 아무것도 안 보여 준다 — **모르는 것을 지어내지 않는다.**
   * 가져온 일정(구글 캘린더)에는 대개 없다.
   */
  country?: string;
  /**
   * 그날의 **대표 일정**인가 (2026-08-30).
   *
   * 리서치 캘린더는 날짜마다 굵은 제목이 하나 있고 나머지는 그 아래 목록이다.
   * 「9월 17일에 뭐가 있더라」에 답하는 것은 그 한 줄이지 열두 줄이 아니다.
   * 하루에 여럿이 켜져 있으면 화면은 **먼저 오는 것 하나만** 굵게 쓴다.
   */
  headline?: boolean;
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

/** 기간 조회 — 주·일 보기가 월 경계를 넘으므로 (2026-08-27). 반복은 기간 인스턴스로 편다 */
export async function listEventsRange(from: string, to: string): Promise<CalendarEvent[]> {
  const items = await load();
  return expandRepeats(items, from, to).sort((a, b) =>
    (a.date + (a.time ?? "")).localeCompare(b.date + (b.time ?? "")),
  );
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
    items.map((e) =>
      e.id === baseId
        ? {
            ...e,
            ...patch,
            id: e.id,
            anchor: undefined,
            /*
             * 가져온 일정이면 **손댔다고 적어 둔다** — 그래야 다음 동기화가 안 덮는다.
             * 직접 만든 일정에는 필요 없다(애초에 동기화가 안 건드린다).
             */
            ...(e.source ? { edited: true } : {}),
          }
        : e,
    ),
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

  /*
   * **내가 고친 것은 남긴다** (2026-08-30).
   *
   * 예전엔 그 출처의 것을 전부 지우고 새로 넣었다. 파일은 다시 올릴 때만 그랬지만,
   * 구독 캘린더에 자동 동기화가 붙으면서 **고쳐도 삼십 분이면 사라지는** 상태가 됐다.
   * 고칠 수 있는 것처럼 보이는데 실제로는 못 고치는 것이 제일 나쁘다.
   */
  const mine = items.filter((e) => e.source === source && e.edited);
  const kept = items.filter((e) => e.source !== source);
  const removed = items.length - kept.length - mine.length;

  /* 고쳐서 갖고 있는 것과 **같은 원본**은 다시 안 넣는다 — 넣으면 둘이 된다 */
  const held = new Set(mine.map((e) => e.srcKey).filter(Boolean) as string[]);
  const added = incoming
    .filter((e) => !(e.srcKey && held.has(e.srcKey)))
    .map((e) => ({ ...e, id: newId(), source }));

  await persist([...kept, ...mine, ...added]);
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
