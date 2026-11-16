import { getCorpCode } from "./newsDisclosure.js";
import { recordApiCall } from "./apiUsage.js";

/**
 * **분기 손익 — DART 로** (2026-11-17).
 *
 * 한투가 2026-11-11 에 [국내주식] 종목분석 7종을 **영구 종료**했다(데이터 라이선스).
 * 그중 손익계산서가 분기 실적의 유일한 출처였다 — 조건검색의 분기 칸 다섯과 종목
 * 상세의 분기 표가 그날로 멎었다.
 *
 * `dartFinance.ts` 머리말이 이미 길을 적어 뒀다: 「분기까지 필요해지면 11012(반기)·
 * 11013(1분기)·11014(3분기)를 추가한다」. 그대로 한다 — **이미 쓰는 길**이라 키도
 * 한도도 그대로다.
 *
 * ## ⚠️ DART 는 한투와 다르다 — 실측으로 알았다
 *
 * 한투 손익계산서는 「분기데이터는 연단위 누적합산」이었다. **DART 는 아니다.**
 * 처음에 같은 줄 알고 앞 분기를 빼 봤더니 삼성전기가 이렇게 나왔다:
 *
 *     2026 2Q 매출 3,648억 (1Q 는 33,529억)
 *     2025 3Q 매출 **-1,206억**        ← 음수 매출
 *     이익률 42.1% · -172.8%
 *
 * 숫자가 말이 안 돼서 다시 셌다. 더해 보니 답이 나왔다:
 *
 *     2025  1Q 34,897 + 2Q 35,119 + 3Q 33,913 = 103,929억
 *           사업보고서(연간) 139,298 - 103,929 = **35,369억**  ← 4Q 로 딱 맞는다
 *     영업익 2,685+2,301+2,323 = 7,309 → 9,571-7,309 = **2,262억**  ← 역시 맞는다
 *
 * 즉 **분기보고서(11013·11012·11014)는 이미 그 분기만의 값**이고, **사업보고서(11011)만
 * 연간**이다. 그러니 되돌릴 것은 **4분기 하나뿐**이다:
 *
 *     1Q = 11013 그대로
 *     2Q = 11012 그대로
 *     3Q = 11014 그대로
 *     4Q = 11011(연간) - (1Q+2Q+3Q)
 *
 * ⚠️ 그래서 **네 분기가 다 있어야 4Q 를 낸다.** 하나라도 빠지면 4Q 는 안 적는다 —
 * 모자란 합을 연간에서 빼면 그만큼 부풀려진 가짜 4Q 가 나온다.
 *
 * ## ⚠️ 한투보다 늦다
 *
 * 분기보고서는 분기 끝나고 **45일**까지 제출이다(사업보고서는 90일). 한투는 그보다
 * 빨랐다. 없는 것보다 낫지만 **「최신이 아닐 수 있다」가 기본값**이라, 가장 최근 분기가
 * 비어 있는 것은 고장이 아니라 **아직 안 나온 것**이다.
 *
 * ## 조회 수
 *
 * 한 해에 네 번(11013·11012·11014·11011), 두 해면 여덟 번. DART 는 하루 2만 건이라
 * 넉넉하고, 재무는 분기에 한 번 바뀌므로 **12시간 캐시**로 충분하다.
 */

const DART_BASE = "https://opendart.fss.or.kr/api";

/** 그 해의 누적 지점 넷 — 뒤로 갈수록 많이 담고 있다 */
const REPORTS = [
  { code: "11013", q: 1 }, // 1분기보고서 = 1Q 그대로
  { code: "11012", q: 2 }, // 반기보고서  = 2Q 그대로
  { code: "11014", q: 3 }, // 3분기보고서 = 3Q 그대로
  { code: "11011", q: 4 }, // 사업보고서  = **연간**. 셋을 빼야 4Q 가 된다
] as const;

interface Row {
  fs_div?: string;
  sj_div?: string;
  account_nm?: string;
  thstrm_amount?: string;
}

/**
 * 보고서 한 건에서 뽑은 값 — 억원.
 *
 * ⚠️ `q` 가 1·2·3 이면 **그 분기만의 값**이고, 4 면 **그 해 연간**이다(위 머리말).
 */
interface Rep {
  year: number;
  q: number;
  revenue: number | null;
  operatingProfit: number | null;
  netIncome: number | null;
}

/** DART 금액은 원 단위 문자열이고 음수가 괄호로 오기도 한다 */
function amount(v: string | undefined): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s || s === "-") return null;
  const neg = /^\(.*\)$/.test(s);
  const n = Number(s.replace(/[()]/g, ""));
  if (!Number.isFinite(n)) return null;
  /* 억원으로 — 화면과 조건식이 전부 억원이다 */
  return Math.round(((neg ? -n : n) / 1e8) * 10) / 10;
}

const REVENUE_NAMES = ["매출액", "수익(매출액)", "영업수익"];
const OP_NAMES = ["영업이익", "영업이익(손실)"];
const NET_NAMES = ["당기순이익", "당기순이익(손실)"];

function pick(rows: Row[], names: string[]): number | null {
  for (const name of names) {
    const hit = rows.find((r) => r.sj_div === "IS" && (r.account_nm ?? "").replace(/\s/g, "") === name);
    if (hit) {
      const v = amount(hit.thstrm_amount);
      if (v !== null) return v;
    }
  }
  return null;
}

