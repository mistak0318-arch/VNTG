import { Pager, usePager } from "./Pager";
import { fmtNum, normalizeStockCode, signClass, type TopTraderRow } from "../api";
import { SortableTh, useSortableTable } from "../useSortableTable";
import { useSection } from "../useSection";
import { useBuzz } from "./BuzzBadge";

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
  /* 뉴스·텔레그램 24시간 수 — 시세분석 표 넷이 같은 훅 (2026-09-09) */
  const buzz = useBuzz(pager.slice(sort.sorted).map((r) => normalizeStockCode(r.code)));

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
              {/* 열 이름만으로는 「누구의 순매수인가」가 안 읽힌다 — 머리에 손을 올리면 뜻이 나온다 */}
              <SortableTh columnKey="net" label="순매수" accessor={(r: TopTraderRow) => r.netAmount} sort={sort} thProps={{ title: "이 종목을 들고 있는 수익률 상위 계좌들이 순으로 사들인 금액(억원) — 시장 전체가 아니라 그 계좌들만의 합입니다" }} />
              <SortableTh columnKey="acc" label="계좌" accessor={(r: TopTraderRow) => r.accounts} sort={sort} thProps={{ title: "이 종목을 들고 있는 수익률 상위 계좌의 수" }} />
              <SortableTh columnKey="avg" label="평균단가" accessor={(r: TopTraderRow) => r.avgBuyPrice} sort={sort} thProps={{ title: "그 계좌들의 평균 매입가" }} />
              <SortableTh columnKey="pr" label="수익률" accessor={(r: TopTraderRow) => r.profitRate} sort={sort} thProps={{ title: "그 계좌들의 이 종목 수익률 — 평균 매입가 대비 현재가" }} />
            </tr>
          </thead>
          <tbody>
            {pager.slice(sort.sorted).map((r) => (
              <tr
                key={r.code}
                className={onSelectStock ? "clickable-row" : ""}
                onClick={() => onSelectStock?.(normalizeStockCode(r.code), r.name)}
              >
                <td className="sticky-col">
                  {r.name}
                  {buzz.badge(normalizeStockCode(r.code), r.name)}
                </td>
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
      {buzz.sheet(onSelectStock)}
      {/*
        **열이 무슨 뜻인지 적는다** (2026-09-08 — 벤티지 "표에 순매수가 의미하는 게 뭐야?
        수익률 상위고객의 계좌에서 순매수 된 금액인가?"). 맞다. 그런데 화면에 그 말이 없어서
        시장 전체 순매수로 읽힐 수 있었다 — 하이닉스 8.8조처럼 하루 거래대금을 넘는 값이
        나오는 이유도 여기 있다(당일이 아니라 **쌓아 온 것**이다).
      */}
      <div className="table-note">
        키움이 고른 <b>수익률 상위 계좌들</b>의 보유·매매입니다 — <b>시장 전체 수급이 아닙니다.</b>
        <br />
        <b>순매수</b>는 그 계좌들이 이 종목을 순으로 사들인 금액(억원)이고, <b>평균단가·수익률</b>은
        그 계좌들의 것입니다. 하루 거래대금보다 큰 값이 나오는 것은 <b>당일 매매가 아니라 그동안
        쌓아 온 몫</b>이기 때문입니다.
        <br />
        <b>계좌 수</b>를 같이 보세요 — 순매수가 커도 한 계좌면 그 사람 사정이고, 여럿이 같이 사고
        있으면 다른 이야기입니다. 따라 사라는 목록이 아니라 <b>곁눈질</b>입니다.
      </div>
    </div>
  );
}
