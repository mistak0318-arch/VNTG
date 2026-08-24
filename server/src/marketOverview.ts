import { getGlobalMarket } from "./globalMarket.js";
import { usMajorIndices } from "./usMajor.js";
import { topTraders } from "./topTraders.js";
import { rateBoard } from "./rateBoard.js";
import { recordFlow } from "./flowIntraday.js";
import { kospi200Futures, type FuturesQuote } from "./kospiFutures.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { getSharesMap } from "./stockListCache.js";

/**
 * 시황 탭용 데이터 캐시.
 *
 * 클라이언트(브라우저)는 이 캐시만 조회하고 키움 API를 직접 호출하지 않는다.
 * 폰·태블릿·PC가 동시에 붙어도 키움 호출량은 동일하게 유지된다.
 *
 * 갱신 방식은 "요청 시 만료 확인 후 갱신"(stale-while-revalidate).
 * 고정 주기 스케줄러 대신 이 방식을 쓰는 이유:
 *  - 아무도 안 보고 있을 때 불필요한 호출이 나가지 않음 (장 마감 후 자동으로 조용해짐)
 *  - 캐시가 살아있으면 즉시 응답하고, 만료됐으면 백그라운드로 갱신하며 이전 값을 먼저 돌려줌
 */

interface CacheEntry<T> {
  data: T | null;
  updatedAt: number;
  error: string | null;
  refreshing: boolean;
}

const SECTION_TTL_MS = {
  /*
   * 지수 — 가장 자주 본다. 그래도 **10초에서 더 줄이지 않는다.**
   * 오늘 키움이 24,508건에 한도 초과 102건이다 — 이쪽은 이미 걸리고 있으므로
   * 더 조이면 다른 조회까지 같이 밀린다. 화면은 5초마다 캐시를 집어 오므로
   * 새 값이 만들어지면 곧바로 보인다.
   */
  indices: 10_000,
  flow: 60_000, // 투자자 수급 — 원 데이터가 자주 안 바뀜
  movers: 60_000, // 등락률 순위
  sectors: 180_000, // 업종
  themes: 180_000, // 테마
  highLow: 300_000, // 250일 신고저가
  vi: 60_000, // VI 발동
  /*
   * 글로벌 — 야후.
   *
   * 60초에서 줄였다. 오늘 사용량을 보니 야후는 20,930건에 **한도 초과 0건**이고
   * 실패도 7건뿐이다. 여유가 있는 쪽이다. 게다가 국내 지수 넷을 빼서 15종목으로 줄었다.
   */
  global: 30_000,
  /*
   * 미장 주요지수 — 미국 **현물**은 우리 시간 05:30 에 닫혀 낮에는 아예 안 움직인다.
   * 자주 부를 이유가 없다. (「글로벌 시황지수」의 선물이 움직이는 쪽이다)
   */
  usMajor: 30_000,
  /*
   * 수익률 상위 고객 매매동향 — 계좌 집계라 자주 안 바뀐다.
   * 참고 자료라 굳이 자주 부를 이유도 없다.
   */
  topTraders: 300_000,
  /* 금리 — 하루에 몇 번 안 바뀐다 */
  rates: 60_000,
} as const;

export type SectionName = keyof typeof SECTION_TTL_MS;

const cache = new Map<SectionName, CacheEntry<unknown>>();

function getEntry(section: SectionName): CacheEntry<unknown> {
  let entry = cache.get(section);
  if (!entry) {
    entry = { data: null, updatedAt: 0, error: null, refreshing: false };
    cache.set(section, entry);
  }
  return entry;
}

const SECT_RESOURCE = "/api/dostk/sect";
const MRKCOND_RESOURCE = "/api/dostk/mrkcond";

