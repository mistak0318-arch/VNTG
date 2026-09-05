import type { KiwoomClient } from "./kiwoomClient.js";
import { indexDailySeries } from "./superSignal.js";
import { yahooChart } from "./yahooChart.js";
import { loadBars } from "./dailyCloses.js";
import { PREMARKET_SPAN, premarketDays } from "./usPremarket.js";

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
 *
 * ## 시계가 둘이다 — **바깥 값은 하루 늦게 쓴다** (2026-09-05)
 *
 * 이 엔진은 **한국 종가(15:30)에 판단하고 그 종가에 체결**한다. 그런데 바깥 변수는
 * 그 시각에 아직 안 끝났거나 시작도 안 했다:
 *
 * | 변수 | 날짜 D 로 적힌 값이 실제로 정해지는 때(한국시간) |
 * |---|---|
 * | 코스피·코스닥 | D 15:30 — **판단하는 바로 그 시각** |
 * | S&P·나스닥선물·VIX·미금리 | D 22:30 ~ **D+1 06:00** |
 * | 미국 프리장 | D 17:00 ~ 23:30 |
 *
 * 즉 **국내 지수만 그날 값을 쓸 수 있다.** 나머지를 그날 값으로 읽으면 백테스트가
 * 아직 일어나지 않은 일을 보고 산다 — 성적이 좋게 나오고, 그 좋음이 전부 거짓이다.
 * 그래서 `SeriesDef.clock` 이 `"us"` 인 변수는 조회할 때 **그날을 빼고 그 이전의
 * 마지막 값**을 쓴다(`asOf(..., true)`). 하루 묵은 값이지만, 그게 한국 종가에
 * 실제로 알 수 있었던 값이다.
 *
 * ⚠️ 이 규칙을 넣기 전(2026-09-04)에 돌린 백테스트 성적은 바깥 변수를 쓴 규칙이라면
 * **지금 다시 돌리면 달라진다.** 예전 것이 한 칸 미래를 보고 있었다.
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
  /**
   * 어느 시계로 도나. `"us"` 면 한국 종가에 **그날 값은 아직 없다** —
   * 조회가 그날을 빼고 읽는다. 머리말의 표를 볼 것.
   */
  clock: "kr" | "us";
  /** 화면이 목록을 묶는 이름 */
  group: string;
  /** 뒤로 얼마나 있나 — 화면이 그대로 적는다. 없는 구간은 조건이 **안 맞은 것**으로 센다 */
  span: string;
}

/**
 * 고를 수 있는 **외부 변수** 목록.
 * 종목은 규칙이 지정한 코드라 여기 없다 — 여기는 「바깥」이다.
 */
export const SERIES: SeriesDef[] = [
  { key: "KOSPI", label: "코스피", kind: "index", unit: "p", clock: "kr", group: "국내 지수", span: "2년+", hint: "지수 종가 (ka20006) — 한국 종가와 같은 시각이라 그날 값을 씁니다" },
  { key: "KOSDAQ", label: "코스닥", kind: "index", unit: "p", clock: "kr", group: "국내 지수", span: "2년+", hint: "지수 종가 (ka20006) — 한국 종가와 같은 시각이라 그날 값을 씁니다" },

  { key: "NQ_FUT", label: "나스닥100 선물", kind: "macro", unit: "p", clock: "us", group: "미국 지수·선물", span: "2년", hint: "야후 NQ=F — 이엠이니 나스닥100 선물. 거의 24시간 돌지만 일봉은 미국 마감(한국 06시)에 닫힙니다" },
  { key: "SP500", label: "S&P 500", kind: "macro", unit: "p", clock: "us", group: "미국 지수·선물", span: "2년", hint: "야후 ^GSPC — 간밤 미국장" },
  { key: "VIX", label: "VIX 공포지수", kind: "macro", unit: "p", clock: "us", group: "미국 지수·선물", span: "2년", hint: "야후 ^VIX — 20 위면 불안, 30 위면 공황 쪽입니다" },

  { key: "US10Y", label: "미국 10년물 금리", kind: "macro", unit: "%", clock: "us", group: "금리", span: "2년", hint: "야후 ^TNX — 4.65 면 4.65%" },
  { key: "US30Y", label: "미국 30년물 금리", kind: "macro", unit: "%", clock: "us", group: "금리", span: "2년", hint: "야후 ^TYX — 4.65 면 4.65%. 10년물과의 차이가 장단기 스프레드입니다" },

  { key: "USDKRW", label: "원/달러 환율", kind: "macro", unit: "원", clock: "us", group: "환율·원자재", span: "2년", hint: "야후 USDKRW=X — 24시간 도는 값이라 일봉은 뉴욕 마감에 닫힙니다" },
  { key: "WTI", label: "WTI 유가", kind: "macro", unit: "$", clock: "us", group: "환율·원자재", span: "2년", hint: "야후 CL=F" },

  /*
   * 프리장 넷. **뒤로 60일뿐이다** — 야후가 분봉을 그만큼만 준다.
   * 이 사실을 `span` 에 적어 두고, 백테스트 결과가 구간이 모자라면 한 줄을 더 적는다.
   */
  { key: "NVDA_PRE", label: "엔비디아 프리장 봉", kind: "macro", unit: "%", clock: "us", group: "미국 프리장", span: PREMARKET_SPAN, hint: "프리장 시가 → 종가(%). 0 보다 크면 양봉입니다. 첫 체결 한 건에 흔들릴 수 있어 「갭」도 같이 보세요" },
  { key: "NVDA_PREGAP", label: "엔비디아 프리장 갭", kind: "macro", unit: "%", clock: "us", group: "미국 프리장", span: PREMARKET_SPAN, hint: "전일 정규장 종가 → 프리장 종가(%). 「간밤에 어디까지 갔나」는 이쪽이 덜 흔들립니다" },
  { key: "MU_PRE", label: "마이크론 프리장 봉", kind: "macro", unit: "%", clock: "us", group: "미국 프리장", span: PREMARKET_SPAN, hint: "프리장 시가 → 종가(%). 0 보다 크면 양봉입니다" },
  { key: "MU_PREGAP", label: "마이크론 프리장 갭", kind: "macro", unit: "%", clock: "us", group: "미국 프리장", span: PREMARKET_SPAN, hint: "전일 정규장 종가 → 프리장 종가(%)" },
];

