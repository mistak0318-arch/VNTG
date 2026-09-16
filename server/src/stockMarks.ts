import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloses } from "./dailyCloses.js";
import { getCommonStockCodes, getSharesMap } from "./stockListCache.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { computeAlerts, killAlerts, marketReturns } from "./hotAlerts.js";
import { marketRegime } from "./marketRegime.js";
import { superMarkIndex } from "./superSignal.js";
import type { DailyLedger, FlowRow } from "./dailyStore.js";

/**
 * **전 종목 마크** (2026-09-16) — 조회 0회.
 *
 * 벤티지: "우리가 지금 마크가 많이 달려 있잖아. 쌍끌이나 자석이나 이런 거 많이 했잖아. 장 마감 뒤 정리
 * 부분에서 이거를 붙이는 작업을 이미 신호등은 하고 있는데 쌍끌이 이런 것도 했으면 좋겠다. 그러면 모든
 * 종목에 대해서 우리가 알 수 있는 거잖아. … 조건 검색에도 그거를 활용할 수 있을 거 같거든."
 *
 * ## 무엇이 달라지나
 *
 * 여태 마크(🧲 쌍끌이·🌟 슈퍼·⚡ 교차…)는 **종목을 하나 열었을 때** `markWhy` 가 그 자리에서 셌다.
 * 그래서 「지금 쌍끌이인 종목 전부」를 물을 수가 없었다 — 2,600번 열어 봐야 알 수 있으니까.
 *
 * 그런데 재료는 **이미 파일에 다 있다.** 마감 뒤 정리 ①일봉과 ②원장이 방금 채운 것들이다:
 *
 *   일봉 `dailyCloses.bars`   2,810종목 × 500봉 — 시·고·저·종가·거래량
 *   원장 `data/daily/*.json`  2,629종목 × 100일 — 수급 13주체·공매도·대차·지분율·프로그램
 *   슈퍼 원장                  슈퍼신호등·무지개·교차
 *
 * 그래서 ②원장 바로 뒤에 한 번 훑어 **전 종목 마크를 한 파일로** 굳힌다(`data/stockMarks.json`).
 * 키움을 한 번도 안 부른다 — `samplesFromLedger` 와 같은 수법이다.
 *
 * ## 어디에 쓰나
 *
 *   ① **조건 검색** — 「쌍끌이 AND 정배열 AND 거래대금 500억 이상」을 **조회 0회로** 전종목에서.
 *      여태 조건 검색은 기준마다 종목당 조회가 나가서 500종목이 한계였다. 마크 조건만 쓰면 파일만 읽는다.
 *   ② 화면 — 목록 어디서든 마크를 달 수 있다(한 파일이면 되니까).
 *
 * ## ⚠️ 점수에는 안 들어간다
 *
 * 신호등 문턱·무게는 2026년 12월 말까지 동결이다. 여기서 세는 것은 **거르는 조건**이지 채점이 아니다.
 * 쌍끌이가 점수에 값을 하는지는 표본이 250거래일 찰 때 본다 — 실측으로는 **초록과 겹칠 때만** 값이
 * 있었다(20일 +3.2%p·승률 59%). 빨강 안에서는 −0.1 이라 단독으로는 못 쓴다.
 *
 * ## 「모른다」를 「아니다」로 적지 않는다
 *
 * 원장이 얕아 5·10·20일을 못 채우면 그 칸은 `null` 이다. 조건 검색은 `null` 을 **통과시키지 않는다**
 * (「모른다」와 「맞다」는 다른 말이다 — `condSearch` 의 같은 규칙).
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const DAILY_DIR = join(DATA_DIR, "daily");
const FILE = join(DATA_DIR, "stockMarks.json");

/** 한 종목의 마크 한 줄. 못 잰 칸은 `null` — 0 으로 채우지 않는다 */
export interface StockMark {
  /** 🧲 쌍끌이 — 외국인·주포가 5·10·20일 **여섯 칸 전부** 순매수 */
  twin: boolean | null;
  /** 외국인만 5·10·20일 **세 칸 전부** — 실측에서 쌍끌이보다 넓고 성적이 같았다 */
  fgn3: boolean | null;
  /** 외국인 **연속** 순매수 일수 (오늘부터 거슬러) */
  fgnDays: number | null;
  /** 기관계 연속 순매수 일수 */
  orgDays: number | null;
  /** 20일 외국인 순매수(억) */
  fgn20: number | null;
  /** 20일 주포(투신+연기금+사모) 순매수(억) */
  smart20: number | null;
  /** 정배열 — 종가 > 5일선 > 20일선 > 60일선 */
  trend: boolean | null;
  /** 60일 최고가 대비 위치(%) — 100 이면 신고가 */
  high60: number | null;
  /** 250일 신고가인가 */
  newHigh250: boolean | null;
  /** 20일선 이격도(%) — 양수면 위 */
  gapMa20: number | null;
  /** 오늘 거래대금(억) */
  volEok: number | null;
  /** 오늘 거래대금 / 최근 20일 평균 — 2 면 평소의 두 배 */
  volRatio: number | null;
  /** 공매도 비중(%) — 최근 5일 평균 */
  shortRatio: number | null;
  /** 공매도 비중이 식는 중인가 — 최근 5일 평균 < 그 앞 20일 평균 */
  shortCooling: boolean | null;
  /** 프로그램 5일 순매수(억) */
  prog5: number | null;
  /** 외국인 지분율 변화(20일, %p) */
  fgnRatioChg: number | null;
  /** 🌟 슈퍼신호등 (활성). 슈퍼 원장을 못 읽었으면 null — 「없다」로 굳히지 않는다 */
  super: boolean | null;
  /** 🌈 무지개 — 문턱 일수 이상 계속 걸린다 */
  rainbow: boolean | null;
  /** ⚡ 교차 — 주도주 태그를 달았던 슈퍼신호등 */
  cross: boolean | null;
  /** 🔥 쏠림 경보 열쇠들 — `turnover`·`range`·`volRatio`·`gap`·`volat`. 일봉이 21봉 미만이면 null(못 잼) */
  hot: string[] | null;
  /** ⏳ 늦음 경보 열쇠들 — `rs20`·`rs60`·`lo60`. **약세장에서만** 찬다. 일봉 61봉 미만이면 null */
  late: string[] | null;
  /** 그중 **탈락(veto)** 짜리가 하나라도 있나 — σ20 7%↑·진폭 12%↑·약세장 RS60·저점 +50%. 못 쟀으면 null */
  kill: boolean | null;
  /** 시가총액(억) */
  capEok: number | null;
}

