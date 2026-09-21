/**
 * **당일 봉 한 개** (2026-09-22 — 벤티지: "등락률 옆에 봉 차트 보여줄 수 있어? 그래서 한눈에
 * 당일 흐름 봉으로 알수 있게끔").
 *
 * 등락률 숫자만으로는 **어떻게 그 숫자가 됐는지**가 안 보인다. 위로 갔다 내려온 +3% 와 쭉 오른 +3%
 * 는 완전히 다른 종목인데 표에서는 똑같이 `+3.00%` 다. 봉 하나면 그 둘이 갈린다.
 *
 * ## 무엇을 기준으로 그리나
 *
 * 세로 자는 **그날의 고가~저가**다(봉 하나뿐이라 다른 자가 없다). 전일 종가가 그 안에 들면
 * 점선으로 같이 긋는다 — 「시가가 갭으로 떴나」가 그 선과의 거리로 보인다.
 *
 * 색은 **전일 종가 대비**다. 캔들 차트의 관례(시가 대비)와 다른데, 옆 칸의 등락률이 전일 대비라
 * **같은 줄에서 색과 숫자가 어긋나면 안 되기 때문**이다. 시가 대비는 몸통의 위치로 이미 보인다.
 */

export interface MiniCandleData {
  o: number;
  h: number;
  l: number;
  c: number;
  pc: number;
}

/** 표 칸용(sm)과 종목 상세의 큰 숫자 옆(lg) — 같은 그림, 크기만 다르다 (2026-09-22) */
const SIZES = { sm: { w: 11, h: 26 }, lg: { w: 20, h: 46 } } as const;

export function MiniCandle({
  d,
  size = "sm",
}: {
  d: MiniCandleData | null | undefined;
  size?: keyof typeof SIZES;
}): React.ReactElement {
  const { w: W, h: H } = SIZES[size];
  if (!d || !(d.h > 0) || !(d.l > 0) || d.h < d.l) return <span className="dcd-none">-</span>;
  const span = d.h - d.l;
  /* 고·저가 같은 날(상한가 직행·거래 한 틱) — 가운데 가로줄 하나 */
  const flat = span <= 0;
  const y = (v: number) => (flat ? H / 2 : H - 1 - ((v - d.l) / span) * (H - 2));
  const up = d.pc > 0 ? d.c >= d.pc : d.c >= d.o;
  const cls = up ? "dcd-up" : "dcd-down";
  const bodyTop = Math.min(y(d.o), y(d.c));
  const bodyBot = Math.max(y(d.o), y(d.c));
  /* 몸통이 1px 보다 얇으면 안 보인다 — 도지도 선으로 보이게 최소 높이를 준다 */
  const bodyH = Math.max(size === "lg" ? 2 : 1.4, bodyBot - bodyTop);
  const pcIn = d.pc > 0 && d.pc >= d.l && d.pc <= d.h && !flat;
  const range = d.l > 0 ? ((d.h - d.l) / d.l) * 100 : 0;
  return (
    <svg
      className={`daycandle daycandle-${size} ${cls}`}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden="true"
    >
      <title>{`시 ${d.o.toLocaleString()} · 고 ${d.h.toLocaleString()} · 저 ${d.l.toLocaleString()} · 현 ${d.c.toLocaleString()}\n일중 변동폭 ${range.toFixed(1)}%`}</title>
      {pcIn && <line className="dcd-prev" x1={0} x2={W} y1={y(d.pc)} y2={y(d.pc)} />}
      {!flat && <line className="dcd-wick" x1={W / 2} x2={W / 2} y1={y(d.h)} y2={y(d.l)} />}
      <rect className="dcd-body" x={W * 0.23} y={flat ? H / 2 - 0.7 : bodyTop} width={W * 0.54} height={flat ? 1.4 : bodyH} />
    </svg>
  );
}
