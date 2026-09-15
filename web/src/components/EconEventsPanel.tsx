import { useEffect, useState } from "react";
import { api, type CalCategory, type CalEvent } from "../api";

/**
 * **경제지표·만기 일정** — 네이버 시장 캘린더 (2026-09-16).
 *
 * 우리 캘린더에는 이미 「경제 캘린더 시드」가 있다(FOMC·CPI·금통위·만기일을 손으로 확인해 심는 것).
 * 그건 **연간 뼈대**고, 이건 **살**이다 — 발표 시각(한국 시각), 시장 영향력, 이전값·예상값까지 온다.
 * 시드를 걷어내지 않는 이유: 네이버는 공식 API 가 아니라 언제든 막힐 수 있고, 그때도 달력의 굵은
 * 일정은 남아 있어야 한다.
 *
 * `compact` 는 장전 브리핑룸처럼 자리가 좁은 곳 — 오늘·내일만, 영향력 높은 것만.
 */

const CAT_LABEL: Record<CalCategory, string> = {
  economicIndicators: "지표",
  expiration: "만기",
  dividends: "배당",
  ipo: "공모",
};

/*
 * 나라는 **글자로** 적는다 — 국기 이모지(🇺🇸)는 윈도우 크롬이 「US」라는 두 글자로 그린다.
 * 벤티지 미니PC·PC 가 다 윈도우라 화면에서 영문 약자가 튀어 보였다.
 */
const NATION: Record<string, string> = { USA: "미국", KOR: "한국", CHN: "중국", JPN: "일본", EUR: "유럽", GBR: "영국", DEU: "독일" };

function impactRank(s: string | null): number {
  if (!s) return 0;
  if (s.includes("매우 높음")) return 3;
  if (s.includes("높음")) return 2;
  if (s.includes("보통")) return 1;
  return 0;
}

function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return ["일", "월", "화", "수", "목", "금", "토"][new Date(y, m - 1, d).getDay()];
}

export function EconEventsPanel({ compact = false, days = 14 }: { compact?: boolean; days?: number }) {
  const [events, setEvents] = useState<CalEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [cats, setCats] = useState<CalCategory[]>(compact ? ["economicIndicators", "expiration"] : ["economicIndicators", "expiration"]);

  useEffect(() => {
    let alive = true;
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 9 * 3600_000 + (compact ? 1 : days - 1) * 86_400_000).toISOString().slice(0, 10);
    api
      .naverCalendar(today, to)
      .then((r) => {
        if (!alive) return;
        setEvents(r.events);
        setStale(r.stale);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [compact, days]);

  if (error) return <div className="table-note">네이버 일정을 못 받았습니다 — {error}</div>;
  if (!events) return <div className="table-note">일정을 불러오는 중…</div>;

  let rows = events.filter((e) => cats.includes(e.category));
  if (compact) rows = rows.filter((e) => e.category === "expiration" || impactRank(e.impact) >= 2);
  if (rows.length === 0) return <div className="table-note">해당 기간에 볼 일정이 없습니다.</div>;

  /* 날짜별로 묶는다 — 한 줄씩 늘어놓으면 「오늘 것」이 어디까지인지 안 보인다 */
  const byDate = new Map<string, CalEvent[]>();
  for (const e of rows) (byDate.get(e.date) ?? byDate.set(e.date, []).get(e.date)!).push(e);
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  return (
    <div className="econ-live">
      {!compact && (
        <div className="econ-cats">
          {(Object.keys(CAT_LABEL) as CalCategory[]).map((c) => (
            <button
              key={c}
              type="button"
              className={`econ-cat${cats.includes(c) ? " on" : ""}`}
              onClick={() => setCats((v) => (v.includes(c) ? v.filter((x) => x !== c) : [...v, c]))}
            >
              {CAT_LABEL[c]}
            </button>
          ))}
        </div>
      )}
      {[...byDate.entries()].map(([date, list]) => (
        <div className="econ-day" key={date}>
          <div className={`econ-day-h${date === today ? " today" : ""}`}>
            {date.slice(5).replace("-", "/")} ({weekday(date)}){date === today && <b>오늘</b>}
          </div>
          {list
            .slice()
            .sort((a, b) => (a.time ?? "99").localeCompare(b.time ?? "99") || impactRank(b.impact) - impactRank(a.impact))
            .map((e, i) => (
              <div className={`econ-ev i${impactRank(e.impact)}`} key={`${date}-${i}`}>
                <span className="econ-ev-t">{e.time ?? CAT_LABEL[e.category]}</span>
                <span className="econ-ev-n">
                  {e.nation && <i className="econ-nat">{NATION[e.nation] ?? e.nation}</i>}
                  {e.title}
                </span>
                {e.impact && <em className={`econ-imp i${impactRank(e.impact)}`}>{e.impact}</em>}
                {e.info.filter((x) => x.value && x.value !== "-").length > 0 && (
                  <span className="econ-ev-i">
                    {e.info
                      .filter((x) => x.value && x.value !== "-")
                      .map((x) => `${x.label} ${x.value}`)
                      .join(" · ")}
                  </span>
                )}
              </div>
            ))}
        </div>
      ))}
      <div className="table-note">
        네이버 시장 캘린더 · <b>한국 시각</b>입니다{stale ? " · 새로 못 받아 옛 값" : ""}.
        {!compact && " 영향력이 높은 지표는 발표 직후 지수·환율이 먼저 움직입니다 — 그 시각에 주문을 걸어 두지 않는 편이 낫습니다."}
      </div>
    </div>
  );
}
