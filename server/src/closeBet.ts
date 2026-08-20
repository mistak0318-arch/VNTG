import type { KiwoomClient } from "./kiwoomClient.js";
import { yahooChart } from "./yahooChart.js";
import { indexDetail } from "./indexDetail.js";

/**
 * 종가배팅 연습기 — **종가에 샀다고 치고 다음날 채점한다.**
 *
 * ## 왜 「연습기」인가
 *
 * 실제로 해 본 적 없는 방식이다. 그래서 화면부터 만들면 **검증 안 된 가설로 화면을
 * 늘리는 것**이 된다. 다행히 이건 **과거로 바로 물을 수 있다** — 조건이 대부분
 * 일봉에 들어 있기 때문이다.
 *
 * ## 가설
 *
 *   1. **미국 선물이 양봉이면 다음날 한국장이 좋다**
 *   2. 유가가 안정돼 있어야 한다 (급등은 전쟁 리스크)
 *   3. 환율이 안정돼 있어야 한다
 *
 * 이 셋을 **조건으로 걸었을 때와 안 걸었을 때**의 다음날 성적을 갈라서 센다.
 * 차이가 없으면 그 조건은 쓸모가 없는 것이다 — 그게 이 도구의 존재 이유다.
 *
 * ## 무엇을 못 하나 (먼저 적어 둔다)
 *
 * - **막판 30분 대금 집중**과 **시간외 흐름**은 일봉에 없다. 실시간으로만 모을 수 있다.
 * - 종가배팅의 실제 진입은 15:20 쯤인데, 여기서는 **종가**로 산 것으로 친다.
 *   NXT 애프터마켓(~20:00)이 있어 실제로도 종가 근처 진입이 가능해졌으므로 큰 왜곡은 아니다.
 * - 대형주만 본다. 소형주는 종가 근처 호가가 얇아 계산대로 안 체결된다.
 */

/* ------------------------------------------------------------------ */
/* 시장 조건                                                            */
/* ------------------------------------------------------------------ */

export interface GaugeDay {
  /** YYYY-MM-DD */
  date: string;
  /** 미국 선물 등락률(%) — 종가/시가 기준 **몸통** */
  futuresBody: number | null;
  /** 유가 하루 변동률(%) */
  oilMove: number | null;
  /** 원/달러 하루 변동률(%) */
  fxMove: number | null;
  /*
   * **실제 값도 같이 준다.**
   * 「유가 −0.21%」만 보면 그게 60달러대인지 90달러대인지 모른다. 변동률은 오늘의
   * 움직임이고, 수준은 그 움직임이 어디서 난 것인지를 말해 준다 — 둘 다 있어야 읽힌다.
   */
  futuresPrice: number | null;
  oilPrice: number | null;
  fxPrice: number | null;
}

export interface GaugeVerdict {
  key: "futures" | "oil" | "fx";
  label: string;
  level: "ok" | "warn" | "bad";
  /** 변동률 */
  value: string;
  /** 지금 값 — 변동률만으로는 수준을 모른다 */
  price: string;
  why: string;
}

/**
 * 선물은 **몸통**으로 본다.
 *
 * 「양봉이면 좋다」는 말의 뜻은 **장중에 올라서 끝났다**는 것이지, 전일 대비 얼마인지가
 * 아니다. 갭으로 뜬 뒤 하루 내내 흘러내린 날은 전일 대비 플러스여도 양봉이 아니다.
 * 그래서 `(종가 − 시가) / 시가` 를 쓴다.
 */
function bodyPct(c: { open: number; close: number }): number {
  return c.open > 0 ? ((c.close - c.open) / c.open) * 100 : 0;
}

