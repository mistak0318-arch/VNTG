import { useEffect, useMemo, useState } from "react";
import { api, type YahooChart } from "../../api";

/**
 * 지수·원자재 차트.
 *
 * 전광판은 숫자 한 줄뿐이라 "지금 얼마"는 알아도 **"어디쯤인가"**를 모른다.
 * 나스닥 -0.12% 는 그 자체로 아무 뜻이 없고, 최근 한 달을 어떻게 왔는지를 봐야
 * 판단이 선다. 그래서 상자를 누르면 이게 열린다.
 *
 * ## 왜 캔버스 차트 라이브러리를 안 쓰나
 *
 * 종목 차트는 `lightweight-charts` 를 쓴다. 여기서는 **SVG 로 직접 그린다.**
 * 이건 선 하나짜리 그림이라 라이브러리가 필요 없고, 무엇보다 캔버스는 컨테이너 폭을
 * 재서 비트맵 크기를 맞춰야 하는데 그 과정이 개발 창에서 어긋난 적이 있다.
 * SVG 는 `viewBox` 라 폭에 상관없이 같은 그림이 나온다.
 */

const YAHOO_RANGES: { key: string; label: string }[] = [
  { key: "1d", label: "1일" },
  { key: "5d", label: "5일" },
  { key: "1mo", label: "1개월" },
  { key: "6mo", label: "6개월" },
  { key: "1y", label: "1년" },
  { key: "5y", label: "5년" },
];

/*
 * 선물은 기간 선택지가 다르다.
 *
 * 한투 기간별시세는 「몇 일치를 일/주/월봉으로」다. 야후처럼 `1d`·`5d` 같은 장중 구간이
 * 없다 — 야간선물 분봉은 다른 TR 이고 아직 확인 안 했다. **없는 걸 있는 척 두면 안 된다.**
 */
const FUTURES_RANGES: { key: string; label: string }[] = [
  { key: "3mo", label: "3개월" },
  { key: "1y", label: "1년" },
  { key: "3y", label: "3년" },
];

const FUTURES_SPEC: Record<string, { days: number; period: "D" | "W" | "M" }> = {
  "3mo": { days: 120, period: "D" },
  "1y": { days: 400, period: "D" },
  "3y": { days: 800, period: "W" },
};

export interface ChartTarget {
  /**
   * 어디서 받아오나.
   *   yahoo   미국 지수·원자재 (`^NDX`, `CL=F`)
   *   futures 야간선물 — 한투 기간별시세(`FHKIF03020100`, 시장 `CM`)
   */
  kind?: "yahoo" | "futures";
  /** 야후 심볼 또는 선물 월물코드 */
  symbol: string;
  label: string;
  /** 소수점 자릿수. 지수는 2, 금리는 3 */
  digits?: number;
}

const W = 720;
const H = 260;
const PAD = { l: 8, r: 58, t: 12, b: 22 };

