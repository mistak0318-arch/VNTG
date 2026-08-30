import type { KiwoomClient } from "./kiwoomClient.js";
import { dropPhantomToday } from "./candleGuard.js";
import { listThemes } from "./customThemes.js";
import { isIndexLikeTheme, loadThemes, themesOfStock } from "./naverThemes.js";
import { etfHoldersOf } from "./etfHolders.js";
import { isNotTheme } from "./signalLight.js";
import { getThemeStocks } from "./marketOverview.js";
import { getSectorMood } from "./sectorMood.js";
import { peekSnapshot } from "./marketSnapshot.js";

/**
 * 테마 지수 — **구성종목으로 직접 만든다.**
 *
 * ## 왜 만들어야 하나
 *
 * 업종에는 업종 지수가 있다(`ka20006`). 테마에는 없다 — 키움 테마도, 내가 묶은
 * 테마도 「지수」라는 물건이 아예 존재하지 않는다. 그런데 이 앱이 종목을 볼 때
 * 기준으로 삼는 것은 **테마**다(2026-08-27, 업종은 판정에서 뺐다). 비교선만
 * 업종으로 남겨 두면 「업종은 올랐는데 이 종목은」 같은, 아무 뜻 없는 문장을
 * 화면이 계속 말하게 된다.
 *
 * 그래서 구성종목 일봉의 **동일가중 평균**으로 만든다. 첫날을 100 으로 두고
 * 각 종목의 상대 수익률을 평균한다 — 시가총액 가중으로 하면 큰 종목 하나가
 * 테마 전체를 대변해 버려서, 「이 묶음이 같이 움직이나」라는 물음에 답을 못 한다.
 *
 * ## 조회를 어떻게 아끼나
 *
 * 종목마다 일봉 한 번이라 그냥 두면 테마 하나에 스무 콜이 넘는다. 셋으로 막는다.
 *   · **시가총액 상위 여덟 종목만** 쓴다. 테마의 성격은 앞쪽 종목이 정한다
 *   · **여섯 시간 캐시.** 일봉은 하루에 한 번 바뀌는 값이다
 *   · 화면이 **따로** 부른다(시트 응답에 안 싣는다) — 종목 창이 이것 때문에
 *     늦게 열리면 안 된다. 선 하나 늦게 그려지는 건 괜찮다
 */

export interface ThemeSeriesResult {
  /** 어느 테마를 썼나 — 내 테마 → 네이버 → 키움 순 */
  kind: "custom" | "naver" | "kiwoom";
  name: string;
  /** 지수에 실제로 쓴 종목 수 */
  used: number;
  /** 테마 전체 종목 수 — used 와 다르면 화면이 「상위 N개로」라고 적는다 */
  total: number;
  /** 옛날→최신. 첫날 = 100 */
  series: { date: string; close: number }[];
}

/** 지수 하나에 쓰는 종목 수 상한 — 조회가 이 수만큼 든다 */
const MAX_MEMBERS = 8;
const TTL_MS = 6 * 3600_000;

const cache = new Map<string, { at: number; data: ThemeSeriesResult | null }>();

/**
 * 이 종목의 테마 지수.
 *
 * **내 테마가 먼저다.** 내가 묶어 둔 것이 있으면 그게 내 기준이고, 없을 때만
 * 키움 분류로 간다. 둘 다 없으면 `null` — 없는 것을 있는 척 그리지 않는다.
 */
