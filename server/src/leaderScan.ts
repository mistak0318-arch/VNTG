import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { tradeValueTop } from "./signalScreen.js";
import { getMarketSnapshot, isRealSector } from "./marketSnapshot.js";
import { searchNews, type NewsItem } from "./newsDisclosure.js";
import { loadCloses } from "./dailyCloses.js";

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

/**
 * 태그 하나 = 근거 한 줄 (2026-09-08). 벤티지: "태그에 숫자를 붙여라" — 「거래량급증」인데 몇 배인지가 없었다.
 */
export interface TagDetail {
  tag: LeaderTag;
  value: number;
  text: string;
  /** 문턱까지 — 툴팁용 */
  hint: string;
}

/** 표식 — 조회 0회. 슈퍼신호등 원장·신호등 분석 원장에서. 원장에 없으면 신호등은 「안 잼」(null) */
export interface LeaderMark {
  super: boolean;
  cross: boolean;
  rainbow: boolean;
  /** 신호등 분석 원장에 살아 있으면 초록 + 최근 점수. 없으면 null = 안 잼(거짓 초록 금지) */
  signal: { level: "green"; score: number } | null;
  hot: string[];
  late: string[];
}

export interface LeaderStock {
  code: string;
  name: string;
  sector: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  marketCap: number | null;
  volumeRatio: number | null;
  tags: LeaderTag[];
  tagDetail: TagDetail[];
  mark: LeaderMark;
  /** 오늘 처음 걸렸나 — 어제 기록에 없던 종목 */
  isNew: boolean;
  score: number;
}

/**
 * **조용한 후보** (2026-09-08) — 판은 도는데 아직 안 움직인 놈.
 * 폭 60% 넘는 섹터의 구성원 중 오늘 +3% 미만·신고가 아님·거래량 2배 미만인 것. 4~8월 표본에서
 * 이긴 자리가 「조용하고 아직 안 몰린」 쪽이었다(신조). 뜨거운 표(걸린 종목)와 같은 줄 모양.
 */
export interface QuietPick {
  code: string;
  name: string;
  sector: string;
  sectorBreadth: number;
  sectorStreak: number | null;
  price: number;
  changeRate: number;
  tradeValue: number;
  /** 5일선 이격(%) — 일봉 파일에서. 없으면 null */
  ma5Gap: number | null;
  mark: LeaderMark;
}

export interface LeaderSector {
  name: string;
  /** 어제 폭 — 「어제 폭 → 오늘 폭」 화살 (어제 기록에 있을 때만) */
  prevBreadth?: number | null;
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
  quiet: QuietPick[];
  /** 오늘 처음 걸린 종목 수 */
  newCount: number;
  /** 태그별 요약 — 카드 넷 */
  tagCards: { tag: LeaderTag; n: number; green: number; sectors: { name: string; n: number }[]; top: { code: string; name: string; changeRate: number }[] }[];
  note: string;
  /** 오늘 거래가 아직 없어 판단 자체가 불가능한 상태인가 (2026-08-31) */
  noTrade?: boolean;
  /** 모집단이 **직전 거래일** 거래대금으로 뽑힌 것인가 (개장 전) */
  staleUniverse?: boolean;
  /** 마감 전이라 이력에 안 남긴 중간 모습인가 */
  intraday?: boolean;
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
  /** 섹터별 폭·가중 등락률 — 「판의 흐름」 격자 (2026-09-08부터 쌓인다) */
  sectorStats?: Record<string, { breadth: number; weightedRate: number; members: number }>;
  /** 조용한 후보 — 뜨거운 쪽과 나란히 5·20일 성적을 재려고 남긴다 */
  quiet?: { code: string; name: string; sector: string; price: number; changeRate: number }[];
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

