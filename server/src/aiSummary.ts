import type { KiwoomClient } from "./kiwoomClient.js";
import { getSection } from "./marketOverview.js";
import type { IndexCard, MarketFlow, StockRow, Themes, Sectors } from "./marketOverview.js";
import { sectorNews } from "./newsDisclosure.js";
import { buildMarketDrivers } from "./reportBuilder.js";
import { isClaudeConfigured, summarize } from "./summarize.js";
import { listWatchlist } from "./watchlist.js";

/**
 * 데일리 리포트 최상단의 "AI 정리".
 *
 * 원칙 두 가지:
 *  1) **토큰을 아낀다.** 원본 JSON을 통째로 넣지 않고 숫자와 제목만 추려서 텍스트로 만든다.
 *     기사 본문은 절대 넣지 않는다 (저작권 + 토큰 낭비).
 *  2) **매매 추천을 시키지 않는다.** 이 앱은 조회 전용이고, 사실 정리와 자금 흐름 해석까지만 맡긴다.
 *     "무엇을 사라"가 아니라 "무슨 일이 있었고 돈이 어디로 움직였나"를 요구한다.
 */

const CACHE_TTL_MS = 10 * 60_000;
let cache: { key: string; data: AiSummary; at: number } | null = null;

export interface AiSummary {
  text: string | null;
  /** 요약을 만들 때 쓴 데이터의 기준 시각 */
  basedOn: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  error?: string;
  /** 프롬프트에 실제로 들어간 요약본 — 무엇을 보고 판단했는지 확인용 */
  digest?: string;
}

function fmt(n: number): string {
  return n.toLocaleString("ko-KR");
}

function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

/** 오늘 판(조간/장중/석간) — 캐시 키와 프롬프트 맥락에 쓴다 */
function edition(now = new Date()): string {
  const h = now.getHours();
  if (h < 7) return "전일 석간";
  if (h < 12) return "조간(장 시작 전)";
  if (h < 16) return "장중";
  return "석간(장 마감 후)";
}

/**
 * 리포트 데이터를 사람이 읽는 짧은 텍스트로 압축한다.
 * 이게 곧 프롬프트 본문이라, 여기서 토큰이 결정된다.
 */
async function buildDigest(client: KiwoomClient): Promise<string> {
  const watchNames = (await listWatchlist().catch(() => [])).map((w) => w.name);

  const [idxSec, flowSec, moverSec, drivers, news] = await Promise.all([
    getSection("indices", client).catch(() => null),
    getSection("flow", client).catch(() => null),
    getSection("movers", client).catch(() => null),
    buildMarketDrivers(client, { topN: 5 }).catch(() => null),
    sectorNews({ majorOnly: true, perSector: 6, watchNames }).catch(() => null),
  ]);

  const lines: string[] = [];

  const indices = (idxSec?.data ?? []) as IndexCard[];
  if (indices.length > 0) {
    lines.push("[지수]");
    for (const i of indices) {
      lines.push(`${i.name} ${fmt(i.price)} ${pct(i.changeRate)} (상승 ${i.rising} / 하락 ${i.falling})`);
    }
  }

  const flow = (flowSec?.data ?? null) as MarketFlow | null;
  if (flow) {
    lines.push("\n[투자자 순매수, 억원]");
    lines.push(
      `코스피: 외국인 ${fmt(flow.kospi.foreign)} / 기관 ${fmt(flow.kospi.institution)} / 개인 ${fmt(flow.kospi.individual)}`,
    );
    lines.push(
      `  (기관 세부) 금융투자 ${fmt(flow.kospi.financialInvestment)} / 투신 ${fmt(flow.kospi.investmentTrust)} / 연기금 ${fmt(flow.kospi.pensionFund)}`,
    );
    lines.push(
      `코스닥: 외국인 ${fmt(flow.kosdaq.foreign)} / 기관 ${fmt(flow.kosdaq.institution)} / 개인 ${fmt(flow.kosdaq.individual)}`,
    );
  }

  if (drivers) {
    lines.push("\n[강한 테마]");
    for (const t of drivers.themes.up) {
      lines.push(`${t.name} ${pct(t.changeRate)} (${t.mainStock})`);
    }
    lines.push("\n[약한 테마]");
    for (const t of drivers.themes.down) lines.push(`${t.name} ${pct(t.changeRate)}`);

    lines.push("\n[강한 업종]");
    for (const s of drivers.sectors) lines.push(`${s.market} ${s.name} ${pct(s.changeRate)}`);
  }

  const movers = (moverSec?.data ?? null) as { rising: StockRow[]; falling: StockRow[] } | null;
  if (movers) {
    lines.push("\n[급등 상위]");
    lines.push(movers.rising.slice(0, 8).map((s) => `${s.name} ${pct(s.changeRate)}`).join(", "));
    lines.push("[급락 상위]");
    lines.push(movers.falling.slice(0, 8).map((s) => `${s.name} ${pct(s.changeRate)}`).join(", "));
  }

  if (news) {
    lines.push("\n[주요 뉴스 헤드라인]");
    for (const sec of news.sectors) {
      const heads = sec.items.slice(0, 4).map((n) => `- ${n.title} (${n.coverage}개 매체)`);
      if (heads.length > 0) lines.push(`<${sec.label}>`, ...heads);
    }
  }

  if (watchNames.length > 0) {
    lines.push(`\n[사용자 관심종목] ${watchNames.join(", ")}`);
  }

  return lines.join("\n");
}

