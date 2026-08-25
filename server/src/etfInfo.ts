import { recordApiCall } from "./apiUsage.js";

/**
 * ETF 구성종목 (2026-08-25).
 *
 * ## 출처가 왜 네이버인가
 *
 * 키움 REST 의 ETF 묶음(ka40001~ka40010)을 문서로 확인했는데 **구성종목이 없다** —
 * 수익률·NAV·체결뿐이다. 한투는 「ETF 구성종목시세」가 있다는 말이 돌지만 공식
 * 샘플 저장소에 없어 TR 을 확인할 수 없었다(추측 금지). 네이버 모바일 증권의
 * `etfAnalysis` 는 실측으로 통과했고 인증도 필요 없다:
 *
 *   GET https://m.stock.naver.com/api/stock/{code}/etfAnalysis
 *   → etfTop10MajorConstituentAssets[{itemCode,itemName,etfWeight,stockCount}]
 *     + issuerName·etfBaseIndex·totalFee·nav·deviationRate·sectorPortfolioList
 *   (2026-08-25 KODEX 200 실측: 삼성전자 33.59% · SK하이닉스 26.59% …)
 *
 * Top10 + 비중이면 「이 ETF 를 사면 사실상 무엇을 사는 건가」에 답하기엔 충분하다.
 *
 * ## ETF 가 아니면
 *
 * 일반 종목으로 부르면 404 가 온다. 그걸 {etf:false} 로 캐시해 두면 화면이
 * 종목마다 한 번만 물어보고 조용히 탭을 숨길 수 있다.
 */

export interface EtfConstituent {
  code: string;
  name: string;
  /** ETF 안에서의 비중(%) */
  weight: number | null;
}

export interface EtfInfo {
  etf: boolean;
  name?: string;
  issuer?: string;
  baseIndex?: string;
  /** 총보수(%) */
  fee?: number | null;
  nav?: number | null;
  /** 괴리율(%) — 시장가와 NAV 의 차이 */
  deviation?: number | null;
  constituents?: EtfConstituent[];
  /** 섹터 구성 상위 (이름·비중%) */
  sectors?: { name: string; weight: number }[];
}

const cache = new Map<string, { at: number; info: EtfInfo }>();
const TTL = 6 * 3600_000;

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[%,+\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export async function getEtfInfo(code: string): Promise<EtfInfo> {
  const hit = cache.get(code);
  if (hit && Date.now() - hit.at < TTL) return hit.info;

  let info: EtfInfo = { etf: false };
  try {
    const res = await fetch(`https://m.stock.naver.com/api/stock/${code}/etfAnalysis`, {
      headers: { "user-agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) {
      const d = (await res.json()) as Record<string, unknown>;
      const top = Array.isArray(d.etfTop10MajorConstituentAssets)
        ? (d.etfTop10MajorConstituentAssets as Record<string, unknown>[])
        : [];
      if (top.length > 0) {
        const sectors = Array.isArray(d.sectorPortfolioList)
          ? (d.sectorPortfolioList as Record<string, unknown>[])
              .map((s) => ({
                name: String(s.sectorName ?? s.name ?? ""),
                weight: num(s.weight ?? s.ratio) ?? 0,
              }))
              .filter((s) => s.name && s.weight > 0)
              .slice(0, 6)
          : [];
        info = {
          etf: true,
          name: String(d.itemName ?? ""),
          issuer: String(d.issuerName ?? ""),
          baseIndex: String(d.etfBaseIndex ?? ""),
          fee: num(d.totalFee),
          nav: num(d.nav),
          deviation: num(d.deviationRate),
          constituents: top.map((t) => ({
            code: String(t.itemCode ?? ""),
            name: String(t.itemName ?? ""),
            weight: num(t.etfWeight),
          })),
          sectors,
        };
      }
      void recordApiCall("naver", "etfAnalysis", "ok");
    } else {
      // 404 = ETF 가 아니다 — 이것도 답이라 캐시한다
      void recordApiCall("naver", "etfAnalysis", res.status === 404 ? "ok" : "failed");
    }
  } catch {
    void recordApiCall("naver", "etfAnalysis", "failed");
    // 실패는 짧게만 캐시되도록 바로 돌려준다 (아래에서 캐시하지만 TTL 은 같다 —
    // ETF 여부는 바뀌지 않는 값이라 과하게 재시도할 이유가 없다)
  }

  cache.set(code, { at: Date.now(), info });
  if (cache.size > 500) {
    const first = cache.keys().next().value;
    if (first) cache.delete(first);
  }
  return info;
}
