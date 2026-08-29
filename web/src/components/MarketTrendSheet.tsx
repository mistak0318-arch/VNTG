import { useEffect, useState } from "react";
import { api, fmtNum, type IndexCandle } from "../api";
import { useSheetBack } from "../useSheetBack";

/**
 * 시장 추이 시트 (2026-08-29 요청 — 「눌러서 흐름을 볼 수 있게」).
 *
 * 등락현황·거래대금은 **오늘 숫자 하나**만 보여 준다. 그런데 「오늘 8.4조」는
 * 그 자체로는 아무 말도 못 한다 — 평소가 6조면 몰린 것이고 12조면 식은 것이다.
 * 눌러서 60거래일을 펴 보면 그 하나가 어디쯤인지 바로 읽힌다.
 *
 * ## 두 가지를 같은 시트에서
 *
 *   거래대금 — 막대. 「돈이 도나」
 *   등락 폭  — 상승 종목 비율 선. 「몇이 오르나」
 *
 * 둘은 같은 물음의 앞뒤라(돈이 들어오면 폭이 넓어진다) 한 화면에 두어야
 * 어긋나는 날이 눈에 띈다 — 대금은 느는데 폭이 좁으면 몇 종목에 쏠린 장이다.
 *
 * ⚠️ **상승 비율은 일봉에 없다.** 지수 일봉이 주는 건 시가·고저·종가·거래대금뿐이라,
 * 과거의 상승/하락 종목 수는 우리에게 없다. 없는 값을 지어내지 않고 **등락률**을
 * 대신 그린다(그날 지수가 몇 % 움직였나) — 폭의 대용이 아니라 다른 값이라고 적는다.
 */

const RANGE_DAYS = 60;

function money(eok: number): string {
  if (eok >= 10000) return `${(eok / 10000).toFixed(1)}조`;
  return `${fmtNum(Math.round(eok))}억`;
}

/** 막대 + 선을 한 좌표계에 — 막대는 거래대금, 선은 일간 등락률 */
function TrendChart({ candles }: { candles: IndexCandle[] }) {
  const W = 640;
  const H = 200;
  const PAD = 26;
  if (candles.length < 2) return <div className="empty">그릴 만큼 쌓이지 않았습니다.</div>;

  const maxTv = Math.max(...candles.map((c) => c.tradeValue), 1);
  const rates = candles.map((c, i) =>
    i === 0 || candles[i - 1].close <= 0
      ? 0
      : ((c.close - candles[i - 1].close) / candles[i - 1].close) * 100,
  );
  const maxAbs = Math.max(...rates.map((r) => Math.abs(r)), 1);

  const bw = W / candles.length;
  /* 거래대금 막대는 아래 2/3, 등락률 선은 위 1/3 — 겹치면 둘 다 안 읽힌다 */
  const barTop = H * 0.34;
  const yBar = (tv: number) => H - PAD - (tv / maxTv) * (H - PAD - barTop);
  const midLine = barTop * 0.5;
  const yRate = (r: number) => midLine - (r / maxAbs) * (barTop * 0.4);

  const avg = candles.reduce((a, c) => a + c.tradeValue, 0) / candles.length;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="mts-chart" preserveAspectRatio="none">
      {/* 20일 평균선 — 오늘 막대가 이 선 위인지 아래인지가 「몰렸나」의 답이다 */}
      <line x1={0} y1={yBar(avg)} x2={W} y2={yBar(avg)} className="mts-avg" />
      {candles.map((c, i) => (
        <rect
          key={c.dt}
          x={i * bw + bw * 0.15}
          y={yBar(c.tradeValue)}
          width={bw * 0.7}
          height={Math.max(1, H - PAD - yBar(c.tradeValue))}
          className={`mts-bar${i === candles.length - 1 ? " last" : ""}`}
        />
      ))}
      <line x1={0} y1={midLine} x2={W} y2={midLine} className="mts-zero" />
      <path
        d={rates
          .map((r, i) => `${i === 0 ? "M" : "L"}${(i * bw + bw / 2).toFixed(1)},${yRate(r).toFixed(1)}`)
          .join(" ")}
        className="mts-line"
        fill="none"
      />
    </svg>
  );
}

export function MarketTrendSheet({
  code,
  name,
  onClose,
}: {
  /** 001 코스피 · 101 코스닥 */
  code: string;
  name: string;
  onClose: () => void;
}) {
  useSheetBack(true, onClose);
  const [candles, setCandles] = useState<IndexCandle[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .indexDetail(code, "day")
      .then((r) => alive && setCandles(r.candles.slice(-RANGE_DAYS)))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [code]);

  const last = candles?.[candles.length - 1];
  const prev = candles?.[(candles?.length ?? 0) - 2];
  const last20 = (candles ?? []).slice(-21, -1);
  const avg20 =
    last20.length > 0 ? last20.reduce((a, c) => a + c.tradeValue, 0) / last20.length : 0;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet mts-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>{name} 흐름</h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && <div className="error-banner">{error}</div>}
        {!candles && !error && <div className="empty">불러오는 중…</div>}

        {candles && (
          <>
            <div className="lens-chips">
              <span className="lens-chip">
                오늘 거래대금 <b>{last ? money(last.tradeValue) : "—"}</b>
              </span>
              {avg20 > 0 && last && (
                <span className="lens-chip">
                  20일 평균 대비{" "}
                  <b className={last.tradeValue >= avg20 ? "positive" : "negative"}>
                    {Math.round((last.tradeValue / avg20) * 100)}%
                  </b>
                  <i>평균 {money(avg20)}</i>
                </span>
              )}
              {last && prev && prev.close > 0 && (
                <span className="lens-chip">
                  오늘 등락{" "}
                  <b className={last.close >= prev.close ? "positive" : "negative"}>
                    {(((last.close - prev.close) / prev.close) * 100).toFixed(2)}%
                  </b>
                </span>
              )}
            </div>

            <TrendChart candles={candles} />

            <div className="table-note">
              막대가 <b>하루 거래대금</b>, 가로 점선이 <b>{candles.length}일 평균</b>입니다 —
              오늘 막대가 선 위면 돈이 몰린 날입니다. 위쪽 선은 <b>그날 지수 등락률</b>이고
              가운데 가로선이 0%입니다.
              <br />
              대금은 느는데 등락이 시원찮으면 <b>몇 종목에 쏠린 장</b>이고, 대금이 줄면서
              오르면 <b>힘이 빠지는 상승</b>입니다.
              <br />
              ⚠️ 과거의 상승/하락 <b>종목 수</b>는 지수 일봉에 없어 그리지 못합니다 — 그 값은
              오늘 것만 있습니다(등락현황 칸).
            </div>
          </>
        )}
      </div>
    </div>
  );
}
