import { useAutoRefresh } from "../useAutoRefresh";
import { StockFilterBar, StockFilterToggle, useStockFilter, type FilterCapable } from "../components/StockFilter";
import { Pager, usePager } from "../components/Pager";
import { useCallback, useEffect, useState } from "react";
import { api, fmtNum, normalizeStockCode, pickList, signClass, type RawRecord } from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { SignalCell, useSignalColumn } from "../components/SignalColumn";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { WatchStar } from "../useWatchedCodes";
import { ColumnGrip, useColumnWidths } from "../components/ColumnWidths";

// ka10131(기관외국인연속매매현황요청) 공식 문서 기준 확인된 필드명
const LIST_KEYS = ["orgn_frgnr_cont_trde_prst"];

const MARKETS: { key: string; label: string }[] = [
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
];

const DAY_OPTIONS: { key: string; label: string }[] = [
  { key: "1", label: "최근일" },
  { key: "3", label: "3일" },
  { key: "5", label: "5일" },
  { key: "10", label: "10일" },
  { key: "20", label: "20일" },
  { key: "120", label: "120일" },
];

export function ContinuousTradePage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [market, setMarket] = useState("001");
  const [days, setDays] = useState("1");
  const [data, setData] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData((await api.continuousTradeRanking(market, days)) as RawRecord);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }, [market, days]);

  useEffect(() => {
    load();
  }, [load]);

  const rows = pickList(data ?? undefined, LIST_KEYS);
  /* 시세분석의 다른 탭과 **같은 조건**을 쓴다 — 탭을 옮겨도 필터가 따라온다 */
  const f = useStockFilter(rows as unknown as FilterCapable[], (r) => Number(String(r.prid_stkpc_flu_rt ?? "").replace(/[+,\s]/g, "")));
  const [openFilter, setOpenFilter] = useState(false);
  const kept = (rows as unknown as FilterCapable[]).filter(f.keep) as unknown as typeof rows;
  const sort = useSortableTable(kept);
  /* 칸 너비 조절 — 시세분석과 같은 공통 모듈 */
  const cw = useColumnWidths("contTrade");
  const pager = usePager(sort.sorted.length, "vntg.cont.pageSize", kept.length);

  /* 장중에는 스스로 다시 받는다 — 새로고침을 누르러 오게 하면 안 된다 */
  const auto = useAutoRefresh(() => void load(), { storeKey: "vntg.auto.cont", intervalMs: 30000 });

  /*
   * 신호등 — **지금 쪽만.** 기본은 꺼 둔다.
   *
   * 연속매매는 「기관이 5일 연속 샀다」를 보는 자리인데, 그게 좋은 종목인지는
   * 별개다. 점 하나가 붙으면 **훑는 단계에서 갈린다** — 시세분석·거래상위와 같은 규칙이다.
   */
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
      <div className="table-toolbar" style={{ justifyContent: "flex-start" }}>
        <label htmlFor="cont-days">기간</label>
        <select id="cont-days" value={days} onChange={(e) => setDays(e.target.value)}>
          {DAY_OPTIONS.map((d) => (
            <option key={d.key} value={d.key}>
              {d.label}
            </option>
          ))}
        </select>
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
          <table className={`data-table${cw.customized ? " col-fixed" : ""}`}>
            <colgroup>
              {sigOn && <col style={{ width: "2.4rem" }} />}
              {["name", "flu", "orgnDays", "orgnAmt", "forDays", "forAmt", "totDays", "totAmt"].map((k) => (
                <col key={k} style={cw.styleOf(k)} />
              ))}
            </colgroup>
            <thead>
              <tr>
                {sigOn && <th className="sig-th">🚦</th>}
                <SortableTh columnKey="name" label="종목명" accessor={(r: RawRecord) => String(r.stk_nm ?? "")} sort={sort} className="sticky-col" extra={<ColumnGrip cw={cw} k="name" />} />
                <SortableTh columnKey="flu" label="기간등락률" accessor={(r: RawRecord) => Number(r.prid_stkpc_flu_rt) || 0} sort={sort} extra={<ColumnGrip cw={cw} k="flu" />} />
                <SortableTh columnKey="orgnDays" label="기관연속일수" accessor={(r: RawRecord) => Number(r.orgn_cont_netprps_dys) || 0} sort={sort} extra={<ColumnGrip cw={cw} k="orgnDays" />} />
                <SortableTh columnKey="orgnAmt" label="기관연속금액(백만)" accessor={(r: RawRecord) => Number(r.orgn_cont_netprps_amt) || 0} sort={sort} extra={<ColumnGrip cw={cw} k="orgnAmt" />} />
                <SortableTh columnKey="forDays" label="외인연속일수" accessor={(r: RawRecord) => Number(r.frgnr_cont_netprps_dys) || 0} sort={sort} extra={<ColumnGrip cw={cw} k="forDays" />} />
                <SortableTh columnKey="forAmt" label="외인연속금액(백만)" accessor={(r: RawRecord) => Number(r.frgnr_cont_netprps_amt) || 0} sort={sort} extra={<ColumnGrip cw={cw} k="forAmt" />} />
                <SortableTh columnKey="totDays" label="합계연속일수" accessor={(r: RawRecord) => Number(r.tot_cont_netprps_dys) || 0} sort={sort} extra={<ColumnGrip cw={cw} k="totDays" />} />
                <SortableTh columnKey="totAmt" label="합계연속금액(백만)" accessor={(r: RawRecord) => Number(r.tot_cont_netprps_amt) || 0} sort={sort} extra={<ColumnGrip cw={cw} k="totAmt" />} />
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
                    <td className={signClass(r.prid_stkpc_flu_rt)}>{fmtNum(r.prid_stkpc_flu_rt)}%</td>
                    <td className={signClass(r.orgn_cont_netprps_dys)}>{fmtNum(r.orgn_cont_netprps_dys)}</td>
                    <td className={signClass(r.orgn_cont_netprps_amt)}>{fmtNum(r.orgn_cont_netprps_amt)}</td>
                    <td className={signClass(r.frgnr_cont_netprps_dys)}>{fmtNum(r.frgnr_cont_netprps_dys)}</td>
                    <td className={signClass(r.frgnr_cont_netprps_amt)}>{fmtNum(r.frgnr_cont_netprps_amt)}</td>
                    <td className={signClass(r.tot_cont_netprps_dys)}>{fmtNum(r.tot_cont_netprps_dys)}</td>
                    <td className={signClass(r.tot_cont_netprps_amt)}>{fmtNum(r.tot_cont_netprps_amt)}</td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={8} className="empty">
                    데이터 없음
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      <Pager pager={pager} total={sort.sorted.length} />
      <div className="table-note">HTS 0763(기관외국인연속매매현황) 참고 · ka10131 · 순매수 연속일 기준</div>
    </div>
  );
}
