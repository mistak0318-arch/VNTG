import type { CalendarEvent } from "../api";
import { kindMeta } from "../calendarKinds";

/**
 * 이번 주 브리핑 — **증권사 리서치 캘린더 양식** (2026-08-30 요청).
 *
 * ## 왜 이 모양인가
 *
 * 미래에셋 리서치 캘린더를 보면 **일요일 칸이 통째로 「이번 주 핵심」**이다.
 * 주차(36주)와 그 주의 대표 주제, 그리고 왜 중요한지를 몇 줄로 적어 둔다.
 * 그 다음에야 월화수목금이 온다.
 *
 * 순서에 뜻이 있다 — **「이번 주에 뭘 봐야 하나」를 먼저 답하고 나서** 날짜별로
 * 흩어 놓는 것이다. 우리 캘린더는 그 첫 답이 없어서, 주간 화면을 열면 일정 스물몇
 * 개가 요일에 흩뿌려진 것만 보였다. 무엇이 중요한지는 사람이 매번 다시 골라야 했다.
 *
 * ## 무엇을 맨 앞에 올리나
 *
 *   ① **주간 핵심**(kind=weekly) — 그 주 일요일에 달아 둔 글. 사람이 직접 적거나
 *      증권사 캘린더에서 옮긴다. 있으면 이게 제일 위다.
 *   ② **대표 일정**(headline) — 날짜마다 하나씩 굵게 표시해 둔 것
 *   ③ 그 주의 **회의·지표·파생** — 성격상 시장을 흔드는 갈래만 따로 모은다
 *
 * ①이 없어도 ②③은 자동으로 뽑히므로 **빈 화면이 되지 않는다.** 손으로 채워야만
 * 쓸모 있는 화면은 결국 안 채워진다.
 */

/** 그 주가 몇 주차인가 — 리서치 캘린더가 「36주」라고 적는 그 숫자 */
function weekNo(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  /* 목요일이 속한 해가 그 주의 해다(ISO 8601) — 연말연시에 주차가 튀지 않게 */
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86400_000 + 1) / 7);
}

/** 시장을 흔드는 갈래 — 이번 주에 이것들이 몇 개인지가 「각오」를 정한다 */
const HEAVY = new Set(["meeting", "indicator", "deriv", "holiday"]);

export function WeekBrief({
  start,
  events,
  onOpen,
}: {
  /** 그 주 일요일 */
  start: Date;
  /** 그 주 7일치 일정 (날짜순) */
  events: CalendarEvent[];
  onOpen: (e: CalendarEvent) => void;
}) {
  const notes = events.filter((e) => e.kind === "weekly");
  const headlines = events.filter((e) => e.headline && e.kind !== "weekly");
  const heavy = events.filter((e) => !e.headline && e.kind !== "weekly" && HEAVY.has(e.kind));

  const end = new Date(start.getTime() + 6 * 86400_000);
  const range = `${start.getMonth() + 1}.${start.getDate()} ~ ${end.getMonth() + 1}.${end.getDate()}`;

  if (notes.length === 0 && headlines.length === 0 && heavy.length === 0) {
    return (
      <div className="wb wb-empty">
        <div className="wb-no">{weekNo(start)}주</div>
        <div>
          <b>{range}</b> — 이번 주에 눈에 띄는 일정이 없습니다.
          <span className="wb-hint">
            일정을 <b>「주간 핵심」</b>으로 넣거나 <b>대표</b>로 표시하면 여기 맨 위에
            올라옵니다. 회의·지표·파생·휴장은 표시하지 않아도 자동으로 모입니다.
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="wb">
      <div className="wb-head">
        <span className="wb-no">{weekNo(start)}주</span>
        <span className="wb-range">{range}</span>
        <span className="wb-count">
          이번 주 <b>{events.filter((e) => e.kind !== "weekly").length}</b>건
        </span>
      </div>

      {/* ① 사람이 적어 둔 주간 핵심 — 있으면 이게 제일 위다 */}
      {notes.map((n) => (
        <button key={n.id} className="wb-note" onClick={() => onOpen(n)}>
          <b>{n.title}</b>
          {n.memo && <p>{n.memo}</p>}
        </button>
      ))}

      {/* ② 날짜마다 굵게 표시해 둔 대표 일정 */}
      {headlines.length > 0 && (
        <div className="wb-block">
          <h5>이번 주 대표 일정</h5>
          <ul className="wb-list">
            {headlines.map((e) => (
              <Row key={e.id} e={e} onOpen={onOpen} />
            ))}
          </ul>
        </div>
      )}

      {/* ③ 표시가 없어도 성격상 무거운 것들 — 손으로 안 채워도 화면이 빈손이 아니게 */}
      {heavy.length > 0 && (
        <div className="wb-block">
          <h5>
            회의 · 지표 · 파생 · 휴장 <i>{heavy.length}건</i>
          </h5>
          <ul className="wb-list">
            {heavy.slice(0, 10).map((e) => (
              <Row key={e.id} e={e} onOpen={onOpen} />
            ))}
          </ul>
          {heavy.length > 10 && (
            <p className="wb-more">외 {heavy.length - 10}건 — 아래 요일별에서 볼 수 있습니다.</p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 한 줄 — **분류·국가·날짜를 왼쪽에 세로로 맞춘다.**
 *
 * 리서치 캘린더가 그렇게 하는 이유는, 그래야 「오늘 미국 것이 몇 개인가」가 훑기만
 * 해도 보이기 때문이다. 가운데 정렬하거나 제목 뒤에 붙이면 그 효과가 사라진다.
 */
function Row({ e, onOpen }: { e: CalendarEvent; onOpen: (e: CalendarEvent) => void }) {
  const meta = kindMeta(e.kind);
  const d = new Date(`${e.date}T00:00:00`);
  return (
    <li>
      <button onClick={() => onOpen(e)}>
        <span className="wb-day">
          {d.getDate()}
          <i>{"일월화수목금토"[d.getDay()]}</i>
        </span>
        <span className="wb-kind" style={{ color: meta.color, borderColor: meta.color }}>
          {meta.label}
        </span>
        <span className="wb-country">{e.country ?? ""}</span>
        <span className="wb-title">
          {e.title}
          {e.time && <i> {e.time}</i>}
        </span>
      </button>
    </li>
  );
}
