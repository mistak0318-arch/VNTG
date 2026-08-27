import { useCallback, useEffect, useState } from "react";
import {
  api,
  type CalendarEvent,
  type MajorRoom,
  type PublishedReport,
  type SuperEntry,
  type SuperStats,
  type UsMajorResult,
} from "../api";
import { MarketSignalPanel } from "../components/MarketSignalPanel";

/**
 * 장전 브리핑룸 (2026-08-27 전수 점검에서 제안) — **아침 루틴을 한 화면으로.**
 *
 * 07~09시에 보던 것들이 메뉴 다섯 곳에 흩어져 있었다: 캘린더(오늘 일정) →
 * 데일리 리포트(조간) → 슈퍼신호등(밤사이 변동) → 텔레그램(주요 채널 밤사이 글) →
 * 시황(미국 마감). 전부 이미 있는 데이터라 **조립만** 한 자리다.
 *
 * 폴링하지 않는다 — 아침에 한 번 여는 화면이다. 새로고침 버튼이 대신한다.
 * 각 카드는 제 메뉴로 가는 문이기도 하다(제목 클릭).
 */

function pct(v: number | null | undefined): string {
  if (v === null || v === undefined) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function cls(v: number | null | undefined): string {
  if (v === null || v === undefined || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

function kstToday(offsetDays = 0): string {
  return new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000).toISOString().slice(0, 10);
}

export function MorningPage() {
  const [cal, setCal] = useState<CalendarEvent[] | null>(null);
  const [us, setUs] = useState<UsMajorResult | null>(null);
  const [report, setReport] = useState<PublishedReport | null>(null);
  const [sup, setSup] = useState<{ entries: SuperEntry[]; stats: SuperStats } | null>(null);
  const [rooms, setRooms] = useState<MajorRoom[] | null>(null);
  const [buzz, setBuzz] = useState<Awaited<ReturnType<typeof api.buzz>> | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);

  const load = useCallback(() => {
    /* 카드 하나가 죽어도 나머지는 나온다 — 아침에 제일 필요한 화면이 통째로 비면 안 된다 */
    void api
      .calendarUpcoming(2)
      .then((r) => setCal(r.events))
      .catch(() => setCal([]));
    void api
      .overviewSection<UsMajorResult>("usMajor")
      .then((r) => setUs(r.data))
      .catch(() => undefined);
    void api
      .publishedReport()
      .then((r) => setReport(r.report))
      .catch(() => undefined);
    void api
      .signalSuper()
      .then((r) => setSup({ entries: r.entries, stats: r.stats }))
      .catch(() => undefined);
    void api
      .majorRooms()
      .then((r) => setRooms(r.rooms))
      .catch(() => setRooms([]));
    void api
      .buzz()
      .then(setBuzz)
      .catch(() => undefined);
    setLoadedAt(Date.now());
  }, []);
  useEffect(() => load(), [load]);

  const go = (hash: string) => {
    location.hash = `#${hash}`;
  };

  const today = kstToday();
  const tomorrow = kstToday(1);
  const todayEvents = (cal ?? []).filter((e) => e.date === today);
  const tomorrowEvents = (cal ?? []).filter((e) => e.date === tomorrow);

  /* 슈퍼신호등 — 추적 중인 것들의 당일 상승·하락 상위 */
  const active = (sup?.entries ?? []).filter((e) => e.active !== false && e.changeRate !== null);
  const supUp = [...active].sort((a, b) => (b.changeRate ?? 0) - (a.changeRate ?? 0)).slice(0, 3);
  const supDown = [...active].sort((a, b) => (a.changeRate ?? 0) - (b.changeRate ?? 0)).slice(0, 3);

  const unreadRooms = (rooms ?? []).filter((r) => r.unread > 0);

  return (
    <div>
      <div className="mrn-head">
        <h2>🌅 장전 브리핑룸</h2>
        <span className="pt-n">
          아침에 볼 것들을 한 화면에 — 카드 제목을 누르면 그 메뉴로 갑니다
        </span>
        <button className="filter-btn" onClick={load} title="전부 다시 읽기">
          ↻ 새로고침
        </button>
        {loadedAt && (
          <span className="pt-n">
            {new Date(loadedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}{" "}
            기준
          </span>
        )}
      </div>

      <div className="mrn-grid">
        {/* ── 시장 신호등 — 공용 패널 그대로 ── */}
        <section className="card mrn-card">
          <MarketSignalPanel />
        </section>

        {/* ── 미국 마감 ── */}
        <section className="card mrn-card">
          <button className="mrn-title" onClick={() => go("overview")}>
            🌙 밤사이 미국 <i>›</i>
          </button>
          {!us && <div className="empty">불러오는 중…</div>}
          {us && (
            <>
              <table className="mrn-table">
                <tbody>
                  {us.rows.slice(0, 8).map((r) => (
                    <tr key={r.key}>
                      <td>{r.label}</td>
                      <td className="num">
                        {r.price === null
                          ? "-"
                          : r.isRate
                            ? `${r.price.toFixed(r.digits)}%`
                            : r.price.toLocaleString("ko-KR", { maximumFractionDigits: r.digits })}
                      </td>
                      <td className={`num ${cls(r.changeRate)}`}>{pct(r.changeRate)}</td>
                    </tr>
                  ))}
                  {us.nightFutures && (
                    <tr>
                      <td>{us.nightFutures.label}</td>
                      <td className="num">
                        {us.nightFutures.price?.toLocaleString("ko-KR", {
                          maximumFractionDigits: us.nightFutures.digits,
                        }) ?? "-"}
                      </td>
                      <td className={`num ${cls(us.nightFutures.changeRate)}`}>
                        {pct(us.nightFutures.changeRate)}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
              {us.curveNote && <p className="pt-n mrn-note">{us.curveNote}</p>}
            </>
          )}
        </section>

        {/* ── 오늘·내일 일정 ── */}
        <section className="card mrn-card">
          <button className="mrn-title" onClick={() => go("calendar")}>
            📅 오늘·내일 일정 <i>›</i>
          </button>
          {cal === null && <div className="empty">불러오는 중…</div>}
          {cal !== null && todayEvents.length === 0 && tomorrowEvents.length === 0 && (
            <div className="empty">이틀 안 일정이 없습니다.</div>
          )}
          {todayEvents.length > 0 && (
            <div className="mrn-day">
              <b>오늘</b>
              {todayEvents.map((e) => (
                <div className="mrn-event" key={e.id}>
                  {e.time && <i>{e.time}</i>} {e.title}
                </div>
              ))}
            </div>
          )}
          {tomorrowEvents.length > 0 && (
            <div className="mrn-day">
              <b>내일</b>
              {tomorrowEvents.map((e) => (
                <div className="mrn-event" key={e.id}>
                  {e.time && <i>{e.time}</i>} {e.title}
                </div>
              ))}
            </div>
          )}
        </section>

        {/* ── 데일리 리포트 (최신 판) ── */}
        <section className="card mrn-card">
          <button className="mrn-title" onClick={() => go("report")}>
            📰 데일리 리포트 <i>›</i>
          </button>
          {!report && <div className="empty">발행된 리포트가 없습니다.</div>}
          {report && (
            <>
              <p className="pt-n">
                {report.date} {report.label} ·{" "}
                {new Date(report.publishedAt).toLocaleTimeString("ko-KR", {
                  hour: "2-digit",
                  minute: "2-digit",
                })}{" "}
                발행
              </p>
              {report.summary.text ? (
                // 요약은 마크다운으로 저장돼 있다 — 미리보기에선 기호만 걷어낸다
                <p className="mrn-report">
                  {report.summary.text
                    .replace(/^#+\s*/gm, "")
                    .replace(/\*\*/g, "")
                    .slice(0, 260)}
                  …
                </p>
              ) : (
                <p className="pt-n">AI 요약이 없는 판입니다 — 열어서 본문을 확인하세요.</p>
              )}
            </>
          )}
        </section>

        {/* ── 슈퍼신호등 밤사이 ── */}
        <section className="card mrn-card">
          <button className="mrn-title" onClick={() => go("superSignal")}>
            🌟 슈퍼신호등 <i>›</i>
          </button>
          {!sup && <div className="empty">불러오는 중…</div>}
          {sup && (
            <>
              <p className="pt-n">
                추적 {sup.stats.activeCount}종목 · 오늘 편입 {sup.stats.todayAdded} · 이탈{" "}
                {sup.stats.exitedCount}
              </p>
              {active.length === 0 && <div className="empty">추적 중인 종목이 없습니다.</div>}
              {supUp.length > 0 && (
                <div className="mrn-sup">
                  {supUp.map((e) => (
                    <div key={`u${e.code}`}>
                      <span>{e.name}</span>
                      <b className={cls(e.changeRate)}>{pct(e.changeRate)}</b>
                    </div>
                  ))}
                  {supDown
                    .filter((e) => !supUp.some((u) => u.code === e.code))
                    .map((e) => (
                      <div key={`d${e.code}`}>
                        <span>{e.name}</span>
                        <b className={cls(e.changeRate)}>{pct(e.changeRate)}</b>
                      </div>
                    ))}
                </div>
              )}
            </>
          )}
        </section>

        {/* ── 밤사이 버즈 — 채널 언급 급증 (2026-08-27 버즈 레이더) ── */}
        <section className="card mrn-card">
          <button className="mrn-title" onClick={() => go("telegram")}>
            🌋 밤사이 버즈 <i>›</i>
          </button>
          {!buzz && <div className="empty">불러오는 중…</div>}
          {/* 살아 있나 — 「안 온다」가 고장인지 조용한 것인지 (2026-08-27) */}
          {buzz?.health && !buzz.health.reader && (
            <div className="alert-note">
              텔레그램 사용자 세션이 없어 수집이 안 됩니다 — 미니PC에서만 돕니다.
            </div>
          )}
          {buzz && buzz.baselineDays < 3 && (
            <>
              <p className="pt-n">
                기준선 수집 중 ({buzz.baselineDays}/3일) — 사흘치가 쌓이면 「평소 대비 몇 배」
                판정과 버즈 방 발송이 시작됩니다.
                {buzz.health && (
                  <>
                    {" "}
                    오늘 센 것 <b>{buzz.health.todayCount}건</b>
                    {buzz.health.lastCollect &&
                      ` · 마지막 수집 ${new Date(buzz.health.lastCollect).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}`}
                  </>
                )}
              </p>
              {buzz.topToday.length > 0 && (
                <div className="mrn-sup">
                  {buzz.topToday.slice(0, 6).map((t) => (
                    <div key={t.term}>
                      <span>{t.term}</span>
                      <b>{t.recent}건</b>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {buzz && buzz.baselineDays >= 3 && buzz.hits.length === 0 && (
            <div className="empty">최근 {buzz.windowHours}시간, 평소보다 크게 커진 주제가 없습니다.</div>
          )}
          {buzz &&
            buzz.hits.slice(0, 5).map((h) => (
              <div className="mrn-buzz" key={h.term}>
                <div className="mrn-buzz-head">
                  <b>{h.term}</b>
                  <span className="positive">
                    {h.recent}건 · 평소 {h.baseline}건의 {h.ratio}배
                  </span>
                </div>
                {h.samples[0] && (
                  <p className="pt-n mrn-buzz-sample">
                    {h.samples[0].text.slice(0, 90)} <i>({h.samples[0].channel})</i>
                  </p>
                )}
              </div>
            ))}
        </section>

        {/* ── 주요 채널 밤사이 글 ── */}
        <section className="card mrn-card">
          <button className="mrn-title" onClick={() => go("telegram")}>
            📡 주요 채널 밤사이 <i>›</i>
          </button>
          {rooms === null && <div className="empty">불러오는 중…</div>}
          {rooms !== null && rooms.length === 0 && (
            <div className="empty">
              등록된 주요 채널이 없습니다 — 텔레그램 동향 &gt; 주요 채널에서 ⭐ 하세요.
            </div>
          )}
          {rooms !== null && rooms.length > 0 && unreadRooms.length === 0 && (
            <div className="empty">밤사이 새 글이 없습니다 — 다 읽었습니다.</div>
          )}
          {unreadRooms.map((r) => (
            <div className="mrn-room" key={r.id}>
              <b>{r.name}</b>
              <i className="tgr-preview">{r.preview}</i>
              <em className="tgr-badge">{r.unread > 99 ? "99+" : r.unread}</em>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
