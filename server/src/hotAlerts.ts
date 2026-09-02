import { loadCloses } from "./dailyCloses.js";

/**
 * **경보 태그** (2026-09-02 저녁) — 「쏠림」과 「늦음」. 점수를 깎지 않는다. 화면에 표시만.
 *
 * 벤티지: "신호등은 … 후보들을 기준으로 검증하려고 하는 거야. 정말 괜찮은 애들만
 * 추려줘야 하는 거지." → 재검토 4·5부에서 초록 안에서도 갈리는 지표 여덟을 찾았다
 * (`docs/신호등_전면재검토_260902.md` 4-3, `tools/sigtune/sigtune4.mts`·`sigtune5.mts`).
 * 시총 중립 exs20, 강·약·앞·뒤 넷 다 같은 방향:
 *
 *   쏠림 (장세 무관 — 강세장에서도 빼면 +4.0 → +7.4)
 *     회전율 ≥3% (거래대금÷시총)   1%↑부터 ❌, 15%↑ -3.0/41
 *     그날 진폭 ≥12%              8%↑ ❌, 12%↑ -2.2/44
 *     거래량 ≥ 20일 평균의 2.5배   2.5↑ ❌ (0.4↓ 죽은 종목도 ❌)
 *     시가 갭 ≥3%                 -1.6~-2.2 ❌
 *     변동성 σ20 ≥7%              -3.6/40 ❌ (5~7 도 -0.9)
 *   늦음 (약세장만 — 강세장에선 빼면 손해 +4.0 → +3.3: 오르는 애는 계속 오른다)
 *     상대강도 20일 ≥ +20%p        -2.9/44, 뒤쪽 -7.2
 *     상대강도 60일 ≥ +30%p        -3.6/42
 *     60일 저점 대비 ≥ +50%        -2.6~-3.0, 뒤쪽 -7.7~-9.4
 *
 * 세대 3 초록 3,158 에서 이 둘을 빼면 1,614(하루 20개) · +4.5/61 → **+6.7/67** · 20일
 * 블록 넷 전부 +4 이상 · 절대 -0.9(시장 -11). 벤티지가 「탈락 말고 태그」를 골랐다 —
 * 초록은 그대로 두고 눈으로 거른다. 그래서 여기서는 **표시만** 만든다.
 *
 * 전부 일봉(ka10081)·시총·거래대금에서 나온다 — 신호등이 이미 받은 것들이라 조회 0회.
 * 상대강도의 「시장」은 일봉 캐시 전종목의 20·60일 수익률 **중앙값**이다(하루 캐시).
 *
 * ⚠️ 문턱은 2026-04~08 표본으로 고른 값이다. 12월에 다시 잰다.
 */

export interface SignalAlert {
  key: string;
  /** 짧은 표시 — 「회전율 3.4%」 */
  label: string;
  value: number;
}

export interface SignalAlerts {
  /** 쏠림 — 장세 무관 */
  hot: SignalAlert[];
  /** 늦음 — 약세장에서만 채운다 (강세장이면 늘 비어 있다) */
  late: SignalAlert[];
}

/** 일봉 캐시 전종목의 20·60일 수익률 중앙값 — 상대강도의 기준선. builtAt 마다 한 번 */
let mktCache: { builtAt: string; r20: number | null; r60: number | null } | null = null;

export async function marketReturns(): Promise<{ r20: number | null; r60: number | null }> {
  const { closes, builtAt } = await loadCloses();
  if (mktCache && mktCache.builtAt === builtAt) return mktCache;
  const r20: number[] = [];
  const r60: number[] = [];
  for (const arr of Object.values(closes)) {
    const n = arr.length;
    if (n < 61) continue;
    const c0 = arr[n - 1];
    const c20 = arr[n - 21];
    const c60 = arr[n - 61];
    if (c0 > 0 && c20 > 0) r20.push(((c0 - c20) / c20) * 100);
    if (c0 > 0 && c60 > 0) r60.push(((c0 - c60) / c60) * 100);
  }
  const med = (a: number[]) => {
    if (a.length < 100) return null;
    const b = [...a].sort((x, y) => x - y);
    const m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  };
  mktCache = { builtAt, r20: med(r20), r60: med(r60) };
  return mktCache;
}

