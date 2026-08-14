import Anthropic from "@anthropic-ai/sdk";
import { recordApiCall } from "./apiUsage.js";
import { choiceFor } from "./aiConfig.js";

/**
 * AI 웹 리서치.
 *
 * 지금까지 AI에 넘긴 건 우리가 조회한 데이터뿐이다. 그러면 우리가 안 받아온 것은
 * AI도 모른다 — 간밤 미국장에서 무슨 일이 있었는지, 지금 시장이 무엇을 주목하는지.
 *
 * **LLM은 그냥 부르면 웹을 못 읽는다.** 학습 시점 지식만 쓰는데, 시장 데이터에서
 * 그건 위험하다. 없는 수치를 자신 있게 지어낸다.
 * 그래서 Anthropic의 서버사이드 web_search 도구를 붙인다 — 모델이 직접 검색하고,
 * 어디서 가져왔는지 출처를 함께 돌려준다.
 *
 * 비용: 검색 1,000회당 $10 (= 회당 $0.01) + 토큰. max_uses로 상한을 건다.
 */

const RESEARCH_PROMPT = `당신은 한국 주식시장 애널리스트입니다. 웹 검색으로 최신 정보를 확인해 정리하십시오.

반드시 검색해서 확인할 것:
1. 간밤 미국 증시 마감 (다우·S&P500·나스닥 등락률, 주도 섹터, 특징 종목)
2. 미국 시장에 영향을 준 사건 (경제지표 발표, 연준 발언, 대형주 실적, 정책)
3. 오늘 한국 시장에 영향을 줄 만한 대외 변수
4. 최근 시장이 주목하는 테마 (미국·한국 양쪽)

규칙:
- **검색으로 확인한 사실만 쓰십시오.** 기억에 의존해 수치를 쓰지 마십시오.
- 수치를 인용할 때는 언제 기준인지 밝히십시오.
- **매수/매도를 권하지 마십시오. 목표주가를 제시하지 마십시오.**
- 확인이 안 된 것은 "~라는 관측이 있음"처럼 출처가 드러나게 쓰십시오.
- 한국어로, 한글 600~900자.

형식:
## 미국 시장
(간밤 마감과 그 배경. 지수 등락률은 반드시 검색으로 확인한 값)

## 오늘 한국 시장에 미칠 영향
(위 내용이 국내 어느 업종·테마에 어떻게 연결되는지)

## 눈여겨볼 변수
(다가오는 일정과 확인 사항 2~3개)`;

export interface WebResearchResult {
  text: string | null;
  /** 모델이 실제로 검색한 질의들 — 무엇을 근거로 썼는지 보이게 */
  searches: string[];
  /** 인용한 출처 */
  sources: { title: string; url: string }[];
  searchCount: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  /** 앞선 발행의 결과를 그대로 쓴 것인가 — 화면에 밝혀야 오해가 없다 */
  cached?: boolean;
  error?: string;
}

export function isWebResearchConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

function model(): string {
  return process.env.RESEARCH_MODEL?.trim() || "claude-sonnet-5";
}

/**
 * 웹을 검색해 시장 상황을 정리한다.
 *
 * @param maxSearches 검색 횟수 상한. 이게 곧 비용 상한이다.
 */
/**
 * 리서치 결과 캐시.
 *
 * 이게 이 앱에서 **가장 비싼 호출**이다. 서버사이드 web_search 는 검색 결과가 대화에
 * 쌓이고 매 턴 통째로 재전송돼서 입력 토큰이 기하급수로 붇는다 — 실측으로 한 번에
 * 입력 96,000 토큰이 나왔다. 여기에 검색 건당 $0.01 이 따로 붙는다.
 *
 * 그런데 발행할 때마다 새로 돌리고 있었다. 조간·장중·석간 세 판이 각각 6~8회씩
 * 검색하는데, **간밤 미국장은 하루에 한 번 끝난다.** 30분 안에 다시 물어봐야 같은 답이
 * 온다. 그래서 판이 달라도 같은 창 안이면 앞의 결과를 그대로 쓴다.
 */
