import type { KiwoomClient } from "./kiwoomClient.js";
import { dropPhantomToday } from "./candleGuard.js";
import { alCode } from "./alCode.js";
import { opinionBrief } from "./analystOpinion.js";
import { evaluateSignal } from "./signalLight.js";
import { listWatchlist, type WatchItem } from "./watchlist.js";

/**
 * 관심종목 추적 지표.
 * 종목마다 차트(ka10081)와 투자자 수급(ka10060)을 조회하므로 호출량이 있다.
 * 마이페이지를 열 때마다 다시 부르지 않도록 짧게 캐싱한다.
 */

export interface TrackedStock extends WatchItem {
  price: number; // 현재가
  changeRate: number; // 당일 등락률
  returnRate: number | null; // 편입가 대비 수익률
  // 외국인/기관 순매매 (백만원). 10일·60일은 같은 응답에서 창만 달리 잘라 낸 것이라 조회가 안 는다
  foreign5: number;
  foreign10: number;
  foreign20: number;
  inst5: number;
  inst20: number;
  inst60: number;
  // 정배열 여부 (데이터 부족 시 null)
  trendPass: boolean | null;
  ma5: number | null;
  ma20: number | null;
  ma60: number | null;
  ma120: number | null;
  /** 종가가 5일선 위인가 / 20일선 위인가 — "지금 어디에 서 있나" */
  above5: boolean | null;
  above20: boolean | null;
  /**
   * 최근 3일 추세. +1 늘었다 / -1 줄었다 / 0 그대로 / null 모름.
   *
   * 공매도가 **줄고** 있으면 눌림이 풀리는 신호이고, 대차잔고가 **늘고** 있으면
   * 공매도로 이어질 재고가 쌓이는 것이다. 방향이 값 자체보다 중요해서 추세로 낸다.
   */
  shortTrend: number | null;
  lendingTrend: number | null;
  /** 신호등에서 가져온다 (자체 15분 캐시를 타므로 추가 부담이 작다) */
  profitUp: boolean | null;
  sectorStrong: boolean | null;
  /** 위 조건 중 몇 개를 만족했나 — 수익률 앞에 세워 한눈에 보게 */
  passCount: number;
  passTotal: number;
  /** 목표가(컨센서스 중앙값)까지 남은 폭 % — 한국투자증권 */
  upside: number | null;
  /** 최근 60일 의견 변경: +1 상향, -1 하향, 0 없음 */
  opinionMove: number | null;
  /** 커버하는 증권사 수 — 1곳이면 컨센서스가 아니다 */
  brokerCount: number | null;
  error: string | null;
}

