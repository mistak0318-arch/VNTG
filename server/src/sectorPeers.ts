import { loadThemes, isIndexLikeTheme } from "./naverThemes.js";
import { loadFinanceCache, marginTrendAt } from "./financeCache.js";
import { loadCloses } from "./dailyCloses.js";

/**
 * **섹터 = 네이버 테마 회원사** (2026-09-03, 세대 5).
 *
 * 벤티지: "그 걔가 속한 섹터의 영업이익률이 전체가 좋아져야 돼. 예를 들어 네이버 테마에
 * 우리가 섹터 잡아놨잖아. 이게 전체적으로 좋아지는 추세인지 — 그 산업이 성장세인지를
 * 봐야 한다." / "그 섹터 종목 중에서도 그 종목 자체 좋아지고 있는 종목."
 *
 * 한 종목이 여러 테마에 든다. **실적 캐시에 있는 회원이 가장 많은 테마**를 그 종목의
 * 섹터로 본다 — 회원이 셋 미만이면 섹터를 말할 수 없다. 지수·제도 묶음(밸류업 등)은 뺀다.
 *
 * 전부 파일에서 읽는다 — 테마 DB·실적 캐시·일봉 캐시. **키움·한투 조회 0회.**
 *
 * ⚠️ 테마 구성은 **오늘 것**이다. 표본(과거)을 채점할 때 그 이름표로 되짚으면 약간의
 * look-ahead 가 있다(ETF 뒷배와 같은 종류). 실적·수익률 값 자체는 그날 것을 쓴다.
 */

export interface Peers {
  /** 테마 번호 */
  no: number;
  name: string;
  /** 자기 자신을 뺀 회원 */
  codes: string[];
}

let membersCache: { at: string; byNo: Map<number, { name: string; codes: string[] }>; ofCode: Map<string, number[]> } | null = null;

async function members() {
  const store = await loadThemes();
  if (membersCache && membersCache.at === store.fetchedAt) return membersCache;
  const byNo = new Map<number, { name: string; codes: string[] }>();
  const ofCode = new Map<string, number[]>();
  for (const t of store.themes ?? []) {
    if (isIndexLikeTheme(t.name)) continue;
    const codes = (t.stocks ?? []).map((s) => s.code);
    byNo.set(t.no, { name: t.name, codes });
    for (const c of codes) (ofCode.get(c) ?? ofCode.set(c, []).get(c)!).push(t.no);
  }
  membersCache = { at: store.fetchedAt, byNo, ofCode };
  return membersCache;
}

/** 이 종목의 섹터(회원이 가장 많은 테마). 없으면 null */
export async function sectorPeersOf(code: string): Promise<Peers | null> {
  const [m, fin] = await Promise.all([members(), loadFinanceCache()]);
  let best: Peers | null = null;
  for (const no of m.ofCode.get(code) ?? []) {
    const t = m.byNo.get(no);
    if (!t) continue;
    const codes = t.codes.filter((c) => c !== code && fin[c]);
    if (codes.length < 3) continue;
    if (!best || codes.length > best.codes.length) best = { no, name: t.name, codes };
  }
  return best;
}

const med = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

/**
 * 회원사들의 **분기 이익률 개선 추세 중앙값** (%p). `date` 를 주면 그날 알 수 있던 분기만.
 * 실적이 있는 회원이 셋 미만이면 null — 둘로 섹터를 말할 수 없다.
 */
export async function peerMarginTrend(
  codes: string[],
  date?: string,
): Promise<{ med: number; n: number } | null> {
  const fin = await loadFinanceCache();
  const vals: number[] = [];
  for (const c of codes) {
    const t = marginTrendAt(fin[c], date);
    if (t) vals.push(t.trend);
  }
  return vals.length >= 3 ? { med: med(vals), n: vals.length } : null;
}

const idxMemo = new Map<string, Map<string, number>>();

/**
 * 회원사들의 **20일 수익률 중앙값** (%). `date`(YYYYMMDD) 를 주면 그날 기준, 없으면 마지막 봉.
 * 일봉 캐시(전종목)에서 읽는다. 셋 미만이면 null.
 */
export async function peerRet20(codes: string[], date?: string): Promise<{ med: number; n: number } | null> {
  const { bars } = await loadCloses();
  const barsOf = bars ?? {};
  const vals: number[] = [];
  for (const c of codes) {
    const bs = barsOf[c];
    if (!bs || bs.length < 21) continue;
    let i = bs.length - 1;
    if (date) {
      let m = idxMemo.get(c);
      if (!m || m.size !== bs.length) {
        m = new Map();
        bs.forEach((b, k) => m!.set(b.d, k));
        idxMemo.set(c, m);
      }
      const k = m.get(date);
      if (k === undefined) continue;
      i = k;
    }
    if (i < 20) continue;
    const c0 = bs[i].c;
    const c20 = bs[i - 20].c;
    if (!(c0 > 0 && c20 > 0)) continue;
    vals.push(((c0 - c20) / c20) * 100);
  }
  return vals.length >= 3 ? { med: med(vals), n: vals.length } : null;
}
