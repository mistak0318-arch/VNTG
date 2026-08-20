import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { tradeValueTop } from "./signalScreen.js";
import { getMarketSnapshot, isRealSector } from "./marketSnapshot.js";
import { searchNews, type NewsItem } from "./newsDisclosure.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "leaderScan.json");

/**
 * 주도주 탐색기 — **오늘 시장이 어디에 반응하는가.**
 *
 * ## 이 화면이 답하려는 질문
 *
 * 「무엇이 올랐나」가 아니라 **「돈이 어디로 몰리고, 그게 이어지고 있나」**다.
 * 등락률 순위는 이미 있다. 그것만 봐서는 주도주를 못 고른다 — 하루 반짝 오른 것과
 * 사흘째 돈이 들어오는 것이 같은 목록에 섞여 나오기 때문이다.
 *
 * ## 요청받은 조건
 *
 *   · 상승이 강한 섹터를 먼저 찾는다
 *   · 그 섹터가 **왜** 강한지 뉴스를 뒤진다
 *   · 그 강함이 **유지되는지** 본다
 *   · 종목은 250일 신고가 · 거래량 급증 · 당일 급등으로 거른다
 *   · **거래대금 500억 미만은 뺀다** — 작전·휩쏘가 끼기 쉬운 구간이다
 *
 * ## 여기에 더한 것 (설계하며 보강)
 *
 * 1. **폭(breadth).** 섹터 +3% 가 한 종목 상한가로 만들어진 것인지 여덟 종목이 고르게
 *    오른 것인지는 **완전히 다른 장**이다. 앞은 종목 이슈고 뒤가 주도 섹터다.
 *    이게 없으면 「강한 섹터」를 계속 잘못 고르게 된다.
 *
 * 2. **거래대금 가중 등락률.** 단순평균은 소형주 한 종목이 섹터를 대표하게 만든다.
 *    우리가 보려는 건 「돈이 어디로 갔나」이므로 돈으로 가중하는 게 맞다.
 *    단순평균도 같이 보여 준다 — 둘이 크게 벌어지면 **대형주 혼자 끌고 있다**는 뜻이다.
 *
 * 3. **지속성을 어제와 견줘서 잰다.** 하루치만 보면 지속성은 정의할 수가 없다.
 *    매일 결과를 저장해 두고 **연속으로 상위에 든 날수**와 **어제 종목과의 교집합**을 센다.
 *    그래서 **첫날은 지속성이 안 나온다.** 없는 걸 있는 척하지 않는다.
 *
 * 4. **왜 걸렸는지 태그를 남긴다.** 신고가로 걸린 것과 거래량 급증으로 걸린 것은
 *    같은 목록에 있어도 성격이 다르다. 나중에 「나는 어느 쪽을 잘 고르나」를 물으려면
 *    그때의 이유가 남아 있어야 한다.
 */

/* ------------------------------------------------------------------ */
/* 설정                                                                */
/* ------------------------------------------------------------------ */

export interface LeaderConfig {
  /** 최소 거래대금(억). 이하는 작전·휩쏘가 끼기 쉬워 아예 뺀다 */
  minTradeValue: number;
  /** 거래대금 상위 몇 위까지 훑을지 */
  universe: number;
  /** 급등으로 볼 당일 등락률(%) */
  surgeRate: number;
  /** 거래량 급증으로 볼 전일 대비 배수 */
  volumeSpike: number;
  /** 섹터를 몇 개까지 보여줄지 */
  topSectors: number;
  /** 섹터로 인정할 최소 종목 수 — 한 종목짜리 「섹터」는 섹터가 아니다 */
  minMembers: number;
}

export const DEFAULT_LEADER_CONFIG: LeaderConfig = {
  minTradeValue: 500,
  universe: 200,
  surgeRate: 5,
  volumeSpike: 2,
  topSectors: 6,
  minMembers: 2,
};

/* ------------------------------------------------------------------ */
/* 모양                                                                */
/* ------------------------------------------------------------------ */