function verdicts(g: GaugeDay): GaugeVerdict[] {
  const out: GaugeVerdict[] = [];

  if (g.futuresBody !== null) {
    const v = g.futuresBody;
    out.push({
      key: "futures",
      label: "미국 선물",
      level: v > 0.2 ? "ok" : v < -0.2 ? "bad" : "warn",
      value: `${v > 0 ? "+" : ""}${v.toFixed(2)}%`,
      price: g.futuresPrice === null ? "" : g.futuresPrice.toLocaleString("ko-KR"),
      why:
        v > 0.2
          ? "양봉 — 장중에 올라서 끝났다"
          : v < -0.2
            ? "음봉 — 장중에 밀려서 끝났다"
            : "몸통이 거의 없다. 방향이 없는 날",
    });
  }
  if (g.oilMove !== null) {
    const a = Math.abs(g.oilMove);
    out.push({
      key: "oil",
      label: "국제 유가",
      // 하루 4% 는 정유·화학·항공이 바로 반응하는 폭이다
      level: a >= 4 ? "bad" : a >= 2 ? "warn" : "ok",
      value: `${g.oilMove > 0 ? "+" : ""}${g.oilMove.toFixed(2)}%`,
      price: g.oilPrice === null ? "" : `$${g.oilPrice.toFixed(2)}`,
      why: a >= 4 ? "급변 — 지정학 리스크가 얹혀 있다" : a >= 2 ? "다소 흔들림" : "안정",
    });
  }
  if (g.fxMove !== null) {
    const a = Math.abs(g.fxMove);
    out.push({
      key: "fx",
      label: "원/달러",
      // 하루 1% 면 외국인 수급이 방향을 바꾸는 폭이다
      level: a >= 1 ? "bad" : a >= 0.5 ? "warn" : "ok",
      value: `${g.fxMove > 0 ? "+" : ""}${g.fxMove.toFixed(2)}%`,
      price: g.fxPrice === null ? "" : `${g.fxPrice.toFixed(1)}원`,
      why:
        a >= 1
          ? "급변 — 외국인 수급이 흔들린다"
          : a >= 0.5
            ? "다소 흔들림"
            : "안정",
    });
  }
  return out;
}

/** 오늘(또는 마지막 거래일) 기준 시장 조건 */
export async function marketGauge(): Promise<{ day: GaugeDay; verdicts: GaugeVerdict[] }> {
  const days = await gaugeHistory(5);
  const day = days[days.length - 1] ?? {
    date: "",
    futuresBody: null,
    oilMove: null,
    fxMove: null,
    futuresPrice: null,
    oilPrice: null,
    fxPrice: null,
  };
  return { day, verdicts: verdicts(day) };
}

/**
 * 과거 시장 조건.
 *
 * 야후 일봉 세 개(선물·유가·환율)면 된다. **날짜로 맞춰 붙인다** — 세 시장의 휴장일이
 * 달라서 인덱스로 맞추면 하루씩 어긋난다.
 */
