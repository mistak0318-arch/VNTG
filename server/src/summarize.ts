import { recordApiCall } from "./apiUsage.js";
import { choiceFor, type AiPurpose } from "./aiConfig.js";
import { generateText } from "./vision.js";

/**
 * 요약 생성 래퍼.
 *
 * 데일리 리포트·알림의 요약문을 만든다. 두 가지 원칙:
 *  1) 키가 없거나 호출이 실패해도 **절대 예외를 던지지 않는다**. 요약은 부가 기능이고,
 *     실패하면 원본 데이터만으로 리포트가 나가야 한다.
 *  2) 응답의 usage(토큰)를 반드시 사용량에 기록한다. 이건 실제 돈이 나가는 API다.
 */

const API_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_MODEL = "claude-sonnet-5";

export interface SummarizeResult {
  text: string | null;
  inputTokens: number;
  outputTokens: number;
  /** 실제로 쓴 모델 — 리포트에 남겨두면 나중에 품질 비교가 된다 */
  usedModel?: string;
  error?: string;
}

export function isClaudeConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function model(): string {
  return process.env.CLAUDE_MODEL?.trim() || DEFAULT_MODEL;
}

/**
 * @param purpose 설정 화면에서 이 용도에 다른 모델을 골랐으면 그쪽으로 보낸다.
 *   고른 게 없으면 지금까지처럼 Claude 기본 경로를 쓴다 — 설정을 안 건드린 사람의
 *   동작이 바뀌면 안 된다.
 */
export async function summarize(
  prompt: string,
  maxTokens = 800,
  purpose?: AiPurpose,
): Promise<SummarizeResult> {
  const empty = { text: null, inputTokens: 0, outputTokens: 0 };

  if (purpose) {
    const choice = await choiceFor(purpose);
    if (choice) {
      const r = await generateText(prompt, maxTokens, choice.provider, choice.model);
      return {
        text: r.text,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        usedModel: r.model ?? choice.model,
        error: r.error,
      };
    }
  }

  if (!isClaudeConfigured()) {
    return { ...empty, error: "ANTHROPIC_API_KEY 미설정" };
  }

  const usedModel = model();
  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!.trim(),
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: usedModel,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const body = (await res.json()) as {
      content?: { type: string; text?: string }[];
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };

    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;

    if (!res.ok) {
      // 실패해도 토큰이 소모됐을 수 있으므로 기록은 남긴다
      void recordApiCall("anthropic", usedModel, res.status === 429 ? "rateLimited" : "failed", {
        inputTokens,
        outputTokens,
      });
      return { ...empty, inputTokens, outputTokens, error: body.error?.message ?? `HTTP ${res.status}` };
    }

    void recordApiCall("anthropic", usedModel, "ok", { inputTokens, outputTokens });

    const text = (body.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();

    return { text: text || null, inputTokens, outputTokens, usedModel };
  } catch (err) {
    void recordApiCall("anthropic", usedModel, "failed");
    return { ...empty, error: err instanceof Error ? err.message : "알 수 없는 오류" };
  }
}
