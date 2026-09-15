import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, signClass, type UsRankKind, type UsRankResult, type UsRankRow } from "../api";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";
import { useTabActive } from "../tabActive";

/**
 * **시세분석(해외)** — 미국 순위판 (2026-09-16).
 *
 * 벤티지: "시세분석 메뉴 있잖아 … 시세분석(해외) 이렇게 해서 해외 쪽도 거래대금·시가총액 … 전광판처럼 …
 * 미국 기준". 국내 시세분석(`ScreenerPage`)과 같은 모양 — 위에 순위 종류, 아래 표, 누르면 종목 상세.
 *
 * 값은 서버 `usRank.ts`(네이버 해외주식 거래소 목록, 실시간 · 나스닥·뉴욕·아멕스 합침). 미국 정규장 중엔
 * 15초마다, 밖에선 1분마다 다시 묻는다(서버도 장 밖엔 5분 캐시). 정규장 밖엔 프리·애프터 가격을 옆에 적는다.
 *
 * 국내판의 「실시간 조회순위」는 미국판 자료가 없어 **거래량 순위**로 대신한다(usRank.ts 머리 주석).
 */
const KINDS: { key: UsRankKind; label: string }[] = [
  /* 인기 = 네이버 사용자가 많이 본 종목. 국내 「실시간 조회순위」 자리 (2026-09-16) */
  { key: "popular", label: "인기" },
  { key: "value", label: "거래대금" },
  { key: "volume", label: "거래량" },
  { key: "cap", label: "시가총액" },
  { key: "up", label: "상승률" },
  { key: "down", label: "하락률" },
];
const EXS: { key: "all" | "NASDAQ" | "NYSE" | "AMEX"; label: string }[] = [
  { key: "all", label: "전체" },
  { key: "NASDAQ", label: "나스닥" },
  { key: "NYSE", label: "뉴욕" },
  { key: "AMEX", label: "아멕스" },
];
/** 상승·하락률 잡주 거르기 — 거래대금 문턱(달러) */
const MIN_VALUES: { v: number; label: string }[] = [
  { v: 0, label: "전부" },
  { v: 10_000_000, label: "$1천만↑" },
  { v: 100_000_000, label: "$1억↑" },
];

