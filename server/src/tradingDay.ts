/**
 * **거래일 판정** (2026-09-10 전수 점검 A).
 *
 * 스케줄러 열셋이 저마다 `getDay()` 로 주말만 걸렀다 — 추석·개천절·성탄절엔 전부
 * 돌아서, 키움이 준 **직전 거래일 값**을 그날 것으로 적었다(주도주 「사흘 연속」 부풀림,
 * 슈퍼신호등 「오늘 없음」 헛줄, 마감 뒤 정리 두 시간 헛돎).
 *
 * 세 겹으로 거른다:
 *   · 토·일
 *   · 아래 KRX 휴장 목록 (orders.ts 의 것과 같은 표 — 그쪽은 주문 모듈이라 끌어오지 않는다)
 *   · `data/calendar.json` 의 한투 휴장일(`source: "hantoo:holiday"`) — 켤 때 한 번, 6시간마다
 *
 * 판정은 **동기**다 — 스케줄러 tick 마다 파일을 읽지 않는다. process.env.TZ 가 Asia/Seoul
 * 이므로 `getDay()`·`getFullYear()` 가 곧 KST 다.
 */
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALENDAR_FILE = resolve(__dirname, "..", "data", "calendar.json");
const HOLIDAY_SOURCE = "hantoo:holiday";
const REFRESH_MS = 6 * 3600_000;

/** orders.ts `KRX_HOLIDAYS` 와 같은 표 — 바꿀 때 둘 다 */
const KRX_HOLIDAYS = new Set([
  "2026-09-24", "2026-09-25", // 추석
  "2026-10-05", // 개천절 대체휴일
  "2026-10-09", // 한글날
  "2026-12-25", // 성탄절
  "2026-12-31", // 연말 휴장
  "2027-01-01",
]);

/** 한투 달력에서 읽은 휴장일 — 동기 판정을 위해 메모리에 든다 */
const hantooHolidays = new Set<string>();
let loaded = false;
let loading: Promise<void> | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

async function loadHantooHolidays(): Promise<void> {
  try {
    const raw = await readFile(CALENDAR_FILE, "utf8");
    const rows = JSON.parse(raw) as { date?: string; source?: string; kind?: string }[];
    const next = new Set<string>();
    for (const r of Array.isArray(rows) ? rows : []) {
      /* 한투 휴장일 + 씨앗·손으로 넣은 kind:"holiday" 도 휴장이다 (신정·근로자의날·연말 씨앗) */
      if ((r?.source === HOLIDAY_SOURCE || r?.kind === "holiday") && typeof r.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) next.add(r.date);
    }
    hantooHolidays.clear();
    for (const d of next) hantooHolidays.add(d);
    loaded = true;
  } catch {
    /* 파일이 없으면 하드코딩 표만으로 간다 */
  }
}

/** 모듈이 실리는 순간 한 번 읽고 6시간마다 다시 — index.ts 를 안 건드리려고 아래에서 스스로 부른다 */
export function startTradingDayCalendar(): void {
  if (refreshTimer) return;
  void ensureLoaded();
  refreshTimer = setInterval(() => void loadHantooHolidays(), REFRESH_MS);
  refreshTimer.unref?.();
}

function ensureLoaded(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (!loading) loading = loadHantooHolidays().finally(() => { loading = null; });
  return loading;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** YYYY-MM-DD 문자열로 판정 — 백필 루프처럼 날짜만 있을 때 */
export function isTradingDate(date: string): boolean {
  if (!loaded) void ensureLoaded();
  const d = new Date(`${date}T12:00:00+09:00`);
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  if (KRX_HOLIDAYS.has(date)) return false;
  if (hantooHolidays.has(date)) return false;
  return true;
}

/** 오늘(또는 준 시각의 KST 날짜)이 거래일인가 — 동기 */
export function isTradingDay(date: Date = new Date()): boolean {
  return isTradingDate(ymd(date));
}

/** `before` 를 **포함하지 않는** 직전 거래일 — YYYY-MM-DD */
export function lastTradingDay(before: Date = new Date()): string {
  const d = new Date(before.getTime());
  for (let i = 0; i < 30; i += 1) {
    d.setDate(d.getDate() - 1);
    const s = ymd(d);
    if (isTradingDate(s)) return s;
  }
  return ymd(d);
}

/** 거래일 기준 며칠 전인가 — `activeMeasures` 유효기간 셈용. 같은 날이면 0 */
export function tradingDaysBetween(from: string, to: string): number {
  let n = 0;
  const d = new Date(`${from}T12:00:00+09:00`);
  const end = new Date(`${to}T12:00:00+09:00`);
  for (let guard = 0; d.getTime() < end.getTime() && guard < 400; guard += 1) {
    d.setDate(d.getDate() + 1);
    if (isTradingDate(ymd(d))) n += 1;
  }
  return n;
}

/* 실리는 순간 시작 — 어느 스케줄러가 먼저 import 해도 달력이 읽힌다 */
startTradingDayCalendar();
