import { getMarketSnapshot } from "./marketSnapshot.js";
import { getStockIndex } from "./stockListCache.js";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 순위 한 줄에 **거를 재료**를 얹는다 — 시가총액·거래대금·회전율.
 *
 * ## 왜 따로 뺐나
 *
 * 시세분석의 필터(거래대금·시가총액·회전율)는 **줄마다 그 값이 있어야** 동작한다.
 * 그런데 값을 붙이는 코드가 순위 라우트 한 곳에만 있어서, 같은 화면의 다른 탭
 * (동일 순매매·연속매매)에서는 필터가 통째로 쉬었다 — 화면은 같은데 어떤 탭은 걸리고
 * 어떤 탭은 안 걸리면 그때마다 다시 확인해야 한다.
 *
 * 한 곳에서 만들어 여러 라우트가 같이 쓴다.
 */

/**
 * 키움 숫자 정리.
 *
 * 응답에 `+1234`, `-1,234` 같은 부호·쉼표가 섞여 오고, 드물게 `--1431665` 처럼
 * **부호가 두 번** 붙어 온다(외국계 창구 순매수에서 실제로 나온다).
 * 그냥 Number()에 넣으면 NaN이 되므로 부호를 하나로 접어서 판다.
 */
export function toNum(v: unknown): number | null {
  const raw = String(v ?? "").replace(/[,\s]/g, "");
  if (!raw) return null;
  const m = /^([+-]*)(\d*\.?\d+)$/.exec(raw);
  if (!m) return null;
  // 부호가 여러 개면 개수로 판단한다 (`--` 는 음수 표기의 중복이지 양수가 아니다)
  const negative = (m[1].match(/-/g) ?? []).length > 0;
  const n = Number(m[2]);
  return Number.isFinite(n) ? (negative ? -n : n) : null;
}

/**
 * 종목코드의 접미사를 뗀다 — 우리 기준은 6자리다.
 *
 * ⚠️ `_AL`(통합)만 떼고 있었는데 **NXT 조회는 `_NX` 로 온다.** 그러면 종목을 눌러도
 * `005930_NX` 라는 없는 코드로 열리고, 시가총액을 붙이는 맵도 못 찾는다.
 */
export function bare(code: unknown): string {
  return String(code ?? "").replace(/_(AL|NX)$/, "").trim();
}

/**
 * 순위 한 줄에 **거를 재료**를 얹는다.
 *
 * ## 왜 서버가 붙이나
 *
 * 화면에서 「거래대금 500억 이상, 시가총액 1조 이하」로 좁히려면 그 값이 줄마다
 * 있어야 하는데, **키움 순위 TR 은 시가총액을 안 준다.** 종목마다 `ka10001` 을
 * 부르면 100줄에 20초다.
 *
 * 대신 `ka10099`(종목 목록)를 이미 **하루 캐싱**하고 있고 거기 상장주식수가 있다.
 * 시가총액 = 상장주식수 × 현재가 — 한 번 만든 맵으로 100줄을 즉시 채운다.
 *
 * ## 거래대금은 「있으면 쓰고 없으면 어림」
 *
 * 거래대금 상위(`ka10032`)는 거래대금을 직접 준다(백만원). 다른 순위는 안 준다 —
 * 그때는 **거래량 × 현재가**로 어림하고 `tvEst: true` 로 표시한다. 평균단가가 아니라
 * 현재가로 곱한 값이라 정확하지 않다. **어림값을 정확한 값인 척하면 안 된다.**
 */
