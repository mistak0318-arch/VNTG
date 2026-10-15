/**
 * **표 한 줄짜리 장중 선** (2026-10-15 — 벤티지: "시세분석 리스트에서 봉 옆에 미니스파크,
 * 장중 흐름 그거 붙일 수 있겠어?").
 *
 * 옆의 봉(`MiniCandle`)은 시·고·저·종 **네 숫자**라 「오늘 어디까지 갔나」는 말해 주지만
 * **순서를 못 말한다.** 아침에 밀렸다 오후에 회복한 날과 아침에 올랐다 오후에 꺾인 날이
 * 똑같은 봉으로 그려진다. 그 둘은 전혀 다른 날이다 — 선이 그걸 가른다.
 *
 * ## 기준선 위냐 아래냐
 *
 * 전일 종가를 점선으로 깔고 그 위·아래를 색으로 가른다. 48×18 픽셀에서 읽을 수 있는
 * 것은 그 한 가지뿐이라, 눈금도 숫자도 넣지 않는다 — 자세한 것은 종목을 누르면 나온다.
 *
 * ## ⚠️ 없는 줄은 비운다
 *
 * 선은 서버가 체결(`0B`)로 쌓아 둔 종목에만 있다(거래대금 상위·관심종목 ~190). 목록
 * 100줄 중 안 쌓인 종목은 **빈칸**이다 — 한 점만 찍어 「움직이지 않았다」처럼 보이게
 * 하는 것보다 낫다.
 */
export function MiniSpark({ line, base }: { line: number[] | undefined; base: number | null }) {
  if (!line || line.length < 2) return null;
  const W = 48;
  const H = 18;
  const lo = Math.min(...line, base && base > 0 ? base : Infinity);
  const hi = Math.max(...line, base && base > 0 ? base : -Infinity);
  const range = hi - lo || 1;
  const y = (v: number) => H - ((v - lo) / range) * H;
  const d = line.map((v, i) => `${((i / (line.length - 1)) * W).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = line[line.length - 1];
  const up = base && base > 0 ? last >= base : last >= line[0];
  return (
    <svg className="msp" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="장중 흐름">
      {base != null && base > 0 && <line x1="0" x2={W} y1={y(base)} y2={y(base)} className="msp-base" />}
      <polyline points={d} className={`msp-line ${up ? "up" : "down"}`} />
    </svg>
  );
}
