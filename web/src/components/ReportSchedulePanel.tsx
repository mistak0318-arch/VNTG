import { useEffect, useState } from "react";
import { api, type EditionSlot } from "../api";

/**
 * 리포트 발행 일정 설정.
 *
 * 07/12/18시 세 판은 코드에 박혀 있었다. 그래서 시각을 바꿔보려 해도, 한 판 더 내보려 해도
 * 코드를 고쳐야 했고 — 무엇보다 **테스트를 못 했다.** 판을 여기서 만들고 지운다.
 *
 * 판마다 프롬프트가 다르므로 종류(kind)는 정해진 넷 중에서 고른다.
 * 개장 전에 "오늘 시장이 어땠나"를 물으면 AI가 0으로 채워진 데이터를 읽고
 * "판단 불가"만 쓰게 되기 때문이다 — 종류가 곧 그 판의 시선이다.
 */

const KINDS: { key: EditionSlot["kind"]; label: string; hint: string }[] = [
  { key: "morning", label: "개장 전", hint: "간밤 해외와 오늘 볼 것. 당일 시세는 다루지 않는다" },
  { key: "intraday", label: "장중", hint: "지금까지의 흐름과 수급" },
  { key: "closing", label: "마감 후", hint: "오늘 하루 총평" },
  { key: "weekend", label: "휴장일", hint: "뉴스만 정리. 시세는 직전 거래일이라 다루지 않는다" },
];

const DAYS: { key: EditionSlot["days"]; label: string }[] = [
  { key: "weekday", label: "평일" },
  { key: "weekend", label: "주말" },
  { key: "always", label: "매일" },
];

function newSlot(): EditionSlot {
  return {
    id: `slot${Date.now().toString(36).slice(-4)}`,
    label: "새 판",
    hour: 9,
    minute: 0,
    kind: "intraday",
    enabled: true,
    days: "weekday",
    deliver: false,
  };
}

export function ReportSchedulePanel() {
  const [slots, setSlots] = useState<EditionSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    api
      .reportSchedule()
      .then((r) => setSlots(r.schedule.slots))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function patch(i: number, next: Partial<EditionSlot>) {
    setSlots((prev) => prev.map((s, idx) => (idx === i ? { ...s, ...next } : s)));
    setDirty(true);
  }

  async function save() {
    setSaving(true);
    setNote(null);
    setError(null);
    try {
      const r = await api.reportScheduleSave(slots);
      setSlots(r.schedule.slots);
      setDirty(false);
      setNote("저장했습니다. 다음 발행부터 적용됩니다.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  if (loading) return <div className="empty">불러오는 중…</div>;

  return (
    <>
      <p className="page-note">
        발행 시각과 판 수를 직접 정합니다. 판을 지우면 그 시각에는 발행하지 않습니다.
        <b> 종류</b>는 그 판이 무엇을 보는지 정합니다 — 개장 전 판에 「장중」을 고르면 아직 없는
        당일 시세를 다루려 해서 내용이 비어버립니다.
      </p>

      {slots.map((s, i) => (
        <div className={`rs-slot${s.enabled ? "" : " off"}`} key={s.id}>
          <div className="rs-row">
            <input
              className="search-input rs-label"
              value={s.label}
              onChange={(e) => patch(i, { label: e.target.value })}
              placeholder="이름"
            />
            <div className="rs-time">
              <input
                className="search-input"
                type="number"
                min={0}
                max={23}
                value={s.hour}
                onChange={(e) => patch(i, { hour: Number(e.target.value) })}
              />
              <span>:</span>
              <input
                className="search-input"
                type="number"
                min={0}
                max={59}
                step={5}
                value={s.minute}
                onChange={(e) => patch(i, { minute: Number(e.target.value) })}
              />
            </div>
            <button
              className="filter-btn"
              onClick={() => {
                setSlots((prev) => prev.filter((_, idx) => idx !== i));
                setDirty(true);
              }}
              title="이 판을 지웁니다"
            >
              삭제
            </button>
          </div>

          <div className="rs-row wrap">
            <span className="rs-cap">종류</span>
            {KINDS.map((k) => (
              <button
                key={k.key}
                className={`filter-btn ${s.kind === k.key ? "active" : ""}`}
                onClick={() => patch(i, { kind: k.key })}
                title={k.hint}
              >
                {k.label}
              </button>
            ))}
            <span className="news-scope-sep" />
            <span className="rs-cap">요일</span>
            {DAYS.map((d) => (
              <button
                key={d.key}
                className={`filter-btn ${s.days === d.key ? "active" : ""}`}
                onClick={() => patch(i, { days: d.key })}
              >
                {d.label}
              </button>
            ))}
          </div>

          <div className="rs-row wrap">
            <label className="rs-check">
              <input
                type="checkbox"
                checked={s.enabled}
                onChange={(e) => patch(i, { enabled: e.target.checked })}
              />
              발행함
            </label>
            <label className="rs-check">
              <input
                type="checkbox"
                checked={s.deliver}
                onChange={(e) => patch(i, { deliver: e.target.checked })}
              />
              텔레그램·메일로 보내기
            </label>
            <span className="rs-hint">{KINDS.find((k) => k.key === s.kind)?.hint}</span>
          </div>
        </div>
      ))}

      <div className="filter-row">
        <button
          className="filter-btn"
          onClick={() => {
            setSlots((prev) => [...prev, newSlot()]);
            setDirty(true);
          }}
        >
          + 판 추가
        </button>
        <button className="primary-btn" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "저장 중…" : dirty ? "저장" : "저장됨"}
        </button>
      </div>

      {note && <div className="alert-note">{note}</div>}
      {error && <div className="error-banner">{error}</div>}

      {slots.filter((s) => s.enabled).length === 0 && (
        <div className="alert-note">
          발행하는 판이 하나도 없습니다. 정기 발행이 멈춘 상태이며, 데일리 리포트 화면의
          <b> 「지금 발행」</b>으로만 볼 수 있습니다.
        </div>
      )}
    </>
  );
}