export async function themeSeriesFor(
  client: KiwoomClient,
  code: string,
): Promise<ThemeSeriesResult | null> {
  const pick = await pickTheme(client, code);
  if (!pick) return null;

  const key = `${pick.kind}:${pick.id}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const data = await build(client, pick).catch(() => null);
  cache.set(key, { at: Date.now(), data });
  return data;
}

interface Pick {
  kind: "custom" | "naver" | "kiwoom";
  id: string;
  name: string;
  codes: string[];
}

async function pickTheme(client: KiwoomClient, code: string): Promise<Pick | null> {
  /*
   * 내 테마 — 여러 개에 들어 있으면 **종목이 적은 쪽**을 쓴다.
   * 「반도체」와 「반도체_후공정」에 같이 담겨 있다면 뒤쪽이 이 종목을 더 정확히
   * 설명한다. 넓은 바구니는 어느 종목에나 걸려서 비교선으로 쓸모가 덜하다.
   */
  const mine = (await listThemes().catch(() => []))
    .filter((t) => t.codes.includes(code) && t.codes.length >= 2)
    .sort((a, b) => a.codes.length - b.codes.length)[0];
  if (mine) return { kind: "custom", id: mine.id, name: mine.name, codes: mine.codes };

  /*
   * 네이버 테마가 키움보다 먼저다 (2026-08-28 — 「지금 설정한 애들이 정밀도가
   * 훨씬 높잖아」). 신호등의 테마 기준(naverTheme)과 **같은 분류**를 쓰므로
   * 편입 점수와 대시보드 비교선이 같은 자로 재진다. 여기도 종목 수 적은
   * 쪽(가장 구체적인 테마)을 고른다 — 내 테마와 같은 이유다. 조회 0회(파일).
   */
  const naver = (await themesOfStock(code).catch(() => []))
    .sort((a, b) => a.no - b.no);
  if (naver.length > 0) {
    const store = await loadThemes();
    const cands = naver
      .map((n) => store.themes.find((t) => t.no === n.no))
      .filter((t): t is NonNullable<typeof t> => !!t && t.stocks.length >= 2)
      /* 지수·제도 묶음(밸류업 등)은 비교선이 못 된다 — 사업 테마만 */
      .filter((t) => !isIndexLikeTheme(t.name))
      .sort((a, b) => a.stocks.length - b.stocks.length);
    const best = cands[0];
    if (best) {
      return {
        kind: "naver",
        id: `naver:${best.no}`,
        name: best.name,
        codes: best.stocks.map((s) => s.code),
      };
    }
  }

  /* 없으면 키움 테마 — sectorMood 가 이미 이 종목의 편입 테마를 들고 있다 */
  const mood = await getSectorMood(client, code).catch(() => null);
  const kiwoom = mood?.themes?.[0];
  if (!kiwoom) return null;
  const stocks = await getThemeStocks(client, kiwoom.code).catch(() => []);
  if (stocks.length < 2) return null;
  return {
    kind: "kiwoom",
    id: kiwoom.code,
    name: kiwoom.name,
    codes: stocks.map((s) => s.code),
  };
}

async function build(client: KiwoomClient, pick: Pick): Promise<ThemeSeriesResult | null> {
  /*
   * 시가총액 상위부터 — 전종목 스냅샷(캐시)에서 읽는다. 조회가 아니다.
   * 스냅샷에 없는 종목은 뒤로 밀 뿐 빼지는 않는다(신규 상장 등).
   */
  const snap = peekSnapshot();
  const ranked = [...pick.codes].sort(
    (a, b) => (snap?.byCode.get(b)?.marketCap ?? 0) - (snap?.byCode.get(a)?.marketCap ?? 0),
  );
  const members = ranked.slice(0, MAX_MEMBERS);

  const seriesList = await Promise.all(members.map((c) => dailyCloses(client, c).catch(() => null)));
  const ok = seriesList.filter((s): s is Map<string, number> => s !== null && s.size > 1);
  if (ok.length === 0) return null;

  /*
   * **모두가 값을 가진 날짜만** 쓴다.
   * 한 종목이라도 빠진 날을 평균에 넣으면, 그날만 구성이 달라져서 지수에 계단이 생긴다.
   */
  const [first, ...rest] = ok;
  const dates = [...first.keys()]
    .filter((d) => rest.every((m) => m.has(d)))
    .sort((a, b) => a.localeCompare(b));
  if (dates.length < 2) return null;

  const base = dates[0];
  const series = dates.map((date) => {
    const avg =
      ok.reduce((sum, m) => sum + m.get(date)! / m.get(base)!, 0) / ok.length;
    return { date, close: Math.round(avg * 100 * 100) / 100 };
  });

  return { kind: pick.kind, name: pick.name, used: ok.length, total: pick.codes.length, series };
}

/** 종목 일봉 → 날짜별 종가 (ka10081). superSignal 의 것과 같은 TR·같은 필드다 */
async function dailyCloses(client: KiwoomClient, code: string): Promise<Map<string, number>> {
  const base = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const out = new Map<string, number>();
  for (const r of dropPhantomToday((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[])) {
    const date = String(r.dt ?? "");
    const close = Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,]/g, "")));
    if (/^\d{8}$/.test(date) && Number.isFinite(close) && close > 0) out.set(date, close);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* ETF 뒷배 비교선 (2026-08-28 — 「ETF 뒷배도 반영해야지」)               */
/* ------------------------------------------------------------------ */

export interface EtfSeriesResult {
  code: string;
  name: string;
  /** 이 종목의 비중(%) — 화면이 「왜 이 ETF 인가」를 적는다 */
  weight: number | null;
  series: { date: string; close: number }[];
}

const etfCache = new Map<string, { at: number; data: EtfSeriesResult | null }>();

/**
 * 이 종목을 **테마로** 가장 많이 담은 ETF 의 일봉.
 *
 * 신호등의 「ETF 뒷배」와 같은 규칙으로 고른다 — 단일종목·레버리지·지수(200/150)·
 * 커버드콜은 빼고, 비중 50% 초과(사실상 그 종목 하나짜리)도 뺀다. 뒷배 점수와
 * 대시보드 비교선이 **같은 ETF** 를 봐야 말이 맞는다.
 * ETF 는 그 자체가 종목이라 일봉 한 번이면 된다. 6시간 캐시.
 */
export async function etfSeriesFor(
  client: KiwoomClient,
  code: string,
): Promise<EtfSeriesResult | null> {
  const hit = etfCache.get(code);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data;

  const data = await (async (): Promise<EtfSeriesResult | null> => {
    const { holders } = await etfHoldersOf(code).catch(() => ({ holders: [] as { code: string; name: string; weight: number | null }[] }));
    const best = holders.find((h) => !isNotTheme(h.name) && (h.weight ?? 0) <= 50);
    if (!best) return null;
    const closes = await dailyCloses(client, best.code).catch(() => null);
    if (!closes || closes.size < 2) return null;
    const series = [...closes.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, close]) => ({ date, close }));
    return { code: best.code, name: best.name, weight: best.weight, series };
  })();

  etfCache.set(code, { at: Date.now(), data });
  return data;
}
