import type { KiwoomClient } from "./kiwoomClient.js";
import { usMajorIndices } from "./usMajor.js";
import { evaluateThemes, listThemes, toCustomThemeDigest } from "./customThemes.js";
import { getTradeStats, toTradeDigest } from "./tradeStats.js";
import { peekWebResearch, runWebResearch, toResearchDigest } from "./webResearch.js";
import { describeBreadth, listBreadth, toPoints } from "./breadthStore.js";
import { listSectorFlow, toSectorFlowDigest } from "./sectorFlowStore.js";
import { evaluateMarket, toMarketSignalDigest } from "./marketSignal.js";
import { listSuperSignal } from "./superSignal.js";
import { mainNews } from "./naverMainNews.js";
import { getSection } from "./marketOverview.js";
import type { IndexCard, MarketFlow, StockRow, HighLow } from "./marketOverview.js";
import type { GlobalQuote } from "./globalMarket.js";
import { sectorNews } from "./newsDisclosure.js";
import { upcomingEvents } from "./calendar.js";
import { todayDartEvents, toDartDigest } from "./dartEvents.js";
import { getTrackedWatchlist } from "./watchTracking.js";
import { buildMarketDrivers } from "./reportBuilder.js";
import { isClaudeConfigured, summarize } from "./summarize.js";
import { listWatchlist } from "./watchlist.js";
import {
  CHECKPOINT_RULE,
  checkpointRule,
  parseCheckpoints,
  stripCheckpointSection,
  type Checkpoint,
} from "./checkpoints.js";
import { noopProgress, type ProgressReporter } from "./reportProgress.js";

/**
 * 데일리 리포트 최상단의 "AI 정리".
 *
 * 원칙 두 가지:
 *  1) **토큰을 아낀다.** 원본 JSON을 통째로 넣지 않고 숫자와 제목만 추려서 텍스트로 만든다.
 *     기사 본문은 절대 넣지 않는다 (저작권 + 토큰 낭비).
 *  2) **매매 추천을 시키지 않는다.** 이 앱은 조회 전용이고, 사실 정리와 자금 흐름 해석까지만 맡긴다.
 *     "무엇을 사라"가 아니라 "무슨 일이 있었고 돈이 어디로 움직였나"를 요구한다.
 */

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
  /**
   * 며칠 뒤 실제 결과와 대조할 예측.
   * 본문에서 뽑아 구조화해 둔다 — 자유 텍스트로 두면 기계가 채점할 수 없다.
   */
  checkpoints?: Checkpoint[];
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
/**
 * 오늘 장이 이미 열렸는가.
 *
 * 키움은 장 시작 전에도 응답을 주는데, 등락률·상승종목수가 전부 0으로 온다.
 * 그걸 그대로 넘기면 AI가 "오늘 상승 0 / 하락 0"을 사실로 읽고
 * **"데이터가 없어 판단 불가"라는 문장을 성실하게 써낸다.** 실제로 조간 리포트의
 * 한 섹션이 통째로 그 말로 채워졌다.
 *
 * 그래서 시각으로 짐작하지 않고 **받은 데이터로 판정한다** — 지수가 전부 0이면
 * 아직 거래가 없는 것이다. 공휴일에도 자동으로 맞는다.
 */
function hasTradedToday(indices: IndexCard[]): boolean {
  if (indices.length === 0) return false;
  return indices.some((i) => i.changeRate !== 0 || i.rising > 0 || i.falling > 0);
}

