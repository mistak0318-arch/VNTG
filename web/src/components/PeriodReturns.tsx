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

interface Point {
  days: number;
  label: string;
  rate: number | null;
  /** 실제로 몇 거래일 전과 견줬는지 — 상장 초기 종목은 요구 기간을 못 채운다 */
  actual: number;
}

export function PeriodReturns({ code }: { code: string }) {
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
