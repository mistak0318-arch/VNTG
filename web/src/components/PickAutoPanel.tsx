import { useEffect, useState } from "react";
import { api, type ChannelEntry, type PickAutoConfig } from "../api";

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
        setPinned(r.config.pinned ?? []);
        setIntervals(r.intervals);
        setMailReady(r.mailConfigured);
      })
      .catch(() => undefined);
  }, []);

  /*
   * 고정 채널 — 선별을 거치지 않고 원문 그대로 리포트 맨 위에 올릴 채널.
   *
   * 정해진 시각에 완결된 시황을 올리는 채널은 다른 채널의 조각 정보와 같은 저울에
   * 올리면 안 된다. 점수가 낮다고 잘려 나가면 정작 제일 읽을 만한 글을 놓친다.
   */
  const [pinned, setPinned] = useState<string[]>([]);
  const [pinInput, setPinInput] = useState("");
  /*
   * 고를 수 있는 채널 목록.
   *
   * 예전엔 아이디를 손으로 적어야 했다. 그런데 **내가 들어가 있는 대화방 아이디를
   * 다 알 리가 없다** — 이름은 아는데 @아이디는 모르는 방이 대부분이다.
   * 「채널 관리」가 이미 목록을 들고 있으므로 그걸 그대로 가져와 고르게 한다.
   * 직접 입력도 남긴다 — 목록에 안 잡히는 방이 있다.
   */
  const [known, setKnown] = useState<ChannelEntry[]>([]);
  useEffect(() => {
    api
      .channels()
      .then((r) => setKnown(r.channels))
      .catch(() => undefined);
  }, []);

  function addPin() {
    const v = pinInput.trim().replace(/^@/, "").replace(/^https?:\/\/t\.me\//, "").toLowerCase();
    if (!v || pinned.includes(v)) return;
    setPinned((p) => [...p, v]);
    setPinInput("");
    setDirty(true);
  }

  function patch(next: Partial<PickAutoConfig>) {
    setCfg((p) => (p ? { ...p, ...next } : p));
    setDirty(true);
    setNote(null);
  }

  async function save() {
    if (!cfg) return;
    setSaving(true);
    try {
      // 고정 채널은 이 패널이 안 건드린다 — 받은 그대로 돌려줘야 안 지워진다
      const r = await api.channelConfigSave({ pickAuto: cfg, pinned });
      setCfg(r.config.pickAuto);
      setPinned(r.config.pinned);
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

      {/*
        고정 채널. 정해진 시각에 완결된 시황을 올리는 채널은 다른 채널의 조각 정보와
        같은 저울에 올리면 안 된다 — 점수가 낮다고 잘려 나가면 제일 읽을 만한 글을 놓친다.
      */}
      <div className="tg-ctl">
        <span className="tg-ctl-label">고정 채널</span>
        <div className="tg-ctl-body">
          {pinned.map((u) => (
            <span className="pin-chip" key={u}>
              {/* 이름을 같이 보여 준다. @아이디만 있으면 어느 방인지 알아보기 어렵다 */}
              {known.find((c) => c.username?.toLowerCase() === u)?.name ?? ""} @{u}
              <button
                onClick={() => {
                  setPinned((p) => p.filter((x) => x !== u));
                  setDirty(true);
                }}
                title="빼기"
              >
                ✕
              </button>
            </span>
          ))}
          {/*
            목록에서 고르기. 이름으로 찾을 수 있어야 한다 — 아이디는 대개 모른다.
            아이디가 없는 방(비공개)은 고정할 수 없으므로 목록에서 뺀다.
          */}
          <select
            className="pt-input short"
            value=""
            onChange={(e) => {
              const v = e.target.value;
              if (v && !pinned.includes(v)) {
                setPinned((p) => [...p, v]);
                setDirty(true);
              }
            }}
          >
            {/*
              목록이 비면 고장 난 것처럼 보인다. 왜 비었는지 말해 준다 —
              대개 「채널 관리」에서 아직 목록을 받아오지 않았거나, 텔레그램 세션이
              이 기기에 없는 경우다(세션은 미니PC 한 대에서만 돈다).
            */}
            <option value="">
              {known.length === 0
                ? "채널 목록이 비어 있습니다 — 「채널 관리」에서 먼저 갱신하세요"
                : "채널 목록에서 고르기…"}
            </option>
            {known
              .filter((c) => c.username && !pinned.includes(c.username.toLowerCase()))
              .map((c) => (
                <option key={c.id} value={c.username!.toLowerCase()}>
                  {c.name} (@{c.username})
                </option>
              ))}
          </select>
          <input
            className="pt-input short"
            placeholder="목록에 없으면 직접 (ehdwl 또는 t.me 주소)"
            value={pinInput}
            onChange={(e) => setPinInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPin()}
          />
          <button className="filter-btn" onClick={addPin} disabled={!pinInput.trim()}>
            + 고정
          </button>
        </div>
      </div>
      <div className="table-note">
        고정한 채널의 글은 <b>선별도 AI 요약도 거치지 않고</b> 데일리 리포트 맨 위에 원문
        그대로 올라갑니다. 이미 사람이 정리해 둔 글을 다시 요약하면 정보만 잃습니다.
        판마다 보는 창이 다릅니다 — 조간은 밤사이 12시간, 장중·석간은 직전 8시간.
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