/** 시황 질문하기(askMarket)도 같은 다이제스트를 쓴다 */
export async function buildDigest(
  client: KiwoomClient,
  progress: ProgressReporter = noopProgress,
): Promise<string> {
  progress.start("market");
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

  progress.done("market", `지수 ${(idxSec?.data as unknown[] | undefined)?.length ?? 0}건`);
  // 뉴스도 위 Promise.all 에서 같이 받아 왔다. 따로 돌지 않으므로 여기서 닫는다
  progress.done("news", news ? `${news.sectors.length}개 분야` : "없음");

  const lines: string[] = [];

  const indices = (idxSec?.data ?? []) as IndexCard[];
  const traded = hasTradedToday(indices);

  if (indices.length > 0) {
    if (traded) {
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
    } else {
      /*
       * 아직 거래 전. 등락률·상승종목수는 전부 0이라 넘겨봐야 해가 되므로 종가만 준다.
       * "오늘 데이터가 없다"는 사실을 프롬프트가 아니라 여기서 확실히 못박아야
       * AI가 0을 사실로 오해하지 않는다.
       */
      lines.push("[지수 — 직전 거래일 종가. 오늘은 아직 거래 전이라 당일 등락 데이터가 없다]");
      for (const i of indices) lines.push(`${i.name} ${fmt(i.price)}`);
      lines.push(
        "※ 오늘의 상승/하락 종목 수, 신고가/신저가는 존재하지 않는다.",
        "  그 항목들을 언급하거나 '데이터가 없어 판단 불가'라고 쓰지 마라. 아예 다루지 마라.",
        "※ 아래 국내 테마·수급 등락률은 전부 직전 거래일 값이다. 인용할 때마다 '전일'임을 밝혀라.",
      );
    }
  }

  const global = (globalSec?.data ?? []) as GlobalQuote[];
  if (global.length > 0) {
    lines.push("\n[글로벌·원자재·환율]");
    lines.push(
      global.filter((g) => g.changeRate !== null).map((g) => `${g.label} ${pct(g.changeRate as number)}`).join(", "),
    );
  }

  /*
   * 밤사이 미국 마감과 코스피 야간선물.
   *
   * 위 [글로벌] 은 **지수선물**이라 우리 시간 낮에도 움직인다. 그런데 조간에 답해야 할
   * 질문은 "밤사이 무슨 일이 있었나"이고, 그 답은 **미국 현물 마감값**과
   * **코스피 야간선물**이다 — 야간선물은 그 결과를 한국 지수로 환산해 준 값이라
   * 오늘 개장가의 예고편이다. 둘 다 지금까지 요약 입력에 없었다.
   *
   * 몇 줄이라 토큰 부담이 거의 없다.
   */
  try {
    const um = await usMajorIndices();
    if (um.nightFutures) {
      lines.push("\n[코스피 야간선물 — 미국장 시간대에 움직인 값. 오늘 개장가의 예고편]");
      lines.push(
        `${um.nightFutures.price?.toFixed(2)} (${pct(um.nightFutures.changeRate ?? 0)})`,
      );
    }
    const rows = um.rows.filter((r) => r.price !== null);
    if (rows.length > 0) {
      lines.push("\n[미국 전일 마감 — 현물 지수·금리·유가]");
      lines.push(
        rows
          .map((r) => `${r.label} ${r.price}${r.isRate ? "%" : ""} (${pct(r.changeRate ?? 0)})`)
          .join(", "),
      );
    }
  } catch {
    // 이 블록이 없어도 요약은 나온다
  }

  const flow = (flowSec?.data ?? null) as MarketFlow | null;
  if (flow && traded) {
    lines.push("\n[투자자 순매수, 억원]");
    lines.push(`코스피: 외국인 ${fmt(flow.kospi.foreign)} / 기관 ${fmt(flow.kospi.institution)} / 개인 ${fmt(flow.kospi.individual)}`);
    lines.push(`  (기관 세부) 금융투자 ${fmt(flow.kospi.financialInvestment)} / 투신 ${fmt(flow.kospi.investmentTrust)} / 연기금 ${fmt(flow.kospi.pensionFund)} / 사모 ${fmt(flow.kospi.privateFund)} / 보험 ${fmt(flow.kospi.insurance)}`);
    lines.push(`코스닥: 외국인 ${fmt(flow.kosdaq.foreign)} / 기관 ${fmt(flow.kosdaq.institution)} / 개인 ${fmt(flow.kosdaq.individual)}`);
  }

  /**
   * 총액 다음에 바로 업종별 이동을 붙인다.
   * "외국인 +2.3조"만 있으면 규모밖에 모르지만, 어느 업종에서 빼서 어디로 넣었는지가 붙으면
   * 같은 총액도 완전히 다르게 읽힌다.
   */
  progress.start("sector");
  const flowDays = await listSectorFlow(14).catch(() => []);
  const flowDigest = toSectorFlowDigest(flowDays);
  if (flowDigest) lines.push(flowDigest);
  progress.done("sector", `${flowDays.length}일 누적`);

  /*
   * 시장 전체 신호등. 개별 수치보다 먼저 "지금이 살 자리인가"를 한 줄로 준다.
   * 아래 항목들이 전부 이 판정의 근거이므로 여기 놓아야 읽는 순서가 맞다.
   */
  progress.start("signal");
  const marketSig = await evaluateMarket(client).catch(() => null);
  if (marketSig) {
    const sigDigest = toMarketSignalDigest(marketSig);
    if (sigDigest) lines.push(sigDigest);
  }
  progress.done("signal", marketSig ? `${marketSig.level} ${marketSig.score}점` : "판정 불가");

  /*
   * 슈퍼신호등 (2026-08-26 전면 개편) — **이 시스템의 핵심 관찰 대상**을 리포트 한가운데로.
   *
   * 일곱 목록 교집합에 걸린 초록을 매일 편입해 따라가는 목록이다. 리포트가 이걸 모르면
   * 「시스템이 지금 무엇을 가리키는가」를 말할 수 없다. 편입 시점 대비 수익·점수 변화·
   * 오늘의 편입/이탈, 그리고 체계 자체의 성적(5·20일 평균과 승률)까지 넘긴다.
   *
   * (같은 자리에 있던 미국↔국내 테마 연동은 뺐다 — 화면에서도 숨긴 안 쓰는 기능이었다)
   */
  progress.start("super");
  try {
    const sup = await listSuperSignal(client);
    const act = sup.entries.filter((e) => e.active !== false);
    const todayKst = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const newly = sup.entries.filter((e) => e.addedDate === todayKst);
    const exitedToday = sup.entries.filter(
      (e) => e.active === false && (e.exits ?? []).some((x) => x.date === todayKst),
    );
    if (act.length + newly.length + exitedToday.length > 0) {
      lines.push("\n[슈퍼신호등 — 거래대금·등락률·외국인 연속매수 등 일곱 목록의 교집합에 걸린 초록 신호등 종목. 이 시스템의 핵심 관찰 목록]");
      const head: string[] = [`추적 ${act.length}종목`];
      if (newly.length > 0) head.push(`오늘 신규 편입: ${newly.map((e) => e.name).join(", ")}`);
      if (exitedToday.length > 0) head.push(`오늘 이탈: ${exitedToday.map((e) => e.name).join(", ")}`);
      lines.push(head.join(" · "));
      for (const e of act.slice(0, 10)) {
        const daily = e.daily ?? [];
        const nowScore = daily.length > 0 ? daily[daily.length - 1].score : null;
        const scoreTxt =
          nowScore !== null && nowScore !== e.score
            ? `${e.score}점→지금 ${nowScore}점`
            : `${e.score}점`;
        lines.push(
          `${e.name}: ${e.addedDate} 편입(${scoreTxt}) · 목록 ${e.lists.length}곳 · ${e.seenCount}일째 · 편입가 대비 ${e.sinceAdded === null ? "-" : pct(e.sinceAdded)}`,
        );
      }
      const g = sup.grade.find((x) => x.label === "전체");
      if (g && (g.d5.n > 0 || g.d20.n > 0)) {
        lines.push(
          `체계 성적: 편입 5일 뒤 평균 ${g.d5.avg === null ? "-" : pct(g.d5.avg)} (${g.d5.n}건, 승률 ${sup.stats.win.d5.rate === null ? "-" : `${sup.stats.win.d5.rate.toFixed(0)}%`}) · 20일 뒤 ${g.d20.avg === null ? "-" : pct(g.d20.avg)} (${g.d20.n}건)`,
        );
      }
    }
    progress.done("super", `추적 ${act.length}종목`);
  } catch {
    progress.skip("super", "없음");
  }

  /*
   * 내가 만든 테마를 **키움 테마보다 먼저** 넣는다.
   *
   * 이게 이 기능의 본체다 — 키움 분류는 시장의 현재 관심사를 못 따라가고, 무엇보다
   * 내가 보는 관점이 아니다. 그런데 지금까지 `toCustomThemeDigest` 는 import 만 되어 있고
   * **호출된 적이 없었다.** 설계만 하고 배선이 빠진 채로 계속 발행돼서, 리포트에 내 테마가
   * 한 번도 들어가지 않았다.
   *
   * 개장 전에도 **넣는다.** 전에는 "스냅샷이 전부 0"이라고 보고 건너뛰었는데, 스냅샷은
   * 다음 개장까지 유지되므로 조간 시각에는 직전 거래일 종가와 실제 등락률을 이미 갖고 있다.
   * 데이터가 있는데 안 쓰고 있었던 것이다. (0짜리로 덮이는 경로는 marketSnapshot 에서 막았고,
   * 그래도 0이면 snap.traded 가 false 로 와서 아래에서 걸러진다)
   *
   * 다만 기준일이 다르므로 헤더에 "직전 거래일 종가 기준"을 못박아 넘긴다.
   */
  progress.start("theme");
  const custom = await evaluateThemes(client).catch(() => null);
  progress.done("theme", custom ? `테마 ${custom.themes.length}개` : "없음");
  if (custom?.traded) {
    // traded 는 지수 기준(오늘 거래 여부), custom.traded 는 스냅샷 기준(값이 살아 있는지)
    const customDigest = toCustomThemeDigest(custom.themes, { previousClose: !traded });
    if (customDigest) lines.push(customDigest);
  }

  // 테마·급등락·신고저는 전부 "당일" 값이라 거래 전에는 0이다. 넣으면 해만 된다.
  if (drivers && traded) {
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

  /*
   * 수출입 동향 (2026-08-26 개편) — toTradeDigest 는 지금까지 **import 만 되고 한 번도
   * 불린 적이 없었다.** 관세청 월별 실측이 리포트에 안 들어가고 있던 것이다.
   * 월 단위 데이터라 매일 같은 값이지만, 그 해석(어느 업종의 실물이 좋아지고 있나)은
   * 시세·수급과 붙여 읽을 때 값이 있다 — 반복 서술은 프롬프트 규칙으로 막는다.
   */
  progress.start("trade");
  const trade = await getTradeStats().catch(() => null);
  const tradeDigest = trade && trade.items.length > 0 ? toTradeDigest(trade.items) : "";
  if (tradeDigest) lines.push(tradeDigest);
  progress.done("trade", trade?.items.length ? `${trade.items.length}품목` : "없음");

  const movers = (moverSec?.data ?? null) as { rising: StockRow[]; falling: StockRow[] } | null;
  if (movers && traded) {
    lines.push("\n[급등 상위]");
    lines.push(movers.rising.slice(0, 5).map((x) => `${x.name} ${pct(x.changeRate)}`).join(", "));
    lines.push("[급락 상위]");
    lines.push(movers.falling.slice(0, 5).map((x) => `${x.name} ${pct(x.changeRate)}`).join(", "));
  }

  const hiLo = (hiLoSec?.data ?? null) as HighLow | null;
  if (hiLo && traded) {
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

  /*
   * 네이버 금융 첫 화면의 주요 뉴스 (2026-08-26 개편) — 뉴스 수집이 커지면서
   * 「지금 시장이 크게 보고 있는 기사」를 따로 받게 됐다. 분야별 헤드라인과 성격이
   * 다르다: 이건 편집자가 고른 오늘의 핵심이다.
   */
  try {
    const main = await mainNews(8);
    if (main.length > 0) {
      lines.push("\n[주요 뉴스 — 네이버 금융 첫 화면]");
      for (const m of main) lines.push(`- ${m.title} (${m.press})`);
    }
  } catch {
    /* 없어도 분야별 헤드라인이 있다 */
  }

  if (news) {
    lines.push("\n[분야별 뉴스 헤드라인]");
    for (const sec of news.sectors) {
      const heads = sec.items.slice(0, 3).map((n) => `- ${n.title} (${n.coverage}개 매체)`);
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
- 한국어로, 군더더기 없이. 아래 항목만, 이 순서로 쓴다.
- **한글·숫자·기본 문장부호만 써라.** 일본어·한자를 섞지 마라 — 실제 발행분에
  「시장の 폭」이 나간 적이 있다. 섹션 제목은 아래 틀의 표기 그대로 쓴다.
- 금액은 **조·억으로 끊어 써라** — 「1조 1,635억 원」이지 「11,635억 원」이 아니다.
  1조 미만이면 억으로만 쓴다.
- **분량 제한은 반드시 지켜라. 항목마다 최대 5문장, 전체 한글 2,600자를 넘기지 마라.**
  넘길 것 같으면 항목을 줄이지 말고 **문장을 줄여라.** 마지막 체크포인트 구획까지
  반드시 다 쓰고 끝내야 한다 — 중간에 잘리면 그 리포트는 쓸 수 없다.
  데이터가 많아졌으므로 나열하지 말고 **연결해라** — 같은 사실을 두 항목에서 반복하지 마라.
- 수치를 그대로 옮겨 적지 마라. 표에 있는 숫자는 화면에 이미 있다.
  **그 숫자가 무엇을 뜻하는지**만 쓴다.

<우선순위>
이 리포트의 중심축은 둘이다: **[슈퍼신호등]과 [내가 만든 테마].**
슈퍼신호등은 이 시스템이 기계적으로 골라 따라가는 종목들이고, 내 테마는 사용자의 관점이다.
데이터에 이 둘이 있으면 다른 어떤 항목보다 비중 있게 다뤄라.
키움 테마 분류는 참고이고, [출처: 인포스탁] 표시가 붙은 테마는 보조로만 쓴다.
</우선순위>

<연결>
좋은 리포트는 숫자를 옮겨 적는 게 아니라 **서로 다른 데이터를 잇는 것**이다. 예를 들면:
- 업종별 자금 흐름의 순위 변화 ↔ 그 업종에 속한 내 테마·슈퍼신호등 종목의 등락
- 주체 합의(여러 주체가 같은 방향) ↔ 그 업종이 강한 테마인지
- 슈퍼신호등 편입 종목의 업종 ↔ 오늘 그 업종의 수급·수출입 실물
- 수출입 증감률 ↔ 그 업종 시세가 실물을 따라가는지 앞서가는지
- 시장의 폭 ↔ 지수 등락 (지수만 오르고 폭이 좁으면 반드시 지적)
근거가 약하면 억지로 잇지 말고 "연결이 뚜렷하지 않다"고 써라.
</연결>

## 오늘 시장 한 줄
(지수 방향과 원인을 한 문장)

## 자금 흐름
(외국인·기관·개인이 어느 시장에서 무엇을 했는지. 코스피와 코스닥 대비를 짚어라.
**업종별 자금 흐름이 있으면 어느 업종에서 빼서 어디로 넣었는지**를 반드시 쓴다 — 총액만
말하는 것은 의미가 없다. 여러 주체가 같은 방향으로 움직인 업종이 있으면 그것을 앞세워라)

## 슈퍼신호등
(데이터에 [슈퍼신호등]이 있으면 **반드시 이 항목을 쓴다.** 오늘 신규 편입·이탈이 있으면
그것부터 — 어떤 종목이 왜 걸렸을지(업종·수급·뉴스에서 근거를 찾아라). 이어서 추적 중
종목들이 편입 시점 대비 어떤지, 점수가 오르는 쪽인지 꺾이는 쪽인지 흐름을 짚어라.
체계 성적(5·20일 평균/승률)이 있으면 지금 이 목록을 얼마나 신뢰할 수 있는지 한 줄로.
데이터에 [슈퍼신호등]이 없으면 이 항목을 생략한다)

## 내 테마
(사용자가 만든 테마의 오늘 움직임. 강한 것과 약한 것을 나누고, **왜 그렇게 움직였는지**를
업종 자금 흐름·뉴스에서 찾아 붙여라. 내가 만든 테마가 없으면 이 항목을 생략한다)

## 시장의 폭
(상승 대 하락 종목 수, 신고가/신저가 종목 수로 이 상승(하락)이 얼마나 퍼져 있는지 판단.
지수와 개별주의 온도차가 있으면 반드시 지적한다)

## 주도 섹터와 실물
(내 테마에서 다루지 않은 강한 테마·업종 2~3개와 그 배경. 뉴스에서 근거를 찾아 연결하라.
약한 쪽도 한 줄 언급해 자금이 어디서 어디로 이동했는지 보여라.
[수출입 동향]이 있으면 **증감이 두드러진 품목만** 골라 관련 업종 시세와 잇는다 — 월별
데이터라 매일 같은 값이니, 시세와의 연결이 새로울 때만 쓰고 아니면 언급하지 마라)

## 관심종목 & 체크포인트
(사용자 관심종목이 있으면 그 종목들의 오늘 움직임과 수급을 먼저 정리한다.
이어서 확인 사항 3~4개. **"무엇을 보면 무엇을 알 수 있는가"** 형태로 구체적으로 써라.
슈퍼신호등 종목에 대한 확인 사항이 있으면 우선한다)
${CHECKPOINT_RULE}`;


/**
 * 조간 규칙.
 *
 * 조간은 07시, **장이 열리기 두 시간 전**에 나간다. 그런데 평일 틀을 그대로 쓰면
 * "오늘 상승/하락 종목 수"를 다루려다 전부 0이라 "판단 불가"만 늘어놓게 된다.
 * 실제로 그렇게 나갔다 — 다섯 섹션 중 하나가 통째로 그 말이었다.
 *
 * 개장 전에 알고 싶은 건 딱 셋이다.
 *   간밤 해외에서 무슨 일이 있었나 / 그게 오늘 우리 장에 뭘 의미하나 / 오늘 뭘 봐야 하나
 * 그래서 항목을 그 셋으로 갈아끼우고, 오늘 시세를 말하지 말라고 명시한다.
 */
const MORNING_RULES = `너는 한국 주식시장 개장 전 브리핑을 쓰는 애널리스트다.

**지금은 장이 열리기 전이다.** 따라서:
- **오늘의 지수 등락, 상승/하락 종목 수, 신고가/신저가는 존재하지 않는다.**
  그 항목을 언급하지도, "데이터가 없어 판단할 수 없다"고 쓰지도 마라. 아예 다루지 마라.
- 데이터에 있는 국내 테마·수급 등락률은 **전부 직전 거래일 값이다.** 써도 되지만
  인용할 때마다 **"전일"** 또는 **"직전 거래일"** 임을 반드시 밝혀라.
  오늘의 결과인 것처럼 쓰면 안 된다.
- 간밤 해외 시장과 뉴스가 이 브리핑의 본체다. 거기에 지면을 써라.
- 주어진 데이터에 있는 사실만 쓴다. 없는 수치를 지어내지 마라.
- **특정 종목 매수/매도를 권하지 마라.** 목표주가를 제시하지 마라.
- 한국어로, 전체 한글 1,300~1,800자.

## 간밤 해외
(미국·유럽·아시아 지수와 그 원인. 유가·금리·환율에 특징이 있으면 함께.
어떤 업종·테마가 움직였는지까지 짚어라 — 그게 오늘 우리 장의 출발점이다)

## 슈퍼신호등 점검
(데이터에 [슈퍼신호등]이 있으면 쓴다. 추적 중 종목 각각에 대해 간밤 해외·뉴스에서
관련 재료가 있으면 짚어라 — 이 목록이 시스템이 기계적으로 골라 둔 오늘의 관찰 대상이다.
편입가 대비 수익률을 인용할 땐 "전일 종가 기준"임을 밝혀라. 재료가 없는 종목은
나열하지 말고 "특이 재료 없음" 한 줄로 접어라. 없으면 이 항목을 생략한다)

## 내 테마 점검
(사용자가 직접 만든 테마 각각에 대해, 간밤 미국·뉴스가 그 테마로 이어지는지 짚어라.
테마의 등락률을 인용할 땐 반드시 "전일" 이라고 밝혀라 — 오늘 값이 아니다.
간밤 재료가 없는 테마는 굳이 언급하지 마라. 내가 만든 테마가 없으면 이 항목을 생략한다)

## 오늘 국내 시장에 주는 함의
(간밤 해외 흐름이 어느 업종·테마로 연결되는지. 전일 수급 흐름이 이어질지 끊길지의 근거.
연결이 약하면 약하다고 쓰고 억지로 이어붙이지 마라)

## 관심종목 체크
(사용자 관심종목 각각에 대해 간밤 해외·뉴스에서 관련된 것이 있으면 짚는다.
전일 수급과 편입가 대비 수익률을 함께. 관련 소식이 없는 종목은 굳이 언급하지 마라)

## 오늘 확인할 것
(다가오는 일정과 뉴스에서 나오는 확인 사항 3~4개.
"무엇을 보면 무엇을 알 수 있는가" 형태로 구체적으로 써라.
예: "개장 후 외국인이 전기전자에서 순매수를 이어가는지 — 끊기면 전일 급등이 일회성")
${CHECKPOINT_RULE}`;

/**
 * 주말판 규칙.
 *
 * 장이 안 열렸으므로 지수·수급·장중흐름을 말할 게 없다. 그런데도 평일 틀을 그대로 쓰면
 * 모델이 어제 숫자를 오늘 일처럼 쓰게 된다 — 그게 제일 위험하다.
 * 그래서 항목 자체를 뉴스 중심으로 갈아끼우고, 시세 얘기를 하지 말라고 명시한다.
 */
const WEEKEND_RULES = `너는 한국 주식시장 뉴스를 정리해 주는 애널리스트다.

**오늘은 주말이라 장이 열리지 않았다.** 따라서:
- 지수 등락, 투자자 수급, 장중 흐름을 이야기하지 마라. 그 숫자들은 직전 거래일 값이다.
- 시세 수치를 인용해야 한다면 반드시 "직전 거래일 기준"임을 밝혀라.
- 주어진 데이터에 있는 사실만 쓴다. 없는 것을 지어내지 마라.
- **특정 종목 매수/매도를 권하지 마라.**
- **분량 제한을 반드시 지켜라. 전체 한글 800~1,200자를 넘기지 마라.**
  넘길 것 같으면 항목을 줄이지 말고 **문장을 줄여라.** 마지막 체크포인트 구획까지
  반드시 다 쓰고 끝내야 한다 — 중간에 잘리면 그 리포트는 쓸 수 없다.
- 수치를 그대로 옮겨 적지 마라. 표에 있는 숫자는 화면에 이미 있다.

## 주말 헤드라인
(주말 사이 나온 뉴스 중 다음 거래일에 영향이 있을 만한 것 3~4개. 왜 중요한지 한 줄씩)

## 관심종목 소식
(사용자 관심종목이 언급된 뉴스만. 없으면 "관심종목 관련 소식 없음"이라고 쓴다)

## 다음 주 확인할 것
(다가오는 일정과 뉴스에서 읽히는 체크포인트 2~3개)
${CHECKPOINT_RULE}`;

/**
 * AI 요약을 새로 만든다. **발행 시각에만 호출된다** (reportScheduler).
 * 화면이 열릴 때마다 부르면 비용이 예측 불가능해지고 같은 판인데 내용이 달라진다.
 */
export async function buildAiSummary(
  client: KiwoomClient,
  editionKey?: string,
  progress: ProgressReporter = noopProgress,
): Promise<AiSummary> {
  const now = new Date();
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

  /*
   * editionKey 로 받던 것을 kind 로 바꿨다. 사용자가 판을 직접 만들 수 있게 되면서
   * id("pre-open" 같은)로는 어떤 프롬프트를 쓸지 알 수 없기 때문이다.
   * 예전 id 들도 그대로 동작하도록 같은 이름을 kind 로 쓴다.
   */
  const weekend = editionKey === "weekend";
  const morning = editionKey === "morning";
  const digest = await buildDigest(client, progress);

  /*
   * 우리가 조회한 데이터만 넘기면 우리가 안 받아온 건 AI도 모른다.
   * 웹 검색을 붙여 간밤 미국장과 시장이 주목하는 주제를 직접 확인하게 한다.
   * 검색은 회당 $0.01이라 상한(max_uses)으로 비용을 막는다.
   */
  /*
   * 검색 횟수를 줄였다 (조간 8→5 / 장중·석간 6→3 / 주말 4→2).
   *
   * 검색 한 번은 $0.01 이지만 진짜 비용은 토큰이다. 검색 결과가 대화에 쌓이고 매 턴
   * 재전송되므로 **횟수를 줄이면 입력 토큰이 그보다 빠르게 준다.** 실측으로 이 호출
   * 하나가 입력 96,000 토큰을 썼다.
   *
   * 조간에만 넉넉히 준다 — 간밤 해외가 본체인데 우리가 가진 해외 데이터는 지수 몇 개뿐이다.
   * 장중·석간은 국내 시세가 이미 손에 있으므로 검색이 덜 아쉽다.
   */
  const searchBudget = weekend ? 2 : morning ? 5 : 3;
  let research = null as Awaited<ReturnType<typeof runWebResearch>> | null;
  if (process.env.RESEARCH_ENABLED === "0") {
    progress.skip("research", "꺼져 있음");
  } else {
    progress.start("research");
    /*
     * **기다리지 않는다.** 앞의 여섯 단계는 10초 안에 끝나는데 이것 하나가 몇 분을
     * 잡아먹어서, 발행 전체가 멈춘 것처럼 보였다. 있는 것만 쓰고 없으면 뒤에서
     * 채우기 시작한 뒤 이번 판은 리서치 없이 낸다.
     */
    research = peekWebResearch(searchBudget);
    if (research) progress.done("research", research.cached ? "직전 결과 재사용 (비용 0)" : `검색 ${research.searchCount}회`);
    else progress.skip("research", "준비 중 — 이번 판은 없이 냅니다 (다음 판에 반영)");
  }
  const label = editionKey
    ? {
        morning: "조간(장 시작 전)",
        midday: "장중",
        closing: "석간(장 마감 후)",
        weekend: "주말(휴장)",
      }[editionKey] ?? edition(now)
    : edition(now);

  /*
   * 판마다 알고 싶은 게 다르다.
   *   조간 — 간밤 해외와 오늘 볼 것 (오늘 시세는 아직 없다)
   *   장중·석간 — 오늘 실제로 무슨 일이 있었나
   *   주말 — 뉴스만
   * 하나의 틀로 세 판을 다 쓰면 조간이 "데이터 없음"으로 채워진다.
   */
  const baseRules = weekend ? WEEKEND_RULES : morning ? MORNING_RULES : SYSTEM_RULES;

  /*
   * 테마 체크포인트는 **「내 테마」 이름만** 쓰게 한다.
   *
   * 예전엔 AI 가 본문에 나온 아무 테마나 찍었는데, 채점은 그 이름을 「내 테마」에서 찾아
   * 하므로 목록에 없으면 **영원히 채점 불가**로 남았다. 목록을 주면 채점도 되고,
   * 무엇보다 **내가 짜 둔 분류로** 예측하게 된다 — 남의 테마 이름으로 맞았다 틀렸다
   * 해 봐야 내 판단에 쌓이지 않는다.
   */
  let themeNames: string[] = [];
  try {
    themeNames = (await listThemes()).map((t) => t.name).filter(Boolean);
  } catch {
    // 못 읽어도 리포트는 나간다 — 그때는 테마 예측을 안 쓰게 된다
  }
  const rules = baseRules.replace(CHECKPOINT_RULE, checkpointRule(themeNames));

  const prompt = `${rules}

지금은 ${now.toLocaleString("ko-KR", { hour12: false })} (${label}) 기준이다.

=== 시장 데이터 ===
${digest}${research ? toResearchDigest(research) : ""}`;

  /*
   * 출력 상한.
   * 항목을 6개로 늘리고 분량을 1,600~2,200자로 올렸더니 4,000 토큰에 걸려 문장이 잘렸다.
   * 한글은 토큰 효율이 나빠 2,200자면 3,000~4,000 토큰을 쓴다 — 여유를 둬야 한다.
   */
  progress.start("ai");
    /*
   * 주말판 상한을 3,000 → 4,500 으로. 800~1,200자를 요구하는데 3,000 토큰에 걸려
   * 체크포인트 구획이 통째로 잘렸다. 프롬프트로 분량을 조이되 상한도 조금 여유를 준다 —
   * 잘린 리포트는 복기에 쓸 수 없어서 그게 더 비싸다.
   */
  const r = await summarize(prompt, weekend ? 4500 : 7000, "report");
  if (r.error) progress.fail("ai", r.error);
  else progress.done("ai", `${r.outputTokens.toLocaleString("ko-KR")} 토큰 생성`);

  /*
   * 체크포인트를 본문에서 뽑아 구조화해 저장한다.
   * 본문에서는 걷어낸다 — 화면과 텔레그램에서는 표로 따로 보여주는 게 읽기 낫고,
   * 그대로 두면 형식 문자열이 그대로 노출된다.
   */
  const checkpoints = r.text ? parseCheckpoints(r.text) : [];
  return {
    text: r.text ? stripCheckpointSection(r.text) : r.text,
    checkpoints,
    basedOn,
    model: r.usedModel || process.env.CLAUDE_MODEL?.trim() || "claude-sonnet-5",
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    error: r.error,
    digest,
  };
}
