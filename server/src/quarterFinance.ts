import { hantooGet, hantooReady } from "./hantooClient.js";

/**
 * 분기 손익 (한투 `FHKST66430200`).
 *
 * DART 는 사업보고서 기준이라 **연간**이 마지막이다 — 8월에도 마지막 줄이 작년이다.
 * 그래서 "지금 이 회사가 벌고 있나"를 볼 수가 없었다. 한투가 분기를 준다.
 *
 * ## ⚠️ 누적합산 — 이 파일이 존재하는 이유
 *
 * 문서에 이렇게 적혀 있다: **「분기데이터는 연단위 누적합산」**.
 * 즉 3분기 값이 그 분기 실적이 아니라 **1~3분기를 더한 값**이다.
 *
 * 이걸 모르고 그대로 그리면 **매 분기 우상향하는 가짜 그래프**가 나온다 —
 * 실적이 반토막 난 회사도 누적이니까 계속 올라간다. 그래서 여기서
 * **직전 분기를 빼서 단일 분기로 되돌린다.** 1분기는 누적이 곧 그 분기라 그대로 둔다.
 *
 * 되돌린 값은 음수가 나올 수 있다 — 적자 분기다. 그건 사실이므로 그대로 둔다.
 */

const PATH = "/uapi/domestic-stock/v1/finance/income-statement";
const TR = "FHKST66430200";

export interface QuarterRow {
  /** 결산 년월 (YYYYMM) */
  period: string;
  /** 표시용 — 2026 3Q */
  label: string;
  /** 그 분기만의 값 (누적을 되돌린 것). 단위는 억원 */
  revenue: number | null;
  operatingProfit: number | null;
  netIncome: number | null;
  /** 영업이익률 (%) */
  margin: number | null;
  /** 직전 분기 대비 영업이익 증감률 (%) */
  qoq: number | null;
  /** 1년 전 같은 분기 대비 영업이익 증감률 (%) */
  yoy: number | null;
}

interface Raw {
  stac_yymm?: string;
  sale_account?: string;
  bsop_prti?: string;
  thtr_ntin?: string;
}

function num(v: unknown): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 결산년월(YYYYMM)에서 몇 분기인지. 03→1, 06→2, 09→3, 12→4 */
function quarterOf(period: string): number | null {
  const m = Number(period.slice(4, 6));
  if (!Number.isFinite(m) || m < 1 || m > 12) return null;
  return Math.ceil(m / 3);
}

function pctChange(now: number | null, before: number | null): number | null {
  if (now === null || before === null || before === 0) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

const TTL_MS = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; rows: QuarterRow[] }>();

/** 최근 분기가 앞. 최대 여덟 분기(2년) */
export async function quarterFinance(code: string, limit = 8): Promise<QuarterRow[]> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows.slice(0, limit);
  if (!hantooReady()) return [];

  const body = await hantooGet<{ output?: Raw[] }>(
    PATH,
    TR,
    {
      fid_cond_mrkt_div_code: "J",
      fid_input_iscd: code,
      FID_DIV_CLS_CODE: "1", // 1: 분기 (연단위 누적합산으로 온다)
    },
    "분기 손익",
  );

  // 누적을 되돌리려면 **오래된 것부터** 훑어야 한다
  const asc = (body.output ?? [])
    .map((r) => ({
      period: String(r.stac_yymm ?? "").trim(),
      revenue: num(r.sale_account),
      operatingProfit: num(r.bsop_prti),
      netIncome: num(r.thtr_ntin),
    }))
    .filter((r) => /^\d{6}$/.test(r.period))
    .sort((a, b) => a.period.localeCompare(b.period));

  /** 같은 회계연도의 직전 분기를 찾아 뺀다 */
  const single = asc.map((cur, i) => {
    const q = quarterOf(cur.period);
    // 1분기는 누적이 곧 그 분기다. 분기를 못 읽으면 건드리지 않는다
    if (q === null || q === 1) return { ...cur };
    const prev = asc[i - 1];
    const sameYear = prev && prev.period.slice(0, 4) === cur.period.slice(0, 4);
    // 직전 줄이 같은 해가 아니면(자료가 빠진 것) 되돌릴 수 없다 — 건드리지 않고 그대로 둔다
    if (!sameYear) return { ...cur };
    const back = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
    return {
      period: cur.period,
      revenue: back(cur.revenue, prev.revenue),
      operatingProfit: back(cur.operatingProfit, prev.operatingProfit),
      netIncome: back(cur.netIncome, prev.netIncome),
    };
  });

  const rows: QuarterRow[] = single.map((r, i) => {
    const q = quarterOf(r.period);
    // 1년 전 같은 분기는 네 칸 앞이다 (자료가 이어져 있을 때)
    const yearAgo = single[i - 4];
    const prev = single[i - 1];
    return {
      period: r.period,
      label: `${r.period.slice(0, 4)} ${q ?? "?"}Q`,
      revenue: r.revenue,
      operatingProfit: r.operatingProfit,
      netIncome: r.netIncome,
      margin:
        r.revenue !== null && r.revenue !== 0 && r.operatingProfit !== null
          ? (r.operatingProfit / r.revenue) * 100
          : null,
      qoq: pctChange(r.operatingProfit, prev?.operatingProfit ?? null),
      yoy: pctChange(r.operatingProfit, yearAgo?.operatingProfit ?? null),
    };
  });

  // 화면은 최근 것부터 본다
  rows.reverse();
  cache.set(code, { at: Date.now(), rows });
  return rows.slice(0, limit);
}