export interface MarksFile {
  /** 어느 날 기준인가 (일봉 마지막 날) */
  day: string;
  builtAt: string;
  /** 몇 종목을 쟀나 */
  count: number;
  marks: Record<string, StockMark>;
}

/* ------------------------------------------------------------------ */
/* 세는 법                                                             */
/* ------------------------------------------------------------------ */

/** 백만원 → 억. 원장의 수급·프로그램은 백만원 단위다. `-0` 은 0 으로 — `-0 >= 0` 이 참이라 「순매수」 조건이 소액 순매도를 통과시켰다 */
const eok = (v: number) => Math.round(v / 100) || 0;

/** 한 칸이라도 값이 있어야 합을 낸다 — 전부 null 이면 「모른다」 */
function sum(rows: FlowRow[], pick: (r: FlowRow) => number | null): number | null {
  const v = rows.map(pick).filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0);
}

/** 주포 = 투신 + 연기금 + 사모 (2026-09-01 실측으로 확정한 셋) */
const smartOf = (r: FlowRow): number | null => {
  const v = [r.trust, r.pen, r.samo].filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0);
};

/**
 * **연속 순매수 일수** — 마지막 날부터 거슬러 올라가며 양수인 동안 센다.
 * 중간에 `null`(못 받은 날)이 나오면 거기서 멈춘다. 건너뛰고 세면 없는 연속을 만들어 낸다.
 */
