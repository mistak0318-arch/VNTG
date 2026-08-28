import type { CalendarEvent, EventKind } from "./api";

/**
 * 일정 종류의 이름·글머리·색 — **여기 한 곳에서만 정한다** (2026-08-28).
 *
 * 전에는 캘린더 페이지·데일리 리포트·이미지 가져오기가 각자 `KIND_LABEL` 을 들고
 * 있었다. 종류를 둘 늘리려니 세 군데를 고쳐야 했고, 그 중 하나는 늘 잊는다.
 *
 * **글머리(icon)** 는 목록에서 종류를 글자 대신 알아보게 한다 — 좁은 달력 칸에
 * 「증시」 두 글자를 넣을 자리는 없어도 📈 하나는 들어간다.
 */

export interface KindMeta {
  label: string;
  /** 글머리 — 제목 앞에 자동으로 붙는다 */
  icon: string;
  /** 칩·배지 색. CSS 는 `.cal-chip.<key>` 로도 같은 색을 쓴다 */
  color: string;
}

export const KIND_META: Record<EventKind, KindMeta> = {
  market: { label: "증시", icon: "📈", color: "#4c8dff" },
  earnings: { label: "실적", icon: "💰", color: "#f5c542" },
  holiday: { label: "휴장", icon: "🛌", color: "#ff5c5c" },
  event: { label: "이벤트", icon: "🎪", color: "#ff8c42" },
  conference: { label: "학회", icon: "🎓", color: "#c084fc" },
  personal: { label: "개인", icon: "🙋", color: "#35c46a" },
};

export const KIND_ORDER: EventKind[] = [
  "market",
  "earnings",
  "holiday",
  "event",
  "conference",
  "personal",
];

/**
 * 모르는 종류가 와도 화면이 안 깨지게. 옛 데이터나 손으로 고친 JSON 이 있을 수 있다.
 */
export function kindMeta(kind: string): KindMeta {
  return KIND_META[kind as EventKind] ?? { label: kind, icon: "•", color: "#8b98a5" };
}

/**
 * 제목만 보고 종류를 **넘겨짚는다** — 폼에서 종류를 직접 고르기 전까지의 기본값.
 *
 * 확신할 때만 답한다(모르면 null). 애매한 걸 개인 일정으로 밀어 넣으면
 * 고르는 것보다 고치는 게 더 귀찮아진다.
 */
export function guessKind(title: string): EventKind | null {
  const t = title.toLowerCase();
  if (/휴장|휴일|폐장|개장|설날|추석|공휴일/.test(title)) return "holiday";
  if (/실적|잠정|어닝|컨센서스|earnings/.test(t)) return "earnings";
  if (/fomc|cpi|ppi|금통위|고용|비농업|점도표|만기|배당락|금리|gdp|pmi|수출입/.test(t))
    return "market";
  if (/학회|논문|세미나|심포지|conference|summit|asco|aacr|esmo|ash\b/.test(t))
    return "conference";
  if (/ces|gtc|wwdc|mwc|컨퍼런스|행사|박람회|전시회|데모데이|출시|언팩/.test(t))
    return "event";
  return null;
}

// ---------------------------------------------------------------- 시각 다루기

/** "09:30" → 570. 못 읽으면 null */
export function toMin(hhmm: string | undefined): number | null {
  if (!hhmm) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 570 → "09:30" */
export function toHhmm(min: number): string {
  const h = Math.floor(min / 60) % 24;
  return `${String(h).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/**
 * 일정이 차지하는 시간대 [시작분, 끝분].
 *
 * **끝 시각이 없으면 한 시간짜리로 본다.** 대부분은 시작만 적는데, 길이를 0 으로
 * 두면 시간표에서 선 하나가 되어 못 읽는다. 끝이 시작보다 앞이면(자정 넘김)
 * 그날 자정까지로 자른다 — 다음 날 칸으로 넘기는 건 과하다.
 */
export function span(e: CalendarEvent): { from: number; to: number } | null {
  const from = toMin(e.time);
  if (from === null) return null;
  const raw = toMin(e.endTime);
  const to = raw === null || raw <= from ? Math.min(from + 60, 24 * 60) : raw;
  return { from, to };
}

/** 화면에 적는 시각 — "09:00" 또는 "09:00~10:30" */
export function timeText(e: CalendarEvent): string {
  if (!e.time) return "";
  return e.endTime ? `${e.time}~${e.endTime}` : e.time;
}
