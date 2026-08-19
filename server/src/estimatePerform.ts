import { hantooGet, hantooReady } from "./hantooClient.js";

/**
 * 종목추정실적 (한투 `HHKST668300C0`).
 *
 * 실적은 **지나간 것**이다. 1분기 숫자를 8월에 보고 있으면 이미 늦다.
 * 이건 애널리스트들이 **앞으로**를 어떻게 보는지다 — 올해와 내년 매출·영업이익 추정.
 *
 * ## 알아 둘 것 둘 (문서에 적혀 있다)
 *
 * 1. **160여 개 기업만 있다.** "리서치본부에서 매월 발표되는 거래소·코스닥 160여개 기업에 한정".
 *    중소형주는 대개 빈다 — 없는 게 정상이므로 없다고 오류를 내면 안 된다.
 * 2. **당월 초 기준**이다. "월중 변동 사항이 있을 수 있음". 어제 나온 실적이 반영돼 있지 않을 수 있다.
 *
 * ## 응답이 전치돼 있다
 *
 * 흔한 모양이 아니다. `output4` 가 결산년월 다섯 개(열)이고,
 * `output2` 는 **여섯 줄**이 각각 매출액·매출액증감율·영업이익·영업이익증감율·순이익·순이익증감율이며
 * 각 줄의 `data1~data5` 가 그 다섯 연도에 대응한다. 즉 표를 세로로 눕혀서 준다.
 *
 * ## 증감율 단위 — 검산해서 확인했다
 *
 * 문서에 `(0.1%)` 라고만 적혀 있어 애매했다. 예시로 맞춰 봤다 —
 * 매출 2,796,048 → 3,022,314 은 **+8.09%** 인데 증감율 칸은 `81.0` 이었다.
 * **10 을 곱해서 주는 것**이 맞다. 그래서 10 으로 나눈다.
 * ROE·부채비율도 같은 표기라 똑같이 나눈다.
 */

const PATH = "/uapi/domestic-stock/v1/quotations/estimate-perform";
const TR = "HHKST668300C0";

export interface EstimateColumn {
  /** 결산년월 (YYYYMM 또는 YYYY/MM(E)) */
  period: string;
  /** 억원 */
  revenue: number | null;
  /** % */
  revenueGrowth: number | null;
  operatingProfit: number | null;
  operatingGrowth: number | null;
  netIncome: number | null;
  netGrowth: number | null;
  /** % */
  roe: number | null;
  /** % */
  debtRatio: number | null;
  /** 배 */
  per: number | null;
  eps: number | null;
}

export interface EstimateResult {
  code: string;
  name: string;
  /** 애널리스트 투자의견 */
  opinion: string | null;
  /** 추정 기준일 */
  estimatedAt: string | null;
  columns: EstimateColumn[];
}

interface Row {
  data1?: string;
  data2?: string;
  data3?: string;
  data4?: string;
  data5?: string;
}

function num(v: unknown): number | null {
  const s = String(v ?? "").replace(/,/g, "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** 0.1% 단위로 오는 값 — 검산으로 확인했다 */
function tenth(v: unknown): number | null {
  const n = num(v);
  return n === null ? null : n / 10;
}

function col(rows: Row[], i: number, key: keyof Row): unknown {
  return rows[i]?.[key];
}

const TTL_MS = 6 * 60 * 60_000;
const cache = new Map<string, { at: number; data: EstimateResult | null }>();

export async function estimatePerform(code: string): Promise<EstimateResult | null> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;
  if (!hantooReady()) return null;

  try {
    const body = await hantooGet<{
      output1?: { item_kor_nm?: string; rcmd_name?: string; estdate?: string };
      output2?: Row[];
      output3?: Row[];
      output4?: { dt?: string }[];
    }>(PATH, TR, { SHT_CD: code }, "종목추정실적");

    const periods = (body.output4 ?? []).map((r) => String(r.dt ?? "").trim());
    const o2 = body.output2 ?? [];
    const o3 = body.output3 ?? [];
    if (periods.length === 0 || o2.length === 0) {
      // 160여 개 밖의 종목은 그냥 없다. 오류가 아니다
      cache.set(code, { at: Date.now(), data: null });
      return null;
    }

    const keys: (keyof Row)[] = ["data1", "data2", "data3", "data4", "data5"];
    const columns: EstimateColumn[] = periods.slice(0, 5).map((period, i) => {
      const k = keys[i];
      return {
        period,
        revenue: num(col(o2, 0, k)),
        revenueGrowth: tenth(col(o2, 1, k)),
        operatingProfit: num(col(o2, 2, k)),
        operatingGrowth: tenth(col(o2, 3, k)),
        netIncome: num(col(o2, 4, k)),
        netGrowth: tenth(col(o2, 5, k)),
        // output3: EBITDA, EPS, EPS증감율, PER, EV/EBITDA, ROE, 부채비율, 이자보상배율
        eps: num(col(o3, 1, k)),
        per: tenth(col(o3, 3, k)),
        roe: tenth(col(o3, 5, k)),
        debtRatio: tenth(col(o3, 6, k)),
      };
    });

    const data: EstimateResult = {
      code,
      name: String(body.output1?.item_kor_nm ?? "").trim(),
      opinion: String(body.output1?.rcmd_name ?? "").trim() || null,
      estimatedAt: String(body.output1?.estdate ?? "").trim() || null,
      columns,
    };
    cache.set(code, { at: Date.now(), data });
    return data;
  } catch {
    // 추정이 없다고 재무 화면이 막히면 안 된다
    cache.set(code, { at: Date.now(), data: null });
    return null;
  }
}
