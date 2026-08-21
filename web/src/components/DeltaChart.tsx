import { useState } from "react";

/**
 * 시간축 증감 막대 — **거래원과 프로그램매매가 같이 쓴다.**
 *
 * ## 왜 만들었나
 *
 * 둘 다 「시각 · 막대 · 숫자」를 세로로 줄줄이 쌓고 있었다. 점이 스무 개만 넘어도
 * 화면을 한참 굴려야 했고, **한눈에 보이는 게 없었다** — 언제 붙었고 언제 빠졌는지는
 * 세로 목록이 아니라 **가로 시간축**으로 봐야 읽힌다.
 *
 * 폰에서는 더 심했다. 한 점이 한 줄을 차지하니 스무 점이면 화면 두 개다.
 *
 * ## 0선을 가운데 두는 이유
 *
 * 증감은 **부호가 뜻의 절반**이다. 위로 붙었는지 아래로 빠졌는지가 크기보다 먼저
 * 읽혀야 해서, 0을 가운데 긋고 위아래로 갈라 그린다.
 *
 * ## 누적선을 겹친다
 *
 * 증감 막대만 보면 **「지금 붙는지」는 알아도 「전체적으로 어느 쪽인지」를 모른다.**
 * 하루 종일 조금씩 팔다가 오후에 크게 산 날과, 아침에 크게 사고 계속 판 날이
 * 막대만으로는 비슷해 보인다.
 *
 * 그래서 **누적을 선으로 겹친다.** 이 선이 0을 넘는 순간이 「총매도에서 총매수로
 * 돌아선 자리」다 — 그 지점에 표시를 찍는다. 눈금은 서로 다르므로(막대는 구간 크기,
 * 선은 하루 총합) **선은 제 눈금으로** 그린다.
 *
 * ## 눈금은 최대·최소만
 *
 * 촘촘한 눈금은 폰에서 뭉갠다. 제일 큰 값과 제일 작은 값, 그리고 시간 양끝만 적는다 —
 * 「얼마나 컸나」와 「언제였나」면 충분하고, 정확한 값은 눌러서 본다.
 */

export interface DeltaPoint {
  /** HHmmss 또는 HHmm */
  t: string;
  v: number;
}

const W = 320;
const H = 96;
const PAD = { t: 10, b: 14, l: 0, r: 0 };

function hhmm(t: string): string {
  return t.length >= 4 ? `${t.slice(0, 2)}:${t.slice(2, 4)}` : t;
}

/**
 * 큰 수를 짧게 — **단위와 겹치지 않게.**
 *
 * ⚠️ 여기서 한 번 데였다. 값이 「백만원」 단위인데 만/억으로 또 줄여 붙였더니
 * **「+7.8만백만」**이 나왔다. 읽을 수가 없다.
 *
 * 그래서 단위를 아는 쪽에서 자릿수를 정한다 — 「백만」이면 만 단위로 줄이고
 * 이름을 **조원**으로 바꾸는 식이다. 줄인 이름과 원래 단위를 같이 쓰면 안 된다.
 */
function short(v: number, unit: string): { text: string; unit: string } {
  const a = Math.abs(v);
  if (unit === "백만") {
    // 백만원 단위 → 1만이면 100억, 100만이면 1조
    if (a >= 1_000_000) return { text: (v / 1_000_000).toFixed(2), unit: "조원" };
    if (a >= 100) return { text: (v / 100).toFixed(0), unit: "억원" };
    return { text: v.toLocaleString("ko-KR"), unit: "백만원" };
  }
  if (a >= 10_000) return { text: (v / 10_000).toFixed(1), unit: `만${unit}` };
  return { text: v.toLocaleString("ko-KR"), unit };
}

