import { useEffect, useState } from "react";
import { api } from "../../api";

/**
 * 미국 지수·원자재의 **하루치 선**.
 *
 * ## 왜 넣었나
 *
 * 전광판 상자가 숫자 두 줄(현재가·등락률)뿐이라 **자리를 많이 먹으면서 정보는 적었다.**
 * 「나스닥 −0.12%」는 그 자체로 아무 말도 안 한다 — 하루 종일 흘러내린 −0.12% 와
 * 크게 빠졌다 되돌린 −0.12% 는 완전히 다른 밤이다.
 *
 * 국내 지수 카드가 이미 스파크라인을 쓰고 있어서 **같은 방식**으로 맞췄다.
 * 새 API 는 없다 — `yahooChart(symbol, "1d")` 가 5분봉 79개를 준다.
 *
 * ## 전일 종가를 기준선으로 깐다
 *
 * 선만 있으면 **어디가 0인지** 모른다. 점선 하나로 「오늘 위에 있었나 아래였나」가 보인다.
 */

const W = 100;
const H = 28;

export function UsSpark({ symbol }: { symbol: string }) {
  const [pts, setPts] = useState<number[] | null>(null);
  const [base, setBase] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .yahooChart(symbol, "1d")
      .then((r) => {
        if (!alive) return;
        setPts(r.candles.map((c) => c.close));
        setBase(r.prevClose);
      })
      .catch(() => {
        if (alive) setPts([]);
      });
    return () => {
      alive = false;
    };
  }, [symbol]);

  if (!pts || pts.length < 2) return <div className="usp-empty" />;

  // 기준선이 화면 밖으로 나가지 않게 범위에 넣는다
  const vals = base === null ? pts : [...pts, base];
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const range = hi - lo || 1;
  const x = (i: number) => (i / (pts.length - 1)) * W;
  const y = (v: number) => H - ((v - lo) / range) * H;

  const line = pts.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const up = base === null ? pts[pts.length - 1] >= pts[0] : pts[pts.length - 1] >= base;

  return (
    <svg className="usp" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img">
      {base !== null && (
        <line className="usp-base" x1={0} x2={W} y1={y(base)} y2={y(base)} />
      )}
      <path className={`usp-line ${up ? "up" : "down"}`} d={line} />
    </svg>
  );
}