function todayYyyymmdd(): string {
  const now = new Date();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}${m}${d}`;
}
const RKINFO_RESOURCE = "/api/dostk/rkinfo";
const STKINFO_RESOURCE = "/api/dostk/stkinfo";
const THME_RESOURCE = "/api/dostk/thme";

type Row = Record<string, unknown>;

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 키움은 가격/지수에 등락 방향 부호를 붙여 보내므로 절댓값을 취한다 */
function toAbsNum(v: unknown): number {
  return Math.abs(toNum(v));
}

// ---------------------------------------------------------------- 지수 + 등락현황

export interface IndexCard {
  /*
   * 코스피200 에만 붙는다 — 그 옆의 선물.
   *
   * 둘의 차이(베이시스)가 핵심이다. 선물이 현물보다 더 빠지면 백워데이션이고
   * 프로그램 매도가 붙기 쉽다. 키움 HTS 가 두 칸을 나란히 놓은 이유가 그것이다.
   * 한투 키가 없으면 null 이고, 화면은 예전처럼 현물만 보여 준다.
   */
  futures?: FuturesQuote | null;
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  sparkline: number[];
  // 종목등락현황 (해당 시장 기준)
  upperLimit: number;
  rising: number;
  flat: number;
  falling: number;
  lowerLimit: number;
}

const INDEX_TARGETS: { code: string; name: string; mrktTp: string }[] = [
  { code: "001", name: "KOSPI", mrktTp: "0" },
  { code: "101", name: "KOSDAQ", mrktTp: "1" },
  { code: "201", name: "코스피200", mrktTp: "0" },
];

async function fetchIndices(client: KiwoomClient): Promise<IndexCard[]> {
  const results: IndexCard[] = [];
  for (const target of INDEX_TARGETS) {
    // ka20001 업종현재가요청 — 지수 현재가 + 상한/상승/보합/하락/하한 + 시간별 지수(스파크라인)
    const { data } = await client.request<Row>(SECT_RESOURCE, "ka20001", {
      mrkt_tp: target.mrktTp,
      inds_cd: target.code,
    });
    const timeRows = Array.isArray(data.inds_cur_prc_tm) ? (data.inds_cur_prc_tm as Row[]) : [];
    // 응답은 최신순이므로 시간순으로 뒤집어 스파크라인에 사용
    const sparkline = timeRows
      .map((r) => toAbsNum(r.cur_prc_n))
      .filter((n) => n > 0)
      .reverse();

    results.push({
      code: target.code,
      name: target.name,
      price: toAbsNum(data.cur_prc),
      change: toNum(data.pred_pre),
      changeRate: toNum(data.flu_rt),
      sparkline,
      upperLimit: toNum(data.upl),
      rising: toNum(data.rising),
      flat: toNum(data.stdns),
      falling: toNum(data.fall),
      lowerLimit: toNum(data.lst),
    });
  }

  /*
   * 선물을 **네 번째 카드**로 세운다.
   *
   * 처음엔 코스피200 밑에 한 줄로 붙였는데 그게 틀렸다 — 선물을 보는 이유는 장중에
   * 현물보다 먼저 움직이는 걸 보려는 것인데, 한 줄짜리로는 **차트도 수급도 못 본다.**
   * 키움 HTS 가 코스피·코스닥·코스피200 과 나란히 같은 크기로 놓는 이유가 그것이다.
   */
  const k200 = results.find((r) => r.code === "201");
  const fut = await kospi200Futures(k200?.price ?? null);
  if (fut && fut.price !== null) {
    results.push({
      code: "F",
      name: "선물",
      price: fut.price,
      change: fut.change ?? 0,
      changeRate: fut.changeRate ?? 0,
      sparkline: fut.sparkline,
      // 선물엔 종목등락현황이 없다 — 지수가 아니라 하나의 계약이다
      upperLimit: 0,
      rising: 0,
      flat: 0,
      falling: 0,
      lowerLimit: 0,
      futures: fut,
    });
  }

  return results;
}

// ---------------------------------------------------------------- 투자자별 수급

export interface InvestorFlow {
  individual: number;
  foreign: number;
  institution: number;
  // 기관 세부
  financialInvestment: number; // 금융투자(증권)
  investmentTrust: number; // 투신
  pensionFund: number; // 연기금(기금)
  privateFund: number; // 사모펀드
  insurance: number;
  bank: number;
  otherFinance: number;
  nation: number;
  otherCorp: number;
}

export interface MarketFlow {
  kospi: InvestorFlow;
  kosdaq: InvestorFlow;
}

/** ka10051 응답에서 시장 전체(종합지수) 행만 골라낸다. inds_cd는 "001_AL" 형태로 올 수 있다. */
function pickTotalRow(rows: Row[], indexCode: string): Row | undefined {
  return (
    rows.find((r) => String(r.inds_cd ?? "").startsWith(indexCode)) ??
    rows[0] // 못 찾으면 첫 행(보통 종합)을 사용
  );
}

function mapFlow(row: Row | undefined): InvestorFlow {
  return {
    individual: toNum(row?.ind_netprps),
    foreign: toNum(row?.frgnr_netprps),
    institution: toNum(row?.orgn_netprps),
    financialInvestment: toNum(row?.sc_netprps),
    investmentTrust: toNum(row?.invtrt_netprps),
    pensionFund: toNum(row?.endw_netprps),
    privateFund: toNum(row?.samo_fund_netprps),
    insurance: toNum(row?.insrnc_netprps),
    bank: toNum(row?.bank_netprps),
    otherFinance: toNum(row?.jnsinkm_netprps),
    nation: toNum(row?.natn_netprps),
    otherCorp: toNum(row?.etc_corp_netprps),
  };
}

async function fetchFlow(client: KiwoomClient): Promise<MarketFlow> {
  // ka10051 업종별투자자순매수요청 — 시장 단위 집계를 한 번에 준다(종목별 합산 불필요). 단위: 억원
  const [kospiRes, kosdaqRes] = await Promise.all([
    client.request<Row>(SECT_RESOURCE, "ka10051", {
      mrkt_tp: "0",
      amt_qty_tp: "0",
      base_dt: "",
      stex_tp: "1", // KRX — 상세(ka10001)와 기준을 맞춘다. 통합은 마감 후 NXT 값을 준다
    }),
    client.request<Row>(SECT_RESOURCE, "ka10051", {
      mrkt_tp: "1",
      amt_qty_tp: "0",
      base_dt: "",
      stex_tp: "1", // KRX — 상세(ka10001)와 기준을 맞춘다. 통합은 마감 후 NXT 값을 준다
    }),
  ]);

  const kospiRows = Array.isArray(kospiRes.data.inds_netprps) ? (kospiRes.data.inds_netprps as Row[]) : [];
  const kosdaqRows = Array.isArray(kosdaqRes.data.inds_netprps) ? (kosdaqRes.data.inds_netprps as Row[]) : [];

  const flow = {
    kospi: mapFlow(pickTotalRow(kospiRows, "001")),
    kosdaq: mapFlow(pickTotalRow(kosdaqRows, "101")),
  };

  /*
   * 장중 변화를 쌓는다. **추가 호출이 아니다** — 방금 받은 값을 시각과 함께 적어 둘 뿐이다.
   * ka10051 은 누적만 주므로 시계열은 이렇게밖에 못 만든다.
   */
  void recordFlow(flow.kospi, flow.kosdaq);

  return flow;
}

// ---------------------------------------------------------------- 등락률 순위

export interface StockRow {
  code: string;
  name: string;
  price: number;
  change: number;
  changeRate: number;
  /** 시가총액(억원). 상장주식수를 못 찾으면 null */
  marketCap?: number | null;
}

function mapStockRows(rows: Row[], limit = 30): StockRow[] {
  return rows.slice(0, limit).map((r) => ({
    code: String(r.stk_cd ?? ""),
    name: String(r.stk_nm ?? ""),
    price: toAbsNum(r.cur_prc),
    change: toNum(r.pred_pre),
    changeRate: toNum(r.flu_rt),
  }));
}

export interface Movers {
  rising: StockRow[];
  falling: StockRow[];
}

async function fetchMovers(client: KiwoomClient): Promise<Movers> {
  // ka10027 전일대비등락률상위요청 — 시세를 같이 주므로 개별 조회 불필요
  const common = {
    mrkt_tp: "000",
    trde_qty_cnd: "0050", // 5만주 이상 (잡주 제외)
    stk_cnd: "16", // ETF+ETN 제외
    crd_cnd: "0",
    updown_incls: "1",
    pric_cnd: "0",
    trde_prica_cnd: "50", // 5억원 이상
    stex_tp: "1", // KRX — 상세(ka10001)와 기준을 맞춘다. 통합은 마감 후 NXT 값을 준다
  };
  const [up, down] = await Promise.all([
    client.request<Row>(RKINFO_RESOURCE, "ka10027", { ...common, sort_tp: "1" }),
    client.request<Row>(RKINFO_RESOURCE, "ka10027", { ...common, sort_tp: "3" }),
  ]);

  const upRows = Array.isArray(up.data.pred_pre_flu_rt_upper) ? (up.data.pred_pre_flu_rt_upper as Row[]) : [];
  const downRows = Array.isArray(down.data.pred_pre_flu_rt_upper) ? (down.data.pred_pre_flu_rt_upper as Row[]) : [];

  return { rising: mapStockRows(upRows), falling: mapStockRows(downRows) };
}

// ---------------------------------------------------------------- 업종

export interface SectorRow {
  code: string;
  name: string;
  changeRate: number;
}

export interface Sectors {
  kospi: SectorRow[];
  kosdaq: SectorRow[];
}

function mapSectors(rows: Row[]): SectorRow[] {
  return rows
    .map((r) => ({
      code: String(r.stk_cd ?? ""),
      name: String(r.stk_nm ?? ""),
      changeRate: toNum(r.flu_rt),
    }))
    .filter((s) => s.name)
    .sort((a, b) => b.changeRate - a.changeRate);
}

async function fetchSectors(client: KiwoomClient): Promise<Sectors> {
  // ka20003 전업종지수요청 — 한 번에 전 업종 등락률을 준다
  const [kospi, kosdaq] = await Promise.all([
    client.request<Row>(SECT_RESOURCE, "ka20003", { inds_cd: "001" }),
    client.request<Row>(SECT_RESOURCE, "ka20003", { inds_cd: "101" }),
  ]);
  return {
    kospi: mapSectors(Array.isArray(kospi.data.all_inds_idex) ? (kospi.data.all_inds_idex as Row[]) : []),
    kosdaq: mapSectors(Array.isArray(kosdaq.data.all_inds_idex) ? (kosdaq.data.all_inds_idex as Row[]) : []),
  };
}

// ---------------------------------------------------------------- 테마

export interface ThemeRow {
  code: string;
  name: string;
  changeRate: number;
  stockCount: number;
  mainStock: string;
}

export interface Themes {
  top: ThemeRow[];
  bottom: ThemeRow[];
}

function mapThemes(rows: Row[]): ThemeRow[] {
  return rows.slice(0, 30).map((r) => ({
    code: String(r.thema_grp_cd ?? ""),
    name: String(r.thema_nm ?? ""),
    changeRate: toNum(r.flu_rt),
    stockCount: toNum(r.stk_num),
    mainStock: String(r.main_stk ?? ""),
  }));
}

async function fetchThemes(client: KiwoomClient): Promise<Themes> {
  // ka90001 테마그룹별요청 — 테마명과 등락률을 계산해서 준다 (외부 크롤링 불필요)
  const common = { qry_tp: "0", stk_cd: "", date_tp: "1", thema_nm: "", stex_tp: "1" };
  const [top, bottom] = await Promise.all([
    client.request<Row>(THME_RESOURCE, "ka90001", { ...common, flu_pl_amt_tp: "3" }), // 3:상위등락률
    client.request<Row>(THME_RESOURCE, "ka90001", { ...common, flu_pl_amt_tp: "4" }), // 4:하위등락률
  ]);
  return {
    top: mapThemes(Array.isArray(top.data.thema_grp) ? (top.data.thema_grp as Row[]) : []),
    bottom: mapThemes(Array.isArray(bottom.data.thema_grp) ? (bottom.data.thema_grp as Row[]) : []),
  };
}

// ---------------------------------------------------------------- 250일 신고가/신저가

export interface HighLow {
  high: StockRow[];
  low: StockRow[];
}

async function fetchHighLow(client: KiwoomClient): Promise<HighLow> {
  // ka10016 신고저가요청 — dt=250 으로 250일 기준
  const common = {
    mrkt_tp: "000",
    high_low_close_tp: "1",
    stk_cnd: "1", // 관리종목 제외
    trde_qty_tp: "00050",
    crd_cnd: "0",
    updown_incls: "1",
    dt: "250",
    stex_tp: "1", // KRX — 상세(ka10001)와 기준을 맞춘다. 통합은 마감 후 NXT 값을 준다
  };
  const [high, low] = await Promise.all([
    client.request<Row>(STKINFO_RESOURCE, "ka10016", { ...common, ntl_tp: "1" }),
    client.request<Row>(STKINFO_RESOURCE, "ka10016", { ...common, ntl_tp: "2" }),
  ]);
  return {
    high: mapStockRows(Array.isArray(high.data.ntl_pric) ? (high.data.ntl_pric as Row[]) : []),
    low: mapStockRows(Array.isArray(low.data.ntl_pric) ? (low.data.ntl_pric as Row[]) : []),
  };
}

// ---------------------------------------------------------------- VI 발동종목

/** VI 응답은 현재가/전일대비 대신 발동가격·시가대비등락률·해제시각을 준다 */
export interface ViRow {
  code: string;
  name: string;
  motionPrice: number; // 발동가격
  openChangeRate: number; // 시가대비등락률
  releaseTime: string; // VI해제시각 HHmmss
  motionCount: number; // VI발동횟수
}

async function fetchVi(client: KiwoomClient): Promise<ViRow[]> {
  // ka10054 변동성완화장치발동종목요청 — REST로 조회 가능(WebSocket 불필요)
  const { data } = await client.request<Row>(STKINFO_RESOURCE, "ka10054", {
    mrkt_tp: "000",
    bf_mkrt_tp: "0",
    stk_cd: "",
    motn_tp: "0",
    skip_stk: "000000000",
    // 구분이 "사용안함(0)"이어도 최소/최대 값은 필수라 0을 채워 보낸다 (빈 문자열은 누락으로 처리됨)
    trde_qty_tp: "0",
    min_trde_qty: "0",
    max_trde_qty: "0",
    trde_prica_tp: "0",
    min_trde_prica: "0",
    max_trde_prica: "0",
    motn_drc: "0",
    stex_tp: "1", // KRX — 상세(ka10001)와 기준을 맞춘다. 통합은 마감 후 NXT 값을 준다
  });
  const rows = Array.isArray(data.motn_stk) ? (data.motn_stk as Row[]) : [];
  return rows.slice(0, 30).map((r) => ({
    code: String(r.stk_cd ?? ""),
    name: String(r.stk_nm ?? ""),
    motionPrice: toAbsNum(r.motn_pric),
    openChangeRate: toNum(r.open_pric_pre_flu_rt),
    releaseTime: String(r.virelis_time ?? ""),
    motionCount: toNum(r.vimotn_cnt),
  }));
}

// ---------------------------------------------------------------- 캐시 제어

const FETCHERS: Record<SectionName, (client: KiwoomClient) => Promise<unknown>> = {
  indices: fetchIndices,
  flow: fetchFlow,
  movers: fetchMovers,
  sectors: fetchSectors,
  themes: fetchThemes,
  highLow: fetchHighLow,
  vi: fetchVi,
  global: () => getGlobalMarket(),
  usMajor: () => usMajorIndices(),
  topTraders: (c: KiwoomClient) => topTraders(c),
  rates: () => rateBoard(),
};

async function refresh(section: SectionName, client: KiwoomClient): Promise<void> {
  const entry = getEntry(section);
  if (entry.refreshing) return;
  entry.refreshing = true;
  try {
    entry.data = await FETCHERS[section](client);
    entry.updatedAt = Date.now();
    entry.error = null;
  } catch (err) {
    entry.error = err instanceof Error ? err.message : "알 수 없는 오류";
    // 이전 데이터는 남겨둬서 일시적 실패로 화면이 비지 않게 한다
  } finally {
    entry.refreshing = false;
  }
}

export interface SectionResult {
  data: unknown;
  updatedAt: number | null;
  error: string | null;
  stale: boolean;
}

/**
 * 섹션 데이터를 가져온다.
 * 캐시가 유효하면 즉시 반환하고, 만료됐으면 갱신을 기다린다.
 * 단, 기존 데이터가 있으면 백그라운드로만 갱신하고 이전 값을 즉시 돌려준다.
 */
export async function getSection(section: SectionName, client: KiwoomClient): Promise<SectionResult> {
  const entry = getEntry(section);
  const age = Date.now() - entry.updatedAt;
  const expired = age > SECTION_TTL_MS[section];

  if (entry.data === null) {
    // 첫 조회는 결과를 기다린다
    await refresh(section, client);
  } else if (expired) {
    // 이미 값이 있으면 이전 값을 즉시 주고 뒤에서 갱신
    void refresh(section, client);
  }

  const latest = getEntry(section);
  return {
    data: latest.data,
    updatedAt: latest.updatedAt || null,
    error: latest.error,
    stale: Date.now() - latest.updatedAt > SECTION_TTL_MS[section],
  };
}

export const SECTION_NAMES = Object.keys(SECTION_TTL_MS) as SectionName[];

// ---------------------------------------------------------------- 프로그램 매매

export interface ProgramRow {
  time: string; // 시간대별은 HHmmss, 일자별은 YYYYMMDDHHmmss
  arbSell: number; // 차익거래 매도
  arbBuy: number; // 차익거래 매수
  arbNet: number; // 차익거래 순매수
  nonArbSell: number; // 비차익거래 매도
  nonArbBuy: number; // 비차익거래 매수
  nonArbNet: number; // 비차익거래 순매수
  allSell: number;
  allBuy: number;
  allNet: number;
}

const MRKT_CODE = { kospi: "P001_AL01", kosdaq: "P101_AL02" } as const;

function mapProgramRows(rows: Row[]): ProgramRow[] {
  return rows.map((r) => ({
    time: String(r.cntr_tm ?? ""),
    arbSell: toNum(r.dfrt_trde_sel),
    arbBuy: toNum(r.dfrt_trde_buy),
    arbNet: toNum(r.dfrt_trde_netprps),
    nonArbSell: toNum(r.ndiffpro_trde_sel),
    nonArbBuy: toNum(r.ndiffpro_trde_buy),
    nonArbNet: toNum(r.ndiffpro_trde_netprps),
    allSell: toNum(r.all_sel),
    allBuy: toNum(r.all_buy),
    allNet: toNum(r.all_netprps),
  }));
}

const programCache = new Map<string, { data: ProgramRow[]; at: number }>();
const PROGRAM_TTL_MS = 60_000;

/**
 * 프로그램 매매 추이.
 * scope="time"  → ka90005 시간대별 (당일)
 * scope="daily" → ka90010 일자별
 */
export async function getProgramTrades(
  client: KiwoomClient,
  market: "kospi" | "kosdaq",
  scope: "time" | "daily",
): Promise<ProgramRow[]> {
  const key = `${market}:${scope}`;
  const hit = programCache.get(key);
  if (hit && Date.now() - hit.at < PROGRAM_TTL_MS) return hit.data;

  const apiId = scope === "time" ? "ka90005" : "ka90010";
  const { data } = await client.request<Row>(MRKCOND_RESOURCE, apiId, {
    date: todayYyyymmdd(),
    amt_qty_tp: "1", // 금액(백만원)
    mrkt_tp: MRKT_CODE[market],
    min_tic_tp: "1", // 분
    stex_tp: "1", // KRX — 상세(ka10001)와 기준을 맞춘다. 통합은 마감 후 NXT 값을 준다
  });
  const rows = Array.isArray(data.prm_trde_trnsn) ? (data.prm_trde_trnsn as Row[]) : [];
  const mapped = mapProgramRows(rows);
  programCache.set(key, { data: mapped, at: Date.now() });
  return mapped;
}

// ---------------------------------------------------------------- 구성종목 (테마/업종)

/** 파라미터가 붙는 조회라 섹션 캐시와 분리해서 키별로 캐싱한다 */
const constituentCache = new Map<string, { data: StockRow[]; at: number }>();
/*
 * ⚠️ 3분이었다. 그런데 이 목록에서 종목을 누르면 상세는 **그 자리에서 새로 받는다** —
 * 목록에 −1.2% 로 뜬 종목이 눌러 보면 +0.4% 라 「어느 쪽이 맞냐」가 됐다.
 * 장중에 3분은 너무 길다. 40초면 조회량도 감당되고 눈에 띄는 어긋남도 없다.
 */
const CONSTITUENT_TTL_MS = 40_000;

function mapConstituents(rows: Row[], shares?: Map<string, number>): StockRow[] {
  return rows.map((r) => {
    const code = String(r.stk_cd ?? "");
    const price = toAbsNum(r.cur_prc);
    const cnt = shares?.get(code.replace(/_(AL|NX)$/, ""));
    return {
      code,
      name: String(r.stk_nm ?? ""),
      price,
      change: toNum(r.pred_pre),
      changeRate: toNum(r.flu_rt),
      // 억원 단위. 구성종목 TR에는 시총 필드가 없어 상장주식수 × 현재가로 계산한다
      marketCap: cnt && price > 0 ? Math.round((cnt * price) / 100_000_000) : null,
    };
  });
}

/** 테마 구성종목 (ka90002) */
export async function getThemeStocks(client: KiwoomClient, themeCode: string): Promise<StockRow[]> {
  const key = `theme:${themeCode}`;
  const hit = constituentCache.get(key);
  if (hit && Date.now() - hit.at < CONSTITUENT_TTL_MS) return hit.data;

  const { data } = await client.request<Row>(THME_RESOURCE, "ka90002", {
    date_tp: "1",
    thema_grp_cd: themeCode,
    stex_tp: "1", // KRX — 상세(ka10001)와 기준을 맞춘다. 통합은 마감 후 NXT 값을 준다
  });
  const rows = Array.isArray(data.thema_comp_stk) ? (data.thema_comp_stk as Row[]) : [];
  const mapped = mapConstituents(rows, await getSharesMap(client));
  constituentCache.set(key, { data: mapped, at: Date.now() });
  return mapped;
}

/**
 * 한 업종에서 몇 쪽까지 이어받을지.
 *
 * 키움은 한 쪽에 100건을 준다. 코스피에서 제일 큰 업종이 200종목쯤이고 코스닥
 * 「일반서비스」가 300종목을 넘는다. 다섯 쪽(500종목)이면 다 들어간다.
 */
const SECTOR_PAGES = 5;

/**
 * 업종 구성종목 (ka20002).
 * 문서상 모든 업종코드에 데이터가 제공되지는 않으므로 빈 배열이 나올 수 있다.
 *
 * ## ⚠️ 한 쪽만 받으면 뒤쪽 종목이 통째로 사라진다 (2026-08-25)
 *
 * 연속조회를 안 하고 첫 쪽만 받고 있었다. 키움은 한 쪽에 **100건**을 주므로 종목이
 * 100개 넘는 업종은 **뒤가 잘렸다.** 그런데 이 목록이 전종목 스냅샷의 재료다 —
 * 「모든 종목은 업종 하나에 속하니 업종을 다 훑으면 전종목이 된다」는 전제가
 * 잘린 목록 위에서는 성립하지 않는다.
 *
 * 실제로 무엇이 빠졌나: **KB금융·신한지주·하나금융지주·우리금융지주·한국금융지주·
 * HD현대·GS·한진칼·에코프로비엠·원익IPS·HPSP·솔브레인·한국콜마·에이피알** 등
 * 40종목. 시가총액 상위인데도 자기 업종 목록에서 101번째 뒤였다는 이유로 사라졌다.
 *
 * 그 대가가 큰 자리에서 나왔다:
 *   · 내 테마에 **「시세 없음」** — 화장품은 6종목 중 3개가 빠져 평균이 절반짜리였다
 *   · 섹터 MAP · **업종 강세** — 업종 강세는 **신호등의 한 축**이다
 *
 * 조회가 46회에서 100회 남짓으로 는다. 캐시(40초)와 스냅샷 미리받기가 이미 있어
 * 화면이 기다리는 시간은 그대로다. **빠진 종목을 아무도 모르는 것보다 낫다.**
 */
export async function getSectorStocks(
  client: KiwoomClient,
  market: "kospi" | "kosdaq",
  sectorCode: string,
): Promise<StockRow[]> {
  const key = `sector:${market}:${sectorCode}`;
  const hit = constituentCache.get(key);
  if (hit && Date.now() - hit.at < CONSTITUENT_TTL_MS) return hit.data;

  const rows: Row[] = [];
  let contYn = "N";
  let nextKey = "";
  for (let page = 0; page < SECTOR_PAGES; page += 1) {
    const res = await client.request<Row>(
      SECT_RESOURCE,
      "ka20002",
      {
        mrkt_tp: market === "kospi" ? "0" : "1",
        inds_cd: sectorCode,
        stex_tp: "1", // KRX — 상세(ka10001)와 기준을 맞춘다. 통합은 마감 후 NXT 값을 준다
      },
      page === 0 ? {} : { contYn, nextKey },
    );
    const got = Array.isArray(res.data.inds_stkpc) ? (res.data.inds_stkpc as Row[]) : [];
    if (got.length === 0) break;
    rows.push(...got);
    if (res.contYn !== "Y" || !res.nextKey) break;
    contYn = "Y";
    nextKey = res.nextKey;
  }

  const mapped = mapConstituents(rows, await getSharesMap(client));
  constituentCache.set(key, { data: mapped, at: Date.now() });
  return mapped;
}
