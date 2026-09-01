import { loadCloses } from "./dailyCloses.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { getCommonStockCodes } from "./stockListCache.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { MA_PERIODS, type Feat } from "./signalSamples.js";
import { getConfig, type SignalConfig } from "./signalLight.js";

/**
 * **전종목 모집단** (2026-09-01) — 조회 0회로 2,400여 종목을 훑어 후보를 세운다.
 *
 * ## 왜 필요한가
 *
 * 벤티지: "전체종목 훑는거지? 다?"
 *
 * 아니었다. 모집단이 전부 **순위 조회**로 만들어져 있었다 — 거래대금 상위 500,
 * 등락률 상위 500. 그래서 **거래대금 500위 밖은 아예 안 보였다.** 실측에서 가장
 * 잘 통한 것이 「시가총액 3천억 이하 소형주」(장세를 안 가리고 승률 +7.6·+8.1%p)
 * 인데, 정작 그런 종목들이 거래대금 순위에서는 아래쪽에 있다. 우리가 제일 좋다고
 * 잰 것을 우리 모집단이 걸러 내고 있었던 셈이다.
 *
 * ## 어떻게 조회 0회인가
 *
 * 두 창고가 이미 전종목을 들고 있다:
 *
 *   `dailyCloses`     2,444종목 × 400일 **종가** (5.2MB)
 *   `marketSnapshot`  종목별 현재가 · 등락률 · 거래대금 · **시가총액** · 시장
 *
 * 종가만 있으므로 **못 내는 것이 있다** — 위쪽 매물(`over`)과 거래량 기반 지표는
 * 고가·저가·거래량이 필요하다. 거래대금은 스냅샷에서 온다.
 *
 * ## 사전 점수의 한계 — 반드시 알고 써야 한다
 *
 * 여기서 매기는 점수는 **일봉으로 낼 수 있는 기준만**으로 낸 것이다. 수급·재무·
 * 목표가는 전부 `null` 이라 채점에서 빠진다. 즉 **추세가 좋은 종목이 위로 온다.**
 *
 * 그래서 이것은 「좋은 종목 목록」이 아니라 **「본격적으로 볼 만한 후보」**다.
 * 여기서 상위 N 을 뽑아 그 N 에만 수급·재무를 조회한다. 수급이 훌륭한데 추세가
 * 밋밋한 종목은 이 문에서 걸린다 — 그건 이 방식의 대가이고, 숨기지 않는다.
 *
 * (커버리지 규칙과 헷갈리면 안 된다. `minCoverage` 는 **덜 잰 점수로 초록을 주지
 * 않겠다**는 것이고, 여기 사전 점수는 애초에 **줄 세우기용**이라 초록을 안 만든다.)
 */

/** 후보 한 줄 — `signalScreen.Candidate` 와 같은 모양 */
export interface AllStockRow {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  marketCap: number | null;
  /** 일봉으로만 낸 사전 점수 (0~100) — 줄 세우기용이다 */
  preScore: number;
  /** 그 점수를 몇 개 기준으로 냈나 — 적으면 그만큼 못 믿는다 */
  measured: number;
}

function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const w = closes.slice(-n);
  return w.reduce((a, b) => a + b, 0) / n;
}

/**
 * 종가 배열로 `Feat` 을 만든다 — **낼 수 없는 칸은 null 이다.**
 *
 * ⚠️ 「모른다」를 0 으로 만들지 않는다. 0 으로 채우면 그 기준이 「최악」으로 채점돼
 * 종목이 통째로 아래로 밀린다 — 실제로는 그냥 못 잰 것뿐인데.
 */
function featFromCloses(
  closes: number[],
  snap: { price: number; tradeValue: number | null; marketCap: number | null },
  theme: number | null,
  etfBack: number | null,
): Feat | null {
  if (closes.length < 65) return null; // 60일 지표를 내려면 그만큼은 있어야 한다
  const cur = closes[closes.length - 1];
  if (!(cur > 0)) return null;

  /* 60일 신고가 — **오늘을 뺀** 직전 60봉의 최고가와 견준다 */
  const win60 = closes.slice(-61, -1);
  const hi60 = win60.length > 0 ? Math.max(...win60) : 0;
  const m20 = sma(closes, 20);
  const m5 = sma(closes, 5);

  return {
    cur,
    ma: MA_PERIODS.map((p) => sma(closes, p)),
    hiPct: hi60 > 0 ? (cur / hi60) * 100 : null,
    disp: m20 ? Math.max(0, ((cur - m20) / m20) * 100) : null,
    ma5Gap: m5 ? Math.max(0, ((cur - m5) / m5) * 100) : null,
    /* 고가·저가·거래량이 없으면 못 낸다 — 일봉 캐시는 종가만 들고 있다 */
    over: null,
    volEok: snap.tradeValue,
    theme,
    etfBack,
    /* 수급은 종목당 조회다 — 여기서는 없다 */
    fgn5: null,
    fgn10: null,
    fgn20: null,
    fgn60: null,
    inst5: null,
    inst10: null,
    inst20: null,
    inst60: null,
    smart5: null,
    smart20: null,
    smart60: null,
    fgnStreak: null,
    profitYoY: null,
    /* 분기 실적은 종목당 조회다 — 전종목 사전훑기에서는 안 쓴다 */
    qStreak: null,
    qYoY: null,
    qQoQ: null,
    qMargin: null,
    mktCap: snap.marketCap,
    short5: null,
    short20: null,
    loan: null,
    loanUp20: null,
    fgnRatio: null,
    fgnRatioUp20: null,
    rateBeta: null,
  };
}

