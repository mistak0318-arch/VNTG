import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { availableTextModels, type VisionProvider } from "./vision.js";

/**
 * 용도별 AI 모델 선택.
 *
 * 하나의 모델로 전부 돌릴 이유가 없다. 용도마다 요구가 다르고, 무엇보다
 * **호출 빈도가 달라서 같은 모델이라도 월 비용이 몇 배씩 벌어진다.**
 *
 *   report   하루 3~4회. 시장 데이터를 해석해야 하므로 품질이 중요하다
 *   channel  하루 3회. 입력이 크고(선별 60건) 정리 성격이라 싼 모델도 쓸 만하다
 *
 * .env 로 하지 않고 파일에 둔 이유: 바꿔가며 결과를 비교해야 하는 값이라
 * 서버 재시작 없이 화면에서 고를 수 있어야 한다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "aiConfig.json");

export type AiPurpose =
  | "report"
  | "channel"
  | "research"
  | "ask"
  | "pulse"
  | "pinned"
  | "vision"
  | "company";

export interface AiChoice {
  provider: VisionProvider;
  model: string;
}

export interface AiConfig {
  report: AiChoice | null;
  channel: AiChoice | null;
  /**
   * 웹 리서치 — **입력이 제일 큰 자리**다.
   *
   * 실측으로 호출당 입력 107,000 토큰이 나왔다. 리포트 본문(8,300)의 열세 배다.
   * 우리가 정제를 안 해서가 아니라 검색 결과가 대화에 쌓여 매 턴 재전송되기 때문인데,
   * 그래서 **여기야말로 싼 모델로 갈아 끼울 값어치가 있다.**
   */
  research: AiChoice | null;
  /**
   * 시황 질문하기.
   *
   * **여기는 Anthropic 만 고를 수 있다.** 웹 검색을 붙여 답하는데 그 도구가
   * Anthropic SDK 쪽에 붙어 있어서, 다른 provider 를 고르면 검색 없이 답하게 된다.
   * 화면에서도 Claude 모델만 보여 준다.
   */
  ask: AiChoice | null;
  /**
   * 시장 흐름 요약.
   *
   * 입력이 **숫자 몇십 줄뿐**이라 리포트보다 훨씬 작다(검색도 안 붙는다).
   * 화면을 열 때마다 도는 자리이므로 **싼 모델이 맞다** — 기본은 리포트와 같은 것을 쓰되
   * 따로 고를 수 있게 뒀다.
   */
  pulse: AiChoice | null;
  /**
   * 고정 채널 AI 세줄 (2026-08-26 분리) — 전엔 「데일리 리포트」 설정을 따라가서
   * 사용자가 따로 고를 수 없었다. 입력이 채널 원문 몇 개라 크지 않다.
   */
  pinned: AiChoice | null;
  /**
   * 캘린더 이미지 인식 (2026-08-26 추가) — vision.ts 가 자체 순서(싼 것부터)로
   * 골랐고 설정에는 없었다. 여기서 고르면 그 모델을 먼저 시도한다.
   */
  vision: AiChoice | null;
  /**
   * 종목 정보 엮기 (2026-09-01 추가).
   *
   * 입력은 **한 종목의 조각들**뿐이다 — 기업개황 한 줄, 테마 편입 사유 대여섯 줄,
   * 공시·뉴스 제목 스물넷, 분기 실적 넉 줄. 리서치처럼 부풀지 않는다.
   *
   * 그리고 **버튼을 눌러야만 돈다.** 자동으로 도는 자리가 아니라서 호출 수가
   * 사람 손에 달려 있다 — 좋은 모델을 골라도 비용이 튀지 않는 자리다.
   */
  company: AiChoice | null;
}

/** null 이면 기존 동작(ANTHROPIC_API_KEY + CLAUDE_MODEL)을 그대로 쓴다 */
export const DEFAULT_AI_CONFIG: AiConfig = {
  report: null,
  channel: null,
  research: null,
  ask: null,
  pulse: null,
  pinned: null,
  vision: null,
  company: null,
};

export const PURPOSE_LABEL: Record<AiPurpose, string> = {
  report: "데일리 리포트",
  channel: "구독 채널 요약",
  research: "웹 리서치 (입력 정제)",
  ask: "시황 질문하기 (Claude 만)",
  pulse: "시장 흐름 요약",
  pinned: "고정 채널 AI 세줄",
  vision: "캘린더 이미지 인식",
  company: "종목 정보 엮기 (버튼)",
};

let cache: AiConfig | null = null;

export async function getAiConfig(): Promise<AiConfig> {
  if (cache) return cache;
  try {
    const saved = JSON.parse(await readFile(FILE, "utf-8")) as AiConfig;
    cache = { ...DEFAULT_AI_CONFIG, ...saved };
  } catch {
    cache = DEFAULT_AI_CONFIG;
  }
  return cache;
}

/** 고른 모델이 실제로 쓸 수 있는 것인지 확인해서 저장한다 */
export async function saveAiConfig(input: AiConfig): Promise<AiConfig> {
  const usable = new Set(availableTextModels().map((m) => m.model));
  const clean = (c: AiChoice | null | undefined): AiChoice | null =>
    c && usable.has(c.model) ? { provider: c.provider, model: c.model } : null;

  const next: AiConfig = {
    report: clean(input.report),
    channel: clean(input.channel),
    research: clean(input.research),
    pulse: clean(input.pulse),
    pinned: clean(input.pinned),
    vision: clean(input.vision),
    company: clean(input.company),
    // 질문하기는 Anthropic 만 — 검색 도구가 거기 붙어 있다
    ask: (() => {
      const c = clean(input.ask);
      return c && c.provider === "anthropic" ? c : null;
    })(),
  };
  cache = next;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(next, null, 2), "utf-8");
  return next;
}

export async function choiceFor(purpose: AiPurpose): Promise<AiChoice | null> {
  const cfg = await getAiConfig();
  /*
   * 고정 채널 세줄은 따로 안 골랐으면 **리포트 설정을 따라간다** — 분리 전의 동작
   * 그대로다. 분리한 이유는 「고를 수 있게」이지 「기본이 바뀌게」가 아니다.
   */
  if (purpose === "pinned") return cfg.pinned ?? cfg.report;
  return cfg[purpose];
}
