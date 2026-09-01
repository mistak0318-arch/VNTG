import { quarterFinance, type QuarterRow } from "./quarterFinance.js";

/**
 * 조건 검색의 **필드 사전** (2026-09-01).
 *
 * ## 왜 신호등 이름을 그대로 못 쓰나
 *
 * 벤티지: "조건식 말이야. 너무 신호등 값을 그대로 가져왔네. (…) 덩치? 이건 뭐야.
 * 해석을 해야지 넌 AI 잖아. 정밀하고 디테일한 조건을 걸려고 조건검색 기능을 두는
 * 거야. 신호등에서 소스는 뽑아왔지만 이제 실제 조건검색에 사용할 수 있도록 만드는
 * 건 니 몫이지."
 *
 * 맞는 지적이다. 신호등의 이름은 **채점표의 항목 이름**이라 그 항목이 점수에서
 * 어떻게 쓰이는지를 담고 있다 — 「덩치 (클수록 안 움직인다)」·「고점 근접 (신고가와
 * 중복)」·「업종 강세 (쓰지 않음)」. 조건식에서는 뜻이 없거나 방해가 된다.
 *
 * 그리고 더 큰 문제: **값의 단위를 아무 데서도 말해 주지 않았다.** 「덩치 ≥ 3」이
 * 3억인지 3조인지 3점인지 화면만 봐서는 알 수 없다. 단위를 모르는 칸에는 값을
 * 넣을 수가 없다.
 *
 * 그래서 이 파일은 조건 검색만의 **이름 · 단위 · 뜻 · 쓸 만한 값**을 따로 갖는다.
 *
 * ## 조건 전용 필드
 *
 * 신호등에 없는 것도 넣는다. 벤티지: "영업이익 증가율 이런 거는 몇 분기 연속
 * 증가율 이런 게 옵션으로 있어야 할 텐데."
 *
 * 신호등의 `profitGrowth` 는 **연간** DART 다 — 8월에도 마지막 줄이 작년이라
 * 「지금 벌고 있나」를 못 본다. 분기(`quarterFinance`, 한투 8분기)로 연속 증가·
 * 흑자 전환 같은 것을 물을 수 있게 한다. **점수에는 안 쓴다** — 검증이 안 된
 * 것을 점수에 넣으면 신호등이 흔들린다. 조건식에서만 쓴다.
 */

/** 어느 묶음에 놓나 — 화면이 이걸로 목록을 나눈다 */
export type CondGroup = "가격·추세" | "수급" | "실적" | "규모" | "위험";

export type CondOp = "gte" | "lte" | "pass" | "fail";

export interface CondField {
  /** 신호등 `CheckKey`, 또는 `q` 로 시작하는 조건 전용 키 */
  key: string;
  /** **조건검색용 이름** — 신호등 라벨과 다르다 */
  label: string;
  group: CondGroup;
  /** 값의 단위. 빈 문자열이면 단위 없는 값(통과/미달 전용) */
  unit: string;
  /** 이 숫자가 뭘 뜻하나 — **예를 들어**까지 적는다 */
  hint: string;
  /** 쓸 수 있는 비교 */
  ops: CondOp[];
  /** 값 칸의 기본값 */
  def?: number;
  /** 빠른 선택 — 화면이 버튼으로 깐다 */
  presets?: { v: number; label: string }[];
  /** 조건 전용(신호등에 없음)인가 */
  own?: boolean;
  /**
   * 이 조건을 쓰면 종목당 조회가 얼마나 느나 — 화면이 미리 말해 준다.
   * 조건을 하나 더할 때 검색이 배로 느려지는 것을 사람이 모르면 안 된다.
   */
  cost?: string;
}

/* 자주 쓰는 값 묶음 — 같은 것을 여러 필드가 쓴다 */
const PCT = [
  { v: 0, label: "0%" },
  { v: 10, label: "10%" },
  { v: 20, label: "20%" },
  { v: 50, label: "50%" },
];
const EOK_FLOW = [
  { v: 1000, label: "10억" },
  { v: 5000, label: "50억" },
  { v: 10000, label: "100억" },
  { v: 50000, label: "500억" },
];

/**
 * 필드 사전.
 *
 * 순서가 화면 순서다. 자주 쓰는 것을 위로 둔다 — 「시가총액」·「신고가」·「수급
 * 지속」이 조건식의 첫 줄이 되는 일이 제일 많다.
 */
