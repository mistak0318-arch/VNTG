import { useEffect, useState } from "react";
import { api, type UsSector, type UsSectorMap } from "../api";
import { YahooChartSheet, type ChartTarget } from "../components/overview/YahooChartSheet";

/**
 * **업종 MAP(해외)** (2026-09-17 — 벤티지가 종목분석(해외) 묶음에서 고름).
 *
 * 한투 42업종을 국내 테마/업종 MAP 과 같은 모양의 히트맵으로. 칸 크기는 거래대금 가중치, 색은 가중 등락률.
 * 업종을 누르면 그 업종 종목(거래대금 순)이 아래 표로, 종목을 누르면 해외 상세 시트(차트·재무·의견).
 * 재료는 한투 REST 두 TR(9/16 밤 실측) — 15분 캐시라 첫 로딩은 30초쯤 걸릴 수 있다.
 */
function pct(v: number | null): string {
  return v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}
function heat(rate: number | null): string {
  if (rate === null) return "var(--panel-2)";
  const a = Math.min(Math.abs(rate) / 3, 1) * 0.55 + 0.1;
  return rate >= 0 ? `color-mix(in srgb, var(--red) ${Math.round(a * 100)}%, var(--panel-2))` : `color-mix(in srgb, var(--blue) ${Math.round(a * 100)}%, var(--panel-2))`;
}

export function UsSectorMapPage() {
  const [data, setData] = useState<UsSectorMap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<string | null>(null);
  const [chart, setChart] = useState<ChartTarget | null>(null);

  const load = () => {
    setError(null);
    api
      .usSectors()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  };
  useEffect(load, []);

  const sectors = data?.sectors ?? [];
  const maxT = Math.max(1, ...sectors.map((s) => s.turnover));
  const chosen: UsSector | undefined = sectors.find((s) => s.code === pick);

  return (
    <div className="page usm">
      <p className="page-note">
        한투 <b>42업종</b>을 나스닥·뉴욕 종목으로 묶어 그린 지도입니다. 칸은 <b>거래대금</b>, 색은 <b>거래대금 가중 등락률</b>.
        업종을 누르면 그 업종 종목이 아래에 뜹니다. {data?.stale && <b>· 새로 못 받아 옛 값</b>}
        {data?.at ? ` · ${new Date(data.at).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 기준` : ""}
        <button type="button" className="filter-btn" style={{ marginLeft: 8 }} onClick={load}>
          ↻ 새로고침
        </button>
      </p>
      {error && <div className="alert-note">업종 지도를 못 받았습니다 — {error}</div>}
      {data?.error && <div className="alert-note">{data.error}</div>}
      {!data && !error && <div className="empty">한투에서 42업종을 받는 중… (첫 로딩 30초쯤)</div>}

      {sectors.length > 0 && (
        <div className="usm-grid">
          {sectors.map((s) => {
            const size = Math.max(0.6, Math.sqrt(s.turnover / maxT) * 2.2);
            return (
              <button
                key={s.code}
                type="button"
                className={`usm-cell${pick === s.code ? " on" : ""}`}
                style={{ background: heat(s.rate), flexGrow: size, minWidth: `${Math.round(90 + size * 40)}px` }}
                onClick={() => setPick((v) => (v === s.code ? null : s.code))}
                title={`${s.name} · ${s.count}종목 · 상승 ${s.up} / 하락 ${s.down}`}
              >
                <span className="usm-name">{s.name}</span>
                <b className="usm-rate">{pct(s.rate)}</b>
                <i className="usm-ud">
                  ▲{s.up} ▼{s.down}
                </i>
              </button>
            );
          })}
        </div>
      )}

      {chosen && (
        <section className="card">
          <h3>
            {chosen.name} <span className="usm-sub">{chosen.count}종목 · 가중 {pct(chosen.rate)}</span>
          </h3>
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">종목</th>
                  <th>거래소</th>
                  <th>현재가</th>
                  <th>등락률</th>
                  <th>거래량</th>
                </tr>
              </thead>
              <tbody>
                {chosen.stocks.slice(0, 60).map((st) => (
                  <tr
                    key={`${st.exchange}:${st.symbol}`}
                    className="clickable-row"
                    onClick={() => setChart({ kind: "usStock", symbol: st.symbol, label: `${st.name} (${st.symbol})`, digits: 2 })}
                  >
                    <td className="sticky-col">
                      {st.name} <span className="pt-n">{st.symbol}</span>
                    </td>
                    <td>{st.exchange}</td>
                    <td className="num">{st.price === null ? "-" : st.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}</td>
                    <td className={`num ${st.rate === null ? "" : st.rate > 0 ? "up" : st.rate < 0 ? "down" : ""}`}>{pct(st.rate)}</td>
                    <td className="num">{st.volume === null ? "-" : st.volume.toLocaleString("en-US")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="table-note">거래대금(현재가×거래량) 순. 종목을 누르면 해외 상세(차트·SEC 재무·야후 의견)가 열립니다.</div>
        </section>
      )}
      {chart && <YahooChartSheet target={chart} onClose={() => setChart(null)} />}
    </div>
  );
}
