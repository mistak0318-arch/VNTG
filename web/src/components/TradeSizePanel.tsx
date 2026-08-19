import { useEffect, useState } from "react";
import { api, fmtNum, type TradeSizeRow } from "../api";

/**
 * 체결금액대별 매매비중.
 *
 * 하루 거래를 **체결 한 건의 금액 크기별로** 쪼갠다. 3백만원 이하 체결이 얼마,
 * 5억 초과가 얼마 하는 식이다.
 *
 * 이게 왜 쓸모 있냐면 — **누가 사고 있는지**가 여기서 갈린다.
 * 소액 구간이 사고 고액 구간이 팔면 **개인이 받고 큰손이 던지는 중**이다.
 * 투자자별 수급은 하루 한 번 집계지만 이건 체결 단위라 결이 더 곱다.
 *
 * 그래서 화면도 **순매수 막대**를 가운데 두고 좌우로 편다 — 어느 구간이
 * 어느 쪽으로 기울었는지가 숫자를 읽기 전에 보여야 한다.
 */

export function TradeSizePanel({ code }: { code: string }) {
  const [rows, setRows] = useState<TradeSizeRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    api
      .tradeSize(code)
      .then((r) => alive && setRows(r.rows))
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, [code]);

  if (error) return <div className="error-banner">{error}</div>;
  if (!rows) return <div className="page-note">불러오는 중…</div>;
  if (rows.length === 0) return <div className="empty">체결 데이터가 없습니다.</div>;

  // 막대 길이의 기준 — 가장 크게 기운 구간을 100% 로 잡는다
  const peak = Math.max(...rows.map((r) => Math.abs(r.netQty)), 1);

  const smallNet = rows.slice(0, 4).reduce((a, r) => a + r.netQty, 0);
  const bigNet = rows.slice(-2).reduce((a, r) => a + r.netQty, 0);

  return (
    <>
      {/*
        한 줄 요약. 표를 읽기 전에 결론이 보여야 한다 —
        소액이 사고 고액이 파는 날과 그 반대는 완전히 다른 뜻이다.
      */}
      {smallNet !== 0 && bigNet !== 0 && (
        <div className="alert-note">
          {smallNet > 0 && bigNet < 0 && (
            <>
              <b>소액이 받고 큰손이 던지는 중</b>입니다 — 작은 체결은 순매수(
              {fmtNum(smallNet)}주), 큰 체결은 순매도({fmtNum(bigNet)}주).
            </>
          )}
          {smallNet < 0 && bigNet > 0 && (
            <>
              <b>큰손이 모으는 중</b>입니다 — 큰 체결이 순매수({fmtNum(bigNet)}주),
              작은 체결은 순매도({fmtNum(smallNet)}주).
            </>
          )}
          {smallNet > 0 && bigNet > 0 && <>작은 체결도 큰 체결도 모두 순매수입니다.</>}
          {smallNet < 0 && bigNet < 0 && <>작은 체결도 큰 체결도 모두 순매도입니다.</>}
        </div>
      )}

      <div className="ts-list">
        {rows.map((r) => {
          const w = (Math.abs(r.netQty) / peak) * 50; // 좌우 각각 최대 50%
          return (
            <div className="ts-row" key={r.band}>
              <span className="ts-band">{r.band}</span>
              <span className="ts-bar">
                {/* 가운데가 0. 순매도는 왼쪽, 순매수는 오른쪽 */}
                <i
                  className={r.netQty >= 0 ? "buy" : "sell"}
                  style={
                    r.netQty >= 0
                      ? { left: "50%", width: `${w}%` }
                      : { right: "50%", width: `${w}%` }
                  }
                />
              </span>
              <span className={`ts-net num ${r.netQty > 0 ? "positive" : r.netQty < 0 ? "negative" : ""}`}>
                {r.netQty > 0 ? "+" : ""}
                {fmtNum(r.netQty)}
              </span>
              <span className="ts-rate pt-n">
                매수 {r.buyRate.toFixed(2)}% / 매도 {r.sellRate.toFixed(2)}%
              </span>
            </div>
          );
        })}
      </div>

      <div className="table-note">
        체결 <b>한 건의 금액</b> 크기별로 나눈 것입니다(키움 <code>ka00196</code>). 막대는
        순매수 수량이고 가운데가 0입니다. 투자자별 수급은 하루 한 번 집계지만 이건 체결
        단위라 <b>결이 더 곱습니다</b> — 다만 누구인지를 직접 알려주는 건 아니고,
        금액 크기로 미루어 볼 뿐입니다.
      </div>
    </>
  );
}
