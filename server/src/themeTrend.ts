import { cumOf, loadCloses } from "./dailyCloses.js";
import { themeStrength, type ThemeStockRow } from "./themeStrength.js";

/**
 * 대세 테마 분석 — **지금 시장을 끌고 있는 묶음은 무엇인가** (2026-10-08).
 *
 * 벤티지: "대세 테마 분석이라는 메뉴를 하나 만들자 … 그 테마가 며칠간, 5일간, 10일간,
 * 20일간 어땠는지 알 수가 있고 … 각 테마들 중에서도 대표주 이런 거 좀 뽑아가지고
 * 한눈에 볼 수 있게"
 *
 * ## 테마 MAP 과 무엇이 다른가
 *
 * MAP 은 **오늘의 지도**다. 지금 무엇이 빨간가를 본다. 이 화면은 **흐름**을 본다 —
 * 5일·20일·60일을 같은 자로 재서 「뜨는 중인가, 이미 갔는가」를 가른다. 물음이 다르므로
 * 화면도 따로다(벤티지: "이건 별도 메뉴로 가야 돼. 왜냐면 흐름을 보는 거기 때문에").
 *
 * ## 줄 세우기를 **둘로 나눈다**
 *
 * 벤티지: "잡주도 많이 오른 잡주를 그래도 보여주는 게 맞는 것 같아 … 단순히 많이 오르네,
 * 그리고 네가 말한 추천, 그렇게 두 개를 보여주는"
 *
 *  · **많이 오른 순** — 단순 평균 등락률. 잡주 몇 개가 끌어올린 테마도 그대로 올라온다.
 *    그래도 봐야 한다 — **관심이 쏠렸다는 사실 자체가 정보**이기 때문이다.
 *  · **종합 점수 순** — 수익률·상승비율·거래대금을 묶은 점수. 「찐으로 크게 오르는 것」을 고른다.
 *
 * 둘이 같이 올라오는 테마가 진짜다. 한쪽에만 있으면 그게 무슨 뜻인지를 화면이 말해 준다.
 *
 * ## 점수를 **순위 백분위**로 내는 까닭
 *
 * 수익률을 그대로 더하면 +80% 짜리 하나가 나머지 두 칸을 통째로 덮어쓴다. 그래서 세 칸을
 * 각각 **전체 테마 안에서의 순위**(0~100)로 바꾼 뒤 가중평균한다. 이러면 한 칸의 극단값이
 * 점수를 지배하지 못하고, **세 가지를 고루 갖춘 테마**가 위로 온다 — 잡주 장세가 걸러지는
 * 자리가 여기다.
 *
 * 거래대금은 분포가 극단적이라(상위 몇 개가 전체의 절반) 순위로 바꾸는 것이 특히 맞다.
 *
 * ## 기간 상승비율은 **직접 센다**
 *
 * `themeStrength` 의 `breadth` 는 **오늘치**다. 5일·20일을 그 값으로 말하면 기간과 숫자가
 * 어긋난다. 전종목 일봉이 이미 있으므로 구성종목의 N일 수익률을 각자 재서
 * 「오른 종목 비율」을 기간마다 새로 센다 — 조회는 0이다.
 */

/** 볼 수 있는 기간(거래일) */
export const TREND_DAYS = [1, 5, 10, 20, 60] as const;
export type TrendDays = (typeof TREND_DAYS)[number];

export interface TrendLeader {
  code: string;
  name: string;
  /** 그 기간 수익률(%) */
  ret: number | null;
  /** 거래대금(억원) */
  tradeValue: number | null;
  /** 이 테마 거래대금에서 차지하는 비중(%) */
  share: number | null;
  /** 네이버가 적어 둔 편입 사유 — 국내만 */
  desc: string;
}

export interface TrendTheme {
  key: string;
  name: string;
  /** ETF 만 — 분류(해외 주식·원자재…) */
  group?: string;
  /** 구성종목 수 / 그중 일봉으로 잴 수 있었던 수 */
  members: number;
  measured: number;
  /** 기간 평균 수익률(%) — 구성종목 단순평균 */
  ret: number | null;
  /** 기간 상승비율(%) — 오른 종목 / 잰 종목 */
  breadth: number | null;
  /** 거래대금 합(억원) */
  tradeValue: number;
  /** 시가총액 합(억원) */
  marketCap: number;
  /** 0~100 — 세 칸의 순위를 가중평균한 것 */
  score: number;
  /** 점수의 속 — 어느 칸이 점수를 만들었나 */
  parts: { ret: number; breadth: number; money: number };
  /** 대표주 — 그 테마를 실제로 끌고 있는 종목 */
  leaders: TrendLeader[];
}

