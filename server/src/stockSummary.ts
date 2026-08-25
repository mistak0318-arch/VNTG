import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 종목 한 장 요약 — **첫 화면에서 한 번에 읽는 표.**
 *
 * ## 왜 만들었나
 *
 * 종목을 누르면 값이 많이 뜨는데 **여기저기 흩어져 있었다.** 시가총액은 요약줄 한쪽에,
 * 체결강도는 거래대금 밑에, 회전율은 아예 없고, 수급은 한참 아래 차트로 있었다.
 * 「이 종목 지금 어떤가」를 보려면 화면을 위아래로 훑어야 했다.
 *
 * 표 두 개로 모은다. **몸값**(시총·PER·회전율·체결강도)과 **오늘 누가 샀나**(수급).
 *
 * ## 왜 서버에서 합치나
 *
 * 화면에서 넷을 따로 부르면 조회 순서가 뒤엉키고 어느 하나가 느릴 때 화면이 조각조각
 * 뜬다. 여기서 한 번에 받아 **한 덩어리로** 준다. 하나가 실패해도 나머지는 낸다 —
 * 수급을 못 받았다고 시가총액까지 빈칸이 되면 안 된다.
 *
 * ## 조회 넷
 *
 *   `ka10007` 시세표성정보 — 시총 재료·거래대금·상장주식수
 *   `ka10059` 일별 투자자   — 개인·외국인·기관 + 기관 세부
 *   `ka10003` 체결          — 체결강도
 *   `ka90013` 프로그램      — 오늘 프로그램 순매수
 */

const MRKCOND = "/api/dostk/mrkcond";
const STKINFO = "/api/dostk/stkinfo";

function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}
/** 키움은 하락을 음수 가격으로 준다 — 가격은 부호를 뗀다 */
function abs(v: unknown): number {
  return Math.abs(n(v));
}
/**
 * 순매수는 **부호가 뜻이다** — 절대 떼면 안 된다.
 *
 * ⚠️ 키움이 `--520995` 처럼 **부호를 두 번** 붙여 보내는 칸이 있다(프로그램 순매수에서
 * 실제로 온다). `Number()` 에 그대로 넣으면 NaN 이 되고, 그럼 **−5,210억이 0 으로** 적힌다.
 * 부호 개수로 판단해 하나로 접는다 — `rankExtras.toNum` 이 같은 이유로 같은 일을 한다.
 */
function signed(v: unknown): number {
  const raw = String(v ?? "").replace(/[,\s]/g, "");
  if (!raw) return 0;
  const m = /^([+-]*)(\d*\.?\d+)$/.exec(raw);
  if (!m) return 0;
  const negative = (m[1].match(/-/g) ?? []).length > 0;
  const x = Number(m[2]);
  return Number.isFinite(x) ? (negative ? -x : x) : 0;
}

export interface SummaryFacts {
  price: number;
  changeRate: number;
  /** 시가총액(억원) — 상장주식수 × 현재가 */
  marketCap: number | null;
  /** 상장주식수(주) */
  shares: number | null;
  /** 오늘 거래대금(억원) */
  tradeValue: number | null;
  volume: number;
  /** 회전율(%) = 거래량 ÷ 상장주식수 */
  turnover: number | null;
  /** 체결강도 — 100 보다 크면 사는 쪽이 세다 */
  strength: number | null;
  /** 전일 종가 */
  prevClose: number;
  high: number;
  low: number;
  open: number;
  upperLimit: number;
  lowerLimit: number;
}

/** 투자자 한 줄 — **금액(백만원)**. 부호가 방향이다 */
export interface SummaryFlowRow {
  key: string;
  label: string;
  amount: number;
}

export interface StockSummary {
  code: string;
  /** YYYYMMDD — 어느 날 수급인가 */
  date: string;
  facts: SummaryFacts;
  /** 큰 세 갈래 */
  main: SummaryFlowRow[];
  /** 기관 안쪽 — 「기관」 한 덩어리로는 누가 샀는지 모른다 */
  institution: SummaryFlowRow[];
  /** 프로그램 순매수(백만원). 못 받으면 null */
  program: number | null;
  /** 어느 조각이 비었나 — 화면이 「못 받았다」와 「0이다」를 갈라 적는다 */
  missing: string[];
}

/*
 * 기관 세부 — **키움이 주는 칸을 그대로** 쓴다.
 *
 * 이름을 우리가 새로 지으면 나중에 다른 화면과 말이 안 맞는다. 순서는 실제로 크게
 * 움직이는 것부터다 — 금융투자(증권사 자기매매)와 투신·연기금이 국내 수급의 대부분이다.
 */
const INST_KEYS = {
  fnnc_invt: "금융투자",
  invtrt: "투신",
  penfnd_etc: "연기금",
  samo_fund: "사모",
  insrnc: "보험",
  bank: "은행",
  etc_fnnc: "기타금융",
} as const;

