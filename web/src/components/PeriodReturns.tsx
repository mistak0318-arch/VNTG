import { useEffect, useState } from "react";
import { api, type RawRecord } from "../api";

/**
 * 기간별 상승률 — 5·10·20·60·120일.
 *
 * 헤더가 보여 주던 건 **오늘 하루** 뿐이었다. 그런데 오늘 +2.65% 가 무슨 뜻인지는
 * 그것만 봐선 알 수 없다. 두 달을 흘러내리다 하루 튄 것과, 석 달째 계단으로 오르는 중인
 * 것이 화면에서 똑같이 생겼다.
 *
 * 기간은 **거래일** 기준이다(달력일이 아니다). 5일≈일주일, 20일≈한 달, 60일≈분기,
 * 120일≈반년. 이동평균선과 같은 눈금이라 「20일선 위」 같은 판단과 바로 이어진다.
 *
 * 값은 이미 있는 일봉(ka10081, 수정주가 반영)에서 계산한다 — 액면분할·유상증자가
 * 섞인 구간에서 원주가로 재면 없는 폭락이 보인다.
 */

const PERIODS = [
  { days: 5, label: "5일" },
  { days: 10, label: "10일" },
  { days: 20, label: "20일" },
  { days: 60, label: "60일" },
  { days: 120, label: "120일" },
];

/**
 * 거래가 있었던 가장 최근 날의 값.
 *
 * `ka10001` 은 **개장 전에 당일 행을 0 으로 준다** — 새벽에 열면 시가·고가·저가·거래량이
 * 전부 0 이고 종가만 남는다. 그런데 종가는 전일 것이라, 화면이 "종가 217,000 / 거래량 0"
 * 처럼 짝이 안 맞는 말을 하게 된다.
 *
 * 일봉에서 **실제로 거래가 있었던 마지막 날**을 골라 그 값으로 메운다.
 */
export interface LastSession {
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** 거래대금 (백만원) */
  value: number | null;
  /** **그날의** 전일종가. 시가·고가·저가 등락률은 이걸 기준으로 재야 한다 */
  base: number | null;
}

interface Point {
  days: number;
  label: string;
  rate: number | null;
  /** 실제로 몇 거래일 전과 견줬는지 — 상장 초기 종목은 요구 기간을 못 채운다 */
  actual: number;
}

export function PeriodReturns({
  code,
  onTradeValue,
}: {
  code: string;
  /*
   * 거래대금을 위쪽 시세 요약으로 올려 준다.
   *
   * 거래대금은 일봉에만 있는데(`trde_prica`, 백만원), 그 일봉을 이미 여기서 받고 있다.
   * 위에서 따로 부르면 같은 응답을 두 번 받게 되므로 받은 김에 넘긴다.
   *
   * ka10001 의 `sale_amt` 를 쓰면 안 된다 — 이름만 비슷하고 값이 다르다.
   * NAVER 08/18 기준 sale_amt 는 120,350 인데 실제 거래대금은 181,268(백만원)이다.
   */
  onTradeValue?: (v: LastSession | null) => void;
}) {
  const [points, setPoints] = useState<Point[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setPoints(null);
    setFailed(false);

    api
      .dailyChart(code)
      .then((d: RawRecord) => {
        if (!alive) return;
        const rows = (d.stk_dt_pole_chart_qry as RawRecord[] | undefined) ?? [];
        // 키움 일봉은 최신이 앞이다. 종가에 부호가 붙어 나오는 자리가 있어 절댓값을 쓴다
        const closes = rows
          .map((r) => Math.abs(Number(r.cur_prc)))
          .filter((n) => Number.isFinite(n) && n > 0);

        /*
         * 거래대금은 **거래가 있었던 가장 최근 날**의 것을 쓴다.
         * 개장 전에는 그날 행이 0 으로 먼저 생기는데, 그걸 그대로 쓰면 "0원"이 뜬다.
         * 위쪽 거래량도 같은 이유로 전일 값을 보여 주므로 둘이 맞아떨어진다.
         */
        const withTrade = rows.find((r) => Math.abs(Number(r.trde_qty)) > 0);
        onTradeValue?.(
          withTrade
            ? {
                date: String(withTrade.dt ?? ""),
                open: Math.abs(Number(withTrade.open_pric)) || null,
                high: Math.abs(Number(withTrade.high_pric)) || null,
                low: Math.abs(Number(withTrade.low_pric)) || null,
                volume: Math.abs(Number(withTrade.trde_qty)) || null,
                value: Math.abs(Number(withTrade.trde_prica)) || null,
                // 그날 종가 − 그날 전일대비 = 그날의 전일종가
                base:
                  Math.abs(Number(withTrade.cur_prc)) - Number(withTrade.pred_pre) || null,
              }
            : null,
        );

        if (closes.length < 2) {
          setFailed(true);
          return;
        }

        const now = closes[0];
        setPoints(
          PERIODS.map(({ days, label }) => {
            // 데이터가 모자라면 있는 만큼 거슬러 올라간다 (마지막 값 = 가장 오래된 종가)
            const idx = Math.min(days, closes.length - 1);
            const past = closes[idx];
            return {
              days,
              label,
              rate: past > 0 ? ((now - past) / past) * 100 : null,
              actual: idx,
            };
          }),
        );
      })
      .catch(() => alive && setFailed(true));

    return () => {
      alive = false;
    };
  }, [code]);

  if (failed) return null;

  return (
    <div className="pr-strip">
      <span className="pr-title">기간 상승률</span>
      {points === null
        ? PERIODS.map((p) => (
            <span className="pr-cell" key={p.days}>
              <em className="pr-label">{p.label}</em>
              <b className="pr-value">…</b>
            </span>
          ))
        : points.map((p) => (
            <span className="pr-cell" key={p.days}>
              <em className="pr-label">
                {p.label}
                {/* 요구한 기간을 못 채웠으면 밝힌다 — 신규 상장·거래정지에서 실제로 생긴다 */}
                {p.actual < p.days && <span className="pr-short">*{p.actual}</span>}
              </em>
              <b
                className={`pr-value ${
                  p.rate == null ? "" : p.rate > 0 ? "positive" : p.rate < 0 ? "negative" : ""
                }`}
              >
                {p.rate == null
                  ? "-"
                  : `${p.rate > 0 ? "+" : ""}${p.rate.toFixed(2)}%`}
              </b>
            </span>
          ))}
      <span className="pr-note">거래일 기준 · 수정주가</span>
    </div>
  );
}
