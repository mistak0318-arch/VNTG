import { addEvent, type CalendarEvent, type EventKind } from "./calendar.js";
import { availableVisionProviders, readImage, type VisionProvider } from "./vision.js";

/**
 * 이미지에서 일정 뽑아내기.
 *
 * 증권사 리포트 캡처, 카톡으로 받은 일정표, 손으로 적은 메모 사진 등을 그대로 올리면
 * 날짜·제목을 뽑아 캘린더에 넣는다.
 *
 * **바로 저장하지 않는다.** 이미지 인식은 틀릴 수 있고, 틀린 일정이 조용히 들어가면
 * 나중에 그게 틀린 줄도 모른다. 그래서 뽑아내기(parse)와 저장(commit)을 분리하고
 * 사용자가 화면에서 확인한 뒤 넣게 한다.
 */

const KINDS: EventKind[] = ["market", "earnings", "holiday", "personal"];

const PROMPT = `이 이미지에서 일정(날짜가 있는 항목)을 모두 찾아 JSON 배열로만 답하십시오.

각 항목의 형식:
{"date":"YYYY-MM-DD","time":"HH:mm 또는 null","title":"일정 제목","kind":"market|earnings|holiday|personal","memo":"부가정보 또는 null"}

규칙:
- JSON 배열만 출력하십시오. 설명·코드블록 표시(\`\`\`)를 붙이지 마십시오.
- 연도가 이미지에 없으면 ${new Date().getFullYear()}년으로 간주하십시오.
- 날짜를 알 수 없는 항목은 아예 빼십시오. 추측해서 만들지 마십시오.
- 시각이 없으면 time 은 null 로 두십시오 (종일 일정).
- kind 는 다음 기준으로 고르십시오.
  earnings: 실적발표·잠정실적·컨퍼런스콜
  market: 배당기준일·배당락·주주총회·상장·FOMC·CPI·고용지표·금통위·옵션만기 등 증시 일정
  holiday: 휴장일·공휴일
  personal: 위에 안 맞는 개인 일정
- 이미지에 일정이 없으면 [] 만 출력하십시오.`;

export interface ParsedEvent {
  date: string;
  time?: string;
  title: string;
  kind: EventKind;
  memo?: string;
}

export interface ParseResult {
  events: ParsedEvent[];
  provider: VisionProvider | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  /** 모델이 실제로 뱉은 원문 — 파싱이 실패했을 때 왜 그런지 보려면 필요하다 */
  raw?: string;
  error?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

/** 모델 응답에서 JSON 배열만 건져낸다 (코드블록이나 설명이 섞여 와도) */
function extractJson(text: string): unknown {
  const cleaned = text.replace(/```(?:json)?/gi, "").trim();
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 모델이 뭘 주든 우리 형식에 맞는 것만 통과시킨다 */
function sanitize(raw: unknown): ParsedEvent[] {
  if (!Array.isArray(raw)) return [];
  const out: ParsedEvent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const date = String(r.date ?? "").trim();
    const title = String(r.title ?? "").trim();
    // 날짜와 제목이 없으면 일정이라고 볼 수 없다
    if (!DATE_RE.test(date) || !title) continue;

    const time = String(r.time ?? "").trim();
    const kind = String(r.kind ?? "").trim() as EventKind;
    const memo = String(r.memo ?? "").trim();

    out.push({
      date,
      title: title.slice(0, 120),
      kind: KINDS.includes(kind) ? kind : "market",
      ...(TIME_RE.test(time) ? { time } : {}),
      ...(memo && memo !== "null" ? { memo: memo.slice(0, 300) } : {}),
    });
  }
  // 같은 날 같은 제목이 두 번 잡히는 경우가 있어 정리한다
  const seen = new Set<string>();
  return out.filter((e) => {
    const key = `${e.date}|${e.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function visionReady(): boolean {
  return availableVisionProviders().length > 0;
}

/** 이미지 → 일정 후보. 저장은 하지 않는다. */
export async function parseCalendarImage(
  imageBase64: string,
  mimeType: string,
  prefer?: VisionProvider,
): Promise<ParseResult> {
  const res = await readImage(PROMPT, imageBase64, mimeType, prefer);

  if (!res.text) {
    return {
      events: [],
      provider: res.provider,
      model: res.model,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      error: res.error ?? "이미지에서 응답을 받지 못했습니다",
    };
  }

  const events = sanitize(extractJson(res.text));
  return {
    events,
    provider: res.provider,
    model: res.model,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    raw: events.length === 0 ? res.text.slice(0, 500) : undefined,
    error: events.length === 0 ? "일정을 찾지 못했습니다" : undefined,
  };
}

/**
 * 확인된 일정을 캘린더에 넣는다.
 * source 에 파일명을 남겨서 나중에 "이 이미지에서 들어온 것"을 한꺼번에 지울 수 있게 한다.
 */
export async function commitParsedEvents(
  events: ParsedEvent[],
  fileName: string,
): Promise<CalendarEvent[]> {
  let all: CalendarEvent[] = [];
  for (const e of events) {
    all = await addEvent({ ...e, source: `image:${fileName}` });
  }
  return all;
}
