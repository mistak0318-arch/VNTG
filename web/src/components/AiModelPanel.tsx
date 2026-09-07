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
  pulse:
    "「시장 흐름 분석」 맨 위 판독. 입력이 숫자 몇십 줄뿐이라 아주 쌉니다(실측 입력 770·출력 274 토큰). 안 고르면 데일리 리포트에 고른 모델을 그대로 씁니다.",
  pinned:
    "데일리 리포트에 붙는 고정 채널 원문 세줄 요약. 입력이 작아 싼 모델로 충분합니다. 안 고르면 데일리 리포트 모델을 따라갑니다.",
  vision:
    "캘린더 화면의 이미지 붙여넣기 인식. 안 고르면 지금까지처럼 싼 제공자부터 시도합니다.",
  sys:
    "플로팅 시스의 AI 모드 — 물을 때마다 한 번. ⚠️ 제약: ① Claude 를 고르면 웹 검색이 붙어 밖의 사실(오늘 뉴스 원인·해외 시장)까지 확인하지만 질문당 1~3분, 검색 결과가 입력에 쌓여 10만 토큰을 넘기도 합니다(패널의 「웹 검색」을 끄면 빠르고 쌉니다). ② Gemini·OpenAI 를 고르면 웹 검색이 없습니다 — 시스가 긁은 묶음(시세·수급·신호등·뉴스 제목·공시·텔레그램)만으로 답하므로 빠르고 싸지만 묶음에 없는 사실은 「모른다」고 합니다. ③ 안 고르면 시황 질문하기 모델을 따라갑니다. 매수·매도 추천은 어느 모델이든 하지 않습니다.",
};

export function AiModelPanel() {
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [models, setModels] = useState<VisionModelOption[]>([]);
  const [purposes, setPurposes] = useState<Record<string, string>>({});
  const [fallback, setFallback] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* 모델 점검 결과 — 모델명 → 살았나·몇 ms·왜 죽었나 */
  const [check, setCheck] = useState<Record<string, { ok: boolean; ms: number; error: string | null }> | null>(null);
  const [checking, setChecking] = useState(false);

  async function runCheck() {
    setChecking(true);
    setError(null);
    try {
      const r = await api.aiCheck();
      setCheck(Object.fromEntries(r.results.map((x) => [x.model, { ok: x.ok, ms: x.ms, error: x.error }])));
    } catch (e) {
      setError(e instanceof Error ? e.message : "점검 실패");
    } finally {
      setChecking(false);
    }
  }

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

  /*
   * 벤티지 (2026-09-08): "설정에 AI 모델 뭘 설정했는지 눌러야 확인 가능하네."
   * 셀렉트가 좁아 「Claude · Cla▾」로 잘렸다. 고른 모델을 셀렉트 앞에 **글자로** 박고, 셀렉트는 넓힌다.
   * 「기본」이면 무엇으로 흘러가는지도 글자로.
   */
  const defaultOf = (key: string) => (key === "pulse" ? "데일리 리포트와 같게" : key === "sys" ? "시황 질문하기와 같게" : (fallback ?? "설정된 키 없음"));
  const nowText = (key: string) => {
    const current = (config as unknown as Record<string, { model: string } | null>)[key];
    const chosen = models.find((m) => m.model === current?.model);
    if (!chosen) return `기본 → ${defaultOf(key)}`;
    const prov = PROVIDER_LABEL[chosen.provider] ?? chosen.provider;
    /* 「Gemini Gemini 3.5 Flash Lite」처럼 겹치지 않게 */
    return chosen.label.startsWith(prov) ? chosen.label : `${prov} ${chosen.label}`;
  };

  return (
    <div className="sig-config">
      {/* 한눈에 — 용도 → 모델 (누르지 않아도 보인다) */}
      <div className="ai-now">
        {Object.entries(purposes).map(([key, label]) => (
          <span className="ai-now-item" key={key}>
            <i>{label}</i> {nowText(key)}
          </span>
        ))}
      </div>
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
                <b className={`ai-chosen ${chosen ? "" : "dim"}`} title={chosen ? chosen.model : "기본값을 따라간다"}>
                  {nowText(key)}
                </b>
                <select
                  className="group-select ai-select"
                  value={current?.model ?? ""}
                  onChange={(e) => pick(key, e.target.value)}
                >
                  <option value="">
                    {/*
                      「기본」이 무엇인지 자리마다 다르다. 맥박은 리포트에 고른 것을 따라가므로
                      그렇게 적어야 한다 — 안 그러면 왜 이 모델이 도는지 알 수 없다.
                    */}
                    {key === "pulse"
                      ? `기본 (데일리 리포트와 같게)`
                      : key === "sys"
                        ? `기본 (시황 질문하기와 같게)`
                        : `기본 (${fallback ?? "설정된 키 없음"})`}
                  </option>
                  {models.map((m) => (
                    <option key={m.model} value={m.model}>
                      {check?.[m.model] ? (check[m.model].ok ? "✅ " : "❌ ") : ""}
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

      {/*
        모델 점검 (2026-09-07) — 목록을 믿지 말고 불러 본다. 죽은 모델이 목록에 산 것처럼
        남아 있던 일(gemini-2.5-flash 404)이 있었다. 모델마다 5토큰짜리라 다 합쳐도 몇 원이다.
      */}
      <div className="ai-check">
        <button className="filter-btn" onClick={() => void runCheck()} disabled={checking}>
          {checking ? "부르는 중… (최대 20초)" : "🩺 모델 점검 — 목록의 모델을 실제로 불러 봅니다"}
        </button>
        {check && (
          <ul className="ai-check-list">
            {models.map((m) => {
              const c = check[m.model];
              if (!c) return null;
              return (
                <li key={m.model} className={c.ok ? "ok" : "bad"}>
                  {c.ok ? "✅" : "❌"} <b>{m.label}</b> <span className="pt-n">{m.model}</span>
                  {c.ok ? <span className="pt-n"> · {c.ms}ms</span> : <span className="ai-check-err"> — {c.error}</span>}
                </li>
              );
            })}
          </ul>
        )}
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
