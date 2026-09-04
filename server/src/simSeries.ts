import type { KiwoomClient } from "./kiwoomClient.js";
import { indexDailySeries } from "./superSignal.js";
import { yahooChart } from "./yahooChart.js";
import { loadBars } from "./dailyCloses.js";

/**
 * 시뮬레이터가 쓰는 **변수 시계열** (2026-09-04).
 *
 * 벤티지: "어떤 지수나 어떤 금리, 어떤 외부 변수 이런 걸 변수로 넣을 수 있게 해서,
 * 그 조건일 때는 매수, 어떤 조건일 땐 매도 이렇게 한 다음에 매일매일 돌려볼 수 있는
 * 시뮬레이터."
 *
 * ## 규칙 하나: **없는 변수는 안 내놓는다**
 *
 * 화면에 고를 수 있게 뜨는 변수는 **과거 이력이 실제로 있는 것뿐**이다. 이력이 없는
 * 값으로 조건을 만들면 백테스트가 「조건이 한 번도 안 맞았다」로 조용히 끝나거나,
 * 더 나쁘게는 오늘 값을 과거에 끼워 넣어 **미래를 본 성적**을 낸다. 이 도구의 값어치는
 * 「과거에 이랬으면 이랬다」인데 그게 거짓이면 없느니만 못하다.
 *
 * ## 어디서 오나
 *
 *   종목  `dailyCloses.json` 의 `bars` — 2,700종목 × 500일 OHLCV. 이미 받아 둔 것이라 빠르다
 *   지수  `ka20006` 업종일봉 (코스피 001 · 코스닥 101). 받아서 이 프로세스에 캐시
 *   거시  야후 2년 일봉 (`^TNX` 미10년 · `USDKRW=X` 환율 · `CL=F` 유가 · `^GSPC` S&P)
 *
 * ⚠️ 야후 **5y 는 주봉**이라 안 쓴다. 국내 일봉과 날짜로 맞출 때 주봉은 거의 다 어긋나
 * 표본이 통째로 사라진다(이 코드베이스가 250일 검증에서 이미 데인 자리다). 2y 가 한계다.
 */

/** 하루 한 점 — 날짜는 `YYYYMMDD` 로 통일한다(국내 일봉이 그 모양이다) */
export interface Point {
  d: string;
  c: number;
}

export type SeriesKind = "stock" | "index" | "macro";

export interface SeriesDef {
  key: string;
  label: string;
  kind: SeriesKind;
  /** 사람이 읽을 단위 — 화면이 조건 값 옆에 적는다 */
  unit: string;
  hint: string;
}

/**
 * 고를 수 있는 **외부 변수** 목록.
 * 종목은 규칙이 지정한 코드라 여기 없다 — 여기는 「바깥」이다.
 */
export const SERIES: SeriesDef[] = [
  { key: "KOSPI", label: "코스피", kind: "index", unit: "p", hint: "지수 종가 (ka20006)" },
  { key: "KOSDAQ", label: "코스닥", kind: "index", unit: "p", hint: "지수 종가 (ka20006)" },
  { key: "US10Y", label: "미국 10년물 금리", kind: "macro", unit: "%", hint: "야후 ^TNX — 4.65 면 4.65%" },
  { key: "USDKRW", label: "원/달러 환율", kind: "macro", unit: "원", hint: "야후 USDKRW=X" },
  { key: "WTI", label: "WTI 유가", kind: "macro", unit: "$", hint: "야후 CL=F" },
  { key: "SP500", label: "S&P 500", kind: "macro", unit: "p", hint: "야후 ^GSPC — 간밤 미국장" },
];

const INDEX_CODE: Record<string, string> = { KOSPI: "001", KOSDAQ: "101" };
const YAHOO_SYMBOL: Record<string, string> = {
  US10Y: "^TNX",
  USDKRW: "USDKRW=X",
  WTI: "CL=F",
  SP500: "^GSPC",
};

/*
 * 프로세스 캐시. 시뮬은 규칙마다 같은 지수를 다시 부르는데, 그때마다 조회하면
 * 규칙 열 개에 조회가 열 번 나간다. 하루 안에서 지수 일봉은 안 바뀐다.
 */
const cache = new Map<string, { at: number; rows: Point[] }>();
const TTL_MS = 30 * 60_000;

function ymd(s: string): string {
  return s.slice(0, 10).replace(/-/g, "");
}

/** 외부 변수 한 줄기 — 옛날→최신 순 */
export async function series(client: KiwoomClient, key: string): Promise<Point[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;

  let rows: Point[] = [];
  if (INDEX_CODE[key]) {
    const s = await indexDailySeries(client, INDEX_CODE[key]).catch(() => []);
    rows = s.map((p) => ({ d: p.date, c: p.close }));
  } else if (YAHOO_SYMBOL[key]) {
    const ch = await yahooChart(YAHOO_SYMBOL[key], "2y").catch(() => null);
    /* 야후 일봉의 `t` 는 이미 `YYYY-MM-DD` 다 — 국내 일봉 모양(`YYYYMMDD`)으로만 바꾼다 */
    rows = (ch?.candles ?? [])
      .map((k) => ({ d: ymd(k.t), c: k.close }))
      .filter((p) => /^\d{8}$/.test(p.d) && Number.isFinite(p.c) && p.c > 0);
  }
  rows.sort((a, b) => a.d.localeCompare(b.d));
  cache.set(key, { at: Date.now(), rows });
  return rows;
}

/**
 * 종목 일봉 — 이미 받아 둔 것에서 꺼낸다.
 *
 * ⚠️ 이 창고는 **500일**만 들고 있다(`dailyCloses`). 그보다 긴 백테스트는 못 한다.
 * 못 하는 것을 되는 척하지 않고, 화면이 「자료가 있는 구간」을 그대로 적는다.
 */
export async function stockBars(code: string): Promise<{ d: string; o: number; c: number }[]> {
  const rows = await loadBars(code);
  return rows
    .map((r) => ({ d: String(r.d), o: Number(r.o) || Number(r.c), c: Number(r.c) }))
    .filter((r) => /^\d{8}$/.test(r.d) && r.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
}

/**
 * **날짜로 맞춘 조회기** — 「그날 또는 그 이전 마지막 값」.
 *
 * 미국장·환율은 한국 휴장일에도 움직이고, 반대로 한국이 열 때 미국이 쉬는 날도 있다.
 * 날짜가 딱 맞는 것만 쓰면 표본이 절반으로 준다. 그래서 **그 이전 마지막 값**을 쓴다 —
 * 이게 실제로 그날 아침에 알 수 있었던 값이기도 하다.
 *
 * ⚠️ **뒤를 보지 않는다.** 이분탐색이 찾는 것은 `d` 이하의 마지막 점이다.
 * 여기서 한 칸만 잘못 잡아도 백테스트가 미래를 보고 번다.
 */
export function asOf(rows: Point[], d: string): number | null {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].d <= d) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? rows[ans].c : null;
}

/** `d` 기준 `n` 거래일 전 값 — 등락률·이동평균의 재료 */
export function backAt(rows: Point[], d: string, n: number): number | null {
  let idx = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].d <= d) {
      idx = i;
      break;
    }
  }
  const j = idx - n;
  return idx >= 0 && j >= 0 ? rows[j].c : null;
}

/** `d` 까지의 `n`일 단순이동평균 */
export function maAt(rows: Point[], d: string, n: number): number | null {
  let idx = -1;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].d <= d) {
      idx = i;
      break;
    }
  }
  if (idx < n - 1) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i += 1) sum += rows[i].c;
  return sum / n;
}