export const COND_FIELDS: CondField[] = [
  /* ── 규모 ─────────────────────────────────────────────────────── */
  {
    key: "marketCap",
    /* 신호등에서는 「덩치 (클수록 안 움직인다)」다 — 채점 방향을 이름에 담은 것이라 조건식에서는 뜻이 없다 */
    label: "시가총액",
    group: "규모",
    unit: "억원",
    hint: "상장주식수 × 현재가. 예를 들어 3000 이면 3천억, 100000 이면 10조입니다. 실측에서 3천억 이하 소형주가 장세와 무관하게 가장 좋았습니다(양쪽 승률 +7.6·+8.1%p).",
    ops: ["gte", "lte"],
    def: 3000,
    presets: [
      { v: 1000, label: "1천억" },
      { v: 3000, label: "3천억" },
      { v: 10000, label: "1조" },
      { v: 100000, label: "10조" },
    ],
    cost: "조회 없음 (스냅샷)",
  },
  {
    key: "volume",
    label: "당일 거래대금",
    group: "규모",
    unit: "억원",
    hint: "오늘(장 밖이면 마지막 거래일) 거래대금. 예를 들어 100 이면 100억입니다. 거래대금이 없으면 신호가 맞아도 못 삽니다.",
    ops: ["gte", "lte"],
    def: 100,
    presets: [
      { v: 50, label: "50억" },
      { v: 100, label: "100억" },
      { v: 500, label: "500억" },
      { v: 1000, label: "1천억" },
    ],
    cost: "조회 없음 (스냅샷)",
  },

  /* ── 가격·추세 ────────────────────────────────────────────────── */
  {
    key: "trend",
    label: "정배열 (현재가 > 단기선 > 장기선)",
    group: "가격·추세",
    unit: "",
    hint: "설정한 이동평균선이 짧은 것부터 순서대로 놓여 있나. 값이 아니라 상태라 통과/미달로만 물을 수 있습니다. 어느 선을 볼지는 「설정 > 신호등 기준」의 이동평균선을 따릅니다.",
    ops: ["pass", "fail"],
    cost: "일봉 1콜",
  },
  {
    key: "newHigh",
    label: "60일 최고가 대비 위치",
    group: "가격·추세",
    unit: "%",
    hint: "최근 60거래일 최고 종가를 100 으로 봤을 때 지금이 몇 %인가. 100 이면 신고가, 95 면 고점에서 5% 눌린 자리, 70 이면 고점 대비 30% 아래입니다. ⚠️ 신고가는 강세장에서만 통합니다(강세 승률 +1.4%p, 약세 −3.9%p).",
    ops: ["gte", "lte"],
    def: 99,
    presets: [
      { v: 100, label: "신고가" },
      { v: 97, label: "3% 이내" },
      { v: 90, label: "10% 이내" },
      { v: 70, label: "30% 아래" },
    ],
    cost: "일봉 1콜",
  },
  {
    key: "pullback",
    label: "눌림목 (고점에서 밀렸지만 20일선 위)",
    group: "가격·추세",
    unit: "",
    hint: "고점 대비 적당히 밀렸으면서 20일선은 안 깬 자리. 신고가와 배타적이라 둘을 AND 로 묶으면 아무것도 안 나옵니다 — OR 로 쓰거나 하나만 쓰세요.",
    ops: ["pass", "fail"],
    cost: "일봉 1콜",
  },
  {
    key: "etfBacking",
    label: "ETF 뒷배 등락률",
    group: "가격·추세",
    unit: "%",
    hint: "이 종목을 가장 많이 담은 ETF 셋의 그날 등락률 평균. 1.5 면 관련 ETF 가 평균 1.5% 올랐다는 뜻입니다. ⚠️ ETF 구성이 오늘 것이라 과거 검증에는 look-ahead 가 남아 있습니다.",
    ops: ["gte", "lte"],
    def: 1,
    presets: [
      { v: 0, label: "플러스" },
      { v: 1, label: "1%" },
      { v: 2, label: "2%" },
    ],
    cost: "조회 없음 (일봉 캐시)",
  },
  {
    key: "naverTheme",
    label: "테마 강세 (가중 등락률)",
    group: "가격·추세",
    unit: "%",
    hint: "이 종목이 속한 가장 강한 테마의 가중 등락률 — 0.5×오늘 + 0.3×(5일 평균) + 0.2×(20일 평균). 하루치만 보면 그날 튄 것에 속아서 이렇게 섞습니다.",
    ops: ["gte", "lte"],
    def: 1,
    presets: [
      { v: 0, label: "플러스" },
      { v: 1, label: "1%" },
      { v: 2, label: "2%" },
    ],
    cost: "조회 없음 (테마 캐시)",
  },

  /* ── 수급 ─────────────────────────────────────────────────────── */
  {
    key: "flowPersist",
    label: "순매수 유지 구간 수",
    group: "수급",
    unit: "구간",
    hint: "외국인·기관 각각의 5·10·20·60일 순매수 합계 여덟 칸 중 **플러스인 칸이 몇 개**인가. 8 이면 둘 다 모든 기간에서 사고 있다는 뜻입니다. 연속 순매수보다 이게 낫습니다 — 퐁당퐁당 장에서는 연속이 잘 끊깁니다. 장세를 안 가리고 통하는 몇 안 되는 기준입니다.",
    ops: ["gte", "lte"],
    def: 5,
    presets: [
      { v: 4, label: "절반" },
      { v: 6, label: "6칸" },
      { v: 8, label: "전부" },
    ],
    cost: "수급 1콜",
  },
  {
    key: "flowAccel",
    label: "수급 가속 배수",
    group: "수급",
    unit: "배",
    hint: "단기 순매수 일평균 ÷ 장기 순매수 일평균. 2 면 최근에 두 배 속도로 사고 있다는 뜻입니다. 1 미만이면 식는 중입니다.",
    ops: ["gte", "lte"],
    def: 1.5,
    presets: [
      { v: 1, label: "유지" },
      { v: 1.5, label: "1.5배" },
      { v: 2.5, label: "2.5배" },
    ],
    cost: "수급 1콜 (지속과 같은 응답)",
  },
  {
    key: "smartMoney",
    label: "주포 순매수 (투신+연기금+사모, 20일)",
    group: "수급",
    unit: "백만원",
    hint: "기관계 전체가 아니라 이 셋만 봅니다 — 기관계는 금융투자의 헤지 물량에 방향이 상쇄되지만 이 셋은 방향입니다. 2000 이면 20억입니다.",
    ops: ["gte", "lte"],
    def: 0,
    presets: EOK_FLOW,
    cost: "수급 1콜 (지속과 같은 응답)",
  },
  {
    key: "flowRatio",
    label: "순매수 / 시가총액",
    group: "수급",
    unit: "%",
    hint: "20일 순매수 금액이 시가총액의 몇 %인가. 절대금액과 달리 **대형주에 안 유리합니다** — 삼성전자 100억과 소형주 100억은 뜻이 다릅니다. 0.75 면 시총의 0.75% 가 들어왔다는 뜻입니다. 약세장에서 특히 잘 통합니다.",
    ops: ["gte", "lte"],
    def: 0.25,
    presets: [
      { v: 0.25, label: "0.25%" },
      { v: 0.5, label: "0.5%" },
      { v: 1, label: "1%" },
    ],
    cost: "수급 1콜 + 시총(스냅샷)",
  },
  {
    key: "foreignFlow",
    label: "외국인 순매수 (설정 기간)",
    group: "수급",
    unit: "백만원",
    hint: "「설정 > 신호등 기준」의 수급 기간(현재 10일)만큼 합산한 금액. 1000 이면 10억입니다. 절대금액이라 대형주에 유리한 약점이 있습니다 — 그게 싫으면 「순매수 / 시가총액」을 쓰세요.",
    ops: ["gte", "lte"],
    def: 1000,
    presets: EOK_FLOW,
    cost: "수급 1콜",
  },
  {
    key: "instFlow",
    label: "기관 순매수 (설정 기간)",
    group: "수급",
    unit: "백만원",
    hint: "기관계 합산. 금융투자(증권사 헤지)가 섞여 방향이 상쇄될 수 있습니다 — 방향을 보려면 「주포 순매수」가 낫습니다.",
    ops: ["gte", "lte"],
    def: 1000,
    presets: EOK_FLOW,
    cost: "수급 1콜",
  },
  {
    key: "foreignRatioUp",
    label: "외국인 지분율 20일 변화",
    group: "수급",
    unit: "%p",
    hint: "20거래일 전과 견준 지분율 차이. 1 이면 지분율이 1%포인트 올랐다는 뜻입니다(예: 12.0% → 13.0%). 금액과 달리 **주식 수 기준**이라 주가가 올라서 커 보이는 착시가 없습니다.",
    ops: ["gte", "lte"],
    def: 0.1,
    presets: [
      { v: 0, label: "안 줄었다" },
      { v: 0.5, label: "0.5%p" },
      { v: 1, label: "1%p" },
    ],
    cost: "지분율 1콜",
  },
  {
    key: "programFlow",
    label: "프로그램 순매수 (20일)",
    group: "수급",
    unit: "억원",
    hint: "20거래일 프로그램 매매 순매수 합계. 500 이면 500억입니다. 지수 편입·패시브 자금의 흔적을 봅니다.",
    ops: ["gte", "lte"],
    def: 50,
    presets: [
      { v: 0, label: "플러스" },
      { v: 50, label: "50억" },
      { v: 500, label: "500억" },
    ],
    cost: "프로그램 1콜",
  },

  /* ── 실적 ─────────────────────────────────────────────────────── */
  {
    key: "qProfitStreak",
    label: "영업이익 연속 증가 분기 수",
    group: "실적",
    unit: "분기",
    own: true,
    hint: "직전 분기보다 영업이익이 늘어난 것이 **연속 몇 분기**인가. 2 면 최근 두 분기 연속으로 늘었다는 뜻입니다(최대 7). ⚠️ 한투 분기 데이터는 연단위 누적으로 오므로 직전 분기를 빼서 단일 분기로 되돌린 값을 씁니다 — 그렇게 안 하면 실적이 반토막 난 회사도 계속 우상향으로 보입니다.",
    ops: ["gte", "lte"],
    def: 2,
    presets: [
      { v: 1, label: "1분기" },
      { v: 2, label: "2분기" },
      { v: 4, label: "1년" },
    ],
    cost: "분기실적 1콜 (6시간 캐시)",
  },
  {
    key: "qProfitYoY",
    label: "최근 분기 영업이익 (전년 동기 대비)",
    group: "실적",
    unit: "%",
    own: true,
    hint: "가장 최근 분기를 1년 전 같은 분기와 견준 증감률. 계절성이 있는 업종은 직전 분기(QoQ)보다 이게 맞습니다. 20 이면 작년 같은 분기보다 20% 늘었다는 뜻입니다.",
    ops: ["gte", "lte"],
    def: 0,
    presets: PCT,
    cost: "분기실적 1콜 (연속 증가와 같은 응답)",
  },
  {
    key: "qProfitQoQ",
    label: "최근 분기 영업이익 (직전 분기 대비)",
    group: "실적",
    unit: "%",
    own: true,
    hint: "가장 최근 분기를 바로 앞 분기와 견준 증감률. 방향이 바뀌는 순간을 가장 빨리 보여 주지만 계절성에 흔들립니다.",
    ops: ["gte", "lte"],
    def: 0,
    presets: PCT,
    cost: "분기실적 1콜 (연속 증가와 같은 응답)",
  },
  {
    key: "qMargin",
    label: "최근 분기 영업이익률",
    group: "실적",
    unit: "%",
    own: true,
    hint: "영업이익 ÷ 매출액. 10 이면 100원 팔아 10원 남겼다는 뜻입니다. 음수면 적자 분기입니다.",
    ops: ["gte", "lte"],
    def: 5,
    presets: [
      { v: 0, label: "흑자" },
      { v: 5, label: "5%" },
      { v: 10, label: "10%" },
      { v: 20, label: "20%" },
    ],
    cost: "분기실적 1콜 (연속 증가와 같은 응답)",
  },
  {
    key: "qTurnaround",
    label: "흑자 전환 (직전 적자 → 최근 흑자)",
    group: "실적",
    unit: "",
    own: true,
    hint: "바로 앞 분기가 영업적자였는데 최근 분기가 흑자인가. 값이 아니라 상태라 통과/미달로만 물을 수 있습니다.",
    ops: ["pass", "fail"],
    cost: "분기실적 1콜 (연속 증가와 같은 응답)",
  },
  {
    key: "profitGrowth",
    label: "영업이익 증가율 (연간·DART)",
    group: "실적",
    unit: "%",
    hint: "⚠️ **연간**입니다 — 사업보고서 기준이라 8월에도 마지막 줄이 작년입니다. 「지금 벌고 있나」를 보려면 위의 분기 항목을 쓰세요. 그리고 실측에서 이 값은 **약세장에서만** 통했습니다(강세장에서는 오히려 마이너스).",
    ops: ["gte", "lte"],
    def: 0,
    presets: PCT,
    cost: "DART 1콜 (캐시)",
  },
  {
    key: "roe",
    label: "ROE (자기자본이익률)",
    group: "실적",
    unit: "%",
    hint: "자기자본으로 얼마를 벌었나. 15 면 자본 100원으로 15원 벌었다는 뜻입니다.",
    ops: ["gte", "lte"],
    def: 8,
    presets: [
      { v: 8, label: "8%" },
      { v: 15, label: "15%" },
      { v: 20, label: "20%" },
    ],
    cost: "DART 1콜 (캐시)",
  },
  {
    key: "targetUpside",
    label: "증권사 목표가 대비 상승여력",
    group: "실적",
    unit: "%",
    hint: "(목표주가 − 현재가) ÷ 현재가. 30 이면 목표가가 현재가보다 30% 위라는 뜻입니다. ⚠️ 한투가 최근 것만 주므로 커버리지가 낮고 검증이 막혀 있습니다.",
    ops: ["gte", "lte"],
    def: 10,
    presets: [
      { v: 0, label: "목표가 아래" },
      { v: 10, label: "10%" },
      { v: 30, label: "30%" },
    ],
    cost: "목표가 1콜",
  },
  {
    key: "targetTrend",
    label: "목표가 눈높이 상향",
    group: "실적",
    unit: "%",
    hint: "증권사 목표주가가 최근에 얼마나 올랐나. 값 자체보다 **방향**을 봅니다 — 0 이상이면 눈높이가 안 내려갔다는 뜻입니다.",
    ops: ["gte", "lte"],
    def: 0,
    presets: [
      { v: 0, label: "안 내려갔다" },
      { v: 5, label: "5%" },
    ],
    cost: "목표가 1콜 (상승여력과 같은 응답)",
  },

  /* ── 위험 ─────────────────────────────────────────────────────── */
  {
    key: "overhead",
    label: "위쪽 매물 부담",
    group: "위험",
    unit: "%",
    hint: "최근 120일 거래 중 **지금 가격보다 위에서** 거래된 몫. 65 면 위에 물린 사람이 65% 라 오를 때마다 팔 물량이 나온다는 뜻이고, 신고가면 0 에 가깝습니다. **낮을수록 좋습니다** — `≤` 로 거세요.",
    ops: ["lte", "gte"],
    def: 40,
    presets: [
      { v: 20, label: "20%" },
      { v: 40, label: "40%" },
      { v: 65, label: "65%" },
    ],
    cost: "일봉 1콜",
  },
  {
    key: "disparity",
    label: "20일선 이격도",
    group: "위험",
    unit: "%",
    hint: "20일 이동평균선에서 위로 얼마나 떨어져 있나. 25 면 20일선보다 25% 위라 되돌림이 나올 자리입니다. **낮을수록 안전합니다.**",
    ops: ["lte", "gte"],
    def: 15,
    presets: [
      { v: 10, label: "10%" },
      { v: 15, label: "15%" },
      { v: 25, label: "25%" },
    ],
    cost: "일봉 1콜",
  },
  {
    key: "ma5Gap",
    label: "5일선 이격",
    group: "위험",
    unit: "%",
    hint: "5일선에서 위로 얼마나 떨어져 있나. 20일선보다 훨씬 예민해서 단기 과열을 봅니다. **낮을수록 안전합니다.**",
    ops: ["lte", "gte"],
    def: 6,
    presets: [
      { v: 3, label: "3%" },
      { v: 6, label: "6%" },
      { v: 12, label: "12%" },
    ],
    cost: "일봉 1콜",
  },
  {
    key: "shortSaleUp",
    label: "공매도 비중 (추이 포함)",
    group: "위험",
    unit: "%p",
    hint: "최근 공매도 비중에서 그 추이를 더한 값. 0 이면 평소 수준, 5 면 늘고 있다는 뜻입니다. **낮을수록 안전합니다.**",
    ops: ["lte", "gte"],
    def: 0,
    presets: [
      { v: 0, label: "안 늘었다" },
      { v: 5, label: "5%p" },
    ],
    cost: "공매도 1콜",
  },
  {
    key: "lendingUp",
    label: "대차잔고 20일 증감률",
    group: "위험",
    unit: "%",
    hint: "빌려 간 주식이 20일 전보다 얼마나 늘었나. **음수면 갚는 중(숏커버)이라 오히려 좋습니다** — −10 처럼 음수로 걸 수 있습니다. ⚠️ 표본 커버리지가 16% 라 검증이 막혀 있습니다.",
    ops: ["lte", "gte"],
    def: 0,
    presets: [
      { v: -10, label: "10% 갚음" },
      { v: 0, label: "안 늘었다" },
      { v: 15, label: "15% 늘었다" },
    ],
    cost: "대차 1콜",
  },
  {
    key: "debtRatio",
    label: "부채비율",
    group: "위험",
    unit: "%",
    hint: "부채 ÷ 자기자본. 150 이면 자본의 1.5배를 빌렸다는 뜻입니다. **낮을수록 안전합니다.**",
    ops: ["lte", "gte"],
    def: 150,
    presets: [
      { v: 100, label: "100%" },
      { v: 150, label: "150%" },
      { v: 250, label: "250%" },
    ],
    cost: "DART 1콜 (캐시)",
  },
];