/**
 * ## 사전 점수 — **신호등 설정을 안 쓴다.** 여기가 이 파일에서 가장 중요한 판단이다.
 *
 * 처음엔 켜진 신호등 기준으로 채점했다. 그런데 실제로 재 보니 **11개 중 3개만
 * 잴 수 있었다** — 신고가 · 시가총액 · 대형주. 나머지는 전부 수급·재무라 조회가
 * 필요하다. 그리고 그 셋 중 **둘이 시가총액**이라 점수를 시총이 지배했고,
 * 삼성전자·SK하이닉스가 위로 올라왔다 — **우리 실측(소형주가 가장 좋다)과 정반대**다.
 *
 * 약세장에서는 더 나쁘다. 신고가와 대형주가 강세장 전용이라 꺼지면서 **시가총액
 * 하나로 2,400종목을 줄 세우게 된다.** 그건 줄 세우기가 아니다.
 *
 * 그래서 **일봉으로 낼 수 있는 것만으로 된 고정 세트**를 쓴다. 신호등에서 꺼진
 * 기준이라도 여기서는 쓴다 — 정배열은 일봉으로 공짜인데 「좋은 후보 고르기」에는
 * 분명히 쓸모가 있다. 대신 **이건 신호등 점수가 아니다.** 화면이 그렇게 적는다.
 */

/** 0~100 으로 자른다 */
const clamp = (v: number) => Math.max(0, Math.min(100, v));

/** 문턱에서 0점, 만점선에서 100점. 문턱이 더 크면 방향이 뒤집힌다 */
function ramp(v: number, at0: number, at100: number): number {
  if (at100 === at0) return v >= at100 ? 100 : 0;
  return clamp(((v - at0) / (at100 - at0)) * 100);
}

export interface PreCheck {
  label: string;
  score: number;
  weight: number;
}

/**
 * 일봉·스냅샷만으로 내는 사전 점수.
 *
 * 무게는 실측에서 나온 힘 순서를 따른다 — **시가총액이 가장 셌다**(장세를 안
 * 가리고 양쪽 승률 +7.6·+8.1%p). 나머지는 추세 모양이라 무게를 낮게 준다.
 */
function preChecks(f: Feat, closes: number[], cfg: SignalConfig): PreCheck[] {
  const out: PreCheck[] = [];

  /* ① 정배열 — 설정한 이동평균선 순서대로 놓였나. 신호등에서 꺼져 있어도 쓴다 */
  const periods: readonly number[] = MA_PERIODS;
  const lines = cfg.maLines.filter((n) => periods.includes(n));
  if (lines.length >= 2) {
    const vals = lines.map((n) => f.ma[periods.indexOf(n)]);
    if (vals.every((v) => v !== null && v > 0)) {
      let ok = f.cur >= (vals[0] as number);
      for (let i = 0; i + 1 < vals.length && ok; i++) {
        ok = (vals[i] as number) >= (vals[i + 1] as number);
      }
      out.push({ label: "정배열", score: ok ? 100 : 0, weight: 2 });
    }
  }

  /* ② 60일 고점 대비 위치 — 100 이 신고가 */
  if (f.hiPct !== null) out.push({ label: "고점 대비", score: ramp(f.hiPct, 70, 100), weight: 2 });

  /* ③ 20일선 이격 — **과열은 감점**이다. 25% 이상 떠 있으면 0점 */
  if (f.disp !== null) out.push({ label: "과열 아님", score: ramp(f.disp, 25, 5), weight: 1 });

  /*
   * ④ **시가총액 U자** — 실측 그대로다.
   *
   * 3천억 이하(+8.1/+7.6)와 10조 이상(강세 +3.9)이 좋고 **가운데가 골짜기**다.
   * 신호등은 이걸 기준 둘(`marketCap`·`largeCap`)로 쪼개 표현하는데, 여기서는
   * 한 곡선으로 낸다 — 사전 점수는 축이 없어서 둘로 나누면 그냥 두 배로 셀 뿐이다.
   */
  if (f.mktCap !== null && f.mktCap > 0) {
    const cap = f.mktCap;
    const small = ramp(cap, 10000, 2000); // 1조에서 0점 → 2천억에서 100점
    const huge = ramp(cap, 30000, 300000); // 3조에서 0점 → 30조에서 100점
    out.push({ label: "규모(U자)", score: Math.max(small, huge), weight: 3 });
  }

  /*
   * ⑤ **위쪽 매물 근사** — 일봉 캐시에 거래량이 없어서 날짜 비중으로 센다.
   *
   * ⚠️ 신호등의 `overhead` 와 **정의가 다르다.** 저쪽은 「위에서 거래된 거래량의
   * 몫」이고 여기는 「위에서 끝난 날의 몫」이다. 근사이므로 사전 점수 안에서만
   * 쓰고, 본격 평가에서는 진짜 값이 다시 매겨진다.
   */
  const win = closes.slice(-120);
  if (win.length >= 60) {
    const above = win.filter((c) => c > f.cur).length;
    out.push({ label: "매물 가벼움", score: ramp((above / win.length) * 100, 70, 10), weight: 1 });
  }

  return out;
}