export interface AlertInput {
  /** 일봉 최신순 — cur_prc·open_pric·high_pric·low_pric·trde_qty (오늘 유령 봉은 이미 뺀 것) */
  chartRows: Record<string, unknown>[];
  /** 그날 거래대금(억) — 0 이면 모른다 */
  tradeEok: number;
  /** 시가총액(억) — 0 이면 모른다 */
  capEok: number;
  regime: "bull" | "bear" | null;
  market: { r20: number | null; r60: number | null };
}

const HOT = { turnover: 3, range: 12, volRatio: 2.5, gap: 3, volat: 7 };
const LATE = { rs20: 20, rs60: 30, lo60: 150 };

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, "").replace(/^--/, "-"));
  return Number.isFinite(n) ? n : 0;
}

export function computeAlerts(input: AlertInput): SignalAlerts {
  const hot: SignalAlert[] = [];
  const late: SignalAlert[] = [];
  const rows = input.chartRows;
  const r1 = (x: number) => Math.round(x * 10) / 10;
  if (rows.length === 0) return { hot, late };

  const closes = rows.map((r) => Math.abs(toNum(r.cur_prc)));
  const cur = closes[0];
  const today = rows[0];

  /* 쏠림 — 오늘 봉 하나로 나오는 것들 */
  if (input.tradeEok > 0 && input.capEok > 0) {
    const t = (input.tradeEok / input.capEok) * 100;
    if (t >= HOT.turnover) hot.push({ key: "turnover", label: `회전율 ${r1(t)}%`, value: t });
  }
  const hi = Math.abs(toNum(today.high_pric));
  const lo = Math.abs(toNum(today.low_pric));
  if (lo > 0 && hi > lo) {
    const range = ((hi - lo) / lo) * 100;
    if (range >= HOT.range) hot.push({ key: "range", label: `진폭 ${r1(range)}%`, value: range });
  }
  if (rows.length >= 21) {
    const v0 = Math.abs(toNum(today.trde_qty));
    const avg = rows.slice(1, 21).reduce((s, r) => s + Math.abs(toNum(r.trde_qty)), 0) / 20;
    if (avg > 0) {
      const ratio = v0 / avg;
      if (ratio >= HOT.volRatio) hot.push({ key: "volRatio", label: `거래량 ${r1(ratio)}배`, value: ratio });
    }
    const open = Math.abs(toNum(today.open_pric));
    const prev = closes[1];
    if (open > 0 && prev > 0) {
      const gap = ((open - prev) / prev) * 100;
      if (gap >= HOT.gap) hot.push({ key: "gap", label: `갭 +${r1(gap)}%`, value: gap });
    }
    const lr: number[] = [];
    for (let k = 0; k < 20; k++) {
      const a = closes[k + 1];
      const b = closes[k];
      if (a > 0 && b > 0) lr.push(Math.log(b / a));
    }
    if (lr.length >= 15) {
      const mean = lr.reduce((s, x) => s + x, 0) / lr.length;
      const sd = Math.sqrt(lr.reduce((s, x) => s + (x - mean) ** 2, 0) / lr.length) * 100;
      if (sd >= HOT.volat) hot.push({ key: "volat", label: `변동성 σ${r1(sd)}%`, value: sd });
    }
  }

  /* 늦음 — 약세장에서만. 강세장에선 오르는 애가 계속 오른다 */
  if (input.regime === "bear" && rows.length >= 61 && cur > 0) {
    const c20 = closes[20];
    const c60 = closes[60];
    if (c20 > 0 && input.market.r20 !== null) {
      const rs = ((cur - c20) / c20) * 100 - input.market.r20;
      if (rs >= LATE.rs20) late.push({ key: "rs20", label: `RS20 +${r1(rs)}%p`, value: rs });
    }
    if (c60 > 0 && input.market.r60 !== null) {
      const rs = ((cur - c60) / c60) * 100 - input.market.r60;
      if (rs >= LATE.rs60) late.push({ key: "rs60", label: `RS60 +${r1(rs)}%p`, value: rs });
    }
    const lo60 = Math.min(...rows.slice(1, 61).map((r) => Math.abs(toNum(r.low_pric))).filter((x) => x > 0));
    if (Number.isFinite(lo60) && lo60 > 0) {
      const pct = (cur / lo60) * 100;
      if (pct >= LATE.lo60) late.push({ key: "lo60", label: `저점 +${Math.round(pct - 100)}%`, value: pct });
    }
  }
  return { hot, late };
}
