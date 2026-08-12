/** 지수 카드용 미니 스파크라인. 값이 2개 미만이면 아무것도 그리지 않는다. */
export function Sparkline({ values, up }: { values: number[]; up: boolean }) {
  if (values.length < 2) return <div className="ov-spark" />;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const stepX = 100 / (values.length - 1);

  const points = values
    .map((v, i) => `${(i * stepX).toFixed(1)},${(26 - ((v - min) / range) * 24 - 1).toFixed(1)}`)
    .join(" ");

  return (
    <svg className="ov-spark" viewBox="0 0 100 26" preserveAspectRatio="none">
      <polyline
        fill="none"
        stroke={up ? "var(--up)" : "var(--down)"}
        strokeWidth={1.2}
        points={points}
      />
    </svg>
  );
}
