import { useEffect, useState } from "react";
import { api, fmtNum, type IndexCandle } from "../../api";

/**
 * 거래대금 현황 (2026-08-25) — **시장의 유동성**을 보는 칸.
 *
 * 지수가 오르는 날과 돈이 들어오는 날은 다르다. 지수 +1% 인데 거래대금이
 * 평소의 60% 면 **소수 종목이 얇게 든 것**이고, 지수는 보합인데 대금이 평소의
 * 두 배면 판이 갈리는 중이다. 종목등락현황(폭) 바로 아래에 두는 이유 —
 * 「몇 종목이 올랐나」 다음 물음이 「돈은 얼마나 돌았나」다.
 *
 * 줄을 누르면 최근 거래대금 추이가 막대로 펼쳐진다. 재료는 지수 차트와 같은
 * ka20006 일봉(거래대금 억원 포함)이라 추가 TR 이 없다.
 */

const MARKETS = [
  { code: "001", name: "코스피" },
  { code: "101", name: "코스닥" },
] as const;

/** 억원 → 「12.3조」/「8,400억」 */
function money(eok: number): string {
  if (eok >= 10000) return `${(eok / 10000).toFixed(1)}조`;
  return `${fmtNum(Math.round(eok))}억`;
}

function pctCls(v: number | null): string {
  if (v === null || v === 0) return "";
  return v > 0 ? "positive" : "negative";
}

/** 최근 N일 거래대금 막대 — 마지막(오늘)은 강조, 20일 평균선 */
function TurnoverChart({ candles }: { candles: IndexCandle[] }) {
  const rows = candles.slice(-40);
  if (rows.length < 2) return null;
  const W = 640;
  const H = 110;
  const PAD = { l: 4, r: 52, t: 8, b: 16 };
  const max = Math.max(1, ...rows.map((c) => c.tradeValue));
  const bw = (W - PAD.l - PAD.r) / rows.length;
  const yOf = (v: number) => H - PAD.b - ((H - PAD.t - PAD.b) * v) / max;
  const last20 = rows.slice(-20);
  const avg20 = last20.reduce((a, c) => a + c.tradeValue, 0) / last20.length;

  return (
    <div className="to-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {[max, max / 2].map((v, i) => (
          <g key={i}>
            <line className="tc-grid" x1={PAD.l} x2={W - PAD.r} y1={yOf(v)} y2={yOf(v)} />
            <text className="tc-tick" x={W - PAD.r + 4} y={yOf(v) + 3}>
              {money(v)}
            </text>
          </g>
        ))}
        {/* 20일 평균 — 「오늘이 평소보다 많은가」의 기준선 */}
        <line className="to-avg" x1={PAD.l} x2={W - PAD.r} y1={yOf(avg20)} y2={yOf(avg20)} />
        {rows.map((c, i) => (
          <rect
            key={c.dt}
            className={i === rows.length - 1 ? "to-bar today" : "to-bar"}
            x={PAD.l + i * bw + bw * 0.18}
            y={yOf(c.tradeValue)}
            width={bw * 0.64}
            height={Math.max(1, H - PAD.b - yOf(c.tradeValue))}
          >
            <title>
              {c.dt.slice(4, 6)}/{c.dt.slice(6, 8)} · {money(c.tradeValue)}
            </title>
          </rect>
        ))}
        {/* 달 경계 눈금 */}
        {rows.map((c, i) =>
          i > 0 && c.dt.slice(4, 6) !== rows[i - 1].dt.slice(4, 6) ? (
            <text key={`m${c.dt}`} className="tc-tick" x={PAD.l + i * bw} y={H - 4}>
              {Number(c.dt.slice(4, 6))}월
            </text>
          ) : null,
        )}
      </svg>
      <div className="table-note">
        최근 {rows.length}거래일 · 점선은 <b>20일 평균</b>({money(avg20)}) — 오늘 막대가 그
        위면 평소보다 붐빈 날입니다. 마지막 막대가 오늘(장중이면 지금까지 누적)입니다.
      </div>
    </div>
  );
}

export function TurnoverPanel() {
  const [data, setData] = useState<Record<string, IndexCandle[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      for (const m of MARKETS) {
        try {
          const r = await api.indexDetail(m.code, "day");
          if (!alive) return;
          setData((p) => ({ ...p, [m.code]: r.candles }));
        } catch (e) {
          if (alive) setError(e instanceof Error ? e.message : "조회 실패");
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="ov-card-b">
      {error && Object.keys(data).length === 0 && <div className="error-banner">{error}</div>}
      <table className="ov-table num">
        <thead>
          <tr>
            <th>구분</th>
            <th>오늘 거래대금</th>
            <th title="전일 대비">전일比</th>
            <th title="최근 20거래일 평균 대비 — 100%보다 크면 평소보다 붐빈다">20일 평균比</th>
          </tr>
        </thead>
        <tbody>
          {MARKETS.map((m) => {
            const cs = data[m.code];
            if (!cs || cs.length === 0) {
              return (
                <tr key={m.code}>
                  <td>{m.name}</td>
                  <td colSpan={3} className="pt-n">
                    불러오는 중…
                  </td>
                </tr>
              );
            }
            const today = cs[cs.length - 1];
            const prev = cs[cs.length - 2];
            const vsPrev =
              prev && prev.tradeValue > 0
                ? ((today.tradeValue - prev.tradeValue) / prev.tradeValue) * 100
                : null;
            const last20 = cs.slice(-21, -1);
            const avg =
              last20.length > 0 ? last20.reduce((a, c) => a + c.tradeValue, 0) / last20.length : 0;
            const vsAvg = avg > 0 ? (today.tradeValue / avg) * 100 : null;
            return (
              <tr
                key={m.code}
                className="clickable-row"
                onClick={() => setOpen(open === m.code ? null : m.code)}
                title="누르면 최근 추이가 펼쳐집니다"
              >
                <td>
                  <i className="sf-caret">{open === m.code ? "▾" : "▸"}</i> {m.name}
                </td>
                <td>
                  <b>{money(today.tradeValue)}</b>
                </td>
                <td className={pctCls(vsPrev)}>
                  {vsPrev === null ? "-" : `${vsPrev > 0 ? "+" : ""}${vsPrev.toFixed(0)}%`}
                </td>
                <td className={vsAvg !== null && vsAvg >= 120 ? "positive" : vsAvg !== null && vsAvg <= 70 ? "negative" : ""}>
                  {vsAvg === null ? "-" : `${vsAvg.toFixed(0)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {open && data[open] && <TurnoverChart candles={data[open]} />}
      <div className="table-note">
        지수가 오르는 날과 <b>돈이 도는 날</b>은 다릅니다 — 상승인데 대금이 얇으면 소수
        종목이 끈 것이고, 보합인데 대금이 크면 판이 갈리는 중입니다. 장중에는 지금까지의
        누적이라 오후로 갈수록 커지는 게 정상입니다.
      </div>
    </div>
  );
}
