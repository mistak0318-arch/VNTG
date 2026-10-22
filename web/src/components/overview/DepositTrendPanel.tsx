import { useEffect, useState } from "react";
import { api, signClass, type DepositDay } from "../../api";

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

/**
 * **잔고 추이 한 칸** (2026-10-22 — 벤티지: "증시자금 동향도 거래대금 현황처럼 추이 좀
 * 볼 수 있게 해줘").
 *
 * 여태 `Sparkline` 한 줄뿐이었다. 모양은 보이는데 **얼마에서 얼마로**가 안 보여서,
 * 「−1.8조」가 큰 변화인지 늘 있는 출렁임인지 가늠할 수가 없었다.
 *
 * 거래대금 차트(`TurnoverPanel`)와 같은 틀로 맞춘다 — 눈금 두 줄, 20일 평균 점선,
 * 달 경계, 마지막 점 강조. **다만 막대가 아니라 선이다.** 거래대금은 「그날 얼마나
 * 돌았나」라 막대가 맞지만, 예탁금·신용잔고는 **쌓여 있는 잔고**라 막대로 그리면
 * 0 부터 그려야 하고 그러면 90조 언저리의 움직임이 납작해져 아무것도 안 보인다.
 *
 * ⚠️ y 범위를 **데이터 최소~최대**로 잡는다(0 기준이 아니다). 잔고는 0 근처로 갈
 * 일이 없어서, 0 부터 그리면 차트의 90%가 빈 칸이 된다. 대신 눈금에 실제 값을 적어
 * 「바닥이 0 이 아니다」를 말한다.
 */
function DepositChart({
  days,
  pick,
  color,
}: {
  days: DepositDay[];
  pick: (d: DepositDay) => number | null;
  /** 선 색 — 예탁금과 신용잔고를 눈으로 가른다 */
  color: string;
}) {
  const rows = days.filter((d) => (pick(d) ?? 0) > 0).slice(-60);
  if (rows.length < 2) return null;
  const vals = rows.map((d) => pick(d) as number);
  const W = 300;
  const H = 84;
  const PAD = { l: 2, r: 42, t: 8, b: 14 };
  const max = Math.max(...vals);
  const min = Math.min(...vals);
  /* 위아래로 한 뼘 — 선이 테두리에 붙으면 꺾인 자리가 안 보인다 */
  const pad = (max - min) * 0.12 || max * 0.02 || 1;
  const hi = max + pad;
  const lo = Math.max(0, min - pad);
  const xOf = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * i) / (rows.length - 1);
  const yOf = (v: number) => H - PAD.b - ((H - PAD.t - PAD.b) * (v - lo)) / (hi - lo || 1);
  const line = vals.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(" ");
  const area = `${xOf(0)},${H - PAD.b} ${line} ${xOf(rows.length - 1)},${H - PAD.b}`;
  const last20 = vals.slice(-20);
  const avg20 = last20.reduce((a, b) => a + b, 0) / last20.length;

  return (
    <svg className="dep-chart" viewBox={`0 0 ${W} ${H}`} role="img">
      {[hi, lo].map((v, i) => (
        <g key={i}>
          <line className="tc-grid" x1={PAD.l} x2={W - PAD.r} y1={yOf(v)} y2={yOf(v)} />
          <text className="tc-tick" x={W - PAD.r + 3} y={yOf(v) + 3}>
            {(v / 조).toFixed(1)}조
          </text>
        </g>
      ))}
      {/* 20일 평균 — 「지금이 평소보다 많은가」의 기준선. 거래대금 차트와 같은 뜻 */}
      <line className="to-avg" x1={PAD.l} x2={W - PAD.r} y1={yOf(avg20)} y2={yOf(avg20)} />
      <polygon points={area} fill={color} opacity={0.14} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
      <circle cx={xOf(rows.length - 1)} cy={yOf(vals[vals.length - 1])} r={2.2} fill={color} />
      {rows.map((d, i) =>
        i > 0 && d.date.slice(5, 7) !== rows[i - 1].date.slice(5, 7) ? (
          <text key={`m${d.date}`} className="tc-tick" x={xOf(i)} y={H - 3}>
            {Number(d.date.slice(5, 7))}월
          </text>
        ) : null,
      )}
      <title>
        {rows.length}거래일 · {(min / 조).toFixed(1)}조 ~ {(max / 조).toFixed(1)}조 · 20일 평균{" "}
        {(avg20 / 조).toFixed(1)}조
      </title>
    </svg>
  );
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
          <DepositChart days={days} pick={(d) => d.deposit} color="var(--blue)" />
          <span className="dep-t">20일 {dTrend === null ? "-" : `${dTrend > 0 ? "+" : ""}${dTrend.toFixed(1)}%`}</span>
        </div>
        <div className="dep-cell">
          <span className="dep-k">신용잔고</span>
          <b className="num">{jo(last.credit)}</b>
          <span className={`num dep-d ${signClass(last.creditDiff ?? 0)}`}>{diff(last.creditDiff)}</span>
          <DepositChart days={days} pick={(d) => d.credit} color="var(--red)" />
          <span className="dep-t">20일 {cTrend === null ? "-" : `${cTrend > 0 ? "+" : ""}${cTrend.toFixed(1)}%`}</span>
        </div>
      </div>
      <div className="dep-funds">
        펀드 — 주식형 {jo(last.fundStock)} · 혼합형 {jo(last.fundMixed)} · 채권형 {jo(last.fundBond)}
      </div>
      <div className="table-note">
        선은 최근 <b>60거래일</b> 잔고 · 붉은 점선은 <b>20일 평균</b> — 선이 그 위면 요즘
        평소보다 많이 쌓여 있다는 뜻입니다. 눈금은 그 구간의 최저·최고라 <b>바닥이 0 이
        아닙니다.</b>
      </div>
      <div className="table-note">
        {last.date} 기준 · 네이버 증권{stale ? " · 새로 못 받아 옛 값" : ""} · 예탁금은 <b>살 힘</b>, 신용잔고는{" "}
        <b>빚으로 산 금액</b>입니다. 신용이 늘어난 채로 지수가 밀리면 반대매매가 나올 자리입니다.
      </div>
    </div>
  );
}
