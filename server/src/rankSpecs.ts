/**
 * 시세분석 — 키움 순위 조회 레지스트리.
 *
 * 키움 HTS의 [0194] 순위분석에는 수십 개 목록이 있는데, 그때마다 라우트와 화면을
 * 따로 만들면 같은 코드를 계속 복사하게 된다. 그래서 **표 하나를 만들고 명세만 늘린다.**
 * 새 순위를 넣는 일 = 이 배열에 항목 하나 추가.
 *
 * 컬럼은 문서가 아니라 **실제 응답을 찍어보고** 정했다 (scripts/rank-fields.mjs).
 * 문서에 있는 필드가 빈 값으로 오는 경우가 있어서 값까지 확인해야 화면에 빈 칸이 안 생긴다.
 */

/*
 * `signed` (2026-08-25) — **부호가 정보인 숫자**(순매수·대비)만 색을 입힌다.
 * 예전엔 `num` 전부를 부호로 칠해서 거래대금·거래량·순위까지 죄다 빨갰다 —
 * 표가 온통 빨가니 정작 등락률이 안 보였다. 이제 `num` 은 무색이다.
 */
export type ColType = "text" | "price" | "num" | "pct" | "signed";

export interface RankColumn {
  key: string;
  label: string;
  type?: ColType;
  /**
   * 응답에서 읽을 이름이 `key` 와 다를 때 (2026-09-09).
   *
   * 조회순위(`ka00198`)는 현재가를 `past_curr_prc`, 등락률을 `base_comp_chgr` 로 준다.
   * 화면은 `cur_prc`·`flu_rt` 라는 이름으로 실시간을 덧씌우고 색을 칠하므로, 응답 이름을
   * 그대로 흘리면 그 줄만 실시간 점이 안 붙는다. 여기서 이름을 맞춘다.
   */
  src?: string;
}

export interface RankSpec {
  /** 주소에 쓰는 식별자 */
  key: string;
  label: string;
  /** 화면 왼쪽 트리의 묶음 */
  group: string;
  uri: "rkinfo" | "stkinfo";
  apiId: string;
  /** 응답에서 배열이 담겨 오는 키 */
  listKey: string;
  /** 이 조회에만 필요한 고정 파라미터 */
  params?: Record<string, string>;
  /**
   * 거래소(stex_tp)를 고를 수 있는가.
   *
   * 키움은 1=KRX / 2=NXT / 3=통합인데, 실측해 보면 **통합이 KRX와 같은 값**을 준다.
   * 그래서 NXT에서만 급등한 종목은 기본 조회에 아예 안 나온다 — 따로 볼 수 있어야 한다.
   */
  exchange?: boolean;
  /**
   * 시장(mrkt_tp)을 **안 받는 조회** (2026-09-09) — 조회순위는 전체 시장 한 덩어리다.
   * 화면이 코스피/코스닥을 고르면 서버가 종목 목록의 시장으로 걸러 준다.
   */
  noMarket?: boolean;
  columns: RankColumn[];
  /**
   * **화면에서 고를 수 있는 파라미터** (2026-09-01).
   *
   * 여태 `params` 는 고정이었다. 그래서 `ka10065`(장중 투자자별)가 `orgn_tp: "9000"`
   * 하나에 묶여 있었는데 — **그게 외국인이었다.** 「투자자별 매매상위」라는 이름을
   * 달고 외국인 것만 보여 주고 있었던 셈이다.
   *
   * 여기 값은 전부 **장중에 실측한 것**이다(2026-09-01 11:5x). 각 코드의 1위 종목을
   * `ka10060`(일별 종목별 투자자)으로 불러 순매수 수량이 정확히 1000배로 맞는
   * 투자자를 찾았다 — 짐작이 아니다.
   */
  choices?: {
    /** 이 선택이 넣는 파라미터 이름 */
    param: string;
    label: string;
    options: { value: string; label: string }[];
    /** 안 고르면 이 값 */
    def: string;
  }[];
  /** 화면 아래에 붙는 설명. 이 숫자를 어떻게 읽어야 하는지 */
  note?: string;
}

/** 모든 순위 조회가 공통으로 받는 값. 안 쓰는 TR은 무시한다 */
export const COMMON_PARAMS: Record<string, string> = {
  mrkt_tp: "000",
  trde_qty_tp: "0000",
  trde_qty_cnd: "0000",
  stk_cnd: "0",
  crd_cnd: "0",
  updown_incls: "1",
  sort_tp: "1",
  pric_cnd: "0",
  trde_prica_cnd: "0",
  mang_stk_incls: "0",
};

const STOCK: RankColumn[] = [
  { key: "stk_nm", label: "종목명", type: "text" },
  { key: "cur_prc", label: "현재가", type: "price" },
  { key: "flu_rt", label: "등락률", type: "pct" },
];

