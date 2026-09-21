import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EVENT_KINDS, upcomingEvents, type CalendarEvent, type EventKind } from "./calendar.js";
import { pushNotice } from "./notifyCenter.js";
import { sendTelegram } from "./telegram.js";

/**
 * **캘린더 일정 알림** (2026-09-02).
 *
 * 벤티지: "그리고 캘린더 일정도 알림으로 줘"
 *
 * 캘린더는 지금까지 **화면을 열어야만 보였다.** `pushNotice` 도 `sendTelegram` 도
 * 부르는 데가 없었다 — FOMC·CPI·선물옵션 만기를 적어 두고 그날 아침에 그 화면을
 * 열지 않으면 그냥 지나간다. 적어 두는 뜻이 없어진다.
 *
 * ## 언제 알리나 — **전날과 당일 아침**
 *
 * 두 번인 이유가 있다:
 *
 *   **전날** 저녁에 알아야 **준비**를 한다. 「내일 FOMC 니까 오늘은 크게 안 들어간다」
 *   **당일** 아침에 알아야 **잊지 않는다**. 전날 알림은 자고 나면 흐려진다
 *
 * 하나만 두면 둘 중 하나를 놓친다.
 *
 * ## ⚠️ 같은 일정을 두 번 보내지 않는다
 *
 * 5분마다 도는 스케줄러라 그냥 두면 같은 알림이 하루에 수십 번 간다. 보낸 것을
 * **일정 id + 어느 시점(전날/당일)** 으로 적어 두고 거른다.
 *
 * 알림 센터의 `dedupeKey` 도 같은 일을 하지만 그건 **화면 쪽 중복**만 막는다 —
 * 텔레그램은 그대로 나간다. 보낸 기록을 여기서 따로 들고 있어야 한다.
 *
 * ## 무엇을 알리나 — 갈래를 고른다
 *
 * 캘린더에는 「내 일정」(personal)부터 「선물옵션 만기」(market)까지 섞여 있다.
 * 사람마다 알림이 필요한 갈래가 다르므로 **켜고 끌 수 있게** 둔다. 기본은
 * 시장에 영향이 큰 것들만 — 개인 일정까지 텔레그램으로 오면 시끄럽다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "calendarAlert.json");

export interface CalendarAlertConfig {
  enabled: boolean;
  /** 몇 시에 보낼까 (KST 0~23) — 오름차순, 중복 없음 */
  hours: number[];
  /** 이 시각 판만 **내일** 것을 보낸다. 나머지는 「오늘 남은 것」 */
  tomorrowHour: number;
  /** 어느 갈래를 알릴까 — 비면 전부 */
  kinds: EventKind[];
  /** 텔레그램으로도 보낼까 (알림 센터에는 늘 남는다) */
  telegram: boolean;
}

/** 옛 판(두 회차) 설정 — 읽어서 `hours` 로 옮기기만 한다 */
interface LegacyConfig {
  dayBefore?: boolean;
  dayBeforeHour?: number;
  sameDay?: boolean;
  sameDayHour?: number;
}

/**
 * 시각·갈래의 **판 번호** (2026-09-22).
 *
 * 저장 파일(`data/calendarAlert.json`)이 기본값을 덮으므로, 기본값만 고치면 이미 돌던 서버는
 * 옛 시각 그대로다. 판이 오르면 **시각과 갈래를 한 번** 새 기본값으로 옮긴다 — 그 뒤에 벤티지가
 * 화면에서 바꾼 것은 그대로 지킨다(판 번호가 같으면 안 건드린다).
 */
const SCHED_VER = 3;

