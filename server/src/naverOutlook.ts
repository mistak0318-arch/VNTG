import { recordApiCall } from "./apiUsage.js";

/**
 * **네이버 컨센서스·추정치** (2026-09-24 — 네이버 맞대기에서 「우리에 없는 것」으로 골라낸 셋).
 *
 *   · 미국 종목: 투자의견 평균·목표주가 평균/최고/최저 (`api.stock.naver.com/stock/{SYM.O}/consensus`, 리피니티브)
 *     — 한투 목표주가는 국내만이고 야후 의견은 있으나 최고/최저가 없다.
 *   · 국내 종목: 추정 PER·추정 EPS·목표주가 평균·투자의견 (`integration`) + **다음 해 추정 매출·영업이익·순이익**
 *     (`finance/annual` 의 `isConsensus=Y` 열) + 같은 업종 종목의 오늘 등락(`industryCompareInfo`).
 *
 * 하루에 한 번 바뀌는 값들이라 6시간 캐시. 못 받으면 null — 화면은 그 칸만 비운다.
 */

const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };
const TTL = 6 * 3600_000;
const cache = new Map<string, { at: number; v: unknown }>();

async function nj<T>(url: string, feature: string): Promise<T | null> {
  try {
    const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(8000) });
    void recordApiCall("naver", feature, r.ok ? "ok" : r.status === 404 || r.status === 409 ? "ok" : "failed");
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    void recordApiCall("naver", feature, "failed");
    return null;
  }
}
const num = (v: unknown): number | null => {
  const s = String(v ?? "").replace(/[,+%배원\s]/g, "");
  if (s === "" || s === "N/A" || s === "-") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.v as T;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

/* ───────────────────────── 미국 ───────────────────────── */

export interface UsConsensus {
  /** 리피니티브 코드 (NVDA.O) */
  reuters: string;
  /** 1 매도 ~ 5 적극매수 (네이버·리피니티브 척도 — 야후는 반대다) */
  recommMean: number | null;
  targetMean: number | null;
  targetHigh: number | null;
  targetLow: number | null;
  currency: string;
  /** 집계일 */
  createDate: string;
}

export async function usConsensus(symbol: string): Promise<UsConsensus | null> {
  const sym = symbol.trim().toUpperCase();
  return cached(`usc:${sym}`, async () => {
    /* 네이버 코드: 나스닥은 `.O`(NVDA.O), **NYSE 는 접미 없음**(BE — 실측), 아멕스 `.A`. 순서대로 두드린다 */
    for (const sfx of [".O", "", ".A", ".K"]) {
      const j = await nj<Record<string, unknown>>(`https://api.stock.naver.com/stock/${sym}${sfx}/consensus`, "usConsensus");
      if (!j || !j.reutersCode) continue;
      return {
        reuters: String(j.reutersCode),
        recommMean: num(j.recommMean),
        targetMean: num(j.priceTargetMean),
        targetHigh: num(j.priceTargetHigh),
        targetLow: num(j.priceTargetLow),
        currency: String((j.currencyType as { code?: string } | undefined)?.code ?? "USD"),
        createDate: String(j.createDate ?? ""),
      };
    }
    return null;
  });
}

/* ───────────────────────── 국내 ───────────────────────── */

export interface KrOutlook {
  code: string;
  /** 현재 PER·PBR·배당수익률 (네이버 계산) */
  per: number | null;
  pbr: number | null;
  eps: number | null;
  bps: number | null;
  dividendYield: number | null;
  /** **추정** PER·EPS — 컨센서스 기준 */
  estPer: number | null;
  estEps: number | null;
  /** 목표주가 평균 · 투자의견 평균(1~5, 5 가 적극매수) · 집계일 */
  targetMean: number | null;
  recommMean: number | null;
  consensusDate: string | null;
  /** 다음 해(추정) — 억원 */
  est: { year: string; sales: number | null; op: number | null; net: number | null } | null;
  /** 마지막 실적 해 — 억원. 추정과 견줄 기준 */
  last: { year: string; sales: number | null; op: number | null; net: number | null } | null;
  /** 같은 업종 종목 — 오늘 등락률·시총(억) */
  peers: { code: string; name: string; changeRate: number | null; marketCap: number | null }[];
}

export async function krOutlook(code: string): Promise<KrOutlook | null> {
  const bare = code.replace(/_(AL|NX)$/i, "");
  return cached(`kro:${bare}`, async () => {
    const [integ, fin] = await Promise.all([
      nj<{
        totalInfos?: { code: string; key: string; value: string }[];
        consensusInfo?: { createDate?: string; recommMean?: string; priceTargetMean?: string } | null;
        industryCompareInfo?: { itemCode: string; stockName: string; fluctuationsRatio?: string; compareToPreviousPrice?: { code?: string }; marketValue?: string }[] | null;
      }>(`https://m.stock.naver.com/api/stock/${bare}/integration`, "krIntegration"),
      nj<{ financeInfo?: { trTitleList?: { title: string; key: string; isConsensus: string }[]; rowList?: { title: string; columns: Record<string, { value?: string }> }[] } }>(
        `https://m.stock.naver.com/api/stock/${bare}/finance/annual`,
        "krFinance",
      ),
    ]);
    if (!integ?.totalInfos) return null;
    const t = new Map(integ.totalInfos.map((x) => [x.code, x.value]));
    const byKey = new Map(integ.totalInfos.map((x) => [x.key, x.value]));
    const pick = (codes: string[], keys: string[]) => {
      for (const c of codes) if (t.has(c)) return num(t.get(c));
      for (const k of keys) if (byKey.has(k)) return num(byKey.get(k));
      return null;
    };
    const fi = fin?.financeInfo;
    const titles = fi?.trTitleList ?? [];
    const rows = fi?.rowList ?? [];
    const row = (title: string) => rows.find((r) => r.title === title);
    const cell = (title: string, key: string) => num(row(title)?.columns?.[key]?.value);
    const estCol = titles.find((x) => x.isConsensus === "Y");
    const lastCol = [...titles].reverse().find((x) => x.isConsensus !== "Y");
    const mk = (col: { title: string; key: string } | undefined) =>
      col ? { year: col.title.replace(/\.$/, ""), sales: cell("매출액", col.key), op: cell("영업이익", col.key), net: cell("당기순이익", col.key) } : null;
    const signed = (p: { fluctuationsRatio?: string; compareToPreviousPrice?: { code?: string } }) => {
      const r = num(p.fluctuationsRatio);
      if (r === null) return null;
      const c = String(p.compareToPreviousPrice?.code ?? "");
      return c === "4" || c === "5" ? -Math.abs(r) : Math.abs(r);
    };
    return {
      code: bare,
      per: pick(["per"], ["PER"]),
      pbr: pick(["pbr"], ["PBR"]),
      eps: pick(["eps"], ["EPS"]),
      bps: pick(["bps"], ["BPS"]),
      dividendYield: pick(["dividendYieldRatio", "dividendYield"], ["배당수익률"]),
      estPer: pick(["cnsPer", "estimatedPer"], ["추정PER"]),
      estEps: pick(["cnsEps", "estimatedEps"], ["추정EPS"]),
      targetMean: num(integ.consensusInfo?.priceTargetMean),
      recommMean: num(integ.consensusInfo?.recommMean),
      consensusDate: integ.consensusInfo?.createDate ?? null,
      est: mk(estCol),
      last: mk(lastCol),
      peers: (integ.industryCompareInfo ?? [])
        .filter((p) => p.itemCode !== bare)
        .slice(0, 6)
        .map((p) => ({ code: p.itemCode, name: p.stockName, changeRate: signed(p), marketCap: num(p.marketValue) })),
    };
  });
}