const SYSTEM_RULES = `너는 한국 주식시장 데이터를 정리해 주는 애널리스트다. 아래 규칙을 지켜라.

- 주어진 데이터에 있는 사실만 쓴다. 없는 수치를 지어내지 마라.
- **특정 종목 매수/매도를 권하지 마라.** "무엇을 사라/팔아라"는 쓰지 않는다.
  대신 "무슨 일이 있었고, 돈이 어디로 움직였는가"를 설명한다.
- 한국어로, 군더더기 없이. 아래 4개 항목만 쓴다.

## 오늘 시장 한 줄
(지수 방향과 원인을 한 문장)

## 자금 흐름
(외국인·기관·개인이 어느 시장에서 무엇을 했는지. 코스피와 코스닥이 다르면 그 대비를 짚어라.
기관 세부 주체(금융투자/투신/연기금)에 특징이 있으면 언급한다)

## 주도 섹터
(강한 테마·업종 2~3개와 그 배경. 뉴스 헤드라인에서 근거를 찾아 연결하라)

## 체크포인트
(내일 또는 다음 장에서 확인할 것 2~3개. 데이터에서 읽히는 위험 신호나 확인 필요 사항)`;

export async function getAiSummary(
  client: KiwoomClient,
  opts: { force?: boolean } = {},
): Promise<AiSummary> {
  const now = new Date();
  const key = `${now.toISOString().slice(0, 13)}:${edition(now)}`;

  if (!opts.force && cache && cache.key === key && Date.now() - cache.at < CACHE_TTL_MS) {
    return cache.data;
  }

  const basedOn = now.toISOString();
  if (!isClaudeConfigured()) {
    return {
      text: null,
      basedOn,
      model: "",
      inputTokens: 0,
      outputTokens: 0,
      error: "ANTHROPIC_API_KEY가 설정되지 않았습니다. 설정 화면에서 확인하세요.",
    };
  }

  const digest = await buildDigest(client);
  const prompt = `${SYSTEM_RULES}

지금은 ${now.toLocaleString("ko-KR", { hour12: false })} (${edition(now)}) 기준이다.

=== 시장 데이터 ===
${digest}`;

  const r = await summarize(prompt, 2200);
  const data: AiSummary = {
    text: r.text,
    basedOn,
    model: process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-5",
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    error: r.error,
    digest,
  };

  // 실패한 응답은 캐싱하지 않는다 (다음 요청에서 다시 시도하도록)
  if (r.text) cache = { key, data, at: Date.now() };
  return data;
}
