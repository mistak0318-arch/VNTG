/**
 * 교차 자동 편입을 며칠 들고 있나 (2026-08-31).
 *
 * 교차는 단기 신호라 일주일이면 뜻이 다한다. 이보다 오래되고 오늘 다시 안 걸린
 * 것은 관심종목에서 뺀다 — 이력은 맥박 화면이 그날그날 다시 계산한다.
 */
const CROSS_KEEP_DAYS = 7;

import { listBreadth, toPoints, type BreadthPoint } from "./breadthStore.js";
import { evaluateMarket } from "./marketSignal.js";
import { kospi200Futures } from "./kospiFutures.js";
import { rateBoard } from "./rateBoard.js";
import { usMajorIndices } from "./usMajor.js";
import { getGlobalMarket } from "./globalMarket.js";
import type { GlobalQuote } from "./globalMarket.js";
import type { UsMajorRow } from "./usMajor.js";
import { choiceFor } from "./aiConfig.js";
import { summarize } from "./summarize.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getSection } from "./marketOverview.js";
import type { Sectors } from "./marketOverview.js";
import { exportYoyForSector, getTradeStats } from "./tradeStats.js";
import { leaderScan } from "./leaderScan.js";
import { getActiveSuper } from "./superSignal.js";
import { listSectorFlow, SUBJECTS } from "./sectorFlowStore.js";
import { CROSS_GROUP, ensureInGroup, listWatchlist, removeFromGroup } from "./watchlist.js";

/**
 * 시장 맥박 — 「돈이 어디로 가고 있나」를 한 덩어리로 낸다.
 *
 * 다른 화면들은 **무엇이 올랐나**를 본다. 이건 **누가 사고 있고, 그게 이어지고 있고,
 * 바깥에서 무엇이 밀고 있나**를 본다. 오늘 하루 숫자로는 아무 말도 할 수 없으므로
 * 전부 며칠을 겹쳐 본다.
 *
 * ## 왜 판정을 서버에서 하나
 *
 * 화면에서 하면 리포트·텔레그램이 같은 판정을 다시 짜야 한다. 같은 시장을 두고
 * 두 곳이 다른 말을 하면 그때부터 무엇도 못 믿는다. **판정은 한 곳에서만** 한다.
 *
 * ## 여기서 새로 만드는 것
 *
 * 나머지는 이미 있는 모듈을 모으는 것이고, 이 파일이 실제로 만들어 내는 건 셋이다.
 *   1. **자금 국면** — 외인·기관·개인 5일 누적의 조합으로 지금이 어떤 판인지
 *   2. **다이버전스** — 지수는 오르는데 시장 폭이 죽고 있는가 (꼭지에서 늘 먼저 나온다)
 *   3. **지속성** — 방향이 며칠째 이어지고 있는가. 하루짜리는 소음이다
 */

export type PhaseKey =
  | "foreignLed" // 외국인 주도 유입
  | "instLed" // 기관 주도 유입
  | "bothIn" // 외국인·기관 동반 유입 — 가장 강한 판
  | "retailOnly" // 개인만 사는 판 — 대체로 하락 구간이다
  | "bothOut" // 동반 이탈
  | "mixed"; // 방향이 안 잡힘

export interface PulseTurn {
  /** 누적은 유입인데 최근 방향이 반대인가 (또는 그 반대) */
  turning: boolean;
  who: "외국인" | "기관" | "외국인·기관" | null;
  note: string;
}

export interface PulseFlow {
  /** 5일 누적 순매수 (억원) */
  foreign5: number;
  inst5: number;
  individual5: number;
  /** 20일 누적 */
  foreign20: number;
  inst20: number;
  individual20: number;
  /** 외국인이 며칠 연속 순매수(양수) 또는 순매도(음수)인가 */
  foreignStreak: number;
  instStreak: number;
  /**
   * 실제로 계산에 쓴 일수 (2026-08-26 — 재검토 #1 「라벨이 거짓말을 한다」).
   * 폭 데이터가 9일치면 「20일 누적」은 사실 9일 누적이다 — 화면이 이걸로
   * 「20일(9일치)」라고 정직하게 적는다.
   */
  days5: number;
  days20: number;
}

