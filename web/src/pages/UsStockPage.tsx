import { useEffect, useState } from "react";
import { api, type UsSearchResult } from "../api";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";

/**
 * **개별종목분석(해외)** (2026-09-17). 국내 「개별종목분석」의 짝 — 심볼·이름으로 찾아 해외 상세 시트(차트·SEC 재무·야후 의견·
 * 국내 연동)를 연다. 최근 본 종목은 이 기기에 남긴다. 상세 자체는 이미 있던 `YahooChartSheet(usStock)` 이다 —
 * 여태 관심종목(해외)·시세분석(해외) 표에서만 열 수 있어서 메뉴로 낸 것.
 */
const RECENT_KEY = "vntg.usStock.recent";

export function UsStockPage() {
  const [q, setQ] = useState("");
  const [results, setResults] = useState<UsSearchResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const [recent, setRecent] = useState<{ symbol: string; name: string }[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]") as { symbol: string; name: string }[];
    } catch {
      return [];
    }
  });

  useEffect(() => {
    const s = q.trim();
    if (s.length < 1) {
      setResults([]);
      return;
    }
    let alive = true;
    setBusy(true);
    const t = window.setTimeout(() => {
      api
        .usWatchSearch(s)
        .then((r) => alive && setResults(r.results.filter((x) => !x.nation || x.nation === "USA").slice(0, 20)))
        .catch(() => alive && setResults([]))
        .finally(() => alive && setBusy(false));
    }, 250);
    return () => {
      alive = false;
      window.clearTimeout(t);
    };
  }, [q]);

  const open = (symbol: string, name: string) => {
    setChart({ kind: "usStock", symbol, label: `${name} (${symbol})`, digits: 2 });
    const next = [{ symbol, name }, ...recent.filter((r) => r.symbol !== symbol)].slice(0, 12);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* */
    }
  };

  return (
    <div className="page">
      <p className="page-note">
        심볼(NVDA)이나 이름(엔비디아)으로 찾아 누르면 <b>해외 상세</b>가 열립니다 — 차트 · SEC 재무 · 야후 의견·실적 · 국내 연동 종목.
      </p>
      <div className="filter-row">
        <input className="search-input" autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="심볼 또는 이름" />
        {busy && <span className="pt-n">찾는 중…</span>}
      </div>
      {results.length > 0 && (
        <div className="uss-list">
          {results.map((r) => (
            <button key={`${r.exchange}:${r.symbol}`} type="button" className="uss-row" onClick={() => open(r.symbol, r.name)}>
              <b>{r.symbol}</b>
              <span>{r.name}</span>
              <i>
                {r.exchange} {r.type}
              </i>
            </button>
          ))}
        </div>
      )}
      {q.trim() === "" && recent.length > 0 && (
        <section className="card">
          <h3>최근 본 종목</h3>
          <div className="uss-list">
            {recent.map((r) => (
              <button key={r.symbol} type="button" className="uss-row" onClick={() => open(r.symbol, r.name)}>
                <b>{r.symbol}</b>
                <span>{r.name}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
