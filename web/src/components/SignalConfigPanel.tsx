import { useEffect, useState } from "react";
import { api, type SignalAxis, type SignalConfig } from "../api";
import { SignalSimPanel } from "./SignalSimPanel";

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
  /* 5일선 이격 — 「몇 % 위인가」라 단위가 %. 좁을수록 좋은 점수다 */
  ma5Gap: "%",
  /* 네이버 테마 강세 — 그 종목이 든 테마의 오늘 평균 등락률 */
  naverTheme: "%",
  /* ETF 뒷배 — 이 종목을 가장 많이 담은 ETF 셋의 오늘 등락률 평균 */
  etfBacking: "%",
  nearHigh: "%",
  marketCap: "억원",
  volume: "억원",
  exportGrowth: "%",
  targetUpside: "%",
  targetTrend: "%",
  roe: "%",
  debtRatio: "%",
  overhead: "%",
  disparity: "%",
  shortSaleUp: "%",
  lendingUp: "%",
};

/** 기준값이 의미 없는 항목 (통과 여부가 계산으로만 정해진다) */
const NO_THRESHOLD = new Set(["trend"]);

/** 정배열 판정에 고를 수 있는 이동평균선 */
const MA_OPTIONS = [5, 10, 20, 60];

/**
 * 지금 기준이 추천 기본값과 **어디가 다른가**.
 *
 * ⚠️ 이게 왜 필요한가 (2026-08-28): **저장분이 코드 기본값을 이긴다**(`mergeConfig`).
 * 그래서 추천값을 코드에서 손봐도, 한 번이라도 저장한 적이 있으면 화면은 옛날 값
 * 그대로다. 축 가중치만 그런 게 아니라 **켬/끔·무게·기준값 전부**가 그렇다 —
 * 백테스트로 좋다고 확인한 조합이 정작 실전 신호등에는 하나도 안 들어가 있었다.
 *
 * 조용히 덮어쓰지 않고 **무엇이 다른지 적어서 보여준 뒤** 누르면 바꾼다.
 * 일부러 맞춰 둔 값일 수도 있으니 결정은 사람이 한다.
 */