/** 교차 신호 — 주도주 태그 ∩ 슈퍼신호등 (+ 그 업종에 자금이 들어오고 있나) */
export interface PulseCrossStock {
  code: string;
  name: string;
  sector: string;
  /** 주도주 탐색이 붙인 태그 (신고가·거래량급증·급등·대금상위) */
  tags: string[];
  /** 그 업종이 최근 5일 외인+기관 순유입 상위인가 */
  sectorInflow: boolean;
  changeRate: number;
}

export interface PulseCross {
  stocks: PulseCrossStock[];
  note: string;
}

export interface PulseDivergence {
  /** 지수는 오르는데 폭이 죽고 있나 */
  warning: boolean;
  /** 최근 5일 코스피 등락 합계 (%) */
  indexMove: number | null;
  /** 상승종목 비율의 5일 전 대비 변화 (%p) */
  breadthMove: number | null;
  note: string;
}

export interface MarketPulse {
  /** 며칠치가 쌓여 있나 — 이게 적으면 아래 판정은 전부 잠정이다 */
  days: number;
  phase: { key: PhaseKey; label: string; note: string };
  flow: PulseFlow;
  divergence: PulseDivergence;
  /**
   * 방향 전환.
   *
   * 5일 누적만 보면 **이미 돌아선 판을 못 잡는다** — 실제로 외국인 5일 누적이
   * +46,916억인데 최근 이틀은 연속 순매도인 날이 있었다. 누적은 지나간 매수가 만든 것이고
   * 지금 손은 반대로 가고 있다는 뜻이다. 그 어긋남이 곧 변곡점이라 따로 낸다.
   */
  turn: PulseTurn;
  /** 시장 신호등 (기존) */
  signal: { level: string; score: number; summary: string } | null;
  /** 선물 베이시스 — 음수면 프로그램 매도가 붙기 쉽다 */
  basis: number | null;
  /**
   * 베이시스를 못 받았을 때의 설명 (재검토 #1) — null 이 조용히 사라지면
   * 「못 봤다」와 「정상이다」가 구분이 안 된다. 값이 있으면 화면이 한 줄 적는다.
   */
  basisNote: string | null;
  /** 교차 신호 (재검토 #2) — 주도주 태그 ∩ 슈퍼신호등. 없으면 null */
  cross: PulseCross | null;
  /** 위험 신호 모음 — 화면이 색만 칠하지 않고 이유를 말할 수 있게 */
  risks: { key: string; label: string; detail: string; level: "warn" | "danger" }[];
  /** 바깥에서 미는 것 — 미장·금리·환율에서 고른 몇 줄 */
  external: { label: string; value: string; changeRate: number | null; note?: string }[];
  at: string;
}

const PHASE_LABEL: Record<PhaseKey, { label: string; note: string }> = {
  bothIn: {
    label: "외국인·기관 동반 유입",
    note: "둘이 같이 사는 판이다. 지수가 밀려도 되돌림이 짧은 구간이 많다",
  },
  foreignLed: {
    label: "외국인 주도",
    note: "외국인이 끌고 간다. 환율과 미국 지수에 더 민감해진다",
  },
  instLed: {
    label: "기관 주도",
    note: "기관이 끌고 간다. 외국인이 붙는지를 확인해야 힘이 이어진다",
  },
  retailOnly: {
    label: "개인 홀로 매수",
    note: "외국인·기관이 파는 걸 개인이 받는 판이다. 반등이 짧게 끝나는 구간이 많다",
  },
  bothOut: {
    label: "동반 이탈",
    note: "외국인·기관이 같이 판다. 현금 비중을 생각할 자리다",
  },
  mixed: { label: "방향 혼조", note: "주체별로 엇갈린다. 며칠 더 봐야 방향이 잡힌다" },
};

function sum(points: BreadthPoint[], key: "foreign" | "institution" | "individual"): number {
  return points.reduce((s, p) => s + (p[key] ?? 0), 0);
}

/** 최신부터 같은 부호가 몇 번 이어지나. 순매수면 양수, 순매도면 음수로 돌려준다 */
function streak(points: BreadthPoint[], key: "foreign" | "institution"): number {
  if (points.length === 0) return 0;
  const desc = [...points].reverse();
  const first = desc[0][key] ?? 0;
  if (first === 0) return 0;
  const positive = first > 0;
  let n = 0;
  for (const p of desc) {
    const v = p[key] ?? 0;
    if (v === 0 || v > 0 !== positive) break;
    n += 1;
  }
  return positive ? n : -n;
}

