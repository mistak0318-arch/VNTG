/**
 * 미니 라인차트 (2026-08-26) — 슈퍼신호등 대시보드의 흐름 그래프용.
 *
 * lightweight-charts 는 캔들·축·상호작용까지 딸려 오는 큰 물건이라, 「선 두세 개로
 * 흐름만 보여주기」에는 인라인 SVG 가 맞다. 의존성 0, 서버 값 그대로 그린다.
 * 값 배열에 null 이 섞이면 그 구간은 선을 끊는다(없는 데이터를 이어 그리면 거짓말이다).
 */

export interface MiniSeries {
  label: string;
  color: string;
  values: (number | null)[];
  /** 파선으로 — 보조 시리즈(지수·업종)를 본선과 구분 */
  dash?: boolean;
  width?: number;
}

export function MiniLine({
  series,
  labels,
  height = 160,
  yFmt = (v) => v.toFixed(0),
  refY,
  refYLabel,
  markX,
  markXLabel,
}: {
  series: MiniSeries[];
  /** x축 라벨(날짜) — 길이가 곧 x칸 수다 */
  labels: string[];
  height?: number;
  yFmt?: (v: number) => string;
  /** 수평 기준선 (예: 0%) */
  refY?: number;
  refYLabel?: string;
  /** 세로 기준선 위치(인덱스) — 편입일 표시 */
  markX?: number;
  markXLabel?: string;
}) {
  const W = 720;
  const H = height;
  const padL = 46;
  const padR = 8;
  const padT = 10;
  const padB = 18;

  const all = series.flatMap((s) => s.values.filter((v): v is number => v !== null));
  if (refY !== undefined) all.push(refY);
  if (all.length === 0) return <div className="empty">데이터 없음</div>;
  let lo = Math.min(...all);
  let hi = Math.max(...all);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const span = hi - lo;
  lo -= span * 0.06;
  hi += span * 0.06;

  const n = Math.max(labels.length, 2);
  const x = (i: number) => padL + ((W - padL - padR) * i) / (n - 1);
  const y = (v: number) => padT + ((H - padT - padB) * (hi - v)) / (hi - lo);

  /** null 구간에서 선을 끊은 path — M/L 로 직접 짠다 */
  const pathOf = (vals: (number | null)[]): string => {
    let d = "";
    let pen = false;
    vals.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    return d;
  };

  /* 가로 눈금 3줄 */
  const ticks = [0.25, 0.5, 0.75].map((t) => lo + (hi - lo) * t);
  /* x축 라벨은 처음·중간·끝만 — 다 적으면 겹쳐서 아무것도 안 읽힌다 */
  const xTicks = [0, Math.floor((n - 1) / 2), n - 1].filter((v, i, a) => a.indexOf(v) === i);

  return (
    <div className="miniline">
      <div className="miniline-legend">
        {series.map((s) => (
          <span key={s.label} className="miniline-key">
            <i style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: H }}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={padL} x2={W - padR} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth="1" />
            <text x={padL - 5} y={y(t) + 3} textAnchor="end" fontSize="10" fill="var(--muted)">
              {yFmt(t)}
            </text>
          </g>
        ))}
        {refY !== undefined && (
          <g>
            <line
              x1={padL}
              x2={W - padR}
              y1={y(refY)}
              y2={y(refY)}
              stroke="var(--muted)"
              strokeWidth="1"
              strokeDasharray="4 3"
            />
            {refYLabel && (
              <text x={W - padR} y={y(refY) - 4} textAnchor="end" fontSize="10" fill="var(--muted)">
                {refYLabel}
              </text>
            )}
          </g>
        )}
        {markX !== undefined && markX >= 0 && markX < n && (
          <g>
            <line
              x1={x(markX)}
              x2={x(markX)}
              y1={padT}
              y2={H - padB}
              stroke="var(--blue)"
              strokeWidth="1"
              strokeDasharray="3 3"
            />
            {markXLabel && (
              <text x={x(markX) + 4} y={padT + 10} fontSize="10" fill="var(--blue)">
                {markXLabel}
              </text>
            )}
          </g>
        )}
        {series.map((s) => (
          <path
            key={s.label}
            d={pathOf(s.values)}
            fill="none"
            stroke={s.color}
            strokeWidth={s.width ?? 1.8}
            strokeDasharray={s.dash ? "5 4" : undefined}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {xTicks.map((i) => (
          <text key={i} x={x(i)} y={H - 5} textAnchor="middle" fontSize="10" fill="var(--muted)">
            {labels[i] ?? ""}
          </text>
        ))}
      </svg>
    </div>
  );
}

/** 표 안에 넣는 손톱만 한 흐름 — 축 없음, 기준선 하나 */
export function Spark({
  values,
  color = "var(--blue)",
  refY,
  width = 84,
  height = 26,
}: {
  values: (number | null)[];
  color?: string;
  refY?: number;
  width?: number;
  height?: number;
}) {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length < 2) return <span className="pt-n">-</span>;
  let lo = Math.min(...nums);
  let hi = Math.max(...nums);
  if (refY !== undefined) {
    lo = Math.min(lo, refY);
    hi = Math.max(hi, refY);
  }
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const n = values.length;
  const x = (i: number) => (width * i) / (n - 1);
  const y = (v: number) => 2 + ((height - 4) * (hi - v)) / (hi - lo);
  let d = "";
  let pen = false;
  values.forEach((v, i) => {
    if (v === null) {
      pen = false;
      return;
    }
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      {refY !== undefined && (
        <line x1={0} x2={width} y1={y(refY)} y2={y(refY)} stroke="var(--border)" strokeDasharray="3 2" />
      )}
      <path d={d} fill="none" stroke={color} strokeWidth="1.4" />
    </svg>
  );
}