export const DEFAULT_CONFIG: CalendarAlertConfig = {
  enabled: true,
  /*
   * **하루 일곱 번** (2026-09-22 — 벤티지가 시각을 그대로 골랐다):
   *   06 기상 · 08 개장 전 · 12 점심 · 15 마감 전 · 17 마감 뒤 · 19 저녁 · 22 자기 전
   */
  hours: [6, 8, 12, 15, 17, 19, 22],
  /* 22시 판만 **내일** 것 — 자기 전에 내일을 본다. 나머지 여섯은 「오늘 남은 것」 */
  tomorrowHour: 22,
  /*
   * **개인 일정도 넣는다** (2026-09-22 — "네이버랑 **내 캘린더** 참고해서"). 구독 캘린더(ICS)로
   * 들어온 내 일정이 `personal` 이다. 휴장일(holiday)은 빼 둔다 — 그날 아침에 알려 봐야 할 게 없고,
   * 전날 판에서는 「내일 휴장」이 뜻이 있지만 증시 일정(market)에 이미 잡힌다.
   */
  kinds: ["weekly", "market", "indicator", "meeting", "earnings", "deriv", "bond", "conference", "event", "personal"],
  telegram: true,
};

interface Store {
  config: CalendarAlertConfig;
  /** 보낸 것 — `일정id:when` */
  sent: string[];
  /** 시각·갈래 기본값의 판 번호 — 오르면 한 번 옮긴다 (2026-09-22) */
  schedVer?: number;
}

const EMPTY: Store = { config: DEFAULT_CONFIG, sent: [] };

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    const config = { ...DEFAULT_CONFIG, ...(raw.config ?? {}) };
    const ver = typeof raw.schedVer === "number" ? raw.schedVer : 1;
    if (ver < SCHED_VER) {
      /*
       * 한 번만 — 옛 두 회차 설정(18시 내일 · 8시 오늘)을 새 `hours` 판으로 옮긴다.
       * 아래 `save` 가 판 번호를 박으므로 그 뒤 화면에서 바꾼 것은 그대로 지킨다.
       */
      config.hours = DEFAULT_CONFIG.hours;
      config.tomorrowHour = DEFAULT_CONFIG.tomorrowHour;
      config.kinds = DEFAULT_CONFIG.kinds;
    }
    /* 옛 필드는 버린다 — 타입에 없으니 남아 있어도 안 읽히지만 저장 파일을 깨끗이 둔다 */
    delete (config as unknown as LegacyConfig).dayBefore;
    delete (config as unknown as LegacyConfig).dayBeforeHour;
    delete (config as unknown as LegacyConfig).sameDay;
    delete (config as unknown as LegacyConfig).sameDayHour;
    config.hours = [...new Set(config.hours.filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
    return { config, sent: Array.isArray(raw.sent) ? raw.sent : [], schedVer: SCHED_VER };
  } catch {
    return { ...EMPTY, sent: [], schedVer: SCHED_VER };
  }
}

async function save(s: Store): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  /* 보낸 기록은 최근 것만 — 무한히 쌓을 이유가 없다 */
  const sent = s.sent.slice(-400);
  await writeFile(FILE, JSON.stringify({ ...s, sent }, null, 2), "utf-8");
}

export async function getCalendarAlertConfig(): Promise<CalendarAlertConfig> {
  return (await load()).config;
}

export async function saveCalendarAlertConfig(
  patch: Partial<CalendarAlertConfig>,
): Promise<CalendarAlertConfig> {
  const s = await load();
  const num = (v: unknown, lo: number, hi: number, d: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  s.config = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : s.config.enabled,
    /* 0~23 정수만, 중복 없이, 오름차순. 빈 목록은 안 받는다(그러면 영영 안 온다) */
    hours: Array.isArray(patch.hours)
      ? (() => {
          const v = [...new Set(patch.hours.map((h) => Math.round(Number(h))).filter((h) => Number.isInteger(h) && h >= 0 && h <= 23))].sort((a, b) => a - b);
          return v.length > 0 ? v : s.config.hours;
        })()
      : s.config.hours,
    tomorrowHour: num(patch.tomorrowHour, 0, 23, s.config.tomorrowHour),
    /* 아는 갈래만 받는다 — 화면이 딴 값을 보내도 저장이 오염되지 않게 */
    kinds: Array.isArray(patch.kinds)
      ? patch.kinds.filter((k) => EVENT_KINDS.some((x) => x.key === k))
      : s.config.kinds,
    telegram: typeof patch.telegram === "boolean" ? patch.telegram : s.config.telegram,
  };
  await save(s);
  return s.config;
}