function decidePhase(f: number, i: number, r: number): PhaseKey {
  // 억원 단위. 잔돈으로 방향을 말하면 안 되므로 문턱을 둔다
  const T = 1000;
  const fIn = f > T;
  const iIn = i > T;
  const fOut = f < -T;
  const iOut = i < -T;
  if (fIn && iIn) return "bothIn";
  if (fOut && iOut) return r > T ? "retailOnly" : "bothOut";
  if (fIn && !iIn) return "foreignLed";
  if (iIn && !fIn) return "instLed";
  return "mixed";
}

/**
 * 지수와 시장 폭의 어긋남.
 *
 * 꼭지에서 늘 먼저 나오는 신호다 — 지수는 대형주 몇 개로 버티는데 **오르는 종목 수는 줄고 있는**
 * 상태. 지수만 보면 멀쩡해 보이므로 숫자로 잡아 줘야 한다.
 */
function findDivergence(points: BreadthPoint[]): PulseDivergence {
  if (points.length < 6) {
    return {
      warning: false,
      indexMove: null,
      breadthMove: null,
      note: "며칠 더 쌓여야 판단할 수 있습니다",
    };
  }
  const recent = points.slice(-5);
  const indexMove = recent.reduce((s, p) => s + (p.kospiRate ?? 0), 0);
  const breadthMove = (recent[recent.length - 1].risingPct ?? 0) - (points[points.length - 6].risingPct ?? 0);
  // 지수는 올랐는데 상승 종목 비율이 눈에 띄게 줄었으면 경고
  const warning = indexMove > 0.5 && breadthMove < -8;
  return {
    warning,
    indexMove,
    breadthMove,
    note: warning
      ? "지수는 올랐는데 오르는 종목 수는 줄었습니다. 몇몇 대형주가 지수를 들고 있는 모양입니다"
      : indexMove < -0.5 && breadthMove > 8
        ? "지수는 밀렸는데 오르는 종목은 늘었습니다. 바닥에서 자주 나오는 모양입니다"
        : "지수와 시장 폭이 같은 방향입니다",
  };
}

/**
 * 누적과 최근 방향의 어긋남.
 *
 * 누적이 플러스인데 며칠째 팔고 있으면 **유입이 끝나 가는 것**이고,
 * 누적이 마이너스인데 며칠째 사고 있으면 **바닥에서 손이 바뀌는 것**이다.
 * 둘 다 국면 이름만으로는 안 보인다.
 */
function findTurn(flow: PulseFlow): PulseTurn {
  const flip = (sum: number, streak: number) =>
    // 이틀 이상 이어져야 방향으로 친다. 하루짜리는 소음이다
    Math.abs(streak) >= 2 && Math.abs(sum) > 1000 && sum > 0 !== streak > 0;
  const f = flip(flow.foreign5, flow.foreignStreak);
  const i = flip(flow.inst5, flow.instStreak);
  if (!f && !i) return { turning: false, who: null, note: "누적과 최근 방향이 같습니다" };

  const who = f && i ? "외국인·기관" : f ? "외국인" : "기관";
  const cooling = f ? flow.foreign5 > 0 : flow.inst5 > 0;
  return {
    turning: true,
    who,
    note: cooling
      ? `${who}이 5일 누적으로는 순매수지만 최근 며칠은 팔고 있습니다. 유입이 식는 자리입니다`
      : `${who}이 5일 누적으로는 순매도지만 최근 며칠은 사고 있습니다. 손이 바뀌는 자리일 수 있습니다`,
  };
}

/**
 * 교차 신호 (2026-08-26, 재검토 #2) — **세 화면이 동시에 가리키는 종목.**
 *
 * 주도주 탐색의 태그와 슈퍼신호등 목록, 업종 자금 유입은 각자 딴 화면에 있어서
 * 같은 종목이 셋 다에 걸려도 사람이 오가며 눈으로 맞춰야 했다. 그 교집합이
 * 가장 강한 시그널인데 아무도 안 세고 있었다 — 서버가 여기서 센다.
 *
 * 주도주 스캔은 조회 4묶음이라 맥박 캐시(60초)보다 길게, 5분에 한 번만 돈다.
 */
