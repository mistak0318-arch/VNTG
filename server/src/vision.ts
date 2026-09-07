import { recordApiCall, type UsageFeature } from "./apiUsage.js";

/**
 * 이미지에서 텍스트를 읽어 구조화하는 계층.
 *
 * 제공자를 갈아끼울 수 있게 만든 이유:
 * 이미지 한 장은 어느 모델이든 1센트 남짓이라 체감이 없지만, 반복 호출은 다르다.
 * 캘린더 이미지처럼 **가끔 쓰는 기능에 비싼 모델을 붙일 이유가 없다.**
 *
 * 우선순위: Gemini → OpenAI → Claude.
 * 키가 있는 것 중 싼 것부터 쓰고, 전부 없으면 그렇다고 말한다.
 */

export type VisionProvider = "gemini" | "openai" | "anthropic";

export interface VisionResult {
  text: string | null;
  provider: VisionProvider | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}

/** 쓸 수 있는 제공자를 싼 순서로 */
export function availableVisionProviders(): VisionProvider[] {
  const out: VisionProvider[] = [];
  if (process.env.GEMINI_API_KEY?.trim()) out.push("gemini");
  if (process.env.OPENAI_API_KEY?.trim()) out.push("openai");
  if (process.env.ANTHROPIC_API_KEY?.trim()) out.push("anthropic");
  return out;
}

/*
 * 제공자별 기본 모델 (2026-09-07 최신화). `gemini-2.5-flash` 는 404 가 오고(신규 사용자에게
 * 닫힘), `gpt-4o-mini` 는 GPT-5.6 세대에 밀렸다. 목록·단가표(`apiUsage`)와 같이 움직인다.
 */
const MODELS: Record<VisionProvider, string> = {
  gemini: "gemini-3.5-flash-lite",
  openai: "gpt-5.6-luna",
  anthropic: "claude-haiku-4-5-20251001",
};

/**
 * 고를 수 있는 모델 목록.
 *
 * 이미지에서 표를 읽는 일은 **싼 모델에서 품질 차이가 크게 벌어진다.**
 * 날짜를 한 줄 밀려 읽거나 항목을 통째로 빠뜨리는데, 그건 사람이 검토해도 잘 안 보인다.
 * 그래서 "기본은 싼 것, 결과가 이상하면 올려 쓰기"가 가능하도록 목록을 열어둔다.
 *
 * hint 의 가격은 이미지 1장(대략 입력 1,500 / 출력 600 토큰) 기준 추정치다.
 */
export interface VisionModelOption {
  provider: VisionProvider;
  model: string;
  label: string;
  hint: string;
}