const RESEARCH_TTL_MS = 90 * 60_000;
let researchCache: { at: number; searches: number; data: WebResearchResult } | null = null;

/**
 * 하루 호출 상한.
 *
 * 캐시를 넣어도 「지금 발행」을 여러 번 누르면 그때마다 캐시가 만료돼 있을 수 있고,
 * 그러면 다시 샌다. 실제로 하루에 $5.64 가 이렇게 나갔다 — 8회 발행 × 회당 $0.3~0.7.
 * 캐시가 "덜 부르게" 하는 장치라면 이건 **못 부르게** 하는 장치다. 둘 다 필요하다.
 */
const DAILY_LIMIT = Number(process.env.RESEARCH_DAILY_LIMIT) || 4;
let spent = { day: "", count: 0 };

function kstDay(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/** 오늘 몇 번 썼나 / 몇 번 남았나 — 화면에 보여주려고 */
export function researchBudget(): { used: number; limit: number; enabled: boolean } {
  const day = kstDay();
  return {
    used: spent.day === day ? spent.count : 0,
    limit: DAILY_LIMIT,
    enabled: process.env.RESEARCH_ENABLED !== "0",
  };
}

export function researchCacheStatus(): { at: number; expiresAt: number } | null {
  return researchCache ? { at: researchCache.at, expiresAt: researchCache.at + RESEARCH_TTL_MS } : null;
}

/** 지금 캐시가 쓸 만한가 */
function cacheFresh(maxSearches: number): boolean {
  return Boolean(
    researchCache &&
      Date.now() - researchCache.at < RESEARCH_TTL_MS &&
      maxSearches <= researchCache.searches,
  );
}

let warming: Promise<unknown> | null = null;

/**
 * 캐시만 쓰고 **절대 기다리지 않는** 경로.
 *
 * 발행 화면에 단계 표시를 붙이고 나서야 보였는데, 앞의 여섯 단계는 10초 안에 끝나고
 * 나머지 몇 분이 전부 이 리서치였다. 검색이 느린 건 어쩔 수 없지만, 그것 때문에
 * **리포트 전체가 인질이 될 이유는 없다.**
 *
 * 그래서 발행은 있는 것만 쓴다. 없으면 뒤에서 채우기 시작하고 이번 판은 리서치 없이 낸다 —
 * 다음 판이 그걸 받는다. 정기 발행은 아래 warmResearch 가 미리 채워 두므로 거의 항상 있다.
 */
export function peekWebResearch(maxSearches = 6): WebResearchResult | null {
  if (cacheFresh(maxSearches)) return { ...researchCache!.data, cached: true };
  if (!warming && isWebResearchConfigured()) {
    warming = runWebResearch(maxSearches).finally(() => {
      warming = null;
    });
  }
  return null;
}

/** 정기 발행 직전에 미리 채운다. 이미 신선하면 아무것도 안 한다 */
export async function warmResearch(maxSearches = 6): Promise<void> {
  if (cacheFresh(maxSearches) || warming) return;
  warming = runWebResearch(maxSearches).finally(() => {
    warming = null;
  });
  await warming.catch(() => undefined);
}

/** 지금 리서치가 돌고 있는가 — 화면에 "준비 중"이라고 알리려고 */
export function isResearchWarming(): boolean {
  return warming !== null;
}

/**
 * Gemini + Google 검색 그라운딩.
 *
 * 검색 결과가 토큰으로 안 잡히므로 입력이 프롬프트 길이만큼만 든다.
 * 출처는 groundingMetadata 에서 꺼낸다 — 무엇을 보고 썼는지는 남아야 한다.
 */
async function geminiResearch(modelName: string, maxSearches: number): Promise<WebResearchResult> {
  const empty: WebResearchResult = {
    text: null,
    searches: [],
    sources: [],
    searchCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    model: modelName,
  };
  const key = process.env.GEMINI_API_KEY?.trim();
  if (!key) return { ...empty, error: "GEMINI_API_KEY 미설정" };

  try {
    const now = new Date().toLocaleString("ko-KR", { hour12: false });
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `${RESEARCH_PROMPT}

지금은 한국 시각 ${now} 입니다.` }] }],
          tools: [{ google_search: {} }],
          generationConfig: { temperature: 0, maxOutputTokens: 2000 },
        }),
      },
    );
    const j = (await res.json()) as {
      error?: { message?: string };
      candidates?: {
        content?: { parts?: { text?: string }[] };
        groundingMetadata?: {
          webSearchQueries?: string[];
          groundingChunks?: { web?: { uri?: string; title?: string } }[];
        };
      }[];
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    if (j.error) {
      void recordApiCall("gemini", modelName, "failed", { feature: "research" });
      return { ...empty, error: j.error.message ?? "Gemini 오류" };
    }

    const cand = j.candidates?.[0];
    const text = (cand?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
    const gm = cand?.groundingMetadata;
    const searches = gm?.webSearchQueries ?? [];
    const sources = (gm?.groundingChunks ?? [])
      .map((c) => ({ title: c.web?.title ?? c.web?.uri ?? "", url: c.web?.uri ?? "" }))
      .filter((x) => x.url);

    const inputTokens = j.usageMetadata?.promptTokenCount ?? 0;
    const outputTokens = j.usageMetadata?.candidatesTokenCount ?? 0;
    void recordApiCall("gemini", modelName, text ? "ok" : "failed", {
      inputTokens,
      outputTokens,
      // 그라운딩 검색은 건당 과금이 따로 없다(요금은 토큰으로만) — 0으로 둔다
      feature: "research",
    });

    const result: WebResearchResult = {
      text: text || null,
      searches,
      sources: [...new Map(sources.map((s) => [s.url, s])).values()].slice(0, 12),
      searchCount: searches.length,
      inputTokens,
      outputTokens,
      model: modelName,
    };
    if (result.text) researchCache = { at: Date.now(), searches: maxSearches, data: result };
    return result;
  } catch (err) {
    void recordApiCall("gemini", modelName, "failed", { feature: "research" });
    return { ...empty, error: err instanceof Error ? err.message : "리서치 실패" };
  }
}

