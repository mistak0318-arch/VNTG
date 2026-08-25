import { useAutoRefresh } from "../useAutoRefresh";
import { StockFilterBar, StockFilterToggle, useStockFilter, type FilterCapable } from "../components/StockFilter";
import { Pager, usePager } from "../components/Pager";
import { useCallback, useEffect, useState } from "react";
import { api, fmtAbsNum, fmtNum, normalizeStockCode, pickList, signClass, type RawRecord } from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { SignalCell, useSignalColumn } from "../components/SignalColumn";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { WatchStar } from "../useWatchedCodes";

// ka10062(동일순매매순위요청) 공식 문서 기준 확인된 필드명
const LIST_KEYS = ["eql_nettrde_rank"];

const MARKETS: { key: string; label: string }[] = [
  { key: "000", label: "전체" },
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
];

const TRADE_TYPES: { key: string; label: string }[] = [
  { key: "1", label: "순매수" },
  { key: "2", label: "순매도" },
];

export function SameNetTradeRankingPage({
  onSelectStock,
}: {
  onSelectStock: (code: string, name: string) => void;
}) {
  const [market, setMarket] = useState("000");
  const [trade, setTrade] = useState("1");
  const [data, setData] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData((await api.sameNetTradeRanking(market, trade)) as RawRecord);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }, [market, trade]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = pickList(data ?? undefined, LIST_KEYS);
  /* 시세분석의 다른 탭과 **같은 조건**을 쓴다 — 탭을 옮겨도 필터가 따라온다 */
  const f = useStockFilter(rows as unknown as FilterCapable[], undefined);
  const [openFilter, setOpenFilter] = useState(false);
  const kept = (rows as unknown as FilterCapable[]).filter(f.keep) as unknown as typeof rows;
  const sort = useSortableTable(kept);
  /* 쪽 넘기기 — 거래대금 상위와 같은 도구를 쓴다 */
  const pager = usePager(sort.sorted.length, "vntg.samenet.pageSize", kept.length);

  /* 장중에는 스스로 다시 받는다 — 새로고침을 누르러 오게 하면 안 된다 */
  const auto = useAutoRefresh(() => void load(), { storeKey: "vntg.auto.samenet", intervalMs: 30000 });

  /* 신호등 — 지금 쪽만, 켤 때만. 시세분석·거래상위·연속매매와 같은 규칙이다 */
  const [sigOn, setSigOn] = useState(false);
  const drawn = pager.slice(sort.sorted);
  const signals = useSignalColumn(
    drawn.map((r) => normalizeStockCode(String(r.stk_cd ?? ""))),
    sigOn,
  );

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} updatedAt={updatedAt} auto={auto} />
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
      </div>
      <div className="filter-row">
        {TRADE_TYPES.map((t) => (
          <button
            key={t.key}
            className={`filter-btn ${trade === t.key ? "active" : ""}`}
            onClick={() => setTrade(t.key)}
          >
            {t.label}
          </button>
        ))}
        <StockFilterToggle f={f} open={openFilter} onToggle={() => setOpenFilter((v) => !v)} />
        <button
          className={`filter-btn ${sigOn ? "active" : ""}`}
          onClick={() => setSigOn((v) => !v)}
          title="지금 쪽의 종목만 평가합니다 — 종목마다 차트·수급·재무를 조회하므로 켤 때만 돕니다"
        >
          🚦 신호등 {sigOn ? "끄기" : "켜기"}
        </button>
        {f.on && (
          <span className="breadth-count">
            {kept.length} / {rows.length}건
          </span>
        )}
      </div>
      <StockFilterBar f={f} open={openFilter} />

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="empty">불러오는 중...</div>}

      {!loading && !error && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                {sigOn && <th className="sig-th">🚦</th>}
                <SortableTh columnKey="name" label="종목명" accessor={(r: RawRecord) => String(r.stk_nm ?? "")} sort={sort} className="sticky-col" />
                <SortableTh columnKey="price" label="현재가" accessor={(r: RawRecord) => Math.abs(Number(r.cur_prc)) || 0} sort={sort} />
                <SortableTh columnKey="fluRt" label="등락률" accessor={(r: RawRecord) => Number(r.flu_rt) || 0} sort={sort} />
                <SortableTh columnKey="orgn" label="기관순매매(백만)" accessor={(r: RawRecord) => Number(r.orgn_nettrde_amt) || 0} sort={sort} />
                <SortableTh columnKey="for" label="외국인순매매(백만)" accessor={(r: RawRecord) => Number(r.for_nettrde_amt) || 0} sort={sort} />
                <SortableTh columnKey="net" label="합계순매매(백만)" accessor={(r: RawRecord) => Number(r.nettrde_amt) || 0} sort={sort} />
              </tr>
            </thead>
            <tbody>
              {drawn.map((r, i) => {
                const code = normalizeStockCode(String(r.stk_cd ?? ""));
                const name = String(r.stk_nm ?? "");
                return (
                  <tr key={`${code}-${i}`} onClick={() => onSelectStock(code, name)} className="clickable-row">
                    {sigOn && (
                      <td className="sig-td" onClick={(e) => e.stopPropagation()}>
                        <SignalCell code={code} name={name} signal={signals[code]} onSelectStock={onSelectStock} />
                      </td>
                    )}
                    <td className="sticky-col">
                      <span className="rank-cell">{String(r.rank ?? i + 1)}. </span>
                      <WatchStar code={code} />
                      {name}
                    </td>
                    <td className={signClass(r.pred_pre)}>{fmtAbsNum(r.cur_prc)}</td>
                    <td className={signClass(r.flu_rt)}>{fmtNum(r.flu_rt)}%</td>
                    <td className={signClass(r.orgn_nettrde_amt)}>{fmtNum(r.orgn_nettrde_amt)}</td>
                    <td className={signClass(r.for_nettrde_amt)}>{fmtNum(r.for_nettrde_amt)}</td>
                    <td className={signClass(r.nettrde_amt)}>{fmtNum(r.nettrde_amt)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty">
                    데이터 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Pager pager={pager} total={sort.sorted.length} />
      <div className="table-note">HTS 0798(동일순매매순위) 참고 · ka10062 · 당일 기준</div>
    </div>
  );
}
