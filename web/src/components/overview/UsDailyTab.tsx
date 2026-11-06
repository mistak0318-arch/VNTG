import { useEffect, useState } from "react";
import { api, fmtNum } from "../../api";

/**
 * **해외 종목 일별상세** (2026-11-07 — 벤티지: "해외종목 종목상세 화면도 국내처럼 다양하게
 * 위아래로 메뉴해서 꾸미라니깐? 모든 메뉴를 도입하되 못 가져오는건 그냥 표시안하면되잖아").
 *
 * 국내 상세의 「일별상세」 자리다. 한투 해외 일봉(`usChart`)이 날짜·시·고·저·종가·거래량을
 * 주므로, 국내와 같은 칸으로 늘어놓는다 — 최신이 위다.
 *
 * ## 국내와 다른 점
 *
 * 국내 일별상세에는 **외국인·기관 순매수**가 같이 뜬다. 해외에는 그 개념이 없다(주는 곳도
 * 없다). 그래서 칸을 아예 안 만든다 — 빈 칸을 두면 「오늘은 안 왔나」로 읽힌다.
 *
 * ⚠️ 한투 해외 일봉은 **100건까지만** 준다(실측 2026-11-07). 그 사실을 표 아래 적는다.
 */

type Row = { t: string; open: number; high: number; low: number; close: number; volume: number };

export function UsDailyTab({ symbol }: { symbol: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    api
      .usChart(symbol, "D")
      .then((r) => {
        if (!alive) return;
        /* 서버가 날짜 오름차순으로 준다 — 표는 최신이 위라 뒤집는다 */
        setRows([...(r.candles ?? [])].reverse() as Row[]);
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : "일봉을 받지 못했습니다"));
    return () => {
      alive = false;
    };
  }, [symbol]);

  if (error) return <div className="page-note">{error}</div>;
  if (rows === null) return <div className="empty">일봉을 받는 중…</div>;
  if (rows.length === 0) return <div className="page-note">일봉이 없습니다.</div>;

  return (
    <>
      <div className="data-table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th className="sticky-col">날짜</th>
              <th className="num">종가</th>
              <th className="num">전일 대비</th>
              <th className="num">시가</th>
              <th className="num">고가</th>
              <th className="num">저가</th>
              <th className="num">거래량</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              /* 전일 대비 — 바로 아래 줄(하루 전)과 견준다. 마지막 줄은 그 전날이 없다 */
              const prev = rows[i + 1];
              const diff = prev && prev.close > 0 ? ((r.close - prev.close) / prev.close) * 100 : null;
              return (
                <tr key={r.t}>
                  <td className="sticky-col">{r.t}</td>
                  <td className="num">
                    <b>{r.close.toLocaleString("ko-KR")}</b>
                  </td>
                  <td className={`num ${diff == null ? "" : diff > 0 ? "positive" : diff < 0 ? "negative" : ""}`}>
                    {diff == null ? "-" : `${diff > 0 ? "+" : ""}${diff.toFixed(2)}%`}
                  </td>
                  <td className="num">{r.open.toLocaleString("ko-KR")}</td>
                  <td className="num">{r.high.toLocaleString("ko-KR")}</td>
                  <td className="num">{r.low.toLocaleString("ko-KR")}</td>
                  <td className="num">{fmtNum(r.volume)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="table-note">
        한국투자증권 해외 일봉입니다 — <b>{rows.length}거래일</b>치({rows[rows.length - 1]?.t} ~ {rows[0]?.t}).
        한투가 <b>100건까지만</b> 주므로 그보다 멀리는 못 봅니다. 국내 일별상세에 있는{" "}
        <b>외국인·기관 순매수</b>는 해외에 그 개념이 없어 칸을 두지 않았습니다.
      </div>
    </>
  );
}