export async function runWebResearch(
  maxSearches = 6,
  opts: { force?: boolean } = {},
): Promise<WebResearchResult> {
  const empty: WebResearchResult = {
    text: null,
    searches: [],
    sources: [],
    searchCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    model: model(),
  };

  /*
   * 앞 결과가 아직 유효하면 그대로 쓴다. 다만 이번에 검색을 **더** 하겠다고 요청했으면
   * (장중 6회 → 조간 8회) 다시 돈다 — 조간은 간밤 해외가 본체라 얕게 보면 안 된다.
   */
  if (!opts.force && researchCache && Date.now() - researchCache.at < RESEARCH_TTL_MS) {
    if (maxSearches <= researchCache.searches) {
      return { ...researchCache.data, cached: true };
    }
  }

  // 상한을 넘으면 아예 안 부른다. 캐시가 있으면 위에서 이미 돌려줬다
  const day = kstDay();
  if (spent.day !== day) spent = { day, count: 0 };
  if (spent.count >= DAILY_LIMIT) {
    return { ...empty, error: `오늘 웹 리서치 상한(${DAILY_LIMIT}회)을 다 썼습니다` };
  }
  if (process.env.RESEARCH_ENABLED === "0") {
    return { ...empty, error: "웹 리서치가 꺼져 있습니다" };
  }
  spent.count += 1;

  /*
   * 설정에서 리서치용 모델을 골랐으면 그쪽으로 보낸다.
   *
   * **Gemini 로 돌리면 입력 토큰이 사실상 사라진다.** 실측:
   *   Claude web_search      입력 107,000 토큰 (+ 검색 건당 $0.01)
   *   gemini-3.5-flash-lite  입력      39 토큰
   * 같은 질문에 같은 답이 나왔다. Google 그라운딩은 검색 결과를 서버에 두고 요약만
   * 돌려주므로, 결과가 대화에 쌓여 매 턴 재전송되는 일이 없다. 이 앱에서 제일 큰
   * 비용 항목이 여기 하나로 정리된다.
   */
  const choice = await choiceFor("research").catch(() => null);
  if (choice?.provider === "gemini") {
    return geminiResearch(choice.model, maxSearches);
  }

  if (!isWebResearchConfigured()) {
    return { ...empty, error: "ANTHROPIC_API_KEY 미설정" };
  }

  const client = new Anthropic();
  const usedModel = model();

  try {
    const now = new Date().toLocaleString("ko-KR", { hour12: false });
    const response = await client.messages.create({
      model: usedModel,
      max_tokens: 4000,
      tools: [
        {
          type: "web_search_20260209",
          name: "web_search",
          // 검색 횟수가 곧 비용이다 ($0.01/회). 여기서 막는다.
          max_uses: maxSearches,
        },
      ],
      messages: [
        {
          role: "user",
          content: `${RESEARCH_PROMPT}\n\n지금은 한국 시각 ${now} 입니다.`,
        },
      ],
    });

    // 서버 도구 오류는 예외가 아니라 200 응답의 블록으로 온다.
    // 성공이면 content가 배열, 실패면 error_code를 담은 객체다.
    const searches: string[] = [];
    const sources: { title: string; url: string }[] = [];
    let searchCount = 0;
    let toolError: string | undefined;
    const texts: string[] = [];

    for (const block of response.content) {
      if (block.type === "text") {
        texts.push(block.text);
      } else if (block.type === "server_tool_use" && block.name === "web_search") {
        searchCount += 1;
        const q = (block.input as { query?: string })?.query;
        if (q) searches.push(q);
      } else if (block.type === "web_search_tool_result") {
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
    void recordApiCall("anthropic", usedModel, "ok", {
      inputTokens,
      outputTokens,
      // 웹 검색은 토큰과 별도로 건당 과금된다. 안 세면 리서치 비용이 통째로 빠진다
      webSearches: searchCount,
      cacheWriteTokens: (response.usage as { cache_creation_input_tokens?: number }).cache_creation_input_tokens ?? 0,
      cacheReadTokens: (response.usage as { cache_read_input_tokens?: number }).cache_read_input_tokens ?? 0,
      feature: "research",
    });

    const result: WebResearchResult = {
      // 인용이 붙으면 한 문장이 여러 text 블록으로 쪼개진다.
      // 줄바꿈으로 이으면 문장 중간이 끊기므로 그대로 이어붙인다.
      text: texts.join("").trim() || null,
      searches,
      // 같은 출처가 여러 번 잡히므로 정리한다
      sources: [...new Map(sources.map((s) => [s.url, s])).values()].slice(0, 12),
      searchCount,
      inputTokens,
      outputTokens,
      model: usedModel,
      error: toolError,
    };
    // 쓸 만한 결과만 캐시에 넣는다 — 실패한 걸 90분 물고 있으면 그게 더 나쁘다
    if (result.text && !toolError) {
      researchCache = { at: Date.now(), searches: maxSearches, data: result };
    }
    return result;
  } catch (err) {
    void recordApiCall("anthropic", usedModel, "failed");
    return { ...empty, error: err instanceof Error ? err.message : "리서치 실패" };
  }
}

/** 리포트 다이제스트에 넣을 형태로 */
export function toResearchDigest(r: WebResearchResult): string {
  if (!r.text) return "";
  const src =
    r.sources.length > 0
      ? `\n(출처: ${r.sources.slice(0, 5).map((s) => s.title).join(" / ")})`
      : "";
  return `\n[AI 웹 리서치 — 검색 ${r.searchCount}회로 확인한 내용]\n${r.text}${src}`;
}