const CROSS_TTL_MS = 5 * 60_000;
let crossCache: { at: number; data: PulseCross | null } | null = null;

async function findCross(client: KiwoomClient): Promise<PulseCross | null> {
  if (crossCache && Date.now() - crossCache.at < CROSS_TTL_MS) return crossCache.data;
  try {
    const [scan, superList, flowDays] = await Promise.all([
      leaderScan(client),
      getActiveSuper(),
      listSectorFlow(5).catch(() => []),
    ]);
    const superCodes = new Set(superList.map((s) => s.code));

    /*
     * 자금 유입 업종 — 최근 5일 외인+기관 순매수 합이 플러스인 업종 이름.
     * SUBJECTS 순서(foreign=0, institution=1)가 저장 스키마다.
     */
    const fi = SUBJECTS.indexOf("foreign");
    const ii = SUBJECTS.indexOf("institution");
    const inflow = new Map<string, number>();
    for (const day of flowDays) {
      for (const row of [...day.kospi, ...day.kosdaq]) {
        inflow.set(row.name, (inflow.get(row.name) ?? 0) + (row.v[fi] ?? 0) + (row.v[ii] ?? 0));
      }
    }
    const norm = (s: string) => s.replace(/[^가-힣a-zA-Z0-9]/g, "");
    const inflowNames = new Set(
      [...inflow.entries()].filter(([, v]) => v > 0).map(([name]) => norm(name)),
    );

    const hits = scan.stocks.filter((s) => superCodes.has(s.code)).slice(0, 8);
    const stocks: PulseCrossStock[] = hits.map((s) => ({
      code: s.code,
      name: s.name,
      sector: s.sector,
      tags: s.tags,
      sectorInflow:
        s.sector.length > 0 &&
        [...inflowNames].some((n) => n.includes(norm(s.sector)) || norm(s.sector).includes(n)),
      changeRate: s.changeRate,
    }));

    /*
     * 교차 종목 자동 편입 (2026-08-26 사용자 요청) — 관심 그룹 「슈퍼신호등+교차」.
     * 세 화면이 동시에 가리킨 종목이 그 뒤로 어떻게 갔는지 **추적할 수 있어야** 한다.
     * ensureInGroup 이라 이미 담긴 종목은 그룹만 붙고 편입가·메모는 안 건드린다.
     */
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    for (const s of hits) {
      await ensureInGroup(
        {
          code: s.code,
          name: s.name,
          addedPrice: s.price,
          memo: `교차 신호 자동 편입 (${today} · ${s.tags.join("·")})`,
        },
        CROSS_GROUP,
      ).catch(() => undefined);
    }

    /*
     * **오래된 교차는 뺀다** (2026-08-31 점검에서 드러남).
     *
     * 담기는 길만 있고 빠지는 길이 없어서 나흘치 18종목이 쌓여 있었다.
     * 교차는 「그날 세 화면이 동시에 가리킨 것」이라 **단기 신호**인데,
     * 한 번 걸리면 영영 남아 관심종목이 늘기만 했다.
     *
     * ⚠️ **오늘 걸린 것만 남기지는 않는다.** 하루 안 걸렸다고 빼면 들락날락하고,
     * 무엇보다 개장 전에는 거래대금이 0이라 hits 가 통째로 비는 날이 있다
     * (그때 전부 빼 버리면 그날 관심종목이 텅 빈다). **담긴 지 오래된 것만** 뺀다.
     *
     * ⚠️ hits 가 0 이면 아무것도 안 한다 — 못 잰 것을 「없다」로 읽지 않는다.
     */
    if (hits.length > 0) {
      const cutoff = new Date(Date.now() + 9 * 3600_000 - CROSS_KEEP_DAYS * 86400_000)
        .toISOString()
        .slice(0, 10);
      const fresh = new Set(hits.map((h) => h.code));
      for (const w of await listWatchlist().catch(() => [])) {
        if (!w.groups.includes(CROSS_GROUP)) continue;
        if (fresh.has(w.code)) continue; // 오늘도 걸렸다
        if ((w.addedAt ?? "").slice(0, 10) > cutoff) continue; // 아직 신선하다
        await removeFromGroup(w.code, CROSS_GROUP).catch(() => undefined);
      }
    }

    /*
     * ⚠️ **「겹치는 게 없다」와 「아직 못 잰다」를 갈라 말한다** (2026-08-31).
     *
     * 장 전에는 거래대금이 전부 0이라 주도주가 0종목으로 나온다. 그러면 교집합도
     * 당연히 0인데, 예전엔 그것을 「겹치는 종목이 없습니다」라고 적었다 — 마치
     * 오늘은 그런 종목이 없다고 판단한 것처럼 읽힌다. **조간 리포트가 07시에
     * 만들어지므로 그 문장이 매일 아침 나갔다.**
     */
    const data: PulseCross | null =
      stocks.length === 0
        ? {
            stocks: [],
            note: scan.noTrade
              ? "아직 오늘 거래가 없어 주도주를 못 가렸습니다 — 장이 열린 뒤에 채워집니다"
              : scan.stocks.length === 0
                ? "오늘 주도주 조건(신고가·거래량 급증·급등)에 걸린 종목이 아직 없습니다"
                : "주도주 태그와 슈퍼신호등이 겹치는 종목이 지금은 없습니다",
          }
        : {
            stocks,
            note:
              `주도주 태그와 슈퍼신호등에 동시에 걸린 종목 ${stocks.length}개` +
              (stocks.some((s) => s.sectorInflow)
                ? ` — 그중 ${stocks.filter((s) => s.sectorInflow).length}개는 업종 자금도 유입 중`
                : ""),
          };
    crossCache = { at: Date.now(), data };
    return data;
  } catch {
    // 교차 신호가 없어도 맥박은 나가야 한다
    crossCache = { at: Date.now(), data: null };
    return null;
  }
}