export const RANK_SPECS: RankSpec[] = [
  // ── 관심 ────────────────────────────────────────────────
  {
    /*
     * **실시간 종목조회순위** (2026-09-09 — 벤티지: "키움증권 API 중에 실시간 조회순이
     * 가져오는 API 있는지 확인해 줘봐" → "시세 분석에 넣어달라고 하려고 했어").
     *
     * 키움 고객이 **지금 어떤 종목을 들여다보는가**의 순위다. 등락·거래 순위는 이미
     * 일어난 일이고, 이건 사람들의 눈이 어디에 몰리는지다 — 거래로 터지기 한 박자
     * 앞의 신호일 때가 있다. 네이버 검색상위와 비슷하지만 매매하는 사람 쪽에 더 가깝다.
     *
     * 실측(2026-09-09 21:35): 20줄 고정, 연속조회 없음, 시장 구분 입력 없음.
     * 순위는 `bigd_rank`(키움 이름은 「빅데이터 순위」), 현재가는 `past_curr_prc`,
     * 등락률은 `base_comp_chgr`. 집계 시각 `tm` 은 1분 기준도 5~10분 단위로 갱신되더라.
     */
    key: "inquiry-rank",
    label: "실시간 조회순위",
    group: "관심",
    uri: "stkinfo",
    apiId: "ka00198",
    listKey: "item_inq_rank",
    noMarket: true,
    choices: [
      {
        param: "qry_tp",
        label: "기준",
        def: "1",
        options: [
          { value: "5", label: "30초" },
          { value: "1", label: "1분" },
          { value: "2", label: "10분" },
          { value: "3", label: "1시간" },
          { value: "4", label: "당일" },
        ],
      },
    ],
    columns: [
      { key: "rank", src: "bigd_rank", label: "순위", type: "num" },
      { key: "rank_chg", label: "변동", type: "signed" },
      { key: "stk_nm", label: "종목명", type: "text" },
      { key: "cur_prc", src: "past_curr_prc", label: "현재가", type: "price" },
      { key: "flu_rt", src: "base_comp_chgr", label: "등락률", type: "pct" },
    ],
    note:
      "키움 고객이 지금 어떤 종목을 많이 조회하는지의 순위입니다 — 20종목, 전체 시장 한 덩어리. " +
      "「변동」은 직전 집계 대비 순위가 몇 계단 올랐나(+)·내렸나(−)입니다. " +
      "거래로 터지기 전에 눈이 먼저 몰리는 종목을 찾을 때 봅니다.",
  },

  // ── 등락 ────────────────────────────────────────────────
  {
    key: "flu-rate",
    label: "전일대비 등락률상위",
    group: "등락",
    uri: "rkinfo",
    apiId: "ka10027",
    listKey: "pred_pre_flu_rt_upper",
    exchange: true,
    columns: [
      ...STOCK,
      { key: "now_trde_qty", label: "거래량", type: "num" },
      { key: "buy_req", label: "매수잔량", type: "num" },
      { key: "cntr_str", label: "체결강도", type: "pct" },
    ],
    note: "거래소를 NXT로 바꾸면 완전히 다른 종목이 나옵니다 — 통합은 사실상 KRX 기준입니다.",
  },
  {
    key: "price-jump",
    label: "가격 급등락",
    group: "등락",
    uri: "stkinfo",
    apiId: "ka10019",
    listKey: "pric_jmpflu",
    params: { flu_tp: "1", tm_tp: "1", tm: "60" },
    columns: [
      ...STOCK,
      { key: "base_pric", label: "기준가", type: "price" },
      { key: "base_pre", label: "기준대비", type: "signed" },
      { key: "jmp_rt", label: "급등률", type: "pct" },
      { key: "trde_qty", label: "거래량", type: "num" },
    ],
    note: "최근 60분 기준입니다. 기준가 대비 짧은 시간에 튄 종목을 봅니다.",
  },
  {
    key: "high-low-near",
    label: "고저가 근접",
    group: "등락",
    uri: "stkinfo",
    apiId: "ka10018",
    listKey: "high_low_pric_alacc",
    params: { high_low_tp: "1", alacc_rt: "05" },
    columns: [
      ...STOCK,
      { key: "tdy_high_pric", label: "당일고가", type: "price" },
      { key: "tdy_low_pric", label: "당일저가", type: "price" },
      { key: "trde_qty", label: "거래량", type: "num" },
    ],
    note: "당일 고가에 0.5% 이내로 붙은 종목입니다. 돌파를 앞둔 자리를 찾을 때 봅니다.",
  },
  {
    key: "expect",
    label: "예상체결 등락률상위",
    group: "등락",
    uri: "rkinfo",
    apiId: "ka10029",
    listKey: "exp_cntr_flu_rt_upper",
    columns: [
      { key: "stk_nm", label: "종목명", type: "text" },
      { key: "exp_cntr_pric", label: "예상체결가", type: "price" },
      { key: "base_pric", label: "기준가", type: "price" },
      { key: "flu_rt", label: "등락률", type: "pct" },
      { key: "exp_cntr_qty", label: "예상수량", type: "num" },
    ],
    note: "장 시작 전·마감 동시호가에서만 의미가 있습니다.",
  },

  // ── 거래 ────────────────────────────────────────────────
  {
    key: "trade-value",
    label: "거래대금 상위",
    group: "거래",
    uri: "rkinfo",
    apiId: "ka10032",
    listKey: "trde_prica_upper",
    exchange: true,
    columns: [
      /*
        순위와 전일순위는 **붙여 둔다.** 둘을 견주는 게 이 조회를 보는 이유다 —
        전일순위와 벌어진 종목이 오늘 새로 돈이 몰린 곳이다. 떨어뜨려 놓으면
        눈이 표를 가로질러 왔다 갔다 해야 하고, 폰에서는 아예 한 화면에 안 들어온다.
      */
      { key: "now_rank", label: "순위", type: "num" },
      { key: "pred_rank", label: "전일", type: "num" },
      ...STOCK,
      { key: "trde_prica", label: "거래대금", type: "num" },
      { key: "now_trde_qty", label: "거래량", type: "num" },
    ],
    note: "거래대금은 백만원 단위입니다. 전일순위와 벌어진 종목이 오늘 새로 돈이 몰린 곳입니다.",
  },
  {
    key: "bid-balance",
    label: "호가잔량 상위",
    group: "거래",
    uri: "rkinfo",
    apiId: "ka10020",
    listKey: "bid_req_upper",
    columns: [
      { key: "stk_nm", label: "종목명", type: "text" },
      { key: "cur_prc", label: "현재가", type: "price" },
      { key: "tot_buy_req", label: "총매수잔량", type: "num" },
      { key: "tot_sel_req", label: "총매도잔량", type: "num" },
      { key: "netprps_req", label: "순잔량", type: "signed" },
      { key: "buy_rt", label: "매수비율", type: "pct" },
    ],
  },

  // ── 수급 ────────────────────────────────────────────────
  {
    key: "foreign-cont",
    label: "외국인 연속순매매",
    group: "수급",
    uri: "rkinfo",
    apiId: "ka10035",
    listKey: "for_cont_nettrde_upper",
    params: { trde_tp: "2", base_dt_tp: "1" },
    columns: [
      { key: "stk_nm", label: "종목명", type: "text" },
      { key: "cur_prc", label: "현재가", type: "price" },
      { key: "dm1", label: "1일", type: "num" },
      { key: "dm2", label: "2일", type: "num" },
      { key: "dm3", label: "3일", type: "num" },
      { key: "tot", label: "합계", type: "num" },
      { key: "limit_exh_rt", label: "한도소진율", type: "pct" },
    ],
    note: "하루치는 노이즈지만 며칠 연속인지는 신호입니다.",
  },
  {
    key: "foreign-period",
    label: "외국인 기간별 매매",
    group: "수급",
    uri: "rkinfo",
    apiId: "ka10034",
    listKey: "for_dt_trde_upper",
    params: { trde_tp: "2", dt: "1" },
    columns: [
      { key: "rank", label: "순위", type: "num" },
      { key: "stk_nm", label: "종목명", type: "text" },
      { key: "cur_prc", label: "현재가", type: "price" },
      { key: "netprps_qty", label: "순매수수량", type: "signed" },
      { key: "trde_qty", label: "거래량", type: "num" },
    ],
  },
  {
    key: "foreign-limit",
    label: "외국인 한도소진율 증가",
    group: "수급",
    uri: "rkinfo",
    apiId: "ka10036",
    listKey: "for_limit_exh_rt_incrs_upper",
    params: { dt: "1" },
    columns: [
      { key: "rank", label: "순위", type: "num" },
      { key: "stk_nm", label: "종목명", type: "text" },
      { key: "cur_prc", label: "현재가", type: "price" },
      { key: "base_limit_exh_rt", label: "기준소진율", type: "pct" },
      { key: "limit_exh_rt", label: "현재소진율", type: "pct" },
      { key: "exh_rt_incrs", label: "증가", type: "pct" },
    ],
    note: "외국인이 살 수 있는 한도를 얼마나 채웠는지입니다. 급증하면 집중 매수가 있었다는 뜻입니다.",
  },
  {
    key: "foreign-wicket",
    label: "외국계 창구 매매상위",
    group: "수급",
    uri: "rkinfo",
    apiId: "ka10037",
    listKey: "frgn_wicket_trde_upper",
    params: { dt: "1", trde_tp: "2" },
    columns: [
      { key: "rank", label: "순위", type: "num" },
      ...STOCK,
      { key: "buy_trde_qty", label: "매수", type: "num" },
      { key: "sel_trde_qty", label: "매도", type: "num" },
      { key: "netprps_trde_qty", label: "순매수", type: "signed" },
    ],
  },
  {
    key: "intraday-investor",
    label: "장중 투자자별 순매수",
    group: "수급",
    uri: "rkinfo",
    apiId: "ka10065",
    listKey: "opmr_invsr_trde_upper",
    /*
     * ⚠️ 예전엔 `{ trde_tp: "2", orgn_tp: "9000" }` 이 **박혀 있었다.**
     * 2026-09-01 장중 실측으로 그 뜻이 밝혀졌는데 — **순매도 상위 · 외국인**이었다.
     * 「투자자별 매매상위」라는 이름을 달고 외국인 순매도만 보여 주고 있었던 셈이다.
     * 이제 둘 다 고를 수 있다.
     */
    choices: [
      {
        param: "trde_tp",
        label: "방향",
        def: "1",
        options: [
          { value: "1", label: "순매수" },
          { value: "2", label: "순매도" },
        ],
      },
      {
        param: "orgn_tp",
        label: "투자자",
        def: "3000",
        /*
         * **실측으로 확정한 것만 넣는다** (2026-09-01).
         *
         * 각 코드의 1위 종목을 `ka10060` 으로 불러 순매수 수량이 정확히 1000배로
         * 맞는 투자자를 찾았다. 예: `orgn_tp=3000` 의 1위가 321370 −616,000주였고
         * 그 종목의 그날 `invtrt` 가 −616(천주)이었다 — 투신이다.
         *
         * 응답은 오지만 대조가 안 맞은 코드(9100·9200·9999)는 **뺐다.** 뜻을
         * 모르는 것에 이름을 붙이면, 그게 틀려도 아무도 눈치채지 못한다.
         *
         * 없는 코드(0000·1000·3100·5000·7000·9001 등)는 빈 응답이었다.
         * ⚠️ **사모펀드·금융투자는 이 TR 에 따로 없다** — 주포 3대장 중 사모는
         * 여기서 못 본다. 그건 `ka10060`(종목별 일별)으로만 볼 수 있다.
         */
        options: [
          { value: "3000", label: "투신" },
          { value: "6000", label: "연기금" },
          { value: "2000", label: "보험" },
          { value: "4000", label: "은행" },
          { value: "9000", label: "외국인" },
          { value: "7100", label: "기타법인" },
        ],
      },
    ],
    columns: [
      { key: "stk_nm", label: "종목명", type: "text" },
      { key: "buy_qty", label: "매수", type: "num" },
      { key: "sel_qty", label: "매도", type: "num" },
      { key: "netslmt", label: "순매수", type: "signed" },
    ],
    note:
      "장중에만 값이 들어옵니다. 단위는 **주**입니다. " +
      "투자자 구분은 2026-09-01 장중에 실측해 확정한 것입니다 — 각 코드의 1위 종목을 " +
      "종목별 일별 투자자 데이터와 대조해 수량이 정확히 맞는 투자자를 찾았습니다. " +
      "사모펀드·금융투자는 이 조회에 따로 없습니다.",
  },

  // ── 신용·위험 ───────────────────────────────────────────
  {
    key: "credit-ratio",
    label: "신용비율 상위",
    group: "신용·위험",
    uri: "rkinfo",
    apiId: "ka10033",
    listKey: "crd_rt_upper",
    columns: [
      ...STOCK,
      { key: "crd_rt", label: "신용비율", type: "pct" },
      { key: "now_trde_qty", label: "거래량", type: "num" },
    ],
    note: "신용비율이 높을수록 반대매매가 나올 여지가 큽니다 — 하락장에서 낙폭이 커지는 자리입니다.",
  },
];

export function findSpec(key: string): RankSpec | undefined {
  return RANK_SPECS.find((s) => s.key === key);
}

/** 화면 트리에 쓸 묶음 목록 (등록 순서 유지) */
export function specGroups(): { group: string; items: { key: string; label: string }[] }[] {
  const out: { group: string; items: { key: string; label: string }[] }[] = [];
  for (const s of RANK_SPECS) {
    let g = out.find((x) => x.group === s.group);
    if (!g) {
      g = { group: s.group, items: [] };
      out.push(g);
    }
    g.items.push({ key: s.key, label: s.label });
  }
  return out;
}
