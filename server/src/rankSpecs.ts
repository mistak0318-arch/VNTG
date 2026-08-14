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

export type ColType = "text" | "price" | "num" | "pct";

export interface RankColumn {
  key: string;
  label: string;
  type?: ColType;
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
  columns: RankColumn[];
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
      { key: "base_pre", label: "기준대비", type: "num" },
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
      { key: "now_rank", label: "순위", type: "num" },
      ...STOCK,
      { key: "trde_prica", label: "거래대금", type: "num" },
      { key: "now_trde_qty", label: "거래량", type: "num" },
      { key: "pred_rank", label: "전일순위", type: "num" },
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
      { key: "netprps_req", label: "순잔량", type: "num" },
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
      { key: "netprps_qty", label: "순매수수량", type: "num" },
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
      { key: "netprps_trde_qty", label: "순매수", type: "num" },
    ],
  },
  {
    key: "intraday-investor",
    label: "장중 투자자별 매매상위",
    group: "수급",
    uri: "rkinfo",
    apiId: "ka10065",
    listKey: "opmr_invsr_trde_upper",
    params: { trde_tp: "2", orgn_tp: "9000" },
    columns: [
      { key: "stk_nm", label: "종목명", type: "text" },
      { key: "buy_qty", label: "매수", type: "num" },
      { key: "sel_qty", label: "매도", type: "num" },
      { key: "netslmt", label: "순매수", type: "num" },
    ],
    note: "장중에만 값이 들어옵니다.",
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