/**
 * 수출↔업종 어긋남 (재검토 #4) — 「실물이 꺾였는데 주가만 오르는」 업종.
 *
 * exportYoyForSector(관세청 최신월 YoY)는 이미 있는데 어디에도 안 얹혀 있었다.
 * 오늘 +1% 넘게 오른 업종 중 수출 YoY 가 -5% 이하인 것을 경고로 만든다.
 * (월별 데이터라 「2개월 연속」 판정은 품목별 이력 조회가 더 필요해 다음 단계로 —
 * 우선 최신월 뚜렷한 마이너스만 잡는다)
 */
async function exportMismatch(
  client: KiwoomClient,
): Promise<{ sector: string; market: string; changeRate: number; yoy: number }[]> {
  try {
    const [sectorSec, trade] = await Promise.all([
      getSection("sectors", client).catch(() => null),
      getTradeStats().catch(() => null),
    ]);
    const sectors = (sectorSec?.data ?? null) as Sectors | null;
    if (!sectors || !trade || trade.items.length === 0) return [];

    const out: { sector: string; market: string; changeRate: number; yoy: number }[] = [];
    const check = (rows: { name: string; changeRate: number }[], market: string) => {
      for (const s of rows) {
        if (s.changeRate < 1) continue; // 오늘 뚜렷이 오른 업종만
        const yoy = exportYoyForSector(trade.items, s.name);
        if (yoy !== null && yoy <= -5) {
          out.push({ sector: s.name, market, changeRate: s.changeRate, yoy });
        }
      }
    };
    check(sectors.kospi ?? [], "코스피");
    check(sectors.kosdaq ?? [], "코스닥");
    // 경고는 둘까지 — 셋 넘게 쏟아지면 아무것도 안 읽힌다
    return out.sort((a, b) => a.yoy - b.yoy).slice(0, 2);
  } catch {
    return [];
  }
}

const TTL_MS = 60_000;
let cache: { at: number; data: MarketPulse } | null = null;

