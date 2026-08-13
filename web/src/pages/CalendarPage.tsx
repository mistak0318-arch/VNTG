import { useEffect, useMemo, useState } from "react";
import { api, type CalendarEvent, type EventKind } from "../api";
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

export function CalendarPage() {
  const [cursor, setCursor] = useState(() => new Date());
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(() => ymd(new Date()));

  // 외부 가져오기
  const [subs, setSubs] = useState<{ label: string; masked: string; url: string; count: number }[]>([]);
  const [subUrl, setSubUrl] = useState("");
  const [subLabel, setSubLabel] = useState("");
  const [importMsg, setImportMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 입력 폼
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState<EventKind>("personal");
  const [time, setTime] = useState("");
  const [memo, setMemo] = useState("");

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

  async function addEvent() {
    if (!title.trim()) return;
    try {
      const res = await api.calendarAdd({
        date: selected,
        title,
        kind,
        time: time || undefined,
        memo: memo || undefined,
      });
      setEvents(res.events.filter((e) => e.date.startsWith(monthKey(cursor))));
      setTitle("");
      setTime("");
      setMemo("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "추가 실패");
    }
  }

  async function removeEvent(id: string) {
    try {
      const res = await api.calendarRemove(id);
      setEvents(res.events.filter((e) => e.date.startsWith(monthKey(cursor))));
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 실패");
    }
  }

  function shiftMonth(delta: number) {
    setCursor((c) => new Date(c.getFullYear(), c.getMonth() + delta, 1));
  }

  const grid = buildGrid(cursor);
  const todayStr = ymd(new Date());
  const selectedEvents = byDate.get(selected) ?? [];

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} />
      {error && <div className="error-banner">{error}</div>}

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
              onClick={() => setSelected(key)}
            >
              <span className={`cal-day${dow === 0 ? " sun" : dow === 6 ? " sat" : ""}`}>
                {d.getDate()}
              </span>
              <span className="cal-events">
                {list.slice(0, 3).map((e) => (
                  <span className={`cal-chip ${e.kind}`} key={e.id} title={e.title}>
                    {e.title}
                  </span>
                ))}
                {list.length > 3 && <span className="cal-more">+{list.length - 3}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <section className="card">
        <h2>{selected} 일정</h2>

        {selectedEvents.length === 0 ? (
          <div className="empty">등록된 일정이 없습니다.</div>
        ) : (
          <div className="cal-list">
            {selectedEvents.map((e) => (
              <div className="cal-item" key={e.id}>
                <span className={`cal-badge ${e.kind}`}>{KIND_LABEL[e.kind]}</span>
                <span className="cal-item-title">
                  {e.time && <b>{e.time} </b>}
                  {e.title}
                  {e.memo && <span className="rl-sub"> — {e.memo}</span>}
                </span>
                <button className="row-del-btn" onClick={() => removeEvent(e.id)} title="삭제">
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="ma-form-row" style={{ marginTop: 12 }}>
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
          <input
            className="ma-input wide"
            placeholder="일정 제목"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addEvent()}
          />
          <input
            className="ma-input wide"
            placeholder="메모 (선택)"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
          />
          <button className="filter-btn active" onClick={addEvent}>
            추가
          </button>
        </div>
        <div className="table-note">
          선물옵션 동시만기·휴장일은 처음 실행할 때 자동으로 들어갑니다. 구글 캘린더 연동은 추후
          iCal 읽기 방식으로 붙일 예정입니다.
        </div>
      </section>

      <section className="card">
        <h2>외부 일정 가져오기</h2>

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
      </section>
    </div>
  );
}
