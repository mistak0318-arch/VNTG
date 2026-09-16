import { useEffect, useMemo, useState } from "react";
import { api, type EtfListRow } from "../api";

/**
 * **ETF 순위** (2026-09-17 — ETF 분석 묶음). 전 상장 ETF(~1,000)를 여섯 판으로 —
 * 거래대금 · 상승 · 하락 · 프리미엄(괴리율 +) · 디스카운트(괴리율 −) · 추적오차.
 * 「시세·NAV」 탭은 내 목록·검색 중심이고, 여기는 **전체에서 튀는 것**이 먼저 보이는 자리다.
 * 재료는 같은 ETF 전체시세(ka40004, 3분 캐시) — 조회가 늘지 않는다. 얇은 ETF(거래대금 10억 미만)는 괴리율 판에서 뺀다.
 */
function pct(v: number | null): string {
  return v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
function cls(v: number | null): string {
  return v === null || v === 0 ? "" : v > 0 ? "up" : "down";
}

type Board = { key: string; title: string; hint: string; rows: EtfListRow[]; value: (r: EtfListRow) => string; vcls: (r: EtfListRow) => string };

export function EtfRankPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [rows, setRows] = useState<EtfListRow[] | null>(null);
  const [at, setAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [minTv, setMinTv] = useState(10);

  useEffect(() => {
    let alive = true;
    const pull = () =>
      api
        .etfList()
        .then((r) => {
          if (!alive) return;
          setRows(r.rows);
          setAt(r.at);
        })
        .catch((e: Error) => alive && setError(e.message));
    void pull();
    const t = window.setInterval(pull, 3 * 60_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);

  const boards = useMemo<Board[]>(() => {
    if (!rows) return [];
    const liquid = rows.filter((r) => r.tradeValue >= minTv);
    const top = (list: EtfListRow[], by: (r: EtfListRow) => number, n = 15) => [...list].sort((a, b) => by(b) - by(a)).slice(0, n);
    const withDev = liquid.filter((r) => r.deviation !== null);
    return [
      { key: "tv", title: "거래대금", hint: "오늘 돈이 제일 많이 오간 ETF", rows: top(rows, (r) => r.tradeValue), value: (r) => `${r.tradeValue.toLocaleString("ko-KR")}억`, vcls: () => "" },
      { key: "up", title: "상승", hint: `거래대금 ${minTv}억 이상`, rows: top(liquid, (r) => r.changeRate), value: (r) => pct(r.changeRate), vcls: (r) => cls(r.changeRate) },
      { key: "down", title: "하락", hint: `거래대금 ${minTv}억 이상`, rows: top(liquid, (r) => -r.changeRate), value: (r) => pct(r.changeRate), vcls: (r) => cls(r.changeRate) },
      { key: "prem", title: "프리미엄 (괴리율 +)", hint: "NAV 보다 비싸게 — 추격 매수가 몰린 자리", rows: top(withDev, (r) => r.deviation ?? 0), value: (r) => pct(r.deviation), vcls: () => "up" },
      { key: "disc", title: "디스카운트 (괴리율 −)", hint: "NAV 보다 싸게 — 투매거나 LP 가 빠진 자리", rows: top(withDev, (r) => -(r.deviation ?? 0)), value: (r) => pct(r.deviation), vcls: () => "down" },
      { key: "trace", title: "추적오차 큰 순", hint: "지수를 못 따라가는 ETF — 장기 보유엔 손해", rows: top(liquid.filter((r) => r.traceErr !== null), (r) => r.traceErr ?? 0), value: (r) => `${(r.traceErr ?? 0).toFixed(2)}%`, vcls: () => "" },
    ];
  }, [rows, minTv]);

  if (error) return <div className="page-note">ETF 전체시세를 못 받았습니다 — {error}</div>;
  if (!rows) return <div className="page-note">불러오는 중…</div>;

  return (
    <div className="page">
      <p className="page-note">
        전 상장 ETF <b>{rows.length.toLocaleString("ko-KR")}</b>개에서 튀는 것 여섯 판. 괴리율은 (현재가 − NAV) ÷ NAV — 플러스면 NAV 보다 비싸게 거래 중.
        {at ? ` · ${new Date(at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준` : ""}
      </p>
      <div className="filter-row">
        <span className="pt-n">거래대금 하한</span>
        {[1, 10, 50, 100].map((v) => (
          <button key={v} type="button" className={`filter-btn${minTv === v ? " on" : ""}`} onClick={() => setMinTv(v)}>
            {v}억
          </button>
        ))}
      </div>
      <div className="etr-grid">
        {boards.map((b) => (
          <section className="card" key={b.key}>
            <h3>
              {b.title} <span className="usm-sub">{b.hint}</span>
            </h3>
            <div className="ubz-list">
              {b.rows.length === 0 && <div className="empty">해당 없음</div>}
              {b.rows.map((r, i) => (
                <button key={r.code} type="button" className="ubz-row" onClick={() => onSelectStock(r.code, r.name)}>
                  <b>{i + 1}</b>
                  <span className="ubz-nm">
                    {r.name} <i>{r.tradeValue.toLocaleString("ko-KR")}억</i>
                  </span>
                  <em className={`num ${b.vcls(r)}`}>{b.value(r)}</em>
                  <i className={`ubz-jp ${cls(r.changeRate)}`}>{b.key === "up" || b.key === "down" ? "" : pct(r.changeRate)}</i>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="table-note">거래대금은 현재가 × 거래량 어림(ka40004 가 거래대금을 안 줍니다). 괴리율·추적오차는 키움 값. 행을 누르면 ETF 상세(구성종목·과세유형).</div>
    </div>
  );
}