const BY_KEY = new Map(COND_FIELDS.map((f) => [f.key, f]));

export function condField(key: string): CondField | undefined {
  return BY_KEY.get(key);
}

/** 조건 전용 키인가 — 그렇다면 신호등이 아니라 여기서 값을 낸다 */
export function isOwnField(key: string): boolean {
  return BY_KEY.get(key)?.own === true;
}

/* ------------------------------------------------------------------ */
/* 조건 전용 필드의 값 — 분기 실적                                       */
/* ------------------------------------------------------------------ */

export interface OwnValues {
  /** 각 키의 잰 값. 못 잰 것은 담지 않는다 — **null 을 0 으로 만들지 않는다** */
  num: Map<string, number>;
  /** 통과/미달로만 묻는 것 */
  flag: Map<string, boolean>;
}

/**
 * 영업이익이 **연속 몇 분기** 늘었나.
 *
 * `quarterFinance` 는 최근이 앞이다. 앞에서부터 「이 분기 > 다음(=이전) 분기」가
 * 깨질 때까지 센다.
 *
 * ⚠️ **적자에서 덜 적자로**도 증가로 센다(−50억 → −10억). 그것도 방향은 개선이
 * 맞고, 「적자를 빼겠다」면 영업이익률 조건을 AND 로 걸면 된다. 여기서 몰래
 * 걸러 버리면 사람이 왜 안 걸렸는지 알 수 없다.
 */
