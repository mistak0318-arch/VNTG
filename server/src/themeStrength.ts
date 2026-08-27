import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { peekSnapshot } from "./marketSnapshot.js";
import { ETF_TABS, loadThemes } from "./naverThemes.js";

/**
 * 테마 강도 — **분류는 남의 것, 숫자는 우리 것.**
 *
 * 네이버에서 받아 둔 것은 「어느 종목이 어느 테마인가」뿐이다. 등락률·상승비율·
 * 연속성은 여기서 **키움 전종목 스냅샷으로 계산한다.** 그래야 국내·ETF·미국이
 * 같은 자로 재지고, 분류 파일이 며칠 낡아도 화면의 숫자는 늘 오늘 것이다.
 *
 * ## 왜 단순평균인가
 *
 * 시가총액 가중으로 하면 큰 종목 하나가 테마 전체를 대변한다. 「반도체」가 +2% 라는
 * 말이 사실은 「삼성전자가 +2%」인 셈인데, 그러면 **이 묶음이 같이 가는가**라는
 * 물음에 답을 못 한다. 그 물음이 테마를 보는 이유다.
 *
 * ## 상승비율과 연속성이 왜 따로 필요한가
 *
 * 평균 등락률만 보면 **열 종목 중 하나가 상한가라 오른 것**과 **열 종목이 고르게
 * 오른 것**이 같아 보인다. 그런데 다음 날은 다르다. 그래서 상승비율(breadth)을
 * 같이 낸다. 연속성은 「하루 반짝」과 「사흘째」를 가른다 — 이것도 평균에는 안 보인다.
 *
 * ## 히스토리
 *
 * 주간·월간·연속성은 **어제까지의 기록이 있어야** 나온다. 그래서 하루 한 줄씩
 * 테마별 등락률을 적어 둔다. 오늘 처음 켜면 그 값들은 `null` 이다 —
 * **없는 것을 0 으로 채우지 않는다.** 며칠 지나면서 채워진다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data");
const FILE = join(DIR, "themeHistory.json");

export interface ThemeStockRow {
  code: string;
  name: string;
  /** 편입 사유 — 국내만 있다 */
  desc: string;
  /** 오늘 등락률. 스냅샷에 없는 종목은 null */
  changeRate: number | null;
  /** 거래대금 어림값(억원) */
  tradeValue?: number | null;
}

export interface ThemeStrength {
  /** 시장 + 원본 id — 화면이 여는 열쇠 */
  key: string;
  name: string;
  /** 구성종목의 **단순평균** 등락률 */
  changeRate: number;
  up: number;
  down: number;
  /** 오른 종목 비율(0~100) */
  breadth: number;
  /** 며칠째 **연속으로** 오르고 있나 (오늘 포함). 기록이 없으면 0 */
  streak: number;
  /**
   * 최근 5일·10일 중 오른 날 수 (2026-08-28 요청).
   *
   * 연속 상승만 세면 「올랐다 쉬었다 하며 꾸준히 오르는」 테마를 놓친다 — 하루만
   * 쉬어도 0 으로 돌아가기 때문이다. 5일 중 4일이면 연속이 아니어도 흐름이 있는 것이다.
   * 기록이 모자라면 `of` 가 실제로 가진 날 수라, 화면이 「3일 중 2일」처럼 정직하게 적는다.
   */
  hit5: { n: number; of: number };
  hit10: { n: number; of: number };
  /**
   * 테마 거래대금 합계(억원) — **어림값**이다(거래량 × 현재가).
   * 「이 테마에 오늘 돈이 도는가」로 거르는 용도다. 266개를 다 볼 이유가 없다.
   */
  tradeValue: number;
  /** 5거래일 누적(%) — 기록이 모자라면 null */
  w1: number | null;
  /** 20거래일 누적(%) — 기록이 모자라면 null */
  m1: number | null;
  /**
   * 3개월 수익률(%) — **ETF 만.** 네이버가 목록에 담아 준다.
   *
   * ⚠️ `m1`(20거래일) 자리에 넣지 않는다. 화면이 「월간」이라 적어 놓고 3개월 값을
   * 보여주면 그건 거짓말이다. 기간이 다른 값은 칸도 달라야 한다.
   */
  m3: number | null;
  /** ETF 만 — 분류(국내 업종/테마 · 해외 주식 · 원자재…). 화면이 이걸로 나눠 본다 */
  group?: string;
  stocks: ThemeStockRow[];
}

type Market = "kr" | "etf" | "us";

/** 날짜별 테마 등락률 — { "20260828": { "kr:36": 1.23, … } } */
interface History {
  days: Record<string, Record<string, number>>;
}

async function loadHistory(): Promise<History> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as History;
    return raw && typeof raw.days === "object" ? raw : { days: {} };
  } catch {
    return { days: {} };
  }
}

function kstDate(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
}

