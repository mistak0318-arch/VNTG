import { useEffect, useState } from "react";
import { api, type DartEvent } from "../api";

/**
 * 오늘 공시 — **내 종목 것부터.**
 *
 * DART 는 하루 2,000건 넘게 쏟아진다. 그걸 다 보는 건 불가능하고 볼 이유도 없다.
 * 내가 들고 있거나 보고 있는 종목의 공시 한 건이 나머지보다 중요하다.
 * 그래서 내 종목 → 내 테마 → 그 밖 순으로 놓고, 기본은 앞의 둘만 편다.
 */

const FILTERS = [
  /* 슈퍼신호등 원장 + 「슈퍼신호등+교차」 그룹 — 지금 추적 중인 종목의 사건이 제일 급하다 */
  { key: "super", label: "🌟 슈퍼·교차" },
  { key: "mine", label: "내 종목·테마" },
  { key: "notable", label: "중요 공시" },
  { key: "all", label: "전체" },
] as const;

type Filter = (typeof FILTERS)[number]["key"];

export function DartTodayPanel({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [events, setEvents] = useState<DartEvent[]>([]);
  const [day, setDay] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("mine");
  /* 슈퍼신호등 추적 종목 — 얘들의 공시는 필터와 무관하게 맨 앞에 세운다 (2026-08-27) */
  const [superCodes, setSuperCodes] = useState<Set<string>>(new Set());

  async function load(force = false) {
    setLoading(true);
    setError(null);
    try {
      const r = await api.dartToday(force);
      setEvents(r.events);
      setDay(r.day);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    void api
      .signalSuperStatus()
      .then((r) => setSuperCodes(new Set(r.stocks.map((s) => s.code))))
      .catch(() => undefined);
  }, []);

  /* 슈퍼신호등·교차 종목 공시 — 별도 필터 버튼(맨 앞)이 됐다 (2026-08-27) */
  const superHits = events.filter((e) => e.stockCode && superCodes.has(e.stockCode));
  const mine = events.filter((e) => e.watched || e.themes.length > 0);
  // 중요도 8 이상 = 유상증자·수주·합병·상장폐지 같은 되돌리기 어려운 사건
  const notable = events.filter((e) => !e.watched && e.themes.length === 0 && e.weight >= 8);
  const shown =
    filter === "super" ? superHits : filter === "mine" ? mine : filter === "notable" ? notable : events;

  if (loading && events.length === 0) return <div className="page-note">공시 불러오는 중…</div>;
  if (error) return <div className="error-banner">{error}</div>;

  return (
    <section>
      <div className="filter-row">
        <span className="tg-ctl-label">
          {day ? `${day.slice(4, 6)}/${day.slice(6, 8)} 공시` : "공시"}
        </span>
        {FILTERS.map((f) => (
          <button
            key={f.key}
            className={`filter-btn ${filter === f.key ? "active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            <span className="pt-n">
              {" "}
              {f.key === "super"
                ? superHits.length
                : f.key === "mine"
                  ? mine.length
                  : f.key === "notable"
                    ? notable.length
                    : events.length}
            </span>
          </button>
        ))}
        <button className="filter-btn" onClick={() => void load(true)} disabled={loading}>
          ↻
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="empty">
          {filter === "super"
            ? "슈퍼신호등·교차 종목에 오늘 나온 공시가 없습니다."
            : filter === "mine"
              ? "내 종목·내 태그에 오늘 나온 공시가 없습니다."
              : "해당하는 공시가 없습니다."}
        </div>
      ) : (
        <div className="dart-list">
          {shown.slice(0, 60).map((e) => (
            <div className={`dart-row${e.weight >= 9 ? " hot" : ""}`} key={e.url}>
              <div className="dart-head">
                {e.stockCode && superCodes.has(e.stockCode) && (
                  <span className="news-tag watch">🌟 슈퍼·교차</span>
                )}
                {e.watched && <span className="news-tag watch">★ 관심</span>}
                {e.themes.map((t) => (
                  <span className="chan-tag theme" key={t}>
                    🎯 {t}
                  </span>
                ))}
                {e.stockCode && onSelectStock ? (
                  <button
                    className="link-btn dart-name"
                    onClick={() => onSelectStock(e.stockCode, e.corpName)}
                  >
                    {e.corpName}
                  </button>
                ) : (
                  <span className="dart-name">{e.corpName}</span>
                )}
                <span className="pt-n">{e.market}</span>
                {e.amended && <span className="dart-amend">정정</span>}
              </div>
              <a className="dart-title" href={e.url} target="_blank" rel="noreferrer">
                {e.title}
              </a>
            </div>
          ))}
        </div>
      )}

      <div className="table-note">
        코스피·코스닥의 <b>주요사항보고·발행공시</b>만 가져옵니다(정기보고서 제외). 제목을
        누르면 DART 원문이 열립니다. <b>정정</b> 표시는 앞서 낸 공시를 고친 것이라 원문과
        달라진 부분을 봐야 합니다.
      </div>
    </section>
  );
}
