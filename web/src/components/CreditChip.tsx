import { useEffect, useState } from "react";
import { api } from "../api";

/**
 * **이 종목을 신용으로 살 수 있나** — 종목명 옆의 작은 칩 (2026-09-08).
 *
 * 벤티지: "종목상세에 종목명 앞에 코스피 써놨잖아 그 옆에 주문메뉴처럼 신용 관련 아이콘도
 * 하나 넣어줄래?" → 그 다음 "종목 클릭하고 나오는 창에는 안 뜨는구나."
 *
 * 두 번째 말이 이 파일이 있는 이유다. 개별종목분석 페이지에만 넣었더니 **클릭 시트**에는
 * 없었다. 이 프로젝트가 반복해서 겪은 자리다 — 화면마다 따로 짜면 어디는 되고 어디는 안 된다.
 * 그래서 값 가져오는 것(`useStockCredit`)과 그리는 것(`CreditChip`)을 여기 하나로 둔다.
 * 새로 붙일 화면은 두 줄이면 된다.
 *
 * ## 세 가지 상태
 *
 *   · **신용E** — 가능. 군(A~E)은 증거금률이 다르다
 *   · **신용불가** — 이 종목은 신용융자 대상이 아니다
 *   · **신용 ?** — **못 읽었다.** 「불가」와 다르다. 조용히 지우면 왜 안 나오는지 알 길이
 *     없어서(벤티지 "신용정보는 안 읽는데?") 이유를 들고 있다가 누르면 편다
 *
 * 서버가 한 시간 캐시라 종목을 옮겨 다녀도 조회가 늘지 않는다. 주문 앱키가 없는 설치에서는
 * `allowed: null` + 이유로 와서 「신용 ?」 만 뜬다.
 */
export interface StockCredit {
  allowed: boolean | null;
  grade: string | null;
  text: string | null;
  why?: string | null;
}

export function useStockCredit(code: string | null | undefined): StockCredit | null {
  const [credit, setCredit] = useState<StockCredit | null>(null);
  useEffect(() => {
    setCredit(null);
    if (!code) return;
    let alive = true;
    void api
      .stockCredit(code)
      .then((c) => alive && setCredit(c))
      /* 길 자체가 막힌 것(옛 서버·401)도 「못 읽었다」로 — 조용히 사라지면 원인을 못 찾는다 */
      .catch((e) => alive && setCredit({ allowed: null, grade: null, text: null, why: e instanceof Error ? e.message : "조회 실패" }));
    return () => {
      alive = false;
    };
  }, [code]);
  return credit;
}

export function CreditChip({ credit }: { credit: StockCredit | null }) {
  if (!credit) return null;
  if (credit.allowed === null) {
    if (!credit.why) return null;
    return (
      <em
        className="ord-crd dim"
        title={credit.why}
        onClick={(e) => {
          e.stopPropagation();
          window.alert(`신용가능여부를 못 읽었다\n\n${credit.why}`);
        }}
      >
        신용 ?
      </em>
    );
  }
  return (
    <em className={`ord-crd${credit.allowed ? " ok" : " no"}`} title={credit.text ?? (credit.allowed ? "신용 가능" : "신용 불가")}>
      {credit.allowed ? `신용${credit.grade ?? ""}` : "신용불가"}
    </em>
  );
}
