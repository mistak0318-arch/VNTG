import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateThemes, toCustomThemeDigest } from "./customThemes.js";
import { getTradeStats, toTradeDigest } from "./tradeStats.js";
import { runWebResearch, toResearchDigest } from "./webResearch.js";
import { describeBreadth, listBreadth, toPoints } from "./breadthStore.js";
import { listSectorFlow, toSectorFlowDigest } from "./sectorFlowStore.js";
import { evaluateLinks, toUsKrDigest } from "./usKrLinks.js";
import { getSection } from "./marketOverview.js";
import type { IndexCard, MarketFlow, StockRow, HighLow } from "./marketOverview.js";
import type { GlobalQuote } from "./globalMarket.js";
import { sectorNews } from "./newsDisclosure.js";
import { upcomingEvents } from "./calendar.js";
import { getTrackedWatchlist } from "./watchTracking.js";
import { buildMarketDrivers } from "./reportBuilder.js";
import { isClaudeConfigured, summarize } from "./summarize.js";
import { listWatchlist } from "./watchlist.js";
import { CHECKPOINT_RULE, parseCheckpoints, stripCheckpointSection, type Checkpoint } from "./checkpoints.js";

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
export async function buildDigest(client: KiwoomClient): Promise<string> {
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
  const flowDays = await listSectorFlow(14).catch(() => []);
  const flowDigest = toSectorFlowDigest(flowDays);
  if (flowDigest) lines.push(flowDigest);

  /*
   * 밤사이 미국이 어느 국내 테마로 이어지는지.
   * "나스닥 +0.8%"만 있으면 사람이 머릿속으로 이어야 하는데, 그 연결을 붙여서 준다.
   * 아직 상관계수 검증 전이라 프롬프트에 "가설"이라고 못박아 둔다.
   */
  const usKr = await evaluateLinks(client).then((r) => r.links).catch(() => []);
  const usKrDigest = toUsKrDigest(usKr, { premarket: !traded });
  if (usKrDigest) lines.push(usKrDigest);

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
  const custom = await evaluateThemes(client).catch(() => null);
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

  const movers = (moverSec?.data ?? null) as { rising: StockRow[]; falling: StockRow[] } | null;
  if (movers && traded) {
    lines.push("\n[급등 상위]");
    lines.push(movers.rising.slice(0, 8).map((x) => `${x.name} ${pct(x.changeRate)}`).join(", "));
    lines.push("[급락 상위]");
    lines.push(movers.falling.slice(0, 8).map((x) => `${x.name} ${pct(x.changeRate)}`).join(", "));
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
- 한국어로, 군더더기 없이. 아래 항목만, 이 순서로 쓴다.
- **전체 분량은 한글 1,600~2,200자.** 항목마다 3~5문장.
  데이터가 많아졌으므로 나열하지 말고 **연결해라** — 같은 사실을 두 항목에서 반복하지 마라.

<우선순위>
데이터에 [내가 만든 테마]가 있으면 **그것을 [강한 테마]보다 먼저, 더 비중 있게** 다뤄라.
키움 테마 분류는 참고이고, 사용자가 직접 정의한 테마가 이 사람의 관점이다.
[출처: 인포스탁] 표시가 붙은 테마는 사용자가 만든 것이 아니라 옮겨온 것이므로 보조로만 쓴다.
</우선순위>

<연결>
좋은 리포트는 숫자를 옮겨 적는 게 아니라 **서로 다른 데이터를 잇는 것**이다. 예를 들면:
- 업종별 자금 흐름의 순위 변화 ↔ 그 업종에 속한 내 테마의 등락
- 주체 합의(여러 주체가 같은 방향) ↔ 그 업종이 강한 테마인지
- 미국↔국내 연동의 '덜 반영' ↔ 오늘 국내에서 실제로 그 테마가 어땠는지
- 시장의 폭 ↔ 지수 등락 (지수만 오르고 폭이 좁으면 반드시 지적)
근거가 약하면 억지로 잇지 말고 "연결이 뚜렷하지 않다"고 써라.
</연결>

## 오늘 시장 한 줄
(지수 방향과 원인을 한 문장)

## 자금 흐름
(외국인·기관·개인이 어느 시장에서 무엇을 했는지. 코스피와 코스닥 대비를 짚어라.
**업종별 자금 흐름이 있으면 어느 업종에서 빼서 어디로 넣었는지**를 반드시 쓴다 — 총액만
말하는 것은 의미가 없다. 여러 주체가 같은 방향으로 움직인 업종이 있으면 그것을 앞세워라)

## 내 테마
(사용자가 만든 테마의 오늘 움직임. 강한 것과 약한 것을 나누고, **왜 그렇게 움직였는지**를
업종 자금 흐름·뉴스·미국 연동에서 찾아 붙여라. 내가 만든 테마가 없으면 이 항목을 생략한다)

## 시장의 폭
(상승 대 하락 종목 수, 신고가/신저가 종목 수로 이 상승(하락)이 얼마나 퍼져 있는지 판단.
지수와 개별주의 온도차가 있으면 반드시 지적한다)

## 주도 섹터
(내 테마에서 다루지 않은 강한 테마·업종 2~3개와 그 배경. 뉴스에서 근거를 찾아 연결하라.
약한 쪽도 한 줄 언급해 자금이 어디서 어디로 이동했는지 보여라)

## 관심종목 & 체크포인트
(사용자 관심종목이 있으면 그 종목들의 오늘 움직임과 수급을 먼저 정리한다.
이어서 확인 사항 3~4개. **"무엇을 보면 무엇을 알 수 있는가"** 형태로 구체적으로 써라)
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

## 내 테마 점검
(**이 항목을 먼저 쓴다.** 사용자가 직접 만든 테마 각각에 대해, 간밤 미국·뉴스가
그 테마로 이어지는지 짚어라. '미국↔국내 테마 연동'의 기대치가 있으면 그 숫자를 인용하되
**아직 개장 전이므로 결과가 아니라 기대치임을 분명히** 하라.
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
- 한국어로, 전체 한글 800~1,200자.

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
  const digest = await buildDigest(client);

  /*
   * 우리가 조회한 데이터만 넘기면 우리가 안 받아온 건 AI도 모른다.
   * 웹 검색을 붙여 간밤 미국장과 시장이 주목하는 주제를 직접 확인하게 한다.
   * 검색은 회당 $0.01이라 상한(max_uses)으로 비용을 막는다.
   */
  // 조간은 간밤 해외가 본체인데 우리가 가진 해외 데이터는 지수 몇 개뿐이라 검색을 더 준다
  const research = process.env.RESEARCH_ENABLED === "0"
    ? null
    : await runWebResearch(weekend ? 4 : morning ? 8 : 6).catch(() => null);
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
  const rules = weekend ? WEEKEND_RULES : morning ? MORNING_RULES : SYSTEM_RULES;

  const prompt = `${rules}

지금은 ${now.toLocaleString("ko-KR", { hour12: false })} (${label}) 기준이다.

=== 시장 데이터 ===
${digest}${research ? toResearchDigest(research) : ""}`;

  /*
   * 출력 상한.
   * 항목을 6개로 늘리고 분량을 1,600~2,200자로 올렸더니 4,000 토큰에 걸려 문장이 잘렸다.
   * 한글은 토큰 효율이 나빠 2,200자면 3,000~4,000 토큰을 쓴다 — 여유를 둬야 한다.
   */
  const r = await summarize(prompt, weekend ? 3000 : 7000, "report");

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
