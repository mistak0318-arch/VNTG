import { useEffect, useMemo, useState } from "react";
import { api, type CalendarEvent, type EventKind } from "../api";
import { DartTodayPanel } from "../components/DartTodayPanel";
import { CalendarImageImport } from "../components/CalendarImageImport";
import { EconomicCalendarCard } from "../components/EconomicCalendarCard";
import { RefreshBar } from "../components/RefreshBar";

/**
 * 캘린더 — 증시 일정과 개인 일정을 한 달력에서 본다.
 * 구글 연동은 나중에 iCal 읽기 전용으로 붙일 예정이라 지금은 직접 입력만 다룬다.
 */

const KIND_LABEL: Record<EventKind, string> = {
  market: "증시",
  earnings: "실적",
  holiday: "휴장",
  personal: "개인",
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function monthKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 달력 그리드에 채울 날짜 배열 (앞뒤 빈칸 포함, 6주 고정) */
function buildGrid(cursor: Date): (Date | null)[] {
  const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
  const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
  const lead = first.getDay();
  const cells: (Date | null)[] = Array.from({ length: lead }, () => null);
  for (let i = 1; i <= daysInMonth; i += 1) {
    cells.push(new Date(cursor.getFullYear(), cursor.getMonth(), i));
  }
  while (cells.length % 7 !== 0) cells.push(null);
  return cells;
}

/** 서브탭 (2026-08-27 전면 개편) — 달력은 달력답게, 공시·가져오기는 제 방으로 */
type CalTab = "cal" | "plan" | "dart" | "import";
const CAL_TABS: { key: CalTab; label: string }[] = [
  { key: "cal", label: "📅 달력" },
  { key: "plan", label: "🗓 다가오는·할 일" },
  { key: "dart", label: "📄 오늘 공시" },
  { key: "import", label: "⬇ 가져오기" },
];

export function CalendarPage() {
  const [tab, setTab] = useState<CalTab>("cal");
  const [cursor, setCursor] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(() => ymd(new Date()));
  /** 할 일 탭용 — 월과 무관한 원본 전체 (반복 전개 없음) */
  const [allEvents, setAllEvents] = useState<CalendarEvent[] | null>(null);

  // 외부 가져오기
  const [subs, setSubs] = useState<{ label: string; masked: string; url: string; count: number }[]>([]);
  const [subUrl, setSubUrl] = useState("");
  const [subLabel, setSubLabel] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 입력 폼 — 날짜도 폼에 있다(2026-08-27). 달력을 클릭하면 따라오고, 직접 바꿀 수도 있다
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<EventKind>("personal");
  const [time, setTime] = useState("");
  const [memo, setMemo] = useState("");
  const [repeat, setRepeat] = useState<"none" | "weekly" | "monthly" | "yearly">("none");
  const [isTodo, setIsTodo] = useState(false);
  const [formDate, setFormDate] = useState<string>(() => ymd(new Date()));
  /** 수정 중인 일정 id — 있으면 폼이 「추가」가 아니라 「수정 저장」이 된다 */
  const [editingId, setEditingId] = useState<string | null>(null);

  /* 다가오는 일정 — 달력은 「어느 날에 뭐가 있나」고, 이건 「곧 뭐가 오나」다 */
  const [upcoming, setUpcoming] = useState<CalendarEvent[] | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setEvents((await api.calendarList(monthKey(cursor))).events);
    } catch (err) {
      setError(err instanceof Error ? err.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
    void api
      .calendarUpcoming(14)
      .then((r) => setUpcoming(r.events))
      .catch(() => undefined);
    void api
      .calendarList()
      .then((r) => setAllEvents(r.events))
      .catch(() => undefined);
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  async function loadSubs() {
    try {
      setSubs((await api.calendarSubs()).subs);
    } catch {
      // 구독 조회 실패가 달력 표시를 막지 않게 한다
    }
  }

  useEffect(() => {
    loadSubs();
  }, []);

  async function addSubscription() {
    if (!subUrl.trim()) return;
    setBusy(true);
    setImportMsg(null);
    setError(null);
    try {
      const r = await api.calendarSubAdd(subUrl, subLabel);
      setImportMsg(`${r.added}건을 가져왔습니다.`);
      setSubUrl("");
      setSubLabel("");
      await loadSubs();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "구독 추가 실패");
    } finally {
      setBusy(false);
    }
  }

  async function syncNow() {
    setBusy(true);
    setImportMsg(null);
    try {
      const r = await api.calendarSync();
      setImportMsg(
        r.results.map((x) => `${x.label}: ${x.error ? `실패(${x.error})` : `${x.added}건`}`).join(" / ") ||
          "등록된 구독이 없습니다.",
      );
      await loadSubs();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "동기화 실패");
    } finally {
      setBusy(false);
    }
  }

  async function removeSubscription(url: string) {
    if (!window.confirm("이 구독을 삭제할까요? 가져온 일정도 함께 지워집니다.")) return;
    try {
      await api.calendarSubRemove(url);
      await loadSubs();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 실패");
    }
  }

  /** 파일을 텍스트로 읽어서 서버에 보낸다 (ICS/CSV 자동 판별) */
  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setImportMsg(null);
    setError(null);
    try {
      const text = await file.text();
      const r = await api.calendarImport(file.name, text, "personal");
      setImportMsg(`${file.name}에서 ${r.added}건을 가져왔습니다.`);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "가져오기 실패");
    } finally {
      setBusy(false);
      e.target.value = "";
    }
  }

  // 날짜별로 미리 묶어두면 셀마다 배열을 훑지 않아도 된다
  const byDate = useMemo(() => {
    const m = new Map<string, CalendarEvent[]>();
    for (const e of events) {
      const list = m.get(e.date) ?? [];
      list.push(e);
      m.set(e.date, list);
    }
    return m;
  }, [events]);

  function resetForm() {
    setTitle("");
    setTime("");
    setMemo("");
    setRepeat("none");
    setIsTodo(false);
    setEditingId(null);
  }

  /** 추가와 수정이 같은 폼을 쓴다 — editingId 가 있으면 그 일정을 고친다 */
  async function submitEvent() {
    if (!title.trim()) return;
    try {
      const body = {
        date: formDate,
        title,
        kind,
        time: time || undefined,
        memo: memo || undefined,
        /* 반복과 할 일은 상호 배타. 수정에서 해제하려면 값이 실려 가야 해서 null 을 보낸다
           (undefined 는 JSON 에서 사라져 기존 값이 남는다) */
        repeat: !isTodo && repeat !== "none" ? repeat : null,
        todo: isTodo ? true : null,
      } as unknown as Omit<CalendarEvent, "id">;
      if (editingId) await api.calendarUpdate(editingId, body);
      else await api.calendarAdd(body);
      await load(); // 반복은 서버가 전개한다 — 응답(원본 목록)으로 채우면 인스턴스가 빠진다
      resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : editingId ? "수정 실패" : "추가 실패");
    }
  }

  /** ✎ — 그 일정을 폼에 실어 수정 모드로. 반복 인스턴스면 원본(앵커)을 고친다 */
  function startEdit(e: CalendarEvent) {
    setEditingId(e.id.split("@")[0]);
    setFormDate(e.anchor ?? e.date);
    setTitle(e.title);
    setKind(e.kind);
    setTime(e.time ?? "");
    setMemo(e.memo ?? "");
    setRepeat(e.repeat ?? "none");
    setIsTodo(Boolean(e.todo));
  }

  async function removeEvent(e: CalendarEvent) {
    if (e.repeat && !window.confirm("반복 일정입니다 — 반복 전체가 삭제됩니다. 지울까요?")) return;
    try {
      await api.calendarRemove(e.id.split("@")[0]);
      await load();
      if (editingId === e.id.split("@")[0]) resetForm();
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 실패");
    }
  }

  /** 할 일 체크 — 완료로 뒤집는다 */
  async function toggleDone(e: CalendarEvent) {
    try {
      await api.calendarUpdate(e.id.split("@")[0], { done: !e.done } as Partial<CalendarEvent>);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    }
  }

  /** 다가오는 일정에서 눌렀을 때 — 그 날짜로 달력을 옮기고 고른다 */
  function jumpTo(date: string) {
    const [y, m] = date.split("-").map(Number);
    setCursor(new Date(y, m - 1, 1));
    setSelected(date);
    setFormDate(date);
  }

  /** D-day 라벨 — 오늘/내일은 말로, 그 뒤는 D-n */
  function dday(date: string): string {
    const today = ymd(new Date());
    if (date === today) return "오늘";
    const diff = Math.round(
      (new Date(`${date}T00:00`).getTime() - new Date(`${today}T00:00`).getTime()) / 86400_000,
    );
    return diff === 1 ? "내일" : `D-${diff}`;
  }

  function shiftMonth(delta: number) {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
  }

  const grid = buildGrid(cursor);
  const todayStr = ymd(new Date());
  const selectedEvents = byDate.get(selected) ?? [];

  return (
    <div>
      {/*
        서브탭 (2026-08-27 전면 개편 — "캘린더 본연의 기능에 집중").
        달력 탭에는 달력과 선택일·입력만 남기고, 다가오는·할 일 / 공시 / 가져오기는
        제 방을 준다 — 한 페이지에 목록이 세 겹으로 쌓여 쓰기 불편하던 것.
      */}
      <nav className="detail-tabs">
        {CAL_TABS.map((t) => (
          <button
            key={t.key}
            className={`detail-tab${tab === t.key ? " active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === "cal" && <RefreshBar onRefresh={load} loading={loading} />}
      {error && <div className="error-banner">{error}</div>}

      {tab === "cal" && (
      <div className="cal-layout">
        <div className="cal-main">
          <h3 className="section-heading">일정</h3>
          <div className="cal-toolbar">
            <button className="filter-btn" onClick={() => shiftMonth(-1)}>
              ‹ 이전
            </button>
            <span className="cal-month">
              {cursor.getFullYear()}년 {cursor.getMonth() + 1}월
            </span>
            <button className="filter-btn" onClick={() => shiftMonth(1)}>
              다음 ›
            </button>
            <button
              className="filter-btn"
              onClick={() => {
                const now = new Date();
                setCursor(new Date(now.getFullYear(), now.getMonth(), 1));
                setSelected(ymd(now));
                setFormDate(ymd(now));
              }}
            >
              오늘
            </button>
          </div>

          <div className="cal-grid">
            {WEEKDAYS.map((w, i) => (
              <div className={`cal-wd${i === 0 ? " sun" : i === 6 ? " sat" : ""}`} key={w}>
                {w}
              </div>
            ))}
            {grid.map((d, i) => {
              if (!d) return <div className="cal-cell empty" key={`e${i}`} />;
              const key = ymd(d);
              const list = byDate.get(key) ?? [];
              const dow = d.getDay();
              return (
                <button
                  key={key}
                  className={`cal-cell${key === todayStr ? " today" : ""}${key === selected ? " selected" : ""}`}
                  onClick={() => {
                    setSelected(key);
                    setFormDate(key);
                  }}
                >
                  <span className={`cal-day${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}`}>
                    {d.getDate()}
                  </span>
                  <span className="cal-events">
                    {list.slice(0, 3).map((e) => (
                      <span
                        className={`cal-chip ${e.kind}${e.todo && e.done ? " done" : ""}`}
                        key={e.id}
                        title={`${e.time ? `${e.time} ` : ""}${e.title}${e.memo ? ` — ${e.memo}` : ""}`}
                      >
                        {e.todo ? (e.done ? "✅" : "☐") : e.repeat ? "↻" : ""}
                        {e.title}
                      </span>
                    ))}
                    {list.length > 3 && <span className="cal-more">+{list.length - 3}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="cal-side">
          {/* 선택일 상세 — 메모가 주인공답게 제 줄을 갖는다 (2026-08-27 개편) */}
          <h3 className="section-heading">{selected} 일정</h3>
          {selectedEvents.length === 0 ? (
            <div className="empty">등록된 일정이 없습니다 — 아래에서 바로 추가하세요.</div>
          ) : (
            <div className="cal-list">
              {selectedEvents.map((e) => (
                <div
                  className={`cal-ev${editingId === e.id.split("@")[0] ? " editing" : ""}${e.todo && e.done ? " done" : ""}`}
                  key={e.id}
                >
                  <div className="cal-ev-head">
                    {e.todo && (
                      <input
                        type="checkbox"
                        checked={Boolean(e.done)}
                        onChange={() => void toggleDone(e)}
                        title={e.done ? "다시 할 일로" : "완료"}
                      />
                    )}
                    <span className={`cal-badge ${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                    {e.repeat && (
                      <span className="cal-badge market" title="반복 일정">
                        ↻ {e.repeat === "weekly" ? "매주" : e.repeat === "monthly" ? "매월" : "매년"}
                      </span>
                    )}
                    <span className="cal-item-title">
                      {e.time && <b>{e.time} </b>}
                      {e.title}
                    </span>
                    {/* 가져온 일정(source 있음)도 고칠 수 있다 — 단 다음 동기화 때 원본으로 돌아간다 */}
                    <button className="row-del-btn" onClick={() => startEdit(e)} title="수정">
                      ✎
                    </button>
                    <button className="row-del-btn" onClick={() => void removeEvent(e)} title="삭제">
                      ✕
                    </button>
                  </div>
                  {e.memo && <div className="cal-ev-memo">{e.memo}</div>}
                </div>
              ))}
            </div>
          )}

          {/* 추가/수정 폼 — 같은 폼이다. 수정 중이면 테두리와 버튼이 바뀐다 */}
          <div className={`cal-form${editingId ? " editing" : ""}`}>
            {editingId && (
              <div className="pt-n" style={{ marginBottom: 4 }}>
                ✎ 일정 수정 중 — 저장하면 반영됩니다
              </div>
            )}
            <div className="ma-form-row">
              <input
                className="ma-input"
                type="date"
                value={formDate}
                onChange={(e) => setFormDate(e.target.value)}
                title="날짜"
              />
              <select
                className="group-select"
                value={kind}
                onChange={(e) => setKind(e.target.value as EventKind)}
              >
                {(Object.keys(KIND_LABEL) as EventKind[]).map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </select>
              <input
                className="ma-input"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                title="시간 (비우면 종일)"
              />
            </div>
            <div className="ma-form-row">
              {/* 반복·할 일 (2026-08-27) — 상호 배타: 반복 할 일의 「완료」는 다른 문제다 */}
              <select
                className="group-select"
                value={isTodo ? "none" : repeat}
                disabled={isTodo}
                onChange={(e) => setRepeat(e.target.value as typeof repeat)}
                title="반복"
              >
                <option value="none">반복 없음</option>
                <option value="weekly">매주</option>
                <option value="monthly">매월</option>
                <option value="yearly">매년</option>
              </select>
              <label className="filter-btn" style={{ cursor: "pointer" }}>
                <input
                  type="checkbox"
                  checked={isTodo}
                  onChange={(e) => {
                    setIsTodo(e.target.checked);
                    if (e.target.checked) setRepeat("none");
                  }}
                />{" "}
                ☑ 할 일
              </label>
            </div>
            <div className="ma-form-row">
              <input
                className="ma-input wide"
                placeholder={isTodo ? "할 일 제목" : "일정 제목"}
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && submitEvent()}
              />
            </div>
            <textarea
              className="ma-input wide cal-memo-input"
              rows={2}
              placeholder="메모 (선택) — 일정을 열면 그대로 보입니다"
              value={memo}
              onChange={(e) => setMemo(e.target.value)}
            />
            <div className="ma-form-row">
              <button className="filter-btn active" onClick={submitEvent}>
                {editingId ? "수정 저장" : "추가"}
              </button>
              {editingId && (
                <button className="filter-btn" onClick={resetForm}>
                  취소
                </button>
              )}
            </div>
          </div>
          <div className="table-note">
            선물옵션 동시만기·휴장일은 처음 실행할 때 자동으로 들어갑니다. 날짜를 바꿔서
            저장하면 일정이 그 날짜로 옮겨집니다. 반복 일정은 정한 날짜가 첫 회입니다.
          </div>
        </div>
      </div>
      )}

      {/* ── 다가오는·할 일 ── */}
      {tab === "plan" && (
        <div className="cal-plan">
          <h3 className="section-heading">다가오는 일정 (14일)</h3>
          {upcoming === null ? (
            <div className="empty">불러오는 중…</div>
          ) : upcoming.length === 0 ? (
            <div className="empty">14일 안에 잡힌 일정이 없습니다.</div>
          ) : (
            <div className="cal-up">
              {upcoming.map((e) => (
                <button
                  className="cal-up-row"
                  key={e.id}
                  onClick={() => {
                    jumpTo(e.date);
                    setTab("cal");
                  }}
                >
                  <em className={`cal-dday${dday(e.date) === "오늘" ? " now" : dday(e.date) === "내일" ? " soon" : ""}`}>
                    {dday(e.date)}
                  </em>
                  <span className="cal-up-date pt-n">
                    {e.date.slice(5).replace("-", "/")}
                    {e.time && ` ${e.time}`}
                  </span>
                  <span className={`cal-badge ${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                  <b className="cal-up-title">
                    {e.todo ? (e.done ? "✅ " : "☐ ") : e.repeat ? "↻ " : ""}
                    {e.title}
                  </b>
                </button>
              ))}
            </div>
          )}

          {/* 할 일 — 날짜가 지나도 끝내기 전엔 남는다 */}
          <h3 className="section-heading">할 일</h3>
          {allEvents === null ? (
            <div className="empty">불러오는 중…</div>
          ) : (
            (() => {
              const open = allEvents.filter((e) => e.todo && !e.done);
              const closed = allEvents.filter((e) => e.todo && e.done);
              return (
                <>
                  {open.length === 0 && (
                    <div className="empty">남은 할 일이 없습니다 — 달력 탭에서 「☑ 할 일」로 추가하세요.</div>
                  )}
                  <div className="cal-list">
                    {open
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map((e) => (
                        <div className="cal-ev" key={e.id}>
                          <div className="cal-ev-head">
                            <input type="checkbox" checked={false} onChange={() => void toggleDone(e)} title="완료" />
                            <em
                              className={`cal-dday${dday(e.date) === "오늘" ? " now" : e.date < ymd(new Date()) ? " late" : ""}`}
                            >
                              {e.date < ymd(new Date()) ? "지남" : dday(e.date)}
                            </em>
                            <span className="cal-item-title">{e.title}</span>
                            <button className="row-del-btn" onClick={() => void removeEvent(e)} title="삭제">
                              ✕
                            </button>
                          </div>
                          {e.memo && <div className="cal-ev-memo">{e.memo}</div>}
                        </div>
                      ))}
                  </div>
                  {closed.length > 0 && (
                    <details className="cal-fold">
                      <summary>완료한 할 일 ({closed.length})</summary>
                      <div className="cal-list">
                        {closed.slice(-20).map((e) => (
                          <div className="cal-ev done" key={e.id}>
                            <div className="cal-ev-head">
                              <input type="checkbox" checked onChange={() => void toggleDone(e)} title="다시 할 일로" />
                              <span className="pt-n">{e.date.slice(5)}</span>
                              <span className="cal-item-title">{e.title}</span>
                              <button className="row-del-btn" onClick={() => void removeEvent(e)} title="삭제">
                                ✕
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </details>
                  )}
                </>
              );
            })()
          )}
        </div>
      )}

      {/* ── 오늘 공시 — 맨 앞에 슈퍼신호등 종목 것부터 선다 ── */}
      {tab === "dart" && <DartTodayPanel />}

      {/* ── 가져오기 ── */}
      {tab === "import" && (
        <>
      <details className="cal-fold" open>
        <summary>경제 캘린더 (FOMC·CPI·금통위 시드)</summary>
        <EconomicCalendarCard onInstalled={load} />
      </details>

      <details className="cal-fold">
        <summary>이미지에서 일정 가져오기</summary>
        <p className="page-note">
          증권사 리포트 캡처, 카톡으로 받은 일정표, 손으로 적은 메모 사진을 그대로 올리면
          날짜와 제목을 뽑아냅니다. <b>확인 후 추가</b>하는 방식이라 잘못 인식된 건 빼거나 고칠 수 있습니다.
        </p>
        <CalendarImageImport onImported={load} />
      </details>

      <details className="cal-fold">
        <summary>외부 일정 가져오기 (구글 캘린더·ICS·CSV)</summary>

        <div className="ma-form-row">
          <input
            className="ma-input wide"
            placeholder="iCal 주소 (구글 캘린더 '비공개 주소(ICAL)')"
            value={subUrl}
            onChange={(e) => setSubUrl(e.target.value)}
          />
          <input
            className="ma-input"
            placeholder="이름"
            value={subLabel}
            onChange={(e) => setSubLabel(e.target.value)}
          />
          <button className="filter-btn active" onClick={addSubscription} disabled={busy}>
            구독 추가
          </button>
          <button className="filter-btn" onClick={syncNow} disabled={busy}>
            {busy ? "처리 중…" : "지금 동기화"}
          </button>
        </div>

        {subs.length > 0 && (
          <div className="cal-list">
            {subs.map((s) => (
              <div className="cal-item" key={s.url}>
                <span className="cal-badge market">구독</span>
                <span className="cal-item-title">
                  {s.label} <span className="rl-sub">{s.masked} · {s.count}건</span>
                </span>
                <button className="row-del-btn" onClick={() => removeSubscription(s.url)}>
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="ma-form-row" style={{ marginTop: 10 }}>
          <label className="filter-btn" style={{ cursor: "pointer" }}>
            파일 업로드 (.ics / .csv)
            <input type="file" accept=".ics,.csv,text/calendar,text/csv" onChange={onFile} hidden />
          </label>
        </div>

        {importMsg && <div className="page-note">{importMsg}</div>}

        <div className="table-note">
          구글 캘린더: 설정 → 내 캘린더 설정 → 캘린더 통합 → <b>비공개 주소(ICAL)</b>를 복사해
          위에 붙여넣으세요. 읽기 전용이라 이 앱에서 수정해도 구글에는 반영되지 않습니다.
          <br />
          CSV 형식: <code>날짜,제목,종류,시간,메모</code> (예: <code>2026-08-20,FOMC,증시,03:00,새벽</code>)
          <br />
          같은 파일·주소를 다시 가져오면 <b>기존 것을 지우고 새로 넣습니다</b> (중복 안 쌓임).
          직접 입력한 일정은 건드리지 않습니다.
        </div>
      </details>
        </>
      )}
    </div>
  );
}
