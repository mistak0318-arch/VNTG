import { useEffect, useState } from "react";
import { api, type SignalAxis, type SignalConfig } from "../api";

/**
 * 신호등 기준 설정.
 *
 * 신호등의 핵심은 "내 기준"이라는 점이다. 남이 정한 기준으로 초록불이 떠봐야
 * 훈련이 안 되므로, 항목 사용 여부·가중치·기준값을 전부 여기서 조절한다.
 *
 * ## 축으로 나뉜 뒤 달라진 것 (2026-08-19)
 *
 * 예전엔 여덟 항목을 한 줄로 늘어놨다. 이제 **추세·수급·실적·위험** 네 묶음이고,
 * 묶음마다 가중치가 따로 있다. 무엇을 더 중요하게 보는지를 항목이 아니라 **축 단위로** 정한다.
 *
 * 기준값도 하나에서 둘로 늘었다 — **기준값(50점)** 과 **아주 좋음(100점)**.
 * 예전엔 「외국인이 샀나」만 봤고, 그래서 +1백만원과 +5,000억이 같은 점수였다.
 *
 * **위험 축은 방향이 반대다.** 값이 클수록 위험하고, 통과(✓)는 안전하다는 뜻이다.
 * 그래서 항목 이름을 「매물 부담 낮음」처럼 안전한 상태로 적어 뒀다.
 */

/** 항목마다 기준값의 의미가 다르다 — 입력창 옆에 단위를 붙여준다 */
const UNITS: Record<string, string> = {
  // 예전엔 "주"라고 적혀 있었는데 틀렸다. amt_qty_tp:1 이라 금액(백만원)으로 온다
  foreignFlow: "백만원",
  instFlow: "백만원",
  flowStreak: "일",
  profitGrowth: "%",
  sectorStrength: "%",
  nearHigh: "%",
  marketCap: "억원",
  volume: "억원",
  exportGrowth: "%",
  overhead: "%",
  disparity: "%",
  shortSaleUp: "%",
  lendingUp: "%",
};

/** 기준값이 의미 없는 항목 (통과 여부가 계산으로만 정해진다) */
const NO_THRESHOLD = new Set(["trend"]);

/** 정배열 판정에 고를 수 있는 이동평균선 */
const MA_OPTIONS = [5, 10, 20, 60];

