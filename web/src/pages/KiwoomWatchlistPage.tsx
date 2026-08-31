import { useAutoRefresh } from "../useAutoRefresh";
import { useCallback, useEffect, useState } from "react";
import {
  api,
  fmtNum,
  normalizeStockCode,
  signClass,
  type KiwoomGroup,
  type KiwoomGroupStock,
} from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { ColumnGrip, useColumnWidths } from "../components/ColumnWidths";
import { useWatchedCodes, WatchStar } from "../useWatchedCodes";
import { SuperMark } from "../useSuperMarks";
import { WatchAddSheet, type WatchAddTarget } from "../components/WatchAddSheet";

/** 키움 MTS/HTS에 등록해둔 관심종목 그룹을 그대로 조회 (읽기 전용) */
export function KiwoomWatchlistPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [groups, setGroups] = useState<KiwoomGroup[]>([]);
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [items, setItems] = useState<KiwoomGroupStock[]>([]);
  const [addTarget, setAddTarget] = useState<WatchAddTarget | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const watchedCodes = useWatchedCodes();
  const sort = useSortableTable(items);
  /* 칸 너비 조절 — 시세분석과 같은 공통 모듈 */
  const cw = useColumnWidths("kiwoomWatch");

  useEffect(() => {
    let cancelled = false;
    api
      .kiwoomGroups()
      .then((res) => {
        if (cancelled) return;
        setGroups(res.groups);
        if (res.groups.length > 0) setActiveGroup(res.groups[0].code);
        else setLoading(false);
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!activeGroup) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.kiwoomGroupStocks(activeGroup);
      setItems(res.items);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }, [activeGroup]);

  useEffect(() => {
    load();
  }, [load]);

  /** 키움 그룹의 종목을 내 관심종목(추적 대상)으로 복사 */
  async function addToMyWatchlist(stock: KiwoomGroupStock) {
    const code = normalizeStockCode(stock.code);
    setAdding(stock.code);
    try {
      const { groups } = await api.watchGroups().catch(() => ({ groups: [] as string[] }));
      if (groups.length > 0) {
        setAddTarget({ code, name: stock.name, addedPrice: stock.price });
        return;
      }
      await api.watchlistAdd({ code, name: stock.name, addedPrice: stock.price });
      watchedCodes.markAdded(code);
    } catch (err) {
      setError(err instanceof Error ? err.message : "추가 실패");
    } finally {
      setAdding(null);
    }
  }

  /* 장중에는 스스로 다시 받는다 — 새로고침을 누르러 오게 하면 안 된다 */
  const auto = useAutoRefresh(() => void load(), { storeKey: "vntg.auto.kiwoomWatch", intervalMs: 20000 });

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} updatedAt={updatedAt} auto={auto} />

      {error && <div className="error-banner">{error}</div>}

      <div className="filter-row">
        {groups.map((g) => (
          <button
            key={g.code}
            className={`filter-btn ${activeGroup === g.code ? "active" : ""}`}
            onClick={() => setActiveGroup(g.code)}
          >
            {g.name}
          </button>
        ))}
      </div>

      {loading && <div className="empty">불러오는 중...</div>}

      {!loading && !error && items.length === 0 && (
        <div className="page-note">이 그룹에 등록된 종목이 없습니다.</div>
      )}

      {!loading && items.length > 0 && (
        <div className="data-table-wrap">
          <table className={`data-table${cw.customized ? " col-fixed" : ""}`}>
            <colgroup>
              {["name", "price", "change", "changeRate", "amount"].map((k) => (
                <col key={k} style={cw.styleOf(k)} />
              ))}
              <col />
            </colgroup>
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목명" accessor={(s: KiwoomGroupStock) => s.name} sort={sort} className="sticky-col" extra={<ColumnGrip cw={cw} k="name" />} />
                <SortableTh columnKey="price" label="현재가" accessor={(s: KiwoomGroupStock) => s.price} sort={sort} extra={<ColumnGrip cw={cw} k="price" />} />
                <SortableTh columnKey="change" label="전일대비" accessor={(s: KiwoomGroupStock) => s.change} sort={sort} extra={<ColumnGrip cw={cw} k="change" />} />
                <SortableTh columnKey="changeRate" label="등락률" accessor={(s: KiwoomGroupStock) => s.changeRate} sort={sort} extra={<ColumnGrip cw={cw} k="changeRate" />} />
                <SortableTh columnKey="amount" label="거래대금(백만)" accessor={(s: KiwoomGroupStock) => s.tradeAmount} sort={sort} extra={<ColumnGrip cw={cw} k="amount" />} />
                <th>추적</th>
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((s) => {
                const code = normalizeStockCode(s.code);
                return (
                  <tr key={s.code} className="clickable-row" onClick={() => onSelectStock(code, s.name)}>
                    <td className="sticky-col">
                      <WatchStar code={code} />
<SuperMark code={code} />
                      {s.name}
                    </td>
                    <td>{fmtNum(s.price)}</td>
                    <td className={signClass(s.change)}>{fmtNum(s.change)}</td>
                    <td className={signClass(s.changeRate)}>
                      {s.changeRate > 0 ? "+" : ""}
                      {s.changeRate.toFixed(2)}%
                    </td>
                    <td>{fmtNum(s.tradeAmount)}</td>
                    <td>
                      <button
                        className="row-add-btn"
                        disabled={adding === s.code || watchedCodes.isWatched(code)}
                        onClick={(e) => {
                          e.stopPropagation();
                          addToMyWatchlist(s);
                        }}
                        title="내 관심종목에 추가해 추적"
                      >
                        {adding === s.code ? "…" : "＋"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <div className="table-note">
            키움 MTS/HTS에 등록된 그룹입니다 (조회 전용) · ＋를 누르면 내 관심종목으로 복사되어 수급 추적이 시작됩니다
          </div>
        </div>
      )}

      {addTarget && <WatchAddSheet target={addTarget} onClose={() => setAddTarget(null)} />}
    </div>
  );
}
