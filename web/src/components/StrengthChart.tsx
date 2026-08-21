/**
 * 체결강도 그래프 — **사자가 몰리나 팔자가 몰리나.**
 *
 * ## 왜 표만으로는 부족한가
 *
 * 체결강도는 이미 표로 있었다. 그런데 숫자를 세로로 예순 줄 읽어서
 * 「10시에 뒤집혔다」를 알아내는 사람은 없다. **언제 뒤집혔나**가 이 값의 쓸모인데
 * 그건 선으로 봐야 보인다.
 *
 * 등락률은 **결과**다. 오르고 나서 멈춘 것과 계속 사고 있는 것이 등락률로는 똑같이
 * 보인다. 체결강도는 매수 체결 ÷ 매도 체결이라 그 둘을 가른다 — 100 이 균형이다.
 *
 * ## 100 은 반드시 눈금 안에 넣는다
 *
 * 다른 그래프는 데이터 범위에 눈금을 맞춘다(0을 억지로 안 넣는다). 여기는 반대다.
 * 120~140 사이만 확대해 그리면 **「세다」는 사실 자체가 사라진다** — 균형선을 넘었는지가
 * 값보다 먼저 읽혀야 한다.
 *
 * ## 평균선을 겹친다
 *
 * 체결강도는 한 건에도 튄다. 키움이 5·20·60분 평균을 같이 주므로 **20분 평균**을
 * 흐린 선으로 깔면 「튄 것」과 「흐름이 바뀐 것」이 갈린다.
 */

const W = 320;
const H = 108;
const PAD = { t: 10, b: 10 };

export interface StrengthPoint {
  /** HHmmss(시간별) 또는 YYYYMMDD(일별) */
  t: string;
  strength: number;
  /** 20분(또는 20일) 평균 */
  avg: number;
  price: number;
  rate: number;
}

function label(t: string): string {
  if (t.length >= 8) return `${Number(t.slice(4, 6))}/${Number(t.slice(6, 8))}`;
  if (t.length >= 4) return `${t.slice(0, 2)}:${t.slice(2, 4)}`;
  return t;
}

export function StrengthChart({ points }: { points: StrengthPoint[] }) {
  if (points.length < 2) return null;

  const vals = points.map((p) => p.strength);
  let min = Math.min(...vals, 100);
  let max = Math.max(...vals, 100);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const ih = H - PAD.t - PAD.b;
  const y = (v: number) => PAD.t + ((max - v) / (max - min)) * ih;
  const x = (i: number) => (i / (points.length - 1)) * W;
  const line = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.strength)}`).join("");
  const avgLine = points
    .filter((p) => p.avg > 0)
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(points.indexOf(p))},${y(p.avg)}`)
    .join("");

  const last = points[points.length - 1];

  /* 100 을 넘나든 자리 — 매수 우위와 매도 우위가 뒤집힌 시각 */
  const crosses: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1].strength;
    const b = points[i].strength;
    if ((a < 100 && b >= 100) || (a > 100 && b <= 100)) crosses.push(i);
  }

  /*
   * 갑자기 튄 자리. 앞 점 대비 변화가 그 구간 평균 변화폭의 네 배를 넘으면 표시한다.
   * 「그 시각에 무슨 일이 있었나」를 뉴스·공시와 맞춰 보라는 뜻이다.
   */
  const diffs = points.slice(1).map((p, i) => Math.abs(p.strength - points[i].strength));
  const avgDiff = diffs.length > 0 ? diffs.reduce((a, b) => a + b, 0) / diffs.length : 0;
  const jumps: number[] = [];
  for (let i = 1; i < points.length; i++) {
    if (avgDiff > 0 && Math.abs(points[i].strength - points[i - 1].strength) > avgDiff * 4) {
      jumps.push(i);
    }
  }

  const peak = points.reduce((a, b) => (b.strength > a.strength ? b : a), points[0]);
  const dip = points.reduce((a, b) => (b.strength < a.strength ? b : a), points[0]);

  return (
    <div className="sp">
      <div className="sp-top">
        <span className="sp-now">
          <span className="pt-n">지금 </span>
          <b className={last.strength >= 100 ? "positive" : "negative"}>
            {last.strength.toFixed(0)}
          </b>
          <span className="pt-n">
            {" "}
            {last.strength >= 100 ? "매수 체결 우세" : "매도 체결 우세"}
          </span>
        </span>
        <span className="pt-n">
          평균 {last.avg > 0 ? last.avg.toFixed(0) : "-"} · {points.length}점
        </span>
      </div>

      <div className="sp-chart">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
          {/* 100 = 균형. 값보다 이 선을 넘었는지가 먼저다 */}
          <line className="sp-base" x1={0} x2={W} y1={y(100)} y2={y(100)} />
          {jumps.map((i) => (
            <line key={`j-${i}`} className="sp-jump" x1={x(i)} x2={x(i)} y1={0} y2={H} />
          ))}
          {avgLine && <path className="sp-avg" d={avgLine} />}
          <path className={`sp-line ${last.strength >= 100 ? "up" : "down"}`} d={line} />
          {crosses.map((i) => (
            <circle
              key={`c-${i}`}
              className="sp-cross"
              cx={x(i)}
              cy={y(points[i].strength)}
              r={2.5}
            />
          ))}
        </svg>
        <span className="sp-y hi">{max.toFixed(0)}</span>
        {/* 하루 종일 100 위였으면 최저가 곧 100 이다 — 그때 「100」을 또 적으면 겹친다 */}
        {min < 100 && max > 100 && (
          <span className="sp-y base" style={{ top: `${(y(100) / H) * 100}%` }}>
            100
          </span>
        )}
        <span className="sp-y lo">{min.toFixed(0)}</span>
      </div>

      <div className="sp-legend">
        <span>{label(points[0].t)}</span>
        <span className="sp-mid">
          최고 <b className="positive">{peak.strength.toFixed(0)}</b>
          <span className="pt-n"> {label(peak.t)}</span>
          {" · "}
          최저 <b className="negative">{dip.strength.toFixed(0)}</b>
          <span className="pt-n"> {label(dip.t)}</span>
        </span>
        <span>{label(last.t)}</span>
      </div>

      {(crosses.length > 0 || jumps.length > 0) && (
        <div className="sp-marks">
          {crosses.length > 0 && (
            <span>
              <i className="sp-k cross" /> 뒤집힌 자리{" "}
              <b>{crosses.slice(-4).map((i) => label(points[i].t)).join(" · ")}</b>
            </span>
          )}
          {jumps.length > 0 && (
            <span>
              <i className="sp-k jump" /> 갑자기 튄 자리{" "}
              <b>{jumps.slice(-4).map((i) => label(points[i].t)).join(" · ")}</b>
            </span>
          )}
        </div>
      )}

      <div className="table-note">
        <b>100 이 균형</b>입니다 — 위로 벌어지면 매수 체결이 우세합니다. 등락률은 결과라서
        「오르고 멈춘 것」과 「계속 사는 것」이 안 갈리는데 이 값이 그 둘을 가릅니다.
        흐린 선은 <b>평균</b>이라 한 건에 튄 것과 흐름이 바뀐 것을 갈라 줍니다.
        <b> ●</b> 는 100 을 넘나든 자리, <b>세로줄</b>은 갑자기 튄 자리입니다 — 그 시각의
        뉴스·공시와 맞춰 보세요.
      </div>
    </div>
  );
}
