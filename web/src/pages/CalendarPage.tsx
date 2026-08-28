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

/** 달력 보기 — 월(전체) · 주(한눈에) · 일(시간 단위 입력) (2026-08-27, 구글 캘린더처럼) */
type CalView = "month" | "week" | "day";

/**
 * CSV 양식 내려받기 — **AI 에게 그대로 주기 위한 파일.**
 *
 * 증권사가 월 1회 내는 캘린더를 AI 에게 주면서 「이 양식대로 채워 줘」라고 할 때
 * 쓴다. 그래서 **규칙을 파일 안에 주석으로 적는다** — 설명서가 따로 있으면 AI 에게
 * 줄 때 그것까지 챙겨야 하고, 대개 안 챙긴다.
 *
 * `#` 로 시작하는 줄은 파서가 날짜 자리에서 8자리 숫자를 못 찾아 그냥 건너뛴다.
 * 예시 줄도 실제 파서가 읽는 꼴 그대로 적었다 — 양식과 파서가 어긋나면 안 된다.
 */
function downloadCsvTemplate() {
  const lines = [
    "# VNTG 캘린더 가져오기 양식",
    "# ─────────────────────────────────────────────",
    "# 열 순서: 날짜,제목,종류,시간,메모",
    "#",
    "# 날짜 (필수) 2026-09-01 / 2026.09.01 / 20260901 다 됩니다",
    "# 제목 (필수) 짧게. 목록에 그대로 보입니다",
    "# 종류 (선택) 증시 · 실적 · 휴장 · 개인  (비우면 개인)",
    "# 시간 (선택) 03:00 처럼 24시간. 비우면 종일 일정",
    "#            ⚠️ 한국 시각으로 적으세요 — FOMC 는 한국 새벽입니다",
    "# 메모 (선택) 쉼표가 들어가면 \"큰따옴표\"로 감싸세요",
    "#",
    "# ⚠️ 같은 파일 이름으로 다시 올리면 그 파일로 넣었던 일정을 지우고 새로 넣습니다.",
    "#    직접 입력한 일정은 건드리지 않습니다.",
    "# ─────────────────────────────────────────────",
    "날짜,제목,종류,시간,메모",
    "2026-09-01,한국 8월 수출입,증시,09:00,전년 대비 증감률",
    "2026-09-05,미국 8월 고용보고서,증시,21:30,실업률·비농업 고용",
    "2026-09-17,FOMC 결과,증시,03:00,\"금리 결정, 점도표\"",
    "2026-09-30,삼성전자 3분기 잠정실적,실적,,",
    "2026-10-03,개천절 휴장,휴장,,",
  ];
  /* BOM 을 붙인다 — 엑셀이 UTF-8 을 못 알아보고 한글을 깬다 */
  const blob = new Blob([`﻿${lines.join("\n")}\n`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "VNTG_캘린더_양식.csv";
  a.click();
  URL.revokeObjectURL(url);
}

export function CalendarPage() {
  const [tab, setTab] = useState<CalTab>("cal");
  const [view, setView] = useState<CalView>("month");
  const [cursor, setCursor] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(() => ymd(new Date()));
  /** 할 일 탭용 — 월과 무관한 원본 전체 (반복 전개 없음) */
  const [allEvents, setAllEvents] = useState<CalendarEvent[] | null>(null);
  /** 일정 미니팝업 (2026-08-27) — 어느 목록에서든 누르면 메모 전체·시간·반복이 보인다 */
  const [detail, setDetail] = useState<CalendarEvent | null>(null);

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
      /* 월 앞뒤로 일주일 여유 — 주·일 보기가 월 경계를 넘어도 한 번에 커버된다 */
      const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
      const last = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0);
      const from = ymd(new Date(first.getTime() - 7 * 86400_000));
      const to = ymd(new Date(last.getTime() + 7 * 86400_000));
      setEvents((await api.calendarRange(from, to)).events);
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

  /** 보기 단위로 이동 — 월은 ±1개월, 주는 ±7일, 일은 ±1일. 주·일은 선택일이 기준이다 */
  function shiftView(delta: number) {
    if (view === "month") {
      shiftMonth(delta);
      return;
    }
    const days = view === "week" ? 7 : 1;
    const next = new Date(new Date(`${selected}T00:00`).getTime() + delta * days * 86400_000);
    setSelected(ymd(next));
    setFormDate(ymd(next));
    // 로드 범위(cursor 월 ±7일)를 벗어나면 달을 따라 옮긴다
    if (next.getMonth() !== cursor.getMonth() || next.getFullYear() !== cursor.getFullYear()) {
      setCursor(new Date(next.getFullYear(), next.getMonth(), 1));
    }
  }

  /** 선택일이 낀 주의 일요일 */
  function weekStart(dateStr: string): Date {
    const d = new Date(`${dateStr}T00:00`);
    return new Date(d.getTime() - d.getDay() * 86400_000);
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
            <button className="filter-btn" onClick={() => shiftView(-1)}>
              ‹ 이전
            </button>
            <span className="cal-month">
              {view === "month"
                ? `${cursor.getFullYear()}년 ${cursor.getMonth() + 1}월`
                : view === "week"
                  ? (() => {
                      const s = weekStart(selected);
                      const e = new Date(s.getTime() + 6 * 86400_000);
                      return `${s.getMonth() + 1}/${s.getDate()} ~ ${e.getMonth() + 1}/${e.getDate()}`;
                    })()
                  : `${selected} (${WEEKDAYS[new Date(`${selected}T00:00`).getDay()]})`}
            </span>
            <button className="filter-btn" onClick={() => shiftView(1)}>
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
            {/* 보기 전환 (2026-08-27) — 월=전체, 주=한눈에, 일=시간 단위 입력 */}
            <span className="cal-views">
              {(
                [
                  { key: "month", label: "월" },
                  { key: "week", label: "주" },
                  { key: "day", label: "일" },
                ] as const
              ).map((v) => (
                <button
                  key={v.key}
                  className={`filter-btn${view === v.key ? " active" : ""}`}
                  onClick={() => setView(v.key)}
                >
                  {v.label}
                </button>
              ))}
            </span>
          </div>

          {view === "month" && (
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
                        title={`${e.time ? `${e.time} ` : ""}${e.title} — 눌러서 자세히`}
                        onClick={(ev) => {
                          ev.stopPropagation(); // 날짜 선택까지 겹치지 않게
                          setDetail(e);
                        }}
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
          )}

          {/* ── 주간 보기 — 7일을 한눈에. 날짜를 누르면 그날이 선택된다 ── */}
          {view === "week" && (
            <div className="cal-week">
              {Array.from({ length: 7 }, (_, i) => {
                const d = new Date(weekStart(selected).getTime() + i * 86400_000);
                const key = ymd(d);
                const list = byDate.get(key) ?? [];
                return (
                  <button
                    key={key}
                    className={`cal-week-col${key === todayStr ? " today" : ""}${key === selected ? " selected" : ""}`}
                    onClick={() => {
                      setSelected(key);
                      setFormDate(key);
                    }}
                  >
                    <span className={`cal-wd${i === 0 ? " sun" : i === 6 ? " sat" : ""}`}>
                      {WEEKDAYS[i]} {d.getDate()}
                    </span>
                    <span className="cal-week-list">
                      {list.map((e) => (
                        <span
                          className={`cal-chip ${e.kind}${e.todo && e.done ? " done" : ""}`}
                          key={e.id}
                          title={`${e.time ? `${e.time} ` : ""}${e.title} — 눌러서 자세히`}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setDetail(e);
                          }}
                        >
                          {e.time && <i className="cal-chip-time">{e.time}</i>}
                          {e.todo ? (e.done ? "✅" : "☐") : e.repeat ? "↻" : ""}
                          {e.title}
                        </span>
                      ))}
                      {list.length === 0 && <span className="cal-week-empty">—</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* ── 일간 보기 — 시간 줄을 누르면 그 시간으로 입력 폼이 맞춰진다.
                 클래스명 주의: .cal-day 는 월 셀의 날짜 숫자가 선점 — dayview 로 갈랐다 ── */}
          {view === "day" && (
            <div className="cal-dayview">
              {(() => {
                const list = byDate.get(selected) ?? [];
                const allDay = list.filter((e) => !e.time);
                const timed = list.filter((e) => e.time);
                const evAt = (h: number) =>
                  timed.filter((e) => Number((e.time ?? "0").split(":")[0]) === h);
                return (
                  <>
                    {allDay.length > 0 && (
                      <div className="cal-day-row allday">
                        <span className="cal-day-h">종일</span>
                        <span className="cal-day-evs">
                          {allDay.map((e) => (
                            <span className={`cal-chip ${e.kind}${e.todo && e.done ? " done" : ""}`} key={e.id}>
                              {e.todo ? (e.done ? "✅" : "☐") : e.repeat ? "↻" : ""}
                              {e.title}
                            </span>
                          ))}
                        </span>
                      </div>
                    )}
                    {Array.from({ length: 17 }, (_, i) => i + 6).map((h) => {
                      const hh = `${String(h).padStart(2, "0")}:00`;
                      const evs = evAt(h);
                      return (
                        <button
                          key={h}
                          className={`cal-day-row${evs.length > 0 ? " has" : ""}`}
                          onClick={() => {
                            setFormDate(selected);
                            setTime(hh);
                          }}
                          title={`${hh} 에 일정 추가`}
                        >
                          <span className="cal-day-h">{hh}</span>
                          <span className="cal-day-evs">
                            {evs.map((e) => (
                              <span
                                className={`cal-chip ${e.kind}`}
                                key={e.id}
                                title={`${e.title} — 눌러서 자세히`}
                                onClick={(ev) => {
                                  ev.stopPropagation();
                                  setDetail(e);
                                }}
                              >
                                <i className="cal-chip-time">{e.time}</i>
                                {e.title}
                                {e.memo && (
                                  <i className="cal-dayev-memo">
                                    {e.memo.replace(/\s+/g, " ").slice(0, 40)}
                                  </i>
                                )}
                              </span>
                            ))}
                          </span>
                        </button>
                      );
                    })}
                  </>
                );
              })()}
            </div>
          )}
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
                    <button className="cal-item-title link-btn" onClick={() => setDetail(e)} title="자세히 보기">
                      {e.time && <b>{e.time} </b>}
                      {e.title}
                    </button>
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
                <button className="cal-up-row" key={e.id} onClick={() => setDetail(e)} title="자세히 보기">
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
                            <button className="cal-item-title link-btn" onClick={() => setDetail(e)} title="자세히 보기">
                              {e.title}
                            </button>
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
          {/*
            양식 내려받기 (2026-08-28) — **AI 에게 이 틀로 채우라고 시키기 위한 것.**
            증권사 월간 캘린더를 AI 에게 주고 「이 양식대로」라고 하면 바로 올릴 수 있는
            파일이 나온다. 그래서 양식 자체에 규칙을 주석으로 적어 둔다 —
            사람이 읽을 설명서가 따로 있으면 AI 에게 줄 때 그것까지 챙겨야 한다.
          */}
          <button className="filter-btn" onClick={downloadCsvTemplate}>
            ⤓ CSV 양식
          </button>
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

      {/* ── 일정 미니팝업 — 메모를 길게 적어도 여기서 전부 읽는다 (2026-08-27) ── */}
      {detail && (
        <div className="overlay" onClick={() => setDetail(null)}>
          <div className="sheet cal-pop" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-header">
              <h2>
                {detail.todo ? (detail.done ? "✅ " : "☐ ") : ""}
                {detail.title}
              </h2>
              <button className="close-btn" onClick={() => setDetail(null)}>
                ✕
              </button>
            </div>
            <div className="cal-pop-meta">
              <span className={`cal-badge ${detail.kind}`}>{KIND_LABEL[detail.kind]}</span>
              {detail.repeat && (
                <span className="cal-badge market">
                  ↻ {detail.repeat === "weekly" ? "매주" : detail.repeat === "monthly" ? "매월" : "매년"}
                  {detail.anchor && ` (첫 회 ${detail.anchor})`}
                </span>
              )}
              {detail.todo && <span className="cal-badge personal">{detail.done ? "완료" : "할 일"}</span>}
            </div>
            <div className="cal-pop-when">
              📅 {detail.date} ({WEEKDAYS[new Date(`${detail.date}T00:00`).getDay()]})
              {detail.time ? ` · 🕐 ${detail.time}` : " · 종일"}
            </div>
            {detail.memo ? (
              <div className="cal-ev-memo cal-pop-memo">{detail.memo}</div>
            ) : (
              <div className="pt-n">메모가 없습니다.</div>
            )}
            <div className="filter-row" style={{ marginTop: 10 }}>
              <button
                className="filter-btn"
                onClick={() => {
                  jumpTo(detail.date);
                  setTab("cal");
                  setDetail(null);
                }}
              >
                📅 달력에서 보기
              </button>
              <button
                className="filter-btn"
                onClick={() => {
                  startEdit(detail);
                  setTab("cal");
                  setDetail(null);
                }}
              >
                ✎ 수정
              </button>
              {detail.todo && (
                <button
                  className="filter-btn"
                  onClick={() => {
                    void toggleDone(detail);
                    setDetail(null);
                  }}
                >
                  {detail.done ? "다시 할 일로" : "✅ 완료"}
                </button>
              )}
              <button
                className="filter-btn danger"
                onClick={() => {
                  void removeEvent(detail);
                  setDetail(null);
                }}
              >
                삭제
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
