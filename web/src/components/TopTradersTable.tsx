import { Pager, usePager } from "./Pager";
import { fmtNum, normalizeStockCode, signClass, type TopTraderRow } from "../api";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { useSection } from "../useSection";

/**
 * 수익률 상위 고객 매매동향 (`ka04196`).
 *
 * 시황 대시보드에만 있던 것을 **시세분석에서도 쓸 수 있게** 떼어냈다.
 * 같은 표를 두 곳에 복사하면 한쪽만 고쳐지는 날이 반드시 온다.
 *
 * ## 왜 보나
 *
 * 「돈을 벌고 있는 계좌들이 지금 무엇을 사고 있나」다. 순매수 금액만 보면 한 계좌의
 * 몰빵일 수 있으므로 **계좌 수**를 같이 본다 — 여럿이 같이 보는 종목인지가 다른 이야기다.
 */
export function TopTradersTable({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const { data, loading, error } = useSection<TopTraderRow[]>("topTraders", 120_000);
  const rows = data ?? [];
  /*
   * ⚠️ 훅은 **조기 return 앞**에 둔다. 아래 「불러오는 중」에서 먼저 빠져나가면 그 렌더에는
   * 훅이 하나 모자라고, 다음 렌더에서 개수가 달라져 React 가 통째로 멎는다.
   */
  const pager = usePager(rows.length, "vntg.toptraders.pageSize", rows.length);
  // 컬럼 정렬 — 모든 표 공통 규칙(2026-08-26). 정렬은 쪽 나누기 전에 건다
  const sort = useSortableTable<TopTraderRow>(rows);

  if (loading && !data) return <div className="empty">불러오는 중…</div>;
  if (error && !data) return <div className="error-banner">{error}</div>;
  if (rows.length === 0) return <div className="empty">데이터 없음</div>;

  return (
    <div>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <SortableTh columnKey="name" label="종목" accessor={(r: TopTraderRow) => r.name} sort={sort} className="sticky-col" />
              <SortableTh columnKey="price" label="현재가" accessor={(r: TopTraderRow) => r.price} sort={sort} />
              <SortableTh columnKey="rate" label="등락률" accessor={(r: TopTraderRow) => r.changeRate} sort={sort} />
              <SortableTh columnKey="net" label="순매수" accessor={(r: TopTraderRow) => r.netAmount} sort={sort} />
              <SortableTh columnKey="acc" label="계좌" accessor={(r: TopTraderRow) => r.accounts} sort={sort} />
              <SortableTh columnKey="avg" label="평균단가" accessor={(r: TopTraderRow) => r.avgBuyPrice} sort={sort} />
              <SortableTh columnKey="pr" label="수익률" accessor={(r: TopTraderRow) => r.profitRate} sort={sort} />
            </tr>
          </thead>
          <tbody>
            {pager.slice(sort.sorted).map((r) => (
              <tr
                key={r.code}
                className={onSelectStock ? "clickable-row" : ""}
                onClick={() => onSelectStock?.(normalizeStockCode(r.code), r.name)}
              >
                <td className="sticky-col">{r.name}</td>
                <td className="num">{fmtNum(r.price)}</td>
                <td className={`num ${signClass(r.changeRate)}`}>
                  {r.changeRate > 0 ? "+" : ""}
                  {r.changeRate.toFixed(2)}%
                </td>
                <td className={`num ${signClass(r.netAmount)}`}>
                  {Math.round(r.netAmount).toLocaleString("ko-KR")}억
                </td>
                <td className="num">{r.accounts}</td>
                <td className="num pt-n">{fmtNum(r.avgBuyPrice)}</td>
                <td className={`num ${signClass(r.profitRate)}`}>
                  {r.profitRate > 0 ? "+" : ""}
                  {r.profitRate.toFixed(0)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pager pager={pager} total={rows.length} unit="번째" />
      <div className="table-note">
        키움 <b>수익률 상위 고객</b> 계좌들의 매매입니다. 금액은 억원.
        <b> 계좌 수</b>를 같이 보세요 — 순매수가 커도 한 계좌면 그 사람 사정이고,
        여럿이 같이 사고 있으면 다른 이야기입니다.
      </div>
    </div>
  );
}
