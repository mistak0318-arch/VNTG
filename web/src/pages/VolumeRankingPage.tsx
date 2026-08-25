import { useAutoRefresh } from "../useAutoRefresh";
import { useCallback, useEffect, useState } from "react";
import { api, fmtAbsNum, fmtNum, normalizeStockCode, pickList, signClass, type RawRecord } from "../api";
import { RefreshBar } from "../components/RefreshBar";
import { SignalCell, useSignalColumn } from "../components/SignalColumn";
import { Pager, usePager } from "../components/Pager";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { WatchStar } from "../useWatchedCodes";
import { ColumnGrip, useColumnWidths } from "../components/ColumnWidths";

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
  /* 칸 너비 조절 — 시세분석과 같은 공통 모듈 */
  const cw = useColumnWidths("volumeRank");
  /* 시세분석과 **같은 도구** — 켤 때만, 지금 쪽만 평가한다 */
  const [sigOn, setSigOn] = useState(false);
  /*
   * 앞의 50 종목만 평가한다. 백 종목을 다 재면 서버가 한참 걸린다 —
   * 거래상위는 쪽 넘기기가 없어 화면에 백 줄이 한꺼번에 있기 때문이다.
   */
  const pager = usePager(sort.sorted.length, "vntg.volume.pageSize", rows.length);
  const shown = pager.slice(sort.sorted);
  /*
   * **보이는 쪽만** 평가한다. 예전엔 앞의 50 종목만 켜서 그 뒤로 넘어가면 신호등이
   * 아예 안 붙었다 — 쪽을 나누면 어느 쪽을 보든 그 쪽이 켜진다.
   */
  const signals = useSignalColumn(
    shown.map((r) => normalizeStockCode(String(r.stk_cd ?? ""))),
    sigOn,
  );

  /* 장중에는 스스로 다시 받는다 — 새로고침을 누르러 오게 하면 안 된다 */
  const auto = useAutoRefresh(() => void load(), { storeKey: "vntg.auto.volume", intervalMs: 20000 });

  return (
    <div>
      <RefreshBar onRefresh={load} loading={loading} updatedAt={updatedAt} auto={auto}>
        <button
          className={`filter-btn ${sigOn ? "active" : ""}`}
          onClick={() => setSigOn((v) => !v)}
          title="지금 보고 있는 쪽만 평가합니다 — 처음엔 좀 걸립니다"
        >
          🚦 신호등 {sigOn ? "끄기" : "켜기"}
        </button>
      </RefreshBar>
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
      <div className="filter-row ctl-ribbon">
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
          <table className={`data-table${cw.customized ? " col-fixed" : ""}`}>
            <colgroup>
              {sigOn && <col style={{ width: "2.4rem" }} />}
              <col style={cw.styleOf("name")} />
              <col style={cw.styleOf("price")} />
              <col style={cw.styleOf("fluRt")} />
              <col style={cw.styleOf("amt")} />
              <col style={cw.styleOf("qty")} />
              <col style={cw.styleOf("turn")} />
            </colgroup>
            <thead>
              <tr>
                {sigOn && <th className="sig-th" title="신호등 — 누르면 근거가 열립니다">🚦</th>}
                <SortableTh
                  columnKey="name"
                  label="종목명"
                  accessor={(r: RawRecord) => String(r.stk_nm ?? "")}
                  sort={sort}
                  className="sticky-col"
                  extra={<ColumnGrip cw={cw} k="name" />}
                />
                <SortableTh
                  columnKey="price"
                  label="현재가"
                  accessor={(r: RawRecord) => Math.abs(Number(r.cur_prc)) || 0}
                  sort={sort}
                  extra={<ColumnGrip cw={cw} k="price" />}
                />
                <SortableTh
                  columnKey="fluRt"
                  label="등락률"
                  accessor={(r: RawRecord) => Number(r.flu_rt) || 0}
                  sort={sort}
                  extra={<ColumnGrip cw={cw} k="fluRt" />}
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
                  extra={<ColumnGrip cw={cw} k="amt" />}
                />
                <SortableTh
                  columnKey="qty"
                  label="거래량"
                  accessor={(r: RawRecord) => Number(r.trde_qty) || 0}
                  sort={sort}
                  extra={<ColumnGrip cw={cw} k="qty" />}
                />
                <SortableTh
                  columnKey="turn"
                  label="거래회전율(%)"
                  accessor={(r: RawRecord) => Number(r.trde_tern_rt) || 0}
                  sort={sort}
                  extra={<ColumnGrip cw={cw} k="turn" />}
                />
              </tr>
            </thead>
            <tbody>
              {shown.map((r, i) => {
                const code = normalizeStockCode(String(r.stk_cd ?? ""));
                const name = String(r.stk_nm ?? "");
                return (
                  <tr key={`${code}-${i}`} onClick={() => onSelectStock(code, name)} className="clickable-row">
                    {sigOn && (
                      <td className="sig-td">
                        <SignalCell
                          code={code}
                          name={name}
                          signal={signals[code]}
                          onSelectStock={onSelectStock}
                        />
                      </td>
                    )}
                    {/* 이름이 길면 잘린다(CSS) — 전체는 마우스를 올려서 본다 */}
                    <td className="sticky-col" title={name}>
                      <span className="rank-cell">{pager.from + i}. </span>
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
      <Pager pager={pager} total={sort.sorted.length} />
      <div className="table-note">HTS 0130(거래상위) 참고 · ka10030 · 관리종목 제외</div>
    </div>
  );
}
