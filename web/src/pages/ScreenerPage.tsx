import { useEffect, useState } from "react";
import { api, fmtNum, type RankResult, type RankSpecGroup } from "../api";

/**
 * 시세분석.
 *
 * 키움 [0194] 순위분석에 있는 목록들을 한 화면에서 본다.
 * 왼쪽 트리에서 고르고 오른쪽에 표가 뜨는 구조 — 항목이 계속 늘어날 것이므로
 * 화면을 목록마다 만들지 않고 **서버 명세(rankSpecs.ts)를 그려주기만** 한다.
 *
 * 거래소 토글이 중요하다. 키움의 "통합"은 실측하면 KRX와 같은 값이라,
 * NXT에서만 급등한 종목은 기본 조회에 아예 안 나온다.
 */

const MARKETS = [
  { key: "000", label: "전체" },
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
];

const EXCHANGES = [
  { key: "3", label: "통합", hint: "실측상 KRX와 같은 값이 나옵니다" },
  { key: "1", label: "KRX", hint: "한국거래소" },
  { key: "2", label: "NXT", hint: "대체거래소 — 여기서만 움직인 종목이 있습니다" },
];

function cell(value: unknown, type?: string): { text: string; cls: string } {
  if (type === "text") return { text: String(value ?? ""), cls: "" };
  if (value === null || value === undefined) return { text: "-", cls: "" };
  const n = Number(value);
  if (!Number.isFinite(n)) return { text: "-", cls: "" };
  const sign = n > 0 ? "positive" : n < 0 ? "negative" : "";
  if (type === "pct") return { text: `${n > 0 ? "+" : ""}${n.toFixed(2)}%`, cls: sign };
  // 가격은 부호로 색을 칠하지 않는다 (음수 표기는 하락을 뜻하는 키움 관행이라 헷갈린다)
  if (type === "price") return { text: fmtNum(Math.abs(n)), cls: "" };
  return { text: fmtNum(n), cls: sign };
}

export function ScreenerPage({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [groups, setGroups] = useState<RankSpecGroup[]>([]);
  const [active, setActive] = useState("flu-rate");
  const [market, setMarket] = useState("000");
  const [exchange, setExchange] = useState("3");
  const [data, setData] = useState<RankResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .rankSpecs()
      .then((r) => setGroups(r.groups))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .rank(active, market, exchange)
      .then((r) => !cancelled && setData(r))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [active, market, exchange]);

  const cols = data?.spec.columns ?? [];

  return (
    <div className="screener">
      <aside className="scr-tree">
        {groups.map((g) => (
          <div className="scr-group" key={g.group}>
            <div className="scr-group-name">{g.group}</div>
            {g.items.map((it) => (
              <button
                key={it.key}
                className={`scr-item${active === it.key ? " active" : ""}`}
                onClick={() => setActive(it.key)}
              >
                {it.label}
              </button>
            ))}
          </div>
        ))}
      </aside>

      <div className="scr-main">
        <div className="filter-row">
          {MARKETS.map((m) => (
            <button
              key={m.key}
              className={`filter-btn ${market === m.key ? "active" : ""}`}
              onClick={() => setMarket(m.key)}
            >
              {m.label}
            </button>
          ))}
          {data?.spec.exchange && (
            <>
              <span className="news-scope-sep" />
              {EXCHANGES.map((e) => (
                <button
                  key={e.key}
                  className={`filter-btn ${exchange === e.key ? "active" : ""}`}
                  onClick={() => setExchange(e.key)}
                  title={e.hint}
                >
                  {e.label}
                </button>
              ))}
            </>
          )}
          {data && <span className="breadth-count">{data.rows.length}건</span>}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {loading && !data && <div className="empty">불러오는 중…</div>}

        {data && (
          <>
            <h3 className="section-heading">{data.spec.label}</h3>
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th className="sticky-col">종목명</th>
                    {cols
                      .filter((c) => c.key !== "stk_nm")
                      .map((c) => (
                        <th key={c.key}>{c.label}</th>
                      ))}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map((r, i) => (
                    <tr key={`${r.code}-${i}`}>
                      <td className="sticky-col">
                        <button
                          className="link-btn"
                          onClick={() => onSelectStock?.(r.code, r.name)}
                        >
                          {r.name}
                        </button>
                      </td>
                      {cols
                        .filter((c) => c.key !== "stk_nm")
                        .map((c) => {
                          const v = cell(r[c.key], c.type);
                          return (
                            <td key={c.key} className={`num ${v.cls}`}>
                              {v.text}
                            </td>
                          );
                        })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {data.rows.length === 0 && (
              <div className="empty">
                조회 결과가 없습니다. 장 시간에만 값이 들어오는 항목일 수 있습니다.
              </div>
            )}
            {data.spec.note && <div className="table-note">{data.spec.note}</div>}
          </>
        )}
      </div>
    </div>
  );
}