type Row = Record<string, unknown>;

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function todayYyyymmdd(): string {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}`;
}

function avg(nums: number[]): number {
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function sum(arr: number[], n: number): number {
  return arr.slice(0, n).reduce((a, b) => a + b, 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function trackOne(client: KiwoomClient, item: WatchItem): Promise<TrackedStock> {
  /*
   * 구분선은 **종목이 아니다.** 시세를 물으면 없는 코드라 오류만 나고, 그 오류가 목록
   * 전체를 느리게 만든다. 자리만 지키는 줄이므로 값 없이 그대로 돌려준다.
   */
  const base: TrackedStock = {
    ...item,
    price: 0,
    changeRate: 0,
    returnRate: null,
    foreign5: 0,
    foreign10: 0,
    foreign20: 0,
    inst5: 0,
    inst20: 0,
    inst60: 0,
    trendPass: null,
    ma5: null,
    ma20: null,
    ma60: null,
    ma120: null,
    above5: null,
    above20: null,
    shortTrend: null,
    lendingTrend: null,
    profitUp: null,
    sectorStrong: null,
    passCount: 0,
    passTotal: 0,
    upside: null,
    opinionMove: null,
    brokerCount: null,
    error: null,
  };

  /* 구분선은 여기서 끝 — 조회할 게 없다 */
  if (item.divider) return base;

  try {
    // 일봉으로 현재가·이동평균·정배열을 계산
    const chart = await client.request<{ stk_dt_pole_chart_qry?: Row[] }>("/api/dostk/chart", "ka10081", {
      stk_cd: item.code,
      base_dt: todayYyyymmdd(),
      upd_stkpc_tp: "1",
    });
    const rows = dropPhantomToday(
      Array.isArray(chart.data.stk_dt_pole_chart_qry)
        ? (chart.data.stk_dt_pole_chart_qry as Record<string, unknown>[])
        : [],
    );
    const closes = rows.map((r) => Math.abs(toNum(r.cur_prc))).filter((n) => n > 0);

    if (closes.length > 0) {
      base.price = closes[0];
      if (closes.length > 1) {
        const prev = closes[1];
        base.changeRate = prev ? ((closes[0] - prev) / prev) * 100 : 0;
      }
      if (item.addedPrice > 0) {
        base.returnRate = ((closes[0] - item.addedPrice) / item.addedPrice) * 100;
      }
      if (closes.length >= 120) {
        base.ma5 = avg(closes.slice(0, 5));
        base.ma20 = avg(closes.slice(0, 20));
        base.ma60 = avg(closes.slice(0, 60));
        base.ma120 = avg(closes.slice(0, 120));
        base.trendPass =
          base.price >= base.ma5 && base.ma5 >= base.ma20 && base.ma20 >= base.ma60 && base.ma60 >= base.ma120;
      }
      // 캔들 위치는 이동평균만 있으면 나온다 — 120일치가 없어도 5·20일선은 잡힌다
      if (closes.length >= 5) base.above5 = base.price >= avg(closes.slice(0, 5));
      if (closes.length >= 20) base.above20 = base.price >= avg(closes.slice(0, 20));
    }

    await sleep(220); // TR당 초당 5회 제한을 여유 있게 지킨다

    // 투자자별 순매매 (금액, 백만원)
    const flow = await client.request<{ stk_invsr_orgn_chart?: Row[] }>("/api/dostk/chart", "ka10060", {
      dt: todayYyyymmdd(),
      stk_cd: item.code,
      amt_qty_tp: "1",
      trde_tp: "0",
      unit_tp: "1000",
    });
    const flowRows = Array.isArray(flow.data.stk_invsr_orgn_chart) ? flow.data.stk_invsr_orgn_chart : [];
    const foreign = flowRows.map((r) => toNum(r.frgnr_invsr));
    const inst = flowRows.map((r) => toNum(r.orgn));
    base.foreign5 = sum(foreign, 5);
    base.foreign10 = sum(foreign, 10);
    base.foreign20 = sum(foreign, 20);
    base.inst5 = sum(inst, 5);
    base.inst20 = sum(inst, 20);
    base.inst60 = sum(inst, 60);
    await sleep(220);

    /*
     * 공매도·대차잔고는 **방향만** 본다.
     *
     * 잔고 절대값은 종목마다 규모가 달라 비교가 안 되지만, 사흘 연속 늘었는지 줄었는지는
     * 어느 종목에서나 같은 뜻이다. 공매도가 줄면 눌림이 풀리는 것이고, 대차잔고가 늘면
     * 공매도로 이어질 재고가 쌓이는 것이다.
     */
    /*
     * 공매도·대차는 **일별 데이터**라 장중에 바뀌지 않는다. 그런데 시세 갱신(10분)마다
     * 같이 불러서 종목당 2회가 매번 나갔다 — 200종목이면 400회를 10분마다 헛돈다.
     * 하루에 한 번만 받고 그 뒤엔 기억한 값을 쓴다.
     */
    const dayKey = todayYyyymmdd();
    const cachedTrend = trendCache.get(item.code);
    if (cachedTrend && cachedTrend.day === dayKey) {
      base.shortTrend = cachedTrend.short;
      base.lendingTrend = cachedTrend.lending;
    } else {
      base.shortTrend = await trendOf(client, "/api/dostk/shsa", "ka10014", {
      // 통합(_AL) — 공매도량도 NXT 몫 포함 (2026-08-26)
      stk_cd: alCode(item.code),
      tm_tp: "1",
      strt_dt: daysAgoYyyymmdd(10),
      end_dt: todayYyyymmdd(),
      }, "shrts_qty").catch(() => null);
      await sleep(220);
      base.lendingTrend = await trendOf(client, "/api/dostk/slb", "ka20068", {
      stk_cd: item.code,
      strt_dt: daysAgoYyyymmdd(10),
      end_dt: todayYyyymmdd(),
      all_tp: "0",
      }, "rmnd").catch(() => null);
      trendCache.set(item.code, { day: dayKey, short: base.shortTrend, lending: base.lendingTrend });
    }
  } catch (err) {
    base.error = err instanceof Error ? err.message : "조회 실패";
  }

  /*
   * 영업이익·섹터는 신호등이 이미 계산한다. 여기서 다시 재무·업종을 부르면 같은 일을
   * 두 번 하는 셈이라, 신호등을 그대로 쓴다 — 자체 15분 캐시가 있어 부담이 작고,
   * 무엇보다 **두 화면의 판정이 어긋나지 않는다.**
   */
  try {
    const sig = await evaluateSignal(client, item.code);
    base.profitUp = sig.checks.find((c) => c.key === "profitGrowth")?.pass ?? null;
    base.sectorStrong = sig.checks.find((c) => c.key === "sectorStrength")?.pass ?? null;
  } catch {
    /* 신호등이 실패해도 나머지 지표는 살린다 */
  }

  /*
   * 증권사 목표주가 (한국투자증권). 키가 없으면 null 을 돌려주고 조용히 넘어간다 —
   * 이 한 칸 때문에 표 전체가 멈추면 안 된다. 종목별 6시간 캐시가 안에 있다.
   */
  const brief = await opinionBrief(item.code, base.price || null);
  if (brief) {
    base.upside = brief.upside;
    base.opinionMove = brief.recentMove;
    base.brokerCount = brief.brokerCount;
  }

  /*
   * 조건충족수 — 이 표의 요약이다.
   *
   * 열두 칸을 가로로 훑으며 세는 건 사람이 할 일이 아니다. 판단 못 한 항목(null)은
   * 분모에서도 빼서, 데이터가 없는 걸 미달로 세지 않는다.
   */
  const checks: (boolean | null)[] = [
    base.foreign5 > 0,
    base.foreign10 > 0,
    base.foreign20 > 0,
    base.inst5 > 0,
    base.inst20 > 0,
    base.inst60 > 0,
    base.trendPass,
    base.above5,
    base.above20,
    base.shortTrend === null ? null : base.shortTrend < 0, // 공매도는 줄어야 좋다
    base.lendingTrend === null ? null : base.lendingTrend < 0,
    base.profitUp,
    base.sectorStrong,
    // 목표가까지 10% 이상 남았나 — 커버하는 곳이 없으면 판단하지 않는다(null)
    base.upside === null ? null : base.upside >= 10,
    // 최근 60일 안에 의견이 내려간 적 없나. 상향은 가점, 하향은 감점
    base.opinionMove === null ? null : base.opinionMove >= 0,
  ];
  base.passTotal = checks.filter((c) => c !== null).length;
  base.passCount = checks.filter((c) => c === true).length;

  return base;
}

/**
 * 최근 3일이 늘었나 줄었나. +1 늘었다 / -1 줄었다 / 0 그대로 / null 모름.
 *
 * TR 을 직접 부른다. 처음엔 우리 서버의 라우트를 HTTP 로 부르려 했는데 그건 나쁘다 —
 * 포트를 가정해야 하고, 왕복이 한 번 더 늘고, 부하가 몰리면 자기 자신을 기다리게 된다.
 *
 * 응답 배열의 키가 TR 마다 다르므로 **배열인 첫 필드**를 찾아 쓴다. 잔고 필드도
 * 이름이 여러 가지라 후보를 훑는다 — 못 찾으면 null 이고, 그건 "모름"으로 표시된다.
 */
async function trendOf(
  client: KiwoomClient,
  uri: string,
  apiId: string,
  params: Record<string, string>,
  /**
   * 볼 필드. TR 마다 뜻이 달라 밖에서 지정해야 한다 — 실측으로 확인했다.
   *   ka10014 shrts_qty = 그날 공매도 **수량** (잔고가 아니다)
   *   ka20068 rmnd      = 대차 **잔고**
   */
  field: string,
): Promise<number | null> {
  const { data } = await client.request<Record<string, unknown>>(uri, apiId, params);
  const list = Object.values(data).find((v): v is Row[] => Array.isArray(v) && v.length > 0);
  if (!list) return null;

  const rows = list
    .slice(0, 3)
    .map((r) => (r[field] === undefined ? null : toNum(r[field])))
    .filter((n): n is number => n !== null);
  if (rows.length < 2) return null;
  const diff = rows[0] - rows[rows.length - 1]; // 최신이 앞
  return diff > 0 ? 1 : diff < 0 ? -1 : 0;
}

function daysAgoYyyymmdd(days: number): string {
  const d = new Date(Date.now() - days * 86400_000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 공매도·대차 추세는 하루 한 번만 받는다 (일별 데이터라 장중에 안 바뀐다) */
const trendCache = new Map<string, { day: string; short: number | null; lending: number | null }>();

let cache: { data: TrackedStock[]; at: number } | null = null;
/** 만드는 중이면 같은 약속을 돌려줘 중복 조회를 막는다 */
let building: Promise<TrackedStock[]> | null = null;

/**
 * 쌓아 둔 결과를 **버린다** — 목록 자체가 바뀌었을 때 부른다.
 *
 * ⚠️ 종목 순서를 바꿨는데 새로고침하면 **옛 순서로 되돌아왔다.** 저장은 제대로 됐는데
 * 이 캐시가 예전 목록을 들고 있었기 때문이다. 시세를 다시 받는 게 비싸서 캐시를 길게
 * 잡아 뒀는데, **목록이 바뀐 것과 시세가 낡은 것은 다른 일**이다.
 */
export function invalidateTracking(): void {
  cache = null;
}

/**
 * 캐시 수명.
 *
 * 종목마다 차트·수급을 조회하고 초당 제한 때문에 사이에 간격을 두므로,
 * 종목이 10개면 만드는 데 몇 초가 걸린다. TTL이 1분이었을 때는 잠깐만 지나도
 * **관심종목 화면에 들어갈 때마다 그 시간을 기다려야 했다.**
 *
 * 장중에는 10분, 장이 닫혀 있으면 값이 안 바뀌므로 다음 개장까지 유지한다.
 * 아래 갱신기가 만료 전에 미리 채워두므로 화면은 늘 완성된 캐시를 받는다.
 */
const INTRADAY_TTL_MS = 10 * 60_000;

function expiryOf(at: number): number {
  const d = new Date(at);
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  const minutes = kst.getHours() * 60 + kst.getMinutes();
  const weekday = kst.getDay() !== 0 && kst.getDay() !== 6;
  if (weekday && minutes >= 9 * 60 && minutes < 15 * 60 + 40) return at + INTRADAY_TTL_MS;

  const next = new Date(kst);
  next.setHours(9, 0, 0, 0);
  if (next.getTime() <= kst.getTime()) next.setDate(next.getDate() + 1);
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  return at + (next.getTime() - kst.getTime());
}

export async function getTrackedWatchlist(client: KiwoomClient, force = false): Promise<TrackedStock[]> {
  if (!force && cache && Date.now() < expiryOf(cache.at)) return cache.data;

  /*
   * **낡은 값이라도 먼저 준다.**
   *
   * 종목이 늘수록 다 만드는 데 오래 걸린다(200종목이면 몇 분). 그동안 화면을 비워 두면
   * 관심종목에 들어갈 때마다 기다려야 하는데, 10분 지난 값이라도 있는 게 낫다.
   * 갱신은 뒤에서 돌고, 다음에 들어오면 새 값을 받는다.
   */
  if (!force && cache) {
    if (!building) void rebuild(client);
    return cache.data;
  }
  if (building) return building;
  return rebuild(client);
}

/**
 * 실제로 만드는 곳.
 *
 * **동시에 넷씩** 돌린다. 예전엔 종목을 하나씩 순서대로 처리하면서 사이에 220ms 를
 * 쉬어서, 종목당 1초 가까이 걸렸다 — 33종목에 30초, 200종목이면 3분이다.
 * 키움의 초당 5회 제한은 TR 단위라, 서로 다른 종목을 넷씩 묶어 돌려도 같은 TR 은
 * 초당 4회를 넘지 않는다.
 */
async function rebuild(client: KiwoomClient): Promise<TrackedStock[]> {
  if (building) return building;
  building = (async () => {
    const items = await listWatchlist();
    const results: TrackedStock[] = [];
    const CONCURRENCY = 4;
    for (let i = 0; i < items.length; i += CONCURRENCY) {
      const chunk = items.slice(i, i + CONCURRENCY);
      results.push(...(await Promise.all(chunk.map((it) => trackOne(client, it)))));
      if (i + CONCURRENCY < items.length) await sleep(300);
    }
    cache = { data: results, at: Date.now() };
    return results;
  })().finally(() => {
    building = null;
  });

  return building;
}

/**
 * 백그라운드 갱신.
 * 만료된 뒤 사용자가 들어오면 그때부터 만들기 시작해 기다리게 된다.
 * 만료 1분 전에 미리 채워 둔다 — 아직 만료 전이므로 반드시 force 로 불러야 실제로 갱신된다.
 */
export function startTrackingRefresher(client: KiwoomClient): void {
  const tick = () => {
    if (building) return;
    if (cache && Date.now() < expiryOf(cache.at) - 60_000) return;
    void getTrackedWatchlist(client, true).catch((err: unknown) => {
      console.error("[watch] 관심종목 갱신 실패:", err instanceof Error ? err.message : err);
    });
  };
  setTimeout(tick, 25_000);
  setInterval(tick, 60_000);
  console.log("[watch] 관심종목 백그라운드 갱신 시작 (장중 10분 주기)");
}

/** 관심종목이 바뀌면 다음 조회 때 새로 집계하도록 캐시를 비운다 */
export function invalidateTrackingCache(): void {
  cache = null;
}
