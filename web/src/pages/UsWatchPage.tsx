import { useEffect, useState } from "react";
import { api, type UsSearchResult, type UsWatchGroup } from "../api";
import { RefreshBar } from "../components/RefreshBar";

/**
 * 관심종목 (미국).
 *
 * 국내 테마는 키움이 시세를 주지만 미국은 안 준다. 그런데 **밤사이 미국이 오늘 국내를
 * 정한다** — 미국↔국내 테마 연동에서 이미 확인한 것이고, 그래서 미국 쪽도 내가 짠
 * 그룹으로 들고 있어야 한다.
 *
 * 그룹·종목은 전부 직접 편집한다. 티커를 외울 필요는 없다 — 이름으로 찾아 담는다.
 */

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function cls(n: number | null): string {
  if (n === null) return "";
  return n > 0 ? "positive" : n < 0 ? "negative" : "";
}

/** 미국 시장은 우리 밤에 열린다 — 지금 열려 있는지 알려줘야 값이 언제 것인지 안다 */
const STATE_LABEL: Record<string, string> = {
  REGULAR: "정규장",
  PRE: "프리마켓",
  POST: "애프터마켓",
  PREPRE: "장전",
  POSTPOST: "마감",
  CLOSED: "마감",
};

export function UsWatchPage() {
  const [groups, setGroups] = useState<UsWatchGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // 종목 추가
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UsSearchResult[]>([]);
  const [newGroup, setNewGroup] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.usWatch();
      setGroups(r.groups);
      if (!openGroup && r.groups.length > 0) setOpenGroup(r.groups[0].id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "불러오기 실패");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 검색은 늦춰서 — 타이핑마다 Yahoo 를 부르지 않는다
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .usWatchSearch(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 350);
    return () => clearTimeout(timer);
  }, [query]);

  async function run(fn: () => Promise<{ groups: UsWatchGroup[] }>) {
    setError(null);
    try {
      setGroups((await fn()).groups);
    } catch (e) {
      setError(e instanceof Error ? e.message : "실패");
    }
  }

  const current = groups.find((g) => g.id === openGroup) ?? groups[0] ?? null;
  const marketState = current?.stocks.find((s) => s.marketState)?.marketState ?? null;

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} />
      {error && <div className="error-banner">{error}</div>}

      {/* 그룹 — 등락률까지 붙여서, 어느 판이 도는지 목록에서 바로 보이게 */}
      <div className="filter-row">
        {groups.map((g) => (
          <button
            key={g.id}
            className={`filter-btn ${current?.id === g.id ? "active" : ""}`}
            onClick={() => setOpenGroup(g.id)}
            title={g.memo}
          >
            {g.name}
            <span className={`uw-grate ${cls(g.changeRate)}`}> {pct(g.changeRate)}</span>
          </button>
        ))}
        <button
          className={`filter-btn ${editing ? "active" : ""}`}
          onClick={() => setEditing(!editing)}
        >
          {editing ? "편집 끝" : "✏ 편집"}
        </button>
        {marketState && (
          <span className="tg-ctl-hint">
            미국장 {STATE_LABEL[marketState] ?? marketState}
          </span>
        )}
      </div>

      {editing && (
        <section className="pt-entry">
          <div className="pt-entry-row">
            <input
              className="pt-input"
              placeholder="새 그룹 이름"
              value={newGroup}
              onChange={(e) => setNewGroup(e.target.value)}
            />
            <button
              className="filter-btn"
              disabled={!newGroup.trim()}
              onClick={() =>
                void run(async () => {
                  const r = await api.usWatchGroupAdd(newGroup.trim());
                  setNewGroup("");
                  return r;
                })
              }
            >
              + 그룹 추가
            </button>
            {current && (
              <>
                <span className="news-scope-sep" />
                <button
                  className="filter-btn danger"
                  onClick={() => {
                    if (!window.confirm(`「${current.name}」 그룹을 지웁니다.`)) return;
                    void run(() => api.usWatchGroupRemove(current.id));
                  }}
                >
                  「{current.name}」 그룹 삭제
                </button>
              </>
            )}
          </div>

          {current && (
            <div className="pt-entry-row">
              <div className="pt-search">
                <input
                  className="pt-input"
                  placeholder="종목 검색 (예: nvidia, rocket lab, OKLO)"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {results.length > 0 && (
                  <ul className="pt-results">
                    {results.map((r) => (
                      <li key={r.symbol}>
                        <button
                          onClick={() =>
                            void run(async () => {
                              const res = await api.usWatchStockAdd(current.id, r.symbol, r.name);
                              setQuery("");
                              setResults([]);
                              return res;
                            })
                          }
                        >
                          <b>{r.symbol}</b> <span className="pt-n">{r.name}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <span className="tg-ctl-hint">
                「{current.name}」에 담깁니다 · 편입가는 지금 가격으로 자동
              </span>
            </div>
          )}
        </section>
      )}

      {loading && groups.length === 0 && <div className="page-note">불러오는 중…</div>}

      {groups.length === 0 && !loading && (
        <div className="page-note">
          그룹이 없습니다. <b>✏ 편집</b>을 눌러 그룹을 만들고 종목을 담아 보세요. 티커를 외울
          필요 없이 <b>이름으로 검색</b>됩니다.
        </div>
      )}

      {current && (
        <>
          <div className="uw-head">
            <b>{current.name}</b>
            {current.memo && <span className="pt-n"> {current.memo}</span>}
            <span className={`uw-grate big ${cls(current.changeRate)}`}>{pct(current.changeRate)}</span>
            <span className="pt-n">
              ▲{current.rising} / ▼{current.falling} · {current.stocks.length}종목
            </span>
          </div>

          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th className="sticky-col">종목</th>
                  <th>현재가</th>
                  <th>등락률</th>
                  <th>편입가</th>
                  <th>편입 대비</th>
                  {editing && <th></th>}
                </tr>
              </thead>
              <tbody>
                {[...current.stocks]
                  .sort((a, b) => (b.changeRate ?? -999) - (a.changeRate ?? -999))
                  .map((s) => (
                    <tr key={s.symbol}>
                      <td className="sticky-col">
                        <b>{s.symbol}</b>
                        <span className="pt-n"> {s.name}</span>
                        {s.error && <span className="uw-err"> {s.error}</span>}
                      </td>
                      <td className="num">{s.price === null ? "-" : s.price.toFixed(2)}</td>
                      <td className={`num ${cls(s.changeRate)}`}>{pct(s.changeRate)}</td>
                      <td className="num">{s.addedPrice === null ? "-" : s.addedPrice.toFixed(2)}</td>
                      <td className={`num ${cls(s.returnRate)}`}>{pct(s.returnRate)}</td>
                      {editing && (
                        <td>
                          <button
                            className="row-del-btn"
                            onClick={() => void run(() => api.usWatchStockRemove(current.id, s.symbol))}
                            title="빼기"
                          >
                            ✕
                          </button>
                        </td>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          <div className="table-note">
            시세는 Yahoo Finance 기준이며 <b>실시간이 아닙니다</b>(1분 캐시). 그룹 등락률은
            구성종목의 <b>단순평균</b>입니다 — 미국은 시가총액을 받아오지 않아 가중을 줄 수
            없습니다. 「편입 대비」는 담은 시점 가격 대비 수익률입니다.
          </div>
        </>
      )}
    </div>
  );
}
