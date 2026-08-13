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

          <div className="metric-help">
            <div className="metric-help-item">
              <b>상승 종목 비율</b>
              <p>
                그날 오른 종목이 전체의 몇 %인지. <b>50%가 기준선</b>입니다. 이 값이 낮은데 지수가
                오르면 소수 대형주가 끌고 가는 장이라, 지수만 보고 &ldquo;좋다&rdquo;고 판단하면
                정작 내가 든 종목은 빠지고 있을 수 있습니다.
              </p>
            </div>

            <div className="metric-help-item">
              <b>A/D Line (등락주선)</b>
              <p>
                매일 <b>(오른 종목 수 − 내린 종목 수)</b>를 구해서 <b>계속 더해 나간 값</b>입니다.
                오늘 +300, 내일 −100이면 선은 300 → 200이 됩니다. 그래서 이 선의{" "}
                <b>기울기</b>만 의미가 있고 절대 숫자 자체에는 뜻이 없습니다 — 우상향이면 오르는
                종목이 계속 더 많다는 뜻입니다.
              </p>
              <p>
                이걸 왜 보냐면 <b>지수는 시가총액으로 가중</b>되기 때문입니다. 삼성전자 하나가
                지수를 밀어 올려도 나머지 2,000종목이 빠지면 지수는 오르고 A/D Line은 내려갑니다.
                이렇게 <b>지수와 A/D Line이 반대로 갈 때를 다이버전스</b>라 하고, 오르는 장에서
                나타나면 상승을 떠받치는 종목 수가 줄고 있다는 신호로 봅니다.
              </p>
              <p className="metric-help-caution">
                다만 다이버전스는 <b>몇 주에 걸쳐 벌어져야</b> 의미가 있고, 신호가 나온 뒤에도 한참
                더 오르는 경우가 흔합니다. 매도 신호가 아니라 &ldquo;장의 폭이 좁아지는 중&rdquo;
                이라는 배경 정보로 쓰세요.
              </p>
            </div>

            <div className="metric-help-item">
              <b>신고가 − 신저가</b>
              <p>
                250일 신고가 종목 수에서 신저가 종목 수를 뺀 값입니다. <b>플러스면</b> 신고가를
                쓰는 종목이 더 많은 강세장, <b>마이너스면</b> 바닥을 깨는 종목이 더 많은 약세장
                입니다. 크게 마이너스였다가 <b>0 쪽으로 돌아서는 지점</b>이 하락이 마무리되는
                국면에서 자주 나옵니다.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