function profitStreak(rows: QuarterRow[]): number | null {
  const vals = rows.map((r) => r.operatingProfit).filter((v): v is number => v !== null);
  if (vals.length < 2) return null;
  let n = 0;
  for (let i = 0; i < vals.length - 1; i++) {
    if (vals[i] > vals[i + 1]) n += 1;
    else break;
  }
  return n;
}

/**
 * 조건에 쓰인 **조건 전용 필드**만 잰다.
 *
 * 분기 실적은 한투 1콜이고 6시간 캐시라, 조건식에 하나라도 있으면 한 번 부르고
 * 그 응답으로 다섯 필드를 다 낸다. 안 쓰면 **아예 안 부른다.**
 */
export async function ownValues(code: string, keys: Set<string>): Promise<OwnValues> {
  const num = new Map<string, number>();
  const flag = new Map<string, boolean>();

  const wantsQuarter = [...keys].some((k) => k.startsWith("q"));
  if (!wantsQuarter) return { num, flag };

  const rows = await quarterFinance(code, 8).catch(() => [] as QuarterRow[]);
  if (rows.length === 0) return { num, flag };

  const streak = profitStreak(rows);
  if (streak !== null) num.set("qProfitStreak", streak);

  const last = rows[0];
  if (last.yoy !== null) num.set("qProfitYoY", last.yoy);
  if (last.qoq !== null) num.set("qProfitQoQ", last.qoq);
  if (last.margin !== null) num.set("qMargin", last.margin);

  /* 흑자 전환 — 직전이 적자, 최근이 흑자. 둘 다 있어야 판정한다 */
  const prev = rows[1];
  if (last.operatingProfit !== null && prev?.operatingProfit !== null && prev !== undefined) {
    flag.set("qTurnaround", prev.operatingProfit! < 0 && last.operatingProfit > 0);
  }

  return { num, flag };
}