export interface RowExtras {
  /** 시가총액(억원). 상장주식수를 못 찾으면 null */
  cap: number | null;
  /** 거래대금(억원) — 고른 거래소 기준. 못 내면 null */
  tv: number | null;
  /**
   * **KRX 몫의 거래대금(억원).** `tv` 는 통합(=KRX+NXT)이다.
   *
   * ## 왜 둘을 다 두나 (2026-08-24 실측)
   *
   * 삼성전자 하루치를 세 갈래로 재 봤다.
   *
   * | 거래소 | 거래대금 | 현재가 |
   * |---|---|---|
   * | KRX | 84,561억 | 257,000 |
   * | NXT | 52,463억 | 256,000 |
   * | **통합** | **137,023억** | 256,000 |
   *
   * 84,561 + 52,463 = 137,024 — **통합의 거래대금은 정확히 합계**다. 하루 거래는
   * NXT 프리(08~09시) + KRX 정규(09~15:30) + NXT 애프터(15:30~20시) 셋이므로 합계가 맞다.
   *
   * 그런데 **가격은 통합이 NXT 최종가**를 준다. 종목 상세는 KRX 라 목록과 상세가 갈렸다.
   *
   * 그래서 **거래대금은 통합, 가격은 KRX** 로 받는다. 둘 다 필요하므로 두 번 부른다.
   */
  tvKrx: number | null;
  /** 거래대금이 어림값인가 (거래량 × 현재가) */
  tvEst: boolean;
  /**
   * **회전율(%)** — 오늘 거래량 ÷ 상장주식수.
   *
   * 거래대금만 보면 큰 종목이 늘 위에 있다. 삼성전자 13조와 소형주 500억은 비교가
   * 안 되는데, 회전율로 보면 **그 종목 치고 얼마나 돌았나**가 나온다. 시가총액이
   * 작은 종목이 회전율 20% 면 주인이 하루에 다섯 번 바뀐 셈이다.
   *
   * 순위 TR 은 회전율을 안 주지만 상장주식수를 이미 갖고 있으므로 여기서 낸다.
   */
  turn: number | null;
  /** 코스피 / 코스닥 */
  mkt: string;
  sector: string;
  /** ETF·ETN·리츠·우선주가 아닌 보통주인가 */
  common: boolean;
}

export function extras(
  row: Record<string, unknown>,
  entry: { marketName: string; sectorName: string; shares: number; code: string } | undefined,
): RowExtras {
  const price = Math.abs(toNum(row.cur_prc) ?? 0);
  const qty = toNum(row.now_trde_qty) ?? toNum(row.trde_qty) ?? 0;
  const prica = toNum(row.trde_prica);
  const shares = entry?.shares ?? 0;
  const listed = entry?.marketName === "거래소" || entry?.marketName === "코스닥";
  return {
    cap: shares > 0 && price > 0 ? Math.round((shares * price) / 1e8) : null,
    // 키움이 주는 거래대금은 백만원 단위다 (100 백만원 = 1억원)
    tv: prica !== null ? Math.round(prica / 100) : qty > 0 && price > 0 ? Math.round((qty * price) / 1e8) : null,
    tvEst: prica === null,
    tvKrx: null,
    turn: shares > 0 && qty > 0 ? (qty / shares) * 100 : null,
    mkt: entry?.marketName === "거래소" ? "코스피" : entry?.marketName === "코스닥" ? "코스닥" : "",
    sector: entry?.sectorName ?? "",
    // 끝자리가 0 이 아니면 우선주다 (stockListCache 의 판별과 같은 근거)
    common: listed && String(entry?.code ?? "").replace(/_(AL|NX)$/, "").endsWith("0"),
  };
}


/**
 * 목록에 재료를 붙인다 — 종목 목록(하루 캐싱)에서 상장주식수를 찾아 쓴다.
 *
 * 목록을 못 받아도 순위 자체는 나와야 하므로 실패하면 빈 맵으로 간다.
 */
export async function attachExtras(
  client: KiwoomClient,
  rows: Record<string, unknown>[],
  codeKey = "stk_cd",
): Promise<Record<string, unknown>[]> {
  const index = await getStockIndex(client).catch(() => new Map());
  /*
   * ⚠️ **현재가를 안 주는 조회가 있다.**
   *
   * 연속매매(`ka10131`)는 순매수 수량·금액과 기간 등락률만 준다 — 현재가도 거래량도
   * 없다. 시가총액은 상장주식수 × **현재가**라 그것만으로는 못 낸다.
   *
   * 시황 스냅샷이 종목별 현재가와 시가총액을 이미 들고 있으므로(40초 캐시) 거기서
   * 메운다. 거래대금·회전율은 **거래량이 있어야** 하는데 스냅샷에도 없어서 못 낸다 —
   * 그건 화면이 「이 조회는 그 값을 안 준다」고 적는다.
   */
  const snap = await getMarketSnapshot(client).catch(() => null);
  return rows.map((r) => {
    const code = bare(r[codeKey]);
    const got = extras(r, index.get(code));
    if (got.cap === null && snap) {
      const s = snap.byCode.get(code);
      if (s?.marketCap != null && s.marketCap > 0) got.cap = s.marketCap;
    }
    return { ...r, code, ...got };
  });
}
