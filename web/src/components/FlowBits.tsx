/**
 * 자금흐름 표의 공통 조각 (2026-10-12).
 *
 * 벤티지: "여기 메뉴 눈에 좀 띄게 UI 개편 좀 해보자. 색깔도 다 흰색이고 하니 눈에
 * 들어오는 게 없네" · "ETF랑 똑같은 구조로 해서 네이버 테마로도 구성해보자고"
 *
 * 테마 판과 ETF 판이 **같은 잣대로 보여야** 나란히 둔 뜻이 산다. 셈이 같아도 그리는 법이
 * 다르면 사람은 다른 것으로 읽는다 — 칸을 만드는 조각을 한곳에 두고 둘이 같이 쓴다.
 */

export function pct(v: number | null): string {
  return v === null ? "-" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
}

export function cls(v: number | null): string {
  return v === null || v === 0 ? "" : v > 0 ? "positive" : "negative";
}

export function eok(v: number | null): string {
  return v === null ? "-" : `${v.toLocaleString("ko-KR")}억`;
}

/**
 * **배수 칸** — 이 화면의 본론이다.
 *
 * 숫자만 적어 두면 「1.48」과 「0.62」가 같은 무게로 보인다. 이 표를 보는 까닭이
 * 「어디에 돈이 몰렸나」이므로 그 답이 **읽지 않아도 보여야** 한다.
 *
 * 1.0 이 제자리다. 그보다 크면 전보다 돈이 몰린 것이고, 1.5 를 넘으면 이 화면이 말하는
 * 「몰리는 중」이다. 막대는 0~3배를 폭으로 펴고 **1.0 자리에 눈금**을 둔다 — 기준선이
 * 없으면 길이가 무슨 뜻인지 알 수 없다.
 */
export function MultCell({ v }: { v: number | null }) {
  if (v === null) return <span className="fl-mult-na">-</span>;
  const lvl = v >= 2 ? "hot" : v >= 1.5 ? "warm" : v >= 1 ? "" : "cold";
  return (
    <span className={`fl-mult ${lvl}`} title={`최근 5일 평균 거래대금이 그 앞 20일 평균의 ${v.toFixed(2)}배`}>
      <i className="fl-mult-bar" style={{ width: `${Math.min(100, (v / 3) * 100)}%` }} />
      <u className="fl-mult-tick" />
      <b>{v.toFixed(2)}배</b>
    </span>
  );
}

/**
 * **오늘 거래대금** — 5일 평균과 견줘 색을 준다.
 *
 * 숫자 둘을 나란히 적어 놓고 사람에게 나눗셈을 시키던 칸이다. 오늘이 평균보다 눈에 띄게
 * 크면 그게 「지금 들어오는 중」이라는 뜻이고, 그 판단이 이 표에서 제일 빠른 신호다.
 */
export function TodayCell({ today, avg5 }: { today: number; avg5: number | null }) {
  const r = avg5 && avg5 > 0 ? today / avg5 : null;
  const k = r === null ? "" : r >= 1.3 ? "positive" : r <= 0.6 ? "fl-cold" : "";
  return (
    <span className={k} title={r === null ? undefined : `5일 평균의 ${r.toFixed(1)}배`}>
      {eok(today)}
    </span>
  );
}