function streak(rows: FlowRow[], pick: (r: FlowRow) => number | null): number | null {
  if (rows.length === 0) return null;
  /* 마지막 날을 못 받았으면 **모른다** — 0 을 돌려주면 「연속 ≤ 2」 조건이 모르는 종목을 통과시킨다 */
  if (pick(rows[rows.length - 1]) === null) return null;
  let n = 0;
  for (let i = rows.length - 1; i >= 0; i--) {
    const v = pick(rows[i]);
    if (v === null) break;
    if (v <= 0) break;
    n += 1;
  }
  return n;
}

function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

function avg(v: number[]): number | null {
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
}

/* ------------------------------------------------------------------ */
/* 만들기                                                              */
/* ------------------------------------------------------------------ */

export interface MarksProgress {
  running: boolean;
  done: number;
  total: number;
  marked: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

let progress: MarksProgress = { running: false, done: 0, total: 0, marked: 0, startedAt: "" };
export function marksProgress(): MarksProgress {
  return { ...progress };
}

/**
 * 전 종목 마크를 다시 센다. **마감 뒤 정리 ②원장 다음**에 부른다 — 원장이 오늘 것이어야
 * 마크도 오늘 것이다. 조회가 0회라 몇 초 안에 끝난다(파일 2,600개 읽기).
 */
export async function buildStockMarks(client: KiwoomClient): Promise<{ day: string; count: number; ms: number; error?: string }> {
  const t0 = Date.now();
  progress = { running: true, done: 0, total: 0, marked: 0, startedAt: new Date().toISOString() };
  try {
    const closes = await loadCloses();
    const bars = closes.bars ?? {};
    /* 보통주만 — 우선주·리츠까지 세면 조건 검색 결과가 쌍둥이로 찬다 */
    const common = await getCommonStockCodes(client).catch(() => null);

    /*
     * 🌟🌈⚡ 는 **이미 있는 색인을 그대로 쓴다** (`superMarkIndex`) — 화면의 SuperMark 가 보는 그것이다.
     * 여기서 원장을 다시 읽어 판정하면 「목록에서는 무지개인데 조건 검색에서는 아닌」 일이 생긴다.
     */
    /* 못 읽으면 null — 2,600종목에 「슈퍼 아님」을 사실처럼 적으면 `mkSuper fail` 이 전 종목을 통과시킨다 */
    const superOf = await superMarkIndex().catch(() => null);

    /* 경보에 쓸 것 — **전부 한 번씩만** 구한다. 종목마다 구하면 2,600번이다 */
    const sharesOf = await getSharesMap(client).catch(() => null);
    const mktRet = await marketReturns().catch(() => ({ r20: null, r60: null }));
    const regime = (await marketRegime().catch(() => null))?.regime ?? null;

    const files = (await readdir(DAILY_DIR).catch(() => [] as string[])).filter((f) => f.endsWith(".json"));
    progress.total = files.length;

    const marks: Record<string, StockMark> = {};
    let day = "";

    for (const f of files) {
      progress.done += 1;
      const code = f.slice(0, -5);
      if (common && !common.has(code)) continue;

      let led: DailyLedger;
      try {
        led = JSON.parse(await readFile(join(DAILY_DIR, f), "utf-8")) as DailyLedger;
      } catch {
        continue;
      }
      const flow = led.flow ?? [];
      const bs = bars[code] ?? [];
      if (flow.length === 0 && bs.length === 0) continue;
      if (bs.length > 0 && bs[bs.length - 1].d > day) day = bs[bs.length - 1].d;

      /* ── 수급 ── */
      const win = (n: number) => flow.slice(-n);
      const fgnSpan = (n: number) => {
        const s = sum(win(n), (r) => r.fgn);
        return s === null ? null : eok(s);
      };
      const smartSpan = (n: number) => {
        const s = sum(win(n), smartOf);
        return s === null ? null : eok(s);
      };
      const f5 = fgnSpan(5);
      const f10 = fgnSpan(10);
      const f20 = fgnSpan(20);
      const s5 = smartSpan(5);
      const s10 = smartSpan(10);
      const s20 = smartSpan(20);
      /* 세 칸·여섯 칸 — 하나라도 모르면 「모른다」(null)다. markWhy·시세분석과 같은 정의 */
      const known3 = f5 !== null && f10 !== null && f20 !== null;
      const fgn3 = known3 ? f5 > 0 && f10 > 0 && f20 > 0 : null;
      const knownSmart = s5 !== null && s10 !== null && s20 !== null;
      const twin = fgn3 === null || !knownSmart ? null : fgn3 && s5 > 0 && s10 > 0 && s20 > 0;

      /* ── 일봉 ── */
      const closesArr = bs.map((b) => b.c).filter((c) => c > 0);
      const last = closesArr[closesArr.length - 1] ?? null;
      const ma5 = sma(closesArr, 5);
      const ma20 = sma(closesArr, 20);
      const ma60 = sma(closesArr, 60);
      const trend = last !== null && ma5 !== null && ma20 !== null && ma60 !== null ? last > ma5 && ma5 > ma20 && ma20 > ma60 : null;
      const highs60 = bs.slice(-60).map((b) => b.h).filter((h) => h > 0);
      const high60 = last !== null && highs60.length >= 30 ? (last / Math.max(...highs60)) * 100 : null;
      const highs250 = bs.slice(-250).map((b) => b.h).filter((h) => h > 0);
      const newHigh250 = last !== null && highs250.length >= 120 ? last >= Math.max(...highs250) : null;
      const gapMa20 = last !== null && ma20 !== null && ma20 > 0 ? ((last - ma20) / ma20) * 100 : null;

      /*
       * **거래대금은 곱해서 낸다.** 일봉의 `v` 는 **거래량(주)** 다(`dailyCloses.ts` 의 `trde_qty`).
       * 검산: 2026-09-15 삼성전자 11,435,506주 × 248,500원 = **2.84조(28,417억)**, 하이닉스 4.48조.
       * 눈으로 아는 수와 맞는다. (처음에 백만원으로 잘못 읽어 100030 이 24억으로 나왔었다 —
       * 실제로는 1,461주 × 20,450원 = 0.3억이다.)
       */
      const todayBar = bs.length > 0 ? bs[bs.length - 1] : null;
      const volEok = todayBar && todayBar.v > 0 && todayBar.c > 0 ? Math.round((todayBar.v * todayBar.c) / 1e8) : null;
      /* 배수는 **거래량**으로 낸다 — 경보(hotAlerts)의 `volRatio` 와 같은 정의라야 한 뜻이다 */
      const base = avg(bs.slice(-21, -1).map((b) => b.v).filter((v) => v > 0));
      const volRatio = todayBar && todayBar.v > 0 && base !== null && base > 0 ? todayBar.v / base : null;

      /* ── 공매도·대차·프로그램 ── */
      const shortRows = led.short ?? [];
      const sr5 = avg(shortRows.slice(-5).map((r) => r.ratio).filter((x): x is number => x !== null));
      const srPrev = avg(shortRows.slice(-25, -5).map((r) => r.ratio).filter((x): x is number => x !== null));
      const shortCooling = sr5 !== null && srPrev !== null ? sr5 < srPrev : null;
      const progRows = led.prog ?? [];
      const progSum = progRows.slice(-5).map((r) => r.net).filter((x): x is number => x !== null);
      const prog5 = progSum.length === 0 ? null : eok(progSum.reduce((a, b) => a + b, 0));
      const ratioRows = (led.fgnRatio ?? []).map((r) => r.ratio).filter((x): x is number => x !== null);
      const fgnRatioChg = ratioRows.length >= 21 ? ratioRows[ratioRows.length - 1] - ratioRows[ratioRows.length - 21] : null;

      /*
       * 🔥 쏠림 · ⏳ 늦음 — **`computeAlerts` 를 그대로 부른다.**
       *
       * 문턱을 여기서 다시 쓰면 그 순간 정의가 둘이 된다(🧲 가 이미 서버·웹 두 곳에 복제돼 있다).
       * 그 함수는 키움 원본 모양(`cur_prc`·`high_pric`…, **최신이 앞**)을 받으므로 일봉을 뒤집어 맞춘다.
       * 시총은 상장주식수 × 종가, 거래대금은 위에서 곱한 값. 조회는 여전히 0회다.
       *
       * ⚠️ ⏳늦음은 **약세장에서만** 채워진다(강세장이면 늘 빈다) — 그래서 오늘 장세를 같이 넣는다.
       */
      const chartRows = bs
        .slice(-61)
        .reverse()
        .map((b) => ({ cur_prc: b.c, open_pric: b.o, high_pric: b.h, low_pric: b.l, trde_qty: b.v }));
      const shares = sharesOf?.get(code) ?? 0;
      const capEok = shares > 0 && todayBar && todayBar.c > 0 ? Math.round((shares * todayBar.c) / 1e8) : 0;
      const al = computeAlerts({ chartRows, tradeEok: volEok ?? 0, capEok, regime, market: mktRet });

      const sup = superOf?.get(code);
      marks[code] = {
        twin,
        fgn3,
        fgnDays: streak(flow, (r) => r.fgn),
        orgDays: streak(flow, (r) => r.org),
        fgn20: f20,
        smart20: s20,
        trend,
        high60: high60 === null ? null : Math.round(high60 * 10) / 10,
        newHigh250,
        gapMa20: gapMa20 === null ? null : Math.round(gapMa20 * 10) / 10,
        volEok,
        volRatio: volRatio === null ? null : Math.round(volRatio * 100) / 100,
        shortRatio: sr5 === null ? null : Math.round(sr5 * 100) / 100,
        shortCooling,
        prog5,
        fgnRatioChg: fgnRatioChg === null ? null : Math.round(fgnRatioChg * 100) / 100,
        /* 봉이 모자라면 경보를 「못 잰 것」으로 — computeAlerts 는 조용히 빈 결과를 주므로 여기서 가른다 */
        hot: bs.length >= 21 ? al.hot.map((a) => a.key) : null,
        late: bs.length >= 61 ? al.late.map((a) => a.key) : null,
        kill: bs.length >= 21 ? killAlerts(al).length > 0 : null,
        capEok: capEok > 0 ? capEok : null,
        super: superOf ? sup?.super === true : null,
        rainbow: superOf ? sup?.rainbow === true : null,
        cross: superOf ? sup?.cross === true : null,
      };
      progress.marked += 1;
    }

    const out: MarksFile = {
      day: day || new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, ""),
      builtAt: new Date().toISOString(),
      count: Object.keys(marks).length,
      marks,
    };
    await mkdir(DATA_DIR, { recursive: true });
    await writeFile(FILE, JSON.stringify(out), "utf-8");
    cache = out;
    cacheAt = Date.now();
    progress.running = false;
    progress.finishedAt = new Date().toISOString();
    return { day: out.day, count: out.count, ms: Date.now() - t0 };
  } catch (err) {
    progress.running = false;
    progress.error = err instanceof Error ? err.message : String(err);
    return { day: "", count: 0, ms: Date.now() - t0, error: progress.error };
  }
}

/* ------------------------------------------------------------------ */
/* 읽기                                                                */
/* ------------------------------------------------------------------ */

let cache: MarksFile | null = null;
let cacheAt = 0;

/**
 * 마크 파일을 읽는다 — 5분 캐시. 조건 검색이 종목마다 부르므로 **파일을 다시 읽으면 안 된다**
 * (2,600종목 × 1.5MB 를 500번 읽는다는 뜻이다).
 */
export async function loadStockMarks(): Promise<MarksFile | null> {
  if (cache && Date.now() - cacheAt < 5 * 60_000) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, "utf-8")) as MarksFile;
    cacheAt = Date.now();
    return cache;
  } catch {
    return null;
  }
}

/** 한 종목의 마크 — 없으면 null */
export async function markOf(code: string): Promise<StockMark | null> {
  const f = await loadStockMarks();
  return f?.marks[code] ?? null;
}
