import Anthropic from "@anthropic-ai/sdk";
import { getAiConfig } from "./aiConfig.js";
import { recordApiCall } from "./apiUsage.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { buildDigest } from "./aiSummary.js";
import { listWatchlist } from "./watchlist.js";

/**
 * 시황 질문하기.
 *
 * 리포트는 정해진 틀로 나가지만, 궁금한 건 그때그때 다르다.
 * "왜 오늘 반도체가 빠졌지", "환율이 여기서 더 오르면 뭐가 문제야" 같은 질문에
 * **우리가 가진 실시간 데이터 + 웹 검색**을 함께 물려서 답하게 한다.
 *
 * 두 가지를 다 물리는 게 핵심이다:
 *   - 우리 데이터만 주면 밖에서 벌어진 일을 모른다
 *   - 웹 검색만 주면 내 관심종목·내 수급 데이터를 모른다
 *
 * 매수/매도 추천은 프롬프트에서 막는다. 이 도구는 판단을 대신하는 게 아니라
 * 판단에 필요한 재료를 모으는 용도다.
 */

const SYSTEM = `당신은 한국 주식시장 애널리스트입니다. 사용자의 질문에 답하십시오.

주어지는 것:
1. [시장 데이터] — 사용자의 HTS가 방금 조회한 실시간 데이터 (지수·수급·테마·관심종목 등)
2. web_search 도구 — 최신 뉴스와 해외 시장을 직접 확인할 수 있습니다

규칙:
- **시장 데이터에 있는 것은 그 값을 쓰십시오.** 그게 지금 이 사용자의 화면에 떠 있는 숫자입니다.
- 데이터에 없는 것(해외 시장, 최신 뉴스, 과거 사례)은 **검색해서 확인**하십시오.
- 검색으로도 확인이 안 되면 모른다고 하십시오. 수치를 지어내지 마십시오.
- **매수/매도를 권하지 마십시오. 목표주가를 제시하지 마십시오.**
  대신 "무슨 일이 있었고, 무엇을 확인해야 하는가"를 설명하십시오.
- 사용자는 시장을 아는 사람입니다. 기초 용어 설명은 생략하고 본론만 쓰십시오.
- 한국어로, 질문의 크기에 맞는 분량으로. 짧게 물으면 짧게 답하십시오.

<search_first>
**아래에 해당하면 답하기 전에 반드시 web_search 를 쓰십시오. 기억으로 답하지 마십시오.**
- 해외 시장(미국·일본·중국 등)의 등락, 마감, 특징주
- 경제지표 발표 결과, 연준·정부 발언, 정책 변화
- 특정 기업의 최근 뉴스·실적·공시
- "왜"를 묻는 질문 중 원인이 [시장 데이터]에 없는 것
- 날짜·수치가 걸린 사실 관계

[시장 데이터]에 있는 국내 지수·수급·테마·관심종목 수치는 검색하지 말고 그대로 쓰십시오.
검색이 필요한지 애매하면 검색하십시오. 지어낸 수치보다 검색 한 번이 낫습니다.
</search_first>`;

export interface AskTurn {
  role: "user" | "assistant";
  text: string;
}

export interface AskResult {
  text: string | null;
  searches: string[];
  sources: { title: string; url: string }[];
  inputTokens: number;
  outputTokens: number;
  model: string;
  error?: string;
}

export function isAskConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

/**
 * 쓸 모델. 설정 화면에서 고른 것이 먼저고, 없으면 .env, 그것도 없으면 기본값이다.
 *
 * **Anthropic 것만 받는다.** 이 함수는 웹 검색 도구를 같이 태우는데 그건 Anthropic
 * SDK 쪽 기능이라, 다른 provider 를 골라도 여기선 못 쓴다 — 조용히 검색 없이 답하는
 * 것보다 기본 모델로 제대로 답하는 편이 낫다.
 */
