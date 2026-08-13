import { useEffect, useState } from "react";
import { api, type BreadthPoint } from "../api";

/**
 * 시장 폭 추이.
 *
 * 다른 화면들이 전부 "오늘"만 보여주는 것과 달리, 여기는 오직 누적으로만 의미가 생긴다.
 * 그래서 데이터가 적을 때 억지로 그리지 않고 "며칠 쌓였다"고 정직하게 말한다.
 *
 * 서버가 소급 조회를 못 하므로(키움 API가 과거 등락종목수를 안 준다) 오늘부터 하루씩 쌓인다.
 */

const RANGES = [
  { days: 20, label: "20일" },
  { days: 60, label: "60일" },
  { days: 120, label: "120일" },
];

/** 값 배열을 폴리라인 좌표로. 위아래 여백 10%를 준다. */
function toPath(values: number[], w: number, h: number): string {
  if (values.length < 2) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pad = h * 0.1;
  return values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - pad - ((v - min) / span) * (h - pad * 2);
      return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

/** 0선이 그려질 y좌표 (값 범위가 0을 걸칠 때만) */
function zeroY(values: number[], h: number): number | null {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min > 0 || max < 0) return null;
  const span = max - min || 1;
  const pad = h * 0.1;
  return h - pad - ((0 - min) / span) * (h - pad * 2);
}

function MiniChart({
  values,
  label,
  color,
  format,
}: {
  values: number[];
  label: string;
  color: string;
  format: (n: number) => string;
}) {
  const W = 320;
  const H = 70;
  const last = values[values.length - 1];
  const zero = zeroY(values, H);

  return (
    <div className="breadth-chart">
      <div className="breadth-chart-head">
        <span className="breadth-chart-label">{label}</span>
        <span className="breadth-chart-value" style={{ color }}>
          {format(last)}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="breadth-svg">
        {zero !== null && (
          <line x1={0} y1={zero} x2={W} y2={zero} className="breadth-zero" />
        )}
        <path d={toPath(values, W, H)} fill="none" stroke={color} strokeWidth={1.6} />
      </svg>
    </div>
  );
}

export function BreadthPanel() {
  const [days, setDays] = useState(60);
  const [points, setPoints] = useState<BreadthPoint[]>([]);
  const [summary, setSummary] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .breadth(days)
      .then((r) => {
        if (cancelled) return;
        setPoints(r.points);
        setSummary(r.summary);
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
  }, [days]);

  if (loading) return <div className="empty">시장 폭 불러오는 중...</div>;
  if (error) return <div className="error-banner">{error}</div>;

  return (
    <div className="breadth">
      <div className="breadth-summary">{summary}</div>

      {points.length < 2 ? (
        <div className="page-note">
          아직 <b>{points.length}일치</b>만 쌓였습니다. 이 지표는 과거 데이터를 소급해서 받아올 수
          없어(키움 API가 과거 등락종목수를 주지 않습니다) 오늘부터 하루씩 누적됩니다. 서버가 켜져
          있는 한 자동으로 쌓이니, 2주쯤 지나면 추세가 보이기 시작합니다.
        </div>
      ) : (
        <>
          <div className="filter-row">
            {RANGES.map((r) => (
              <button
                key={r.days}
                className={`filter-btn ${days === r.days ? "active" : ""}`}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
            <span className="breadth-count">누적 {points.length}일</span>
          </div>

          <div className="breadth-charts">
            <MiniChart
              label="상승 종목 비율"
              values={points.map((p) => p.risingPct)}
              color="var(--blue)"
              format={(n) => `${n.toFixed(0)}%`}
            />
            <MiniChart
              label="A/D Line (상승−하락 누적)"
              values={points.map((p) => p.adLine)}
              color="var(--green)"
              format={(n) => n.toLocaleString("ko-KR")}
            />
            <MiniChart
              label="신고가 − 신저가"
              values={points.map((p) => p.highLowDiff)}
              color="#f5c542"
              format={(n) => (n > 0 ? `+${n}` : String(n))}
            />
          </div>

          <div className="table-note">
            <b>상승 비율</b>이 낮은데 지수가 오르면 소수 대형주가 끌고 가는 장입니다.
            <b> A/D Line</b>이 지수와 반대로 움직이면(다이버전스) 추세가 약해지고 있다는 신호입니다.
            <b> 신고가−신저가</b>가 마이너스에서 돌아서면 바닥을 다지는 국면일 수 있습니다.
          </div>
        </>
      )}
    </div>
  );
}
