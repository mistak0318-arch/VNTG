import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 텔레그램 방 재배정 (2026-08-26) — **.env 를 안 고치고 화면에서 보내는 방을 바꾼다.**
 *
 * .env 의 TELEGRAM_CHAT_ID_* 가 기본이고, 여기 저장된 배정이 있으면 그게 이긴다.
 * 「키워드를 당분간 시그널 방으로 합치자」 같은 조정을 서버 재시작 없이 하기 위한 것 —
 * 방(chat_id) 자체는 여전히 .env 가 주 명단이고, 화면에서는 **직접 chat_id 를 추가**할 수도 있다.
 *
 * ⚠️ chatIdFor(발송 경로)는 **동기**라서 이 저장소도 동기(readFileSync)로 간다.
 * 파일이 몇 줄짜리라 비용이 없고, 캐시를 둬서 발송마다 디스크를 안 읽는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "telegramRooms.json");

export interface CustomRoom {
  /** 사람이 알아보는 이름 (예: "임시 테스트방") */
  name: string;
  chatId: string;
}

export interface RoomStore {
  /** 갈래(TelegramChannel 키) → chat_id. 있으면 .env 보다 우선 */
  assign: Record<string, string>;
  /** .env 에 없는 방을 화면에서 등록한 것 */
  custom: CustomRoom[];
}

const EMPTY: RoomStore = { assign: {}, custom: [] };

let cache: RoomStore | null = null;

export function readRooms(): RoomStore {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(FILE, "utf-8")) as Partial<RoomStore>;
    cache = {
      assign: raw.assign && typeof raw.assign === "object" ? raw.assign : {},
      custom: Array.isArray(raw.custom)
        ? raw.custom.filter((c) => c && typeof c.chatId === "string")
        : [],
    };
  } catch {
    cache = { ...EMPTY, assign: {}, custom: [] };
  }
  return cache;
}

export function saveRooms(next: RoomStore): RoomStore {
  const clean: RoomStore = {
    assign: Object.fromEntries(
      Object.entries(next.assign ?? {}).filter(([, v]) => typeof v === "string" && v.trim()),
    ),
    custom: (next.custom ?? [])
      .map((c) => ({ name: String(c.name ?? "").trim(), chatId: String(c.chatId ?? "").trim() }))
      .filter((c) => c.chatId)
      .slice(0, 20),
  };
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, JSON.stringify(clean, null, 2), "utf-8");
  cache = clean;
  return clean;
}

/** 이 갈래에 화면 배정이 있으면 그 chat_id — 없으면 null (그러면 .env 가 정한다) */
export function assignedChatId(channel: string): string | null {
  const v = readRooms().assign[channel];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}