export const VISION_MODELS: VisionModelOption[] = [
  /*
   * 2026-09-07 최신화. 벤티지: "AI API 모델 리스트 최신화 되어 있나?" — 안 돼 있었다.
   * `gemini-2.5-flash` 는 실측 404 인데 여기 남아 있었고, GPT 는 4o 세대였다.
   * ⚠️ 이 목록은 또 낡는다. 설정 › AI 모델의 「모델 점검」이 각 줄을 실제로 불러
   * 살았는지 표시한다 — 목록을 믿지 말고 점검을 믿을 것.
   */
  { provider: "gemini", model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", hint: "가장 저렴 · 단순한 표만" },
  { provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", hint: "저렴 · 일반적인 일정표 · 혼합 입력에 강함" },
  { provider: "gemini", model: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", hint: "복잡한 표·손글씨에 강함" },
  { provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "저렴 · 무난" },
  { provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "표 인식 정확도 높음" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", hint: "저렴 · 한글 표에 강함" },
  { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "복잡한 이미지에 가장 안정적" },
  { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5", hint: "가장 정확 · 비싸다" },
];

/** 키가 있는 제공자의 모델만 */
export function availableVisionModels(): VisionModelOption[] {
  const ok = new Set(availableVisionProviders());
  return VISION_MODELS.filter((m) => ok.has(m.provider));
}

function modelFor(p: VisionProvider, override?: string): string {
  if (override?.trim()) return override.trim();
  const envOverride = {
    gemini: process.env.GEMINI_VISION_MODEL,
    openai: process.env.OPENAI_VISION_MODEL,
    anthropic: process.env.ANTHROPIC_VISION_MODEL,
  }[p];
  return envOverride?.trim() || MODELS[p];
}

// ---------------------------------------------------------------- 제공자별 호출

async function callGemini(
  prompt: string,
  imageBase64: string,
  mimeType: string,
  modelName?: string,
  maxTokens = 4000,
): Promise<VisionResult> {
  const model = modelFor("gemini", modelName);
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${process.env.GEMINI_API_KEY!.trim()}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          parts: imageBase64
            ? [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }]
            : [{ text: prompt }],
        },
      ],
      generationConfig: { temperature: 0, maxOutputTokens: maxTokens },
    }),
  });

  const body = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    error?: { message?: string };
  };

  if (!res.ok || body.error) {
    return {
      text: null,
      provider: "gemini",
      model,
      inputTokens: 0,
      outputTokens: 0,
      error: body.error?.message ?? `HTTP ${res.status}`,
    };
  }

  /*
   * ⚠️ 생각(thought) 파트를 걸러낸다 (2026-08-26).
   *
   * gemini-3.5-flash 는 응답 parts 에 **모델의 사고 과정**을 `thought: true` 로
   * 섞어 보낼 때가 있다. 전 파트를 그대로 이어붙였더니 조간 리포트 AI 정리에
   * 「Character Count Check: Let's count the characters…」 같은 검산 메모가
   * 본문으로 발행됐다 — 답이 아닌 것은 답에 넣지 않는다.
   */
  const parts = (body.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought);
  return {
    text: parts.map((p) => p.text ?? "").join("") || null,
    provider: "gemini",
    model,
    inputTokens: body.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: body.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

async function callOpenAI(
  prompt: string,
  imageBase64: string,
  mimeType: string,
  modelName?: string,
  maxTokens = 4000,
): Promise<VisionResult> {
  const model = modelFor("openai", modelName);
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${process.env.OPENAI_API_KEY!.trim()}`,
    },
    /*
     * GPT-5.x·6 은 `max_tokens` 를 거절하고(`max_completion_tokens` 만 받는다) 추론 모델이라
     * `temperature` 도 기본값만 받는다. 4o 세대 호출을 그대로 보내면 400 이 온다.
     * 새 이름은 모든 현행 모델이 받으므로 그쪽으로 통일한다.
     */
    body: JSON.stringify({
      model,
      ...(/^gpt-[5-9]/.test(model) ? {} : { temperature: 0 }),
      max_completion_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: imageBase64
            ? [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: { url: `data:${mimeType};base64,${imageBase64}` },
                },
              ]
            : [{ type: "text", text: prompt }],
        },
      ],
    }),
  });

  const body = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
    error?: { message?: string };
  };

  if (!res.ok || body.error) {
    return {
      text: null,
      provider: "openai",
      model,
      inputTokens: 0,
      outputTokens: 0,
      error: body.error?.message ?? `HTTP ${res.status}`,
    };
  }

  return {
    text: body.choices?.[0]?.message?.content ?? null,
    provider: "openai",
    model,
    inputTokens: body.usage?.prompt_tokens ?? 0,
    outputTokens: body.usage?.completion_tokens ?? 0,
  };
}

async function callAnthropic(
  prompt: string,
  imageBase64: string,
  mimeType: string,
  modelName?: string,
  maxTokens = 4000,
): Promise<VisionResult> {
  const model = modelFor("anthropic", modelName);
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY!.trim(),
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: imageBase64
            ? [
                {
                  type: "image",
                  source: { type: "base64", media_type: mimeType, data: imageBase64 },
                },
                { type: "text", text: prompt },
              ]
            : [{ type: "text", text: prompt }],
        },
      ],
    }),
  });

  const body = (await res.json()) as {
    content?: { text?: string }[];
    usage?: { input_tokens?: number; output_tokens?: number };
    error?: { message?: string };
  };

  if (!res.ok || body.error) {
    return {
      text: null,
      provider: "anthropic",
      model,
      inputTokens: 0,
      outputTokens: 0,
      error: body.error?.message ?? `HTTP ${res.status}`,
    };
  }

  return {
    text: body.content?.map((c) => c.text ?? "").join("") ?? null,
    provider: "anthropic",
    model,
    inputTokens: body.usage?.input_tokens ?? 0,
    outputTokens: body.usage?.output_tokens ?? 0,
  };
}

/**
 * 이미지를 읽어 텍스트를 돌려준다.
 *
 * @param prefer 특정 제공자를 강제할 때. 없으면 싼 것부터.
 * 실패하면 다음 제공자로 넘어간다 — 한 곳이 죽었다고 기능 전체가 멈추면 안 된다.
 */
export async function readImage(
  prompt: string,
  imageBase64: string,
  mimeType: string,
  prefer?: VisionProvider,
  model?: string,
  maxTokens = 4000,
  /** 어느 메뉴가 부른 건지 — 비용을 기능별로 가르는 데 쓴다 */
  feature: UsageFeature = "vision",
): Promise<VisionResult> {
  const order = prefer
    ? [prefer, ...availableVisionProviders().filter((p) => p !== prefer)]
    : availableVisionProviders();

  if (order.length === 0) {
    return {
      text: null,
      provider: null,
      model: null,
      inputTokens: 0,
      outputTokens: 0,
      error: "이미지 분석 키가 없습니다 (GEMINI_API_KEY / OPENAI_API_KEY / ANTHROPIC_API_KEY 중 하나 필요)",
    };
  }

  let last: VisionResult | null = null;
  for (const p of order) {
    const fn = { gemini: callGemini, openai: callOpenAI, anthropic: callAnthropic }[p];
    // 모델 지정은 그 제공자로 넘어갔을 때만 쓴다 (다른 제공자에 남의 모델명을 넘기면 실패한다)
    const useModel = p === prefer ? model : undefined;
    try {
      const r = await fn(prompt, imageBase64, mimeType, useModel, maxTokens);
      void recordApiCall(p, r.model ?? p, r.text ? "ok" : "failed", {
        feature,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
      });
      if (r.text) return r;
      last = r;
    } catch (err) {
      void recordApiCall(p, modelFor(p, useModel), "failed");
      last = {
        text: null,
        provider: p,
        model: modelFor(p, useModel),
        inputTokens: 0,
        outputTokens: 0,
        error: err instanceof Error ? err.message : "호출 실패",
      };
    }
  }
  return last!;
}

// ---------------------------------------------------------------- 텍스트 생성

/**
 * 이미지 없이 글만 생성한다.
 *
 * 채널 요약처럼 **하루 여러 번 도는 작업**은 모델 선택이 곧 월 비용이다.
 * 이미지 경로와 같은 코드를 쓰되 이미지 파트만 빼서, 제공자별 예외 처리를 두 벌 만들지 않는다.
 */
export const TEXT_MODELS: VisionModelOption[] = [
  /*
   * 2026-09-07 최신화 — 단가는 `apiUsage.MODEL_PRICING` 과 짝이다. 한쪽만 고치면
   * 사용량 화면이 엉뚱한 단가로 곱한다. ⚠️ 모델 ID 는 공식 문서 기준이지만 살았는지는
   * 「모델 점검」으로 확인한다 — `gemini-2.5-flash` 가 목록에 남은 채 404 를 내던 일이 있었다.
   *
   * 힌트의 「월」은 데일리 리포트 기준(74회, 입력 86만·출력 24만 토큰)이다.
   */
  { provider: "gemini", model: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash Lite", hint: "가장 저렴(월 $1 아래) · 검색 그라운딩 됨 · 분량을 요구보다 짧게 쓰는 경향" },
  { provider: "gemini", model: "gemini-3.5-flash", label: "Gemini 3.5 Flash", hint: "월 $3.5 · 정리 품질이 Lite 보다 낫다" },
  { provider: "gemini", model: "gemini-3.6-flash", label: "Gemini 3.6 Flash", hint: "월 $3 · 3.5 Flash 의 후속, 출력 단가가 조금 싸다" },
  { provider: "gemini", model: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro", hint: "월 $4.6 · 구글 플래그십 — 플래그십 중 가장 싸다" },
  { provider: "openai", model: "gpt-5.6-luna", label: "GPT-5.6 Luna", hint: "월 $0.5 · 오픈AI 경량" },
  { provider: "openai", model: "gpt-5.6-terra", label: "GPT-5.6 Terra", hint: "월 $4.6 · 중간 — 일반 업무의 기본" },
  { provider: "openai", model: "gpt-5.6-sol", label: "GPT-5.6 Sol", hint: "월 $8.3 · 오픈AI 플래그십" },
  { provider: "openai", model: "gpt-6-astra", label: "GPT-6 Astra", hint: "월 $21 · 최상위 (9/3 출시) — 출력 $50/M" },
  { provider: "anthropic", model: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5", hint: "월 $2 · 저렴 · 한국어 자연스러움" },
  { provider: "anthropic", model: "claude-sonnet-5", label: "Claude Sonnet 5", hint: "월 $6 · 가장 안정적 (기본값)" },
  { provider: "anthropic", model: "claude-opus-5", label: "Claude Opus 5", hint: "월 $10 · 판단이 들어가는 판에" },
  { provider: "anthropic", model: "claude-fable-5-1", label: "Claude Fable 5.1", hint: "단가 미확인 — 사용량 화면이 소넷 단가로 어림한다" },
];

export function availableTextModels(): VisionModelOption[] {
  const ok = new Set(availableVisionProviders());
  return TEXT_MODELS.filter((m) => ok.has(m.provider));
}

/**
 * 이미지 없이 텍스트만 생성. 설정에서 용도별 모델을 고르면 이 경로로 온다.
 *
 * readImage 와 같은 함수를 쓰므로 **기능을 넘겨야 한다.** 안 넘기면 리포트를
 * Gemini 로 돌렸을 때 그 비용이 "이미지 인식"으로 잡힌다 — 어느 메뉴가 돈을 쓰는지
 * 보려고 만든 집계가 거꾸로 거짓말을 하게 된다.
 */
export async function generateText(
  prompt: string,
  maxTokens = 2500,
  provider?: VisionProvider,
  model?: string,
  feature: UsageFeature = "other",
): Promise<VisionResult> {
  return readImage(prompt, "", "", provider, model, maxTokens, feature);
}
