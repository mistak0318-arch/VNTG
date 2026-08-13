import { useEffect, useState } from "react";
import { api, type SignalConfig } from "../api";

/**
 * 신호등 기준 설정.
 *
 * 신호등의 핵심은 "내 기준"이라는 점이다. 남이 정한 기준으로 초록불이 떠봐야
 * 훈련이 안 되므로, 항목 사용 여부·가중치·임계값을 전부 여기서 조절한다.
 *
 * 점수 = (통과 항목 가중치 합 / 판단 가능한 항목 가중치 합) × 100.
 * 데이터가 없어 판단 못한 항목은 분모에서도 빠지므로, 항목을 꺼도 나머지 비율은 유지된다.
 */

/** 항목마다 임계값의 의미가 다르다 — 입력창 옆에 단위를 붙여준다 */
const UNITS: Record<string, string> = {
  foreignFlow: "주",
  instFlow: "주",
  profitGrowth: "%",
  sectorStrength: "%",
  marketCap: "억원",
  volume: "억원",
};

/** 임계값이 의미 없는 항목 (통과/실패가 계산으로만 정해짐) */
const NO_THRESHOLD = new Set(["trend"]);

/** 정배열 판정에 고를 수 있는 이동평균선 */
const MA_OPTIONS = [5, 10, 20, 60];

export function SignalConfigPanel() {
  const [config, setConfig] = useState<SignalConfig | null>(null);
  const [defaults, setDefaults] = useState<SignalConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .signalConfig()
      .then((r) => {
        setConfig(r.config);
        setDefaults(r.defaults);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  function patch(next: Partial<SignalConfig>) {
    setConfig((c) => (c ? { ...c, ...next } : c));
    setSaved(false);
  }

  function patchCheck(key: string, next: Partial<SignalConfig["checks"][number]>) {
    setConfig((c) =>
      c ? { ...c, checks: c.checks.map((x) => (x.key === key ? { ...x, ...next } : x)) } : c,
    );
    setSaved(false);
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.signalConfigSave(config);
      setConfig(r.config);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장 실패");
    } finally {
      setSaving(false);
    }
  }

  if (error && !config) return <div className="error-banner">{error}</div>;
  if (!config) return <div className="empty">불러오는 중...</div>;

  const activeWeight = config.checks
    .filter((c) => c.enabled)
    .reduce((sum, c) => sum + c.weight, 0);

  return (
    <div className="sig-config">
      <div className="sig-config-rows">
        {config.checks.map((c) => (
          <div className={`sig-config-row${c.enabled ? "" : " off"}`} key={c.key}>
            <label className="sig-config-name">
              <input
                type="checkbox"
                checked={c.enabled}
                onChange={(e) => patchCheck(c.key, { enabled: e.target.checked })}
              />
              <span>
                <b>{c.label}</b>
                <small>{c.hint}</small>
              </span>
            </label>

            {c.key === "trend" && (
              <div className="sig-ma-picker">
                {MA_OPTIONS.map((n) => {
                  const on = config.maLines.includes(n);
                  // 2개 미만으로는 정배열이 성립하지 않으므로 마지막 하나는 끄지 못하게
                  const locked = on && config.maLines.length <= 2;
                  return (
                    <button
                      key={n}
                      className={`sig-ma-btn${on ? " on" : ""}`}
                      disabled={!c.enabled || locked}
                      title={locked ? "최소 2개는 선택해야 합니다" : undefined}
                      onClick={() =>
                        patch({
                          maLines: (on
                            ? config.maLines.filter((x) => x !== n)
                            : [...config.maLines, n]
                          ).sort((a, b) => a - b),
                        })
                      }
                    >
                      {n}일
                    </button>
                  );
                })}
              </div>
            )}

            <div className="sig-config-inputs">
              <label>
                가중치
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={c.weight}
                  disabled={!c.enabled}
                  onChange={(e) =>
                    patchCheck(c.key, { weight: Math.max(1, Number(e.target.value) || 1) })
                  }
                />
              </label>
              {!NO_THRESHOLD.has(c.key) && (
                <label>
                  기준값
                  <input
                    type="number"
                    value={c.threshold}
                    disabled={!c.enabled}
                    onChange={(e) => patchCheck(c.key, { threshold: Number(e.target.value) || 0 })}
                  />
                  <span className="sig-unit">{UNITS[c.key] ?? ""}</span>
                </label>
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="sig-config-thresholds">
        <label>
          초록 기준
          <input
            type="number"
            min={0}
            max={100}
            value={config.greenAt}
            onChange={(e) => patch({ greenAt: Number(e.target.value) || 0 })}
          />
          점 이상
        </label>
        <label>
          노랑 기준
          <input
            type="number"
            min={0}
            max={100}
            value={config.yellowAt}
            onChange={(e) => patch({ yellowAt: Number(e.target.value) || 0 })}
          />
          점 이상 (미만은 빨강)
        </label>
        <label>
          수급 판정 기간
          <select
            value={config.flowDays}
            onChange={(e) => patch({ flowDays: Number(e.target.value) as 5 | 10 | 20 })}
          >
            <option value={5}>5일</option>
            <option value={10}>10일</option>
            <option value={20}>20일</option>
          </select>
        </label>
      </div>

      <div className="sig-config-actions">
        <button className="primary-btn" onClick={save} disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </button>
        {defaults && (
          <button
            className="filter-btn"
            onClick={() => {
              setConfig(defaults);
              setSaved(false);
            }}
            disabled={saving}
          >
            기본값으로
          </button>
        )}
        {saved && <span className="sig-saved">저장됨 · 다음 평가부터 적용</span>}
        {error && <span className="sig-error">{error}</span>}
      </div>

      <div className="table-note">
        정배열은 <b>현재가 ≥ {[...config.maLines].sort((a, b) => a - b).map((n) => `${n}일`).join(" ≥ ")}</b> 순서를 확인합니다.
        켜져 있는 항목 가중치 합계 <b>{activeWeight}</b>. 평가 결과는 15분간 캐시되므로, 기준을 바꾼
        뒤 바로 보고 싶으면 종목 화면에서 <b>↻ 다시 평가</b>를 누르세요.
      </div>
    </div>
  );
}
