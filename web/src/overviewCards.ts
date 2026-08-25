/**
 * 시황 대시보드에 어떤 카드가 있나.
 *
 * **여기가 유일한 목록이다.** 예전엔 대시보드 안에 키 배열이 박혀 있었는데, 배치 설정을
 * 설정 화면으로 옮기면서 두 곳이 같은 목록을 각자 들고 있게 됐다. 그러면 카드를 하나
 * 더 만들었을 때 한쪽만 고치고 넘어가기 십상이다 — 설정에는 안 뜨는 카드가 생긴다.
 *
 * **여기 적힌 순서가 기본 배치다.** 저장된 배치가 없으면 이 차례로 나온다.
 * 카드를 새로 만들면 이 배열에도 넣어야 화면에 뜬다.
 */

export type OverviewSub = "summary" | "flow" | "rank";

export interface CardDef {
  key: string;
  /** 설정 화면에 보일 이름 — 카드 제목과 같아야 헷갈리지 않는다 */
  label: string;
}

export const OVERVIEW_CARDS: Record<OverviewSub, CardDef[]> = {
  summary: [
    { key: "indices", label: "국내 지수" },
    { key: "updown", label: "종목등락현황" },
    /* 폭(몇 종목이 올랐나) 다음 물음이 유동성(돈이 얼마나 돌았나)이다 */
    { key: "turnover", label: "거래대금 현황" },
    { key: "global", label: "글로벌" },
    /* 미장 주요지수 카드는 숨김 (2026-08-25) — 야간선물·VIX·유가는 글로벌로 옮겼다 */
    { key: "rates", label: "금리" },
    { key: "breadth", label: "시장 폭 추이" },
    { key: "sectors", label: "업종" },
  ],
  flow: [{ key: "flow", label: "투자자별 수급" }],
  rank: [
    { key: "topTraders", label: "수익률 상위 고객 매매동향" },
    { key: "movers", label: "등락률 순위" },
    { key: "themes", label: "테마" },
    { key: "highLow", label: "250일 신고가 / 신저가" },
    { key: "vi", label: "변동성 완화 (VI)" },
  ],
};
