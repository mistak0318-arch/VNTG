import { useEffect, useState } from "react";
import { api, type UsEvent } from "../api";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";

/**
 * **실적·일정(해외)** (2026-09-17). 해외 관심종목의 다음 실적 발표일·예상 EPS·배당락일을 날짜순으로.
 * 야후 quoteSummary(calendarEvents) — 심볼별 6시간 캐시. 관심종목이 아닌 종목은 아래 칸에 심볼을 넣어 더 볼 수 있다.
 * 국내 캘린더의 경제지표 탭과 짝이다 — 그쪽은 시장 일정, 여기는 **내 종목** 일정.
 */
const BIG = ["AAPL", "MSFT", "NVDA", "AMZN", "GOOGL", "META", "TSLA", "AVGO", "JPM", "NFLX"];

export function UsEventsPage() {
  const [events, setEvents] = useState<UsEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [extra, setExtra] = useState("");
  const [extraSyms, setExtraSyms] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("vntg.usEvents.extra") ?? "[]") as string[];
    } catch {
      return [];
    }
  });
  const [chart, setChart] = useState<ChartTarget | null>(null);
  const [names, setNames] = useState<Record<string, string>>({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const w = await api.usWatch().catch(() => null);
        const nm: Record<string, string> = {};
        const mine = new Set<string>();
        for (const g of w?.groups ?? []) for (const s of g.stocks) {
          mine.add(s.symbol);
          nm[s.symbol] = s.name;
        }
        /* 서버는 앞 100개만 본다 — 내가 손으로 넣은 것 → 관심종목 → 대형주 순으로 잘리게 */
        const syms = [...new Set([...extraSyms, ...mine, ...BIG])];
        if (!alive) return;
        setNames(nm);
        const r = await api.usEvents(syms);
        if (alive) setEvents(r.events);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [extraSyms]);

  const addExtra = () => {
    const s = extra.trim().toUpperCase();
    if (!s || extraSyms.includes(s)) return;
    const next = [...extraSyms, s];
    setExtraSyms(next);
    try {
      localStorage.setItem("vntg.usEvents.extra", JSON.stringify(next));
    } catch {
      /* 못 남겨도 이번엔 산다 */
    }
    setExtra("");
  };

  if (error) return <div className="page-note">못 받았습니다 — {error}</div>;

  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const rows = (events ?? [])
    .flatMap((e) => {
      const out: { symbol: string; kind: "실적" | "배당락" | "배당지급"; date: string; eps: number | null; rev: number | null; err?: string }[] = [];
      for (const d of e.earnings) out.push({ symbol: e.symbol, kind: "실적", date: d, eps: e.epsEstimate, rev: e.revenueEstimate });
      if (e.exDividend) out.push({ symbol: e.symbol, kind: "배당락", date: e.exDividend, eps: null, rev: null });
      if (e.dividendDate) out.push({ symbol: e.symbol, kind: "배당지급", date: e.dividendDate, eps: null, rev: null });
      if (e.error) out.push({ symbol: e.symbol, kind: "실적", date: "", eps: null, rev: null, err: e.error });
      return out;
    })
    .filter((r) => r.err || r.date >= today)
    .sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"));

  return (
    <div className="page">
      <p className="page-note">
        <b>해외 관심종목</b>(전 그룹) + 대형주 열 종목의 다음 실적 발표일·예상 EPS·배당락. 실적 발표 직후 갭이 크니 <b>발표일 전날</b>은
        포지션 크기를 줄여 보는 자리입니다. 심볼을 더 넣어 볼 수도 있습니다.
      </p>
      <div className="filter-row">
        <input className="search-input" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="심볼 추가 (예: AMD)" onKeyDown={(e) => e.key === "Enter" && addExtra()} />
        <button type="button" className="filter-btn" onClick={addExtra}>
          + 추가
        </button>
        {extraSyms.map((s) => (
          <button
            key={s}
            type="button"
            className="filter-btn"
            title="누르면 뺍니다"
            onClick={() => {
              const next = extraSyms.filter((x) => x !== s);
              setExtraSyms(next);
              try {
                localStorage.setItem("vntg.usEvents.extra", JSON.stringify(next));
              } catch {
                /* */
              }
            }}
          >
            {s} ✕
          </button>
        ))}
      </div>
      {!events && <div className="empty">야후에서 일정을 받는 중…</div>}
      {events && rows.length === 0 && <div className="empty">앞으로 잡힌 일정이 없습니다.</div>}
      {rows.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>날짜</th>
                <th>D-</th>
                <th className="sticky-col">종목</th>
                <th>무엇</th>
                <th>예상 EPS</th>
                <th>예상 매출</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const dday = r.date ? Math.round((Date.parse(r.date) - Date.parse(today)) / 86_400_000) : null;
                return (
                  <tr key={`${r.symbol}-${r.kind}-${r.date}-${i}`} className="clickable-row" onClick={() => setChart({ kind: "usStock", symbol: r.symbol, label: `${names[r.symbol] ?? r.symbol} (${r.symbol})`, digits: 2 })}>
                    <td className="num">{r.date || "-"}</td>
                    <td className={`num ${dday !== null && dday <= 3 ? "up" : ""}`}>{dday === null ? "-" : dday === 0 ? "오늘" : `D-${dday}`}</td>
                    <td className="sticky-col">
                      {names[r.symbol] ?? r.symbol} <span className="pt-n">{r.symbol}</span>
                    </td>
                    <td>{r.err ? <span className="pt-n">못 받음 — {r.err.slice(0, 30)}</span> : r.kind}</td>
                    <td className="num">{r.eps === null ? "-" : r.eps.toFixed(2)}</td>
                    <td className="num">{r.rev === null ? "-" : r.rev >= 1e9 ? `$${(r.rev / 1e9).toFixed(2)}B` : `$${(r.rev / 1e6).toFixed(0)}M`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div className="table-note">실적일이 두 날짜로 오면 야후가 「범위」로 준 것입니다(확정 전). 시각(장 전·장 후)은 야후가 안 줍니다.</div>
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
