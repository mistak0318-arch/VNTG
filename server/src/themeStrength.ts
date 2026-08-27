import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { peekSnapshot } from "./marketSnapshot.js";
import { loadThemes } from "./naverThemes.js";

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
  /** 며칠째 오르고 있나 (오늘 포함). 기록이 없으면 0 */
  streak: number;
  /** 5거래일 누적(%) — 기록이 모자라면 null */
  w1: number | null;
  /** 20거래일 누적(%) — 기록이 모자라면 null */
  m1: number | null;
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
async function record(rows: ThemeStrength[], traded: boolean): Promise<void> {
  if (!traded || rows.length === 0) return;
  const hist = await loadHistory();
  const day = kstDate();
  hist.days[day] = Object.fromEntries(rows.map((r) => [r.key, Math.round(r.changeRate * 100) / 100]));
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

/** 오늘 포함 며칠째 오르고 있나 */
function streakOf(series: number[]): number {
  let n = 0;
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i] > 0) n += 1;
    else break;
  }
  return n;
}

/**
 * 시장 하나의 테마 강도.
 *
 * ⚠️ **조회를 하지 않는다.** 분류는 파일에서, 시세는 이미 떠 있는 스냅샷(`peekSnapshot`)
 * 에서 읽는다. 스냅샷이 아직 없으면 등락률이 전부 null 이 되므로 그때는 빈 목록을 준다 —
 * 0% 로 채워진 MAP 은 「전부 보합」이라는 거짓말이다.
 */
export async function themeStrength(market: Market): Promise<{ themes: ThemeStrength[]; at: string }> {
  const store = await loadThemes();
  const snap = peekSnapshot();
  const hist = await loadHistory();
  const days = Object.keys(hist.days).sort();

  const rows: ThemeStrength[] = [];

  if (market === "kr") {
    for (const t of store.themes) {
      const stocks: ThemeStockRow[] = t.stocks.map((s) => ({
        code: s.code,
        name: s.name,
        desc: s.desc,
        changeRate: snap?.byCode.get(s.code)?.changeRate ?? null,
      }));
      const row = build(`kr:${t.no}`, t.name, stocks, days, hist);
      if (row) rows.push(row);
    }
  } else if (market === "us") {
    /*
     * 미국은 스냅샷이 없다(키움 전종목은 국내뿐이다). 네이버가 분류와 함께 준
     * 시세를 쓰려면 매일 받아야 하는데, 지금은 주 1회다 — 그래서 **등락률을 못 낸다.**
     * 구성만 보여 주고 숫자는 비운다. 0 으로 채우지 않는다.
     */
    for (const t of store.us) {
      const stocks: ThemeStockRow[] = t.stocks.map((s) => ({
        code: s.symbol,
        name: s.name,
        desc: "",
        changeRate: null,
      }));
      rows.push({
        key: `us:${t.code}`,
        name: t.name,
        changeRate: 0,
        up: 0,
        down: 0,
        breadth: 0,
        streak: 0,
        w1: null,
        m1: null,
        stocks,
      });
    }
  }
  /* ETF 테마는 아직 출처가 없다 — 빈 목록을 준다(화면이 안내한다) */

  rows.sort((a, b) => b.changeRate - a.changeRate);
  if (market === "kr") void record(rows, snap?.traded ?? false).catch(() => undefined);

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

  return {
    key,
    name,
    changeRate: Math.round(avg * 100) / 100,
    up,
    down,
    breadth: Math.round((up / known.length) * 100),
    streak: streakOf([...series, avg]),
    w1: cumulative(series, 5),
    m1: cumulative(series, 20),
    stocks: stocks.sort((a, b) => (b.changeRate ?? -99) - (a.changeRate ?? -99)),
  };
}