  /* 표식 색인 — 조회 0회 (2026-09-08). 못 읽으면 표식만 빈다 */
  /* superSignal·listTrack 은 이 파일을 import 한다(⚡ 교차) — 정적 import 면 순환이라 지연 import */
  const [superIdx, listActive] = await Promise.all([
    import("./superSignal.js").then((m) => m.superMarkIndex()).catch(() => new Map<string, { super: boolean; rainbow: boolean; cross: boolean; seenCount: number; score: number; alerts?: { hot: { label: string }[]; late: { label: string }[] } }>()),
    import("./listTrack.js").then((m) => m.activeListEntries()).catch(() => [] as { code: string; score: number }[]),
  ]);
  const listScore = new Map(listActive.map((e) => [e.code, e.score]));
  const markOf = (code: string): LeaderMark => {
    const s = superIdx.get(code);
    const sc = listScore.get(code);
    return {
      super: s?.super ?? false,
      cross: s?.cross ?? false,
      rainbow: s?.rainbow ?? false,
      signal: typeof sc === "number" ? { level: "green", score: Math.round(sc) } : s?.super && s.score > 0 ? { level: "green", score: s.score } : null,
      hot: (s?.alerts?.hot ?? []).map((a) => a.label),
      late: (s?.alerts?.late ?? []).map((a) => a.label),
    };
  };
  const prevRec = store.days[store.days.length - 1];
  const prevCodes = new Set((prevRec?.date !== date ? prevRec : store.days[store.days.length - 2])?.picks?.map((p) => p.code) ?? []);

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
    const tagDetail: TagDetail[] = [];
    if (highs.has(u.code)) {
      tags.push("신고가");
      tagDetail.push({ tag: "신고가", value: 250, text: "250일 신고가", hint: "거래일 250일(≈1년) 최고가를 오늘 넘었다" });
    }
    if (ratio !== null && ratio >= cfg.volumeSpike) {
      tags.push("거래량급증");
      tagDetail.push({ tag: "거래량급증", value: ratio, text: `거래량 ${ratio.toFixed(1)}배`, hint: `문턱 ${cfg.volumeSpike}배 · 지금 ${ratio.toFixed(1)}배 (전일 대비)` });
    }
    if (u.changeRate >= cfg.surgeRate) {
      tags.push("급등");
      tagDetail.push({ tag: "급등", value: u.changeRate, text: `+${u.changeRate.toFixed(1)}%`, hint: `문턱 +${cfg.surgeRate}% · 지금 +${u.changeRate.toFixed(1)}%` });
    }
    /*
     * 태그가 하나도 없으면 **목록에 안 넣는다.**
     * 거래대금만 큰 종목(삼성전자 등)은 늘 상위에 있어서, 그냥 두면 매일 같은 얼굴이
     * 목록을 채우고 정작 오늘 새로 반응한 종목이 묻힌다.
     */
    if (tags.length === 0) continue;
    // 대금이 아주 크면 그것도 근거다 — 다만 단독으로는 못 들어온다
    if (tradeValue >= cfg.minTradeValue * 4) {
      tags.push("대금상위");
      tagDetail.push({ tag: "대금상위", value: tradeValue, text: `대금 ${tradeValue.toLocaleString()}억`, hint: `문턱 ${cfg.minTradeValue}억의 4배(${(cfg.minTradeValue * 4).toLocaleString()}억) 이상` });
    }

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
      tagDetail,
      mark: markOf(u.code),
      isNew: !prevCodes.has(u.code),
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
        prevBreadth: yesterday?.date !== date ? (yesterday?.sectorStats?.[name]?.breadth ?? null) : (store.days[store.days.length - 2]?.sectorStats?.[name]?.breadth ?? null),
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

