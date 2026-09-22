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
 * 색은 **시가 대비**다 — 캔들 관례 그대로(양봉 빨강 / 음봉 파랑). 전일 대비는 옆 칸의 등락률이
 * 이미 말하므로, 색까지 그걸 되풀이하면 봉이 새로 말해 주는 것이 없다. 아래 `up` 주석 참고.
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
  /*
   * ⚠️ **색은 시가 대비다 — 캔들 관례** (2026-09-22 고침).
   *
   * 처음엔 **전일 종가 대비**로 칠했다. 이유는 「옆 칸 등락률이 전일 대비라 같은 줄에서 색과 숫자가
   * 어긋나면 안 된다」였는데, 그게 틀렸다. 벤티지가 SK스퀘어를 보고 「봉 이게 맞아?」라고 물었다 —
   * 시가 1,189,000(=고가)에서 출발해 1,160,000 으로 **밀린** 종목인데, 전일종가(1,127,000)보다는
   * 위라서 **양봉(빨강)** 으로 칠해졌다. 모양은 「위에서 밀렸다」인데 색은 「올랐다」였다.
   *
   * 색까지 전일 대비로 맞추면 **봉이 옆 숫자를 되풀이할 뿐 새로 말해 주는 게 없다.** 봉을 붙인 이유가
   * 「그 +2.93% 가 어떻게 된 +2.93% 인가」를 보려는 것이므로, 시가 대비가 맞다 — 전일 대비는 옆 칸이
   * 이미 말한다. 시가와 종가가 같으면(도지) 전일 대비로 가른다.
   */
  const up = d.c !== d.o ? d.c > d.o : d.pc > 0 ? d.c >= d.pc : true;
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
      <title>{`시 ${d.o.toLocaleString()} · 고 ${d.h.toLocaleString()} · 저 ${d.l.toLocaleString()} · 현 ${d.c.toLocaleString()}\n시가 대비 ${d.o > 0 ? `${d.c >= d.o ? "+" : ""}${(((d.c - d.o) / d.o) * 100).toFixed(2)}%` : "-"} · 일중 변동폭 ${range.toFixed(1)}%${pcIn ? "" : "\n전일종가는 오늘 범위 밖입니다(갭)"}`}</title>
      {pcIn && <line className="dcd-prev" x1={0} x2={W} y1={y(d.pc)} y2={y(d.pc)} />}
      {!flat && <line className="dcd-wick" x1={W / 2} x2={W / 2} y1={y(d.h)} y2={y(d.l)} />}
      <rect className="dcd-body" x={W * 0.23} y={flat ? H / 2 - 0.7 : bodyTop} width={W * 0.54} height={flat ? 1.4 : bodyH} />
    </svg>
  );
}