export function YahooChartSheet({
  target,
  onClose,
}: {
  target: ChartTarget;
  onClose: () => void;
}) {
  const futures = target.kind === "futures";
  const ranges = futures ? FUTURES_RANGES : YAHOO_RANGES;
  const [range, setRange] = useState(futures ? "3mo" : "6mo");
  const [data, setData] = useState<YahooChart | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const spec = FUTURES_SPEC[range] ?? FUTURES_SPEC["3mo"];
    const req = futures
      ? api.futuresChart(target.symbol, spec.period, spec.days).then((r) => ({
          symbol: target.symbol,
          range,
          interval: spec.period === "D" ? "1일봉" : spec.period === "W" ? "주봉" : "월봉",
          candles: r.candles,
          // 선물은 전일 종가를 따로 안 준다 — 기준선 없이 흐름만 본다
          prevClose: null,
          error: r.error,
        }))
      : api.yahooChart(target.symbol, range);
    req
      .then((d) => {
        if (alive) setData(d);
      })
      .catch(() => {
        if (alive) setData(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [target.symbol, range, futures]);

  const digits = target.digits ?? 2;
  const candles = useMemo(() => data?.candles ?? [], [data]);

  const view = useMemo(() => {
    if (candles.length < 2) return null;
    const closes = candles.map((c) => c.close);
    let lo = Math.min(...closes);
    let hi = Math.max(...closes);
    /*
     * 「1일」에서는 전일 종가도 눈금 안에 넣는다.
     * 기준선이 화면 밖으로 나가면 **오늘 오른 건지 내린 건지가 안 보인다.**
     */
    const base = range === "1d" ? data?.prevClose ?? null : null;
    if (base !== null) {
      lo = Math.min(lo, base);
      hi = Math.max(hi, base);
    }
    // 위아래가 딱 붙으면 선이 테두리에 닿는다
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
    lo -= pad;
    hi += pad;

    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const x = (i: number) => PAD.l + (i / (candles.length - 1)) * iw;
    const y = (v: number) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;

    const line = candles.map((c, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(c.close).toFixed(1)}`).join("");
    const area = `${line}L${x(candles.length - 1).toFixed(1)},${(PAD.t + ih).toFixed(1)}L${PAD.l},${(PAD.t + ih).toFixed(1)}Z`;

    const first = closes[0];
    const last = closes[closes.length - 1];
    /*
     * 기간 등락률의 기준.
     * 「1일」은 전일 종가가 기준이다 — 그날 첫 봉과 견주면 **갭이 통째로 빠진다.**
     */
    const from = base ?? first;
    return {
      line,
      area,
      baseY: base === null ? null : y(base),
      lo,
      hi,
      last,
      rate: from > 0 ? ((last - from) / from) * 100 : 0,
      loLabel: Math.min(...closes),
      hiLabel: Math.max(...closes),
      firstT: candles[0].t,
      lastT: candles[candles.length - 1].t,
    };
  }, [candles, range, data]);

  const up = (view?.rate ?? 0) >= 0;

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet yc" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {target.label}
            <span className="sheet-sub">{target.symbol}</span>
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        <div className="filter-row">
          {ranges.map((r) => (
            <button
              key={r.key}
              className={`filter-btn ${range === r.key ? "active" : ""}`}
              onClick={() => setRange(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>

        {loading && !view && <div className="empty">차트 불러오는 중…</div>}
        {!loading && data?.error && <div className="error-banner">{data.error}</div>}

        {view && (
          <>
            <div className="yc-head">
              <b className="yc-px">{view.last.toLocaleString("ko-KR", { maximumFractionDigits: digits })}</b>
              <span className={`yc-rate ${up ? "positive" : "negative"}`}>
                {up ? "+" : ""}
                {view.rate.toFixed(2)}%
              </span>
              <span className="pt-n">
                {range === "1d" ? "전일 종가 대비" : `${view.firstT} 이후`}
              </span>
            </div>

            <svg className="yc-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
              {/* 기준선 — 「1일」에서 이게 없으면 오른 건지 내린 건지 안 보인다 */}
              {view.baseY !== null && (
                <line
                  className="yc-base"
                  x1={PAD.l}
                  x2={W - PAD.r}
                  y1={view.baseY}
                  y2={view.baseY}
                />
              )}
              <path className={`yc-area ${up ? "up" : "down"}`} d={view.area} />
              <path className={`yc-line ${up ? "up" : "down"}`} d={view.line} />
              {/* 고·저 눈금은 오른쪽에. 값을 읽으려고 여는 창이 아니라 모양을 보려는 창이다 */}
              <text className="yc-tick" x={W - PAD.r + 6} y={PAD.t + 10}>
                {view.hiLabel.toLocaleString("ko-KR", { maximumFractionDigits: digits })}
              </text>
              <text className="yc-tick" x={W - PAD.r + 6} y={H - PAD.b}>
                {view.loLabel.toLocaleString("ko-KR", { maximumFractionDigits: digits })}
              </text>
            </svg>

            <div className="table-note">
              {candles.length}개 봉 ({data?.interval}) · {view.firstT} ~ {view.lastT}
              {range === "1d" && " · 시각은 한국시간입니다"}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
