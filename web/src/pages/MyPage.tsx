import { useEffect, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type StockSearchResult,
  type TrackedStock,
} from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { useWatchedCodes } from "../useWatchedCodes";

function fmtPct(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

const ALL = "__all__";
const DEFAULT_GROUP = "기본";

export function MyPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [items, setItems] = useState<TrackedStock[]>([]);
  const [groups, setGroups] = useState<string[]>([DEFAULT_GROUP]);
  const [activeGroup, setActiveGroup] = useState<string>(ALL);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  // 종목 추가 — 이름으로 찾아 고르게 한다 (코드를 손으로 적으면 틀린다)
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<StockSearchResult[]>([]);
  const [adding, setAdding] = useState(false);
  const watchedCodes = useWatchedCodes();

  // 그룹 필터를 먼저 적용한 뒤 정렬한다
  const visible =
    activeGroup === ALL ? items : items.filter((i) => (i.group || DEFAULT_GROUP) === activeGroup);
  const sort = useSortableTable(visible);

  async function loadGroups() {
    try {
      setGroups((await api.watchGroups()).groups);
    } catch {
      // 그룹 조회 실패가 목록 표시를 막지 않게 한다
    }
  }

  async function createGroup() {
    const name = window.prompt("새 그룹 이름")?.trim();
    if (!name) return;
    try {
      setGroups((await api.watchGroupAdd(name)).groups);
      setActiveGroup(name);
    } catch (err) {
      setError(err instanceof Error ? err.message : "그룹 추가 실패");
    }
  }

  async function removeGroupNow() {
    if (activeGroup === ALL || activeGroup === DEFAULT_GROUP) return;
    if (!window.confirm(`'${activeGroup}' 그룹을 삭제할까요?
소속 종목은 기본 그룹으로 이동합니다.`)) return;
    try {
      setGroups((await api.watchGroupRemove(activeGroup)).groups);
      setActiveGroup(ALL);
      await load(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "그룹 삭제 실패");
    }
  }

  async function moveToGroup(code: string, group: string) {
    try {
      await api.watchlistSetGroup(code, group);
      setItems((prev) => prev.map((i) => (i.code === code ? { ...i, group } : i)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "그룹 이동 실패");
    }
  }

  async function load(force = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await api.watchlistTracking(force);
      setItems(res.items);
      setUpdatedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
    loadGroups();
  }, []);

  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setResults([]);
      return;
    }
    const timer = setTimeout(() => {
      api
        .searchStocks(q)
        .then((r) => setResults(r.results))
        .catch(() => setResults([]));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  /**
   * 관심종목에 담는다.
   *
   * 편입가는 **지금 현재가**로 잡는다. 사용자가 직접 적게 하면 매번 입력하기 번거롭고,
   * 여기서 재는 것은 매수 단가가 아니라 "지켜보기 시작한 시점 대비 얼마나 움직였나"이므로
   * 담은 순간의 가격이 기준으로 맞다. (실제 매수 단가는 계좌 화면이 따로 본다)
   */
  async function addStock(r: StockSearchResult) {
    setAdding(true);
    setError(null);
    try {
      const code = normalizeStockCode(r.code);
      const info = (await api.stockInfo(code)) as Record<string, unknown>;
      const price = Math.abs(Number(String(info.cur_prc ?? "").replace(/[+,]/g, ""))) || 0;
      await api.watchlistAdd({
        code,
        name: r.name,
        addedPrice: price,
        group: activeGroup === ALL ? DEFAULT_GROUP : activeGroup,
      });
      setQuery("");
      setResults([]);
      await load(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "관심종목 추가 실패");
    } finally {
      setAdding(false);
    }
  }

  async function remove(code: string) {
    try {
      await api.watchlistRemove(code);
      setItems((prev) => prev.filter((i) => i.code !== code));
      watchedCodes.markRemoved(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "삭제 실패");
    }
  }

  // 요약: 수급이 살아있는 종목이 몇 개인지
  const foreignBuying = items.filter((i) => i.foreign5 > 0).length;
  const instBuying = items.filter((i) => i.inst5 > 0).length;
  const trendOk = items.filter((i) => i.trendPass === true).length;
  const profitable = items.filter((i) => (i.returnRate ?? 0) > 0).length;

  return (
    <div>
      <RefreshBar onRefresh={() => load(true)} loading={loading} updatedAt={updatedAt} />

      {error && <div className="error-banner">{error}</div>}

      <div className="search-box">
        <input
          className="search-input"
          type="text"
          inputMode="search"
          placeholder={`종목명·코드로 검색해서 ${activeGroup === ALL ? DEFAULT_GROUP : activeGroup} 그룹에 추가`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          disabled={adding}
        />
        {query.trim() && results.length > 0 && (
          <div className="search-dropdown">
            {results.map((r) => {
              const already = items.some((i) => i.code === normalizeStockCode(r.code));
              return (
                <button
                  key={r.code}
                  className="search-result-row"
                  disabled={already || adding}
                  onClick={() => void addStock(r)}
                >
                  <span className="name">{r.name}</span>
                  <span className="sub">
                    {r.code} · {r.marketName}
                    {already && " · 이미 담김"}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      <div className="filter-row group-tabs">
        <button
          className={`filter-btn ${activeGroup === ALL ? "active" : ""}`}
          onClick={() => setActiveGroup(ALL)}
        >
          전체 ({items.length})
        </button>
        {groups.map((g) => {
          const n = items.filter((i) => (i.group || DEFAULT_GROUP) === g).length;
          return (
            <button
              key={g}
              className={`filter-btn ${activeGroup === g ? "active" : ""}`}
              onClick={() => setActiveGroup(g)}
            >
              {g} ({n})
            </button>
          );
        })}
        <button className="filter-btn" onClick={createGroup} title="새 그룹 만들기">
          + 그룹
        </button>
        {activeGroup !== ALL && activeGroup !== DEFAULT_GROUP && (
          <button className="filter-btn danger" onClick={removeGroupNow} title="이 그룹 삭제">
            그룹 삭제
          </button>
        )}
      </div>

      <section className="card">
        <h2>관심종목 요약 ({items.length})</h2>
        <div className="summary-grid">
          <div className="summary-item">
            <div className="label">수익 중</div>
            <div className="value">
              {profitable} / {items.length}
            </div>
          </div>
          <div className="summary-item">
            <div className="label">정배열</div>
            <div className="value">
              {trendOk} / {items.length}
            </div>
          </div>
          <div className="summary-item">
            <div className="label">외인 5일 순매수</div>
            <div className="value positive">{foreignBuying}</div>
          </div>
          <div className="summary-item">
            <div className="label">기관 5일 순매수</div>
            <div className="value positive">{instBuying}</div>
          </div>
        </div>
      </section>

      {loading && items.length === 0 && <div className="empty">불러오는 중...</div>}

      {!loading && items.length > 0 && visible.length === 0 && (
        <div className="page-note">이 그룹에 담긴 종목이 없습니다.</div>
      )}

      {!loading && items.length === 0 && (
        <div className="page-note">
          관심종목이 없습니다. 시황·거래상위·알고리즘 탭에서 종목을 열고 ☆ 버튼을 눌러 추가하세요.
        </div>
      )}

      {visible.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목명" accessor={(r: TrackedStock) => r.name} sort={sort} className="sticky-col" />
                <SortableTh columnKey="group" label="그룹" accessor={(r: TrackedStock) => r.group || DEFAULT_GROUP} sort={sort} />
                <SortableTh columnKey="addedAt" label="편입일" accessor={(r: TrackedStock) => r.addedAt} sort={sort} />
                <SortableTh columnKey="addedPrice" label="편입가" accessor={(r: TrackedStock) => r.addedPrice} sort={sort} />
                <SortableTh columnKey="price" label="현재가" accessor={(r: TrackedStock) => r.price} sort={sort} />
                <SortableTh columnKey="returnRate" label="수익률" accessor={(r: TrackedStock) => r.returnRate ?? 0} sort={sort} />
                <SortableTh columnKey="changeRate" label="당일" accessor={(r: TrackedStock) => r.changeRate} sort={sort} />
                <SortableTh columnKey="foreign5" label="외인5일" accessor={(r: TrackedStock) => r.foreign5} sort={sort} />
                <SortableTh columnKey="foreign20" label="외인20일" accessor={(r: TrackedStock) => r.foreign20} sort={sort} />
                <SortableTh columnKey="inst5" label="기관5일" accessor={(r: TrackedStock) => r.inst5} sort={sort} />
                <SortableTh columnKey="inst20" label="기관20일" accessor={(r: TrackedStock) => r.inst20} sort={sort} />
                <SortableTh columnKey="trend" label="정배열" accessor={(r: TrackedStock) => (r.trendPass ? 1 : 0)} sort={sort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r) => (
                <tr key={r.code} className="clickable-row" onClick={() => onSelectStock(r.code, r.name)}>
                  <td className="sticky-col">{r.name}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    <select
                      className="group-select"
                      value={r.group || DEFAULT_GROUP}
                      onChange={(e) => moveToGroup(r.code, e.target.value)}
                      title="그룹 변경"
                    >
                      {groups.map((g) => (
                        <option key={g} value={g}>
                          {g}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>{fmtDate(r.addedAt)}</td>
                  <td>{fmtNum(r.addedPrice)}</td>
                  <td>{fmtNum(r.price)}</td>
                  <td className={signClass(r.returnRate)}>{fmtPct(r.returnRate)}</td>
                  <td className={signClass(r.changeRate)}>{fmtPct(r.changeRate)}</td>
                  <td className={signClass(r.foreign5)}>{fmtNum(r.foreign5)}</td>
                  <td className={signClass(r.foreign20)}>{fmtNum(r.foreign20)}</td>
                  <td className={signClass(r.inst5)}>{fmtNum(r.inst5)}</td>
                  <td className={signClass(r.inst20)}>{fmtNum(r.inst20)}</td>
                  <td>{r.trendPass === null ? "-" : r.trendPass ? "O" : ""}</td>
                  <td>
                    <button
                      className="row-del-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(r.code);
                      }}
                      title="관심종목에서 제거"
                    >
                      ✕
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="table-note">
            수익률은 편입가 대비 · 순매매 단위는 백만원 · 정배열은 현재가≥5일≥20일≥60일≥120일선
          </div>
        </div>
      )}
    </div>
  );
}
