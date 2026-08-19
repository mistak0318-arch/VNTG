import { useEffect, useState } from "react";
import { api, fmtNum, normalizeStockCode, signClass, type StockRow } from "../../api";
import { SortableTh, useSortableTable } from "../../useSortableTable";
import { WatchStar } from "../../useWatchedCodes";

export interface ConstituentTarget {
  kind: "theme" | "sector" | "custom";
  code: string;
  name: string;
  market?: "kospi" | "kosdaq"; // 업종일 때만
  /**
   * 내 테마일 때 구성종목을 그대로 넘긴다.
   * 이미 손에 있는 걸 다시 조회할 이유가 없다 — 테마 평가에서 받아온 그 값이다.
   */
  stocks?: StockRow[];
  /**
   * 제목에 붙일 이름표. 안 주면 `kind` 로 정한다.
   *
   * `custom` 이 「내 테마」만 뜻하지 않게 됐다 — 리포트의 **미국 테마 MAP** 도
   * 이걸 쓰는데 그건 해외 관심종목 그룹이다. 「내 테마 구성종목」이라고 뜨면 거짓말이다.
   */
  label?: string;
}

/** 테마/업종 구성종목 목록 시트 */
export function ConstituentSheet({
  target,
  onClose,
  onSelectStock,
}: {
  target: ConstituentTarget;
  onClose: () => void;
  onSelectStock: (code: string, name: string) => void;
}) {
  const [items, setItems] = useState<StockRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const sort = useSortableTable(items);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    // 내 테마는 이미 받아온 구성종목을 그대로 쓴다 (조회 0회)
    if (target.stocks) {
      setItems([...target.stocks].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)));
      setLoading(false);
      return;
    }

    const req =
      target.kind === "theme"
        ? api.themeStocks(target.code)
        : api.sectorStocks(target.market ?? "kospi", target.code);
    req
      .then((res) => {
        // 시총이 큰 종목일수록 테마·업종을 실제로 끌고 가는 힘이 크므로 기본 정렬을 시총순으로
        if (!cancelled) setItems([...res.items].sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0)));
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [target.kind, target.code, target.market, target.stocks]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-header">
          <h2>
            {target.name}
            <span className="sheet-sub">
              {target.label ??
                (target.kind === "custom" ? "내 테마" : target.kind === "theme" ? "테마" : "업종")}{" "}
              구성종목
            </span>
          </h2>
          <button className="close-btn" onClick={onClose}>
            ✕
          </button>
        </div>

        {loading && <div className="empty">불러오는 중...</div>}
        {error && <div className="error-banner">{error}</div>}

        {!loading && !error && items.length === 0 && (
          <div className="empty">
            구성종목 데이터가 없습니다. (키움 API가 일부 업종코드는 제공하지 않습니다)
          </div>
        )}

        {!loading && !error && items.length > 0 && (
          <div className="data-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <SortableTh columnKey="name" label="종목명" accessor={(s: StockRow) => s.name} sort={sort} className="sticky-col" />
                  <SortableTh columnKey="price" label="현재가" accessor={(s: StockRow) => s.price} sort={sort} />
                  <SortableTh columnKey="change" label="전일대비" accessor={(s: StockRow) => s.change} sort={sort} />
                  <SortableTh columnKey="changeRate" label="등락률" accessor={(s: StockRow) => s.changeRate} sort={sort} />
                  <SortableTh columnKey="marketCap" label="시가총액(억)" accessor={(s: StockRow) => s.marketCap ?? 0} sort={sort} />
                </tr>
              </thead>
              <tbody>
                {sort.sorted.map((s, i) => {
                  const code = normalizeStockCode(s.code);
                  return (
                    <tr
                      key={`${code}-${i}`}
                      className="clickable-row"
                      onClick={() => onSelectStock(code, s.name)}
                    >
                      <td className="sticky-col">
                        <WatchStar code={code} />
                        {s.name}
                      </td>
                      {/*
                        넘겨받은 구성종목에는 현재가·전일대비가 없을 수 있다(테마 평가는
                        등락률만 쓴다). 그때 0 을 찍으면 **값이 0원인 것처럼 보인다** —
                        모르는 것은 「-」로 둔다.
                      */}
                      <td>{s.price ? fmtNum(s.price) : "-"}</td>
                      <td className={signClass(s.change)}>{s.price ? fmtNum(s.change) : "-"}</td>
                      <td className={signClass(s.changeRate)}>
                        {s.changeRate > 0 ? "+" : ""}
                        {s.changeRate.toFixed(2)}%
                      </td>
                      <td>{s.marketCap ? fmtNum(s.marketCap) : "-"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="table-note">
              {items.length}개 종목 · 시가총액 큰 순 · 시가총액 = 상장주식수 × 현재가 (억원) · 종목을 누르면 상세로
              이동합니다
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
