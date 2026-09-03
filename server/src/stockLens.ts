import { themeStrength } from "./themeStrength.js";
import { isIndexLikeTheme, themesOfStock } from "./naverThemes.js";
import { etfHoldersOf } from "./etfHolders.js";
import { isNotTheme } from "./signalLight.js";

/**
 * 종목 렌즈 — **테마·ETF 뒷배를 한 종목에 붙이는 한 곳** (2026-08-28).
 *
 * 슈퍼신호등 대시보드가 먼저 쓰기 시작했고, 신호등 찾기 결과표도 같은 걸 단다.
 * 두 화면이 각자 고르면 같은 종목의 「무리」가 화면마다 달라진다 — 고르는 규칙은
 * 신호등의 테마 강세·ETF 뒷배 판정과 **똑같아야** 점수와 표가 같은 것을 본다.
 *
 * 테마·구성은 파일·스냅샷에서, ETF 오늘 등락률만 ETF 전체시세(3분 캐시 한 번)에서 —
 * 종목마다 키움을 부르진 않는다 (2026-09-03 전엔 파일의 어제 등락률을 그대로 썼다).
 */

export interface LensTheme {
  key: string;
  name: string;
  changeRate: number;
  streak: number;
}

export interface LensEtf {
  /** 상위 셋의 오늘 평균 등락률(%) */
  rate: number;
  /** 대표(비중 1위) ETF — 브랜드 접두는 뗀다 */
  top: string;
}

export type ThemeMap = Map<string, LensTheme>;

/** 테마 강도 한 벌 — 여러 종목에 붙일 때 한 번만 받는다 (수십 ms) */
export async function themeMapNow(): Promise<ThemeMap> {
  const { themes } = await themeStrength("kr").catch(() => ({ themes: [] }));
  return new Map(
    themes.map((t) => [
      t.key,
      { key: t.key, name: t.name, changeRate: t.changeRate, streak: t.streak },
    ]),
  );
}

/**
 * 이 종목의 렌즈.
 * - 테마: 든 사업 테마(지수성 제외) 중 오늘 가장 강한 것
 * - ETF 뒷배: 테마로 담은 상위 3 ETF 의 오늘 평균 (신호등 뒷배와 같은 필터)
 */
export async function stockLens(
  code: string,
  themeMap: ThemeMap,
): Promise<{ theme: LensTheme | null; etfBack: LensEtf | null }> {
  let theme: LensTheme | null = null;
  for (const t of await themesOfStock(code).catch(() => [])) {
    const row = themeMap.get(`kr:${t.no}`);
    if (!row) continue;
    if (isIndexLikeTheme(row.name)) continue; // 밸류업 지수는 무리가 아니다
    if (!theme || row.changeRate > theme.changeRate) theme = row;
  }

  let etfBack: LensEtf | null = null;
  const holders = (await etfHoldersOf(code).catch(() => ({ holders: [] }))).holders
    .filter((h) => !isNotTheme(h.name) && (h.weight ?? 0) <= 50 && h.changeRate !== null)
    .slice(0, 3);
  if (holders.length > 0) {
    etfBack = {
      rate:
        Math.round(
          (holders.reduce((n, h) => n + (h.changeRate ?? 0), 0) / holders.length) * 100,
        ) / 100,
      top: holders[0].name.replace(/^(KODEX|TIGER|RISE|PLUS|ACE|SOL|HANARO)\s*/, ""),
    };
  }
  return { theme, etfBack };
}
