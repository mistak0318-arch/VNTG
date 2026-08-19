import { useCallback, useEffect, useState } from "react";
import { api, fmtAbsNum, fmtNum, normalizeStockCode, pickList, signClass, type RawRecord } from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { WatchStar } from "../useWatchedCodes";

// ka10030(당일거래량상위요청) 공식 문서 기준 확인된 필드명
const LIST_KEYS = ["tdy_trde_qty_upper"];

/**
 * 키움이 거래량을 32비트로 잘라 주는 자리.
 *
 * 오늘 KODEX 200선물인버스2X 의 거래량이 정확히 4,294,967,295 로 왔다 — 2^32-1 이다.
 * 실제 거래량이 그 값일 리 없고, 같은 줄의 거래대금은 멀쩡하다.
 * **없는 숫자를 그럴듯하게 보여주느니** 초과라고 밝힌다.
 */
const UINT32_MAX = 4294967295;

const MARKETS: { key: string; label: string }[] = [
  { key: "000", label: "전체" },
  { key: "001", label: "코스피" },
  { key: "101", label: "코스닥" },
];

// sort_tp: 1:거래량, 2:거래회전율, 3:거래대금
const SORTS: { key: string; label: string }[] = [
  { key: "3", label: "거래대금" },
  { key: "1", label: "거래량" },
  { key: "2", label: "거래회전율" },
];

export function VolumeRankingPage({ onSelectStock }: { onSelectStock: (code: string, name: string) => void }) {
  const [market, setMarket] = useState("000");
  const [sortTp, setSortTp] = useState("3"); // 서버 조회 기준 (거래대금/거래량/회전율)
  const [data, setData] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [updatedAt, setUpdatedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData((await api.volumeRanking(market, sortTp)) as RawRecord);
      setUpdatedAt(Date.now());
    } catch (err) {
      setError(err instanceof Error ? err.message : "알 수 없는 오류");
    } finally {
      setLoading(false);
    }
  }, [market, sortTp]);

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
      <div className="filter-row">
        {SORTS.map((s) => (
          <button
            key={s.key}
            className={`filter-btn ${sortTp === s.key ? "active" : ""}`}
            onClick={() => setSortTp(s.key)}
          >
            {s.label}순
          </button>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}
      {loading && <div className="empty">불러오는 중...</div>}

      {!loading && !error && (
        <div className="data-table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <SortableTh
                  columnKey="name"
                  label="종목명"
                  accessor={(r: RawRecord) => String(r.stk_nm ?? "")}
                  sort={sort}
                  className="sticky-col"
                />
                <SortableTh
                  columnKey="price"
                  label="현재가"
                  accessor={(r: RawRecord) => Math.abs(Number(r.cur_prc)) || 0}
                  sort={sort}
                />
                <SortableTh
                  columnKey="fluRt"
                  label="등락률"
                  accessor={(r: RawRecord) => Number(r.flu_rt) || 0}
                  sort={sort}
                />
                {/*
                  거래대금을 등락률 바로 뒤로 올린다. 이 화면의 기본 정렬이 거래대금순인데
                  정작 그 값이 거래량 뒤에 있어 모바일에서 잘렸다 — 정렬 기준은 보여야 한다.

                  게다가 거래량은 믿을 수 없는 줄이 있다. 키움이 32비트를 넘기면
                  4,294,967,295(2^32-1)로 잘라 준다 — 오늘 KODEX 200선물인버스2X 가 그렇다.
                  같은 줄의 거래대금(6,182억)은 멀쩡하다.
                */}
                <SortableTh
                  columnKey="amt"
                  label="거래대금(억)"
                  accessor={(r: RawRecord) => Number(r.trde_amt) || 0}
                  sort={sort}
                />
                <SortableTh
                  columnKey="qty"
                  label="거래량"
                  accessor={(r: RawRecord) => Number(r.trde_qty) || 0}
                  sort={sort}
                />
                <SortableTh
                  columnKey="turn"
                  label="거래회전율(%)"
                  accessor={(r: RawRecord) => Number(r.trde_tern_rt) || 0}
                  sort={sort}
                />
              </tr>
            </thead>
            <tbody>
              {sort.sorted.map((r, i) => {
                const code = normalizeStockCode(String(r.stk_cd ?? ""));
                const name = String(r.stk_nm ?? "");
                return (
                  <tr key={`${code}-${i}`} onClick={() => onSelectStock(code, name)} className="clickable-row">
                    <td className="sticky-col">
                      <span className="rank-cell">{i + 1}. </span>
                      <WatchStar code={code} />
                      {name}
                    </td>
                    <td className={signClass(r.pred_pre)}>{fmtAbsNum(r.cur_prc)}</td>
                    <td className={signClass(r.flu_rt)}>{fmtNum(r.flu_rt)}%</td>
                    {/* 백만원으로 오므로 100 으로 나눠 억원으로 — 검산해서 확인했다 */}
                    <td className="num">
                      {fmtNum(Math.round((Number(r.trde_amt) || 0) / 100))}
                    </td>
                    <td className="num">
                      {UINT32_MAX === Number(r.trde_qty) ? (
                        <span className="pt-n" title="키움이 32비트를 넘기면 이 값으로 잘라 줍니다">
                          집계 초과
                        </span>
                      ) : (
                        fmtNum(r.trde_qty)
                      )}
                    </td>
                    <td>{fmtNum(r.trde_tern_rt)}</td>
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
      <div className="table-note">HTS 0130(거래상위) 참고 · ka10030 · 관리종목 제외</div>
    </div>
  );
}