async function gaugeHistory(days: number): Promise<GaugeDay[]> {
  /*
   * **반드시 일봉이 나오는 구간을 고른다.**
   * `5y` 는 주봉이라 국내 일봉과 날짜로 맞출 수가 없다 — 표본이 통째로 날아간다.
   */
  const range = days > 240 ? "2y" : days > 120 ? "1y" : "6mo";
  const [fut, oil, fx] = await Promise.all([
    yahooChart("ES=F", range),
    yahooChart("CL=F", range),
    yahooChart("KRW=X", range),
  ]);

  const oilBy = new Map(oil.candles.map((c, i) => [c.t, { c, prev: oil.candles[i - 1] }]));
  const fxBy = new Map(fx.candles.map((c, i) => [c.t, { c, prev: fx.candles[i - 1] }]));

  return fut.candles.slice(-days).map((c) => {
    const o = oilBy.get(c.t);
    const f = fxBy.get(c.t);
    return {
      date: c.t,
      futuresBody: bodyPct(c),
      oilMove: o?.prev ? ((o.c.close - o.prev.close) / o.prev.close) * 100 : null,
      fxMove: f?.prev ? ((f.c.close - f.prev.close) / f.prev.close) * 100 : null,
      futuresPrice: c.close,
      oilPrice: o?.c.close ?? null,
      fxPrice: f?.c.close ?? null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 검증                                                                */
/* ------------------------------------------------------------------ */

export interface BetCondition {
  /** 선물 몸통이 이 값 이상이어야 함(%) */
  futuresMin: number;
  /** 유가 변동이 이 값 이하여야 함(%) */
  oilMax: number;
  /** 환율 변동이 이 값 이하여야 함(%) */
  fxMax: number;
}

export const DEFAULT_CONDITION: BetCondition = { futuresMin: 0, oilMax: 4, fxMax: 1 };

export interface BetStat {
  key: string;
  n: number;
  /** 다음날 **시가**에 팔았을 때 */
  openWin: number;
  openAvg: number;
  /** 다음날 **종가**에 팔았을 때 */
  closeWin: number;
  closeAvg: number;
  /**
   * 같은 날 **코스피 대비 초과분**(%p).
   *
   * **이게 없으면 아무것도 증명하지 못한다.** 미국 선물이 양봉이면 다음날 한국장 전체가
   * 오른다 — 그러면 +2.7% 는 삼성전자를 골라서 번 게 아니라 **시장이 올라서 번 것**이다.
   * 종가배팅의 값어치는 「시장보다 더 먹었나」에 있다.
   *
   * 초과분이 0 에 가까우면 종목을 고를 이유가 없다. 지수 ETF 가 낫다.
   */
  openExcess: number;
  closeExcess: number;
  /** 초과분이 플러스였던 비율(%) */
  excessWin: number;
}

export type Venue = "krx" | "nxt";

export interface BetBacktest {
  /** 어디서 샀다고 쳤나 */
  venue: Venue;
  stocks: { code: string; name: string; days: number }[];
  /** 조건에 맞은 날 vs 안 맞은 날 */
  matched: BetStat;
  unmatched: BetStat;
  /** 조건 하나씩 따로 — 어느 조건이 실제로 일을 하나 */
  perCondition: BetStat[];
  condition: BetCondition;
  /** 벤치마크(코스피)를 받은 날 수 */
  benchDays: number;
  note: string;
}

/**
 * 국내 종목 일봉 — 시가가 있어야 「다음날 시가에 판다」를 잴 수 있다.
 *
 * **어디서 샀느냐가 값을 바꾼다.** 키움은 종목코드 접미사로 거래소를 가른다 —
 * `005930`(KRX) · `005930_NX`(넥스트레이드). 종가배팅은 **어느 장 마감에 사느냐**가
 * 전략의 일부다:
 *
 *   KRX 15:20 무렵  — 미국 선물이 아직 아시아 시간대뿐이라 정보가 적다
 *   NXT 19:50 무렵  — 미국 프리마켓이 세 시간 돌아 **방향이 더 보인다.**
 *                      대신 호가가 얇아 페이크에 걸리기 쉽다
 *
 * 실측(삼성전자 최근 10일): 두 종가가 **8일이나 달랐고** 하루는 10,000원(약 4%) 벌어졌다.
 * 같은 전략이라도 어디서 샀느냐로 결과가 갈린다는 뜻이라, 갈라서 재야 한다.
 */
async function krCandles(
  client: KiwoomClient,
  code: string,
): Promise<{ date: string; open: number; close: number }[]> {
  const d = new Date();
  const base = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = (res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  const n = (v: unknown) => Math.abs(Number(String(v ?? "").replace(/[+,-]/g, "")));
  return rows
    .map((r) => ({
      date: String(r.dt ?? ""),
      open: n(r.open_pric),
      close: n(r.cur_prc),
    }))
    .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0 && r.open > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

interface Row {
  open: number;
  close: number;
  /** 같은 날 코스피 다음날 시가·종가 수익률 */
  benchOpen: number | null;
  benchClose: number | null;
}

function summarize(key: string, rows: Row[]): BetStat {
  if (rows.length === 0) {
    return {
      key,
      n: 0,
      openWin: 0,
      openAvg: 0,
      closeWin: 0,
      closeAvg: 0,
      openExcess: 0,
      closeExcess: 0,
      excessWin: 0,
    };
  }
  const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  const o = rows.map((r) => r.open);
  const c = rows.map((r) => r.close);
  // 벤치마크가 있는 행만으로 초과분을 낸다 — 없는 날을 0 으로 치면 초과분이 부풀려진다
  const withBench = rows.filter((r) => r.benchOpen !== null && r.benchClose !== null);
  const exO = withBench.map((r) => r.open - (r.benchOpen as number));
  const exC = withBench.map((r) => r.close - (r.benchClose as number));
  return {
    key,
    n: rows.length,
    openWin: (o.filter((x) => x > 0).length / o.length) * 100,
    openAvg: avg(o),
    closeWin: (c.filter((x) => x > 0).length / c.length) * 100,
    closeAvg: avg(c),
    openExcess: avg(exO),
    closeExcess: avg(exC),
    excessWin: exO.length > 0 ? (exO.filter((x) => x > 0).length / exO.length) * 100 : 0,
  };
}

/**
 * 과거를 훑어 조건별 성적을 낸다.
 *
 * **종가에 사서 다음날 시가/종가에 판다**를 가정한다.
 * 조건에 맞은 날과 안 맞은 날을 갈라서 세는 게 요점이다 — 둘이 같으면 그 조건은
 * 아무 일도 안 하는 것이다.
 *
 * ⚠️ **생존편향이 있다.** 오늘 고른 종목의 과거만 보므로, 그동안 망한 종목은 안 들어온다.
 * 대형주 몇 개로 첫 감을 잡는 데는 쓸 만하지만 나온 승률을 그대로 믿으면 안 된다.
 */
export async function betBacktest(
  client: KiwoomClient,
  codes: { code: string; name: string }[],
  days = 120,
  cond: BetCondition = DEFAULT_CONDITION,
  venue: Venue = "krx",
): Promise<BetBacktest> {
  const gauge = await gaugeHistory(days + 20);
  const gaugeBy = new Map(gauge.map((g) => [g.date.replace(/-/g, ""), g]));

  /*
   * **코스피를 벤치마크로 받는다.**
   * 이게 없으면 「시장이 올라서 번 것」과 「종목을 골라서 번 것」이 안 갈린다.
   */
  const kospi = await indexDetail(client, "001", "day").catch(() => null);
  const benchBy = new Map<string, { open: number; close: number }>();
  const kc = kospi?.candles ?? [];
  for (let i = 0; i < kc.length - 1; i++) {
    const buy = kc[i];
    const next = kc[i + 1];
    if (buy.close > 0 && next.open > 0) {
      benchBy.set(buy.dt, {
        open: ((next.open - buy.close) / buy.close) * 100,
        close: ((next.close - buy.close) / buy.close) * 100,
      });
    }
  }

  const matched: Row[] = [];
  const unmatched: Row[] = [];
  const byCond: Record<string, Row[]> = {
    "선물 양봉": [],
    "유가 안정": [],
    "환율 안정": [],
  };
  const stocks: BetBacktest["stocks"] = [];

  for (const s of codes) {
    /*
     * 매수는 고른 장의 종가로, **매도는 언제나 다음날 KRX 시가/종가**로 친다.
     * NXT 새벽에 팔 수는 없으니 파는 쪽은 정규장이 기준이어야 실제와 맞는다.
     */
    const [rows, exitRows] = await Promise.all([
      krCandles(client, venue === "nxt" ? `${s.code}_NX` : s.code).catch(() => []),
      venue === "nxt" ? krCandles(client, s.code).catch(() => []) : Promise.resolve([]),
    ]);
    const exitBy = new Map((venue === "nxt" ? exitRows : rows).map((r) => [r.date, r]));
    await new Promise((r) => setTimeout(r, 260));
    if (rows.length < 2) continue;

    let used = 0;
    // 마지막 봉은 「다음날」이 없어서 못 센다
    for (let i = Math.max(1, rows.length - days); i < rows.length - 1; i++) {
      const buy = rows[i];
      // 파는 날은 KRX 기준이다 — NXT 로 샀어도 다음날 정규장에 판다
      const next = exitBy.get(rows[i + 1].date) ?? rows[i + 1];
      /*
       * **전날 미국장의 조건을 본다.**
       * 한국 종가배팅은 「어젯밤 미국이 어땠나」를 보고 오늘 종가에 사는 것이 아니라,
       * 오늘 종가에 사서 **오늘 밤 미국**을 지나 내일 아침을 맞는다.
       * 그러므로 매수일과 **같은 날짜**의 미국 선물이 그 밤의 방향이다.
       */
      const g = gaugeBy.get(buy.date);
      if (!g) continue;
      const b = benchBy.get(buy.date) ?? null;
      const r: Row = {
        open: ((next.open - buy.close) / buy.close) * 100,
        close: ((next.close - buy.close) / buy.close) * 100,
        benchOpen: b?.open ?? null,
        benchClose: b?.close ?? null,
      };
      used += 1;

      const okFut = g.futuresBody !== null && g.futuresBody >= cond.futuresMin;
      const okOil = g.oilMove === null || Math.abs(g.oilMove) <= cond.oilMax;
      const okFx = g.fxMove === null || Math.abs(g.fxMove) <= cond.fxMax;

      if (okFut && okOil && okFx) matched.push(r);
      else unmatched.push(r);
      if (okFut) byCond["선물 양봉"].push(r);
      if (okOil) byCond["유가 안정"].push(r);
      if (okFx) byCond["환율 안정"].push(r);
    }
    stocks.push({ code: s.code, name: s.name, days: used });
  }

  return {
    venue,
    stocks,
    matched: summarize("조건 맞음", matched),
    unmatched: summarize("조건 안 맞음", unmatched),
    perCondition: Object.entries(byCond).map(([k, v]) => summarize(k, v)),
    condition: cond,
    benchDays: benchBy.size,
    note:
      matched.length === 0
        ? "조건에 맞는 날이 없습니다. 조건을 느슨하게 해 보세요."
        : `${stocks.length}종목 · 최근 ${days}거래일. **생존편향이 있습니다** — 지금 고른 종목의 과거만 봅니다.`,
  };
}
