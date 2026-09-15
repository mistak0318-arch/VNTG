import { useEffect, useState } from "react";
import { api, signClass, type DepositDay } from "../../api";
import { Sparkline } from "./Sparkline";

/**
 * **증시자금동향** — 고객예탁금·신용잔고·펀드 (2026-09-16).
 *
 * 벤티지가 네이버 증권 개편판을 훑어 보라고 해서 찾은 것 중 하나. 우리 할 일 목록에는 이게 **「안 한다 —
 * 증시주변자금은 공공데이터 신청이 필요하다」**로 닫혀 있었는데, 네이버가 로그인 없이 준다(`trendDeposit`).
 *
 * 무엇을 보는 칸인가:
 *   · **고객예탁금** — 계좌에 들어와 대기 중인 돈. 늘면 살 힘이 쌓이는 것이고, 줄면 빠져나가는 것이다.
 *   · **신용잔고** — 빚내서 산 금액. 늘어난 채로 지수가 밀리면 반대매매가 밀려 나올 자리다.
 * 시장 체온계가 「얼마나 넓게 오르나」라면 이건 **「돈이 얼마나 들어와 있나」**다.
 *
 * 값은 전 영업일 기준 하루 한 줄 — 서버가 한 시간 캐시한다. 단위는 억원.
 */
const 조 = 10_000; // 억 → 조

function jo(v: number | null): string {
  if (v === null) return "-";
  return `${(v / 조).toFixed(1)}조`;
}
function diff(v: number | null): string {
  if (v === null || v === 0) return "-";
  const t = Math.abs(v) >= 조 ? `${(Math.abs(v) / 조).toFixed(1)}조` : `${Math.round(Math.abs(v)).toLocaleString("ko-KR")}억`;
  return `${v > 0 ? "+" : "−"}${t}`;
}

export function DepositTrendPanel() {
  const [days, setDays] = useState<DepositDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .naverDeposit(60)
      .then((r) => {
        if (!alive) return;
        setDays(r.days);
        setStale(r.stale);
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
    };
  }, []);

  if (error) return <div className="ov-card-b empty">네이버에서 못 받음 — {error}</div>;
  if (!days) return <div className="ov-card-b empty">불러오는 중…</div>;
  if (days.length === 0) return <div className="ov-card-b empty">자금 동향이 비어 있습니다.</div>;

  const last = days[days.length - 1];
  const deposits = days.map((d) => d.deposit ?? 0).filter((v) => v > 0);
  const credits = days.map((d) => d.credit ?? 0).filter((v) => v > 0);
  /* 20거래일 전과 견준다 — 하루치 증감은 결제일 때문에 튄다 */
  const ago = days[Math.max(0, days.length - 21)];
  const trend = (now: number | null, then: number | null) => (now === null || !then ? null : ((now - then) / then) * 100);
  const dTrend = trend(last.deposit, ago.deposit);
  const cTrend = trend(last.credit, ago.credit);

  return (
    <div className="ov-card-b dep">
      <div className="dep-row">
        <div className="dep-cell">
          <span className="dep-k">고객예탁금</span>
          <b className="num">{jo(last.deposit)}</b>
          <span className={`num dep-d ${signClass(last.depositDiff ?? 0)}`}>{diff(last.depositDiff)}</span>
          <Sparkline values={deposits} up={(dTrend ?? 0) >= 0} />
          <span className="dep-t">20일 {dTrend === null ? "-" : `${dTrend > 0 ? "+" : ""}${dTrend.toFixed(1)}%`}</span>
        </div>
        <div className="dep-cell">
          <span className="dep-k">신용잔고</span>
          <b className="num">{jo(last.credit)}</b>
          <span className={`num dep-d ${signClass(last.creditDiff ?? 0)}`}>{diff(last.creditDiff)}</span>
          <Sparkline values={credits} up={(cTrend ?? 0) >= 0} />
          <span className="dep-t">20일 {cTrend === null ? "-" : `${cTrend > 0 ? "+" : ""}${cTrend.toFixed(1)}%`}</span>
        </div>
      </div>
      <div className="dep-funds">
        펀드 — 주식형 {jo(last.fundStock)} · 혼합형 {jo(last.fundMixed)} · 채권형 {jo(last.fundBond)}
      </div>
      <div className="table-note">
        {last.date} 기준 · 네이버 증권{stale ? " · 새로 못 받아 옛 값" : ""} · 예탁금은 <b>살 힘</b>, 신용잔고는{" "}
        <b>빚으로 산 금액</b>입니다. 신용이 늘어난 채로 지수가 밀리면 반대매매가 나올 자리입니다.
      </div>
    </div>
  );
}
