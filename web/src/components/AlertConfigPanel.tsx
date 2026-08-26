import { useEffect, useState } from "react";
import { api, type AlertConfig, type TelegramChannelStatus } from "../api";

/**
 * 관심종목 시그널 설정.
 *
 * 알림은 많아지는 순간 무시된다. 그래서 기준값을 올려서 **덜 울리게 만드는 것**이
 * 이 화면의 주된 용도다. 지금 기준으로 몇 건이나 울릴지 미리 볼 수 있어야
 * 감으로 조절하지 않는다 — "지금 검사"가 그 역할이다.
 */

const UNITS: Record<string, string> = {
  priceJump: "%",
  volumeSurge: "배",
};

/**
 * 손절 감시 상태.
 *
 * **끄고 켜는 칸이 없다.** 손절선은 내가 미리 정해 둔 규칙이고, 그게 깨진 걸
 * 알리는 것을 꺼 두는 건 규칙을 지우는 것과 같다. 손절선을 안 적으면 자연히 안 울린다.
 *
 * 대신 여기서 보여줄 것은 **「감시 못 하는 자리가 몇인가」**다. 그게 실은
 * 제일 중요한 숫자다 — 손절선을 안 적은 자리는 이 기능이 아무것도 못 해 준다.
 */
function StopWatchBlock() {
  const [st, setSt] = useState<{
    positions: number;
    watched: number;
    unwatched: number;
    breaks: { code: string; name: string; price: number; stop: number; lossPct: number }[];
  } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .stopWatch()
      .then((r) => alive && setSt(r))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  if (!st) return null;

  return (
    <div className="alert-master">
      <span className="sig-config-name">
        <span>
          <b>🛑 손절 감시</b>
          <small>
            복기 노트에 적어 둔 손절선이 깨지면 시그널 방으로 보냅니다. 장중{" "}
            <b>1분마다</b> 보고, 종목당 <b>하루 한 번</b>만 울립니다. 조회를 새로 부르지
            않으므로 자주 봐도 부담이 없습니다.
          </small>
        </span>
      </span>
      <div className="sw-stat">
        {st.positions === 0 ? (
          <small>
            아직 들고 있는 자리가 없습니다. 복기 노트에 <b>매수</b>를 적으면 여기 잡힙니다.
          </small>
        ) : (
          <small>
            들고 있는 자리 <b>{st.positions}</b> · 감시 중 <b className="positive">{st.watched}</b>
            {st.unwatched > 0 && (
              <>
                {" · "}
                <b className="negative">{st.unwatched}자리는 손절선이 없어 감시 못 합니다</b>
              </>
            )}
            {st.breaks.length > 0 && (
              <>
                <br />
                지금 깨진 자리 —{" "}
                <b className="negative">
                  {st.breaks.map((b) => `${b.name} ${b.lossPct.toFixed(1)}%`).join(", ")}
                </b>
              </>
            )}
          </small>
        )}
      </div>
    </div>
  );
}

/** 기준값이 의미 없는 규칙 (조건이 계산으로만 정해짐) */
const NO_THRESHOLD = new Set(["flowTurn", "newHigh", "trendAlign", "viHit", "brokerExit"]);

/**
 * 조회를 안 쓰는 규칙 — **실시간에서 바로 꺼낸다.**
 *
 * 이걸 표시하는 이유는, 검사 간격을 늘려도 이 둘은 그대로 1분마다 돈다는 걸
 * 알아야 하기 때문이다. 「간격을 20분으로 했는데 왜 VI 가 바로 오지」가 안 생기게.
 */
const LIVE_RULES = new Set(["viHit", "strengthJump"]);

const CHANNEL_LABEL: Record<string, string> = {
  report: "리포트",
  signal: "시그널",
  log: "로그",
  channel: "채널 수집",
  disclosure: "공시",
  keyword: "키워드",
  super: "슈퍼신호등",
};

