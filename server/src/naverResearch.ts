import { recordApiCall } from "./apiUsage.js";

/**
 * **종목별 증권사 리포트** (2026-09-25 — 벤티지: "리서치나 증권사 리포트 가져오는 api 나 소스는 없어?").
 *
 * 네이버 두 창구를 잇는다(둘 다 공개, 키 없음, 조회 0회):
 *   · 목록  `m.stock.naver.com/api/stock/{code}/integration` 의 `researches[]` — id·증권사·제목·조회수·날짜
 *   · 상세  `m.stock.naver.com/api/research/company/{id}` — **본문 요약(HTML)·PDF(attachUrl)·투자의견·목표주가(전→후)·
 *          작성일 주가**. 리서치 메뉴가 쓰는 `stockSecurity/researches/v2/*` 는 종목별 조회가 없다(itemCode 를 무시, 실측).
 *
 * 리포트는 하루 몇 번 안 나오니 목록 1시간·상세 24시간 캐시. 본문은 태그를 걷어 글자만 남긴다.
 */

const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };
const LIST_TTL = 60 * 60_000;
const DETAIL_TTL = 24 * 3600_000;

export interface StockReport {
  id: number;
  broker: string;
  title: string;
  /** YYYY-MM-DD */
  date: string;
  reads: number | null;
  /** Buy · Hold · Sell … 증권사가 적은 그대로 */
  opinion: string | null;
  goal: number | null;
  prevGoal: number | null;
  /** 작성일 주가 — 목표주가와 견줄 기준 */
  priceAt: number | null;
  pdf: string | null;
  /** 본문 요약(태그 걷어 냄) — 대개 500~1500자 */
  body: string;
}

const listCache = new Map<string, { at: number; v: StockReport[] }>();
const detailCache = new Map<number, { at: number; v: StockReport | null }>();

const num = (v: unknown): number | null => {
  const s = String(v ?? "").replace(/[,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** HTML → 글자. 문단·줄바꿈은 줄바꿈으로 남긴다 */
function stripHtml(html: string): string {
  return html
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>|<\/div>|<\/li>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function detail(id: number): Promise<StockReport | null> {
  const hit = detailCache.get(id);
  if (hit && Date.now() - hit.at < DETAIL_TTL) return hit.v;
  let v: StockReport | null = null;
  try {
    const r = await fetch(`https://m.stock.naver.com/api/research/company/${id}`, { headers: UA, signal: AbortSignal.timeout(8000) });
    void recordApiCall("naver", "researchDetail", r.ok ? "ok" : "failed");
    if (r.ok) {
      const j = (await r.json()) as { researchContent?: Record<string, unknown> };
      const c = j.researchContent;
      if (c) {
        v = {
          id,
          broker: String(c.brokerName ?? ""),
          title: String(c.title ?? ""),
          date: String(c.writeDate ?? ""),
          reads: num(c.readCount),
          opinion: c.opinion ? String(c.opinion) : null,
          goal: num(c.goalPrice),
          prevGoal: num(c.prevGoalPrice),
          priceAt: num(c.priceAtWriteDate),
          pdf: typeof c.attachUrl === "string" && c.attachUrl ? c.attachUrl : null,
          body: stripHtml(String(c.content ?? "")),
        };
      }
    }
  } catch {
    void recordApiCall("naver", "researchDetail", "failed");
  }
  detailCache.set(id, { at: Date.now(), v });
  return v;
}

/** 종목의 최근 리포트 — 목록의 차례(최신순) 그대로, 최대 `limit` */
export async function stockReports(code: string, limit = 8): Promise<StockReport[]> {
  const bare = code.replace(/_(AL|NX)$/i, "");
  const hit = listCache.get(bare);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit.v.slice(0, limit);
  let ids: number[] = [];
  try {
    const r = await fetch(`https://m.stock.naver.com/api/stock/${bare}/integration`, { headers: UA, signal: AbortSignal.timeout(8000) });
    void recordApiCall("naver", "krIntegration", r.ok ? "ok" : "failed");
    if (r.ok) {
      const j = (await r.json()) as { researches?: { id?: number }[] };
      ids = (j.researches ?? []).map((x) => Number(x.id)).filter((n) => Number.isFinite(n) && n > 0);
    }
  } catch {
    void recordApiCall("naver", "krIntegration", "failed");
  }
  /* 상세는 다섯씩 — 리포트 하나가 한 요청이라 예의 */
  const out: StockReport[] = [];
  for (let i = 0; i < ids.length; i += 5) {
    const got = await Promise.all(ids.slice(i, i + 5).map((id) => detail(id)));
    for (const g of got) if (g) out.push(g);
  }
  if (out.length > 0 || hit === undefined) listCache.set(bare, { at: Date.now(), v: out });
  return (out.length > 0 ? out : (hit?.v ?? [])).slice(0, limit);
}
