import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EditionKey } from "./reportStore.js";

/**
 * 리포트 발행 일정 설정.
 *
 * 07/12/18시 세 판은 코드에 박혀 있었다. 그러면 발행 시각을 바꿔보려 해도,
 * 지금 당장 한 판을 더 내보려 해도 코드를 고쳐야 한다 — 테스트조차 못 한다.
 *
 * 그래서 판을 **설정 파일에서 읽는다.** 개수 제한도 없앴다.
 * 다만 판마다 프롬프트가 다르므로(`kind`) 그건 정해진 넷 중에서 고르게 한다:
 *   morning  — 개장 전 브리핑 (간밤 해외 중심, 당일 시세를 말하지 않는다)
 *   intraday — 장중
 *   closing  — 마감 후 총평
 *   weekend  — 휴장일 뉴스 정리
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "reportSchedule.json");

export type EditionKind = "morning" | "intraday" | "closing" | "weekend";

export interface EditionSlot {
  /** 저장 파일명과 주소에 쓰는 식별자. 영문/숫자/하이픈만 */
  id: string;
  /** 화면에 보이는 이름 */
  label: string;
  hour: number;
  minute: number;
  /** 어떤 프롬프트로 쓸지 */
  kind: EditionKind;
  enabled: boolean;
  /**
   * 언제 내는가.
   * weekday — 평일에만 (장이 서는 날)
   * weekend — 토·일에만
   * always  — 매일
   */
  days: "weekday" | "weekend" | "always";
  /** 발행 후 텔레그램·메일로 보낼지 */
  deliver: boolean;
}

export interface ReportSchedule {
  slots: EditionSlot[];
}

/** 지금까지 동작하던 것과 같은 구성 — 설정 파일이 없으면 이걸 쓴다 */
export const DEFAULT_SCHEDULE: ReportSchedule = {
  slots: [
    { id: "morning", label: "조간", hour: 7, minute: 0, kind: "morning", enabled: true, days: "weekday", deliver: true },
    { id: "midday", label: "장중", hour: 12, minute: 0, kind: "intraday", enabled: true, days: "weekday", deliver: true },
    { id: "closing", label: "석간", hour: 18, minute: 0, kind: "closing", enabled: true, days: "weekday", deliver: true },
    { id: "weekend", label: "주말", hour: 9, minute: 0, kind: "weekend", enabled: true, days: "weekend", deliver: true },
  ],
};

function clampInt(v: unknown, min: number, max: number, fallback: number): number {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

/** 파일명에 그대로 쓰이므로 경로를 벗어나는 문자를 막는다 */
function safeId(v: unknown): string {
  return String(v ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
    .slice(0, 24);
}

function normalize(input: unknown): ReportSchedule {
  const raw = (input as ReportSchedule)?.slots;
  if (!Array.isArray(raw)) return DEFAULT_SCHEDULE;

  const seen = new Set<string>();
  const slots: EditionSlot[] = [];
  for (const s of raw) {
    const id = safeId(s?.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const kind = (["morning", "intraday", "closing", "weekend"] as const).includes(s?.kind)
      ? (s.kind as EditionKind)
      : "intraday";
    const days = (["weekday", "weekend", "always"] as const).includes(s?.days)
      ? (s.days as EditionSlot["days"])
      : "weekday";
    slots.push({
      id,
      label: String(s?.label ?? id).trim().slice(0, 20) || id,
      hour: clampInt(s?.hour, 0, 23, 7),
      minute: clampInt(s?.minute, 0, 59, 0),
      kind,
      enabled: s?.enabled !== false,
      days,
      deliver: s?.deliver !== false,
    });
  }
  if (slots.length === 0) return { slots: [] };
  // 시각 순으로 정렬해 두면 화면에서도, 스케줄러에서도 읽기 쉽다
  slots.sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
  return { slots };
}

let cache: ReportSchedule | null = null;

export async function getSchedule(): Promise<ReportSchedule> {
  if (cache) return cache;
  try {
    cache = normalize(JSON.parse(await readFile(FILE, "utf-8")));
  } catch {
    cache = DEFAULT_SCHEDULE;
  }
  return cache;
}

export async function saveSchedule(input: unknown): Promise<ReportSchedule> {
  const next = normalize(input);
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  cache = next;
  return next;
}

/** 오늘(요일) 내야 하는 판만 */
export function slotsForDay(schedule: ReportSchedule, date: Date): EditionSlot[] {
  const day = date.getDay();
  const weekend = day === 0 || day === 6;
  return schedule.slots.filter((s) => {
    if (!s.enabled) return false;
    if (s.days === "always") return true;
    return s.days === "weekend" ? weekend : !weekend;
  });
}

/** 지금 시각 기준으로 가장 최근에 지난 판. 화면이 기본으로 열어줄 판을 고를 때 쓴다 */
export function currentSlot(schedule: ReportSchedule, date: Date): EditionSlot | null {
  const today = slotsForDay(schedule, date);
  const mins = date.getHours() * 60 + date.getMinutes();
  const passed = today.filter((s) => s.hour * 60 + s.minute <= mins);
  // 아직 첫 판 시각도 안 됐으면 그날의 첫 판을 보여준다 (빈 화면보다 낫다)
  return passed[passed.length - 1] ?? today[0] ?? null;
}

/** reportStore가 쓰는 키 타입으로 (파일명 용도) */
export function toEditionKey(slot: EditionSlot): EditionKey {
  return slot.id as EditionKey;
}
