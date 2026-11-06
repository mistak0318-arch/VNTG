import { useEffect, useState } from "react";
import { api } from "../../api";

/**
 * **해외 종목의 기간 상승률** (2026-11-07 — 벤티지: "해외종목 종목상세도 국내종목상세처럼
 * 꾸며봐 최대한 지원되는 한도내에서").
 *
 * 국내 상세의 `PeriodReturns` 와 **같은 모양·같은 클래스**다. 오늘 +3.79% 가 무슨 뜻인지는
 * 그것만 봐선 알 수 없다 — 두 달을 흘러내리다 하루 튄 것과 석 달째 계단으로 오르는 것이
 * 화면에서 똑같이 생긴다. 그 하나가 해외 상세에 없던 자리다.
 *
 * ## ⚠️ 120일은 없다
 *
 * 한투 해외 일봉(`HHDFS76240000`)은 **100건까지만** 준다. 실측(2026-11-07, NVDA·TSM):
 * 5·10·20·60일은 나오고 120일은 자료가 모자란다. 그래서 **120일 칸을 아예 안 그린다** —
 * 국내는 다섯 칸, 여기는 네 칸이다. 빈칸을 두고 「-」를 적으면 「오늘은 값이 안 왔나」로
 * 읽히는데, 이건 날이 모자라서 **영영 안 나오는** 값이라 뜻이 다르다.
 *
 * 100건을 다 못 받은 종목(신규 상장 등)은 국내와 같은 방식으로 `*실제일수` 를 붙인다.
 *
 * ## 조회
 *
 * 상세를 열 때 일봉 한 건. 차트가 「D」(일봉)로 열려 있으면 같은 값을 또 받는 셈이지만,
 * 기본 범위는 분봉(`1d`)이라 대개 겹치지 않는다. 서버가 캐시하므로 겹쳐도 싸다.
 */

const PERIODS = [
  { days: 5, label: "5일" },
  { days: 10, label: "10일" },
  { days: 20, label: "20일" },
  { days: 60, label: "60일" },
];

type Pt = { days: number; label: string; rate: number | null; actual: number };

export function UsPeriodReturns({ symbol }: { symbol: string }) {
  const [points, setPoints] = useState<Pt[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setPoints(null);
    setFailed(false);
    api
      .usChart(symbol, "D")
      .then((r) => {
        if (!alive) return;
        /* 서버가 날짜 오름차순으로 정렬해 준다 — 마지막이 가장 최근이다 */
        const closes = (r.candles ?? []).map((c) => c.close).filter((v) => typeof v === "number" && v > 0);
        if (closes.length < 2) {
          setFailed(true);
          return;
        }
        const last = closes[closes.length - 1];
        setPoints(
          PERIODS.map(({ days, label }) => {
            /* 요구한 날만큼 못 거슬러 가면 **있는 만큼만** 센다 — 그 사실을 라벨에 적는다 */
            const back = Math.min(days, closes.length - 1);
            const prev = closes[closes.length - 1 - back];
            return {
              days,
              label,
              rate: prev > 0 ? ((last - prev) / prev) * 100 : null,
              actual: back,
            };
          }),
        );
      })
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [symbol]);

  /* 못 받으면 통째로 안 그린다 — 없는 것을 있는 척하지 않는다 */
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
                {p.actual < p.days && <span className="pr-short">*{p.actual}</span>}
              </em>
              <b
                className={`pr-value ${
                  p.rate == null ? "" : p.rate > 0 ? "positive" : p.rate < 0 ? "negative" : ""
                }`}
              >
                {p.rate == null ? "-" : `${p.rate > 0 ? "+" : ""}${p.rate.toFixed(2)}%`}
              </b>
            </span>
          ))}
      <span className="pr-note" title="한국투자증권 해외 일봉이 100건까지라 120일은 셀 수 없습니다">
        거래일 기준 · 120일은 자료 밖
      </span>
    </div>
  );
}