/**
 * 오늘 값을 기록에 남긴다.
 *
 * **장중에는 안 적는다.** 오전 10시의 +3% 를 그날 값으로 굳히면 연속성이 거짓이 된다.
 * 스냅샷이 「거래 중」이 아닐 때(=마감 뒤)만 적는다.
 */
async function record(rows: ThemeStrength[], traded: boolean, market: Market): Promise<void> {
  if (!traded || rows.length === 0) return;
  const hist = await loadHistory();
  const day = kstDate();
  /* 같은 날 다른 시장을 덮지 않는다 — 국내와 미국이 같은 줄을 나눠 쓴다 */
  const prev = hist.days[day] ?? {};
  for (const k of Object.keys(prev)) if (k.startsWith(`${market}:`)) delete prev[k];
  hist.days[day] = {
    ...prev,
    ...Object.fromEntries(rows.map((r) => [r.key, Math.round(r.changeRate * 100) / 100])),
  };
  /* 60일치만 남긴다 — 월간까지 보는데 그 이상은 쓰지 않는다 */
  const keys = Object.keys(hist.days).sort();
  for (const k of keys.slice(0, Math.max(0, keys.length - 60))) delete hist.days[k];
  await mkdir(DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(hist), "utf-8");
}

/** 최근 N일 누적(%) — 하루치 등락률을 곱해서 이어 붙인다 */
function cumulative(series: number[], n: number): number | null {
  if (series.length < n) return null;
  const win = series.slice(-n);
  return (win.reduce((acc, v) => acc * (1 + v / 100), 1) - 1) * 100;
}

/** 오늘 포함 며칠째 **연속으로** 오르고 있나 */
function streakOf(series: number[]): number {
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] > 0) n += 1;
    else break;
  }
  return n;
}

/**
 * 최근 N일 중 오른 날 수.
 *
 * 연속만 세면 하루 쉰 테마가 0 이 된다 — 「올랐다 쉬었다 하며 꾸준한」 흐름을
 * 통째로 놓친다. `of` 는 실제로 가진 날 수라, 기록이 사흘뿐이면 「3일 중 2일」로
 * 정직하게 나온다. 없는 날을 0% 로 채워 세지 않는다.
 */
function hitsOf(series: number[], n: number): { n: number; of: number } {
  const win = series.slice(-n);
  return { n: win.filter((v) => v > 0).length, of: win.length };
}

/**
 * 시장 하나의 테마 강도.
 *
 * ⚠️ **조회를 하지 않는다.** 분류는 파일에서, 시세는 이미 떠 있는 스냅샷(`peekSnapshot`)
 * 에서 읽는다. 스냅샷이 아직 없으면 등락률이 전부 null 이 되므로 그때는 빈 목록을 준다 —
 * 0% 로 채워진 MAP 은 「전부 보합」이라는 거짓말이다.
 */
