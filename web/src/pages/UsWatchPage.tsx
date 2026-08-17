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

/**
 * "실시간이야?" 에 답하려면 두 시각이 다 있어야 한다.
 *   체결  = 거래소에서 마지막으로 거래된 시각 (Yahoo 가 알려준 것)
 *   조회  = 우리가 그걸 받아온 시각
 * 둘이 붙어 있으면 장중 실시간에 가깝고, 벌어져 있으면 장이 닫힌 것이다.
 * marketState 는 안 올 때가 많아서 그것만 믿지 않는다.
 */
function ago(ms: number): string {
  const m = Math.floor((Date.now() - ms) / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

function stampKst(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
}

export function UsWatchPage() {
  const [groups, setGroups] = useState<UsWatchGroup[]>([]);
  const [quotedAt, setQuotedAt] = useState<number | null>(null);
  const [fetchedAt, setFetchedAt] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [openGroup, setOpenGroup] = useState<string | null>(null);

  // 종목 추가
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UsSearchResult[]>([]);
  const [newGroup, setNewGroup] = useState("");

  async function load(force = false) {
    setLoading(true);
    setError(null);
    try {
      const r = await api.usWatch(force);
      setGroups(r.groups);
      setQuotedAt(r.quotedAt);
      setFetchedAt(r.fetchedAt);
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

  return (
    <div>
      <RefreshBar onRefresh={() => load(true)} loading={loading} />
      {error && <div className="error-banner">{error}</div>}

      {/* 어느 시점 값인지 못 박는다 — "실시간이야?" 를 화면이 스스로 답해야 한다 */}
      <div className="uw-stamp">
        {quotedAt ? (
          <>
            시세 기준 <b>{stampKst(quotedAt)}</b> (한국시각) · <b>{ago(quotedAt)}</b> 체결
          </>
        ) : (
          <>시세 기준 불명</>
        )}
        {fetchedAt && <> · 조회 {ago(fetchedAt)}</>}
        <span className="uw-stamp-note">
          Yahoo Finance · 실시간이 아닐 수 있고 서버에서 1분 캐시합니다. ↻ 를 누르면 캐시를
          무시하고 새로 받습니다.
        </span>
      </div>

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
            그룹 등락률은
            구성종목의 <b>단순평균</b>입니다 — 미국은 시가총액을 받아오지 않아 가중을 줄 수
            없습니다. 「편입 대비」는 담은 시점 가격 대비 수익률입니다.
          </div>
        </>
      )}
    </div>
  );
}
