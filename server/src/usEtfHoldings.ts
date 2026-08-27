import { recordApiCall } from "./apiUsage.js";

/**
 * 미국 ETF 구성종목 — **섹터 MAP 타일을 눌렀을 때 「무엇이 들었나」.**
 *
 * 미국은 섹터가 ETF 로 거래되므로(XLK·SOXX·ARKK…) 그 두 묶음이 곧 업종 MAP 노릇을
 * 한다. 그런데 타일을 눌러도 차트만 나왔다 — 「소프트웨어가 +6% 」라는 걸 봐도
 * **무엇이 밀어 올렸는지**를 모르면 다음 행동으로 이어지지 않는다 (2026-08-27 요청).
 *
 * ## 출처와 인증 (실측 2026-08-27)
 *
 * 야후 `quoteSummary?modules=topHoldings`. 차트 API 와 달리 **crumb 이 필요하다** —
 * 그냥 부르면 401 `Invalid Crumb` 이다. 순서가 정해져 있다:
 *   1. `fc.yahoo.com` 을 한 번 쳐서 쿠키(A3)를 받는다
 *   2. 그 쿠키로 `/v1/test/getcrumb` → 짧은 토큰 문자열
 *   3. 쿠키 + `crumb=` 로 quoteSummary 를 부른다
 *
 * 토큰은 **오래 산다.** 한 번 받아 두고 401 이 나면 그때 다시 받는다 —
 * 조회마다 세 번씩 부르면 그게 더 나쁘다.
 *
 * 주는 것은 상위 10종목 안팎(비중 포함)과 섹터 비중이다. **전량이 아니다** —
 * 화면이 「상위 N종목」이라고 적어야 한다. 없는 것을 다 있는 척하면 안 된다.
 */

export interface UsEtfHolding {
  symbol: string;
  name: string;
  /** 편입 비중(%) */
  weight: number | null;
}

export interface UsEtfHoldings {
  symbol: string;
  holdings: UsEtfHolding[];
  /** 섹터 비중(%) — 「이 ETF 가 어디에 쏠려 있나」 */
  sectors: { name: string; weight: number }[];
  /** 못 받았을 때의 이유 — null 이 조용히 사라지면 「없음」과 「못 봤음」이 안 갈린다 */
  error: string | null;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

let auth: { cookie: string; crumb: string } | null = null;

async function getAuth(force = false): Promise<{ cookie: string; crumb: string } | null> {
  if (auth && !force) return auth;
  try {
    const r1 = await fetch("https://fc.yahoo.com", { headers: { "User-Agent": UA } });
    const list =
      typeof r1.headers.getSetCookie === "function"
        ? r1.headers.getSetCookie()
        : [r1.headers.get("set-cookie") ?? ""];
    const cookie = list
      .filter(Boolean)
      .map((c) => c.split(";")[0])
      .join("; ");
    if (!cookie) return null;
    const r2 = await fetch("https://query1.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": UA, cookie },
    });
    const crumb = (await r2.text()).trim();
    // 크럼은 짧은 토큰이다. HTML 이 오면 실패한 것이다
    if (!r2.ok || !crumb || crumb.length > 40 || crumb.includes("<")) return null;
    auth = { cookie, crumb };
    return auth;
  } catch {
    return null;
  }
}

/** 하루 캐시 — 편입 종목이 장중에 바뀌는 값이 아니다 */
const TTL_MS = 24 * 3600_000;
const cache = new Map<string, { at: number; data: UsEtfHoldings }>();

export async function usEtfHoldings(symbol: string): Promise<UsEtfHoldings> {
  const sym = symbol.trim().toUpperCase();
  const hit = cache.get(sym);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const empty: UsEtfHoldings = { symbol: sym, holdings: [], sectors: [], error: null };

  const fetchOnce = async (a: { cookie: string; crumb: string }): Promise<Response> =>
    fetch(
      `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(sym)}` +
        `?modules=topHoldings&crumb=${encodeURIComponent(a.crumb)}`,
      { headers: { "User-Agent": UA, cookie: a.cookie } },
    );

  try {
    let a = await getAuth();
    if (!a) return { ...empty, error: "야후 인증을 받지 못했습니다" };
    let res = await fetchOnce(a);
    /* 401 은 크럼이 늙은 것이다 — 딱 한 번만 다시 받아 재시도한다 */
    if (res.status === 401) {
      a = await getAuth(true);
      if (!a) return { ...empty, error: "야후 인증을 받지 못했습니다" };
      res = await fetchOnce(a);
    }
    if (!res.ok) {
      void recordApiCall("yahoo", sym, res.status === 429 ? "rateLimited" : "failed");
      return { ...empty, error: `야후 응답 ${res.status}` };
    }
    void recordApiCall("yahoo", sym, "ok");

    const body = (await res.json()) as {
      quoteSummary?: {
        result?: Array<{
          topHoldings?: {
            holdings?: Array<{
              symbol?: string;
              holdingName?: string;
              holdingPercent?: { raw?: number };
            }>;
            sectorWeightings?: Array<Record<string, { raw?: number } | undefined>>;
          };
        }>;
      };
    };
    const t = body.quoteSummary?.result?.[0]?.topHoldings;
    if (!t) return { ...empty, error: "구성종목을 주지 않는 종목입니다" };

    const holdings: UsEtfHolding[] = (t.holdings ?? [])
      .map((h) => ({
        symbol: String(h.symbol ?? "").toUpperCase(),
        name: String(h.holdingName ?? ""),
        weight: typeof h.holdingPercent?.raw === "number" ? h.holdingPercent.raw * 100 : null,
      }))
      .filter((h) => h.symbol.length > 0);

    /*
     * 섹터 비중은 `[{realestate:{raw:0.01}}, {technology:{raw:0.7}}, …]` 처럼
     * **한 칸에 키 하나**인 배열로 온다. 키를 우리 말로 바꿔 편다.
     */
    const sectors = (t.sectorWeightings ?? [])
      .flatMap((row) =>
        Object.entries(row).map(([k, v]) => ({
          name: SECTOR_KO[k] ?? k,
          weight: typeof v?.raw === "number" ? v.raw * 100 : 0,
        })),
      )
      .filter((s) => s.weight > 0)
      .sort((a2, b2) => b2.weight - a2.weight);

    const data: UsEtfHoldings = { symbol: sym, holdings, sectors, error: null };
    cache.set(sym, { at: Date.now(), data });
    return data;
  } catch (err) {
    void recordApiCall("yahoo", sym, "failed");
    return { ...empty, error: err instanceof Error ? err.message : "구성종목 조회 실패" };
  }
}

const SECTOR_KO: Record<string, string> = {
  technology: "기술",
  financial_services: "금융",
  healthcare: "헬스케어",
  consumer_cyclical: "경기소비재",
  consumer_defensive: "필수소비재",
  communication_services: "커뮤니케이션",
  industrials: "산업재",
  energy: "에너지",
  utilities: "유틸리티",
  basic_materials: "소재",
  realestate: "리츠·부동산",
};