/** 왜 이 종목이 걸렸나 */
export type LeaderTag = "신고가" | "거래량급증" | "급등" | "대금상위";

export interface LeaderStock {
  code: string;
  name: string;
  sector: string;
  price: number;
  changeRate: number;
  /** 억원 */
  tradeValue: number;
  marketCap: number | null;
  /** 전일 거래량 대비 배수 */
  volumeRatio: number | null;
  tags: LeaderTag[];
  /** 태그 가중합 — 목록 순서를 정한다 */
  score: number;
}

export interface LeaderSector {
  name: string;
  /** 거래대금 가중 등락률 — 돈이 어디로 갔나 */
  weightedRate: number;
  /** 단순평균. 가중과 크게 벌어지면 대형주 혼자 끌고 있다는 뜻 */
  simpleRate: number;
  /** 이 섹터로 들어온 거래대금 합 (억) */
  tradeValue: number;
  members: number;
  rising: number;
  /** 폭 — 오른 종목 비율(%). 낮으면 섹터가 아니라 종목 이슈다 */
  breadth: number;
  /** 대금 상위 구성종목 */
  leaders: LeaderStock[];
  /** 며칠 연속 상위에 들었나. 기록이 없으면 null */
  streak: number | null;
  /** 어제 이 섹터에서 뽑힌 종목 중 오늘도 남은 비율(%) */
  carryOver: number | null;
  /** 왜 강한가 — 뉴스 */
  news: { title: string; press: string; link: string }[];
}

export interface LeaderScan {
  at: string;
  date: string;
  config: LeaderConfig;
  sectors: LeaderSector[];
  /** 섹터를 가리지 않고 걸린 종목 전체 (점수순) */
  stocks: LeaderStock[];
  scanned: number;
  /** 500억 문턱에서 잘린 수 — 문턱이 적당한지 판단하는 근거 */
  belowThreshold: number;
  note: string;
}

/* ------------------------------------------------------------------ */
/* 저장 — 지속성을 재려면 어제가 있어야 한다                              */
/* ------------------------------------------------------------------ */

interface DayRecord {
  date: string;
  /** 섹터명 → 그날 뽑힌 종목코드 */
  sectors: Record<string, string[]>;
  /**
   * 그날 뽑힌 종목의 **그때 값**.
   *
   * 성적 추적(「그때 뽑은 게 그 뒤 어떻게 됐나」)을 하려면 편입가가 있어야 한다.
   * 나중에 일봉으로 되짚을 수도 있지만, 그때의 **거래대금·태그**는 되살릴 방법이 없다 —
   * 신고가로 걸린 것과 거래량으로 걸린 것 중 어느 쪽을 잘 고르는지 물으려면
   * 그때의 이유가 남아 있어야 한다. 오늘 안 적으면 오늘치는 영영 못 센다.
   */
  picks?: {
    code: string;
    name: string;
    sector: string;
    price: number;
    changeRate: number;
    tradeValue: number;
    tags: string[];
  }[];
}

interface Store {
  config: LeaderConfig;
  days: DayRecord[];
}

const EMPTY: Store = { config: { ...DEFAULT_LEADER_CONFIG }, days: [] };

async function load(): Promise<Store> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as Partial<Store>;
    return {
      config: { ...DEFAULT_LEADER_CONFIG, ...(raw.config ?? {}) },
      days: Array.isArray(raw.days) ? raw.days : [],
    };
  } catch {
    return { ...EMPTY, days: [] };
  }
}

async function save(s: Store): Promise<void> {
  // 60일이면 지속성을 보기에 충분하다. 안 자르면 파일이 계속 자란다
  s.days = s.days.slice(-60);
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(s, null, 2), "utf-8");
}

export async function getLeaderConfig(): Promise<LeaderConfig> {
  return (await load()).config;
}

