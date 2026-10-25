import { useEffect, useState } from "react";
import { api, type CondAutoConfig } from "../api";

/**
 * **조건식 자동 실행 설정** (2026-10-26 — 벤티지: "조건검색식에 이거 걸어놓은거 정규장
 * 끝나면 한바퀴 돌아서 나한테 한번 오게 하자 … 설정창에 설정할 수 있게 좀 해주고
 * 어느방에 보내는 지 언제 돌릴지 이런것들").
 *
 * 돌리는 일은 2026-09-16 부터 하고 있었다 — 없던 것은 **손잡이**다.
 *
 * ## 여기서 정하지 않는 것 둘
 *
 *   **어느 식을 돌릴지** — 조건검색 화면의 `⏰` 토글이 맡는다. 식 옆에서 켜는 게
 *   자연스럽고, 두 곳에 두면 어느 쪽이 맞는지 매번 헷갈린다.
 *
 *   **어느 방으로 보낼지** — 「signal」 채널의 방 배정이고, 텔레그램 동향 화면이 이미
 *   맡고 있다. 같은 것을 두 군데서 고르게 하면 **어느 쪽이 이기는지** 알 수 없다.
 *   그래서 여기서는 그 자리를 가리키기만 한다.
 */
export function CondAutoConfigPanel() {
  const [cfg, setCfg] = useState<CondAutoConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .condAutoConfig()
      .then((c) => alive && setCfg(c))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  const patch = async (next: Partial<CondAutoConfig>) => {
    if (!cfg) return;
    const merged = { ...cfg, ...next };
    setCfg(merged); // 손이 멈추지 않게 화면 먼저
    setSaving(true);
    try {
      setCfg(await api.condAutoConfigSave(next));
    } catch {
      /* 못 저장하면 다음에 열 때 옛 값이 보인다 — 조용히 되돌리지 않는다 */
    } finally {
      setSaving(false);
    }
  };

  if (!cfg) return <div className="empty">불러오는 중…</div>;

  return (
    <div className="ca-cfg">
      <label className="ca-row">
        <input type="checkbox" checked={cfg.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} />
        <span>
          <b>조건식 자동 실행</b>
          <small>
            ⏰ 켜 둔 식을 마감 뒤 한 바퀴 돌려, <b>어제는 없었는데 오늘 새로 걸린 종목</b>만
            텔레그램·알림함으로 보냅니다. 마크만 쓰는 식은 조회가 0회입니다.
          </small>
        </span>
      </label>

      <div className="ca-row">
        <span className="ca-k">언제 돌릴까</span>
        <select
          className="group-select"
          value={cfg.mode}
          disabled={!cfg.enabled}
          onChange={(e) => void patch({ mode: e.target.value as CondAutoConfig["mode"] })}
        >
          <option value="pipeline">마감 정리 직후 (권장)</option>
          <option value="fixed">정한 시각에 따로</option>
        </select>
        {cfg.mode === "fixed" && (
          <span className="ca-time">
            <input
              type="number"
              min={0}
              max={23}
              value={cfg.hour}
              disabled={!cfg.enabled}
              onChange={(e) => void patch({ hour: Number(e.target.value) })}
            />
            시
            <input
              type="number"
              min={0}
              max={59}
              value={cfg.minute}
              disabled={!cfg.enabled}
              onChange={(e) => void patch({ minute: Number(e.target.value) })}
            />
            분
          </span>
        )}
        {saving && <span className="ca-saving">저장 중…</span>}
      </div>

      <div className="table-note">
        {cfg.mode === "pipeline" ? (
          <>
            마감 정리가 <b>전종목 마크를 만든 바로 다음</b>에 돕니다 — 실제로는 16시를 조금
            넘깁니다. 애프터장(16:00~20:00) 시작 직후라 그날 바로 쓸 수 있습니다.
          </>
        ) : (
          <>
            정한 시각에 따로 돕니다. ⚠️ <b>그 시각에 오늘 마크가 없으면 돌지 않고</b> 「마크가
            오늘 것이 아니라 안 돌림」이라고 적습니다 — 조건식은 오늘 일봉·원장이 채워진 뒤에야
            뜻이 있기 때문입니다. <b>15:40 같은 이른 시각은 그래서 빕니다.</b>
          </>
        )}
      </div>
      <div className="table-note">
        <b>어느 식을 돌릴지</b>는 「신호등 찾기 &gt; 조건검색」 화면에서 식 옆의 ⏰ 로 켭니다.{" "}
        <b>어느 방으로 보낼지</b>는 「텔레그램 동향」의 방 배정에서 <b>signal</b> 채널에 방을
        붙이면 됩니다 — 같은 것을 두 군데서 고르게 하지 않으려고 여기 두지 않았습니다.
      </div>
    </div>
  );
}