function preScore(f: Feat, closes: number[], cfg: SignalConfig): { score: number; measured: number } {
  const cs = preChecks(f, closes, cfg);
  const w = cs.reduce((s, c) => s + c.weight, 0);
  if (w === 0) return { score: 0, measured: 0 };
  return {
    score: Math.round(cs.reduce((s, c) => s + c.score * c.weight, 0) / w),
    measured: cs.length,
  };
}

/**
 * 전종목을 훑어 상위 `limit` 을 돌려준다. **키움을 한 번도 안 부른다**(스냅샷이
 * 이미 있으면; 없으면 스냅샷 만드는 비용은 다른 화면과 공유한다).
 *
 * @param market 000 전체 · 001 코스피 · 101 코스닥
 * @param minValue 최소 거래대금(억). **못 사는 종목을 후보에 넣지 않는다** —
 *                 신호가 맞아도 하루 3억 도는 종목은 들어갈 수가 없다
 */
export async function allStocksUniverse(
  client: KiwoomClient,
  market: string,
  limit: number,
  minValue = 10,
  lenses?: {
    /** 종목 → 그날 테마 가중 등락률 */
    theme?: Map<string, number>;
    /** 종목 → ETF 뒷배 등락률 */
    etf?: Map<string, number>;
  },
): Promise<{ rows: AllStockRow[]; scanned: number; skippedThin: number }> {
  const [{ closes }, snap, cfg] = await Promise.all([
    loadCloses(),
    getMarketSnapshot(client),
    getConfig(),
  ]);

  /* ETF·ETN·리츠·우선주·스팩을 뺀 보통주만 — 다른 모집단과 같은 자를 쓴다 */
  const common = await getCommonStockCodes(client).catch(() => null);

  const want = market === "001" ? "kospi" : market === "101" ? "kosdaq" : null;
  const rows: AllStockRow[] = [];
  let scanned = 0;
  let skippedThin = 0;

  for (const [code, arr] of Object.entries(closes)) {
    const s = snap.byCode.get(code);
    /*
     * 스냅샷에 없으면 못 쓴다 — 이름·거래대금·시총이 다 거기서 온다.
     * ⚠️ 스냅샷은 업종 구성종목으로 만들어서 **ETF·리츠와 일부 업종이 빠진다.**
     * 그래서 이 모집단도 「전 종목」이 아니라 「스냅샷에 잡히는 전 종목」이다.
     * 화면이 그 수를 적을 수 있게 `scanned` 를 같이 돌려준다.
     */
    if (!s) continue;
    if (common && !common.has(code)) continue;
    if (want && s.market !== want) continue;
    scanned += 1;

    /*
     * 못 사는 종목은 후보가 아니다.
     *
     * ⚠️ **거래대금을 모르면(null) 뺀다.** 처음엔 「모른다」를 통과시켰는데 —
     * 「모른다를 0 으로 만들지 않는다」는 원칙을 여기 그대로 옮긴 것이었다 —
     * 그러자 스팩과 거래가 아예 없는 종목이 상위에 올라왔다(대신밸런스제·
     * 유진스팩10호…). 이 문의 물음은 「값이 얼마인가」가 아니라 **「살 수 있나」**다.
     * 살 수 있는지 모르면 후보가 아니다.
     */
    if (s.tradeValue === null || s.tradeValue < minValue) {
      skippedThin += 1;
      continue;
    }

    const f = featFromCloses(
      arr,
      { price: s.price, tradeValue: s.tradeValue, marketCap: s.marketCap },
      lenses?.theme?.get(code) ?? null,
      lenses?.etf?.get(code) ?? null,
    );
    if (!f) continue;

    const { score, measured } = preScore(f, arr, cfg);
    rows.push({
      code,
      name: s.name,
      price: s.price,
      changeRate: s.changeRate,
      tradeValue: s.tradeValue ?? 0,
      marketCap: s.marketCap,
      preScore: score,
      measured,
    });
  }

  rows.sort((a, b) => b.preScore - a.preScore || b.tradeValue - a.tradeValue);
  return { rows: rows.slice(0, limit), scanned, skippedThin };
}
