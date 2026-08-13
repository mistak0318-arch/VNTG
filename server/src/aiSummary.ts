import type { KiwoomClient } from "./kiwoomClient.js";
import { getSection } from "./marketOverview.js";
import type { IndexCard, MarketFlow, StockRow, HighLow } from "./marketOverview.js";
import type { GlobalQuote } from "./globalMarket.js";
import { sectorNews } from "./newsDisclosure.js";
import { upcomingEvents } from "./calendar.js";
import { getTrackedWatchlist } from "./watchTracking.js";
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

  const [idxSec, flowSec, moverSec, hiLoSec, globalSec, drivers, news, events, tracked] =
    await Promise.all([
      getSection("indices", client).catch(() => null),
      getSection("flow", client).catch(() => null),
      getSection("movers", client).catch(() => null),
      getSection("highLow", client).catch(() => null),
      getSection("global", client).catch(() => null),
      buildMarketDrivers(client, { topN: 5 }).catch(() => null),
      sectorNews({ majorOnly: true, perSector: 6, watchNames }).catch(() => null),
      upcomingEvents(7).catch(() => []),
      getTrackedWatchlist(client).catch(() => []),
    ]);

  const lines: string[] = [];

  const indices = (idxSec?.data ?? []) as IndexCard[];
  if (indices.length > 0) {
    lines.push("[지수]");
    for (const i of indices) {
      // 상승/하락 종목 수까지 넣어야 "지수는 올랐는데 개별주는 죽었다"를 판단할 수 있다
      lines.push(
        `${i.name} ${fmt(i.price)} ${pct(i.changeRate)} (상승 ${i.rising} / 하락 ${i.falling} / 상한 ${i.upperLimit} / 하한 ${i.lowerLimit})`,
      );
      // 장중 흐름 — 4개 지점으로 압축해서 "초반 강세 후 밀림" 같은 패턴을 읽게 한다
      if (i.sparkline.length >= 6) {
        const sp = i.sparkline;
        const seg = Math.floor(sp.length / 3);
        const at = (n: number) => sp[Math.min(n, sp.length - 1)];
        lines.push(`  장중: ${fmt(at(0))} → ${fmt(at(seg))} → ${fmt(at(seg * 2))} → ${fmt(sp[sp.length - 1])}`);
      }
    }
  }

  const global = (globalSec?.data ?? []) as GlobalQuote[];
  if (global.length > 0) {
    lines.push("\n[글로벌·원자재·환율]");
    lines.push(
      global.filter((g) => g.changeRate !== null).map((g) => `${g.label} ${pct(g.changeRate as number)}`).join(", "),
    );
  }

  const flow = (flowSec?.data ?? null) as MarketFlow | null;
  if (flow) {
    lines.push("\n[투자자 순매수, 억원]");
    lines.push(`코스피: 외국인 ${fmt(flow.kospi.foreign)} / 기관 ${fmt(flow.kospi.institution)} / 개인 ${fmt(flow.kospi.individual)}`);
    lines.push(`  (기관 세부) 금융투자 ${fmt(flow.kospi.financialInvestment)} / 투신 ${fmt(flow.kospi.investmentTrust)} / 연기금 ${fmt(flow.kospi.pensionFund)} / 사모 ${fmt(flow.kospi.privateFund)} / 보험 ${fmt(flow.kospi.insurance)}`);
    lines.push(`코스닥: 외국인 ${fmt(flow.kosdaq.foreign)} / 기관 ${fmt(flow.kosdaq.institution)} / 개인 ${fmt(flow.kosdaq.individual)}`);
  }

  if (drivers) {
    lines.push("\n[강한 테마]");
    for (const t of drivers.themes.up) {
      const why = t.reasons.length > 0 ? ` ← ${t.reasons[0].title}` : "";
      lines.push(`${t.name} ${pct(t.changeRate)} (${t.mainStock})${why}`);
    }
    lines.push("\n[약한 테마]");
    for (const t of drivers.themes.down) lines.push(`${t.name} ${pct(t.changeRate)}`);
    lines.push("\n[강한 업종]");
    for (const sec of drivers.sectors) lines.push(`${sec.market} ${sec.name} ${pct(sec.changeRate)}`);
  }

  const movers = (moverSec?.data ?? null) as { rising: StockRow[]; falling: StockRow[] } | null;
  if (movers) {
    lines.push("\n[급등 상위]");
    lines.push(movers.rising.slice(0, 8).map((x) => `${x.name} ${pct(x.changeRate)}`).join(", "));
    lines.push("[급락 상위]");
    lines.push(movers.falling.slice(0, 8).map((x) => `${x.name} ${pct(x.changeRate)}`).join(", "));
  }

  const hiLo = (hiLoSec?.data ?? null) as HighLow | null;
  if (hiLo) {
    // 신고가가 많으면 상승이 특정 종목에 그치지 않고 퍼졌다는 뜻
    lines.push("\n[250일 신고가/신저가]");
    lines.push(`신고가 ${hiLo.high.length}종목: ${hiLo.high.slice(0, 6).map((x) => x.name).join(", ")}`);
    lines.push(`신저가 ${hiLo.low.length}종목: ${hiLo.low.slice(0, 6).map((x) => x.name).join(", ")}`);
  }

  // 사용자 자신의 포지션 — 가장 중요한 맥락
  if (tracked.length > 0) {
    lines.push("\n[사용자 관심종목 현황]");
    for (const t of tracked.slice(0, 12)) {
      const ret = t.returnRate === null ? "-" : pct(t.returnRate);
      lines.push(`${t.name} ${pct(t.changeRate)} (편입가 대비 ${ret}) 외인5일 ${fmt(t.foreign5)} / 기관5일 ${fmt(t.inst5)}${t.trendPass ? " 정배열" : ""}`);
    }
  }

  if (events.length > 0) {
    lines.push("\n[다가오는 일정 7일]");
    for (const e of events.slice(0, 8)) lines.push(`${e.date}${e.time ? " " + e.time : ""} ${e.title}`);
  }

  if (news) {
    lines.push("\n[주요 뉴스 헤드라인]");
    for (const sec of news.sectors) {
      const heads = sec.items.slice(0, 4).map((n) => `- ${n.title} (${n.coverage}개 매체)`);
      if (heads.length > 0) lines.push(`<${sec.label}>`, ...heads);
    }
  }

  return lines.join("\n");
}

