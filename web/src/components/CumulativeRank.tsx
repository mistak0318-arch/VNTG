import { useEffect, useState } from "react";
import { fmtNum, signClass } from "../api";

/**
 * 누적등락률 상위 — **키움에 없어서 우리가 계산한다.**
 *
 * HTS [0796] 순위분석의 「누적등락상위」 자리다. 키움 REST 순위정보 26개를 전수
 * 확인했는데 없다 — `ka10027` 은 전일대비뿐이고 기간 옵션이 없다.
 *
 * ## 시간이 걸린다는 걸 숨기지 않는다
 *
 * 종목마다 일봉을 받아야 해서 100종목이면 **26초**다. 그동안 빈 화면을 두면
 * 「고장인가」 싶어진다. 몇 초쯤 걸리는지 미리 적고, 도는 동안 그렇게 말해 준다.
 * 한 번 계산하면 10분은 그대로 준다(누적등락률은 그 사이에 순위가 안 뒤집힌다).
 *
 * ## 오늘 등락률을 같이 보여주는 이유
 *
 * 5일 누적이 좋아도 **오늘 빠지고 있으면** 다른 이야기다. 「며칠째 오르는 중」과
 * 「오르다 오늘 꺾임」을 가르지 못하면 순위를 잘못 읽는다.
 */

interface Row {
  code: string;
  name: string;
  price: number;
  cumRate: number;
  todayRate: number;
  from: number;
  tradeValue: number;
}

const DAYS = [3, 5, 10, 20];

export function CumulativeRank({
  onSelectStock,
}: {
  onSelectStock?: (code: string, name: string) => void;
}) {
  const [days, setDays] = useState(5);
  const [market, setMarket] = useState("000");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");

  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError(null);
    fetch(`/api/rank/cumulative?days=${days}&market=${market}`)
      .then((r) => r.json())
      .then((j: { rows?: Row[]; note?: string; error?: string }) => {
        if (!alive) return;
        if (j.error) setError(j.error);
        setRows(j.rows ?? []);
        setNote(j.note ?? "");
      })
      .catch((e: Error) => alive && setError(e.message))
      .finally(() => alive && setBusy(false));
    return () => {
      alive = false;
    };
  }, [days, market]);

  return (
    <div>
      <div className="filter-row">
        <span className="st-cfg-k">기간</span>
        {DAYS.map((d) => (
          <button
            key={d}
            className={`filter-btn ${days === d ? "active" : ""}`}
            onClick={() => setDays(d)}
          >
            {d}일
          </button>
        ))}
        <span className="st-cfg-k">시장</span>
        {[
          { k: "000", l: "전체" },
          { k: "001", l: "코스피" },
          { k: "101", l: "코스닥" },
        ].map((m) => (
          <button
            key={m.k}
            className={`filter-btn ${market === m.k ? "active" : ""}`}
            onClick={() => setMarket(m.k)}
          >
            {m.l}
          </button>
        ))}
      </div>

      {error && <div className="error-banner">{error}</div>}

      {busy && !rows && (
        <div className="page-note">
          <b>계산 중입니다 — 30초쯤 걸립니다.</b> 키움에 누적등락률 TR 이 없어서 종목마다
          일봉을 받아 직접 셉니다. 한 번 계산하면 <b>10분간</b>은 바로 나옵니다.
        </div>
      )}

      {rows && rows.length > 0 && (
        <div className="data-table-wrap">
          <table className="data-table num">
            <thead>
              <tr>
                <th className="sticky-col">종목</th>
                <th>현재가</th>
                <th title="고른 기간 동안의 누적 등락률">{days}일 누적</th>
                <th title="오늘 하루 — 누적이 좋아도 오늘 꺾였으면 다른 이야기다">오늘</th>
                <th title="기간 시작일 종가">시작가</th>
                <th>거래대금</th>
              </tr>
            </thead>
            <tbody>
              {rows.slice(0, 60).map((r, i) => (
                <tr
                  key={r.code}
                  className={onSelectStock ? "clickable-row" : ""}
                  onClick={() => onSelectStock?.(r.code, r.name)}
                >
                  <td className="sticky-col">
                    <span className="pt-n">{i + 1}. </span>
                    {r.name}
                  </td>
                  <td>{fmtNum(r.price)}</td>
                  <td className={signClass(r.cumRate)}>
                    <b>
                      {r.cumRate > 0 ? "+" : ""}
                      {r.cumRate.toFixed(2)}%
                    </b>
                  </td>
                  <td className={signClass(r.todayRate)}>
                    {r.todayRate > 0 ? "+" : ""}
                    {r.todayRate.toFixed(2)}%
                  </td>
                  <td className="pt-n">{fmtNum(r.from)}</td>
                  <td className="pt-n">{fmtNum(Math.round(r.tradeValue))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rows && rows.length === 0 && !busy && (
        <div className="empty">결과가 없습니다.</div>
      )}

      {note && <div className="table-note">{note}</div>}
    </div>
  );
}
