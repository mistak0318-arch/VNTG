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

function short(v: number): string {
  const a = Math.abs(v);
  if (a >= 100_000_000) return `${(v / 100_000_000).toFixed(1)}억`;
  if (a >= 10_000) return `${(v / 10_000).toFixed(1)}만`;
  return v.toLocaleString("ko-KR");
}

export function DeltaChart({
  points,
  unit = "",
  height = H,
}: {
  points: DeltaPoint[];
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
      </svg>

      {/* 양끝 시각과 제일 큰·작은 값 — 촘촘한 눈금은 폰에서 뭉갠다 */}
      <div className="dc-legend">
        <span>{hhmm(points[0].t)}</span>
        <span className="dc-peak">
          <b className="positive">
            +{short(hi.v)}
            {unit}
          </b>
          <span className="pt-n"> {hhmm(hi.t)}</span>
          {lo.v < 0 && (
            <>
              {" · "}
              <b className="negative">
                {short(lo.v)}
                {unit}
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
            {unit}
          </b>
        </div>
      )}
    </div>
  );
}
