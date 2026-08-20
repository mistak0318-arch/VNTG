import { useEffect, useState } from "react";
import { api, fmtNum, type RawRecord } from "../api";
import type { Candle } from "./CandleChart";
import { useChartPrefs } from "../useChartPrefs";
import { toCandles } from "./chartCandles";

/**
 * 차트 위에 붙는 판독 줄.
 *
 * 캔들만 보고 "5일선이 20일선 위인가", "위에 매물이 얼마나 걸려 있나"를 눈으로 세는 건
 * 사람이 할 일이 아니다. 차트를 여는 순간 같이 나와야 한다.
 *
 * **추가 조회가 없다.** 전부 일봉 하나에서 나온다 — 이동평균도, 52주 위치도,
 * 거래량 배수도, 매물대도. 차트가 이미 받아 둔 배열을 그대로 넘겨받아 계산한다.
 * 다른 봉(주·월·분)을 보고 있을 때만 일봉을 따로 받는다. 「5일선」은 5거래일이라
 * 주봉으로 재면 5주선이 되기 때문이다.
 */

/** 가격대를 몇 칸으로 자를지 */
const BANDS = 14;

const MA_PERIODS = [5, 20, 60, 120] as const;

interface Band {
  /** 칸의 아래·위 가격 */
  from: number;
  to: number;
  volume: number;
  /** 전체 대비 비중 (0~1) */
  share: number;
}

interface Insights {
  price: number;
  ma: Record<number, number | null>;
  /** 정배열이면 "up", 역배열이면 "down", 아니면 null */
  order: "up" | "down" | null;
  /** 5일선이 20일선 위인가 */
  fastAbove: boolean | null;
  /** 마지막 교차가 며칠 전이었나 (교차를 못 찾으면 null) */
  crossAgo: number | null;
  /** 마지막 교차가 골든이었나 */
  crossGolden: boolean | null;
  /** 52주(250거래일) 최고·최저와 그 사이에서의 위치(0~1) */
  yearHigh: number | null;
  yearLow: number | null;
  yearPos: number | null;
  /** 오늘 거래량이 20일 평균의 몇 배인가 */
  volRatio: number | null;
  bands: Band[];
  /** 가장 두꺼운 칸 */
  heaviest: Band | null;
  /**
   * 현재가 **위쪽에서** 가장 두꺼운 칸.
   *
   * 크게 오른 종목은 가장 두꺼운 칸이 한참 아래에 있어(−40% 같은) 볼 일이 없다.
   * 차트를 보며 알고 싶은 건 "올라가면 어디서 막히나"다 — 그게 이것이다.
   */
  wall: Band | null;
  /** 현재가보다 위에 쌓인 물량의 비중 (0~1) */
  overhead: number | null;
}

/** 매물대 막대를 몇 줄까지 보여줄지 */
const SHOW_BANDS = 5;

/**
 * 보여줄 매물대 칸을 고른다 — **묻는 것에 답하는 칸만.**
 *
 * 열네 칸을 다 그리면 화면을 잡아먹으면서 정작 답은 안 준다.
 * 차트 옆에서 매물대를 볼 때 알고 싶은 건 셋뿐이다:
 *
 *   · 지금 내가 선 칸은 어디인가
 *   · 올라가면 어디서 막히나 (위쪽 벽)
 *   · 제일 두꺼운 데는 어디인가
 *
 * 이 셋을 먼저 확보하고 남는 자리를 두꺼운 순으로 채운다.
 * 마지막에 **가격 순으로 되돌린다** — 두꺼운 순으로 늘어놓으면 위아래 관계가
 * 사라져서 매물대가 아니라 순위표가 된다.
 */
function pickBands(ins: Insights): Band[] {
  const bands = ins.bands;
  if (bands.length <= SHOW_BANDS) return [...bands].reverse();

  const must = new Set<Band>();
  const here = bands.find((b) => ins.price >= b.from && ins.price < b.to);
  for (const b of [here, ins.wall, ins.heaviest]) if (b) must.add(b);

  // 남는 자리는 두꺼운 순으로
  for (const b of [...bands].sort((a, c) => c.volume - a.volume)) {
    if (must.size >= SHOW_BANDS) break;
    must.add(b);
  }

  // 비싼 가격이 위로 오게 — 화면에서는 위가 높은 값이다
  return bands.filter((b) => must.has(b)).reverse();
}