const BY_KEY = new Map(SERIES.map((d) => [d.key, d]));

export function seriesDef(key: string): SeriesDef | null {
  return BY_KEY.get(key) ?? null;
}

/**
 * 이 변수는 **그날 값을 못 쓰나**.
 * 모르는 key 는 `false` 다 — 국내 것으로 보는 셈인데, 목록에 없는 key 는 값도 안 나와
 * 어차피 「못 잼」으로 걸린다.
 */
export function isLagged(key: string): boolean {
  return BY_KEY.get(key)?.clock === "us";
}

const INDEX_CODE: Record<string, string> = { KOSPI: "001", KOSDAQ: "101" };
const YAHOO_SYMBOL: Record<string, string> = {
  US10Y: "^TNX",
  US30Y: "^TYX",
  USDKRW: "USDKRW=X",
  WTI: "CL=F",
  SP500: "^GSPC",
  NQ_FUT: "NQ=F",
  VIX: "^VIX",
};

/** 프리장 넷 — 한 심볼에서 두 값이 나온다(같은 조회를 두 번 하지 않는다) */
const PREMARKET: Record<string, { symbol: string; field: "body" | "gap" }> = {
  NVDA_PRE: { symbol: "NVDA", field: "body" },
  NVDA_PREGAP: { symbol: "NVDA", field: "gap" },
  MU_PRE: { symbol: "MU", field: "body" },
  MU_PREGAP: { symbol: "MU", field: "gap" },
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
  } else if (PREMARKET[key]) {
    const { symbol, field } = PREMARKET[key];
    const days = await premarketDays(symbol).catch(() => []);
    /* 갭이 없는 날(창고 첫날)은 **버린다** — 0 으로 메우면 「보합」이라는 거짓이 된다 */
    rows = days
      .map((p) => ({ d: p.d, c: field === "body" ? p.body : (p.gap as number) }))
      .filter((p) => Number.isFinite(p.c));
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
 * `d` 이하(또는 `d` **미만**)의 마지막 점 자리. 셋이 같은 기준을 쓰게 하나로 뺐다 —
 * 세 군데에 같은 탐색을 따로 적으면 한 곳만 고쳐지는 날이 온다.
 */
function idxAt(rows: Point[], d: string, strict: boolean): number {
  let lo = 0;
  let hi = rows.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (strict ? rows[mid].d < d : rows[mid].d <= d) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/**
 * **날짜로 맞춘 조회기** — 「그날 또는 그 이전 마지막 값」.
 *
 * 미국장·환율은 한국 휴장일에도 움직이고, 반대로 한국이 열 때 미국이 쉬는 날도 있다.
 * 날짜가 딱 맞는 것만 쓰면 표본이 절반으로 준다. 그래서 **그 이전 마지막 값**을 쓴다.
 *
 * ⚠️ **뒤를 보지 않는다.** 여기서 한 칸만 잘못 잡아도 백테스트가 미래를 보고 번다.
 *
 * `strict` 를 켜면 **그날조차 뺀다.** 바깥 시계로 도는 변수가 그것이다 — 한국 종가에는
 * 아직 그날 값이 없다(머리말의 표). 켜고 끄는 것은 `isLagged(key)` 가 정한다.
 */
export function asOf(rows: Point[], d: string, strict = false): number | null {
  const i = idxAt(rows, d, strict);
  return i >= 0 ? rows[i].c : null;
}

/** `d` 기준 `n` 거래일 전 값 — 등락률·이동평균의 재료 */
export function backAt(rows: Point[], d: string, n: number, strict = false): number | null {
  const idx = idxAt(rows, d, strict);
  const j = idx - n;
  return idx >= 0 && j >= 0 ? rows[j].c : null;
}

/** `d` 까지의 `n`일 단순이동평균 */
export function maAt(rows: Point[], d: string, n: number, strict = false): number | null {
  const idx = idxAt(rows, d, strict);
  if (idx < n - 1) return null;
  let sum = 0;
  for (let i = idx - n + 1; i <= idx; i += 1) sum += rows[i].c;
  return sum / n;
}
