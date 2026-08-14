import { useEffect, useState } from "react";
import { api, fmtNum, type ExchangeQuote } from "../api";

/**
 * 거래소별 시세 — KRX / NXT / 통합.
 *
 * 지금까지 화면의 시가·고가·저가는 **KRX만 본 값**이었다. 같은 삼성전자라도
 * KRX 고가 275,500 / NXT 고가 278,000 처럼 갈리는데, NXT에서 더 높이 찍힌 걸
 * 놓치고 있었다. 통합(_AL)이 두 곳을 합친 값이라 "그날 진짜 고가"는 거기 있다.
 *
 * 키움은 종목코드 접미사로 거래소를 가른다 — 005930 / 005930_NX / 005930_AL.
 */

function pct(n: number): string {
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}

export function ExchangeSplit({ code }: { code: string }) {
  const [rows, setRows] = useState<ExchangeQuote[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .exchangeQuotes(code)
      .then((r) => !cancelled && setRows(r.exchanges))
      .catch((e: Error) => !cancelled && setError(e.message))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (loading) return <div className="empty">거래소별 시세 불러오는 중…</div>;
  if (error) return <div className="error-banner">{error}</div>;
  if (rows.length === 0) return null;

  const krx = rows.find((r) => r.key === "krx");
  const nxt = rows.find((r) => r.key === "nxt");
  // 어느 거래소에서 고가/저가가 나왔는지 표시하기 위해
  const best = (pick: "high" | "low") => {
    if (!krx || !nxt || krx[pick] === null || nxt[pick] === null) return null;
    if (krx[pick] === nxt[pick]) return "동일";
    const higher = (krx[pick] as number) > (nxt[pick] as number);
    return pick === "high" ? (higher ? "KRX" : "NXT") : higher ? "NXT" : "KRX";
  };

  return (
    <>
      <div className="data-table-wrap">
        <table className="data-table num">
          <thead>
            <tr>
              <th className="sticky-col">거래소</th>
              <th>현재가</th>
              <th>등락률</th>
              <th>시가</th>
              <th>고가</th>
              <th>저가</th>
              <th>거래량</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={r.key === "all" ? "ex-total" : ""}>
                <td className="sticky-col">{r.label}</td>
                <td>{r.price === null ? "-" : fmtNum(r.price)}</td>
                <td className={r.changeRate > 0 ? "positive" : r.changeRate < 0 ? "negative" : ""}>
                  {pct(r.changeRate)}
                </td>
                <td>{r.open === null ? "-" : fmtNum(r.open)}</td>
                <td className="positive">{r.high === null ? "-" : fmtNum(r.high)}</td>
                <td className="negative">{r.low === null ? "-" : fmtNum(r.low)}</td>
                <td>{r.volume === null ? "-" : fmtNum(r.volume)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="table-note">
        같은 종목이라도 거래소마다 체결가가 달라 <b>고가·저가가 갈립니다</b>
        {best("high") && best("high") !== "동일" && <> — 오늘 고가는 <b>{best("high")}</b>에서 찍혔습니다</>}.
        <b> 통합</b>은 두 곳을 합친 값이라 그날의 실제 고가·저가와 총 거래량이 여기 있습니다.
        다른 화면의 시세는 별도 표시가 없으면 KRX 기준입니다.
      </div>
    </>
  );
}
