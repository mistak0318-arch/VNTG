import { useEffect, useState } from "react";
import { api, type IntraFlowPoint } from "../../api";

/**
 * 장중 투자자별 **누적 순매수 곡선** (2026-08-26 — 「차트 밑에 장중 수급 변화 찍어줘」).
 *
 * 네이버 Time 표(2분 간격 누적)를 서버가 하루치로 모아 준다. 값이 누적이라
 * 선 세 개(개인·외국인·기관)의 **모양 자체가 장중 수급 변화**다 — 오전에 팔던
 * 외국인이 오후에 돌아섰는지가 이 그림 하나로 보인다.
 *
 * 코스피(01)·코스닥(02)은 억원, K200 선물(03)은 계약.
 * 색은 사용자 지정(2026-08-26): 외국인 빨강 · 기관 찐한 노랑 · 개인 초록 —
 * 처음엔 국내 관행(외국인 파랑)으로 했는데 「색이 낯설다」고 해서 바꿨고,
 * 기관 주황은 빨강과 겹쳐 보여서 노랑으로 확정.
 */
export function IntradayFlowChart({
  market,
  unit,
}: {
  market: "01" | "02" | "03";
  unit: string;
}) {
  const [data, setData] = useState<{ date: string; points: IntraFlowPoint[] } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setData(null);
    setFailed(false);
    api
      .intradayFlow(market)
      .then((r) => alive && setData(r))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [market]);

  if (failed) return null;
  if (data === null) return <div className="empty">장중 수급 불러오는 중…</div>;
  const pts = data.points;
  if (pts.length < 2) return null;

  const W = 640;
  const H = 150;
  const PAD = { l: 4, r: 52, t: 14, b: 16 };
  const SERIES = [
    /*
     * 색 배정 (2026-08-26 사용자 지정) — 외국인 빨강 · 기관 찐한 노랑 · 개인 초록.
     * 주황도 써 봤는데 가는 선에서 빨강과 겹쳐 보여서 노랑으로 확정.
     */
    { key: "foreign" as const, label: "외국인", color: "#f04452" },
    { key: "institution" as const, label: "기관", color: "#eab308" },
    { key: "individual" as const, label: "개인", color: "#35c46a" },
  ];
  const vals = pts.flatMap((p) => SERIES.map((s) => p[s.key]));
  const max = Math.max(1, ...vals.map(Math.abs));
  const zero = PAD.t + (H - PAD.t - PAD.b) / 2;
  const scale = (H - PAD.t - PAD.b) / 2 / max;
  const xOf = (i: number) => PAD.l + ((W - PAD.l - PAD.r) * i) / (pts.length - 1);
  const yOf = (v: number) => zero - v * scale;
  const last = pts[pts.length - 1];

  // 시간 눈금 — 두 시간마다. 다 적으면 겹쳐서 하나도 안 읽힌다
  const hourTicks: { i: number; label: string }[] = [];
  let lastHour = "";
  pts.forEach((p, i) => {
    const h = p.t.slice(0, 2);
    if (h !== lastHour && Number(h) % 2 === 1) {
      hourTicks.push({ i, label: `${Number(h)}시` });
      lastHour = h;
    } else if (h !== lastHour) {
      lastHour = h;
    }
  });

  return (
    <div className="ff-wrap">
      <div className="ff-head">
        <b>장중 수급 변화 · {data.date.slice(5).replace("-", "/")} 누적({unit})</b>
        <span className="tct-legend">
          {SERIES.map((s) => (
            <span className="tct-key" key={s.key}>
              <i className="tct-dot" style={{ background: s.color }} />
              {s.label}{" "}
              <b className={last[s.key] > 0 ? "positive" : last[s.key] < 0 ? "negative" : ""}>
                {last[s.key] > 0 ? "+" : ""}
                {last[s.key].toLocaleString("ko-KR")}
              </b>
            </span>
          ))}
        </span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        <line className="breadth-zero" x1={PAD.l} x2={W - PAD.r} y1={zero} y2={zero} />
        <text className="tc-tick" x={W - PAD.r + 4} y={PAD.t + 8}>
          +{max.toLocaleString("ko-KR")}
        </text>
        <text className="tc-tick" x={W - PAD.r + 4} y={H - PAD.b}>
          -{max.toLocaleString("ko-KR")}
        </text>
        {SERIES.map((s) => (
          <polyline
            key={s.key}
            className="tct-line"
            style={{ stroke: s.color }}
            points={pts.map((p, i) => `${xOf(i)},${yOf(p[s.key])}`).join(" ")}
          />
        ))}
        {hourTicks.map((t) => (
          <text key={t.i} className="tc-tick" x={xOf(t.i)} y={H - 4} textAnchor="middle">
            {t.label}
          </text>
        ))}
      </svg>
      <div className="trade-note">
        네이버 투자자별 매매동향(2분 간격 누적, ±10분 지연) · 마지막 시각 {last.t}
      </div>
    </div>
  );
}