  /* ---------------- 조용한 후보 (2026-09-08) ---------------- */
  const QUIET_BREADTH = 60;
  const QUIET_MAX_RATE = 3;
  const sectorStatsAll: Record<string, { breadth: number; weightedRate: number; members: number }> = {};
  for (const [name, all] of sectorAll) {
    if (!isRealSector(name) || all.length < cfg.minMembers) continue;
    const totalValue = all.reduce((a, x) => a + x.value, 0);
    sectorStatsAll[name] = {
      breadth: all.length > 0 ? (all.filter((x) => x.rate > 0).length / all.length) * 100 : 0,
      weightedRate: totalValue > 0 ? all.reduce((a, x) => a + x.rate * x.value, 0) / totalValue : 0,
      members: all.length,
    };
  }
  const streakOf = (name: string): number | null => {
    if (store.days.length === 0) return null;
    let n = 0;
    for (let i = store.days.length - 1; i >= 0; i--) {
      if (store.days[i].date === date) continue;
      if (store.days[i].sectors[name]?.length) n += 1;
      else break;
    }
    return n;
  };
  /* 오늘 상위 섹터면 오늘까지 세서 「오늘」 탭의 「N일째」와 같은 수가 되게 (2026-09-08) */
  const topToday = new Set(sectors.map((s) => s.name));
  const streakWithToday = (name: string): number | null => {
    const prior = streakOf(name);
    if (prior === null) return topToday.has(name) ? 1 : null;
    return prior + (topToday.has(name) ? 1 : 0);
  };
  const pickedCodes = new Set(stocks.map((s) => s.code));
  let barsOf: Record<string, { c: number }[]> = {};
  try {
    barsOf = ((await loadCloses()).bars ?? {}) as Record<string, { c: number }[]>;
  } catch {
    /* 일봉 파일이 없으면 이격만 빈다 */
  }
  const ma5GapOf = (code: string, price: number): number | null => {
    const bs = barsOf[code];
    if (!bs || bs.length < 5 || price <= 0) return null;
    const last = bs.slice(-5).map((b) => b.c).filter((v) => v > 0);
    if (last.length < 5) return null;
    const ma = last.reduce((a, b) => a + b, 0) / 5;
    return ((price - ma) / ma) * 100;
  };
  const quiet: QuietPick[] = [];
  for (const u of universe) {
    const tv = Math.round(u.tradeValue / 100);
    if (tv < cfg.minTradeValue) continue;
    const sec = snap?.byCode.get(u.code)?.sector ?? "";
    const st = sectorStatsAll[sec];
    if (!st || st.breadth < QUIET_BREADTH) continue;
    if (pickedCodes.has(u.code)) continue;
    if (u.changeRate >= QUIET_MAX_RATE || u.changeRate < -3) continue;
    if (highs.has(u.code)) continue;
    const ratio = spikes.get(u.code) ?? null;
    if (ratio !== null && ratio >= cfg.volumeSpike) continue;
    quiet.push({
      code: u.code,
      name: u.name,
      sector: sec,
      sectorBreadth: st.breadth,
      sectorStreak: streakWithToday(sec),
      price: u.price,
      changeRate: u.changeRate,
      tradeValue: tv,
      ma5Gap: ma5GapOf(u.code, u.price),
      mark: markOf(u.code),
    });
  }
  /* 판이 센 순 → 신호등 있는 것 먼저 → 이격 작은 순 */
  quiet.sort((a, b) => b.sectorBreadth - a.sectorBreadth || Number(!!b.mark.signal) - Number(!!a.mark.signal) || (a.ma5Gap ?? 99) - (b.ma5Gap ?? 99));

  /* ---------------- 태그 카드 넷 ---------------- */
  const TAGS: LeaderTag[] = ["신고가", "거래량급증", "급등", "대금상위"];
  const tagCards = TAGS.map((tag) => {
    const rows = stocks.filter((s) => s.tags.includes(tag));
    const bySec = new Map<string, number>();
    for (const r of rows) if (r.sector) bySec.set(r.sector, (bySec.get(r.sector) ?? 0) + 1);
    return {
      tag,
      n: rows.length,
      green: rows.filter((r) => r.mark.signal?.level === "green").length,
      sectors: [...bySec.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([name, n]) => ({ name, n })),
      top: rows.slice(0, 3).map((r) => ({ code: r.code, name: r.name, changeRate: r.changeRate })),
    };
  });

