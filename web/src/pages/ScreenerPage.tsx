import { useEffect, useState } from "react";
import { api, fmtNum, type RankResult, type RankSpecGroup } from "../api";
import { SameNetTradeRankingPage } from "./SameNetTradeRankingPage";
import { ContinuousTradePage } from "./ContinuousTradePage";
import { TopTradersTable } from "../components/TopTradersTable";

/**
 * 시세분석 — **실제로 보는 다섯 개를 앞에 세운다.**
 *
 * ## 왜 다시 짰나
 *
 * 예전엔 왼쪽 트리에 열두 개가 늘어서 있었다. 서버 명세를 그대로 그린 것이라
 * **만들기는 편했지만 쓰기는 불편했다** — 매번 트리를 훑어 같은 것을 찾게 된다.
 * 실제로 보는 것은 다섯이고 나머지는 가끔이다. 다섯을 탭으로 앞에 세우고
 * 나머지는 「그 밖에」에 그대로 둔다(쓰던 것을 지우지는 않는다).
 *
 * ## 거래소 토글
 *
 * 키움의 「통합」은 실측하면 KRX 와 같은 값이라, NXT 에서만 급등한 종목은
 * 기본 조회에 아예 안 나온다. 그래서 토글을 남겨 둔다.
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

/**
 * 위에 세울 다섯 — 실제로 보던 것들.
 *
 * `rank` 는 서버 명세를 그리는 기존 machinery 를 그대로 쓴다.
 * `page` 는 이미 따로 있던 화면을 그대로 끼운다 — 같은 표를 두 벌 만들면
 * 한쪽만 고쳐지는 날이 온다.
 */
const TABS = [
  { key: "trade-value", label: "거래대금 상위", kind: "rank" as const },
  { key: "same-net", label: "기관/외국인 동일 순매매", kind: "page" as const },
  { key: "cont", label: "기관/외국인 연속매매", kind: "page" as const },
  { key: "flu-rate", label: "등락률 상위", kind: "rank" as const },
  { key: "top-traders", label: "수익률 상위고객", kind: "page" as const },
  { key: "etc", label: "그 밖에", kind: "tree" as const },
];

export function ScreenerPage({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [groups, setGroups] = useState<RankSpecGroup[]>([]);
  const [tab, setTab] = useState<string>("trade-value");
  const [active, setActive] = useState("flu-rate");
  const [market, setMarket] = useState("000");
  const [exchange, setExchange] = useState("3");
  const [data, setData] = useState<RankResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 지금 그릴 명세 — 탭이 rank 면 탭 것, 「그 밖에」면 트리에서 고른 것 */
  const current = TABS.find((t) => t.key === tab);
  const rankKey = current?.kind === "rank" ? tab : active;

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
      .rank(rankKey, market, exchange)
      .then((r) => !cancelled && setData(r))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [rankKey, market, exchange]);

  const cols = data?.spec.columns ?? [];

  return (
    <div>
      {/* 실제로 보는 다섯이 앞이다 — 트리를 매번 훑지 않게 */}
      <div className="filter-row scr-tabs">
        {TABS.map((t) => (
          <button
            key={t.key}
            className={`filter-btn ${tab === t.key ? "active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "same-net" && <SameNetTradeRankingPage onSelectStock={onSelectStock ?? (() => {})} />}
      {tab === "cont" && <ContinuousTradePage onSelectStock={onSelectStock ?? (() => {})} />}
      {tab === "top-traders" && <TopTradersTable onSelectStock={onSelectStock} />}

      {current?.kind !== "page" && (
        <div className="screener">
          {/* 「그 밖에」일 때만 트리를 편다 — 다섯 탭에서는 자리만 먹는다 */}
          {tab === "etc" && (
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
          )}

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
      )}
    </div>
  );
}