export async function saveLeaderConfig(input: Partial<LeaderConfig>): Promise<LeaderConfig> {
  const store = await load();
  const c = store.config;
  const clamp = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt;
  };
  store.config = {
    minTradeValue: clamp(input.minTradeValue, 0, 100000, c.minTradeValue),
    universe: clamp(input.universe, 20, 400, c.universe),
    surgeRate: clamp(input.surgeRate, 0, 30, c.surgeRate),
    volumeSpike: clamp(input.volumeSpike, 1, 20, c.volumeSpike),
    topSectors: clamp(input.topSectors, 1, 20, c.topSectors),
    minMembers: clamp(input.minMembers, 1, 10, c.minMembers),
  };
  await save(store);
  return store.config;
}

function kstDate(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------ */
/* 부속 조회                                                            */
/* ------------------------------------------------------------------ */

/**
 * 키움이 주는 종목코드에서 거래소 접미사를 뗀다.
 *
 * `ka10023` 은 `053030_AL` 처럼 **통합(_AL) 접미사를 붙여** 준다. 예전엔 `_` 만 지워서
 * `053030AL` 이 됐고, 그러면 6자리 코드와 절대 안 맞아 **거래량 급증 태그가 하나도
 * 안 붙었다.** 같은 TR 이 장중에 멀쩡히 값을 주는데 화면만 비어 있었다.
 */
function bareCode(v: unknown): string {
  return String(v ?? "")
    .replace(/_(AL|NX)$/i, "")
    .replace(/[^0-9A-Za-z]/g, "");
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 250일 신고가 종목코드 — 52주에 가장 가까운 것이 이것이다(거래일 250 ≈ 1년) */
async function highCodes(client: KiwoomClient): Promise<Set<string>> {
  try {
    const res = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10016", {
      mrkt_tp: "000",
      high_low_close_tp: "1",
      stk_cnd: "1",
      trde_qty_tp: "00050",
      crd_cnd: "0",
      updown_incls: "1",
      dt: "250",
      stex_tp: "3",
      ntl_tp: "1",
    });
    const rows = (res.data?.ntl_pric ?? []) as Record<string, unknown>[];
    return new Set(rows.map((r) => bareCode(r.stk_cd)));
  } catch {
    return new Set();
  }
}

/**
 * 거래량 급증 종목 → 전일 대비 배수.
 *
 * `ka10023` 거래량급증요청. 못 받으면 빈 지도를 준다 — 태그 하나가 빠질 뿐
 * 나머지 판단은 그대로 선다.
 */