  /* ---------------- 오늘을 기록 ---------------- */
  const today: DayRecord = {
    date,
    sectors: Object.fromEntries(sectors.map((s) => [s.name, s.leaders.map((l) => l.code)])),
    sectorStats: Object.fromEntries(Object.entries(sectorStatsAll).map(([k, v]) => [k, { breadth: Math.round(v.breadth), weightedRate: Math.round(v.weightedRate * 100) / 100, members: v.members }])),
    quiet: quiet.slice(0, 40).map((q) => ({ code: q.code, name: q.name, sector: q.sector, price: q.price, changeRate: q.changeRate })),
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
  /*
   * ⚠️ **거래가 아직 없는 시각의 결과로 그날을 굳히지 않는다** (2026-08-31).
   *
   * 장 전(07시대)에는 거래대금 상위가 **전부 0**으로 온다. 그러면 200종목이 통째로
   * 문턱 아래가 되어 주도주 0종목이 나오는데, 예전엔 그걸 그대로 그날 기록으로
   * 저장했다. **조간 리포트가 07시에 만들어지므로 주도주와 교차 신호가 늘 비어
   * 있었다** — 실측에서 거래일 6일이 내리 0종목이었던 이유가 이것이다.
   *
   * 「오늘 주도주가 없다」와 「아직 장이 안 열렸다」는 완전히 다른 말이다.
   * 판단할 재료가 없으면 **아무 말도 안 하고 기록도 남기지 않는다.**
   */
  const noTrade = universe.length > 0 && universe.every((u) => u.tradeValue <= 0);
  /*
   * ⚠️ **정규장이 끝나기 전에는 그날을 기록하지 않는다** (2026-08-31 2차).
   *
   * 「전부 0이면 안 남긴다」만으로는 모자랐다. 08시대 **장전 시간외**에는 거래대금이
   * 0 은 아니지만 아주 작아서(실측 08:03 — SK하이닉스 1,910억, 200종목 중 198개가
   * 500억 문턱 미달) 주도주가 0~2 종목으로 나온다. 그 상태가 그날 기록으로 굳는다.
   *
   * 주도주는 **하루의 결론**이다. 장중 화면에서는 지금 모습을 그대로 보여 주되,
   * 이력에 남기는 것은 마감 뒤여야 한다 — 그래야 「며칠 연속 상위」 같은 지속성
   * 계산이 하루의 결론끼리 비교하는 것이 된다.
   */
  const kst = new Date(Date.now() + 9 * 3600_000);
  const afterClose = kst.getUTCHours() > 15 || (kst.getUTCHours() === 15 && kst.getUTCMinutes() >= 30);
  /*
   * ⚠️ **주말·휴장일에는 기록하지 않는다** (2026-08-31 3차).
   *
   * 토요일에 스캔하면 키움은 **금요일 자료**를 준다. 그걸 「토요일」 기록으로 저장하면
   * 같은 하루가 이틀·사흘로 세어진다 — 실측에서 8/28(금)·8/29(토)·8/30(일)이 전부
   * 같은 21종목이었다. 「며칠 연속 상위」와 「어제 종목 유지율」이 그만큼 부풀려진다.
   *
   * 지속성은 이 기능의 핵심 물음이라(「그 강함이 유지되는가」) 여기가 부풀면
   * 기능 전체가 거짓말이 된다.
   */
  const dow = kst.getUTCDay();
  const tradingDay = dow >= 1 && dow <= 5;
  if (!noTrade && afterClose && tradingDay) {
    const idx = store.days.findIndex((d) => d.date === date);
    if (idx >= 0) store.days[idx] = today;
    else store.days.push(today);
    await save(store).catch(() => undefined);
  }

  return {
    at: new Date().toISOString(),
    date,
    config: cfg,
    sectors,
    stocks: stocks.slice(0, 60),
    scanned: universe.length,
    belowThreshold,
    quiet: quiet.slice(0, 40),
    newCount: stocks.filter((s) => s.isNew).length,
    tagCards,
    /*
     * `noTrade` 를 밖으로 알린다 — 화면이 「없다」와 「아직 모른다」를 갈라
     * 말할 수 있어야 한다. 빈 목록만 던지면 둘이 똑같아 보인다.
     */
    noTrade,
    staleUniverse: universe.some((u) => u.stale),
    /** 지금 본 것이 하루의 결론인가 — 아니면 장중 중간 모습인가 */
    intraday: !afterClose,
    note: noTrade
      ? "아직 오늘 거래가 없습니다 — 장이 열린 뒤에 판단합니다 (기록도 남기지 않습니다)."
      : !tradingDay
        ? "장이 없는 날입니다 — 직전 거래일 자료를 보여 주되 이력에는 안 남깁니다."
        : !afterClose
          ? "장중 중간 모습입니다 — 마감(15:30) 뒤 값으로 이력에 남깁니다."
      : store.days.length <= 1
        ? "오늘이 첫 기록입니다. 지속성(연속일·유지율)은 내일부터 나옵니다."
        : `${store.days.length}일치 기록으로 지속성을 셉니다.${prevDate ? ` (직전 ${prevDate})` : ""}`,
  };
}

/* ------------------------------------------------------------------ */
/* 판의 흐름 — 날짜 × 섹터 격자 (2026-09-08)                              */
/* ------------------------------------------------------------------ */

export interface LeaderFlow {
  dates: string[];
  /** 창 안에 한 번이라도 상위에 든 섹터 — 등장 횟수 많은 순 */
  sectors: { name: string; days: number; streak: number; today: boolean }[];
  /** [섹터][날짜] — 상위에 들었으면 picks>0. breadth·rate 는 09-08 뒤 기록에만 */
  cells: Record<string, Record<string, { picks: number; breadth: number | null; rate: number | null }>>;
  /** 날짜별 「어제와 같은 섹터 비율」 — 순환인가 지속인가 */
  overlap: Record<string, number | null>;
}

export async function leaderFlow(days = 10): Promise<LeaderFlow> {
  const store = await load();
  const win = store.days.slice(-Math.max(2, Math.min(days, 40)));
  const dates = win.map((d) => d.date);
  const count = new Map<string, number>();
  for (const d of win) for (const s of Object.keys(d.sectors)) count.set(s, (count.get(s) ?? 0) + 1);
  const last = win[win.length - 1];
  const streakOf = (name: string) => {
    let n = 0;
    for (let i = win.length - 1; i >= 0; i--) {
      if (win[i].sectors[name]?.length) n += 1;
      else break;
    }
    return n;
  };
  const sectors = [...count.entries()]
    .map(([name, n]) => ({ name, days: n, streak: streakOf(name), today: !!last?.sectors[name]?.length }))
    .sort((a, b) => Number(b.today) - Number(a.today) || b.streak - a.streak || b.days - a.days);
  const cells: LeaderFlow["cells"] = {};
  for (const s of sectors) {
    cells[s.name] = {};
    for (const d of win) {
      const st = d.sectorStats?.[s.name];
      cells[s.name][d.date] = { picks: d.sectors[s.name]?.length ?? 0, breadth: st ? st.breadth : null, rate: st ? st.weightedRate : null };
    }
  }
  const overlap: Record<string, number | null> = {};
  for (let i = 0; i < win.length; i++) {
    const cur = new Set(Object.keys(win[i].sectors));
    const prev = i > 0 ? new Set(Object.keys(win[i - 1].sectors)) : null;
    overlap[win[i].date] = prev && prev.size > 0 ? ([...cur].filter((x) => prev.has(x)).length / prev.size) * 100 : null;
  }
  return { dates, sectors, cells, overlap };
}

/* ------------------------------------------------------------------ */
/* 자동 기록                                                            */
/* ------------------------------------------------------------------ */

/**
 * 장 마감 뒤에 하루 한 번 자동으로 훑는다.
 *
 * ## 왜 이게 있어야 하나
 *
 * 이게 없으면 **화면을 열어야만 그날이 기록된다.** 바쁜 날 안 열면 그날은 영영 빈다.
 * 가격은 나중에 일봉으로 되짚을 수 있지만 **그때의 거래대금·태그·섹터 폭은 되살릴
 * 방법이 없다.** 「며칠 연속 강한 섹터」를 세는 기능인데 기록에 구멍이 나면 연속 계산
 * 자체가 틀린다 — 하루 못 열었다고 3일 연속이 1일로 리셋된다.
 *
 * **15:35 에 돈다.** 정규장이 15:30 에 끝나므로 그때가 그날의 최종 모습이다.
 * 신호등 추적기(15:40)보다 살짝 앞에 둬서 둘이 같은 순간에 키움을 두들기지 않게 한다.
 *
 * 뉴스는 **끄고** 돈다. 자동 실행이 매일 네이버를 부르면 할당량이 조용히 녹는다 —
 * 「왜 강한가」는 사람이 볼 때 누르면 된다.
 */
export function startLeaderScanScheduler(client: KiwoomClient): void {
  const CHECK_MS = 5 * 60_000;
  let running = false;

  const tick = async () => {
    if (running) return;
    const now = new Date();
    const weekday = now.getDay() !== 0 && now.getDay() !== 6;
    const mins = now.getHours() * 60 + now.getMinutes();
    // 15:35 ~ 16:05 사이에 한 번 걸리면 된다
    if (!weekday || mins < 15 * 60 + 35 || mins > 16 * 60 + 5) return;

    // 오늘 이미 적었으면 넘어간다 — 화면에서 먼저 열어 봤을 수도 있다
    const store = await load().catch(() => null);
    const today = kstDate();
    if (store?.days.some((d) => d.date === today && (d.picks?.length ?? 0) > 0)) return;

    running = true;
    try {
      const r = await leaderScan(client, { withNews: false });
      console.log(
        `[leaderScan] ${r.date} — 섹터 ${r.sectors.length} · 종목 ${r.stocks.length} (${r.scanned}종목 훑음)`,
      );
    } catch (err) {
      console.error("[leaderScan] 실패:", err);
    } finally {
      running = false;
    }
  };

  void tick();
  setInterval(() => void tick(), CHECK_MS);
  console.log("[leaderScan] 주도주 탐색기 시작 — 평일 15:35 자동 기록");
}
