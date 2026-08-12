import type { KiwoomClient } from "./kiwoomClient.js";
import { getSection } from "./marketOverview.js";
import type { Sectors } from "./marketOverview.js";
import { findStock } from "./stockListCache.js";

/**
 * 종목이 속한 업종·테마가 오늘 어떤 분위기인지.
 *
 * - 업종: ka10099의 upName(업종명)을 ka20003 전업종지수와 이름으로 맞춘다.
 *   업종지수는 이미 시황 대시보드가 캐싱하고 있어 추가 호출이 없다.
 * - 테마: ka90001을 qry_tp=2(종목검색) + stk_cd로 부르면 그 종목이 속한 테마만 돌아온다.
 *   테마를 전부 훑을 필요 없이 호출 1번이면 된다.
 */

const THME_RESOURCE = "/api/dostk/thme";

export interface SectorMood {
  /** 업종지수 코드 (ka20002 구성종목 조회용). 이름 매칭에 실패하면 빈 문자열 */
  code: string;
  name: string;
  changeRate: number;
  /** 같은 시장 전체 업종 중 몇 위인지 (1이 가장 강함) */
  rank: number | null;
  total: number | null;
  market: "코스피" | "코스닥";
  /** 구성종목 조회 시 넘길 시장 구분 */
  marketKey: "kospi" | "kosdaq";
}

export interface ThemeMood {
  code: string;
  name: string;
  changeRate: number;
  stockCount: number;
  risingCount: number;
  fallingCount: number;
  /** 기간수익률(%) — date_tp 기준 */
  periodReturn: number;
  mainStocks: string;
}

export interface MoodResult {
  sector: SectorMood | null;
  themes: ThemeMood[];
  note?: string;
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** "전기/전자" ↔ "전기전자" ↔ "전기,전자" 를 같은 것으로 보기 위한 정규화 */
function normalizeSectorName(name: string): string {
  return name.replace(/[^가-힣a-zA-Z0-9]/g, "").toLowerCase();
}

const moodCache = new Map<string, { data: MoodResult; at: number }>();
const MOOD_TTL_MS = 3 * 60_000;

export async function getSectorMood(client: KiwoomClient, code: string): Promise<MoodResult> {
  const hit = moodCache.get(code);
  if (hit && Date.now() - hit.at < MOOD_TTL_MS) return hit.data;

  const [entry, themes] = await Promise.all([findStock(client, code), fetchStockThemes(client, code)]);

  let sector: SectorMood | null = null;
  if (entry?.sectorName) {
    const section = await getSection("sectors", client).catch(() => null);
    const sectors = (section?.data ?? null) as Sectors | null;
    const isKospi = entry.marketCode === "0";
    const list = isKospi ? sectors?.kospi : sectors?.kosdaq;
    if (list && list.length > 0) {
      const target = normalizeSectorName(entry.sectorName);
      // 업종지수 이름과 종목 목록의 업종명이 완전히 같지 않을 수 있어 포함 관계까지 본다
      const idx = list.findIndex((s) => {
        const n = normalizeSectorName(s.name);
        return n === target || n.includes(target) || target.includes(n);
      });
      if (idx >= 0) {
        // list는 등락률 내림차순으로 정렬되어 있으므로 인덱스가 곧 순위
        sector = {
          code: list[idx].code,
          name: list[idx].name,
          changeRate: list[idx].changeRate,
          rank: idx + 1,
          total: list.length,
          market: isKospi ? "코스피" : "코스닥",
          marketKey: isKospi ? "kospi" : "kosdaq",
        };
      } else {
        // 업종지수와 이름이 안 맞으면 이름만 보여주고 구성종목 조회는 막는다
        sector = {
          code: "",
          name: entry.sectorName,
          changeRate: 0,
          rank: null,
          total: null,
          market: isKospi ? "코스피" : "코스닥",
          marketKey: isKospi ? "kospi" : "kosdaq",
        };
      }
    }
  }

  const result: MoodResult = {
    sector,
    themes,
    note: themes.length === 0 ? "이 종목이 편입된 키움 테마가 없습니다." : undefined,
  };
  moodCache.set(code, { data: result, at: Date.now() });
  return result;
}

/** ka90001 qry_tp=2 — 해당 종목이 편입된 테마만 반환 */
async function fetchStockThemes(client: KiwoomClient, code: string): Promise<ThemeMood[]> {
  const bare = code.replace(/_(AL|NX)$/, "");
  const { data } = await client.request<Record<string, unknown>>(THME_RESOURCE, "ka90001", {
    qry_tp: "2", // 2:종목코드 기준 검색
    stk_cd: bare,
    date_tp: "1",
    thema_nm: "",
    flu_pl_amt_tp: "1",
    stex_tp: "3",
  });
  const rows = Array.isArray(data.thema_grp) ? (data.thema_grp as Record<string, unknown>[]) : [];
  return rows
    .map((r) => ({
      code: String(r.thema_grp_cd ?? ""),
      name: String(r.thema_nm ?? ""),
      changeRate: toNum(r.flu_rt),
      stockCount: toNum(r.stk_num),
      risingCount: toNum(r.rising_stk_num),
      fallingCount: toNum(r.fall_stk_num),
      periodReturn: toNum(r.dt_prft_rt),
      mainStocks: String(r.main_stk ?? ""),
    }))
    .filter((t) => t.name)
    .sort((a, b) => b.changeRate - a.changeRate);
}