export interface TrendResult {
  market: string;
  days: TrendDays;
  at: string;
  /** 잰 테마 수 */
  total: number;
  /** 많이 오른 순 */
  byReturn: TrendTheme[];
  /** 종합 점수 순 */
  byScore: TrendTheme[];
  /** 못 잰 까닭이 있으면 한 줄 */
  note: string | null;
}

/**
 * 순위 백분위 — 가장 큰 것이 100, 가장 작은 것이 0.
 * 같은 값은 같은 점수를 받는다(평균 순위).
 */
function percentile(values: (number | null)[]): number[] {
  const idx = values.map((v, i) => ({ v, i })).filter((x): x is { v: number; i: number } => x.v !== null);
  const out = new Array<number>(values.length).fill(0);
  if (idx.length <= 1) {
    for (const x of idx) out[x.i] = 50;
    return out;
  }
  idx.sort((a, b) => a.v - b.v);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1].v === idx[i].v) j += 1;
    /* 같은 값 묶음은 가운데 순위를 나눠 갖는다 */
    const rank = (i + j) / 2;
    const pct = (rank / (idx.length - 1)) * 100;
    for (let k = i; k <= j; k++) out[idx[k].i] = pct;
    i = j + 1;
  }
  return out;
}

/**
 * 점수 무게.
 *
 * 수익률이 반이다 — 결국 「올랐나」를 보는 화면이다. 상승비율은 그 상승이 **고른가**를
 * 묻는 칸이라 잡주 장세를 거르는 몫이 크다. 거래대금은 **돈이 실제로 돌았나** —
 * 아무도 안 사는 묶음이 숫자만 좋은 경우를 막는다.
 */
const W = { ret: 0.5, breadth: 0.3, money: 0.2 };

/** 대표주를 몇 개까지 */
const LEADERS = 4;

export async function themeTrend(
  market: "kr" | "etf" | "us",
  days: TrendDays,
): Promise<TrendResult> {
  const { themes, at } = await themeStrength(market);
  const { closes } = await loadCloses();

  /*
   * ⚠️ **미국은 일봉 원장에 없다.** 원장은 국내 전종목이라, 미국 테마의 구성종목(티커)을
   * 여기서 재면 전부 `null` 이 된다. 그때는 `themeStrength` 가 이미 들고 있는 값으로
   * 물러선다 — 기간은 1일·5일·20일만 있고 그 밖은 못 낸다. 없는 것을 지어내지 않는다.
   */
  const fromLedger = market !== "us";

  const rows: TrendTheme[] = [];
  for (const t of themes) {
    if (t.gone) continue;
    const stocks: ThemeStockRow[] = t.stocks ?? [];
    let sum = 0;
    let n = 0;
    let up = 0;
    const retOf = new Map<string, number>();
    if (fromLedger) {
      for (const s of stocks) {
        const r = cumOf(closes[s.code], days);
        if (r === null || !Number.isFinite(r)) continue;
        retOf.set(s.code, r);
        sum += r;
        n += 1;
        if (r > 0) up += 1;
      }
    }
    /* 원장으로 못 잰 경우(미국)는 themeStrength 가 들고 있는 칸으로 */
    const fallback = days === 1 ? t.changeRate : days <= 5 ? t.w1 : days <= 20 ? t.m1 : t.m60;
    const ret = n > 0 ? sum / n : (fallback ?? null);
    const breadth = n > 0 ? (up / n) * 100 : (days === 1 ? t.breadth : null);

    const totalTv = stocks.reduce((a, s) => a + (s.tradeValue ?? 0), 0);
    const leaders = stocks
      .map((s) => {
        const r = retOf.get(s.code) ?? (days === 1 ? s.changeRate : null);
        const tv = s.tradeValue ?? null;
        return {
          code: s.code,
          name: s.name,
          ret: r,
          tradeValue: tv,
          share: tv !== null && totalTv > 0 ? (tv / totalTv) * 100 : null,
          desc: s.desc,
          /*
           * **끌고 있는 종목** — 많이 오른 것이 아니라 **오르면서 돈이 몰린** 것.
           * 수익률만 보면 거래 없는 잡주가 1등으로 올라온다. 테마 거래대금에서 차지하는
           * 비중을 곱하면 「이 테마의 상승을 실제로 만든 종목」이 나온다.
           * 내린 종목은 대표주가 아니므로 0 으로 눕힌다.
           */
          pull: r !== null && r > 0 && tv !== null && totalTv > 0 ? r * (tv / totalTv) : 0,
        };
      })
      .sort((a, b) => b.pull - a.pull)
      .slice(0, LEADERS)
      .map(({ pull: _pull, ...rest }) => rest);

    rows.push({
      key: t.key,
      name: t.name,
      group: t.group,
      members: stocks.length,
      measured: n,
      ret: ret === null ? null : Math.round(ret * 100) / 100,
      breadth: breadth === null ? null : Math.round(breadth),
      tradeValue: t.tradeValue,
      marketCap: t.marketCap,
      score: 0,
      parts: { ret: 0, breadth: 0, money: 0 },
      leaders,
    });
  }

  /* 세 칸을 각각 순위로 바꿔 더한다 — 한 칸의 극단값이 점수를 지배하지 못하게 */
  const pRet = percentile(rows.map((r) => r.ret));
  const pBr = percentile(rows.map((r) => r.breadth));
  const pMoney = percentile(rows.map((r) => (r.tradeValue > 0 ? r.tradeValue : null)));
  rows.forEach((r, i) => {
    r.parts = { ret: Math.round(pRet[i]), breadth: Math.round(pBr[i]), money: Math.round(pMoney[i]) };
    r.score = Math.round(pRet[i] * W.ret + pBr[i] * W.breadth + pMoney[i] * W.money);
  });

  const byReturn = [...rows].sort((a, b) => (b.ret ?? -1e9) - (a.ret ?? -1e9));
  const byScore = [...rows].sort((a, b) => b.score - a.score);

  const note = !fromLedger
    ? "미국 테마는 국내 일봉 원장에 없어 themeStrength 가 들고 있는 값으로 냅니다 — 1일·5일·20일만 있고 기간 상승비율은 못 냅니다."
    : null;

  return { market, days, at, total: rows.length, byReturn, byScore, note };
}

