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
   * **저장분이 기본값을 이긴다** — 그래서 코드에서 기본값을 바꿔도, 이미 저장해 둔
   * 사람에게는 아무것도 안 바뀐다 (2026-08-28). 축 가중치를 1·1·1 에서 추천값으로
   * 고쳐 놓고도 화면은 1·1·1 이라 「왜 안 바뀌지」가 됐다.
   * 조용히 덮어쓰지는 않는다 — 일부러 맞춰 둔 값일 수도 있다. **다르다고 알리고
   * 누르면 바뀌게** 한다.
   */
  const axisStale =
    defaults !== null &&
    (["trend", "flow", "value"] as const).some(
      (k) => config.axisWeights[k] !== defaults.axisWeights[k],
    );

  return (
    <div className="sig-config">
      {axisStale && defaults && (
        <div className="sig-stale">
          지금 축 가중치는 <b>추세 {config.axisWeights.trend} · 수급 {config.axisWeights.flow} ·
          실적 {config.axisWeights.value}</b> 로, 추천 기본값(<b>추세{" "}
          {defaults.axisWeights.trend} · 수급 {defaults.axisWeights.flow} · 실적{" "}
          {defaults.axisWeights.value}</b>)과 다릅니다. 저장해 둔 설정이 기본값보다 우선하기
          때문입니다.
          <button
            className="filter-btn"
            onClick={() =>
              patch({ axisWeights: { ...defaults.axisWeights } })
            }
          >
            축 가중치만 추천값으로
          </button>
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

      <SignalGuide />
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