const kst = (at = Date.now()): Date => {
  const d = new Date(at);
  return new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
};

const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const labelOf = (k: EventKind): string => EVENT_KINDS.find((x) => x.key === k)?.label ?? k;

/** 한 줄로 — 「09-10 15:30 선물옵션 동시만기 (증시 일정)」 */
function line(e: CalendarEvent): string {
  const when = e.time ? ` ${e.time}` : "";
  return `${e.date.slice(5)}${when} ${e.title} (${labelOf(e.kind)})`;
}

export interface CalendarAlertRun {
  checked: number;
  sent: { when: "before" | "today"; events: string[] }[];
}

/**
 * 한 번 점검한다. 스케줄러가 5분마다 부른다.
 *
 * @param force 시각 조건을 무시하고 지금 보낸다 — 화면의 「지금 보내보기」용.
 *              **보낸 기록은 그대로 지킨다**(같은 것을 두 번 보내지 않는다).
 */
export async function runCalendarAlert(force = false): Promise<CalendarAlertRun> {
  const s = await load();
  const out: CalendarAlertRun = { checked: 0, sent: [] };
  if (!s.config.enabled && !force) return out;

  const now = kst();
  const hour = now.getHours();
  const today = ymd(now);
  const tomorrow = ymd(new Date(now.getTime() + 24 * 3600_000));

  /* 이틀치면 충분하다 — 전날·당일만 알린다 */
  const all = await upcomingEvents(3).catch(() => [] as CalendarEvent[]);
  const want = (e: CalendarEvent) =>
    s.config.kinds.length === 0 || s.config.kinds.includes(e.kind);
  out.checked = all.length;

  const seen = new Set(s.sent);
  /*
   * **하루 일곱 번** (2026-09-22 — 벤티지: "오전 6시, 오전 8시, 12시, 오후 3시, 오후 5시, 오후 7시,
   * 오후 10시 이렇게 해줘"). 기상 · 개장 전 · 점심 · 마감 전 · 마감 후 · 저녁 · 자기 전이다.
   *
   * 판이 일곱이므로 **같은 일정을 일곱 번 보내면 안 된다.** 그래서 회차마다 무엇을 담을지가 다르다:
   *
   *   · 마지막 판(기본 22시) — **내일** 일정 전부. 자기 전에 내일을 본다
   *   · 그 밖 — **오늘 남은** 일정만. 시각이 지난 것은 뺀다(종일 일정은 늘 넣는다).
   *     그래서 12시 판과 19시 판의 내용이 저절로 다르다
   *
   * 중복 막기도 「일정 하나당 한 번」이 아니라 **「그날 그 시각 판을 보냈나」** 로 센다 —
   * 아니면 두 번째 판부터 늘 빈 목록이 된다.
   */
  const hours = s.config.hours.length > 0 ? s.config.hours : DEFAULT_CONFIG.hours;
  const lastHour = s.config.tomorrowHour;
  const fired = force ? hours.slice(-1) : hours.filter((h) => h === hour);
  /** 지금 시각(HH:MM) — 「남은 일정」을 가르는 잣대 */
  const nowHm = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;

  const rounds = fired.map((h) => {
    const forTomorrow = h === lastHour;
    return {
      h,
      when: (forTomorrow ? "before" : "today") as "before" | "today",
      date: forTomorrow ? tomorrow : today,
      forTomorrow,
      head: forTomorrow
        ? `🌙 <b>내일 일정·이벤트</b> <i>(${tomorrow.slice(5)})</i>`
        : `📅 <b>오늘 남은 일정·이벤트</b> <i>(${today.slice(5)} ${String(h).padStart(2, "0")}시 판)</i>`,
    };
  });

  for (const r of rounds) {
    /*
     * 한 회차는 **하루에 한 번**. 5분 틱이라 같은 시각에 열두 번 들어오므로 도장이 필요하다.
     * 일정이 없는 날도 **한 줄은 보낸다** — 예전엔 0건이면 넘어갔는데, 그러면 「일정이 없다」와
     * 「알림이 고장 났다」가 똑같이 보인다(그 방이 한 달 조용했는데 고장인 줄 몰랐다).
     */
    const slotKey = `slot:${r.date}:${r.h}`;
    if (seen.has(slotKey)) continue;
    const rows = all.filter(
      (e) => e.date === r.date && want(e) && (r.forTomorrow || !e.time || e.time >= nowHm),
    );

    /*
     * 비었을 때도 **쓸모 있는 한 줄**로. 「없습니다」만 일곱 번 오면 그건 소음이다 —
     * 다음 것이 언제인지를 같이 적어 준다.
     */
    const ahead = all.filter((e) => want(e) && (e.date > r.date || (e.date === r.date && !!e.time && e.time >= nowHm)));
    const nextOne = ahead.find((e) => e.date > r.date);
    const body =
      rows.length > 0
        ? rows.map(line).join("\n")
        : r.forTomorrow
          ? `내일은 적힌 일정이 없습니다.${nextOne ? `\n다음 일정 — ${line(nextOne)}` : ""}`
          : `오늘 남은 일정이 없습니다.${nextOne ? `\n다음 일정 — ${line(nextOne)}` : ""}`;
    /*
     * 알림 센터와 텔레그램 **둘 다**. 텔레그램은 자리를 비운 사이에 오고 알림
     * 센터는 화면에 남는다 — 서로를 대신하지 못한다(마감 뒤 정리와 같은 이유).
     */
    /*
     * **도장은 하나라도 닿은 뒤에** (2026-09-21 「조용한 건너뜀」 훑기 🟠).
     *
     * 예전엔 둘 다 `.catch(() => undefined)` 로 삼키고 **무조건** 보냄표를 찍었다. 텔레그램이 죽은
     * 시각(429·망 끊김)에 걸리면 그 일정 알림은 **영영 안 왔다** — 다시 시도할 근거가 지워지니까.
     * 오늘 `liveAlerts` 에서 고친 것과 같은 병이다. 둘 중 **하나라도 닿았으면** 찍고, 둘 다 실패하면
     * 안 찍는다(다음 틱이 다시 해 본다). 두 번 가는 것은 `dedupeKey` 가 막는다.
     */
    await pushNotice({
      source: "calendar",
      kind: "market",
      level: "info",
      title: rows.length > 0 ? `${r.when === "before" ? "내일" : "오늘"} 일정 ${rows.length}건` : `${r.when === "before" ? "내일" : "오늘"} 일정 없음`,
      body,
      link: "#/calendar",
      dedupeKey: `calendar:${r.date}:${r.h}`,
      dedupeHours: 20,
    }).catch(() => undefined);

    if (s.config.telegram) {
      /* 「일정/이벤트」 방으로 (2026-09-22) — 전용 키가 없으면 이름만 바꾼 옛 키워드 방으로 간다 */
      const r2 = await sendTelegram(`${r.head}\n\n${body}`, "calendar").catch(() => ({ ok: false, error: "던짐" }));
      if (!r2.ok) {
        console.warn(`[calendar] ${r.h}시 판 ${rows.length}건 텔레그램 실패 — 도장 안 찍는다. 다음 틱에 다시 (${r2.error ?? ""})`);
        continue;
      }
    }

    /* 회차 도장 — 「그날 그 시각 판을 보냈다」. 일정이 0건이어도 찍는다 */
    s.sent.push(slotKey);
    seen.add(slotKey);
    out.sent.push({ when: r.when, events: rows.map((e) => e.title) });
  }

  if (out.sent.length > 0) await save(s);
  return out;
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startCalendarAlertScheduler(): void {
  if (timer) return;
  const tick = () => void runCalendarAlert().catch(() => undefined);
  /* 5분마다 — 시각이 맞는 창에 들어왔을 때만 실제로 보낸다 */
  timer = setInterval(tick, 5 * 60_000);
  timer.unref?.();
  /* 켜자마자 한 번 — 서버를 그 시각에 켰으면 그날 몫이 나간다 */
  setTimeout(tick, 20_000);
  console.log("[calendar] 일정 알림 시작 — 전날 18시 · 당일 8시");
}