export async function marketPulse(client: KiwoomClient, force = false): Promise<MarketPulse> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const [points, signal, futures, rates, usMajor, global] = await Promise.all([
    listBreadth()
      .then(toPoints)
      .catch(() => [] as BreadthPoint[]),
    evaluateMarket(client).catch(() => null),
    kospi200Futures().catch(() => null),
    rateBoard().catch(() => []),
    usMajorIndices().catch(() => null),
    getGlobalMarket().catch(() => []),
  ]);

  const last5 = points.slice(-5);
  const last20 = points.slice(-20);
  const flow: PulseFlow = {
    foreign5: Math.round(sum(last5, "foreign")),
    inst5: Math.round(sum(last5, "institution")),
    individual5: Math.round(sum(last5, "individual")),
    foreign20: Math.round(sum(last20, "foreign")),
    inst20: Math.round(sum(last20, "institution")),
    individual20: Math.round(sum(last20, "individual")),
    foreignStreak: streak(points, "foreign"),
    instStreak: streak(points, "institution"),
    // 라벨 정직화 — 「20일 누적」이 실제 며칠치인지
    days5: last5.length,
    days20: last20.length,
  };

  const key = decidePhase(flow.foreign5, flow.inst5, flow.individual5);
  const divergence = findDivergence(points);
  const turn = findTurn(flow);

  /*
   * 위험 신호.
   *
   * 색만 칠하면 왜 빨간지 모른다. **무엇이 왜 위험한지**를 문장으로 같이 낸다 —
   * 이 화면은 판단을 돕는 자리이지 점수를 매기는 자리가 아니다.
   */
  const risks: MarketPulse["risks"] = [];
  if (turn.turning) {
    risks.push({ key: "turn", label: `${turn.who} 방향 전환`, detail: turn.note, level: "warn" });
  }
  if (divergence.warning) {
    risks.push({
      key: "divergence",
      label: "지수·폭 어긋남",
      detail: divergence.note,
      level: "warn",
    });
  }
  if (flow.foreignStreak <= -3) {
    risks.push({
      key: "foreignOut",
      label: "외국인 연속 매도",
      detail: `${Math.abs(flow.foreignStreak)}거래일 연속 순매도입니다`,
      level: flow.foreignStreak <= -5 ? "danger" : "warn",
    });
  }
  const basis = futures?.basis ?? null;
  if (basis !== null && basis < 0) {
    risks.push({
      key: "backwardation",
      label: "백워데이션",
      detail: `선물이 현물보다 ${Math.abs(basis).toFixed(2)} 낮습니다. 프로그램 매도가 붙기 쉬운 자리입니다`,
      level: basis < -1 ? "danger" : "warn",
    });
  }
  /* basis 를 못 받은 날 — 「못 봤다」와 「정상」을 가른다 (재검토 #1) */
  const basisNote =
    basis === null
      ? "선물 값이 없어(장 마감 뒤 등) 백워데이션 위험은 이번엔 판단하지 못했습니다"
      : null;

  /* 수출↔업종 어긋남 (재검토 #4) — 실물이 꺾였는데 업종 주가만 오르면 경고 */
  for (const m of await exportMismatch(client)) {
    risks.push({
      key: `trade-${m.sector}`,
      label: "수출·주가 어긋남",
      detail:
        `${m.market} ${m.sector} 이(가) 오늘 +${m.changeRate.toFixed(1)}% 인데 ` +
        `관련 수출은 최신월 전년동월 ${m.yoy.toFixed(1)}% 입니다. 실물이 안 받쳐 주는 상승일 수 있습니다`,
      level: "warn",
    });
  }

  /* 교차 신호 (재검토 #2) — 주도주 ∩ 슈퍼신호등 */
  const cross = await findCross(client);
  // 미장 쪽 경고는 이미 usMajor 가 줄 단위로 판정해 둔 것을 그대로 쓴다
  for (const row of usMajor?.rows ?? []) {
    if (row.signal?.level === "danger") {
      risks.push({
        key: `us-${row.key}`,
        label: row.label,
        detail: row.signal.why,
        level: "danger",
      });
    }
  }
  if (usMajor?.curveNote) {
    risks.push({
      key: "curve",
      label: "장단기 금리 역전",
      detail: usMajor.curveNote,
      level: "danger",
    });
  }

  /*
   * 바깥에서 미는 것.
   *
   * 전부 나열하면 스무 줄이라 못 읽는다. 국내 자금에 실제로 영향을 주는 것만 고른다 —
   * 환율(외국인 매매의 전제), 미국 선물(개장가의 예고), 반도체(우리 지수의 절반),
   * 미국 10년물(할인율), 일본 10년물(엔 캐리).
   */
  const pick = (label: string, from: UsMajorRow[]) => from.find((x) => x.label === label);
  const external: MarketPulse["external"] = [];
  const g = (label: string): GlobalQuote | undefined => global.find((x) => x.label === label);
  const usd = g("달러/원");
  if (usd) {
    external.push({
      label: "달러/원",
      value: usd.price?.toFixed(2) ?? "-",
      changeRate: usd.changeRate,
      note: "오르면 외국인이 팔 이유가 하나 늘어난다",
    });
  }
  for (const name of ["US 500", "US Tech 100"]) {
    const row = g(name);
    if (row) {
      external.push({
        label: row.label,
        value: row.price?.toLocaleString("ko-KR") ?? "-",
        changeRate: row.changeRate,
        note: "지금 움직이는 값이라 개장가의 예고편이다",
      });
    }
  }
  const sox = pick("필라델피아 반도체", usMajor?.rows ?? []);
  if (sox) {
    external.push({
      label: "필라델피아 반도체",
      value: sox.price?.toLocaleString("ko-KR") ?? "-",
      changeRate: sox.changeRate,
      note: "우리 지수의 절반이 여기에 묶여 있다",
    });
  }
  for (const name of ["미국 10년", "일본 10년"]) {
    const row = rates.find((x) => x.name === name);
    if (row) {
      external.push({
        label: row.name,
        value: row.rate === null ? "-" : `${row.rate.toFixed(3)}%`,
        // 금리는 등락률이 아니라 %p 로 읽어야 한다. 화면이 그렇게 쓰도록 null 로 둔다
        changeRate: null,
        note:
          row.change === null
            ? undefined
            : `전일대비 ${row.change > 0 ? "+" : ""}${row.change.toFixed(3)}%p`,
      });
    }
  }

  const data: MarketPulse = {
    days: points.length,
    phase: { key, ...PHASE_LABEL[key] },
    flow,
    divergence,
    turn,
    signal: signal
      ? { level: signal.level, score: signal.score, summary: signal.summary }
      : null,
    basis,
    basisNote,
    cross,
    risks,
    external,
    at: new Date().toISOString(),
  };
  cache = { at: Date.now(), data };
  return data;
}