export function AlertConfigPanel() {
  const [config, setConfig] = useState<AlertConfig | null>(null);
  const [channels, setChannels] = useState<TelegramChannelStatus[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [scanning, setScanning] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [scanNote, setScanNote] = useState<string | null>(null);

  useEffect(() => {
    api
      .alertConfig()
      .then((r) => {
        setConfig(r.config);
        setChannels(r.channels);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  function patch(next: Partial<AlertConfig>) {
    setConfig((c) => (c ? { ...c, ...next } : c));
    setSaved(false);
  }

  function patchRule(key: string, next: Partial<AlertConfig["rules"][number]>) {
    setConfig((c) =>
      c ? { ...c, rules: c.rules.map((x) => (x.key === key ? { ...x, ...next } : x)) } : c,
    );
    setSaved(false);
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.alertConfigSave(config);
      setConfig(r.config);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  /** send=false면 상태를 남기지 않으므로 진짜 알림을 잡아먹지 않는다 */
  async function scan(send: boolean) {
    setScanning(true);
    setPreview(null);
    setScanNote(null);
    try {
      const r = await api.alertScan(send);
      if (r.alerts.length === 0) {
        setScanNote("지금 기준으로는 발동한 시그널이 없습니다.");
      } else {
        setPreview(r.preview.replace(/<[^>]+>/g, ""));
        setScanNote(
          send
            ? r.sent
              ? `${r.alerts.length}건 시그널 방으로 발송했습니다.`
              : `발송 실패: ${r.error ?? "알 수 없음"}`
            : `${r.alerts.length}건 발동 (미리보기 — 실제로 보내지 않았고 중복방지 기록도 남기지 않았습니다)`,
        );
      }
    } catch (err) {
      setScanNote(err instanceof Error ? err.message : "검사 실패");
    } finally {
      setScanning(false);
    }
  }

  if (error && !config) return <div className="error-banner">{error}</div>;
  if (!config) return <div className="empty">불러오는 중...</div>;

  const signalChannel = channels.find((c) => c.channel === "signal");

  return (
    <div className="sig-config">
      <StopWatchBlock />
      <div className="alert-master">
        <label className="sig-config-name">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => patch({ enabled: e.target.checked })}
          />
          <span>
            <b>시그널 알림 사용</b>
            <small>장중(09:00~15:30 평일)에만 검사합니다. 장 끝난 뒤 알림은 쓸모가 없습니다.</small>
          </span>
        </label>
        <label>
          검사 간격
          <input
            type="number"
            min={3}
            max={120}
            value={config.intervalMin}
            disabled={!config.enabled}
            onChange={(e) => patch({ intervalMin: Number(e.target.value) || 10 })}
          />
          분
        </label>
      </div>

      <div className={`sig-config-rows${config.enabled ? "" : " off"}`}>
        {config.rules.map((r) => (
          <div className={`sig-config-row${r.enabled ? "" : " off"}`} key={r.key}>
            <label className="sig-config-name">
              <input
                type="checkbox"
                checked={r.enabled}
                disabled={!config.enabled}
                onChange={(e) => patchRule(r.key, { enabled: e.target.checked })}
              />
              <span>
                <b>
                  {r.label}
                  {LIVE_RULES.has(r.key) && (
                    <i
                      className="sig-live-tag"
                      title="실시간에서 바로 꺼냅니다 — 조회를 안 쓰므로 위 검사 간격과 상관없이 1분마다 봅니다"
                    >
                      실시간 · 1분
                    </i>
                  )}
                </b>
                <small>{r.hint}</small>
              </span>
            </label>

            {!NO_THRESHOLD.has(r.key) && (
              <div className="sig-config-inputs">
                <label>
                  기준값
                  <input
                    type="number"
                    step={r.key === "volumeSurge" ? 0.5 : 1}
                    value={r.threshold}
                    disabled={!config.enabled || !r.enabled}
                    onChange={(e) => patchRule(r.key, { threshold: Number(e.target.value) || 0 })}
                  />
                  <span className="sig-unit">{UNITS[r.key] ?? ""}</span>
                </label>
              </div>
            )}
          </div>
        ))}
      </div>

      <div className="sig-config-actions">
        <button className="primary-btn" onClick={save} disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </button>
        <button className="filter-btn" onClick={() => scan(false)} disabled={scanning}>
          {scanning ? "검사 중…" : "지금 검사 (미리보기)"}
        </button>
        <button className="filter-btn" onClick={() => scan(true)} disabled={scanning}>
          검사 후 실제 발송
        </button>
        {saved && <span className="sig-saved">저장됨</span>}
        {error && <span className="sig-error">{error}</span>}
      </div>

      {scanNote && <div className="alert-note">{scanNote}</div>}
      {preview && <pre className="alert-preview">{preview}</pre>}

      <div className="table-note">
        발송처: <b>{signalChannel?.dedicated ? "VNTG 시그널 전용방" : "기본 대화방"}</b>
        {signalChannel?.chatId ? ` (${signalChannel.chatId})` : " — 텔레그램 키 미설정"}.
        같은 종목·같은 시그널은 <b>하루 1회</b>만 울립니다. 알림이 너무 잦으면 기준값을 올리세요.
        {channels.length > 0 && (
          <>
            {" "}
            연결된 방:{" "}
            {channels
              .map((c) => `${CHANNEL_LABEL[c.channel]}${c.dedicated ? "" : "(기본)"}`)
              .join(" · ")}
          </>
        )}
      </div>
    </div>
  );
}
