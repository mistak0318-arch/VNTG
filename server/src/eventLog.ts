import { appendFile, mkdir, readFile, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 오늘의 이벤트 로그 — **알림이 지나간 자리를 남긴다.**
 *
 * ## 왜 필요한가
 *
 * 알림 모듈들(텔레그램 키워드·시그널·손절·체결강도)은 전부 **텔레그램으로 쏘고
 * 끝**이었다. 남는 것은 중복 방지용 키뿐이라(`keywordAlert.json` 의 `sent` 800개),
 * 「오늘 무슨 일이 있었나」를 **시간순으로 되짚을 방법이 없었다.** 폰을 못 보는
 * 시간에 온 알림은 그냥 사라진 것과 같았다.
 *
 * 마켓 브리핑의 타임라인이 이걸 읽는다. VI 와 DART 공시는 이미 조회 가능한 곳이
 * 있으므로(실시간 저장소·`todayDartEvents`) **여기에 다시 적지 않는다** — 같은
 * 사건을 두 곳에 적으면 언젠가 두 번 나온다.
 *
 * ## 원칙
 *
 *   · **판정하는 자리에서 한 줄 append.** 조회를 새로 만들지 않는다 — 이미 알림을
 *     보내기로 결정한 바로 그 순간의 값을 적을 뿐이다.
 *   · 날짜별 JSONL. 통째 다시 쓰지 않는다(전원이 나가도 그날치가 통째로 안 날아간다) —
 *     실시간 저장(`realtimeStore`)과 같은 이유, 같은 방식이다.
 *   · **기록 실패가 알림을 막으면 안 된다.** 전부 조용히 삼킨다. 로그는 부산물이다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "events");

export type MarketEventKind =
  /** 텔레그램 키워드 매칭 — 출처 채널이 붙는다. 지라시 성격이라 화면은 회색 배지 */
  | "telegram"
  /** 관심종목 시그널 (급변·거래량·수급전환·신고가·정배열·거래원 이탈) */
  | "signal"
  /** 손절선 이탈 */
  | "stop"
  /** 체결강도 급변 */
  | "strength";

export interface MarketEvent {
  /** ISO 시각 */
  at: string;
  kind: MarketEventKind;
  /** 시그널이면 규칙 이름(「급변」·「거래원 이탈」…) — 배지에 그대로 쓴다 */
  rule?: string;
  /** 6자리 종목코드. 테마·키워드 매칭처럼 종목이 아닐 수 있다 */
  code?: string;
  name: string;
  /** 한 줄 요약 — 타임라인에서 이것만 읽고 판단한다 */
  summary: string;
  /** 텔레그램이면 채널 이름 */
  source?: string;
  /** 내 관심종목 관련인가 — 타임라인이 하이라이트한다 */
  watch: boolean;
  /** 원문 링크 (텔레그램 메시지 등) */
  link?: string;
}

function dayOf(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

/**
 * 오래된 날짜 파일 정리 (2026-08-27 전수 점검) — 파일이 무기한 쌓이기만 했다.
 * 타임라인·복기는 최근을 보므로 90일이면 넉넉하다. 하루 한 번, 첫 기록길에 지나간다.
 */
const KEEP_DAYS = 90;
let cleanedDay = "";

async function cleanupOldDays(): Promise<void> {
  const today = dayOf();
  if (cleanedDay === today) return;
  cleanedDay = today;
  try {
    const cutoff = new Date(Date.now() - KEEP_DAYS * 86400_000).toISOString().slice(0, 10);
    for (const f of await readdir(DIR)) {
      if (f.endsWith(".jsonl") && f.replace(/\.jsonl$/, "") < cutoff) {
        await unlink(join(DIR, f)).catch(() => undefined);
      }
    }
  } catch {
    /* 정리 실패는 다음 날 다시 */
  }
}

/**
 * 한 건 남긴다. **실패는 삼킨다** — 로그 때문에 알림이 죽으면 주객전도다.
 */
export async function logEvent(e: Omit<MarketEvent, "at"> & { at?: string }): Promise<void> {
  try {
    await mkdir(DIR, { recursive: true });
    const row: MarketEvent = { ...e, at: e.at ?? new Date().toISOString() };
    await appendFile(join(DIR, `${dayOf()}.jsonl`), `${JSON.stringify(row)}\n`, "utf-8");
    void cleanupOldDays();
  } catch {
    /* 기록 실패가 알림을 막으면 안 된다 */
  }
}

/** 여러 건 — 한 번의 append 로 (알림이 몰릴 때 파일 열기를 반복하지 않는다) */
export async function logEvents(rows: (Omit<MarketEvent, "at"> & { at?: string })[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await mkdir(DIR, { recursive: true });
    const text = rows
      .map((e) => JSON.stringify({ ...e, at: e.at ?? new Date().toISOString() }))
      .join("\n");
    await appendFile(join(DIR, `${dayOf()}.jsonl`), `${text}\n`, "utf-8");
  } catch {
    /* 위와 같다 */
  }
}

/**
 * 오늘치(기본) 또는 지정한 날짜를 읽는다. 깨진 줄은 그 줄만 버린다 —
 * 한 줄 때문에 하루치가 통째로 안 읽히면 말이 안 된다.
 */
export async function readEvents(day = dayOf()): Promise<MarketEvent[]> {
  try {
    const text = await readFile(join(DIR, `${day}.jsonl`), "utf-8");
    const out: MarketEvent[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as MarketEvent);
      } catch {
        /* 이 줄만 버린다 */
      }
    }
    return out;
  } catch {
    return []; // 파일이 없으면 그날 이벤트가 없는 것이다
  }
}