/* ------------------------------------------------------------------ */
/* AI 한 줄 판독                                                        */
/* ------------------------------------------------------------------ */

/**
 * 맥박을 문장으로 바꾼다.
 *
 * **숫자를 다시 읽어 주는 요약은 쓸모가 없다.** "외국인 5일 +1.2조" 는 이미 화면에 있다.
 * 여기서 원하는 건 **그 숫자들이 겹쳐서 무슨 뜻인지** — 어느 쪽으로 돈이 옮겨가고 있고,
 * 그 판단이 깨지는 조건이 무엇인지다.
 *
 * 그래서 프롬프트가 세 가지를 강제한다.
 *   · 숫자 나열 금지
 *   · **틀릴 조건**을 반드시 적을 것 (이게 없으면 나중에 복기가 안 된다)
 *   · 모르면 모른다고 할 것 — 며칠치가 모자라면 그렇게 말해야 한다
 *
 * 입력이 작아서(숫자 몇십 줄) 리포트보다 훨씬 싸다. 그래도 화면을 열 때마다 부르면
 * 돈이 새므로 **10분 캐시**를 둔다.
 */

export interface PulseBrief {
  text: string | null;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  at: string;
  error: string | null;
}

const BRIEF_TTL_MS = 10 * 60_000;
let briefCache: { at: number; key: string; data: PulseBrief } | null = null;