/* ───────── 한눈에 보기 (2026-10-08) ───────── */

/**
 * 벤티지: "네가 한 거대로라면 난 일일이 하나씩 클릭해서 봐야 돼. 나는 한눈에 보는 게
 * 필요하다고. 5일 클릭하고 10일 클릭하고 ETF 클릭했다 해외 클릭했다 그게 아니라
 * 한눈에 … 상위 5개씩 모아가지고 보여주고."
 *
 * 맞는 지적이다. **클릭해서 비교하게 만들면 사람은 비교를 안 한다.** 탭과 기간 단추로
 * 나눠 두면 「국내 5일」과 「ETF 20일」을 머릿속에서 맞춰야 하는데, 그건 화면이 할 일이다.
 *
 * 그래서 **시장 셋 × 기간 넷 × 줄 세우기 둘**을 한 번에 낸다. 전부 파일과 일봉 캐시라
 * 조회가 0회이므로 한 번에 다 내도 비싸지 않다 — 나눌 이유가 애초에 없었다.
 */
export const OVERVIEW_DAYS = [1, 5, 20, 60] as const;

/** 한 칸 — 그 시장·그 기간의 상위 다섯 */
export interface OverviewCell {
  days: number;
  byReturn: TrendTheme[];
  byScore: TrendTheme[];
}

export interface OverviewMarket {
  market: "kr" | "etf" | "us";
  label: string;
  total: number;
  note: string | null;
  cells: OverviewCell[];
}

export interface OverviewResult {
  at: string;
  top: number;
  markets: OverviewMarket[];
}

const MARKET_LABEL: Record<string, string> = { kr: "국내 테마", etf: "ETF", us: "해외 테마" };

export async function themeTrendOverview(top = 5): Promise<OverviewResult> {
  const markets: OverviewMarket[] = [];
  let at = "";
  for (const m of ["kr", "etf", "us"] as const) {
    const cells: OverviewCell[] = [];
    let total = 0;
    let note: string | null = null;
    for (const d of OVERVIEW_DAYS) {
      const r = await themeTrend(m, d as TrendDays);
      if (!at) at = r.at;
      total = r.total;
      note = r.note;
      cells.push({ days: d, byReturn: r.byReturn.slice(0, top), byScore: r.byScore.slice(0, top) });
    }
    markets.push({ market: m, label: MARKET_LABEL[m], total, note, cells });
  }
  return { at, top, markets };
}