async function fetchCum(corpCode: string, year: number, reprt: string): Promise<Row[] | null> {
  const key = process.env.DART_API_KEY;
  const url =
    `${DART_BASE}/fnlttSinglAcnt.json?crtfc_key=${key}&corp_code=${corpCode}` +
    `&bsns_year=${year}&reprt_code=${reprt}`;
  const res = await fetch(url);
  if (!res.ok) {
    void recordApiCall("dart", "fnlttSinglAcnt:quarter", "failed");
    return null;
  }
  void recordApiCall("dart", "fnlttSinglAcnt:quarter", "ok");
  const body = (await res.json()) as { status?: string; list?: Row[] };
  /* 013 = 아직 그 보고서가 없다. 고장이 아니라 **안 나온 것**이다 */
  if (body.status !== "000") return null;
  const list = body.list ?? [];
  /* 연결 우선, 없으면 별도 — `dartFinance` 와 같은 규칙이라야 두 화면이 안 어긋난다 */
  const cfs = list.filter((r) => r.fs_div === "CFS");
  return cfs.length > 0 ? cfs : list.filter((r) => r.fs_div === "OFS");
}

/** 그 해의 보고서 넷을 모은다 — 아직 안 나온 것은 건너뛴다 */
async function yearReports(corpCode: string, year: number): Promise<Rep[]> {
  const out: Rep[] = [];
  for (const r of REPORTS) {
    const rows = await fetchCum(corpCode, year, r.code);
    if (!rows || rows.length === 0) continue;
    out.push({
      year,
      q: r.q,
      revenue: pick(rows, REVENUE_NAMES),
      operatingProfit: pick(rows, OP_NAMES),
      netIncome: pick(rows, NET_NAMES),
    });
  }
  return out;
}

export interface DartQuarter {
  /** YYYYMM — 그 분기의 마지막 달 (1Q=03, 2Q=06, 3Q=09, 4Q=12) */
  period: string;
  year: number;
  quarter: number;
  /** 그 분기만의 값. 억원 */
  revenue: number | null;
  operatingProfit: number | null;
  netIncome: number | null;
  /**
   * 예전에는 「앞 분기를 못 구해 누적인 채」를 뜻했다. DART 에서는 **늘 false** 다 —
   * 1~3Q 는 처음부터 단일 분기이고, 4Q 는 셋이 다 있을 때만 내기 때문이다.
   * 칸은 남긴다: `QuarterRow` 가 이 뜻으로 증감률을 끄고, 다른 출처가 붙으면 다시 쓴다.
   */
  cumulative: boolean;
}

const cache = new Map<string, { at: number; rows: DartQuarter[] }>();
/* 재무는 분기에 한 번 바뀐다 — 길게 */
const TTL_MS = 12 * 3600_000;

/**
 * 최근 분기가 앞. 최대 여덟 분기(2년).
 *
 * 1~3Q 는 보고서가 준 값 그대로다. **4Q 만** `연간 − (1Q+2Q+3Q)` 로 낸다 —
 * 셋 중 하나라도 없으면 **4Q 를 아예 안 적는다**(모자란 합을 빼면 가짜로 부풀려진다).
 */
export async function dartQuarters(stockCode: string, limit = 8): Promise<DartQuarter[]> {
  const hit = cache.get(stockCode);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows.slice(0, limit);
  if (!process.env.DART_API_KEY) return [];

  const corpCode = await getCorpCode(stockCode);
  if (!corpCode) return [];

  const thisYear = new Date().getFullYear();
  const reps: Rep[] = [];
  for (const y of [thisYear, thisYear - 1, thisYear - 2]) {
    reps.push(...(await yearReports(corpCode, y)));
  }

  const out: DartQuarter[] = [];
  for (const c of reps) {
    /* 1~3Q 는 그대로 */
    if (c.q !== 4) {
      out.push({
        period: `${c.year}${String(c.q * 3).padStart(2, "0")}`,
        year: c.year,
        quarter: c.q,
        revenue: c.revenue,
        operatingProfit: c.operatingProfit,
        netIncome: c.netIncome,
        cumulative: false,
      });
      continue;
    }
    /* 4Q = 연간 − 앞 셋. 셋이 다 있을 때만 */
    const q1 = reps.find((x) => x.year === c.year && x.q === 1);
    const q2 = reps.find((x) => x.year === c.year && x.q === 2);
    const q3 = reps.find((x) => x.year === c.year && x.q === 3);
    if (!q1 || !q2 || !q3) continue;
    const minus = (yr: number | null, a: number | null, b: number | null, d: number | null): number | null =>
      yr === null || a === null || b === null || d === null ? null : Math.round((yr - a - b - d) * 10) / 10;
    out.push({
      period: `${c.year}12`,
      year: c.year,
      quarter: 4,
      revenue: minus(c.revenue, q1.revenue, q2.revenue, q3.revenue),
      operatingProfit: minus(c.operatingProfit, q1.operatingProfit, q2.operatingProfit, q3.operatingProfit),
      netIncome: minus(c.netIncome, q1.netIncome, q2.netIncome, q3.netIncome),
      cumulative: false,
    });
  }

  /* 최근이 앞 */
  out.sort((a, b) => b.period.localeCompare(a.period));
  cache.set(stockCode, { at: Date.now(), rows: out });
  return out.slice(0, limit);
}
