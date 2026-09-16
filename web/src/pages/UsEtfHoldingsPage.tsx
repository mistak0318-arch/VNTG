import { useEffect, useState } from "react";
import { api, type UsEtfHoldings } from "../api";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";

/**
 * **미국 ETF 구성종목** (2026-09-17 — ETF 분석 묶음). 심볼을 넣으면 상위 구성종목·비중·섹터 쏠림.
 * 여태는 섹터 MAP 타일 안에서만 열렸다 — 메뉴로 꺼낸 것. 야후가 주는 **상위 종목만**(전체 구성이 아니다),
 * 하루 캐시라 여닫아도 조회가 안 는다. 종목을 누르면 해외 상세(차트·SEC 재무·의견).
 */
const PRESETS: { symbol: string; name: string }[] = [
  { symbol: "SPY", name: "S&P 500" },
  { symbol: "QQQ", name: "나스닥 100" },
  { symbol: "SMH", name: "반도체" },
  { symbol: "SOXX", name: "반도체(iShares)" },
  { symbol: "XLK", name: "기술" },
  { symbol: "XLF", name: "금융" },
  { symbol: "XLE", name: "에너지" },
  { symbol: "XLV", name: "헬스케어" },
  { symbol: "XLI", name: "산업재" },
  { symbol: "XLY", name: "경기소비" },
  { symbol: "ARKK", name: "ARK 혁신" },
  { symbol: "BOTZ", name: "로봇·AI" },
  { symbol: "ITA", name: "방산" },
  { symbol: "URA", name: "우라늄" },
  { symbol: "XBI", name: "바이오" },
  { symbol: "EWY", name: "한국(MSCI)" },
];
const RECENT_KEY = "vntg.usEtfHoldings.recent";

export function UsEtfHoldingsPage() {
  const [q, setQ] = useState("");
  const [symbol, setSymbol] = useState<string>(() => {
    try {
      return (JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[])[0] ?? "SPY";
    } catch {
      return "SPY";
    }
  });
  const [data, setData] = useState<UsEtfHoldings | null>(null);
  const [busy, setBusy] = useState(false);
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const [recent, setRecent] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setData(null);
    api
      .usEtfHoldings(symbol)
      .then((d) => alive && setData(d))
      .catch((e: Error) => alive && setData({ symbol, holdings: [], sectors: [], error: e.message }))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [symbol]);

  const go = (s: string) => {
    const sym = s.trim().toUpperCase();
    if (!sym) return;
    setSymbol(sym);
    setQ("");
    const next = [sym, ...recent.filter((r) => r !== sym)].slice(0, 10);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* */
    }
  };

  const top = data?.holdings.reduce((s, h) => s + (h.weight ?? 0), 0) ?? 0;
  const preset = PRESETS.find((p) => p.symbol === symbol);

  return (
    <div className="page">
      <p className="page-note">
        미국 ETF 심볼을 넣으면 <b>상위 구성종목·비중·섹터 쏠림</b>. 「이 ETF 가 사실은 무엇에 걸려 있나」를 보는 자리 — 종목을 누르면 해외 상세.
      </p>
      <div className="filter-row">
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="심볼 (예: SMH)" onKeyDown={(e) => e.key === "Enter" && go(q)} />
        <button type="button" className="filter-btn" onClick={() => go(q)}>
          보기
        </button>
      </div>
      <div className="filter-row" style={{ flexWrap: "wrap" }}>
        {PRESETS.map((p) => (
          <button key={p.symbol} type="button" className={`filter-btn${symbol === p.symbol ? " on" : ""}`} onClick={() => go(p.symbol)} title={p.name}>
            {p.symbol} <span className="pt-n">{p.name}</span>
          </button>
        ))}
        {recent.filter((r) => !PRESETS.some((p) => p.symbol === r)).map((r) => (
          <button key={r} type="button" className={`filter-btn${symbol === r ? " on" : ""}`} onClick={() => go(r)}>
            {r}
          </button>
        ))}
      </div>
      <section className="card">
        <h3>
          {symbol} {preset && <span className="usm-sub">{preset.name}</span>}
          {top > 0 && <span className="usm-sub">상위 {data?.holdings.length}종목 합계 비중 {top.toFixed(1)}%</span>}
          <button type="button" className="link-btn" style={{ marginLeft: 8 }} onClick={() => setChart({ kind: "yahoo", symbol, label: `${preset?.name ?? symbol} (${symbol})`, digits: 2 })}>
            차트 →
          </button>
        </h3>
        {busy && <div className="empty">받는 중…</div>}
        {data?.error && <div className="alert-note">{data.error}</div>}
        {data && !data.error && data.holdings.length === 0 && !busy && <div className="empty">구성종목이 없습니다 — ETF 가 아니거나 야후가 안 줍니다.</div>}
        {data && data.sectors.length > 0 && (
          <div className="etfh-secs" style={{ marginBottom: 8 }}>
            {data.sectors.slice(0, 8).map((s) => (
              <span className="etfh-sec" key={s.name}>
                {s.name} <b>{s.weight.toFixed(0)}%</b>
              </span>
            ))}
          </div>
        )}
        {data && data.holdings.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th className="sticky-col">종목</th>
                  <th>심볼</th>
                  <th>비중</th>
                  <th>비중 막대</th>
                </tr>
              </thead>
              <tbody>
                {data.holdings.map((h, i) => (
                  <tr key={h.symbol} className="clickable-row" onClick={() => setChart({ kind: "usStock", symbol: h.symbol, label: `${h.name || h.symbol} (${h.symbol})`, digits: 2 })}>
                    <td className="num">{i + 1}</td>
                    <td className="sticky-col">{h.name || h.symbol}</td>
                    <td>{h.symbol}</td>
                    <td className="num">{h.weight === null ? "-" : `${h.weight.toFixed(2)}%`}</td>
                    <td>
                      <div className="ueh-bar">
                        <i style={{ width: `${Math.min(100, ((h.weight ?? 0) / Math.max(1, data.holdings[0].weight ?? 1)) * 100)}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <div className="table-note">야후가 주는 상위 종목만입니다 — 전체 구성이 아닙니다. 하루 한 번 받아 둡니다. 국내 ETF 구성종목은 「ETF」 메뉴의 구성종목 분석.</div>
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