async function model(): Promise<string> {
  const choice = (await getAiConfig()).ask;
  if (choice && choice.provider === "anthropic" && choice.model.trim()) return choice.model.trim();
  return process.env.ASK_MODEL?.trim() || "claude-sonnet-5";
}

/** 대화 맥락이 길어지면 비용이 붙으므로 최근 것만 남긴다 */
const MAX_HISTORY = 8;

export async function askMarket(
  client: KiwoomClient,
  question: string,
  history: AskTurn[] = [],
  opts: { useSearch?: boolean; useMarketData?: boolean } = {},
): Promise<AskResult> {
  const { useSearch = true, useMarketData = true } = opts;
  const usedModel = await model();
  const empty: AskResult = {
    text: null,
    searches: [],
    sources: [],
    inputTokens: 0,
    outputTokens: 0,
    model: usedModel,
  };

  if (!isAskConfigured()) return { ...empty, error: "ANTHROPIC_API_KEY 미설정" };
  if (!question.trim()) return { ...empty, error: "질문이 비어 있습니다" };

  const anthropic = new Anthropic();

  try {
    // 시장 데이터는 첫 질문에만 붙인다 — 매 턴 붙이면 토큰이 배로 든다
    let context = "";
    if (useMarketData && history.length === 0) {
      const digest = await buildDigest(client).catch(() => "");
      const watch = (await listWatchlist().catch(() => [])).map((w) => w.name);
      context = `\n\n=== 시장 데이터 (${new Date().toLocaleString("ko-KR", { hour12: false })} 조회) ===\n${digest}`;
      if (watch.length > 0) context += `\n\n[사용자 관심종목] ${watch.join(", ")}`;
    }

    const messages: Anthropic.MessageParam[] = [
      ...history.slice(-MAX_HISTORY).map((t) => ({
        role: t.role,
        content: t.text,
      })),
      { role: "user" as const, content: `${question}${context}` },
    ];

    const response = await anthropic.messages.create({
      model: usedModel,
      max_tokens: 4000,
      system: SYSTEM,
      ...(useSearch
        ? {
            tools: [
              { type: "web_search_20260209" as const, name: "web_search" as const, max_uses: 5 },
            ],
          }
        : {}),
      messages,
    });

    const searches: string[] = [];
    const sources: { title: string; url: string }[] = [];
    const texts: string[] = [];
    let toolError: string | undefined;

    for (const block of response.content) {
      if (block.type === "text") {
        texts.push(block.text);
      } else if (block.type === "server_tool_use" && block.name === "web_search") {
        const q = (block.input as { query?: string })?.query;
        if (q) searches.push(q);
      } else if (block.type === "web_search_tool_result") {
        // 서버 도구 오류는 예외가 아니라 200 응답에 담겨 온다
        const content = block.content as unknown;
        if (Array.isArray(content)) {
          for (const r of content as { title?: string; url?: string }[]) {
            if (r.url) sources.push({ title: r.title ?? r.url, url: r.url });
          }
        } else if (content && typeof content === "object") {
          toolError = String((content as { error_code?: string }).error_code ?? "검색 실패");
        }
      }
    }

    const inputTokens = response.usage.input_tokens ?? 0;
    const outputTokens = response.usage.output_tokens ?? 0;
    void recordApiCall("anthropic", usedModel, "ok", { inputTokens, outputTokens, feature: "ask" });

    return {
      // 인용이 붙으면 한 문장이 여러 text 블록으로 쪼개진다.
      // 줄바꿈으로 이으면 문장 중간이 끊기므로 그대로 이어붙인다.
      text: texts.join("").trim() || null,
      searches,
      sources: [...new Map(sources.map((s) => [s.url, s])).values()].slice(0, 10),
      inputTokens,
      outputTokens,
      model: usedModel,
      error: toolError,
    };
  } catch (err) {
    void recordApiCall("anthropic", usedModel, "failed");
    return { ...empty, error: err instanceof Error ? err.message : "질문 처리 실패" };
  }
}