export async function themeStrength(
  market: Market,
): Promise<{ themes: ThemeStrength[]; at: string; warming?: boolean }> {
  const store = await loadThemes();
  const snap = peekSnapshot();
  const hist = await loadHistory();
  const days = Object.keys(hist.days).sort();

  /*
   * ⚠️ **스냅샷이 아직 없을 때를 구분해서 알려 준다** (2026-08-28).
   *
   * 국내 등락률은 키움 전종목 스냅샷에서 나오는데, 서버를 막 켜면 그게 비어 있다.
   * 그러면 모든 종목의 등락률이 null 이라 테마가 통째로 걸러지고, 화면에는
   * 「받아 둔 테마가 없습니다」가 뜬다 — **분류는 멀쩡히 있는데** 그렇게 보인다.
   * 원인이 전혀 다른 두 상태가 같은 화면으로 보이면 사람이 엉뚱한 데를 고치게 된다.
   */
  if (market === "kr" && !snap && store.themes.length > 0) {
    return { themes: [], at: "", warming: true };
  }

  const rows: ThemeStrength[] = [];

  if (market === "kr") {
    for (const t of store.themes) {
      const stocks: ThemeStockRow[] = t.stocks.map((s) => {
        const row = snap?.byCode.get(s.code);
        return {
          code: s.code,
          name: s.name,
          desc: s.desc,
          changeRate: row?.changeRate ?? null,
          tradeValue: row?.tradeValue ?? null,
        };
      });
      const row = build(`kr:${t.no}`, t.name, stocks, days, hist);
      if (row) rows.push(row);
    }
  } else if (market === "us") {
    /*
     * 미국은 키움 스냅샷이 없다 — 해외주식은 종목당 1콜이라 6,100종목을 매일 받을 수
     * 없다. 대신 **분류를 주는 네이버 API 가 시세를 같은 응답에 담아 준다**(63콜).
     * 그래서 저장된 값을 그대로 쓴다. 집계는 국내와 똑같이 여기서 한다 —
     * 평균도 상승비율도 연속성도 우리 계산이다.
     */
    for (const t of store.us) {
      const stocks: ThemeStockRow[] = t.stocks
        .slice()
        .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
        .map((s) => ({ code: s.symbol, name: s.name, desc: "", changeRate: s.changeRate }));
      const row = build(`us:${t.code}`, t.name, stocks, days, hist);
      if (row) rows.push(row);
    }
  } else {
    /*
     * ETF — **묶음이 아니라 종목 하나가 곧 테마다.**
     * 「KODEX 2차전지산업」은 그 자체로 이차전지 테마라, 구성종목을 모을 필요가 없다.
     * 그래서 분류(국내 업종/테마·해외 주식·원자재…)를 테마 이름 대신 쓰고
     * 타일 하나가 ETF 하나가 된다. 상승비율·연속성은 뜻이 없어 0 으로 둔다 —
     * 한 종목짜리 묶음에서 「몇이 올랐나」는 물음 자체가 성립하지 않는다.
     */
    for (const e of store.etf) {
      if (e.changeRate === null) continue;
      const key = `etf:${e.code}`;
      const series = days
        .map((d) => hist.days[d]?.[key])
        .filter((v): v is number => typeof v === "number");
      const withToday = [...series, e.changeRate];
      rows.push({
        key,
        name: e.name,
        changeRate: e.changeRate,
        up: e.changeRate > 0 ? 1 : 0,
        down: e.changeRate < 0 ? 1 : 0,
        breadth: e.changeRate > 0 ? 100 : 0,
        streak: streakOf(withToday),
        hit5: hitsOf(withToday, 5),
        hit10: hitsOf(withToday, 10),
        /*
         * ETF 는 거래대금 대신 **시가총액(순자산)** 을 쓴다 — 네이버가 그걸 준다.
         * 864개 중 대부분은 규모가 작아 거래가 거의 없다. 「얼마 이상만」이 없으면
         * 화면이 쓸모없는 타일로 덮인다.
         */
        tradeValue: Math.round(e.marketCap ?? 0),
        /* 주간·월간은 기록이 쌓여야 나온다. 3개월은 네이버가 주는 별도 값이다 */
        w1: cumulative(series, 5),
        m1: cumulative(series, 20),
        m3: e.m3,
        group: ETF_TABS[e.tab] ?? "기타",
        stocks: [
          {
            code: e.code,
            name: e.name,
            desc:
              e.nav !== null && e.price !== null && e.nav > 0
                ? `NAV ${e.nav.toLocaleString("ko-KR")} · 괴리 ${(((e.price - e.nav) / e.nav) * 100).toFixed(2)}%`
                : "",
            changeRate: e.changeRate,
            tradeValue: e.marketCap,
          },
        ],
      });
    }
  }

  rows.sort((a, b) => b.changeRate - a.changeRate);
  /*
   * 기록은 국내·미국 둘 다 남긴다 — 연속성과 주간·월간이 여기서 나온다.
   * 국내는 **마감 뒤에만** 적는다(장중 +3% 를 그날 값으로 굳히면 거짓이 된다).
   * 미국은 저장된 값 자체가 이미 마지막 정규장 종가 기준이라 그 조건이 없다.
   */
  void record(rows, market === "kr" ? snap?.traded ?? false : rows.length > 0, market).catch(
    () => undefined,
  );

  return { themes: rows, at: String(snap?.at ?? "") };
}

function build(
  key: string,
  name: string,
  stocks: ThemeStockRow[],
  days: string[],
  hist: History,
): ThemeStrength | null {
  const known = stocks.filter((s) => s.changeRate !== null);
  // 절반도 못 찾았으면 평균이 그 테마를 대표하지 못한다
  if (known.length === 0 || known.length < stocks.length * 0.5) return null;

  const avg = known.reduce((n, s) => n + (s.changeRate ?? 0), 0) / known.length;
  const up = known.filter((s) => (s.changeRate ?? 0) > 0).length;
  const down = known.filter((s) => (s.changeRate ?? 0) < 0).length;

  const series = days.map((d) => hist.days[d]?.[key]).filter((v): v is number => typeof v === "number");
  /* 오늘 값은 아직 기록 전이라 뒤에 붙여서 센다 */
  const withToday = [...series, avg];

  return {
    key,
    name,
    changeRate: Math.round(avg * 100) / 100,
    up,
    down,
    breadth: Math.round((up / known.length) * 100),
    streak: streakOf(withToday),
    hit5: hitsOf(withToday, 5),
    hit10: hitsOf(withToday, 10),
    tradeValue: Math.round(stocks.reduce((n, s) => n + (s.tradeValue ?? 0), 0)),
    w1: cumulative(series, 5),
    m1: cumulative(series, 20),
    m3: null,
    stocks: stocks.sort((a, b) => (b.changeRate ?? -99) - (a.changeRate ?? -99)),
  };
}