function diffFromDefaults(cur: SignalConfig, def: SignalConfig): string[] {
  const out: string[] = [];
  for (const k of ["trend", "flow", "value"] as const) {
    const label = { trend: "추세", flow: "수급", value: "실적" }[k];
    if (cur.axisWeights[k] !== def.axisWeights[k]) {
      out.push(`${label} 축 가중치 ${cur.axisWeights[k]} → ${def.axisWeights[k]}`);
    }
  }
  if (cur.regimeSwitch !== def.regimeSwitch)
    out.push(`장세 전환 ${cur.regimeSwitch ? "켬 → 끔" : "끔 → 켬"}`);
  if (cur.bullAt !== def.bullAt) out.push(`강세장 기준 ${cur.bullAt}% → ${def.bullAt}%`);
  if (cur.minCoverage !== def.minCoverage)
    out.push(
      `최소 커버리지 ${Math.round(cur.minCoverage * 100)}% → ${Math.round(def.minCoverage * 100)}%`,
    );
  if (cur.greenTo !== def.greenTo) out.push(`초록 상한 ${cur.greenTo}점 → ${def.greenTo}점`);
  for (const d of def.checks) {
    const c = cur.checks.find((x) => x.key === d.key);
    if (!c) continue;
    if (c.enabled !== d.enabled) out.push(`${d.label} ${c.enabled ? "켬 → 끔" : "끔 → 켬"}`);
    // 꺼진 항목의 무게·기준값은 판정에 안 쓰인다 — 다르다고 알려 봐야 소음이다
    if (!d.enabled && !c.enabled) continue;
    if (c.weight !== d.weight) out.push(`${d.label} 무게 ${c.weight} → ${d.weight}`);
    if (c.threshold !== d.threshold) out.push(`${d.label} 기준값 ${c.threshold} → ${d.threshold}`);
    if (c.strongAt !== d.strongAt) out.push(`${d.label} 아주 좋음 ${c.strongAt} → ${d.strongAt}`);
    if (c.span !== d.span) out.push(`${d.label} 기간 ${c.span ?? "-"}일 → ${d.span ?? "-"}일`);
  }
  return out;
}

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
  /**
   * **서버에 저장된 값** — 화면 값(`config`)과 따로 들고 있는다.
   *
   * ⚠️ 이걸 안 나누어서 관계도가 거짓말을 했다 (2026-08-31). 「전부 추천 기본값으로」를
   * 누르면 `config` 만 바뀌는데, 관계도가 그걸 ②로 보고 **「= 같음 · 반영됨」**이라
   * 적었다 — 저장은 안 됐는데 다 된 것처럼 보였다. 벤티지가 "2번은 된건지 안된건지
   * 내가 알 수가 없네" 라고 한 그 자리다.
   */
  const [savedCfg, setSavedCfg] = useState<SignalConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .signalConfig()
      .then((r) => {
        setConfig(r.config);
        setSavedCfg(r.config);
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
      /* 저장이 성공해야 ②가 바뀐 것이다 — 그때만 갱신한다 */
      setSavedCfg(r.config);
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
  const extraCalls = (() => {
    // 같은 응답을 나눠 쓰는 기준(목표가 괴리율·눈높이 상향)은 둘 다 켜도 호출이 한 번이다.
    // 그냥 더하면 실제보다 비싸게 알려 주게 된다 — 겁줘서 못 켜게 만들면 안 된다
    const seen = new Set<string>();
    let n = 0;
    for (const c of config.checks) {
      if (!c.enabled || !(c.cost > 0)) continue;
      if (c.costGroup) {
        if (seen.has(c.costGroup)) continue;
        seen.add(c.costGroup);
      }
      n += c.cost;
    }
    return n;
  })();

  /*
   * **`stale` 은 저장된 값 기준이다** — 「실제로 도는 신호등이 추천값과 다른가」.
   * 화면 값으로 재면 버튼만 눌러도 「같아졌다」고 나온다(저장 전인데).
   */
  const stale = defaults && savedCfg ? diffFromDefaults(savedCfg, defaults) : [];
  /** 화면에서 만졌는데 아직 저장 안 한 것이 있나 */
  const dirty = savedCfg !== null && JSON.stringify(config) !== JSON.stringify(savedCfg);

  return (
    <div className="sig-config">
      {/*
        **세 겹 관계도** (2026-08-31 — "니가 커밋하면 그게 추천 기본값에 설정된다는거지?
        아 설명에 넣어줘야해 내가 이해할 수 있게 말야").

        이걸 몇 번을 말로 설명해도 계속 헷갈렸다. 화면에 **안 보이기 때문**이다 —
        「추천 기본값을 고쳤다」와 「내 화면이 그대로다」가 머릿속에서 안 이어진다.
        그래서 그림으로 그린다. 지금 어느 단계에서 막혀 있는지가 한눈에 보여야 한다.
      */}
      {defaults && (
        <div className={`sig-flow${stale.length > 0 ? " stale" : ""}`}>
          <div className="sig-flow-step">
            <b>① 추천 기본값</b>
            <span>코드에 적힌 값. 검증해서 정한 값이 여기 들어옵니다</span>
          </div>
          <div className="sig-flow-arrow">
            {stale.length > 0 ? (
              <>
                <span className="sig-flow-block">✕ 막힘</span>
                <small>{stale.length}군데 다름</small>
              </>
            ) : (
              <>
                <span className="sig-flow-ok">= 같음</span>
                <small>반영됨</small>
              </>
            )}
          </div>
          <div className={`sig-flow-step now${dirty ? " dirty" : ""}`}>
            <b>② 내 설정 {dirty && <i className="sig-flow-dirty">저장 안 됨</i>}</b>
            <span>
              {dirty ? (
                <>
                  <b>화면에서 바꾼 값이 아직 서버에 없습니다.</b> 맨 아래 <b>「저장」</b>을
                  눌러야 ②가 바뀌고 ③이 따라옵니다
                </>
              ) : (
                <>
                  <b>①보다 우선합니다.</b> 한 번이라도 저장했으면 ①을 고쳐도 안 바뀝니다
                </>
              )}
            </span>
          </div>
          <div className="sig-flow-arrow">
            <span className="sig-flow-ok">→</span>
            <small>그대로</small>
          </div>
          <div className="sig-flow-step">
            <b>③ 실제 신호등</b>
            <span>종목 화면·신호등 찾기·슈퍼신호등이 ②를 씁니다</span>
          </div>
        </div>
      )}

      {stale.length > 0 && defaults && (
        <div className="sig-stale">
          <b>지금 기준이 추천 기본값과 {stale.length}군데 다릅니다.</b>
          <span className="sig-stale-why">
            <b>①이 ②로 자동으로 넘어가지 않습니다.</b> 아래 「전부 추천 기본값으로」를
            누르고 <b>저장</b>해야 ①이 ②로 복사됩니다. 그래야 종목 화면과 슈퍼신호등이
            새 기준으로 돕니다.
            <br />
            일부러 이렇게 만들었습니다 — 추천값이 바뀔 때마다 벤티지가 맞춰 둔 설정이
            조용히 덮이면 안 되니까요.
          </span>
          <ul className="sig-stale-list">
            {stale.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ul>
          <span className="sig-stale-acts">
            <button
              className="filter-btn active"
              onClick={() => {
                setConfig(defaults);
                setSaved(false);
              }}
              disabled={saving}
            >
              전부 추천 기본값으로
            </button>
            <button
              className="filter-btn"
              onClick={() => {
                patch({ axisWeights: { ...defaults.axisWeights } });
              }}
              disabled={saving}
            >
              축 가중치만
            </button>
            <span className="pt-n">
              누른 뒤 <b>맨 아래 「저장」까지</b> 눌러야 ②가 바뀝니다 — 누르기만 하면
              화면 값만 바뀐 상태입니다
            </span>
          </span>
        </div>
      )}
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
                    {/*
                      **기간은 기준마다 따로** (2026-09-01 — "그럼 저것도 개별로
                      세팅하게 두자고").

                      위쪽 「수급 판정 기간」은 한 값으로 모든 수급 기준을 묶는데,
                      지속은 5·10·20·60 을 한꺼번에 보고 가속은 두 기간의 비를 내고
                      주포는 누적 하나를 낸다 — 「기간」의 뜻이 서로 달라서 한 칸으로
                      묶으면 어느 하나는 반드시 어긋난다.

                      기간 개념이 없는 기준(신고가·정배열)에는 아예 안 뜬다.
                    */}
                    {c.span !== undefined && (
                      <label title="이 기준이 며칠을 되짚나 — 뜻은 기준마다 다릅니다. 아래 설명을 보세요">
                        기간
                        <input
                          type="number"
                          min={2}
                          max={250}
                          value={c.span}
                          disabled={!c.enabled}
                          onChange={(e) =>
                            patchCheck(c.key, {
                              span: Math.max(2, Math.min(250, Number(e.target.value) || 2)),
                            })
                          }
                        />
                        <span className="sig-unit">일</span>
                      </label>
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

      {/*
        **장세 전환** (2026-09-01) — 벤티지: "강세장이다 약세장이다라는 판단 기준은
        네가 정해서 하는 거야? 아니면 나한테 옵션 값을 주는 거야?"

        맞는 물음이다. 문턱이 코드에 박혀 있으면 **사람이 도구를 통제하지 못한다.**
        근거(표본 380일 중앙값 50)는 기본값으로 두되, 바꾸고 끄는 것은 사람 몫이다.
      */}
      <div className="sig-config-line sig-regime-line">
        <label className="sig-block-toggle">
          <input
            type="checkbox"
            checked={config.regimeSwitch}
            onChange={(e) => patch({ regimeSwitch: e.target.checked })}
          />
          <b>장세에 따라 기준을 갈아 끼운다</b>
        </label>
        <label title="전종목 중 20일선 위인 비율이 이 값 이상이면 강세장입니다">
          강세장 기준
          <input
            type="number"
            min={10}
            max={90}
            value={config.bullAt}
            disabled={!config.regimeSwitch}
            onChange={(e) =>
              patch({ bullAt: Math.max(10, Math.min(90, Number(e.target.value) || 50)) })
            }
          />
          <span className="sig-unit">% 가 20일선 위</span>
        </label>
        <span className="table-note">
          같은 기준도 장세에 따라 방향이 뒤집힙니다 — <b>60일 신고가는 강세장 승률
          +1.4%p, 약세장 −3.9%p</b>. 그래서 장세에 안 맞는 기준은 점수에서 뺍니다.
          끄면 예전처럼 전부 씁니다. 기본 50%는 표본 380거래일의 중앙값입니다.
        </span>
      </div>

      {/*
        **커버리지 문턱** (2026-09-01) — 이 도구에서 가장 크게 틀렸던 자리.

        렌즈가 없는 기준은 채점에서 빠지고 남은 것으로 평균이 났다. 「모르는 것을
        0 으로 만들지 않는다」는 옳았는데, 그렇게 낸 점수를 **다 잰 점수와 같은
        눈금에 올린 것**이 틀렸다. 덜 잰 종목이 더 쉽게 높은 점수를 받았다.
      */}
      <div className="sig-config-line sig-regime-line">
        <label title="켜진 기준의 무게 중 이 비율 이상을 실제로 재야 초록을 줍니다">
          <b>최소 커버리지</b>
          <input
            type="number"
            min={0}
            max={100}
            step={5}
            value={Math.round(config.minCoverage * 100)}
            onChange={(e) =>
              patch({
                minCoverage: Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100,
              })
            }
          />
          <span className="sig-unit">% 이상 재야 초록</span>
        </label>
        <label title="이 점수를 넘으면 초록을 주지 않습니다. 100 이면 상한 없음">
          초록 상한
          <input
            type="number"
            min={50}
            max={100}
            value={config.greenTo}
            onChange={(e) =>
              patch({ greenTo: Math.max(50, Math.min(100, Number(e.target.value) || 100)) })
            }
          />
          <span className="sig-unit">점까지 {config.greenTo >= 100 && "(상한 없음)"}</span>
        </label>
        {/*
          **커버리지가 뭔지부터** (2026-09-01) — 벤티지: "커버리지가 가지는 의미에
          대해서도 설명문에 붙여줘 그래야 내가 이해하지."

          맞는 지적이다. 지금까지 「커버리지 0.85 가 나빴다」는 **발견만** 적어 뒀지
          그게 무슨 값인지는 어디에도 없었다. 뜻을 모르는 숫자는 설정할 수 없다.
        */}
        <span className="table-note">
          <b>커버리지 = 이 종목을 켜 놓은 기준 중 몇 %나 실제로 재 봤나</b>입니다
          (개수가 아니라 <b>무게</b> 기준 — 무게 3짜리 시가총액이 빠진 것과 무게 1짜리
          하나가 빠진 것은 다른 일이니까요).
          <br />
          예를 들어 켜 둔 기준의 무게 합이 15인데 시가총액(3)과 영업이익(2)을 못
          받아왔다면 10/15 = <b>67%</b>입니다. 신규 상장이라 60일 신고가를 못 재거나,
          재무 데이터가 아직 안 올라온 종목에서 이런 일이 생깁니다.
          <br />
          <b>왜 문제가 되냐면</b> — 신호등은 못 잰 기준을 <b>빼고 남은 것으로 평균</b>을
          냅니다. 「모른다」를 0점으로 만들지 않으려고 그렇게 한 건데, 그 결과 <b>덜 잰
          종목은 남은 기준만 잘 맞으면 만점이 나옵니다.</b> 시가총액·영업이익을 못 잰
          종목이 추세·수급만 좋으면 90점을 받는데, 다 잰 종목은 다섯 군데를 다 통과해야
          90점입니다. <b>같은 90점이 아닌데 화면에서는 똑같아 보였습니다.</b>
          <br />
          실측에서 커버리지 80~89% 구간의 70점 통과가 시장에 <b>중앙 1.92%p 지고 승률이
          5.04%p 낮았습니다.</b> 90% 문턱을 걸자 40~90점 <b>전 구간이 앞·뒤 모두
          양수</b>가 됐습니다. 미달이면 점수는 그대로 내고 <b>초록만 막습니다</b> —
          못 재는 게 종목 잘못은 아니니 빨강으로 찍는 것도 거짓말이기 때문입니다.
          <br />
          <b>값을 올리면</b> 근거가 더 확실한 종목만 초록이 되지만 후보가 줄고,
          <b> 내리면</b> 후보는 늘지만 부풀려진 점수가 섞입니다. 100%로 두면 표본의
          42%가 빠집니다.
          <br />
          <br />
          상한은 기본이 <b>꺼져 있습니다(100)</b>. 「과한 점수는 고점신호」가 그럴듯해
          보이지만, 커버리지를 고친 뒤 <b>90~100점이 뒤쪽 중앙 +1.69%p 로 가장 좋은
          구간</b>이 됐습니다 — 「꼭대기가 나쁘다」는 렌즈 결손이 만든 착시였습니다.
          걸면 가장 좋은 구간을 버립니다.
        </span>
      </div>

      <div className="sig-config-actions">
        {/*
          저장 버튼이 **지금 눌러야 하는지**를 스스로 말해야 한다 (2026-08-31).
          「기본값으로」는 화면 값만 바꾸는데, 그 뒤에 저장을 안 누르면 아무 일도
          안 일어난다 — 그런데 화면상으로는 다 바뀐 것처럼 보인다.
        */}
        <button
          className={`primary-btn${dirty ? " sig-save-need" : ""}`}
          onClick={save}
          disabled={saving || !dirty}
          title={dirty ? "화면에서 바꾼 값을 서버에 저장합니다" : "바꾼 것이 없습니다"}
        >
          {saving ? "저장 중…" : dirty ? "저장 (바뀐 것 있음)" : "저장됨"}
        </button>
        {defaults && (
          <button
            className="filter-btn"
            onClick={() => {
              setConfig(defaults);
              setSaved(false);
            }}
            disabled={saving}
            title="추천 기본값을 화면에 불러옵니다 — 그 뒤 「저장」까지 눌러야 반영됩니다"
          >
            기본값 불러오기
          </button>
        )}
        {dirty && (
          <span className="sig-error">
            ⚠️ 아직 저장 안 됨 — 지금 신호등은 <b>예전 값</b>으로 돌고 있습니다
          </span>
        )}
        {saved && !dirty && <span className="sig-saved">저장됨 · 다음 평가부터 적용</span>}
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

      <SignalGuide />

      {/*
       * 시뮬레이터를 **설정 바로 아래**에 둔다 (2026-08-31). 문턱을 만지는 자리와
       * 그 결과를 재는 자리가 떨어져 있으면, 바꾸고 나서 재러 가지를 않는다.
       * 저장 전 화면 값(`config`)을 그대로 넘기므로 **저장하지 않고도** 재 볼 수 있다.
       */}
      <SignalSimPanel config={config} />
    </div>
  );
}

/**
 * 기준 읽는 법 — **왜 이 값인지**를 적어 둔다.
 *
 * 숫자만 있으면 「가중치 2가 맞나 1이 맞나」를 매번 처음부터 생각하게 된다.
 * 겹치는 항목이 어디인지, 어떤 것이 검증된 값인지가 특히 중요하다 — 그걸 모르면
 * 좋아 보이는 기준을 다 켜게 되고, 그러면 **같은 것을 여러 번 세면서 점수만 부푼다.**
 */
function SignalGuide() {
  const [open, setOpen] = useState(false);
  return (
    <div className="sig-guide">
      <button className="filter-btn" onClick={() => setOpen((v) => !v)}>
        {open ? "▴ 기준 읽는 법 접기" : "▾ 기준 읽는 법 — 어떤 값을 어떻게 정할까"}
      </button>
      {!open ? null : (
        <div className="sig-guide-body">
          <h4>추천 기본값은 무슨 뜻인가 (2026-08-31 개정)</h4>
          <p>
            지금 기본값은 <b>감으로 정한 값이 아니라 재서 정한 값</b>입니다. 거래대금 상위{" "}
            <b>500 종목 × 400 거래일 = 19만 관측</b>을 놓고, 되짚을 수 있는 기준 열 개의{" "}
            <b>모든 조합(1,024개)</b>을 돌려서 정했습니다.
          </p>
          <p>
            핵심은 <b>표본을 날짜로 반 갈라 앞에서 고르고 뒤에서 채점</b>했다는 점입니다.
            조합을 여러 개 돌려 그중 1등을 고르면 거의 반드시 그 기간에만 맞는 값이
            나옵니다. 실제로 짧은 표본(120일)에서 <b>「+7.95%, 압도적」</b>이던 조합이{" "}
            <b>뒤쪽 절반에서 -19%p</b> 였습니다.
          </p>

          <p>
            <b>켠 것 셋</b> — 60일 신고가 <span className="pt-n">(추세)</span> · 외인 연속
            순매수 <span className="pt-n">(수급)</span> · 위쪽 매물 부담{" "}
            <span className="pt-n">(위험)</span>
          </p>
          <pre className="guide-pre">
{`초록 6,323건  20일 +6.54% (승률 53%)
시장 평균               +4.19% (52%)   → +2.35%p
앞쪽 +1.57%p · 뒤쪽 +3.39%p  — 양쪽 다 양수

점수 구간별 (높을수록 좋아야 한다)
  0~44   +4.02%
  45~59  +4.79%
  70~79  +6.09%
  90~100 +7.99%   ← 단조 증가`}
          </pre>

          <h4>1등을 안 골랐습니다 — 이게 이번 판단의 핵심입니다</h4>
          <p>
            1위 조합은 여기에 <b>금액 기반 수급 둘</b>(외국인·기관)을 더한 것으로, 뒤쪽
            성적이 <b>+4.08%p</b> 였습니다(지금 기본값은 +3.39%p, 20위). 그런데{" "}
            <b>점수 꼭대기가 무너져 있었습니다.</b>
          </p>
          <pre className="guide-pre">
{`             90~100 구간
1위 조합       +3.66%   ← 시장 평균(+4.19%)보다 못하다
지금 기본값     +7.99%`}
          </pre>
          <p>
            원인은 문턱이 <b>절대 금액</b>이라는 데 있습니다. 순매수 100억을 넘기는 건
            대형주뿐이라 「신고가 + 수급 만점」이 사실상 <b>대형주 필터</b>가 되고,
            대형주는 20일에 덜 움직입니다.
          </p>
          <p>
            <b>초록을 통째로 사는 게 아니라 점수 높은 것부터 고르므로</b>, 꼭대기가
            시장에 지는 설정은 평균이 좋아도 쓸 수 없습니다. 같은 수급이라도{" "}
            <b>외인 연속 순매수는 금액이 아니라 「일수」</b>를 세므로 그 편향이 없습니다
            — 그쪽만 남겼습니다.
          </p>

          <h4>끈 것과 그 이유 — 「거꾸로」거나 「중복」입니다</h4>
          <ul>
            <li>
              <b>테마 강세 −5.76%p</b> — 테마가 강한 날 산 것이 20일 뒤 <b>-6.74%</b>,
              약한 날은 -0.98% 였습니다. 추세 축 가중치 2를 차지하면서 정반대로
              작동했습니다. <b>「테마가 강한 날 = 이미 급등한 날 = 되돌림 자리」</b>로
              읽힙니다. 테마 화면과 슈퍼신호등의 테마 판정은 그대로입니다.
            </li>
            <li>
              <b>거래대금 −2.40%p · 기관 수급 −1.55%p</b> — 둘 다 거꾸로입니다.
              수급은 위에 적은 대형주 편향 때문입니다.
            </li>
            <li>
              <b>20일선 이격도 +2.45%p</b> — 위험 축은 「높으면 위험하니 초록을 막는다」는
              전제인데, 실제로는 많이 벌어진 쪽이 <b>더 좋았습니다.</b> 막지 말아야 할
              것을 막고 있었습니다.
            </li>
            <li>
              <b>고점 근접 · 정배열</b> — 신고가와 <b>겹칩니다.</b> 고점 근접은 껐다 켜도
              결과가 <b>한 건도</b> 안 바뀌고, 정배열은 더하면 20위 → 46위로 내려갑니다.
              신고가면 대개 정배열이라 새로 알려 주는 것이 없습니다.
            </li>
            <li>
              <b>5일선 이격 −0.30%p</b> — 거의 0입니다. 더해도 구간별 성적이 한 자리도
              안 바뀝니다.
            </li>
          </ul>

          <p className="sim-note">
            ⚠️ <b>세 기준은 아직 채점 밖입니다</b> — ETF 뒷배 · 영업이익 증가 · 시가총액.
            그때의 편입 비중·공시 시점·상장주식수를 갖고 있지 않아 되짚을 수 없을 뿐,{" "}
            <b>틀렸다는 근거는 없습니다.</b> 그래서 켠 채로 뒀습니다 — 잴 수 없다고 끄면
            신호등이 <b>백테스트를 위한 도구</b>가 됩니다. 다만 실전 점수에는 이 셋이
            얹히므로 <b>백테스트 최적이 곧 실전 최적은 아닙니다.</b>
          </p>
          <p className="sim-note">
            ⚠️ <b>수급은 2026-08-31 에 처음 되짚어 본 것</b>이라 다른 표본으로 교차확인이
            없습니다. 400거래일 안에 큰 하락장도 없었습니다.{" "}
            <b>앞뒤가 일관되다까지가 확인된 것</b>이지 다른 장세에서도 같다는 증명은
            아닙니다.
          </p>
          <p className="sim-note">
            ⚠️ <b>저장된 설정이 기본값보다 우선합니다.</b> 한 번이라도 저장했으면 위쪽의{" "}
            <b>「전부 추천 기본값으로」</b>를 누르고 저장해야 반영됩니다. 바꾸기 전에{" "}
            <b>아래 시뮬레이터에서 먼저 재 보세요</b> — 저장하지 않고도 잽니다.
          </p>

          <h4>먼저 — 겹치는 기준을 켜지 마세요</h4>
          <p>
            같은 것을 재는 기준을 둘 다 켜면 그 축에서 <b>점수가 두 번 세어집니다.</b>{" "}
            지금 기본값에서 꺼 둔 것들이 그래서입니다.
          </p>
          <ul>
            <li>
              <b>고점 근접 ↔ 60일 신고가</b> — 신고가면 고점 근접은 자동으로 만점입니다.
              신고가 쪽을 남긴 이유는 <b>자체 백테스트에서 엣지가 가장 컸기 때문</b>입니다
              (20일 뒤 +3.77%p).
            </li>
            <li>
              <b>테마 강세 키움 ↔ 네이버</b> — 네이버는 종목마다 <b>편입 사유</b>가 붙어 있어
              분류를 믿을 근거가 있습니다. 키움 쪽은 묶음이 거칩니다.
            </li>
            <li>
              <b>업종 강세</b>는 아예 뺐습니다 — 「화학」 한 칸에 화장품·이차전지·정유가 같이
              들어가서, 업종이 올랐다는 게 그 종목에 대해 아무 말도 못 합니다.
            </li>
          </ul>

          <h4>축 비중 — 무엇을 보는 매매인가</h4>
          <p>
            기본값은 <b>추세 1.5 · 수급 1.3 · 실적 0.6</b> 입니다. 며칠에서 몇 주를 보는
            매매를 전제한 값입니다 — 그 기간에 실적은 이미 가격에 들어가 있고 분기에 한 번만
            바뀝니다. 그렇다고 0 으로 두면 <b>적자기업이 안 걸러지므로</b> 낮게 두되 살려 둡니다.
            몇 달을 보는 매매라면 실적을 1 이상으로 올리세요.
          </p>

          <h4>축마다 무엇을 답하나</h4>
          <ul>
            <li>
              <b>추세</b> — 「지금 올라가는 자리인가」. 정배열·신고가는 <b>가격이 그린 모양</b>이고,
              테마 강세는 <b>같은 이름으로 묶인 종목들</b>이 가는지, ETF 뒷배는 <b>실제로 돈을
              넣어 담은 쪽</b>이 가는지입니다. 셋이 서로 다른 것을 봅니다.
            </li>
            <li>
              <b>수급</b> — 「누가 사는가」. 하루치 큰 금액보다 <b>이어지는 쪽</b>이 강해서
              연속 순매수에 무게를 더 줍니다. 금액 문턱은 <b>백만원</b> 단위입니다
              (1,000 = 10억).
            </li>
            <li>
              <b>실적</b> — 「회사가 벌고 있나」. 목표가·ROE 는 종목당 조회가 한 번씩 더
              나가므로(위에 표시됩니다) 정말 볼 때만 켜세요.
            </li>
            <li>
              <b>위험</b> — 다른 축과 <b>섞이지 않습니다.</b> 따로 재서 빨강이면 나머지가
              좋아도 초록을 막습니다. 그래서 「5일선 이격 좁음」 같은 항목이 여기 있으면
              <b> 다른 조건이 이미 좋을 때만</b> 총점을 밀어 올립니다 — 이격이 좁다는 것만으로는
              방향을 못 정하기 때문입니다.
            </li>
          </ul>

          <h4>문턱과 만점 — 두 숫자의 뜻</h4>
          <p>
            <b>문턱</b>은 50점 선, <b>만점</b>은 100점이 되는 값입니다. 그 사이는 비례해서
            매겨집니다. 위험 축은 <b>반대</b>입니다 — 값이 작을수록 안전합니다.
          </p>
          <p>
            문턱을 0 으로 두면 그 기준은 <b>아무도 거르지 못합니다.</b> 실제로 외국인 수급이
            0 이라 순매수 1원에도 통과했었고, 그래서 10억으로 올렸습니다. 기준을 바꿀 때는
            「이 값을 못 넘는 종목이 실제로 있나」를 먼저 보세요.
          </p>

          <h4>바꾼 뒤에는 검증하세요</h4>
          <p>
            여기 적힌 값은 <b>겹치는 것을 정리한 결과</b>이지 수익률로 검증된 조합이 아닙니다.
            <b> 신호등 찾기 &gt; 조건 백테스트</b>로 과거에 어땠는지 보고,{" "}
            <b>복기 노트</b>에 예측 종목을 며칠 박제하면 다음날 자동으로 채점됩니다.
            2~3주 쌓이면 어느 구성이 맞았는지 숫자로 나옵니다.
          </p>
        </div>
      )}
    </div>
  );
}