const SYSTEM_RULES = `너는 한국 주식시장 데이터를 정리해 주는 애널리스트다. 아래 규칙을 지켜라.

- 주어진 데이터에 있는 사실만 쓴다. 없는 수치를 지어내지 마라.
- **특정 종목 매수/매도를 권하지 마라.** "무엇을 사라/팔아라"는 쓰지 않는다.
  대신 "무슨 일이 있었고, 돈이 어디로 움직였는가"를 설명한다.
- 지수 등락만 보지 말고 **상승/하락 종목 수, 신고가 종목 수**로 상승이 퍼진 것인지
  소수 대형주만 끌어올린 것인지 반드시 구분해라.
- **장중 흐름**(4개 지점)이 있으면 초반·중반·후반 중 어디서 힘이 실렸는지 짚어라.
- 한국어로, 군더더기 없이. 아래 5개 항목만 쓴다.

## 오늘 시장 한 줄
(지수 방향과 원인을 한 문장)

## 자금 흐름
(외국인·기관·개인이 어느 시장에서 무엇을 했는지. 코스피와 코스닥 대비를 짚어라.
기관 세부 주체(금융투자/투신/연기금/사모/보험)에 특징이 있으면 언급한다.
환율·글로벌 지표가 수급에 주는 함의가 있으면 함께 쓴다)

## 시장의 폭
(상승 대 하락 종목 수, 신고가/신저가 종목 수로 이 상승(하락)이 얼마나 퍼져 있는지 판단.
지수와 개별주의 온도차가 있으면 반드시 지적한다)

## 주도 섹터
(강한 테마·업종 2~3개와 그 배경. 뉴스 헤드라인에서 근거를 찾아 연결하라.
약한 쪽도 한 줄 언급해 자금이 어디서 어디로 이동했는지 보여라)

## 관심종목 & 체크포인트
(사용자 관심종목이 있으면 그 종목들의 오늘 움직임과 수급을 먼저 정리한다.
이어서 다가오는 일정과 데이터에서 읽히는 확인 사항 2~3개)`;


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
