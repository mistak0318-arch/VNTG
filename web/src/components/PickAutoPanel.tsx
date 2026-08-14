import { useEffect, useState } from "react";
import { api, type PickAutoConfig } from "../api";

/**
 * 선별 자동 발송 설정.
 *
 * 선별은 AI를 안 쓰므로 **비용이 0**이다. 그래서 자주 받아도 되는데, 관건은 텔레그램
 * 호출량이었다 — 새 글이 있는 채널만 골라 읽도록 바꾼 뒤로는 5분 주기도 감당된다.
 *
 * 알림은 많아지면 안 보게 되므로 **시간대와 요일을 제한**할 수 있게 뒀다.
 * 새벽에 울리는 알림만큼 빨리 무시하게 되는 것도 없다.
 */
export function PickAutoPanel() {
  const [cfg, setCfg] = useState<PickAutoConfig | null>(null);
  const [intervals, setIntervals] = useState<number[]>([]);
  const [mailReady, setMailReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    api
      .channelConfig()
      .then((r) => {
        setCfg(r.config.pickAuto);
        setIntervals(r.intervals);
        setMailReady(r.mailConfigured);
      })
      .catch(() => undefined);
  }, []);

  function patch(next: Partial<PickAutoConfig>) {
    setCfg((p) => (p ? { ...p, ...next } : p));
    setDirty(true);
    setNote(null);
  }

  async function save() {
    if (!cfg) return;
    setSaving(true);
    try {
      const r = await api.channelConfigSave({ pickAuto: cfg });
      setCfg(r.config.pickAuto);
      setDirty(false);
      setNote("저장했습니다.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  if (!cfg) return <div className="empty">불러오는 중…</div>;

  const noChannel = cfg.enabled && !cfg.telegram && !cfg.mail;

  return (
    <>
      <p className="page-note">
        AI를 거치지 않고 <b>필터가 걸러낸 원문 그대로</b> 정해진 주기마다 보냅니다.
        토큰 비용이 들지 않으므로 자주 받아도 됩니다. 지난번 이후 <b>새로 온 것만</b> 보내며,
        걸린 게 없으면 보내지 않습니다.
      </p>

      <div className="pa-row">
        <label className="rs-check">
          <input
            type="checkbox"
            checked={cfg.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          자동 발송 사용
        </label>
      </div>

      <div className="pa-row">
        <span className="rs-cap">주기</span>
        {intervals.map((m) => (
          <button
            key={m}
            className={`filter-btn ${cfg.intervalMin === m ? "active" : ""}`}
            onClick={() => patch({ intervalMin: m })}
          >
            {m}분
          </button>
        ))}
      </div>

      <div className="pa-row">
        <span className="rs-cap">받는 곳</span>
        <label className="rs-check">
          <input
            type="checkbox"
            checked={cfg.telegram}
            onChange={(e) => patch({ telegram: e.target.checked })}
          />
          텔레그램
        </label>
        <label className="rs-check">
          <input
            type="checkbox"
            checked={cfg.mail}
            disabled={!mailReady}
            onChange={(e) => patch({ mail: e.target.checked })}
          />
          이메일{!mailReady && " (메일 설정 필요)"}
        </label>
      </div>

      <div className="pa-row">
        <span className="rs-cap">시간대</span>
        <input
          className="search-input pa-hour"
          type="number"
          min={0}
          max={23}
          value={cfg.startHour}
          onChange={(e) => patch({ startHour: Number(e.target.value) })}
        />
        <span>시 ~</span>
        <input
          className="search-input pa-hour"
          type="number"
          min={0}
          max={23}
          value={cfg.endHour}
          onChange={(e) => patch({ endHour: Number(e.target.value) })}
        />
        <span>시</span>
        <label className="rs-check">
          <input
            type="checkbox"
            checked={cfg.weekdayOnly}
            onChange={(e) => patch({ weekdayOnly: e.target.checked })}
          />
          평일만
        </label>
      </div>

      <div className="pa-row">
        <span className="rs-cap">훑는 범위</span>
        {[1, 2, 4, 6].map((h) => (
          <button
            key={h}
            className={`filter-btn ${cfg.windowHours === h ? "active" : ""}`}
            onClick={() => patch({ windowHours: h })}
            title={`최근 ${h}시간 안의 메시지만 대상으로 합니다`}
          >
            {h}시간
          </button>
        ))}
      </div>

      <div className="filter-row">
        <button className="primary-btn" onClick={() => void save()} disabled={saving || !dirty}>
          {saving ? "저장 중…" : dirty ? "저장" : "저장됨"}
        </button>
      </div>

      {noChannel && (
        <div className="alert-note">
          받는 곳을 하나도 고르지 않았습니다. 텔레그램이나 이메일 중 최소 하나를 켜야 발송됩니다.
        </div>
      )}
      {note && <div className="alert-note">{note}</div>}

      <div className="table-note">
        주기를 짧게 잡아도 텔레그램 호출은 늘지 않습니다 — 대화 목록을 한 번만 확인해{" "}
        <b>새 글이 있는 채널만</b> 읽기 때문입니다. 다만 알림은 많아지면 안 보게 되므로,
        처음에는 <b>10분·평일·07~20시</b>로 두고 쓰면서 줄이거나 늘리는 걸 권합니다.
      </div>
    </>
  );
}