/** 마지막 n개의 평균. 모자라면 null — 없는 걸 있는 척하면 안 된다 */
function sma(values: number[], n: number, end: number): number | null {
  if (end + 1 < n) return null;
  let sum = 0;
  for (let i = end - n + 1; i <= end; i++) sum += values[i];
  return sum / n;
}

function compute(candles: Candle[], profileDays: number): Insights | null {
  if (candles.length === 0) return null;
  const closes = candles.map((c) => c.close);
  const last = candles.length - 1;
  const price = closes[last];

  const ma: Record<number, number | null> = {};
  for (const p of MA_PERIODS) ma[p] = sma(closes, p, last);

  /*
   * 정배열은 **현재가부터** 따진다. 이동평균끼리만 줄을 세우면
   * 주가가 이미 5일선을 깨고 내려온 날도 정배열로 나온다.
   */
  const chain = [price, ...MA_PERIODS.map((p) => ma[p])].filter(
    (v): v is number => v !== null,
  );
  const desc = chain.every((v, i) => i === 0 || chain[i - 1] >= v);
  const asc = chain.every((v, i) => i === 0 || chain[i - 1] <= v);
  const order = chain.length >= 3 ? (desc ? "up" : asc ? "down" : null) : null;

  // 5일선과 20일선의 자리바꿈을 거슬러 찾는다
  let fastAbove: boolean | null = null;
  let crossAgo: number | null = null;
  let crossGolden: boolean | null = null;
  const diffAt = (i: number): number | null => {
    const f = sma(closes, 5, i);
    const s = sma(closes, 20, i);
    return f === null || s === null ? null : f - s;
  };
  const nowDiff = diffAt(last);
  if (nowDiff !== null) {
    fastAbove = nowDiff > 0;
    for (let i = last - 1; i >= 0 && last - i <= 250; i--) {
      const d = diffAt(i);
      if (d === null) break;
      if (d > 0 !== nowDiff > 0) {
        crossAgo = last - i;
        crossGolden = nowDiff > 0;
        break;
      }
    }
  }

  // 52주 — 거래일로 250일. 데이터가 짧으면 있는 만큼만 본다
  const yearWin = candles.slice(-250);
  const yearHigh = yearWin.length > 0 ? Math.max(...yearWin.map((c) => c.high)) : null;
  const yearLow = yearWin.length > 0 ? Math.min(...yearWin.map((c) => c.low)) : null;
  const yearPos =
    yearHigh !== null && yearLow !== null && yearHigh > yearLow
      ? (price - yearLow) / (yearHigh - yearLow)
      : null;

  // 오늘 거래량이 평소의 몇 배인지. 오늘은 빼고 20일 평균을 낸다
  let volRatio: number | null = null;
  if (candles.length >= 21) {
    const prev = candles.slice(-21, -1);
    const avg = prev.reduce((s, c) => s + c.volume, 0) / prev.length;
    if (avg > 0) volRatio = candles[last].volume / avg;
  }

  /*
   * 매물대.
   *
   * 하루 거래량을 **그날 고가~저가에 고르게 흩는다.** 종가 한 점에 몰아넣으면
   * 위아래로 크게 흔든 날의 물량이 실제로 손바뀜한 구간을 못 잡는다.
   * 체결 단위 자료가 아니므로 근사지만, 어느 가격대가 두꺼운지를 보는 데는 충분하다.
   */
  const win = candles.slice(-profileDays);
  const lo = Math.min(...win.map((c) => c.low));
  const hi = Math.max(...win.map((c) => c.high));
  const bands: Band[] = [];
  let heaviest: Band | null = null;
  let wall: Band | null = null;
  let overhead: number | null = null;

  if (hi > lo) {
    const step = (hi - lo) / BANDS;
    const vol = new Array<number>(BANDS).fill(0);
    for (const c of win) {
      const from = Math.min(BANDS - 1, Math.max(0, Math.floor((c.low - lo) / step)));
      const to = Math.min(BANDS - 1, Math.max(0, Math.floor((c.high - lo) / step)));
      const each = c.volume / (to - from + 1);
      for (let i = from; i <= to; i++) vol[i] += each;
    }
    const total = vol.reduce((s, v) => s + v, 0);
    for (let i = 0; i < BANDS; i++) {
      bands.push({
        from: lo + step * i,
        to: lo + step * (i + 1),
        volume: vol[i],
        share: total > 0 ? vol[i] / total : 0,
      });
    }
    heaviest = bands.reduce((a, b) => (b.volume > a.volume ? b : a), bands[0]);
    // 현재가가 걸친 칸은 이미 지나는 중이라 벽으로 치지 않는다
    const aboveBands = bands.filter((b) => b.from > price);
    wall =
      aboveBands.length > 0 ? aboveBands.reduce((a, b) => (b.volume > a.volume ? b : a)) : null;

    if (total > 0) {
      // 현재가가 걸친 칸은 걸친 만큼만 위로 친다
      let stacked = 0;
      for (const b of bands) {
        if (b.from >= price) stacked += b.volume;
        else if (b.to > price) stacked += (b.volume * (b.to - price)) / (b.to - b.from);
      }
      overhead = stacked / total;
    }
  }

  return {
    price,
    ma,
    order,
    fastAbove,
    crossAgo,
    crossGolden,
    yearHigh,
    yearLow,
    yearPos,
    volRatio,
    bands,
    heaviest,
    wall,
    overhead,
  };
}