export async function stockSummary(client: KiwoomClient, code: string): Promise<StockSummary> {
  const bare = String(code).replace(/_(AL|NX)$/i, "");
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const missing: string[] = [];

  const [quote, investor, ticks, program] = await Promise.all([
    client
      .request<Record<string, unknown>>(MRKCOND, "ka10007", { stk_cd: bare })
      .catch(() => null),
    client
      .request<Record<string, unknown>>(STKINFO, "ka10059", {
        dt: today,
        stk_cd: bare,
        amt_qty_tp: "1", // 금액(백만원)
        trde_tp: "0", // 순매수
        unit_tp: "1000",
      })
      .catch(() => null),
    client.request<Record<string, unknown>>(STKINFO, "ka10003", { stk_cd: bare }).catch(() => null),
    client
      .request<Record<string, unknown>>(MRKCOND, "ka90013", {
        stk_cd: bare,
        date: today,
        amt_qty_tp: "1",
      })
      .catch(() => null),
  ]);

  if (!quote) missing.push("시세");
  const q = quote?.data ?? {};

  const price = abs(q.cur_prc);
  /* `flo_stkcnt` 는 **천주** 단위다 (삼성전자 5,846,279 = 58.4억주) */
  const shares = n(q.flo_stkcnt) > 0 ? n(q.flo_stkcnt) * 1000 : null;
  const volume = n(q.trde_qty);
  const tradeValue = n(q.trde_prica) > 0 ? Math.round(n(q.trde_prica) / 100) : null;

  /*
   * 체결강도 — `ka10003` 의 최근 체결 줄에 들어 있다. 없으면 null 이고, 화면은 「-」다.
   * **0 으로 두면 「파는 쪽이 압도적」으로 읽힌다.**
   */
  let strength: number | null = null;
  const tickRows = Array.isArray(ticks?.data?.cntr_infr)
    ? (ticks.data.cntr_infr as Record<string, unknown>[])
    : [];
  if (tickRows.length > 0) {
    const v = n(tickRows[0].cntr_str);
    strength = v > 0 ? v : null;
  }
  if (strength === null) missing.push("체결강도");

  /* 투자자 — 오늘 줄. 장 시작 전이면 아직 없을 수 있다 */
  const invRows = Array.isArray(investor?.data?.stk_invsr_orgn)
    ? (investor.data.stk_invsr_orgn as Record<string, unknown>[])
    : [];
  const row = invRows.find((r) => String(r.dt ?? "") === today) ?? invRows[0] ?? null;
  if (!row) missing.push("투자자 수급");

  const main: SummaryFlowRow[] = row
    ? [
        { key: "ind_invsr", label: "개인", amount: signed(row.ind_invsr) },
        { key: "frgnr_invsr", label: "외국인", amount: signed(row.frgnr_invsr) },
        { key: "orgn", label: "기관", amount: signed(row.orgn) },
        { key: "etc_corp", label: "기타법인", amount: signed(row.etc_corp) },
      ]
    : [];

  const institution: SummaryFlowRow[] = row
    ? Object.entries(INST_KEYS)
        .map(([key, label]) => ({ key, label, amount: signed(row[key]) }))
        /* 0 인 칸은 안 보여준다 — 안 움직인 창구를 늘어놓으면 움직인 게 안 보인다 */
        .filter((r) => r.amount !== 0)
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
    : [];

  /*
   * 프로그램 — 오늘 줄의 순매수(백만원).
   *
   * ⚠️ `prm_netprps_amt` 가 `--520995` 처럼 **부호를 두 번** 달고 온다. `signed` 가
   * 접어서 −520,995 로 읽는다. 그냥 `Number()` 로 읽으면 NaN → 0 이 되어
   * **−5,210억 매도를 「0」으로** 적게 된다.
   */
  let prog: number | null = null;
  const progRows = Array.isArray(program?.data?.stk_daly_prm_trde_trnsn)
    ? (program.data.stk_daly_prm_trde_trnsn as Record<string, unknown>[])
    : [];
  if (progRows.length > 0) {
    const p = progRows.find((r) => String(r.dt ?? "") === today) ?? progRows[0];
    prog = signed(p.prm_netprps_amt);
  }
  if (prog === null) missing.push("프로그램");

  return {
    code: bare,
    date: String(row?.dt ?? today),
    facts: {
      price,
      changeRate: signed(q.flu_rt),
      marketCap: shares && price > 0 ? Math.round((shares * price) / 1e8) : null,
      shares,
      tradeValue,
      volume,
      turnover: shares && shares > 0 && volume > 0 ? (volume / shares) * 100 : null,
      strength,
      prevClose: abs(q.pred_close_pric),
      high: abs(q.high_pric),
      low: abs(q.low_pric),
      open: abs(q.open_pric),
      upperLimit: abs(q.upl_pric),
      lowerLimit: abs(q.lst_pric),
    },
    main,
    institution,
    program: prog,
    missing,
  };
}
