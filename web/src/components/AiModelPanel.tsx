import { useEffect, useState } from "react";
import { api, type AiConfig, type VisionModelOption } from "../api";

/**
 * 용도별 AI 모델 선택.
 *
 * 하나로 통일할 이유가 없다. 용도마다 **호출 빈도가 달라서** 같은 모델이라도
 * 월 비용이 몇 배씩 벌어진다. 채널 요약은 입력이 크고 정리 성격이라 싼 모델도 쓸 만하지만,
 * 데일리 리포트는 시장 데이터를 해석해야 해서 품질이 바로 드러난다.
 *
 * 고르지 않으면 기존 동작(Claude 기본)을 그대로 쓴다.
 */

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  anthropic: "Claude",
};

/** 하루 호출 횟수 기준 월 비용 감각 — 정확한 값이 아니라 비교용 */
const CALLS_PER_MONTH: Record<string, number> = { report: 100, channel: 90 };

const PURPOSE_NOTE: Record<string, string> = {
  report:
    "07/12/18시 + 주말 09시. 시장 데이터를 해석해야 하므로 모델 차이가 바로 드러납니다.",
  channel:
    "07/12/18시. 입력이 크지만(선별 40건) 분류·정리 성격이라 저렴한 모델도 쓸 만합니다. Haiku 로 바꾸면 비용이 절반입니다.",
  research:
    "입력이 제일 큰 자리입니다. 검색 결과가 대화에 쌓여 매 턴 다시 실리기 때문인데, 그래서 여기야말로 싼 모델로 바꿀 값어치가 있습니다.",
  ask:
    "물을 때마다 한 번. 웹 검색을 붙여 답하는데 그 도구가 Anthropic 쪽에 있어서 Claude 만 고를 수 있습니다 — 다른 걸 고르면 저장되지 않고 기본값으로 돕니다.",
};

export function AiModelPanel() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [models, setModels] = useState<VisionModelOption[]>([]);
  const [purposes, setPurposes] = useState<Record<string, string>>({});
  const [fallback, setFallback] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .aiConfig()
      .then((r) => {
        setConfig(r.config);
        setModels(r.models);
        setPurposes(r.purposes);
        setFallback(r.fallback);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  function pick(purpose: string, modelName: string) {
    const m = models.find((x) => x.model === modelName);
    setConfig((c) =>
      c ? { ...c, [purpose]: m ? { provider: m.provider, model: m.model } : null } : c,
    );
    setSaved(false);
  }

  async function save() {
    if (!config) return;
    setSaving(true);
    setError(null);
    try {
      const r = await api.aiConfigSave(config);
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

  if (models.length === 0) {
    return (
      <div className="page-note">
        쓸 수 있는 모델이 없습니다. <code>server/.env</code> 에{" "}
        <code>ANTHROPIC_API_KEY</code> / <code>GEMINI_API_KEY</code> /{" "}
        <code>OPENAI_API_KEY</code> 중 하나 이상을 넣어주세요.
      </div>
    );
  }

  return (
    <div className="sig-config">
      <div className="sig-config-rows">
        {Object.entries(purposes).map(([key, label]) => {
          const current = (config as unknown as Record<string, { model: string } | null>)[key];
          const chosen = models.find((m) => m.model === current?.model);
          return (
            <div className="sig-config-row" key={key}>
              <span className="sig-config-name" style={{ cursor: "default" }}>
                <span>
                  <b>{label}</b>
                  <small>{PURPOSE_NOTE[key] ?? ""}</small>
                </span>
              </span>
              <div className="sig-config-inputs">
                <select
                  className="group-select"
                  value={current?.model ?? ""}
                  onChange={(e) => pick(key, e.target.value)}
                >
                  <option value="">
                    기본 ({fallback ?? "설정된 키 없음"})
                  </option>
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {PROVIDER_LABEL[m.provider] ?? m.provider} · {m.label}
                    </option>
                  ))}
                </select>
              </div>
              {chosen && <span className="ai-model-hint">{chosen.hint}</span>}
            </div>
          );
        })}
      </div>

      <div className="sig-config-actions">
        <button className="primary-btn" onClick={save} disabled={saving}>
          {saving ? "저장 중…" : "저장"}
        </button>
        {saved && <span className="sig-saved">저장됨 · 다음 발행부터 적용</span>}
        {error && <span className="sig-error">{error}</span>}
      </div>

      <div className="table-note">
        고르지 않으면 <b>기본({fallback ?? "없음"})</b>을 씁니다. 바꾼 뒤에는 다음 발행분부터
        적용되며, 이미 발행된 리포트는 그대로 남습니다. 발행된 리포트에 어떤 모델을 썼는지
        기록되므로 <b>같은 날 판끼리 비교해 보고 정하세요</b> — 월 호출은 리포트 약{" "}
        {CALLS_PER_MONTH.report}회, 채널 요약 약 {CALLS_PER_MONTH.channel}회입니다.
        실제 비용은 <b>API 사용량</b> 카드에서 제공자별로 확인할 수 있습니다.
      </div>
    </div>
  );
}
