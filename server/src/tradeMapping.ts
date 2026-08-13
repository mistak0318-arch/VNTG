/**
 * 수출입 품목 ↔ 키움 업종 매핑.
 *
 * 수출 데이터가 시장 지표로 쓸모 있으려면 "반도체 수출 +12%"가
 * **어느 업종 종목에 해당하는지** 이어져야 한다. 그 다리가 이 표다.
 *
 * 두 갈래로 들어온다:
 *   1) 10일 단위 잠정치 API — 품목명이 한글로 온다 (반도체, 승용차 …). 이름으로 매핑.
 *   2) 품목별 수출입실적 API — HS코드로 온다. 2자리(류) 기준으로 매핑.
 *
 * ⚠ **이 표는 초안이다.** 실제 API 응답을 받아본 뒤 품목명·코드를 맞춰야 한다.
 * 특히 10일 단위 쪽 품목명은 API가 주는 문자열과 정확히 일치해야 하므로,
 * `scripts/trade-probe.mjs` 결과를 보고 고칠 것.
 *
 * 업종명은 키움 ka20003(업종별지수) 기준이며, `sectorMood.ts` 의
 * `normalizeSectorName` 과 같은 방식으로 비교한다.
 */

export interface TradeSector {
  /** 10일 단위 API가 주는 품목명 (부분 일치로 찾는다) */
  itemNames: string[];
  /** HS코드 2자리(류). 품목별 API용 */
  hsChapters: string[];
  /** 대응하는 키움 업종명 */
  sectors: string[];
  /** 이 품목이 왜 그 업종의 선행 지표인지 — 리포트에 근거로 쓴다 */
  note: string;
}

export const TRADE_SECTORS: TradeSector[] = [
  {
    itemNames: ["반도체"],
    hsChapters: ["85"], // 전기기기·전자
    sectors: ["전기전자", "반도체"],
    note: "국내 수출의 최대 비중. 메모리 가격과 함께 움직여 전기전자 업종 실적을 선행",
  },
  {
    itemNames: ["반도체 제조용 장비", "반도체장비"],
    hsChapters: ["84"], // 기계류
    sectors: ["기계", "전기전자"],
    note: "장비 수입은 향후 증설을 뜻해 반도체 소부장 실적을 선행",
  },
  {
    itemNames: ["승용차", "자동차"],
    hsChapters: ["87"],
    sectors: ["운수장비", "자동차"],
    note: "완성차 수출 물량이 곧 매출. 환율과 함께 보면 마진까지 읽힌다",
  },
  {
    itemNames: ["석유제품"],
    hsChapters: ["27"],
    sectors: ["화학", "석유화학"],
    note: "정제마진의 선행 지표. 원유 수입 단가와 같이 봐야 의미가 있다",
  },
  {
    itemNames: ["원유"],
    hsChapters: ["27"],
    sectors: ["화학", "운수창고"],
    note: "수입 단가 상승은 정유·화학 원가 부담이자 항공·해운 연료비 부담",
  },
  {
    itemNames: ["무선통신기기"],
    hsChapters: ["85"],
    sectors: ["전기전자", "통신업"],
    note: "휴대폰·부품 수출. 세트 업체 물량 흐름",
  },
  {
    itemNames: ["정밀기기"],
    hsChapters: ["90"],
    sectors: ["의료정밀", "전기전자"],
    note: "계측·광학기기. 설비투자 사이클과 연동",
  },
  {
    itemNames: ["가스", "천연가스"],
    hsChapters: ["27"],
    sectors: ["전기가스업"],
    note: "발전 연료비. 도입 단가가 유틸리티 마진을 좌우",
  },
  {
    itemNames: ["석탄"],
    hsChapters: ["27"],
    sectors: ["전기가스업", "철강금속"],
    note: "발전용·제철용. 원료탄은 철강 원가에 직결",
  },
  {
    itemNames: ["기계류"],
    hsChapters: ["84"],
    sectors: ["기계"],
    note: "설비투자 대리 지표",
  },
];

/** 10일 단위 API의 품목명으로 대응 업종을 찾는다 */
export function sectorsForItem(itemName: string): TradeSector | null {
  const n = itemName.replace(/\s+/g, "");
  return (
    TRADE_SECTORS.find((t) => t.itemNames.some((i) => n.includes(i.replace(/\s+/g, "")))) ?? null
  );
}

/** HS코드(앞 2자리)로 대응 업종을 찾는다 */
export function sectorsForHs(hsCode: string): TradeSector[] {
  const ch = hsCode.slice(0, 2);
  return TRADE_SECTORS.filter((t) => t.hsChapters.includes(ch));
}

/** 어떤 업종이 수출 지표를 가지는지 (신호등 항목 후보) */
export function tradeCoveredSectors(): string[] {
  return [...new Set(TRADE_SECTORS.flatMap((t) => t.sectors))];
}
