import { useEffect, useState } from "react";
import { api, pickList, type RawRecord } from "../api";

/**
 * 지수의 장중 흐름 (코스피 / 코스닥).
 *
 * "장초반에 강했다가 밀렸는지, 후반에 힘이 붙었는지"를 보려는 화면이라
 * 캔들이 아니라 종가 라인 + 전일종가 기준선으로 그린다.
 * 데이터는 ka20005(업종 분봉). 시황 카드의 sparkline은 20점뿐이라 장 전체를 못 담는다.
 */

/** 지수는 소수 2자리를 정수로 보내온다 (6813.34 → "+681334") */
function toIndexValue(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) / 100 : 0;
}

function fmtIdx(v: number): string {
  return v.toLocaleString("ko-KR", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function hhmm(cntrTm: string): string {
  return cntrTm.length >= 12 ? `${cntrTm.slice(8, 10)}:${cntrTm.slice(10, 12)}` : "";
}

interface Point {
  time: string;
  value: number;
}

/** 응답에서 "가장 최근 거래일" 구간만 뽑는다 */
function todayPoints(raw: RawRecord | null): Point[] {
  const rows = pickList(raw ?? undefined, ["inds_min_pole_qry"]);
  if (rows.length === 0) return [];
  const latestDay = String(rows[0].cntr_tm ?? "").slice(0, 8);
  const out: Point[] = [];
  for (const r of rows) {
    const tm = String(r.cntr_tm ?? "");
    if (tm.slice(0, 8) !== latestDay) break; // 최신순이라 날짜가 바뀌면 중단
    const v = toIndexValue(r.cur_prc);
    if (v > 0) out.push({ time: hhmm(tm), value: v });
  }
  return out.reverse();
}

function Chart({ points, base, color }: { points: Point[]; base: number; color: string }) {
  const values = points.map((p) => p.value);
  const top = Math.max(...values, base);
  const bottom = Math.min(...values, base);
  const span = top - bottom || 1;

  const W = 100;
  const H = 42;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const y = (v: number) => H - ((v - bottom) / span) * H;

  const line = points.map((p, i) => `${x(i).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");

  return (
    <svg className="idx-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
      <polygon points={`0,${H} ${line} ${W},${H}`} fill={color} opacity={0.15} />
      <polyline
        points={line}
        fill="none"
        stroke={color}
        strokeWidth={0.6}
        vectorEffect="non-scaling-stroke"
      />
      {/* 전일종가 — 이 선 위/아래가 곧 플러스/마이너스 */}
      <line
        x1="0"
        x2={W}
        y1={y(base)}
        y2={y(base)}
        stroke="var(--muted)"
        strokeWidth={0.4}
        strokeDasharray="2 2"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function OneIndex({ code, name }: { code: string; name: string }) {
  const [raw, setRaw] = useState<RawRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .indexIntraday(code, "5")
      .then((r) => {
        if (!cancelled) setRaw(r as RawRecord);
      })
      .catch(() => {
        if (!cancelled) setRaw(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (loading) return <div className="empty">{name} 장중 흐름 불러오는 중...</div>;

  const points = todayPoints(raw);
  if (points.length < 2) return <div className="empty">{name} 장중 데이터가 없습니다.</div>;

  const rows = pickList(raw ?? undefined, ["inds_min_pole_qry"]);
  // 전일종가 = 현재가 - 전일대비 (첫 행이 최신)
  const last = points[points.length - 1].value;
  const diff = Number(String(rows[0]?.pred_pre ?? "0").replace(/[+,]/g, "").replace(/^--/, "-")) / 100;
  const base = last - diff;

  const open = points[0].value;
  const high = Math.max(...points.map((p) => p.value));
  const low = Math.min(...points.map((p) => p.value));
  const rate = base > 0 ? ((last - base) / base) * 100 : 0;
  const up = rate >= 0;
  const color = up ? "var(--red)" : "var(--blue)";

  return (
    <div className="idx-card">
      <div className="idx-head">
        <span className="idx-name">{name}</span>
        <span className={`idx-price ${up ? "positive" : "negative"}`}>{fmtIdx(last)}</span>
        <span className={`idx-rate ${up ? "positive" : "negative"}`}>
          {rate > 0 ? "+" : ""}
          {rate.toFixed(2)}%
        </span>
      </div>
      <Chart points={points} base={base} color={color} />
      <div className="idx-legend">
        <span>시 {fmtIdx(open)}</span>
        <span>고 {fmtIdx(high)}</span>
        <span>저 {fmtIdx(low)}</span>
        <span className="idx-time">
          {points[0].time} ~ {points[points.length - 1].time}
        </span>
      </div>
    </div>
  );
}

export function IndexIntraday() {
  return (
    <div className="idx-grid">
      <OneIndex code="001" name="코스피" />
      <OneIndex code="101" name="코스닥" />
    </div>
  );
}
