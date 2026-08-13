import { useEffect, useState } from "react";
import { api, normalizeStockCode, type TradeSummary } from "../api";

/**
 * 수출입 동향.
 *
 * 오늘 등락률만 보면 왜 오르는지 모른다. 수출이 같이 늘고 있으면 근거가 있는 강세고,
 * **수출이 꺾이는데 지수만 오르면 그게 짚어야 할 신호다.**
 *
 * 관세청 데이터는 월 단위 갱신이라 매일 볼 것은 아니지만,
 * 섹터를 고를 때 한 번 확인하면 판단이 달라진다.
 */

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function rateClass(n: number | null): string {
  if (n === null) return "";
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

interface Related {
  stocks: { code: string; name: string; changeRate: number; marketCap?: number | null }[];
  from: "theme" | "sector" | "none";
  label: string;
}

export function TradePanel({ onSelectStock }: { onSelectStock?: (code: string, name: string) => void }) {
  const [items, setItems] = useState<TradeSummary[]>([]);
  const [fetchedAt, setFetchedAt] = useState("");
  const [configured, setConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  // 관련 종목은 펼칠 때만 부른다 — 31품목을 한꺼번에 받으면 첫 조회가 훨씬 느려진다
  const [related, setRelated] = useState<Record<string, Related | "loading">>({});

  function toggle(key: string) {
    if (open === key) {
      setOpen(null);
      return;
    }
    setOpen(key);
    if (!related[key]) {
      setRelated((p) => ({ ...p, [key]: "loading" }));
      api
        .tradeStocks(key)
        .then((r) => setRelated((p) => ({ ...p, [key]: r })))
        .catch(() => setRelated((p) => ({ ...p, [key]: { stocks: [], from: "none", label: "" } })));
    }
  }

  function load(force = false) {
    setLoading(true);
    api
      .trade(force)
      .then((r) => {
        setItems(r.items);
        setFetchedAt(r.fetchedAt);
        setConfigured(r.configured);
        setError(r.error ?? null);
      })
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }

  useEffect(() => load(), []);

  if (!configured) {
    return (
      <div className="page-note">
        <b>수출입 API 키가 설정되지 않았습니다.</b>
        <br />
        관세청 수출입 통계는 공공데이터포털 키가 필요합니다 (개발계정 자동승인, 무료, 일 1만건).
        <br />
        발급 절차는 <code>docs/수출입API_설정가이드.md</code> 를 보세요. 키를 받으면{" "}
        <code>server/.env</code> 의 <code>DATA_GO_KR_KEY</code> 에 <b>Decoding 키</b>를 넣습니다.
      </div>
    );
  }

  if (loading && items.length === 0) return <div className="empty">수출입 통계 불러오는 중…</div>;

  const month = items[0]?.month ?? "";
  const val = (i: TradeSummary) => (i.watch === "import" ? i.importUsd : i.exportUsd);
  const rate = (i: TradeSummary) => (i.watch === "import" ? i.importYoy : i.exportYoy);
  const sorted = [...items].sort((a, b) => (rate(b) ?? -999) - (rate(a) ?? -999));

  return (
    <div className="trade">
      <div className="filter-row">
        <span className="breadth-count" style={{ marginLeft: 0 }}>
          {month} 기준 · 관세청
        </span>
        <button className="filter-btn" onClick={() => load(true)} disabled={loading}>
          {loading ? "…" : "↻ 새로고침"}
        </button>
        {fetchedAt && (
          <span className="breadth-count">{fetchedAt.slice(5, 16).replace("T", " ")} 조회</span>
        )}
      </div>

      {error && <div className="page-note">{error}</div>}

      <div className="data-table-wrap">
        <table className="data-table num">
          <thead>
            <tr>
              <th className="sticky-col">품목</th>
              <th>구분</th>
              <th>금액(억$)</th>
              <th>전년동월</th>
              <th>대응 업종</th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((i) => (
              <tr
                key={i.key}
                className="trade-row"
                onClick={() => toggle(i.key)}
                title={i.note}
              >
                <td className="sticky-col">{i.label}</td>
                <td>{i.watch === "import" ? "수입" : "수출"}</td>
                <td>{(val(i) / 1e8).toFixed(1)}</td>
                <td className={rateClass(rate(i))}>{pct(rate(i))}</td>
                <td style={{ textAlign: "left" }}>{i.sectors.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {open && (
        <div className="trade-detail">
          {(() => {
            const i = items.find((x) => x.key === open);
            if (!i) return null;
            return (
              <>
                <div className="trade-note">{i.note}</div>
                {i.top.length > 0 && (
                  <>
                    <div className="trade-sub">세부 품목</div>
                    <div className="trade-top">
                      {i.top.map((t) => (
                        <div className="trade-top-row" key={t.name}>
                          <span className="trade-top-name">{t.name}</span>
                          <span className="num">{(t.exportUsd / 1e8).toFixed(1)}억$</span>
                          <span className={`num ${rateClass(t.yoy)}`}>{pct(t.yoy)}</span>
                        </div>
                      ))}
                    </div>
                  </>
                )}

                {(() => {
                  const r = related[i.key];
                  if (r === "loading") return <div className="trade-sub">관련 종목 찾는 중…</div>;
                  if (!r || r.stocks.length === 0) return null;
                  return (
                    <>
                      <div className="trade-sub">
                        관련 종목 · {r.label}
                        {r.from === "sector" && " (업종 전체 — 테마가 없어 거칠 수 있습니다)"}
                      </div>
                      <div className="trade-stocks">
                        {r.stocks.map((st) => (
                          <button
                            key={st.code}
                            className="trade-stock"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSelectStock?.(normalizeStockCode(st.code), st.name);
                            }}
                          >
                            <span className="trade-stock-name">{st.name}</span>
                            <span className={`num ${st.changeRate > 0 ? "positive" : st.changeRate < 0 ? "negative" : ""}`}>
                              {st.changeRate > 0 ? "+" : ""}
                              {st.changeRate.toFixed(2)}%
                            </span>
                          </button>
                        ))}
                      </div>
                    </>
                  );
                })()}
              </>
            );
          })()}
        </div>
      )}

      <div className="table-note">
        품목을 누르면 <b>세부 항목과 관련 종목</b>이 열립니다. 종목을 누르면 상세로 이동합니다.
        종목은 <b>키움 테마 구성종목</b>을 그대로 씁니다 — 종목코드를 손으로 적으면 상장폐지·합병을
        따라갈 수 없습니다. 관세청은 월 단위로 확정치를
        내고 우리는 12시간 캐시를 둡니다. <b>원유·반도체 장비는 수입 기준</b>입니다 — 사오기만 하는
        품목이라 수출로 보면 의미가 없습니다. 반도체 장비 수입 증가는 향후 증설을 뜻해 소부장 실적을
        선행합니다.
      </div>
    </div>
  );
}
