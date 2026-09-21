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
  /** 전날 저녁에 알릴까 — 준비할 시간을 준다 */
  dayBefore: boolean;
  /** 전날 알림을 몇 시에 (KST) */
  dayBeforeHour: number;
  /** 당일 아침에 알릴까 — 전날 알림은 자고 나면 흐려진다 */
  sameDay: boolean;
  /** 당일 알림을 몇 시에 (KST) */
  sameDayHour: number;
  /** 어느 갈래를 알릴까 — 비면 전부 */
  kinds: EventKind[];
  /** 텔레그램으로도 보낼까 (알림 센터에는 늘 남는다) */
  telegram: boolean;
}

/**
 * 시각·갈래의 **판 번호** (2026-09-22).
 *
 * 저장 파일(`data/calendarAlert.json`)이 기본값을 덮으므로, 기본값만 고치면 이미 돌던 서버는
 * 옛 시각 그대로다. 판이 오르면 **시각과 갈래를 한 번** 새 기본값으로 옮긴다 — 그 뒤에 벤티지가
 * 화면에서 바꾼 것은 그대로 지킨다(판 번호가 같으면 안 건드린다).
 */
const SCHED_VER = 2;

export const DEFAULT_CONFIG: CalendarAlertConfig = {
  enabled: true,
  dayBefore: true,
  /*
   * 20시 — **장마감(애프터 20:00) 직후.** 벤티지: "오전 6시랑 장마감 8시에 일정이랑 이벤트 관련
   * 메시지 좀 보내줄래?" (예전엔 18시였다 — 애프터마켓이 생기기 전 「장 끝나고」의 뜻이었다)
   */
  dayBeforeHour: 20,
  sameDay: true,
  /* 6시 — 아침에 눈 뜨자마자. 개장 세 시간 전이라 준비할 시간이 있다 (예전엔 8시) */
  sameDayHour: 6,
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
      /* 한 번만 — 저장된 옛 시각(18시·8시)을 새 기본값으로 옮긴다. 아래 `save` 가 판 번호를 박는다 */
      config.dayBeforeHour = DEFAULT_CONFIG.dayBeforeHour;
      config.sameDayHour = DEFAULT_CONFIG.sameDayHour;
      config.kinds = DEFAULT_CONFIG.kinds;
    }
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
    dayBefore: typeof patch.dayBefore === "boolean" ? patch.dayBefore : s.config.dayBefore,
    dayBeforeHour: num(patch.dayBeforeHour, 0, 23, s.config.dayBeforeHour),
    sameDay: typeof patch.sameDay === "boolean" ? patch.sameDay : s.config.sameDay,
    sameDayHour: num(patch.sameDayHour, 0, 23, s.config.sameDayHour),
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
  const rounds: { when: "before" | "today"; on: boolean; date: string; head: string }[] = [
    {
      when: "before",
      on: s.config.dayBefore && (force || hour === s.config.dayBeforeHour),
      date: tomorrow,
      head: `🌙 <b>내일 일정·이벤트</b> <i>(${tomorrow.slice(5)})</i>`,
    },
    {
      when: "today",
      on: s.config.sameDay && (force || hour === s.config.sameDayHour),
      date: today,
      head: `🌅 <b>오늘 일정·이벤트</b> <i>(${today.slice(5)})</i>`,
    },
  ];

  for (const r of rounds) {
    if (!r.on) continue;
    const rows = all.filter((e) => e.date === r.date && want(e) && !seen.has(`${e.id}:${r.when}`));
    /*
     * **일정이 없는 날도 한 줄은 보낸다** (2026-09-22 — 벤티지: "우리 키워드 채널에는 왜 아무것도 안와?").
     *
     * 예전엔 0건이면 그냥 넘어갔다. 그런데 그러면 **「오늘은 일정이 없다」와 「알림이 고장 났다」가
     * 화면에서 똑같이 보인다.** 실제로 그 방이 한 달 동안 조용했는데 아무도 고장인 줄 몰랐다.
     * 하루 한 줄은 「살아 있다」는 신호이기도 하다.
     *
     * 단, 이미 그날 것을 보낸 뒤(전부 `seen`)라면 조용히 넘어간다 — 5분 틱마다 「없음」이 가면 안 된다.
     */
    const noneKey = `none:${r.when}:${r.date}`;
    const already = all.some((e) => e.date === r.date && want(e) && seen.has(`${e.id}:${r.when}`));
    if (rows.length === 0 && (already || seen.has(noneKey))) continue;

    const body = rows.length > 0 ? rows.map(line).join("\n") : "적힌 일정이 없습니다.";
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
      dedupeKey: `calendar:${r.when}:${r.date}`,
      dedupeHours: 20,
    }).catch(() => undefined);

    if (s.config.telegram) {
      /* 「일정/이벤트」 방으로 (2026-09-22) — 전용 키가 없으면 이름만 바꾼 옛 키워드 방으로 간다 */
      const r2 = await sendTelegram(`${r.head}\n\n${body}`, "calendar").catch(() => ({ ok: false, error: "던짐" }));
      if (!r2.ok) {
        console.warn(`[calendar] ${r.when} 일정 ${rows.length}건 텔레그램 실패 — 도장 안 찍는다. 다음 틱에 다시 (${r2.error ?? ""})`);
        continue;
      }
    }

    for (const e of rows) {
      s.sent.push(`${e.id}:${r.when}`);
      seen.add(`${e.id}:${r.when}`);
    }
    /* 「없음」도 도장을 찍는다 — 안 그러면 5분 틱마다 「없습니다」가 간다 */
    if (rows.length === 0) {
      s.sent.push(noneKey);
      seen.add(noneKey);
    }
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