async function volumeSpikes(client: KiwoomClient): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  try {
    const res = await client.request<Record<string, unknown>>("/api/dostk/rkinfo", "ka10023", {
      mrkt_tp: "000",
      sort_tp: "1",
      tm_tp: "2",
      trde_qty_tp: "5",
      tm: "",
      stk_cnd: "1",
      pric_tp: "0",
      stex_tp: "3",
    });
    const rows = (res.data?.trde_qty_sdnin ?? []) as Record<string, unknown>[];
    for (const r of rows) {
      const code = bareCode(r.stk_cd);
      const now = toNum(r.now_trde_qty);
      const prev = toNum(r.prev_trde_qty);
      if (code && prev > 0) out.set(code, now / prev);
    }
  } catch {
    /* 못 받으면 태그 하나가 빠질 뿐이다 */
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 본체                                                                */
/* ------------------------------------------------------------------ */

const TAG_WEIGHT: Record<LeaderTag, number> = {
  신고가: 40,
  거래량급증: 30,
  급등: 20,
  대금상위: 10,
};

export async function leaderScan(
  client: KiwoomClient,
  opts: { withNews?: boolean } = {},
): Promise<LeaderScan> {
  const store = await load();
  const cfg = store.config;
  const date = kstDate();

  const [universe, snap, highs, spikes] = await Promise.all([
    tradeValueTop(client, "000", cfg.universe),
    getMarketSnapshot(client).catch(() => null),
    highCodes(client),
    volumeSpikes(client),
  ]);

  let belowThreshold = 0;
  const stocks: LeaderStock[] = [];
  for (const u of universe) {
    // trde_prica 는 백만원 단위다 — /100 이 억원
    const tradeValue = Math.round(u.tradeValue / 100);
    if (tradeValue < cfg.minTradeValue) {
      belowThreshold += 1;
      continue;
    }
    const snapshot = snap?.byCode.get(u.code);
    const ratio = spikes.get(u.code) ?? null;

    const tags: LeaderTag[] = [];
    if (highs.has(u.code)) tags.push("신고가");
    if (ratio !== null && ratio >= cfg.volumeSpike) tags.push("거래량급증");
    if (u.changeRate >= cfg.surgeRate) tags.push("급등");
    /*
     * 태그가 하나도 없으면 **목록에 안 넣는다.**
     * 거래대금만 큰 종목(삼성전자 등)은 늘 상위에 있어서, 그냥 두면 매일 같은 얼굴이
     * 목록을 채우고 정작 오늘 새로 반응한 종목이 묻힌다.
     */
    if (tags.length === 0) continue;
    // 대금이 아주 크면 그것도 근거다 — 다만 단독으로는 못 들어온다
    if (tradeValue >= cfg.minTradeValue * 4) tags.push("대금상위");

    stocks.push({
      code: u.code,
      name: u.name,
      // 스냅샷에 없으면 업종을 모르는 것이다. 「기타」로 뭉뚱그리면 그게 섹터인 척한다
      sector: snapshot?.sector ?? "",
      price: u.price,
      changeRate: u.changeRate,
      tradeValue,
      marketCap: snapshot?.marketCap ?? null,
      volumeRatio: ratio,
      tags,
      score:
        tags.reduce((a, t) => a + TAG_WEIGHT[t], 0) +
        // 같은 태그면 더 오른 쪽이 먼저다. 등락률을 점수에 살짝만 섞는다
        Math.min(u.changeRate, 30),
    });
  }
  stocks.sort((a, b) => b.score - a.score || b.tradeValue - a.tradeValue);

  /* ---------------- 섹터 묶기 ---------------- */
  /*
   * 업종을 모르는 종목은 **섹터 집계에서 뺀다.**
   *
   * 예전엔 「기타」로 묶었더니 그게 44종목짜리 상위 섹터로 올라왔다.
   * 「기타가 강하다」는 아무 말도 아니다 — 신규상장·재상장처럼 전 종목 스냅샷이
   * 아직 못 담은 것들이 섞인 자루일 뿐이다.
   * **종목 목록에는 그대로 남는다.** 업종을 모른다고 종목이 사라지면 안 된다.
   */
  const bySector = new Map<string, LeaderStock[]>();
  for (const s of stocks) {
    if (!s.sector || !isRealSector(s.sector)) continue;
    if (!bySector.has(s.sector)) bySector.set(s.sector, []);
    bySector.get(s.sector)!.push(s);
  }

  /*
   * 섹터 등락률·폭은 **걸린 종목이 아니라 그 섹터 전체**로 센다.
   * 걸린 종목만으로 재면 전부 오른 종목이라 폭이 늘 100% 가 되어 아무 말도 못 한다.
   */
  const sectorAll = new Map<string, { rate: number; value: number }[]>();
  for (const u of universe) {
    const sec = snap?.byCode.get(u.code)?.sector ?? "";
    if (!sec) continue;
    if (!sectorAll.has(sec)) sectorAll.set(sec, []);
    sectorAll.get(sec)!.push({ rate: u.changeRate, value: Math.round(u.tradeValue / 100) });
  }

  const yesterday = store.days[store.days.length - 1];
  const prevDate = yesterday?.date;

  const sectors: LeaderSector[] = [...bySector.entries()]
    .map(([name, picks]) => {
      const all = sectorAll.get(name) ?? [];
      const totalValue = all.reduce((a, x) => a + x.value, 0);
      const weighted =
        totalValue > 0 ? all.reduce((a, x) => a + x.rate * x.value, 0) / totalValue : 0;
      const simple = all.length > 0 ? all.reduce((a, x) => a + x.rate, 0) / all.length : 0;
      const rising = all.filter((x) => x.rate > 0).length;

      // 지속성 — 어제 기록이 있을 때만. 없으면 null 로 두고 화면에서 「-」로 그린다
      let streak: number | null = null;
      let carryOver: number | null = null;
      if (store.days.length > 0) {
        streak = 0;
        for (let i = store.days.length - 1; i >= 0; i--) {
          if (store.days[i].sectors[name]?.length) streak += 1;
          else break;
        }
        const prev = yesterday?.sectors[name] ?? [];
        if (prev.length > 0) {
          const now = new Set(picks.map((p) => p.code));
          carryOver = (prev.filter((c) => now.has(c)).length / prev.length) * 100;
        }
      }

      return {
        name,
        weightedRate: weighted,
        simpleRate: simple,
        tradeValue: totalValue,
        members: all.length,
        rising,
        breadth: all.length > 0 ? (rising / all.length) * 100 : 0,
        leaders: picks.slice(0, 5),
        streak,
        carryOver,
        news: [] as { title: string; press: string; link: string }[],
      };
    })
    // 「대형주」·「종합(KOSPI)」는 산업이 아니다 — 섹터로 세면 안 된다
    .filter((s) => isRealSector(s.name) && s.members >= cfg.minMembers)
    /*
     * 정렬은 **가중 등락률 × 폭**이다.
     * 등락률만으로 줄 세우면 한 종목이 끌어올린 섹터가 1등으로 온다 — 그건 주도 섹터가 아니다.
     */
    .sort((a, b) => b.weightedRate * b.breadth - a.weightedRate * a.breadth)
    .slice(0, cfg.topSectors);

  /* ---------------- 왜 강한가 ---------------- */
  if (opts.withNews !== false) {
    await Promise.all(
      sectors.slice(0, 4).map(async (sec) => {
        // 섹터명만으로는 기사가 잘 안 걸린다. **대표 종목 이름**을 같이 던진다
        const q = `${sec.leaders[0]?.name ?? ""} ${sec.name}`.trim();
        const items = await searchNews(q, { majorOnly: true, limit: 4 }).catch(
          () => [] as NewsItem[],
        );
        sec.news = items.slice(0, 3).map((n) => ({
          title: n.title,
          press: n.press,
          link: n.link,
        }));
      }),
    );
  }

  /* ---------------- 오늘을 기록 ---------------- */
  const today: DayRecord = {
    date,
    sectors: Object.fromEntries(sectors.map((s) => [s.name, s.leaders.map((l) => l.code)])),
    /*
     * 걸린 종목을 **값까지 통째로** 남긴다.
     * 장중에 여러 번 훑으면 마지막 것으로 덮인다 — 그게 그날의 최종 모습이라 맞다.
     */
    picks: stocks.slice(0, 40).map((t) => ({
      code: t.code,
      name: t.name,
      sector: t.sector,
      price: t.price,
      changeRate: t.changeRate,
      tradeValue: t.tradeValue,
      tags: t.tags,
    })),
  };
  const idx = store.days.findIndex((d) => d.date === date);
  if (idx >= 0) store.days[idx] = today;
  else store.days.push(today);
  await save(store).catch(() => undefined);

  return {
    at: new Date().toISOString(),
    date,
    config: cfg,
    sectors,
    stocks: stocks.slice(0, 60),
    scanned: universe.length,
    belowThreshold,
    note:
      store.days.length <= 1
        ? "오늘이 첫 기록입니다. 지속성(연속일·유지율)은 내일부터 나옵니다."
        : `${store.days.length}일치 기록으로 지속성을 셉니다.${prevDate ? ` (직전 ${prevDate})` : ""}`,
  };
}