/** 현재가 대비 몇 % 떨어져 있는지 */
function gap(from: number, to: number): string {
  const v = ((to - from) / from) * 100;
  return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

export function ChartInsights({
  code,
  candles,
}: {
  code: string;
  /**
   * 차트가 이미 일봉을 받아 놨으면 그대로 넘긴다 — 같은 걸 두 번 받지 않으려는 것이다.
   * 주봉·월봉·분봉을 보고 있을 때는 넘기지 않고, 여기서 일봉을 따로 받는다.
   */
  candles?: Candle[];
}) {
  const { prefs } = useChartPrefs();
  const [own, setOwn] = useState<Candle[] | null>(null);
  const need = candles === undefined;

  useEffect(() => {
    if (!need || !code) return;
    let alive = true;
    setOwn(null);
    void (async () => {
      try {
        const raw = (await api.dailyChart(code)) as RawRecord;
        if (alive) setOwn(toCandles(raw, "day"));
      } catch {
        // 판독 줄 하나 때문에 차트가 막히면 안 된다
      }
    })();
    return () => {
      alive = false;
    };
  }, [need, code]);

  const rows = candles ?? own;
  const ins = rows ? compute(rows, prefs.profileDays) : null;
  if (!ins) return null;

  const orderLabel =
    ins.order === "up" ? "정배열" : ins.order === "down" ? "역배열" : "혼조";
  const orderClass = ins.order === "up" ? "up" : ins.order === "down" ? "down" : "mix";

  return (
    <div className="ci-wrap">
      {/* ---- 이동평균 ---- */}
      <div className="ci-col">
        <div className="ci-head">
          <span className={`ci-order ${orderClass}`}>{orderLabel}</span>
          {ins.fastAbove !== null && (
            <span className={`ci-cross ${ins.fastAbove ? "up" : "down"}`}>
              5일선이 20일선 {ins.fastAbove ? "위" : "아래"}
              {ins.crossAgo !== null && (
                <span className="pt-n">
                  {" "}
                  · {ins.crossGolden ? "골든" : "데드"}크로스 {ins.crossAgo}일 전
                </span>
              )}
            </span>
          )}
        </div>

        <div className="ci-ma">
          {MA_PERIODS.map((p) => {
            const v = ins.ma[p];
            const above = v !== null && ins.price >= v;
            return (
              <div key={p} className={`ci-ma-item ${v === null ? "none" : above ? "up" : "down"}`}>
                <span className="ci-ma-label">{p}일</span>
                <span className="ci-ma-value">{v === null ? "-" : fmtNum(Math.round(v))}</span>
                {/* 이격도 — 선에서 얼마나 벌어져 있나. 붙어 있으면 곧 방향이 갈린다 */}
                <span className="ci-ma-gap">{v === null ? "" : gap(v, ins.price)}</span>
              </div>
            );
          })}
        </div>

        <div className="ci-facts">
          {ins.yearHigh !== null && ins.yearLow !== null && (
            <span>
              52주 {fmtNum(Math.round(ins.yearLow))} ~ {fmtNum(Math.round(ins.yearHigh))}
              {ins.yearPos !== null && (
                <b className="ci-pos"> 아래서 {Math.round(ins.yearPos * 100)}% 자리</b>
              )}
              <span className="pt-n">
                {" "}
                · 고점까지 {gap(ins.price, ins.yearHigh)}
              </span>
            </span>
          )}
          {ins.volRatio !== null && (
            <span>
              거래량 20일 평균의{" "}
              <b className={ins.volRatio >= 2 ? "positive" : ins.volRatio < 0.5 ? "negative" : ""}>
                {ins.volRatio.toFixed(1)}배
              </b>
            </span>
          )}
        </div>
      </div>

      {/* ---- 매물대 ---- */}
      {prefs.profileOn && ins.heaviest && (
        <div className="ci-col ci-profile">
          <div className="ci-head">
            <span className="ci-title">매물대 {prefs.profileDays}일</span>
            {ins.overhead !== null && (
              <span
                className={`ci-overhead ${ins.overhead >= 0.5 ? "heavy" : ins.overhead <= 0.2 ? "light" : ""}`}
                title="현재가보다 위에서 손바뀜한 물량의 비중. 높을수록 오를 때 팔 사람이 많다"
              >
                위쪽 매물 {Math.round(ins.overhead * 100)}%
              </span>
            )}
          </div>

          <div className="ci-bars">
            {/*
              **열네 칸을 다 뿌리지 않는다.**

              칸을 전부 그리면 화면 반쪽이 막대로 덮이는데, 그 중 눈이 실제로 쓰는 건
              서너 줄뿐이다 — 지금 어디 서 있나, 올라가면 어디서 막히나, 제일 두꺼운 데가 어디냐.
              나머지 열 줄은 **스크롤만 늘리고 답은 안 준다.**

              그래서 꼭 필요한 칸(현재가·위쪽 벽·가장 두꺼운 곳)은 반드시 남기고,
              남는 자리를 두꺼운 순서로 채운다. 고른 뒤에는 **다시 가격 순으로** 세워야
              위아래 관계가 읽힌다(두꺼운 순으로 늘어놓으면 매물대가 아니라 순위표가 된다).
            */}
            {pickBands(ins).map((b, i) => {
              const max = ins.heaviest?.volume ?? 1;
              const top = b === ins.heaviest;
              const wall = b === ins.wall;
              const here = ins.price >= b.from && ins.price < b.to;
              return (
                <div
                  key={i}
                  className={`ci-bar-row${top ? " top" : ""}${wall ? " wall" : ""}${here ? " here" : ""}`}
                >
                  <span className="ci-bar-price">{fmtNum(Math.round(b.to))}</span>
                  {/*
                    칸마다 현재가에서 몇 % 떨어져 있는지. 가격만 있으면 그때그때 암산해야 한다 —
                    「1,740,714」보다 「+10.9%」가 먼저 읽힌다.
                    칸의 가운데를 기준으로 잰다(위아래 끝을 쓰면 같은 칸인데 값이 달라진다).
                  */}
                  <span className={`ci-bar-gap ${(b.from + b.to) / 2 >= ins.price ? "up" : "down"}`}>
                    {gap(ins.price, (b.from + b.to) / 2)}
                  </span>
                  <span className="ci-bar-track">
                    <span
                      className="ci-bar-fill"
                      style={{ width: `${max > 0 ? (b.volume / max) * 100 : 0}%` }}
                    />
                  </span>
                  <span className="ci-bar-share">{(b.share * 100).toFixed(0)}%</span>
                </div>
              );
            })}
          </div>

          <div className="ci-facts">
            {/* 올라가면 어디서 막히나 — 차트를 보며 가장 알고 싶은 것이라 맨 위에 둔다 */}
            {ins.wall ? (
              <span>
                위쪽 벽{" "}
                <b>
                  {fmtNum(Math.round(ins.wall.from))} ~ {fmtNum(Math.round(ins.wall.to))}
                </b>{" "}
                <span className="pt-n">
                  ({gap(ins.price, (ins.wall.from + ins.wall.to) / 2)} ·
                  전체의 {Math.round(ins.wall.share * 100)}%)
                </span>
              </span>
            ) : (
              <span className="pt-n">위쪽에 쌓인 물량이 없습니다 — 이 구간이 신고가입니다</span>
            )}
            <span>
              가장 두꺼운 곳{" "}
              <b>
                {fmtNum(Math.round(ins.heaviest.from))} ~ {fmtNum(Math.round(ins.heaviest.to))}
              </b>{" "}
              <span className="pt-n">
                ({gap(ins.price, (ins.heaviest.from + ins.heaviest.to) / 2)} ·
                전체의 {Math.round(ins.heaviest.share * 100)}%)
              </span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
