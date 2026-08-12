import { recordApiCall } from "./apiUsage.js";
import { getCorpCode } from "./newsDisclosure.js";

/**
 * DART 재무 정보 (재무제표 3년치 + 배당).
 *
 * fnlttSinglAcnt는 한 번 호출로 당기/전기/전전기 3개년을 함께 주므로
 * 연도별로 반복 호출할 필요가 없다.
 */

const DART_BASE = "https://opendart.fss.or.kr/api";

/** 사업보고서(연간). 분기까지 필요해지면 11012(반기)·11013(1분기)·11014(3분기)를 추가한다 */
const ANNUAL_REPORT = "11011";

type Row = Record<string, string>;

/** "333,605,938,000,000" -> 333605938000000 (빈 값·"-"는 null) */
function parseAmount(v: string | undefined): number | null {
  if (!v) return null;
  const cleaned = v.replace(/,/g, "").trim();
  if (!cleaned || cleaned === "-") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export interface FinancialPeriod {
  /** 표시용 라벨 (예: 2025) */
  label: string;
  revenue: number | null; // 매출액
  operatingProfit: number | null; // 영업이익
  netIncome: number | null; // 당기순이익
  assets: number | null; // 자산총계
  liabilities: number | null; // 부채총계
  equity: number | null; // 자본총계
}

export interface DividendInfo {
  yieldRate: number | null; // 현금배당수익률(%)
  perShare: number | null; // 주당 현금배당금(원)
  payoutRatio: number | null; // 현금배당성향(%)
  eps: number | null; // 주당순이익(원)
}

export interface FinanceResult {
  /** 연결(CFS) 기준인지 별도(OFS) 기준인지 */
  basis: "연결" | "별도" | null;
  /** 과거→최근 순 */
  periods: FinancialPeriod[];
  dividend: DividendInfo | null;
  note: string | null;
}

const cache = new Map<string, { data: FinanceResult; at: number }>();
const TTL_MS = 12 * 3600 * 1000; // 재무는 분기에 한 번 바뀌므로 길게 캐싱

/** 계정명이 회사마다 조금씩 달라서 후보를 순서대로 찾는다 */
function findAmount(rows: Row[], sjDiv: string, names: string[], field: keyof Row): number | null {
  for (const name of names) {
    const hit = rows.find((r) => r.sj_div === sjDiv && (r.account_nm ?? "").replace(/\s/g, "") === name);
    if (hit) {
      const v = parseAmount(hit[field]);
      if (v !== null) return v;
    }
  }
  return null;
}

const REVENUE_NAMES = ["매출액", "수익(매출액)", "영업수익"];
const OP_NAMES = ["영업이익", "영업이익(손실)"];
const NET_NAMES = ["당기순이익", "당기순이익(손실)"];
const ASSET_NAMES = ["자산총계"];
const LIAB_NAMES = ["부채총계"];
const EQUITY_NAMES = ["자본총계"];

function buildPeriods(rows: Row[]): FinancialPeriod[] {
  // 기간 라벨은 thstrm_dt("2025.01.01 ~ 2025.12.31")에서 연도만 뽑는다
  const sample = rows.find((r) => r.sj_div === "IS") ?? rows[0];
  const yearOf = (dt: string | undefined) => (dt ?? "").slice(0, 4) || "-";

  const cols: { field: keyof Row; label: string }[] = [
    { field: "bfefrmtrm_amount", label: yearOf(sample?.bfefrmtrm_dt) },
    { field: "frmtrm_amount", label: yearOf(sample?.frmtrm_dt) },
    { field: "thstrm_amount", label: yearOf(sample?.thstrm_dt) },
  ];

  return cols.map(({ field, label }) => ({
    label,
    revenue: findAmount(rows, "IS", REVENUE_NAMES, field),
    operatingProfit: findAmount(rows, "IS", OP_NAMES, field),
    netIncome: findAmount(rows, "IS", NET_NAMES, field),
    assets: findAmount(rows, "BS", ASSET_NAMES, field),
    liabilities: findAmount(rows, "BS", LIAB_NAMES, field),
    equity: findAmount(rows, "BS", EQUITY_NAMES, field),
  }));
}

async function fetchStatements(
  corpCode: string,
  year: number,
): Promise<{ rows: Row[]; basis: "연결" | "별도" } | null> {
  const key = process.env.DART_API_KEY;
  const url =
    `${DART_BASE}/fnlttSinglAcnt.json?crtfc_key=${key}&corp_code=${corpCode}` +
    `&bsns_year=${year}&reprt_code=${ANNUAL_REPORT}`;

  const res = await fetch(url);
  if (!res.ok) {
    void recordApiCall("dart", "fnlttSinglAcnt", "failed");
    throw new Error(`DART 재무제표 조회 실패: HTTP ${res.status}`);
  }
  void recordApiCall("dart", "fnlttSinglAcnt", "ok");

  const body = (await res.json()) as { status?: string; message?: string; list?: Row[] };
  if (body.status === "013") return null; // 데이터 없음
  if (body.status !== "000") throw new Error(`DART 오류(${body.status}): ${body.message ?? ""}`);

  const list = body.list ?? [];
  // 연결재무제표를 우선 쓰고, 없으면 별도재무제표를 쓴다 (지주사·소형주는 CFS가 없기도 함)
  const cfs = list.filter((r) => r.fs_div === "CFS");
  if (cfs.length > 0) return { rows: cfs, basis: "연결" };
  const ofs = list.filter((r) => r.fs_div === "OFS");
  if (ofs.length > 0) return { rows: ofs, basis: "별도" };
  return null;
}

async function fetchDividend(corpCode: string, year: number): Promise<DividendInfo | null> {
  const key = process.env.DART_API_KEY;
  const url =
    `${DART_BASE}/alotMatter.json?crtfc_key=${key}&corp_code=${corpCode}` +
    `&bsns_year=${year}&reprt_code=${ANNUAL_REPORT}`;

  const res = await fetch(url);
  if (!res.ok) {
    void recordApiCall("dart", "alotMatter", "failed");
    return null;
  }
  void recordApiCall("dart", "alotMatter", "ok");

  const body = (await res.json()) as { status?: string; list?: Row[] };
  if (body.status !== "000") return null;

  const list = body.list ?? [];
  // 보통주 기준으로 고른다 (우선주 행이 함께 오므로)
  const pick = (seName: string) => {
    const common = list.find(
      (r) => (r.se ?? "").replace(/\s/g, "").startsWith(seName) && r.stock_knd === "보통주",
    );
    const any = list.find((r) => (r.se ?? "").replace(/\s/g, "").startsWith(seName));
    return parseAmount((common ?? any)?.thstrm);
  };

  return {
    yieldRate: pick("현금배당수익률"),
    perShare: pick("주당현금배당금"),
    payoutRatio: pick("(연결)현금배당성향") ?? pick("현금배당성향"),
    eps: pick("(연결)주당순이익") ?? pick("주당순이익"),
  };
}

export async function getFinance(stockCode: string): Promise<FinanceResult> {
  const hit = cache.get(stockCode);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  if (!process.env.DART_API_KEY) throw new Error("DART_API_KEY 환경변수가 설정되지 않았습니다.");

  const corpCode = await getCorpCode(stockCode);
  if (!corpCode) {
    const empty: FinanceResult = {
      basis: null,
      periods: [],
      dividend: null,
      note: "DART에 등록되지 않은 종목입니다 (ETF·ETN 등).",
    };
    cache.set(stockCode, { data: empty, at: Date.now() });
    return empty;
  }

  // 사업보고서는 이듬해 3월경 공시되므로, 최근 연도부터 거슬러 올라가며 찾는다
  const thisYear = new Date().getFullYear();
  let statements: Awaited<ReturnType<typeof fetchStatements>> = null;
  let usedYear = thisYear - 1;
  for (const year of [thisYear - 1, thisYear - 2]) {
    statements = await fetchStatements(corpCode, year);
    if (statements) {
      usedYear = year;
      break;
    }
  }

  if (!statements) {
    const empty: FinanceResult = {
      basis: null,
      periods: [],
      dividend: null,
      note: "최근 사업보고서를 찾지 못했습니다.",
    };
    cache.set(stockCode, { data: empty, at: Date.now() });
    return empty;
  }

  const dividend = await fetchDividend(corpCode, usedYear);

  const result: FinanceResult = {
    basis: statements.basis,
    periods: buildPeriods(statements.rows),
    dividend,
    note: null,
  };
  cache.set(stockCode, { data: result, at: Date.now() });
  return result;
}
