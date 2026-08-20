import { useEffect, useMemo, useState } from "react";
import { api, fmtNum, type UsDetail, type YahooChart } from "../../api";

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

/** 해외종목 — 한투 기간별시세는 일/주/월이다 */
const US_RANGES: { key: string; label: string }[] = [
  { key: "D", label: "일봉" },
  { key: "W", label: "주봉" },
  { key: "M", label: "월봉" },
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
   *   usStock 해외종목 — 한투 price-detail + dailyprice
   */
  kind?: "yahoo" | "futures" | "usStock";
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
  const usStock = target.kind === "usStock";
  const ranges = usStock ? US_RANGES : futures ? FUTURES_RANGES : YAHOO_RANGES;
  const [range, setRange] = useState(usStock ? "D" : futures ? "3mo" : "6mo");
  const [data, setData] = useState<YahooChart | null>(null);
  const [detail, setDetail] = useState<UsDetail | null>(null);
  const [loading, setLoading] = useState(true);

  // 상세 숫자는 기간을 바꿔도 그대로다 — 한 번만 받는다
  useEffect(() => {
    if (!usStock) return;
    let alive = true;
    api
      .usDetail(target.symbol)
      .then((d) => {
        if (alive) setDetail(d);
      })
      .catch(() => {
        if (alive) setDetail(null);
      });
    return () => {
      alive = false;
    };
  }, [usStock, target.symbol]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    const spec = FUTURES_SPEC[range] ?? FUTURES_SPEC["3mo"];
    const req = usStock
      ? api.usChart(target.symbol, range as "D" | "W" | "M").then((r) => ({
          symbol: target.symbol,
          range,
          interval: range === "D" ? "일봉" : range === "W" ? "주봉" : "월봉",
          candles: r.candles,
          prevClose: null,
          error: r.error,
        }))
      : futures
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
  }, [target.symbol, range, futures, usStock]);

  const digits = target.digits ?? 2;
  const candles = useMemo(() => data?.candles ?? [], [data]);

  const view = useMemo(() => {
    if (candles.length < 2) return null;

    /*
     * 눈금은 **고가·저가**로 잡는다.
     *
     * 선 그래프였을 때는 종가만 봐도 됐지만 봉은 위아래로 꼬리가 뻗는다.
     * 종가 범위로 눈금을 잡으면 꼬리가 차트 밖으로 잘려 나간다.
     */
    let lo = Math.min(...candles.map((c) => c.low));
    let hi = Math.max(...candles.map((c) => c.high));
    /*
     * 「1일」에서는 전일 종가도 눈금 안에 넣는다.
     * 기준선이 화면 밖으로 나가면 **오늘 오른 건지 내린 건지가 안 보인다.**
     */
    const base = range === "1d" ? data?.prevClose ?? null : null;
    if (base !== null) {
      lo = Math.min(lo, base);
      hi = Math.max(hi, base);
    }
    // 위아래가 딱 붙으면 봉이 테두리에 닿는다
    const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.01 || 1;
    lo -= pad;
    hi += pad;

    const iw = W - PAD.l - PAD.r;
    const ih = H - PAD.t - PAD.b;
    const y = (v: number) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;

    /*
     * 봉 하나가 차지하는 칸과 몸통 너비.
     *
     * 기간마다 봉 수가 크게 다르다 — 5분봉 51개, 일봉 126개, 주봉이면 260개다.
     * 260개를 이 폭에 그리면 칸이 2.7px 라, 비율로만 깎으면 몸통이 사라진다.
     * **최소 1px 은 보장한다.** 안 보이는 봉은 없는 봉이다.
     */
    const slot = iw / candles.length;
    const bodyW = Math.max(1, slot * 0.68);
    const cx = (i: number) => PAD.l + slot * (i + 0.5);

    const bars = candles.map((c, i) => {
      const oy = y(c.open);
      const cy = y(c.close);
      return {
        key: c.t,
        x: cx(i),
        // 종가가 시가보다 높으면 양봉이다 (국내 관행: 상승 빨강 · 하락 파랑)
        up: c.close >= c.open,
        highY: y(c.high),
        lowY: y(c.low),
        bodyY: Math.min(oy, cy),
        // 시가와 종가가 같으면 몸통 높이가 0 이라 아무것도 안 그려진다 — 1px 을 준다
        bodyH: Math.max(1, Math.abs(cy - oy)),
      };
    });

    const closes = candles.map((c) => c.close);
    const last = closes[closes.length - 1];
    /*
     * 기간 등락률의 기준.
     * 「1일」은 전일 종가가 기준이다 — 그날 첫 봉과 견주면 **갭이 통째로 빠진다.**
     */
    const from = base ?? candles[0].open;

    /*
     * **전일 대비를 따로 낸다.**
     *
     * 목록에서 종목을 누르면 목록과 같은 숫자가 먼저 보여야 한다. 예전에는 큰 글씨가
     * 늘 **기간 수익률**이었는데(구간 첫 봉 대비), 목록은 전일 대비라 둘이 부호까지
     * 갈렸다 — 실제로 「목록 +4.23, 눌렀더니 −4.26」이 나왔다. 옆에 작게 「언제 이후」를
     * 적어 두긴 했지만, 크고 색 있는 숫자를 두고 그 글씨를 읽는 사람은 없다.
     *
     * 어느 것이 「전일」인지는 **봉의 날짜로** 판단한다. 기간 이름(`1d`·`D`)으로 가르면
     * 받아오는 곳마다 이름이 달라 또 어긋난다 —
     * 마지막 두 봉의 날짜가 다르면 앞 봉이 전일이고, 같으면 장중 봉이라 알 수 없다.
     * 장중 구간에서는 메타의 전일 종가를 쓴다.
     */
    const day = (t: string) => String(t).slice(0, 10);
    const prev = candles.length >= 2 ? candles[candles.length - 2] : null;
    const dayBase =
      base !== null
        ? base
        : prev && day(prev.t) !== day(candles[candles.length - 1].t)
          ? prev.close
          : null;

    return {
      bars,
      bodyW,
      baseY: base === null ? null : y(base),
      last,
      dayRate: dayBase !== null && dayBase > 0 ? ((last - dayBase) / dayBase) * 100 : null,
      rate: from > 0 ? ((last - from) / from) * 100 : 0,
      loLabel: Math.min(...candles.map((c) => c.low)),
      hiLabel: Math.max(...candles.map((c) => c.high)),
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
            {/*
              큰 숫자는 **전일 대비**다 — 목록에서 보고 누른 그 숫자와 같아야 한다.
              기간 수익률은 그 아래 따로, 언제부터인지를 붙여서 적는다.
            */}
            <div className="yc-head">
              <b className="yc-px">{view.last.toLocaleString("ko-KR", { maximumFractionDigits: digits })}</b>
              {view.dayRate !== null ? (
                <>
                  <span className={`yc-rate ${view.dayRate >= 0 ? "positive" : "negative"}`}>
                    {view.dayRate >= 0 ? "+" : ""}
                    {view.dayRate.toFixed(2)}%
                  </span>
                  <span className="pt-n">전일 대비</span>
                </>
              ) : (
                <>
                  <span className={`yc-rate ${up ? "positive" : "negative"}`}>
                    {up ? "+" : ""}
                    {view.rate.toFixed(2)}%
                  </span>
                  <span className="pt-n">{view.firstT} 이후</span>
                </>
              )}
            </div>
            {/*
              구간 등락률은 **안 띄운다.**
              전일 대비 옆에 같이 있으면 두 숫자 중 어느 것을 보는지 매번 헷갈린다 —
              부호가 갈리는 날이 흔해서 특히 그렇다. 알고 싶으면 기간을 바꿔 보면 된다.
            */}

            {detail && !detail.error && <UsFigures d={detail} />}

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
              {/*
                봉 하나 = 꼬리(고가~저가) + 몸통(시가~종가).
                꼬리를 몸통보다 먼저 그려야 몸통이 위에 온다.
              */}
              {view.bars.map((b) => (
                <g className={`yc-c ${b.up ? "up" : "down"}`} key={b.key}>
                  <line className="yc-wick" x1={b.x} x2={b.x} y1={b.highY} y2={b.lowY} />
                  <rect
                    className="yc-body"
                    x={b.x - view.bodyW / 2}
                    y={b.bodyY}
                    width={view.bodyW}
                    height={b.bodyH}
                  />
                </g>
              ))}
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


/**
 * 해외종목 숫자판.
 *
 * **없는 것은 안 그린다.** 한투 해외주식에는 재무제표도 수급도 없다 — 국내 상세와
 * 같은 모양으로 맞추겠다고 빈 칸을 늘어놓으면, 값이 없는 건지 0인 건지 알 수 없어진다.
 */
function UsFigures({ d }: { d: UsDetail }) {
  const pos52 =
    d.price !== null && d.high52 !== null && d.low52 !== null && d.high52 > d.low52
      ? ((d.price - d.low52) / (d.high52 - d.low52)) * 100
      : null;
  const volRatio = d.volume !== null && d.prevVolume ? d.volume / d.prevVolume : null;

  const rows: { k: string; v: string; hint?: string }[] = [];
  if (d.open !== null) rows.push({ k: "시/고/저", v: `${d.open} / ${d.high} / ${d.low}` });
  if (pos52 !== null)
    rows.push({
      k: "52주 자리",
      v: `${pos52.toFixed(0)}% (${d.low52} ~ ${d.high52})`,
      hint: "0%가 52주 최저, 100%가 최고입니다",
    });
  if (volRatio !== null)
    rows.push({
      k: "거래량",
      v: `${fmtNum(d.volume ?? 0)} · 전일比 ${volRatio.toFixed(2)}배`,
      hint: "1배보다 크면 평소보다 붐빈다는 뜻입니다",
    });
  if (d.marketCap !== null) {
    /*
     * **원화로도 적는다.**
     *
     * 「3,900십억 USD」는 그 자체로는 크기가 안 잡힌다 — 국내 종목을 볼 때 쓰는 자가
     * 「억원」이라, 같은 자로 바꿔 놔야 삼성전자와 견줄 수 있다.
     * 환율은 원화 환산에 이미 쓰고 있는 값을 그대로 쓴다(없으면 괄호를 안 붙인다).
     */
    const won = d.fxRate ? (d.marketCap * d.fxRate) / 1e8 : null;
    /*
     * 조 단위면 조로 적는다.
     * 엔비디아를 억원으로 적으면 「73,803,074억원」이 되는데, 자릿수가 여덟 개라
     * **읽는 순간 크기가 안 잡힌다.** 억으로 통일하는 것보다 읽히는 게 먼저다.
     */
    const wonText =
      won === null
        ? ""
        : won >= 10_000
          ? ` (약 ${fmtNum(Math.round(won / 10_000))}조원)`
          : ` (약 ${fmtNum(Math.round(won))}억원)`;
    rows.push({
      k: "시가총액",
      v: `${(d.marketCap / 1e9).toFixed(1)}십억 ${d.currency}${wonText}`,
      hint: won === null ? undefined : "국내 종목과 견주기 쉽게 원화로도 적었습니다",
    });
  }
  if (d.per !== null || d.pbr !== null)
    rows.push({ k: "PER / PBR", v: `${d.per ?? "-"} / ${d.pbr ?? "-"}` });
  if (d.eps !== null || d.bps !== null)
    rows.push({ k: "EPS / BPS", v: `${d.eps ?? "-"} / ${d.bps ?? "-"}` });
  if (d.wonPrice !== null)
    rows.push({
      k: "원화 환산",
      v: `${d.wonPrice.toLocaleString("ko-KR")}원${d.fxRate ? ` (환율 ${d.fxRate})` : ""}`,
      hint: "환율까지 얹힌 값이라 실제 체감에 가깝습니다",
    });
  if (d.sector) rows.push({ k: "업종", v: d.sector });
  if (d.tradable) rows.push({ k: "매매", v: d.tradable });

  return (
    <>
      <div className="usd-grid">
        {rows.map((r) => (
          <div className="usd-cell" key={r.k} title={r.hint}>
            <span className="usd-k">{r.k}</span>
            <span className="usd-v">{r.v}</span>
          </div>
        ))}
      </div>
      <div className="table-note">
        한국투자증권 해외주식 시세입니다. <b>재무제표와 수급은 없습니다</b> — 해외 종목에는
        DART 같은 자리가 없고, 외국인·기관 순매수는 국내 시장의 개념입니다.
      </div>
    </>
  );
}