function usd(n: number | null): string {
  if (n === null) return "-";
  if (n >= 1e12) return `${(n / 1e12).toFixed(2)}조$`;
  if (n >= 1e8) return `${Math.round(n / 1e8).toLocaleString("ko-KR")}억$`;
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만$`;
  return `${Math.round(n).toLocaleString("ko-KR")}$`;
}
function shares(n: number | null): string {
  if (n === null) return "-";
  if (n >= 1e8) return `${(n / 1e8).toFixed(2)}억주`;
  if (n >= 1e4) return `${Math.round(n / 1e4).toLocaleString("ko-KR")}만주`;
  return `${n.toLocaleString("ko-KR")}주`;
}
const pct = (v: number | null) => (v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const price = (v: number | null) => (v === null ? "-" : v >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 2 }) : v.toFixed(2));

const STATUS: Record<string, string> = {
  OPEN: "정규장 거래 중",
  CLOSE: "장 마감",
  PREOPEN: "개장 전",
};

export function UsScreenerPage() {
  const [kind, setKind] = useState<UsRankKind>("value");
  const [ex, setEx] = useState<(typeof EXS)[number]["key"]>("all");
  const [minValue, setMinValue] = useState(10_000_000);
  const [data, setData] = useState<UsRankResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const tabActive = useTabActive();
  const seq = useRef(0);

  const rateKind = kind === "up" || kind === "down";

  useEffect(() => {
    let alive = true;
    const my = ++seq.current;
    const pull = (quiet: boolean) => {
      if (!quiet) setLoading(true);
      api
        .usRank(kind, ex, rateKind ? minValue : 0)
        .then((r) => {
          if (!alive || my !== seq.current) return;
          setData(r);
          setError(null);
        })
        .catch((e: Error) => alive && setError(e.message))
        .finally(() => alive && setLoading(false));
    };
    pull(false);
    const t = window.setInterval(() => {
      if (document.visibilityState !== "visible" || !tabActive) return;
      pull(true);
    }, data?.marketStatus === "OPEN" ? 15_000 : 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, ex, minValue, tabActive, data?.marketStatus === "OPEN"]);

  const rows = data?.rows ?? [];
  const showOver = data?.marketStatus !== "OPEN" && rows.some((r) => r.over);

  return (
    <div className="usr">
      <div className="filter-row">
        {KINDS.map((k) => (
          <button key={k.key} type="button" className={`filter-btn${kind === k.key ? " active" : ""}`} onClick={() => setKind(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
      <div className="filter-row usr-sub">
        {EXS.map((e) => (
          <button key={e.key} type="button" className={`filter-btn${ex === e.key ? " active" : ""}`} onClick={() => setEx(e.key)}>
            {e.label}
          </button>
        ))}
        {rateKind && (
          <span className="usr-min">
            거래대금
            {MIN_VALUES.map((m) => (
              <button key={m.v} type="button" className={`filter-btn${minValue === m.v ? " active" : ""}`} onClick={() => setMinValue(m.v)}>
                {m.label}
              </button>
            ))}
          </span>
        )}
      </div>
      {kind === "popular" && (
        <div className="table-note usr-pop-note">네이버 사용자가 많이 본 미국 종목 — 국내 시세분석의 「실시간 조회순위」에 해당합니다.</div>
      )}
      <div className="usr-status">
        <span className={`usr-dot${data?.marketStatus === "OPEN" ? " on" : ""}`} />
        {data ? STATUS[data.marketStatus] ?? data.marketStatus ?? "" : ""}
        {data && ` · ${new Date(data.at).toLocaleTimeString("ko-KR", { hour12: false })} 기준 · 네이버 실시간`}
        {loading && " · 불러오는 중…"}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="data-table-wrap">
        <table className="data-table usr-table">
          <thead>
            <tr>
              <th className="usr-no">#</th>
              <th className="sticky-col">종목</th>
              <th>현재가($)</th>
              <th>등락률</th>
              {showOver && <th>시간외</th>}
              <th className={kind === "value" ? "usr-key" : ""}>거래대금</th>
              <th className={kind === "volume" ? "usr-key" : ""}>거래량</th>
              <th className={kind === "cap" ? "usr-key" : ""}>시가총액</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr
                key={`${r.exchange}:${r.symbol}`}
                className="clickable-row"
                onClick={() => setChart({ kind: "usStock", symbol: r.symbol, label: r.name, hintRate: r.rate, hintPrice: r.price })}
              >
                <td className="usr-no">{i + 1}</td>
                <td className="sticky-col usr-name">
                  <b>{r.name}</b>
                  <span>
                    {r.symbol} · {r.exchange === "NASDAQ" ? "나스닥" : r.exchange === "NYSE" ? "뉴욕" : "아멕스"}
                    {r.kind === "etf" ? " · ETF" : ""}
                  </span>
                </td>
                <td className="num">{price(r.price)}</td>
                <td className={`num ${signClass(r.rate ?? 0)}`}>{pct(r.rate)}</td>
                {showOver && (
                  <td className="num usr-over">
                    {r.over ? (
                      <>
                        <small>{r.over.session === "pre" ? "프리" : "애프터"}</small> {price(r.over.price)}{" "}
                        <em className={signClass(r.over.rate ?? 0)}>{pct(r.over.rate)}</em>
                      </>
                    ) : (
                      "-"
                    )}
                  </td>
                )}
                <td className={`num${kind === "value" ? " usr-key" : ""}`}>{usd(r.value)}</td>
                <td className={`num${kind === "volume" ? " usr-key" : ""}`}>{shares(r.volume)}</td>
                <td className={`num${kind === "cap" ? " usr-key" : ""}`}>{usd(r.cap)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && !loading && !error && <div className="empty">받은 순위가 없습니다.</div>}
      <div className="table-note">
        나스닥·뉴욕·아멕스 상위를 합쳐 다시 줄 세운 것 · 값은 달러(억$ = 1억 달러) · 누르면 해외종목 상세
        {rateKind && " · 상승·하락률은 거래대금 문턱으로 잡주를 거른다"}
      </div>
      {chart && createPortal(<YahooChartSheet target={chart} onClose={() => setChart(null)} />, document.body)}
    </div>
  );
}
