import { useEffect, useMemo, useState } from "react";
import { api } from "../api";

/**
 * 시간별 수급 — **선 + 표.** 거래원과 프로그램매매가 같이 쓴다.
 *
 * ## 막대를 버린 이유
 *
 * 예전에는 구간 증감을 0선 위아래 막대로 그렸다. 문제는 **정규화**다 —
 * 막대 높이는 그날 최대 증감에 맞춰 그리므로, 9시 5분에 한 번 크게 들어오면
 * 나머지 하루가 전부 1px 가 된다. 「어떤 게 튀는지」만 보이고 **「나머지가 서로
 * 어떻게 다른지」가 안 보인다.**
 *
 * HTS 가 이걸 어떻게 푸는지는 분명하다. 증감 막대가 아니라 **누적 순매수를 선**으로
 * 그리고, 눈금을 **데이터 범위에 맞춘다** — 0을 억지로 넣지 않는다. HTS 화면의
 * 눈금이 `-8,984 ~ -9,091` 인 게 그 뜻이다. 하루 종일 순매도인 종목이라도 그 안에서의
 * 오르내림이 보인다. 0을 넣었으면 저 선은 납작한 일직선이 됐을 것이다.
 *
 * ## 표를 같이 두는 이유
 *
 * 그림은 모양을 주고 **표는 값을 준다.** HTS 도 표가 본체고 그림은 접었다 편다.
 * 「15:20 에 순매수가 얼마였나」는 그림에서 못 읽는다. 그래서 시간·매도·매수·순매수를
 * **최신이 위로** 줄줄이 적는다.
 *
 * ## 「분 단위로 쭉」
 *
 * 서버는 30초에 한 점씩 쌓는다. 그대로 적으면 한 시간에 120줄이라 눈이 못 따라간다.
 * 기본은 **1분에 한 줄**(그 분의 마지막 값 — 누적값이므로 마지막이 그 분의 결과다)로
 * 묶고, 촘촘히 보고 싶으면 30초로 푼다.
 *
 * ## 값이 누적이라는 것
 *
 * 여기 들어오는 `buy`·`sell`·`net` 은 **그 시점까지의 누적**이다(키움이 그렇게 준다).
 * 증감은 앞 줄과의 차이로 우리가 낸다 — 「지금 붙고 있나」는 그 차이에 있다.
 */

export interface FlowSample {
  /** HHmmss 또는 HHmm */
  t: string;
  /** 그 시점까지의 누적 매수 */
  buy: number;
  /** 그 시점까지의 누적 매도 */
  sell: number;
  /** 그 시점까지의 누적 순매수 — 키움이 직접 주면 그 값(빼서 만들면 어긋난다) */
  net: number;
}

/** 서버가 주는 시계열 한 덩어리 — 어느 날 것인지까지 */
export interface FlowSeriesData {
  pts: FlowSample[];
  /** YYYY-MM-DD (한국시간) */
  day: string;
  /** 오늘이 아니라 지난 장 것인가 */
  stale: boolean;
}

const WEEKDAY = ["일", "월", "화", "수", "목", "금", "토"];

/**
 * `2026-08-21` → `8월 21일 (금)`.
 *
 * 요일을 같이 적는 이유는 **주말에 열면 금요일 것이 나오기** 때문이다.
 * 날짜만 적으면 그게 지난 장인지 오늘인지 한 번 더 세어봐야 한다.
 *
 * 요일은 UTC 로 계산한다 — 날짜만 있는 문자열에 시간대를 붙이면 하루가 밀린다.
 */
