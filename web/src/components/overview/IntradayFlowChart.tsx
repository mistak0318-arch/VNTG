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

  /*
   * **넓이는 점 수를 따라간다** (2026-08-31 — "시계열이 길어져서 그런가 앞에가 짤려
   * 스크롤 될 수 있게 해줄래?").
   *
   * 예전엔 640 고정이었다. 2분 간격이라 장중만 195점, 시간외까지 270점이 넘는데
   * 그걸 640 안에 밀어 넣으니 선이 눌려 붙었다. 점마다 3px 을 주고, 넘치면
   * 감싼 칸이 **가로로 스크롤**된다(아래 `fi-scroll`).
   *
   * ⚠️ 왼쪽 여백이 **4** 였던 것이 진짜 잘림의 원인이다. 첫 시각 라벨이
   * `textAnchor="middle"` 로 x=4 에 놓여 절반이 viewBox 밖으로 나갔다 —
   * 「09시」가 「시」로 보였다. 라벨이 들어갈 만큼 준다.
   */
  const H = 150;
  const PAD = { l: 22, r: 52, t: 14, b: 16 };
  const W = Math.max(640, PAD.l + PAD.r + pts.length * 3);
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

  /*
   * **한 줄로 먼저 말한다** (2026-10-16 — 벤티지: "그래프 상단에 외국인 매수세 증가중,
   * 기관 매수세 증가중 이런 식으로 간략하게 좀 써줘, 텍스트로 바로 볼 수 있게").
   *
   * 범례는 **누적**을 말한다(외국인 −2,661). 그런데 이 곡선을 보는 까닭은 누적이 아니라
   * **지금 어느 쪽으로 가고 있나**다 — 하루 종일 판 날과 아침에 팔다 지금 사는 날이
   * 같은 −2,661 로 보이기 때문이다. 그 차이를 읽으라고 그림을 그려 놓고, 정작 읽는 일은
   * 사람에게 맡겨 두고 있었다.
   *
   * **최근 20분의 변화**로 가른다(2분 간격이라 10칸). 누적의 부호가 아니라 **그 창에서
   * 늘었나 줄었나**다 — 누적이 −2,661 이어도 그 사이에 샀으면 「매수 ↑」가 맞다.
   *
   * ⚠️ 문턱은 **비율**로 잡는다. 고정 숫자를 쓰면 코스닥에서 늘 「주춤」이 되고, 선물은
   * 단위가 계약이라 아예 뜻이 달라진다. 오늘 곡선이 닿은 최대폭의 3% 면 어느 시장에서든
   * 「움직였다」고 할 만하다.
   */
  const back = Math.min(pts.length - 1, 10); // 2분 간격 → 10칸 ≈ 20분
  const prev = pts[pts.length - 1 - back];
  const th = Math.max(1, max * 0.03);
  const moves = SERIES.map((sr) => {
    const d = last[sr.key] - prev[sr.key];
    return { label: sr.label, color: sr.color, dir: d >= th ? 1 : d <= -th ? -1 : 0, delta: d };
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
      {back >= 3 && (
        <div className="fi-now">
          {moves.map((m) => (
            <span key={m.label} className={m.dir > 0 ? "positive" : m.dir < 0 ? "negative" : "pt-n"}>
              <i style={{ background: m.color }} />
              {m.label} {m.dir > 0 ? "매수 ↑" : m.dir < 0 ? "매도 ↑" : "주춤"}
              <em>
                {m.delta > 0 ? "+" : ""}
                {Math.round(m.delta).toLocaleString("ko-KR")}
              </em>
            </span>
          ))}
          <span className="pt-n fi-now-note">최근 {back * 2}분 변화</span>
        </div>
      )}
      <div className="fi-scroll">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          /*
           * 넓이를 px 로 못 박고 `min-width:100%` 를 준다 — 점이 적으면 칸을 채우고,
           * 많으면 칸을 넘겨 스크롤된다. `preserveAspectRatio="none"` 이라야
           * 높이는 150 에 고정된 채 가로만 늘어난다.
           */
          preserveAspectRatio="none"
          style={{ width: `${W}px`, height: `${H}px`, minWidth: "100%" }}
        >
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
      </div>
      <div className="trade-note">
        네이버 투자자별 매매동향(2분 간격 누적, ±10분 지연) · 마지막 시각 {last.t}
      </div>
    </div>
  );
}
