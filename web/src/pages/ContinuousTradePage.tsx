import { useCallback, useEffect, useState } from "react";
import { api, fmtNum, normalizeStockCode, pickList, signClass, type RawRecord } from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { WatchStar } from "../useWatchedCodes";

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
  const sort = useSortableTable(rows);

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} updatedAt={updatedAt} />
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
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="empty">불러오는 중...</div>}

      {!loading && !error && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh columnKey="name" label="종목명" accessor={(r: RawRecord) => String(r.stk_nm ?? "")} sort={sort} className="sticky-col" />
                <SortableTh columnKey="flu" label="기간등락률" accessor={(r: RawRecord) => Number(r.prid_stkpc_flu_rt) || 0} sort={sort} />
                <SortableTh columnKey="orgnDays" label="기관연속일수" accessor={(r: RawRecord) => Number(r.orgn_cont_netprps_dys) || 0} sort={sort} />
                <SortableTh columnKey="orgnAmt" label="기관연속금액(백만)" accessor={(r: RawRecord) => Number(r.orgn_cont_netprps_amt) || 0} sort={sort} />
                <SortableTh columnKey="forDays" label="외인연속일수" accessor={(r: RawRecord) => Number(r.frgnr_cont_netprps_dys) || 0} sort={sort} />
                <SortableTh columnKey="forAmt" label="외인연속금액(백만)" accessor={(r: RawRecord) => Number(r.frgnr_cont_netprps_amt) || 0} sort={sort} />
                <SortableTh columnKey="totDays" label="합계연속일수" accessor={(r: RawRecord) => Number(r.tot_cont_netprps_dys) || 0} sort={sort} />
                <SortableTh columnKey="totAmt" label="합계연속금액(백만)" accessor={(r: RawRecord) => Number(r.tot_cont_netprps_amt) || 0} sort={sort} />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r, i) => {
                const code = normalizeStockCode(String(r.stk_cd ?? ""));
                const name = String(r.stk_nm ?? "");
                return (
                  <tr key={`${code}-${i}`} onClick={() => onSelectStock(code, name)} className="clickable-row">
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
      <div className="table-note">HTS 0763(기관외국인연속매매현황) 참고 · ka10131 · 순매수 연속일 기준</div>
    </div>
  );
}