export function dayLabel(day: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return day;
  const d = new Date(`${day}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return day;
  return `${Number(day.slice(5, 7))}월 ${Number(day.slice(8, 10))}일 (${WEEKDAY[d.getUTCDay()]})`;
}

const W = 320;
const H = 104;
const PAD = { t: 8, b: 8 };

/** 몇 분에 한 줄 — 0 이면 안 묶는다(30초 원본) */
const STEPS: [number, string][] = [
  [1, "1분"],
  [3, "3분"],
  [5, "5분"],
  [0, "30초"],
];

function hhmm(t: string): string {
  return t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : t;
}

function hhmmss(t: string): string {
  return t.length >= 6 ? `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}` : hhmm(t);
}

function mins(t: string): number {
  return Number(t.slice(0, 2)) * 60 + Number(t.slice(2, 4));
}

/**
 * 큰 수를 짧게 — **단위와 겹치지 않게.**
 *
 * ⚠️ 여기서 한 번 데였다. 값이 「백만원」 단위인데 만/억으로 또 줄여 붙였더니
 * **「+7.8만백만」**이 나왔다. 단위를 아는 쪽에서 자릿수를 정한다.
 */
export function shortAmt(v: number, unit: string): string {
  const a = Math.abs(v);
  if (unit === "백만") {
    if (a >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}조원`;
    if (a >= 100) return `${Math.round(v / 100).toLocaleString("ko-KR")}억원`;
    return `${Math.round(v).toLocaleString("ko-KR")}백만원`;
  }
  if (a >= 10_000) return `${(v / 10_000).toFixed(1)}만${unit}`;
  return `${Math.round(v).toLocaleString("ko-KR")}${unit}`;
}

function num(v: number): string {
  return Math.round(v).toLocaleString("ko-KR");
}

