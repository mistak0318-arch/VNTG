import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * 보유 집중도 (2026-08-27 전수 점검에서 제안) — **지금 어디에 몰려 있나.**
 *
 * 보유종목 목록은 종목 단위라, 「반도체에 60% 몰려 있다」는 사실이 눈에 안 보였다.
 * 잔고를 업종·내 테마로 묶어 비중 막대로 보여 준다. 한 업종이 절반을 넘으면
 * 그 업종이 꺾이는 날 계좌가 통째로 꺾인다 — 그걸 사기 전에 알자는 자리다.
 */

type Conc = Awaited<ReturnType<typeof api.accountConcentration>>;

function won억(v: number): string {
  return `${(v / 100_000_000).toFixed(v >= 1_000_000_000 ? 0 : 1)}억`;
}

function Bars({
  rows,
  note,
}: {
  rows: { name: string; value: number; count: number; weight: number }[];
  note?: string;
}) {
  if (rows.length === 0) return <div className="empty">묶을 것이 없습니다.</div>;
  return (
    <div className="conc-bars">
      {rows.slice(0, 8).map((r) => (
        <div className="conc-row" key={r.name}>
          <span className="conc-name">
            {r.name} <i>({r.count})</i>
          </span>
          <span className="conc-track">
            <span
              className={`conc-fill${r.weight >= 50 ? " heavy" : ""}`}
              style={{ width: `${Math.min(r.weight, 100)}%` }}
            />
          </span>
          <b className="conc-pct">{r.weight.toFixed(0)}%</b>
          <span className="pt-n conc-val">{won억(r.value)}</span>
        </div>
      ))}
      {note && <p className="pt-n conc-note">{note}</p>}
    </div>
  );
}

export function ConcentrationCard() {
  const [data, setData] = useState<Conc | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api
      .accountConcentration()
      .then(setData)
      .catch((e: Error) => setError(e.message));
  }, []);

  if (error) return <div className="error-banner">{error}</div>;
  if (!data) return <div className="empty">불러오는 중…</div>;
  if (data.stocks.length === 0) return <div className="empty">보유종목이 없습니다.</div>;

  const topStock = data.stocks[0];
  return (
    <div>
      <p className="pt-n">
        평가 {won억(data.total)} · {data.stocks.length}종목 — 최대 종목 {topStock.name}{" "}
        {topStock.weight.toFixed(0)}%
        {topStock.weight >= 40 && <b className="negative"> (한 종목 집중 주의)</b>}
      </p>
      <div className="conc-cols">
        <div>
          <h4 className="conc-h">업종별</h4>
          <Bars rows={data.bySector} />
        </div>
        <div>
          <h4 className="conc-h">내 테마별</h4>
          <Bars
            rows={data.byTheme}
            note="한 종목이 여러 테마에 속할 수 있어 합이 100%를 넘을 수 있습니다."
          />
        </div>
      </div>
    </div>
  );
}