export function DeltaChart({
  points,
  cum,
  unit = "",
  height = H,
}: {
  points: DeltaPoint[];
  /**
   * 누적값. 안 주면 **증감을 더해서** 만든다 —
   * 프로그램매매처럼 키움이 누적을 따로 주면 그걸 쓰는 게 정확하다.
   */
  cum?: number[];
  /** 값 옆에 붙일 단위 (「주」·「백만」 등) */
  unit?: string;
  height?: number;
}) {
  /** 눌러서 그 점의 정확한 값을 본다 — 촘촘한 눈금 대신 */
  const [at, setAt] = useState<number | null>(null);

  if (points.length < 2) return null;

  const mx = Math.max(...points.map((p) => Math.abs(p.v)), 1);
  const ih = height - PAD.t - PAD.b;
  const zero = PAD.t + ih / 2;
  const slot = W / points.length;
  const bw = Math.max(1, slot * 0.72);

  const hi = points.reduce((a, b) => (b.v > a.v ? b : a), points[0]);
  const lo = points.reduce((a, b) => (b.v < a.v ? b : a), points[0]);
  const picked = at === null ? null : points[at];

  /* 누적 — 안 주면 증감을 더해 만든다 */
  const totals =
    cum && cum.length === points.length
      ? cum
      : points.reduce<number[]>((acc, p, i) => {
          acc.push((i === 0 ? 0 : acc[i - 1]) + p.v);
          return acc;
        }, []);
  const cmax = Math.max(...totals.map((v) => Math.abs(v)), 1);
  // 선은 제 눈금으로 — 막대(구간 크기)와 선(하루 총합)은 자릿수가 다르다
  const cy = (v: number) => zero - (v / cmax) * (ih / 2);
  const line = totals.map((v, i) => `${i === 0 ? "M" : "L"}${slot * i + slot / 2},${cy(v)}`).join("");

  /* 0을 넘어선 자리 — 총매도에서 총매수로 돌아선 지점 */
  const crosses: number[] = [];
  for (let i = 1; i < totals.length; i++) {
    if ((totals[i - 1] < 0 && totals[i] >= 0) || (totals[i - 1] > 0 && totals[i] <= 0)) {
      crosses.push(i);
    }
  }
  const last = totals[totals.length - 1];

  return (
    <div className="dc">
      <svg className="dc-svg" viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img">
        {/* 0선 — 부호가 뜻의 절반이다 */}
        <line className="dc-zero" x1={0} x2={W} y1={zero} y2={zero} />
        {points.map((p, i) => {
          const h = (Math.abs(p.v) / mx) * (ih / 2);
          const x = slot * i + (slot - bw) / 2;
          return (
            <rect
              key={`${p.t}-${i}`}
              className={`dc-bar ${p.v >= 0 ? "up" : "down"}${at === i ? " on" : ""}`}
              x={x}
              y={p.v >= 0 ? zero - h : zero}
              width={bw}
              height={Math.max(1, h)}
              onPointerDown={() => setAt(at === i ? null : i)}
            />
          );
        })}

        {/* 누적선 — 이게 0을 넘는 순간이 돌아선 자리다 */}
        <path className="dc-cum" d={line} />
        {crosses.map((i) => (
          <circle
            key={`x-${i}`}
            className="dc-cross"
            cx={slot * i + slot / 2}
            cy={zero}
            r={2.5}
          />
        ))}
      </svg>

      {/* 지금 누적이 어느 쪽인지 — 선만 보면 크기를 못 읽는다 */}
      <div className="dc-total">
        <span className="pt-n">누적</span>{" "}
        <b className={last >= 0 ? "positive" : "negative"}>
          {last > 0 ? "+" : ""}
          {short(last, unit).text}
          {short(last, unit).unit}
        </b>
        {crosses.length > 0 && (
          <span className="pt-n">
            {" · "}
            {hhmm(points[crosses[crosses.length - 1]].t)} 에 {last >= 0 ? "매수" : "매도"} 우위로
            돌아섬
          </span>
        )}
      </div>

      {/* 양끝 시각과 제일 큰·작은 값 — 촘촘한 눈금은 폰에서 뭉갠다 */}
      <div className="dc-legend">
        <span>{hhmm(points[0].t)}</span>
        <span className="dc-peak">
          <b className="positive">
            +{short(hi.v, unit).text}
            {short(hi.v, unit).unit}
          </b>
          <span className="pt-n"> {hhmm(hi.t)}</span>
          {lo.v < 0 && (
            <>
              {" · "}
              <b className="negative">
                {short(lo.v, unit).text}
                {short(lo.v, unit).unit}
              </b>
              <span className="pt-n"> {hhmm(lo.t)}</span>
            </>
          )}
        </span>
        <span>{hhmm(points[points.length - 1].t)}</span>
      </div>

      {picked && (
        <div className="dc-pick">
          {hhmm(picked.t)}{" "}
          <b className={picked.v >= 0 ? "positive" : "negative"}>
            {picked.v > 0 ? "+" : ""}
            {picked.v.toLocaleString("ko-KR")}
            {unit === "백만" ? "백만원" : unit}
          </b>
        </div>
      )}
    </div>
  );
}