function pulsePrompt(p: MarketPulse): string {
  const won = (v: number) => `${v > 0 ? "+" : ""}${v.toLocaleString("ko-KR")}억`;
  const lines = [
    `[자금 국면] ${p.phase.label}`,
    `[누적 순매수] 5일(${p.flow.days5}일치) — 외국인 ${won(p.flow.foreign5)} / 기관 ${won(p.flow.inst5)} / 개인 ${won(p.flow.individual5)}`,
    `             20일(${p.flow.days20}일치) — 외국인 ${won(p.flow.foreign20)} / 기관 ${won(p.flow.inst20)} / 개인 ${won(p.flow.individual20)}`,
    p.cross && p.cross.stocks.length > 0
      ? `[교차 신호] ${p.cross.note} — ${p.cross.stocks.map((s) => `${s.name}(${s.tags.join("·")}${s.sectorInflow ? "·업종유입" : ""})`).join(", ")}`
      : "",
    `[연속성] 외국인 ${p.flow.foreignStreak >= 0 ? `${p.flow.foreignStreak}일 연속 순매수` : `${-p.flow.foreignStreak}일 연속 순매도`} · 기관 ${p.flow.instStreak >= 0 ? `${p.flow.instStreak}일 순매수` : `${-p.flow.instStreak}일 순매도`}`,
    p.turn.turning ? `[방향 전환] ${p.turn.note}` : "",
    `[지수·폭] ${p.divergence.note}${p.divergence.indexMove !== null ? ` (5일 지수 ${p.divergence.indexMove.toFixed(2)}%, 상승비율 변화 ${p.divergence.breadthMove?.toFixed(0)}%p)` : ""}`,
    p.basis !== null ? `[선물 베이시스] ${p.basis.toFixed(2)}` : p.basisNote ? `[선물 베이시스] ${p.basisNote}` : "",
    p.signal ? `[시장 신호등] ${p.signal.level} ${p.signal.score}점 — ${p.signal.summary}` : "",
    p.risks.length > 0
      ? `[위험]\n${p.risks.map((r) => `  · ${r.label}: ${r.detail}`).join("\n")}`
      : "[위험] 눈에 띄는 것 없음",
    `[바깥]\n${p.external.map((e) => `  · ${e.label} ${e.value}${e.changeRate !== null ? ` (${e.changeRate > 0 ? "+" : ""}${e.changeRate.toFixed(2)}%)` : ""}${e.note ? ` — ${e.note}` : ""}`).join("\n")}`,
    `[쌓인 일수] ${p.days}일`,
  ].filter(Boolean);

  return `너는 한국 주식시장의 자금 흐름을 읽는 사람이다. 아래는 오늘의 지표다.

${lines.join("\n")}

이걸 보고 **돈이 어디로 옮겨가고 있는지**를 판단해라. 규칙:

1. **숫자를 다시 읽어 주지 마라.** 위 숫자는 화면에 이미 있다. 숫자가 겹쳐서 무슨 뜻인지를 써라.
2. 세 부분으로 쓴다:
   - **지금 판** (2~3문장): 어떤 자금 국면이고 왜 그렇게 보는지
   - **볼 것** (2~3문장): 이 판이 이어질지 꺾일지가 무엇에 달려 있는지
   - **틀릴 조건** (1~2문장): 어떤 일이 생기면 위 판단이 무너지는지. **반드시 구체적인 지표와 값으로.**
3. 쌓인 일수가 10일 미만이면 판단이 잠정임을 첫 줄에 밝혀라.
4. 모르면 모른다고 해라. 없는 근거를 지어내지 마라.
5. 매수·매도를 권하지 마라. 이건 판단을 돕는 자리이지 지시하는 자리가 아니다.
6. 전체 600자 이내. 마크다운 굵게(**) 는 써도 된다.`;
}

export async function pulseBrief(client: KiwoomClient, force = false): Promise<PulseBrief> {
  const p = await marketPulse(client, force);
  // 국면·위험이 그대로면 다시 부를 이유가 없다. 숫자만 조금 움직인 걸로는 판단이 안 바뀐다
  const key = `${p.phase.key}|${p.risks.map((r) => r.key).join(",")}|${p.divergence.warning}`;
  if (!force && briefCache && briefCache.key === key && Date.now() - briefCache.at < BRIEF_TTL_MS) {
    return briefCache.data;
  }

  /*
   * 모델을 따로 안 정했으면 **리포트 모델을 따라간다.**
   *
   * 예전엔 안 정하면 Claude 로 떨어졌는데, Claude 키가 한도에 걸려 있으면
   * 이 화면만 통째로 죽었다 — 정작 리포트는 Gemini 로 잘 돌고 있는데도 그랬다.
   * 같은 성격의 일이므로 이미 고른 것을 쓰는 게 맞다. 따로 정하면 그게 우선한다.
   */
  const purpose = (await choiceFor("pulse")) ? "pulse" : "report";
  const r = await summarize(pulsePrompt(p), 700, purpose);
  const data: PulseBrief = {
    text: r.text,
    model: r.usedModel ?? null,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    at: new Date().toISOString(),
    error: r.error ?? null,
  };
  briefCache = { at: Date.now(), key, data };
  return data;
}
