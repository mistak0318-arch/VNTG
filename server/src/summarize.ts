import { recordApiCall, type UsageFeature } from "./apiUsage.js";
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
/**
 * 잘린 응답에서 **마지막 성한 문장까지만** 남긴다.
 *
 * 출력 상한에 걸리면 단어 한가운데서 끊긴다. 그 꼬리를 그대로 두면
 * "코스닥 전기/전자(-1,9" 같은 반쪽 숫자가 화면에 남아 오독을 부른다.
 * 이미 토큰 값은 치렀으므로 앞부분은 버리지 않고, 꼬리만 떼어낸다.
 */
export function trimToLastSentence(text: string): string {
  if (!text) return text;
  const lines = text.split("\n");
  // 마지막 줄만 손본다 — 앞줄들은 어차피 완결돼 있다
  const last = lines[lines.length - 1];
  const m = /[.!?。]["'”’)\]]?(?=[^.!?。]*$)/.exec(last);
  if (m) {
    lines[lines.length - 1] = last.slice(0, m.index + m[0].length);
  } else {
    // 이 줄에 끝난 문장이 하나도 없으면 줄째로 버린다
    lines.pop();
  }
  return lines.join("\n").trimEnd();
}

export async function summarize(
  prompt: string,
  maxTokens = 800,
  purpose?: AiPurpose,
): Promise<SummarizeResult> {
  const empty = { text: null, inputTokens: 0, outputTokens: 0 };

  if (purpose) {
    const choice = await choiceFor(purpose);
    if (choice) {
      // 용도를 그대로 넘긴다 — 안 넘기면 이 경로의 비용이 전부 "이미지 인식"으로 잡힌다
      const r = await generateText(prompt, maxTokens, choice.provider, choice.model, purpose);
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
      usage?: {
        input_tokens?: number;
        output_tokens?: number;
        // 캐시 토큰은 단가가 달라서(쓰기 1.25배 / 읽기 0.1배) 따로 받아야 비용이 맞는다
        cache_creation_input_tokens?: number;
        cache_read_input_tokens?: number;
      };
      stop_reason?: string;
      error?: { message?: string };
    };

    const inputTokens = body.usage?.input_tokens ?? 0;
    const outputTokens = body.usage?.output_tokens ?? 0;
    const cacheWriteTokens = body.usage?.cache_creation_input_tokens ?? 0;
    const cacheReadTokens = body.usage?.cache_read_input_tokens ?? 0;
    // 용도를 그대로 기능으로 쓴다. 안 넘어온 호출(설정 화면 연결 테스트 등)은 "기타"
    const feature: UsageFeature = purpose === "channel" ? "channel" : purpose === "report" ? "report" : "other";

    if (!res.ok) {
      // 실패해도 토큰이 소모됐을 수 있으므로 기록은 남긴다
      void recordApiCall("anthropic", usedModel, res.status === 429 ? "rateLimited" : "failed", {
        inputTokens,
        outputTokens,
        cacheWriteTokens,
        cacheReadTokens,
        feature,
      });
      return { ...empty, inputTokens, outputTokens, error: body.error?.message ?? `HTTP ${res.status}` };
    }

    void recordApiCall("anthropic", usedModel, "ok", {
      inputTokens,
      outputTokens,
      cacheWriteTokens,
      cacheReadTokens,
      feature,
    });

    const text = (body.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("")
      .trim();

    /*
     * 출력 상한에 걸려 문장 중간에서 끊긴 응답이 그대로 발행된 적이 있다
     * ("...닛케이는 +1." 에서 끝남). 조용히 나가면 잘린 줄도 모르므로 반드시 알린다.
     * 텍스트는 살려서 돌려준다 — 잘렸어도 앞부분은 쓸 만하다.
     */
    if (body.stop_reason === "max_tokens") {
      return {
        // 마지막 성한 문장까지만 남긴다. "...닛케이는 +1." 처럼 단어 중간에서 끊긴
        // 꼬리를 그대로 보여 주면 읽는 사람이 숫자를 오독한다 — 잘라내는 게 낫다.
        text: trimToLastSentence(text) || null,
        inputTokens,
        outputTokens,
        usedModel,
        error: `출력 상한(${maxTokens} 토큰)에 걸려 뒷부분이 잘렸습니다. 마지막 문장까지만 표시합니다.`,
      };
    }

    return { text: text || null, inputTokens, outputTokens, usedModel };
  } catch (err) {
    void recordApiCall("anthropic", usedModel, "failed");
    return { ...empty, error: err instanceof Error ? err.message : "알 수 없는 오류" };
  }
}
