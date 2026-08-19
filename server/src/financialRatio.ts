import { hantooGet, hantooReady } from "./hantooClient.js";

/**
 * 국내주식 재무비율 (한투 `FHKST66430300`).
 *
 * DART 는 재무제표 **원장**을 준다 — 매출·영업이익 같은 금액이다.
 * 여기서 필요한 건 그걸로 계산한 **비율**이다. ROE 와 부채비율은 회사의 체력을 한 줄로 말해 주는데,
 * DART 응답으로 직접 계산하려면 자기자본·총부채 항목을 계정과목 이름으로 찾아 맞춰야 하고
 * 회사마다 이름이 달라 자주 어긋난다. 한투가 이미 계산해서 준다.
 *
 * ⚠️ **`bsop_prfi_inrt`(영업이익 증가율)는 0 이 두 가지 뜻이다.**
 * 문서에 「적자지속, 흑자전환, 적자전환인 경우 0으로 표시」라고 적혀 있다 —
 * 그러니까 0 은 「제자리」일 수도 있고 「흑자전환」일 수도 있다.
 * **판단에 쓰지 않는다.** 영업이익 증가는 DART 금액으로 직접 재는 쪽이 정확하다.
 *
 * 분기(`FID_DIV_CLS_CODE: "1"`)도 되지만 **분기 값은 연단위 누적합산**이다.
 * 단일 분기를 보려면 직전 분기를 빼야 한다. 여기서는 비율만 쓰므로 연간으로 받는다.
 */

const PATH = "/uapi/domestic-stock/v1/finance/financial-ratio";
const TR = "FHKST66430300";

export interface FinanceRatio {
  /** 결산 년월 (YYYYMM) */
  period: string;
  /** ROE (%) — 자기자본으로 얼마나 벌었나 */
  roe: number | null;
  /** 부채비율 (%) — 낮을수록 안전하다 */
  debtRatio: number | null;
  /** 유보비율 (%) */
  reserveRatio: number | null;
  eps: number | null;
  bps: number | null;
  /** 매출액 증가율 (%) */
  salesGrowth: number | null;
}

interface Raw {
  stac_yymm?: string;
  grs?: string;
  roe_val?: string;
  lblt_rate?: string;
  rsrv_rate?: string;
  eps?: string;
  bps?: string;
}

function num(v: unknown): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 재무는 하루에 몇 번 바뀌는 값이 아니다 */
const TTL_MS = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; rows: FinanceRatio[] }>();

/** 최신순으로 돌려준다 */
export async function financeRatios(code: string): Promise<FinanceRatio[]> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.rows;
  if (!hantooReady()) return [];

  const body = await hantooGet<{ output?: Raw[] }>(
    PATH,
    TR,
    {
      fid_cond_mrkt_div_code: "J",
      fid_input_iscd: code,
      FID_DIV_CLS_CODE: "0", // 0: 년
    },
    "재무비율",
  );

  const rows: FinanceRatio[] = (body.output ?? [])
    .map((r) => ({
      period: String(r.stac_yymm ?? "").trim(),
      roe: num(r.roe_val),
      debtRatio: num(r.lblt_rate),
      reserveRatio: num(r.rsrv_rate),
      eps: num(r.eps),
      bps: num(r.bps),
      salesGrowth: num(r.grs),
    }))
    .filter((r) => r.period)
    .sort((a, b) => b.period.localeCompare(a.period));

  cache.set(code, { at: Date.now(), rows });
  return rows;
}

/** 가장 최근 결산 한 줄. 없으면 null */
export async function latestRatio(code: string): Promise<FinanceRatio | null> {
  try {
    const rows = await financeRatios(code);
    return rows[0] ?? null;
  } catch {
    // 신호등 한 칸 때문에 평가가 통째로 멈추면 안 된다
    return null;
  }
}