const AXIS_META: { key: SignalAxis; label: string; hint: string }[] = [
  { key: "trend", label: "추세", hint: "지금 올라가는 자리인가" },
  { key: "flow", label: "수급", hint: "누가 사고 있나" },
  { key: "value", label: "실적·가치", hint: "회사가 벌고 있나" },
  {
    key: "risk",
    label: "위험",
    hint: "깨질 구석이 있나 — 이 축만 방향이 반대다. 값이 클수록 위험하고, ✓는 안전하다는 뜻이다",
  },
];

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

  /*
   * 켠 항목이 종목당 조회를 몇 번 더 부르는지 합산한다.
   * 「신호등 찾기」는 100종목을 도니까 여기 1이면 실제로는 100번이 더 나간다 —
   * 눌러 보고 나서 느려진 이유를 찾게 두면 안 된다.
   */
  const extraCalls = config.checks.filter((c) => c.enabled).reduce((s, c) => s + (c.cost ?? 0), 0);

  return (
    <div className="sig-config">
      {AXIS_META.map((axis) => {
        const rows = config.checks.filter((c) => c.axis === axis.key);
        if (rows.length === 0) return null;
        const isRisk = axis.key === "risk";
        return (
          <section className={`sig-axis-group${isRisk ? " risk" : ""}`} key={axis.key}>
            <div className="sig-axis-title">
              <b>{axis.label}</b>
              <small>{axis.hint}</small>
              {!isRisk && (
                <label className="sig-axis-weight">
                  축 가중치
                  <input
                    type="number"
                    min={0}
                    max={10}
                    value={config.axisWeights[axis.key as "trend" | "flow" | "value"]}
                    onChange={(e) =>
                      patch({
                        axisWeights: {
                          ...config.axisWeights,
                          [axis.key]: Math.max(0, Number(e.target.value) || 0),
                        },
                      })
                    }
                  />
                </label>
              )}
            </div>

            <div className="sig-config-rows">
              {rows.map((c) => (
                <div className={`sig-config-row${c.enabled ? "" : " off"}`} key={c.key}>
                  <label className="sig-config-name">
                    <input
                      type="checkbox"
                      checked={c.enabled}
                      onChange={(e) => patchCheck(c.key, { enabled: e.target.checked })}
                    />
                    <span>
                      <b>
                        {c.label}
                        {c.cost > 0 && (
                          <span
                            className="sig-cost"
                            title="이 기준을 켜면 종목당 조회가 그만큼 더 나갑니다. 「신호등 찾기」는 100종목을 돕니다"
                          >
                            +{c.cost}회
                          </span>
                        )}
                      </b>
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
                      <>
                        <label title={isRisk ? "이 값부터 위험으로 봅니다" : "이 값부터 절반(50점)을 줍니다"}>
                          {isRisk ? "위험 시작" : "기준값"}
                          <input
                            type="number"
                            value={c.threshold}
                            disabled={!c.enabled}
                            onChange={(e) =>
                              patchCheck(c.key, { threshold: Number(e.target.value) || 0 })
                            }
                          />
                          <span className="sig-unit">{UNITS[c.key] ?? ""}</span>
                        </label>
                        <label title={isRisk ? "이 값부터 심각한 위험으로 봅니다" : "이 값부터 만점(100점)을 줍니다"}>
                          {isRisk ? "심각" : "아주 좋음"}
                          <input
                            type="number"
                            value={c.strongAt}
                            disabled={!c.enabled}
                            onChange={(e) =>
                              patchCheck(c.key, { strongAt: Number(e.target.value) || 0 })
                            }
                          />
                          <span className="sig-unit">{UNITS[c.key] ?? ""}</span>
                        </label>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </section>
        );
      })}

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

      <div className="sig-config-thresholds risk">
        <label>
          위험 노랑
          <input
            type="number"
            min={0}
            max={100}
            value={config.riskYellowAt}
            onChange={(e) => patch({ riskYellowAt: Number(e.target.value) || 0 })}
          />
          점 이상
        </label>
        <label>
          위험 빨강
          <input
            type="number"
            min={0}
            max={100}
            value={config.riskRedAt}
            onChange={(e) => patch({ riskRedAt: Number(e.target.value) || 0 })}
          />
          점 이상
        </label>
        <label className="sig-block-toggle">
          <input
            type="checkbox"
            checked={config.riskBlocksGreen}
            onChange={(e) => patch({ riskBlocksGreen: e.target.checked })}
          />
          위험이 빨강이면 초록을 주지 않는다
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
        종합 점수는 <b>추세·수급·실적</b> 세 축의 가중평균입니다 — <b>위험은 섞지 않습니다.</b>{" "}
        위험은 따로 재서, 빨강이면 나머지가 아무리 좋아도 초록을 막습니다(위에서 끌 수 있습니다).
        정배열은 <b>현재가 ≥ {[...config.maLines].sort((a, b) => a - b).map((n) => `${n}일`).join(" ≥ ")}</b> 순서를
        확인하고, 완전 정배열이 아니어도 가장 짧은 선 위면 절반을 줍니다.
        {extraCalls > 0 && (
          <>
            {" "}
            지금 켠 기준은 종목당 조회가 <b>{extraCalls}회</b> 더 나갑니다 —
            「신호등 찾기」로 100종목을 돌리면 {extraCalls * 100}회입니다.
          </>
        )}{" "}
        평가 결과는 15분간 캐시되므로, 기준을 바꾼 뒤 바로 보고 싶으면 종목 화면에서{" "}
        <b>↻ 다시 평가</b>를 누르세요.
      </div>
    </div>
  );
}
