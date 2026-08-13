import { recordApiCall } from "./apiUsage.js";

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

const MODELS: Record<VisionProvider, string> = {
  gemini: "gemini-2.5-flash",
  openai: "gpt-4o-mini",
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
  {
    provider: "gemini",
    model: "gemini-2.5-flash-lite",
    label: "Gemini 2.5 Flash Lite",
    hint: "가장 저렴 · 단순한 표만",
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    hint: "저렴 · 일반적인 일정표",
  },
  {
    provider: "gemini",
    model: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "복잡한 표·손글씨에 강함",
  },
  { provider: "openai", model: "gpt-4o-mini", label: "GPT-4o mini", hint: "저렴 · 무난" },
  { provider: "openai", model: "gpt-4o", label: "GPT-4o", hint: "표 인식 정확도 높음" },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    hint: "저렴 · 한글 표에 강함",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    hint: "복잡한 이미지에 가장 안정적",
  },
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
    candidates?: { content?: { parts?: { text?: string }[] } }[];
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

  return {
    text: body.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? null,
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
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: maxTokens,
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
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    hint: "가장 저렴 · 요약에 무난",
  },
  {
    provider: "gemini",
    model: "gemini-2.5-pro",
    label: "Gemini 2.5 Pro",
    hint: "맥락 파악이 필요할 때",
  },
  { provider: "openai", model: "gpt-4o-mini", label: "GPT-4o mini", hint: "저렴 · 무난" },
  { provider: "openai", model: "gpt-4o", label: "GPT-4o", hint: "정리 품질 높음" },
  {
    provider: "anthropic",
    model: "claude-haiku-4-5-20251001",
    label: "Claude Haiku 4.5",
    hint: "저렴 · 한국어 자연스러움",
  },
  {
    provider: "anthropic",
    model: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    hint: "가장 안정적 (기본값)",
  },
];

export function availableTextModels(): VisionModelOption[] {
  const ok = new Set(availableVisionProviders());
  return TEXT_MODELS.filter((m) => ok.has(m.provider));
}

export async function generateText(
  prompt: string,
  maxTokens = 2500,
  provider?: VisionProvider,
  model?: string,
): Promise<VisionResult> {
  return readImage(prompt, "", "", provider, model, maxTokens);
}