export function FlowSeries({
  samples,
  unit = "",
  /** 표 머리에 적을 단위 안내 — 「금액(백만)」처럼 */
  unitLabel,
  /** 오늘이 아니면 어느 장 것인지 (YYYY-MM-DD) */
  asOf,
  /** HHmm → 그 시각 주가. 있으면 표에 추정가격, 그림에 주가 선이 붙는다 */
  price,
}: {
  samples: FlowSample[];
  unit?: string;
  unitLabel?: string;
  asOf?: string;
  price?: Map<string, number>;
}) {
  const [step, setStep] = useState(1);
  /** 누른 줄 — 그림과 표가 같이 표시된다 */
  const [at, setAt] = useState<number | null>(null);
  /** HTS 처럼 **표가 먼저**고 그림은 버튼으로 연다 */
  const [chart, setChart] = useState(true);

  /* 분 단위로 묶는다 — 누적값이므로 그 분의 **마지막** 점이 그 분의 결과다 */
  const rows = useMemo(() => {
    if (step === 0) return samples;
    const byBucket = new Map<number, FlowSample>();
    for (const s of samples) {
      if (s.t.length < 4) continue;
      byBucket.set(Math.floor(mins(s.t) / step), s);
    }
    return [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
  }, [samples, step]);

  if (rows.length === 0) return null;

  const vals = rows.map((r) => r.net);
  let min = Math.min(...vals);
  let max = Math.max(...vals);
  if (min === max) {
    // 하루 종일 한 값 — 납작한 선이 화면 밖으로 나가지 않게
    min -= 1;
    max += 1;
  }
  /*
   * ⚠️ 0을 억지로 넣지 않는다. 하루 종일 순매도인 종목에 0을 끼우면
   * 선이 위쪽에 붙은 일직선이 되어 **그 안의 오르내림이 통째로 사라진다.**
   */
  const ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ((max - v) / (max - min)) * ih;
  const x = (i: number) => (rows.length === 1 ? W / 2 : (i / (rows.length - 1)) * W);
  const line = rows.map((r, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(r.net)}`).join("");
  const last = rows[rows.length - 1];
  const zeroIn = min < 0 && max > 0;

  /*
   * 주가 선. **눈금이 따로다** — 순매수는 억 단위고 주가는 원 단위라 한 눈금에 그리면
   * 둘 중 하나가 납작해진다. HTS 도 좌우로 눈금을 나눠 그린다.
   */
  const prices = price ? rows.map((r) => price.get(r.t.slice(0, 4)) ?? null) : [];
  const pv = prices.filter((p): p is number => p !== null);
  const pmin = pv.length > 0 ? Math.min(...pv) : 0;
  const pmax = pv.length > 0 ? Math.max(...pv) : 0;
  const py = (v: number) =>
    pmax === pmin ? PAD.t + ih / 2 : PAD.t + ((pmax - v) / (pmax - pmin)) * ih;
  /* 값이 빈 구간에서 선을 끊는다 — 없는 값을 이어 그리면 없던 움직임이 생긴다 */
  let pstarted = false;
  const priceLine = prices
    .map((p, i) => {
      if (p === null) {
        pstarted = false;
        return "";
      }
      const cmd = pstarted ? "L" : "M";
      pstarted = true;
      return `${cmd}${x(i)},${py(p)}`;
    })
    .join("");

  /* 총매도 → 총매수로 돌아선 자리 */
  const crosses: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1].net;
    const b = rows[i].net;
    if ((a < 0 && b >= 0) || (a > 0 && b <= 0)) crosses.push(i);
  }

  /* 표는 최신이 위 — HTS 와 같다. 증감은 앞 줄과의 차이 */
  const table = rows
    .map((r, i) => ({ ...r, delta: i === 0 ? 0 : r.net - rows[i - 1].net, i }))
    .reverse();

  const picked = at === null ? null : rows[at];

  return (
    <div className="fs">
      {/* 지난 장 것이면 반드시 적는다 — 오늘인 척 보여주면 안 된다 */}
      {asOf && (
        <div className="fs-asof">
          <b>{dayLabel(asOf)}</b> 장 기준입니다 — 오늘은 쌓인 게 없습니다
        </div>
      )}

      <div className="fs-top">
        <span className="fs-sum">
          <span className="pt-n">누적 순매수 </span>
          <b className={last.net >= 0 ? "positive" : "negative"}>
            {last.net > 0 ? "+" : ""}
            {shortAmt(last.net, unit)}
          </b>
        </span>
        <span className="fs-steps">
          {STEPS.map(([v, l]) => (
            <button
              key={v}
              className={`filter-btn ${step === v ? "active" : ""}`}
              onClick={() => {
                setStep(v);
                setAt(null);
              }}
            >
              {l}
            </button>
          ))}
          {/* HTS 오른쪽 끝의 그 버튼 — 표가 본체고 그림은 켜고 끈다 */}
          <button
            className={`filter-btn ${chart ? "active" : ""}`}
            onClick={() => setChart(!chart)}
            title="그림으로 보기"
          >
            📈
          </button>
        </span>
      </div>

      <div className="fs-wrap">
        <table className="data-table num fs-table">
          <thead>
            <tr>
              <th className="sticky-col">시간</th>
              <th>매도{unitLabel ? ` ${unitLabel}` : ""}</th>
              <th>매수{unitLabel ? ` ${unitLabel}` : ""}</th>
              <th title="그 시점까지의 누적. 작은 글씨는 앞 줄 대비 증감입니다">순매수</th>
              {price && <th title="그 시각 분봉 종가">추정가격</th>}
            </tr>
          </thead>
          <tbody>
            {table.map((r) => (
              <tr
                key={`${r.t}-${r.i}`}
                className={`clickable-row${at === r.i ? " on" : ""}`}
                onClick={() => setAt(at === r.i ? null : r.i)}
              >
                <td className="sticky-col">{hhmmss(r.t)}</td>
                <td className="negative">{r.sell === 0 ? "-" : num(r.sell)}</td>
                <td className="positive">{r.buy === 0 ? "-" : num(r.buy)}</td>
                <td className={r.net >= 0 ? "positive" : "negative"}>
                  <b>{num(r.net)}</b>
                  {r.delta !== 0 && (
                    <i className={`fs-d ${r.delta > 0 ? "up" : "down"}`}>
                      {r.delta > 0 ? "+" : ""}
                      {num(r.delta)}
                    </i>
                  )}
                </td>
                {price && (
                  <td className="pt-n">
                    {price.get(r.t.slice(0, 4)) === undefined
                      ? "-"
                      : num(price.get(r.t.slice(0, 4)) as number)}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {chart && (
        <>
          <div className="fs-chart">
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
              {zeroIn && <line className="fs-zero" x1={0} x2={W} y1={y(0)} y2={y(0)} />}
              {/* 주가를 먼저 깔고 순매수를 위에 — 보려는 건 수급이다 */}
              {priceLine && <path className="fs-price" d={priceLine} />}
              <path className={`fs-line ${last.net >= 0 ? "up" : "down"}`} d={line} />
              {crosses.map((i) => (
                <circle key={`x-${i}`} className="fs-cross" cx={x(i)} cy={y(rows[i].net)} r={2.5} />
              ))}
              {at !== null && (
                <>
                  <line className="fs-cursor" x1={x(at)} x2={x(at)} y1={0} y2={H} />
                  <circle className="fs-dot" cx={x(at)} cy={y(rows[at].net)} r={3} />
                </>
              )}
              {/* 눌러서 고르는 자리 — 선은 얇아서 손가락으로 못 짚는다 */}
              {rows.map((r, i) => (
                <rect
                  key={`h-${r.t}-${i}`}
                  className="fs-hit"
                  x={x(i) - W / rows.length / 2}
                  y={0}
                  width={W / rows.length}
                  height={H}
                  onPointerDown={() => setAt(at === i ? null : i)}
                />
              ))}
            </svg>
            {/* 눈금은 HTML 로 — viewBox 를 늘려 그리므로 SVG 글자는 찌그러진다 */}
            <span className="fs-y hi">{shortAmt(max, unit)}</span>
            <span className="fs-y lo">{shortAmt(min, unit)}</span>
            {pv.length > 1 && (
              <>
                <span className="fs-y price hi">{num(pmax)}</span>
                <span className="fs-y price lo">{num(pmin)}</span>
              </>
            )}
          </div>

          <div className="fs-legend">
            <span>{hhmm(rows[0].t)}</span>
            <span className="fs-mid">
              {picked ? (
                <>
                  {hhmmss(picked.t)}{" "}
                  <b className={picked.net >= 0 ? "positive" : "negative"}>
                    {picked.net > 0 ? "+" : ""}
                    {num(picked.net)}
                  </b>
                </>
              ) : (
                <>
                  <b className="fs-k net">순매수</b>
                  {pv.length > 1 && <b className="fs-k price">주가</b>}
                  <span className="pt-n"> · 눈금은 각자 제 범위로</span>
                </>
              )}
            </span>
            <span>{hhmm(last.t)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * 분봉 종가 — **주가 선과 추정가격 칸의 재료.**
 *
 * 실시간 체결(`0B`)로도 낼 수 있지만 그건 **구독한 순간부터**라 과거가 빈다.
 * 분봉(`ka10080`)은 조회라 **하루가 통째로** 있고, 지난 장을 되짚어 볼 때도 그대로 맞는다.
 */
export function useMinutePrices(code: string, day?: string): Map<string, number> {
  const [map, setMap] = useState<Map<string, number>>(new Map());

  useEffect(() => {
    if (!code) {
      setMap(new Map());
      return;
    }
    let alive = true;
    void (async () => {
      try {
        const j = (await api.minuteChart(code, "1")) as {
          stk_min_pole_chart_qry?: { cntr_tm?: string; cur_prc?: string }[];
        };
        if (!alive) return;

        /*
         * ⚠️ **분봉은 며칠치가 함께 온다.**
         *
         * 이걸 모르고 `HHmm` 만 키로 담았더니 **이틀 전 15:35 가 오늘 15:35 를 덮어썼다** —
         * 삼성전자 오늘 종가가 281,500 인데 표에 247,500(이틀 전 값)이 찍혔다.
         *
         * 그래서 **날짜를 먼저 고르고** 그 하루의 분봉만 담는다. 볼 장(`day`)을 주면 그날,
         * 안 주면 응답에서 가장 최근 날짜다.
         */
        const rows = (j.stk_min_pole_chart_qry ?? [])
          .map((r) => ({
            tm: String(r.cntr_tm ?? ""),
            price: Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,\s]/g, "")) || 0),
          }))
          .filter((r) => r.tm.length >= 12 && r.price > 0);
        if (rows.length === 0) {
          setMap(new Map());
          return;
        }
        const want = day ? day.replace(/-/g, "") : "";
        const dates = new Set(rows.map((r) => r.tm.slice(0, 8)));
        const pick = want && dates.has(want) ? want : [...dates].sort().pop();

        const next = new Map<string, number>();
        for (const r of rows) {
          if (r.tm.slice(0, 8) !== pick) continue;
          next.set(r.tm.slice(8, 12), r.price);
        }
        setMap(next);
      } catch {
        /* 주가 선이 없어도 수급 표는 그대로 나온다 */
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, day]);

  return map;
}
