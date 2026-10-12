import { loadCloses, type DayBar } from "./dailyCloses.js";
import { themeStrength } from "./themeStrength.js";
import { themeTrend } from "./themeTrend.js";

/**
 * **테마 자금흐름** (2026-10-12) — ETF 자금흐름의 네이버 테마 판.
 *
 * 벤티지: "ETF랑 똑같은 구조로 해서 네이버 테마로도 구성해보자고. ETF 자금 흐름 자체를
 * 테마/ETF 자금흐름으로 바꾸고 메뉴 안에 2개의 탭으로."
 *
 * ## 왜 둘이 필요한가
 *
 * ETF 판은 **대표 ETF 서른 남짓**만 본다. 「반도체」처럼 ETF 가 있는 테마는 잘 보이지만,
 * ETF 가 안 만들어진 테마(초전도체·우주항공 같은 것)는 **아예 화면에 없다.**
 * 네이버 테마는 수백 개고 벤티지가 이미 믿는 분류라, ETF 로는 안 보이는 쏠림이 여기서 드러난다.
 * 둘을 **같은 잣대**(1·5·20일 등락 + 거래대금 배수)로 나란히 두면 그 차이가 읽힌다.
 *
 * ## 잣대를 둘로 만들지 않는다
 *
 * 등락은 **`themeTrend` 가 내는 값을 그대로 쓴다** — 대세 테마 분석이 쓰는 그 함수다.
 * 여기서 따로 평균을 내면 두 화면이 같은 테마를 두고 다른 숫자를 말하게 된다.
 * 거래대금 배수는 ETF 판의 셈(`최근 5일 평균 ÷ 그 앞 20일 평균`)을 그대로 옮긴다.
 *
 * ## 거래대금은 종가 × 거래량이다
 *
 * 일봉 원장에 거래대금 칸이 없어 **종가 × 거래량**으로 대신한다. ETF 판도 같은 어림을 쓴다.
 * 배수는 비율이라 이 어림의 치우침이 분자·분모에서 상쇄된다 — 절대값(5일 평균 억원)은
 * 참고로만 읽을 값이고, 이 화면이 묻는 것은 「전보다 몰렸나」지 「얼마가 몰렸나」가 아니다.
 */

export interface ThemeFlowRow {
  key: string;
  name: string;
  /** 구성종목 수 / 그중 일봉으로 잰 수 */
  members: number;
  measured: number;
  /** 대표주 — 그 테마 거래대금을 가장 많이 끄는 종목 */
  leadCode: string | null;
  leadName: string | null;
  /** 기간 평균 등락률(%) — `themeTrend` 의 값 그대로 */
  d1: number | null;
  d5: number | null;
  d20: number | null;
  /** 최근 5일 평균 거래대금 ÷ 그 앞 20일 평균 — 1.5 면 돈이 몰리는 중 */
  volRatio: number | null;
  /** 최근 5일 평균 거래대금(억원) */
  value5: number | null;
  /** 오늘 거래대금(억원) */
  todayValue: number;
}

const kstDay = (): string =>
  new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");

/** 오늘 봉은 아직 안 끝났다 — 배수에서 뺀다 (ETF 판과 같은 규칙) */
function settled(bars: DayBar[]): DayBar[] {
  const today = kstDay();
  return bars.length > 0 && bars[bars.length - 1].d === today ? bars.slice(0, -1) : bars;
}

/** 배수를 내려면 25일(5+20)이 온전히 있어야 한다 */
const NEED = 25;

export async function themeFlow(
  market: "kr" | "etf",
): Promise<{ at: string; rows: ThemeFlowRow[]; note: string }> {
  /*
   * 세 기간을 따로 부른다. 한 번에 내는 길을 새로 파면 `themeTrend` 와 두 벌이 되고,
   * 두 벌은 언젠가 서로 다른 말을 한다. 전부 파일에서 읽는 함수라 조회는 0회다.
   */
  const [t1, t5, t20] = await Promise.all([themeTrend(market, 1), themeTrend(market, 5), themeTrend(market, 20)]);
  const by5 = new Map(t5.byReturn.map((t) => [t.key, t]));
  const by20 = new Map(t20.byReturn.map((t) => [t.key, t]));

  const { themes } = await themeStrength(market);
  const { bars } = await loadCloses();
  const memberOf = new Map(themes.map((t) => [t.key, t.stocks ?? []]));

  const rows: ThemeFlowRow[] = [];
  for (const t of t1.byReturn) {
    const stocks = memberOf.get(t.key) ?? [];
    /*
     * 테마의 하루 거래대금 = 그날 구성종목 거래대금의 합.
     * 25일이 온전한 종목만 더한다 — 날짜를 맞춰 더해야 하는데, 상장이 얼마 안 된 종목을
     * 끼우면 앞쪽 20일만 비어 **배수가 저절로 커진다.** 없는 날을 0 으로 세면 안 된다.
     */
    const sumByDay = new Array<number>(NEED).fill(0);
    let measured = 0;
    for (const s of stocks) {
      const b = settled(bars?.[s.code] ?? []);
      if (b.length < NEED) continue;
      const tail = b.slice(-NEED);
      for (let i = 0; i < NEED; i++) sumByDay[i] += tail[i].c * tail[i].v;
      measured += 1;
    }
    let volRatio: number | null = null;
    let value5: number | null = null;
    if (measured > 0) {
      const last5 = sumByDay.slice(-5).reduce((a, b2) => a + b2, 0) / 5;
      const prev20 = sumByDay.slice(0, 20).reduce((a, b2) => a + b2, 0) / 20;
      if (prev20 > 0) volRatio = Math.round((last5 / prev20) * 100) / 100;
      value5 = Math.round(last5 / 1e8);
    }
    const lead = t.leaders[0] ?? null;
    rows.push({
      key: t.key,
      name: t.name,
      members: t.members,
      measured,
      leadCode: lead?.code ?? null,
      leadName: lead?.name ?? null,
      d1: t.ret,
      d5: by5.get(t.key)?.ret ?? null,
      d20: by20.get(t.key)?.ret ?? null,
      volRatio,
      value5,
      todayValue: Math.round(t.tradeValue),
    });
  }

  /*
   * 잴 수 없었던 테마는 뺀다. 배수가 이 화면의 본론인데 그 칸이 비면 줄만 늘어난다 —
   * 「없다」를 스무 줄 보여 주는 것은 알려 주는 것이 아니다.
   */
  const usable = rows.filter((r) => r.volRatio !== null);
  const dropped = rows.length - usable.length;
  return {
    at: t1.at,
    rows: usable,
    note:
      "거래대금은 일봉의 종가×거래량 어림입니다. 배수는 어제까지 25거래일(최근 5일 평균 ÷ 그 앞 20일 평균)이고, " +
      "25일이 온전한 종목만 더합니다. 등락률은 대세 테마 분석과 같은 값입니다." +
      (dropped > 0 ? ` 잴 거리가 모자란 테마 ${dropped}개는 뺐습니다.` : ""),
  };
}
