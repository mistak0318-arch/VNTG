import type { KiwoomClient } from "./kiwoomClient.js";
import { isTradingDay } from "./tradingDay.js";
import { dropPhantomToday } from "./candleGuard.js";
import { indexDetail } from "./indexDetail.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { futuresFlow } from "./naverFuturesFlow.js";
import { listSectorFlow, type SectorFlowDay } from "./sectorFlowStore.js";
import type { Level } from "./signalLight.js";
import { marketThermo } from "./marketLens.js";
import { usMajorIndices } from "./usMajor.js";
import { promises as fs } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HIST_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "marketSignalHistory.json");

/**
 * 시장 전체 신호등.
 *
 * 종목 신호등은 "이 종목이 내 기준에 맞나"를 본다. 그런데 **아무리 좋은 종목도 시장이
 * 무너지는 날엔 같이 빠진다.** 종목을 고르기 전에 지금이 살 자리인지 쉴 자리인지를
 * 먼저 봐야 하는데, 그걸 볼 화면이 없었다.
 *
 * 판정 항목을 고른 기준은 **지금 손에 있는 데이터의 깊이**다.
 * A/D 라인은 breadth.json 이 2일치뿐이고 백필이 안 되므로(수집 시점 이후로만 쌓인다)
 * 여기에 기대면 몇 달을 기다려야 한다. 그래서 히스토리가 이미 깊거나 아예 필요 없는
 * 것들로만 짰다.
 *
 *   지수 추세    ka10081 일봉 — 무제한 백필
 *   시장 폭      오늘 스냅샷 2,200여 종목 — 히스토리 불필요, 조회 0회
 *   업종 확산    오늘 업종 등락률 — 히스토리 불필요, 조회 0회
 *   외국인·기관  sectorFlow 58일 — ka10051 base_dt 로 백필해 둔 것
 *
 * 종목 신호등과 같은 초록/노랑/빨강 체계를 쓴다. 읽는 법을 새로 배울 이유가 없다.
 */

const CHART = "/api/dostk/chart";

/**
 * 지수 일봉은 **ka20006 업종일봉으로 직접** 받는다 (업종코드 001=코스피, 101=코스닥).
 *
 * 처음엔 지수 ETF(069500)를 대신 썼는데, 실측해 보니 하루 고저 폭이 20%에 회전율이
 * 17%로 찍히는 날들이 있었다. 지수를 따라간다고 볼 수 없는 값이라 20일선 기울기 같은
 * 지표를 태우면 추세가 아니라 잡음을 읽게 된다. 지수 자체가 열려 있으니 그걸 쓴다.
 */
const INDEX_CODES = [
  { label: "코스피", code: "001" },
  { label: "코스닥", code: "101" },
] as const;

/** 지수 자체를 나타내는 행. 시장 전체 순매수가 여기 들어 있다 */
const TOTAL_CODE: Record<"kospi" | "kosdaq", string> = { kospi: "001", kosdaq: "101" };

/** SUBJECTS 배열에서의 자리 — sectorFlowStore 의 v[] 순서와 같아야 한다 */
const IDX_FOREIGN = 0;
const IDX_INSTITUTION = 1;

export interface MarketCheck {
  key: string;
  label: string;
  /** true=우호적, false=비우호적, null=판단 불가 **또는 중립** — 중립이면 `neutral` 이 true */
  pass: boolean | null;
  /**
   * **중립** (2026-09-07 밤) — 값은 있는데 방향이 없는 것(폭 45~55%, 에너지 65~100%, 지수 둘이 갈림…).
   * 「모름」(데이터 없음)과 갈라야 한다. 여태 둘을 같이 `null` 로 두고 「판정 가능한 무게 50% 미만이면 보류」로
   * 굴렸더니, 중립이 셋만 겹치면 나머지가 다 우호(100점)여도 「판단할 데이터가 부족하다」가 떴다 — 벤티지:
   * "시장 신호등 제대로 동작하는 거 맞아? 전광판이랑 다르네." 중립은 반 점을 받고 판정에 들어간다.
   */
  neutral?: boolean;
  /**
   * **흐름** (2026-09-07 밤, 국면 판정기) — 오늘 값만 보면 하루짜리 반등도 초록이 된다.
   * up = 개선 중 · down = 악화 중 · flat = 그대로. 어떻게 쟀는지는 항목마다 다르다(value 에 적힌다)
   */
  arrow?: "up" | "down" | "flat" | null;
  /** 화면에 그대로 보여줄 실제 값 */
  value: string;
  /** 왜 이 항목을 보는가 — 화면에서 펼쳐 읽는다 */
  why: string;
  weight: number;
}

export type RegimeKey = "up" | "rebound" | "range" | "down" | "fear" | "split";
export interface MarketRegime {
  key: RegimeKey;
  name: string;
  /** 국면마다 행동 한 줄 */
  action: string;
  /** 「한쪽만 도는 장」이면 어느 쪽인가 */
  side?: "코스피" | "코스닥";
  /** 왜 이 국면인지 — 결정적인 근거 두셋 */
  why: string[];
}

export interface MarketSignal {
  level: Level;
  /** 통과 가중치 / 판단 가능한 가중치 × 100 */
  score: number;
  checks: MarketCheck[];
  /** 한 줄 요약 — 리포트·텔레그램에 그대로 넣는다 */
  summary: string;
  evaluatedAt: string;
  /** 국면 판정 (2026-09-07 밤) — 점수 하나로 뭉개지 않는다 */
  regime: MarketRegime;
  /** 장 초반(09:00~09:30)엔 폭·에너지가 아직 덜 움직였다 — 화면이 적는다 */
  note?: string;
}

/** 하루 한 줄 — 15:35 판정을 남겨 나중에 「맞았나」를 센다 */
export interface MarketSignalDay {
  date: string;
  level: Level;
  score: number;
  regime: RegimeKey;
  /** 그날 코스피 종가(지수×100 그대로) — 수익률은 비율만 쓴다 */
  kospi: number | null;
  /** 지수·수급만으로 되짚은 부분 백필 — 폭·에너지·선물이 빠졌다 */
  backfilled?: boolean;
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, "").replace(/^--/, "-"));
  return Number.isFinite(n) ? n : 0;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 업종(지수) 일봉 종가 — 최신순. 값은 지수×100 으로 오지만 비율만 쓰므로 그대로 둔다 */
async function indexCloses(client: KiwoomClient, indsCode: string): Promise<number[]> {
  const { data } = await client.request<{ inds_dt_pole_qry?: Record<string, unknown>[] }>(
    CHART,
    "ka20006",
    // base_dt 가 비면 키움이 데이터를 아예 안 준다
    { inds_cd: indsCode, base_dt: ymd(new Date()) },
  );
  const rows = dropPhantomToday(Array.isArray(data.inds_dt_pole_qry) ? (data.inds_dt_pole_qry as Record<string, unknown>[]) : []);
  return rows.map((r) => Math.abs(toNum(r.cur_prc))).filter((n) => n > 0);
}

function sma(xs: number[], period: number, offset = 0): number | null {
  if (xs.length < period + offset) return null;
  return xs.slice(offset, offset + period).reduce((a, b) => a + b, 0) / period;
}

// ---------------------------------------------------------------- 개별 판정

/**
 * 지수 추세 — 20일선 위인가, 그리고 20일선이 오르고 있는가.
 *
 * 둘을 같이 보는 이유: 20일선 위라도 선 자체가 내려오는 중이면 반등이지 추세가 아니다.
 * 코스피·코스닥 둘 다 봐서, 하나만 좋으면 절반만 준다 — 한쪽 시장만 도는 장이 실제로 많다.
 */
export interface TrendDetail {
  label: string;
  above20: boolean;
  ma20Rising: boolean | null;
  above60: boolean | null;
  /** 20일선이 60일선 위(골든)인가, 며칠째인가 */
  golden: boolean | null;
  crossDays: number | null;
  gap20: number;
  ok: boolean | null;
}
let lastTrendDetail: TrendDetail[] = [];

async function checkTrend(client: KiwoomClient): Promise<MarketCheck> {
  const results = await Promise.all(
    INDEX_CODES.map(async (idx) => {
      const c = await indexCloses(client, idx.code).catch(() => []);
      const now = c[0] ?? null;
      const ma20 = sma(c, 20);
      const ma20Prev = sma(c, 20, 5); // 5일 전의 20일선
      if (now === null || ma20 === null) return { ...idx, ok: null as boolean | null, text: "-", detail: null as TrendDetail | null };
      const above = now > ma20;
      const rising = ma20Prev !== null ? ma20 > ma20Prev : null;
      const gap = ((now - ma20) / ma20) * 100;
      /* 60일선과의 관계 — 20일선이 60일선 위면 골든, 며칠째인지 센다(최대 60일 되짚음) */
      const ma60 = sma(c, 60);
      const above60 = ma60 !== null ? now > ma60 : null;
      let golden: boolean | null = null;
      let crossDays: number | null = null;
      if (ma60 !== null) {
        golden = ma20 > ma60;
        crossDays = 0;
        for (let k = 0; k < 60; k++) {
          const a = sma(c, 20, k);
          const b = sma(c, 60, k);
          if (a === null || b === null) break;
          if ((a > b) !== golden) break;
          crossDays += 1;
        }
      }
      const ok = above && rising !== false;
      const detail: TrendDetail = { label: idx.label, above20: above, ma20Rising: rising, above60, golden, crossDays, gap20: gap, ok };
      return {
        ...idx,
        ok,
        detail,
        text: `${idx.label} 20선 ${above ? "위" : "아래"} ${gap > 0 ? "+" : ""}${gap.toFixed(1)}%${rising === false ? " 선↓" : rising ? " 선↑" : ""}${golden === null ? "" : golden ? ` 골든 ${crossDays}일` : ` 데드 ${crossDays}일`}`,
      };
    }),
  );
  lastTrendDetail = results.map((r) => r.detail).filter((d): d is TrendDetail => d !== null);

  const known = results.filter((r) => r.ok !== null);
  const good = known.filter((r) => r.ok).length;
  const risingN = results.filter((r) => r.detail?.ma20Rising === true).length;
  const fallingN = results.filter((r) => r.detail?.ma20Rising === false).length;
  return {
    key: "trend",
    label: "지수 추세",
    pass: known.length === 0 ? null : good === known.length ? true : good === 0 ? false : null,
    neutral: known.length > 0 && good > 0 && good < known.length,
    arrow: risingN > fallingN ? "up" : fallingN > risingN ? "down" : "flat",
    value: results.map((r) => r.text).join(" / "),
    why: "지수가 20일선 위에 있고 그 선이 우상향이면 추세가 살아 있는 것이다. 선 위라도 선 자체가 내려오는 중이면 추세가 아니라 반등이다. 코스피·코스닥이 갈리면 한쪽 시장만 도는 장이므로 '판단 보류'로 둔다.",
    weight: 30,
  };
}

/**
 * 시장 폭 — 오늘 오른 종목이 얼마나 되나.
 *
 * 지수만 보면 소수 대형주가 끌어올린 장을 상승장으로 오해한다.
 * 스냅샷에 2,200여 종목이 이미 있으므로 조회를 한 번도 더 하지 않는다.
 */
function checkBreadth(rates: number[], thermo: { above20: number | null; above20d5: number | null }): MarketCheck {
  const total = rates.length;
  const th = thermo.above20 !== null ? ` · 20선 위 종목 ${thermo.above20.toFixed(0)}%${thermo.above20d5 !== null ? ` (5일 ${thermo.above20d5 > 0 ? "+" : ""}${thermo.above20d5.toFixed(0)}%p)` : ""}` : "";
  const arrow: MarketCheck["arrow"] = thermo.above20d5 === null ? null : thermo.above20d5 > 3 ? "up" : thermo.above20d5 < -3 ? "down" : "flat";
  const why =
    "전체 종목 중 오른 종목의 비율(보합 제외). 지수가 올라도 이 값이 45% 아래면 소수 대형주가 끌어올린 장이라 내 종목은 안 올랐을 가능성이 크다. 55% 위면 상승이 시장 전반에 퍼진 것이다.";
  if (total === 0) {
    return { key: "breadth", label: "시장 폭", pass: null, value: "-", why, weight: 20 };
  }
  const up = rates.filter((r) => r > 0).length;
  const down = rates.filter((r) => r < 0).length;
  /*
   * ⚠️ **보합을 분모에서 뺀다** (2026-08-27 — "잘 안 맞는 것 같다" 점검에서 발견).
   * 예전엔 up/전체 로 쟀는데, 개장 전·개장 직후에는 대부분이 0% 라 상승비율이
   * 0%로 곤두박질쳐 **아침마다 빨간불**이 됐다. 시장이 나쁜 게 아니라 아직 안
   * 움직인 것이다. 움직인 종목(up+down)만으로 재고, 움직인 게 전체의 30%도
   * 안 되면 「아직 판단할 장이 아니다」로 보류한다.
   */
  const moved = up + down;
  if (moved < total * 0.3) {
    return {
      key: "breadth",
      label: "시장 폭",
      pass: null,
      arrow,
      value: `움직인 종목 ${moved}/${total} — 장 시작 전이거나 직후${th}`,
      why,
      weight: 20,
    };
  }
  const pct = (up / moved) * 100;
  return {
    key: "breadth",
    label: "시장 폭",
    // 55% 위면 확산, 45% 아래면 위축. 그 사이는 방향이 없는 것이지 좋은 것도 나쁜 것도 아니다
    pass: pct >= 55 ? true : pct <= 45 ? false : null,
    neutral: pct > 45 && pct < 55,
    arrow,
    /*
     * ⚠️ **모집단을 값에 적는다** (2026-08-31 점검).
     *
     * 이 수는 전종목 스냅샷(보통주 위주)을 우리가 센 것이고, 같은 리포트 위쪽의
     * 「KOSPI 상승 640 / 하락 238」은 **거래소 집계**(ETF·우선주 포함)다. 원천이
     * 다르니 합이 안 맞는 게 정상인데, 나란히 놓이면 사람도 AI 도 「하나가 틀렸다」로
     * 읽는다 — 실제로 디제스트에서 1,597 대 1,541 로 어긋나 보였다.
     */
    value: `상승비율 ${pct.toFixed(0)}% (↑${up} ↓${down} / ${total})${th}`,
    why,
    weight: 20,
  };
}

/**
 * 업종 확산 — 오른 업종이 얼마나 되나.
 *
 * 시장 폭과 비슷해 보이지만 다르다. 폭은 종목 수, 이건 업종 수다.
 * 종목은 많이 올랐는데 업종이 몇 개뿐이면 한 테마에 쏠린 장이다.
 *
 * 업종 등락률은 **스냅샷의 종목을 업종별로 묶어서** 낸다. sectorFlow(ka10051)에도
 * changeRate 필드가 있지만 그 TR은 값을 채워 주지 않아 늘 0이다 — 저장된 58일치가
 * 전부 0인 걸 확인했다. 스냅샷은 애초에 업종별로 훑어 만든 것이라 묶는 데 비용이 안 든다.
 */
function checkSectorSpread(bySector: Map<string, number[]>): MarketCheck {
  if (bySector.size === 0) {
    return { key: "sectorSpread", label: "업종 확산", pass: null, value: "-", why: "", weight: 15 };
  }
  // 업종 지수 대신 구성종목 등락률의 중앙값을 쓴다 — 한두 종목의 급등에 안 흔들린다
  const median = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  };
  const sectorRates = [...bySector.values()].filter((xs) => xs.length >= 3).map(median);
  if (sectorRates.length === 0) {
    return { key: "sectorSpread", label: "업종 확산", pass: null, value: "-", why: "", weight: 10 };
  }
  /* 시장 폭과 같은 개장 전 가드 — 중앙값이 거의 다 0이면 아직 안 움직인 것이다 */
  const movedSectors = sectorRates.filter((r) => Math.abs(r) > 0.01);
  if (movedSectors.length < sectorRates.length * 0.3) {
    return {
      key: "sectorSpread",
      label: "업종 확산",
      pass: null,
      value: "장 시작 전이거나 직후",
      why: "오른 업종의 비율(보합 업종 제외). 여러 업종이 함께 오르는 장이 오래간다.",
      weight: 10,
    };
  }
  const up = movedSectors.filter((r) => r > 0).length;
  const pct = (up / movedSectors.length) * 100;
  return {
    key: "sectorSpread",
    label: "업종 확산",
    pass: pct >= 55 ? true : pct <= 40 ? false : null,
    neutral: pct > 40 && pct < 55,
    value: `${up}/${movedSectors.length} 업종 상승 (${pct.toFixed(0)}%)`,
    why: "오른 업종의 비율. 업종마다 구성종목 등락률의 중앙값으로 판정한다. 종목은 많이 올랐는데 업종 수가 적으면 한 테마에 쏠린 장이라, 그 테마가 식으면 시장이 같이 꺼진다. 여러 업종이 함께 오르는 장이 오래간다.",
    weight: 10,
  };
}

/**
 * 수급 — 외국인·기관의 5일 누적 순매수.
 *
 * 하루치는 노이즈다. 5일을 누적해야 방향이 보인다.
 * 개인은 보지 않는다 — 외국인·기관이 사면 개인은 자동으로 반대편이라 정보가 없다.
 */
function checkFlow(
  days: SectorFlowDay[],
  subjectIndex: number,
  key: string,
  label: string,
  why: string,
  weight: number,
): MarketCheck {
  const recent = days.slice(-5);
  if (recent.length === 0) {
    return { key, label, pass: null, value: "데이터 없음", why, weight };
  }

  let sum = 0;
  let today = 0;
  for (const day of recent) {
    const isLast = day === recent[recent.length - 1];
    for (const market of ["kospi", "kosdaq"] as const) {
      const row = day[market].find((r) => r.code === TOTAL_CODE[market]);
      const v = row?.v[subjectIndex] ?? 0;
      sum += v;
      if (isLast) today += v;
    }
  }

  const fmt = (n: number) => `${n > 0 ? "+" : ""}${Math.round(n).toLocaleString("ko-KR")}억`;
  /*
   * **「당일」이라고 쓰면 안 된다.**
   *
   * 수급은 장이 끝난 뒤에만 저장한다(진행 중인 값을 최종값으로 굳히면 안 되므로).
   * 그래서 장중에 이 화면을 보면 마지막 저장분은 **어제**다. 그걸 「당일」이라고 부르면
   * 오늘 −3.8조가 빠진 것처럼 읽힌다 — 실제로 그렇게 오해했다.
   * 날짜를 그대로 적는다.
   */
  const lastDate = recent[recent.length - 1]?.date ?? "";
  const lastLabel = lastDate ? lastDate.slice(5) : "최근일";
  return {
    key,
    label,
    // 5일 누적이 0 근처면 방향이 없는 것이다. ±1,000억 안쪽은 중립으로 둔다
    pass: sum > 1000 ? true : sum < -1000 ? false : null,
    neutral: sum >= -1000 && sum <= 1000,
    /* 오늘이 5일 방향과 같으면 유지, 반대면 전환 조짐 */
    arrow: Math.abs(today) < 500 ? "flat" : (today > 0) === (sum > 0) ? (today > 0 ? "up" : "down") : today > 0 ? "up" : "down",
    value: `5일 ${fmt(sum)} · ${lastLabel} ${fmt(today)}${Math.abs(today) >= 500 && (today > 0) !== (sum > 0) ? " ⚡전환 조짐" : ""}`,
    why,
    weight: recent.length >= 5 ? weight : Math.round(weight / 2), // 표본이 얕으면 무게를 줄인다
  };
}

/**
 * 거래 에너지 — 코스피 거래대금이 20일 평균 대비 얼마나 도는가 (2026-08-27 추가).
 *
 * 지수가 올라도 대금이 평소의 60% 면 팔 사람이 없어서 오르는 것이라 힘이 없고,
 * 대금이 도는 상승이라야 이어진다. 재료는 지수 일봉(ka20006)의 거래대금 — 거래대금
 * 현황 카드와 같은 값이다.
 *
 * ⚠️ 장중엔 오늘 봉이 **지금까지의 누적**이라 그대로 평균과 견주면 늘 모자라 보인다.
 * 장 경과 시간으로 나눠 하루치로 환산해 견준다(9:00~15:30 기준). 개장 45분 전까지는
 * 표본이 얕아 보류.
 */
async function checkEnergy(client: KiwoomClient): Promise<MarketCheck> {
  const why =
    "코스피 거래대금 ÷ 20일 평균. 대금이 마른 상승은 팔 사람이 없어 오르는 것이라 힘이 없다. 장중에는 경과 시간으로 하루치를 환산해 견준다.";
  try {
    const d = await indexDetail(client, "001", "day");
    const cs = d.candles;
    if (cs.length < 22) {
      return { key: "energy", label: "거래 에너지", pass: null, value: "-", why, weight: 10 };
    }
    const today = cs[cs.length - 1];
    const last20 = cs.slice(-21, -1);
    const avg = last20.reduce((a, c) => a + c.tradeValue, 0) / last20.length;
    if (avg <= 0) {
      return { key: "energy", label: "거래 에너지", pass: null, value: "-", why, weight: 10 };
    }
    /* 장중 보정 — KST 9:00~15:30 (390분) */
    const k = new Date(Date.now() + 9 * 3600_000);
    const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
    const openMin = 9 * 60;
    const closeMin = 15 * 60 + 30;
    let value = today.tradeValue;
    let note = "";
    if (mins >= openMin - 0 && mins < openMin + 45 && k.getUTCDay() >= 1 && k.getUTCDay() <= 5) {
      return {
        key: "energy",
        label: "거래 에너지",
        pass: null,
        value: "개장 직후 — 표본이 얕아 보류",
        why,
        weight: 10,
      };
    }
    if (mins >= openMin && mins < closeMin) {
      const elapsed = Math.max(0.12, (mins - openMin) / (closeMin - openMin));
      value = today.tradeValue / elapsed;
      note = " (장중 환산)";
    }
    const ratio = (value / avg) * 100;
    return {
      key: "energy",
      label: "거래 에너지",
      pass: ratio >= 100 ? true : ratio <= 65 ? false : null,
      neutral: ratio > 65 && ratio < 100,
      value: `20일 평균의 ${ratio.toFixed(0)}%${note}`,
      why,
      weight: 10,
    };
  } catch {
    return { key: "energy", label: "거래 에너지", pass: null, value: "조회 실패", why, weight: 10 };
  }
}

/**
 * 외국인 선물 — 최근일 K200 지수선물 순매수 (2026-08-27 추가, 네이버 계약).
 *
 * 현물 수급은 마감 후에만 쌓여 장중엔 어제 것이지만, 선물은 외국인이 **방향을 거는
 * 자리**라 시장 판단에 한 발 앞선다. 크게 팔면(수천 계약) 현물이 버텨도 곧 눌린다.
 */
async function checkFutForeign(): Promise<MarketCheck> {
  const why =
    "외국인의 K200 지수선물 순매수(계약, 네이버 ±10분). 선물은 방향을 거는 자리라 현물 수급보다 앞선다. ±2,000계약 안쪽은 중립.";
  try {
    const days = await futuresFlow(5);
    const last = days[days.length - 1];
    if (!last) {
      return { key: "futForeign", label: "외인 선물", pass: null, value: "-", why, weight: 10 };
    }
    const v = last.foreign;
    return {
      key: "futForeign",
      label: "외인 선물",
      pass: v > 2000 ? true : v < -2000 ? false : null,
      neutral: v >= -2000 && v <= 2000,
      value: `${last.date.slice(5)} ${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}계약`,
      why,
      weight: 10,
    };
  } catch {
    return { key: "futForeign", label: "외인 선물", pass: null, value: "조회 실패", why, weight: 10 };
  }
}

// ---------------------------------------------------------------- 종합

const CACHE_TTL_MS = 10 * 60_000;
let cache: { data: MarketSignal; at: number } | null = null;

export async function evaluateMarket(client: KiwoomClient, force = false): Promise<MarketSignal> {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;

  const [trend, snap, flowDays, energy, futFor, thermo, us] = await Promise.all([
    checkTrend(client),
    getMarketSnapshot(client).catch(() => null),
    listSectorFlow(30).catch(() => [] as SectorFlowDay[]),
    checkEnergy(client),
    checkFutForeign(),
    marketThermo().catch(() => null),
    usMajorIndices(false).catch(() => null),
  ]);
  const a20 = thermo?.series.above20 ?? [];
  const above20 = a20.length ? a20[a20.length - 1] : null;
  const above20d5 = a20.length > 5 ? a20[a20.length - 1] - a20[a20.length - 6] : null;
  const vix = us?.rows.find((r) => r.key === "vix")?.price ?? null;

  const stocks = snap ? [...snap.byCode.values()] : [];
  const rates = stocks.map((s) => s.changeRate);
  const bySector = new Map<string, number[]>();
  for (const s of stocks) {
    if (!s.sector) continue;
    const key = `${s.market}|${s.sector}`;
    const arr = bySector.get(key);
    if (arr) arr.push(s.changeRate);
    else bySector.set(key, [s.changeRate]);
  }

  const checks: MarketCheck[] = [
    trend,
    checkBreadth(rates, { above20, above20d5 }),
    checkSectorSpread(bySector),
    checkFlow(
      flowDays,
      IDX_FOREIGN,
      "foreignFlow",
      "외국인 수급",
      "외국인의 5일 누적 순매수. 하루치는 노이즈라 방향이 안 보이지만 5일을 쌓으면 보인다. 외국인이 파는 장에서는 개별 재료가 잘 안 먹힌다.",
      15,
    ),
    checkFlow(
      flowDays,
      IDX_INSTITUTION,
      "instFlow",
      "기관 수급",
      "기관의 5일 누적 순매수. 외국인과 방향이 같으면 신호가 강하고, 엇갈리면 한쪽이 곧 꺾인다는 뜻이라 판단을 미루는 게 낫다.",
      15,
    ),
    /* 2026-08-27 추가 — 쌓아 둔 데이터로 판을 더 넓게 본다: 돈이 도는가 + 외인의 방향 */
    energy,
    futFor,
  ];

  /*
   * 점수는 **판단 가능한 항목만으로** 낸다.
   * 데이터가 없는 항목을 미달로 세면 수집이 덜 된 초기에 항상 빨간불이 된다 —
   * 시장이 나쁜 게 아니라 우리가 모르는 것인데, 둘을 섞으면 화면을 믿을 수 없게 된다.
   */
  /* 중립(값은 있으나 방향 없음)은 반 점 — 「모름」(데이터 없음)만 판정에서 뺀다 (2026-09-07 밤) */
  const decidable = checks.filter((c) => c.pass !== null || c.neutral === true);
  const totalWeight = decidable.reduce((s, c) => s + c.weight, 0);
  const gained = decidable.reduce((s, c) => s + (c.pass === true ? c.weight : c.neutral ? c.weight / 2 : 0), 0);
  const score = totalWeight > 0 ? Math.round((gained / totalWeight) * 100) : 0;

  // 데이터가 있는 무게가 절반도 안 되면 점수를 매기지 않는다
  const allWeight = checks.reduce((s, c) => s + c.weight, 0);
  const raw: Level =
    totalWeight < allWeight * 0.5 ? "unknown" : score >= 70 ? "green" : score >= 40 ? "yellow" : "red";

  /*
   * 지수 추세가 판단 보류면 초록을 주지 않는다.
   *
   * 나머지가 다 좋아도 추세가 확인 안 된 건 대개 **반등 국면**이다 — 지수가 20일선 위로
   * 올라왔지만 그 선은 아직 내려오는 중인 상태. 그때 초록불을 켜면 되돌림을 추세로
   * 오해하게 된다. 가장 무거운 항목(w30)이 비었는데 100점이라고 단정하는 건 화면이
   * 거짓말을 하는 것이다.
   */
  const trendUnclear = trend.pass === null;
  const level: Level = raw === "green" && trendUnclear ? "yellow" : raw;

  const good = decidable.filter((c) => c.pass === true).map((c) => c.label);
  const mid = decidable.filter((c) => c.pass === null && c.neutral).map((c) => c.label);
  const bad = decidable.filter((c) => c.pass === false).map((c) => c.label);
  const unknownN = checks.length - decidable.length;
  const body = [good.length > 0 ? `우호 ${good.join("·")}` : "", mid.length > 0 ? `중립 ${mid.join("·")}` : "", bad.length > 0 ? `비우호 ${bad.join("·")}` : "", unknownN > 0 ? `모름 ${unknownN}` : ""]
    .filter(Boolean)
    .join(" / ");
  const summary =
    level === "unknown"
      ? `판단할 데이터가 부족하다 (${body})`
      : raw === "green" && trendUnclear
        ? `${score}점이지만 코스피·코스닥이 갈려 노랑 — ${body}`
        : `${score}점 — ${body}`;

  const regime = judgeRegime({ trend, checks, above20, above20d5, vix, breadthPct: breadthPctOf(checks) });
  const k = new Date(Date.now() + 9 * 3600_000);
  const hm = k.getUTCHours() * 60 + k.getUTCMinutes();
  const note = hm >= 540 && hm < 570 ? "장 초반 — 폭·에너지가 아직 덜 움직였다. 09:30 뒤 값이 제값이다" : undefined;
  const data: MarketSignal = { level, score, checks, summary: `${regime.name} · ${summary}`, evaluatedAt: new Date().toISOString(), regime, ...(note ? { note } : {}) };
  cache = { data, at: Date.now() };
  void recordIfClose(client, data).catch(() => undefined);
  return data;
}

function breadthPctOf(checks: MarketCheck[]): number | null {
  const b = checks.find((c) => c.key === "breadth");
  const m = b?.value.match(/상승비율 (\d+)%/);
  return m ? Number(m[1]) : null;
}

/**
 * 국면 판정 (2026-09-07 밤) — 점수 하나로 뭉개지 않는다. 벤티지: "좀더 컴팩트하고 정확한 분석 토대로."
 *   공포        VIX 30 이상이거나 상승비율 30% 아래
 *   한쪽만      코스피·코스닥이 갈림(한쪽만 20선 위·선 상승)
 *   상승 추세   두 지수 다 20선 위·선 상승 + 폭 확산(상승비율 55↑ 또는 20선 위 종목 55↑) + 외인·기관 중 하나 우호
 *   하락 추세   두 지수 다 추세 아님 + 폭 위축이거나 수급 비우호
 *   반등 시도   지수는 20선 위인데 선은 아직 내려오는 중, 또는 20선 위 종목 비율이 5일 새 +3%p 넘게 늘어나는 중
 *   횡보        나머지
 */
function judgeRegime(a: { trend: MarketCheck; checks: MarketCheck[]; above20: number | null; above20d5: number | null; vix: number | null; breadthPct: number | null }): MarketRegime {
  const by = (k: string) => a.checks.find((c) => c.key === k);
  const breadth = by("breadth");
  const fx = by("foreignFlow");
  const ins = by("instFlow");
  const det = lastTrendDetail;
  const kospi = det.find((d) => d.label === "코스피");
  const kosdaq = det.find((d) => d.label === "코스닥");
  const why: string[] = [];
  if (a.vix !== null && a.vix >= 30) {
    why.push(`VIX ${a.vix.toFixed(1)}`);
    return { key: "fear", name: "공포", action: "새로 사지 말고 손절선만 지킨다", why };
  }
  if (a.breadthPct !== null && a.breadthPct < 30) {
    why.push(`상승비율 ${a.breadthPct}%`);
    return { key: "fear", name: "공포", action: "새로 사지 말고 손절선만 지킨다", why };
  }
  const breadthOk = breadth?.pass === true || (a.above20 !== null && a.above20 >= 55);
  const flowOk = fx?.pass === true || ins?.pass === true;
  const flowBad = fx?.pass === false && ins?.pass === false;
  if (a.trend.neutral && kospi && kosdaq) {
    const side = kospi.ok ? "코스피" : "코스닥";
    why.push(`${side}만 20선 위·선 상승`, `${side === "코스피" ? "코스닥" : "코스피"} ${side === "코스피" ? (kosdaq.above20 ? "선 하락" : "20선 아래") : kospi.above20 ? "선 하락" : "20선 아래"}`);
    return { key: "split", name: `한쪽만 도는 장 (${side})`, action: `${side}만, 소량 — 갈린 장은 오래 안 간다`, side, why };
  }
  if (a.trend.pass === true && breadthOk && flowOk) {
    why.push("두 지수 20선 위·선 상승", breadth?.pass === true ? `상승비율 ${a.breadthPct}%` : `20선 위 종목 ${a.above20?.toFixed(0)}%`, fx?.pass ? "외인 우호" : "기관 우호");
    return { key: "up", name: "상승 추세", action: "사도 되는 날 — 거르고, 추세를 따른다", why };
  }
  if (a.trend.pass === false && (breadth?.pass === false || flowBad)) {
    why.push("두 지수 추세 아님", breadth?.pass === false ? `상승비율 ${a.breadthPct}%` : "외인·기관 비우호");
    return { key: "down", name: "하락 추세", action: "새로 사지 않는다. 출구만 본다", why };
  }
  const priceAboveButMaFalling = det.some((d) => d.above20 && d.ma20Rising === false);
  const widening = a.above20d5 !== null && a.above20d5 > 3;
  if (priceAboveButMaFalling || widening) {
    if (priceAboveButMaFalling) why.push("20선 위지만 선은 내려오는 중");
    if (widening) why.push(`20선 위 종목 5일 +${a.above20d5?.toFixed(0)}%p`);
    return { key: "rebound", name: "반등 시도", action: "소량만 — 20일선이 돌아서면 추종", why };
  }
  why.push(a.trend.pass === true ? "추세는 살아 있으나 폭·수급이 안 받침" : "지수·폭·수급 어느 것도 방향 없음");
  return { key: "range", name: "횡보", action: "관망 — 감시만 걸어 둔다", why };
}

/* ── 하루 한 줄 기록 · 검증 ─────────────────────────────────────────── */

let recordedDay = "";
async function readHistory(): Promise<MarketSignalDay[]> {
  try {
    return JSON.parse(await fs.readFile(HIST_FILE, "utf8")) as MarketSignalDay[];
  } catch {
    return [];
  }
}

/**
 * 15:35~16:30 사이에 하루 한 번 — 그날 판정과 코스피 종가를 남긴다.
 *
 * ## 9/14 뒤에도 **15:35 그대로다** (2026-09-12, KRX 애프터마켓 개편)
 *
 * 마감 뒤 정리는 20:10 으로 옮겼지만, 이 줄은 **검증 표의 재료**다 — `kospi` 칸이 정규장
 * 종가로 400일 가까이 쌓여 있고, 「초록이었던 날의 5·20거래일 뒤 수익률」이 그 값으로
 * 계산된다. 20:10 로 옮겨 애프터가 섞인 값이 들어오면 9/14 를 경계로 **같은 표 안에서
 * 자가 갈린다.** 지수 자체도 정규장 종가로 확정된다(애프터마켓은 지수 산출 밖).
 *
 * `recordedDay` 가드가 있어 하루 한 줄이고, 5분 주기라 사실상 15:35~15:40 에 걸린다.
 * 창의 끝(16:30)이 애프터 개장 뒤까지 물려 있지만 그건 「그날 한 번도 못 찍었을 때의
 * 마지막 기회」다 — 안 남기는 것보다 낫다.
 */
async function recordIfClose(client: KiwoomClient, data: MarketSignal): Promise<void> {
  const k = new Date(Date.now() + 9 * 3600_000);
  const date = k.toISOString().slice(0, 10);
  const hm = k.getUTCHours() * 60 + k.getUTCMinutes();
  if (!isTradingDay() || hm < 935 || hm > 990 || recordedDay === date) return; // (2026-09-10 전수 점검) 휴장일 기록 차단
  const hist = await readHistory();
  const dup = hist.findIndex((h) => h.date === date);
  if (dup >= 0 && !hist[dup].backfilled) {
    recordedDay = date;
    return;
  }
  if (dup >= 0) hist.splice(dup, 1); // 오늘 자리에 백필 값이 있으면 진짜 값으로 바꾼다
  const closes = await indexCloses(client, "001").catch(() => []);
  hist.push({ date, level: data.level, score: data.score, regime: data.regime.key, kospi: closes[0] ?? null });
  await fs.mkdir(dirname(HIST_FILE), { recursive: true });
  await fs.writeFile(HIST_FILE, JSON.stringify(hist.slice(-400)), "utf8");
  recordedDay = date;
}

/**
 * 부분 백필 (2026-09-07 밤) — 검증 표가 몇 주 비어 있으면 못 쓴다. 날짜가 있는 재료(지수 일봉·수급 58일)로
 * 최근 60거래일의 판정을 되짚는다. 폭·에너지·선물은 과거값이 없어 빠지므로 **부분**이고, 그렇게 표시한다.
 *   추세  두 지수 20선 위·선 상승(+30) · 한쪽(+15)
 *   수급  외인 5일 누적 +1,000억 초과(+15) · 기관(+15)
 *   점수 = 얻은/60 × 100 → 70 초록 · 40 노랑 · 그 아래 빨강. 국면은 같은 규칙(폭 없이)
 */
async function backfillHistory(client: KiwoomClient): Promise<void> {
  const hist = await readHistory();
  if (hist.some((h) => !h.backfilled)) return; // 진짜 기록이 있으면 손대지 않는다
  if (hist.length >= 30) return;
  const [kp, kq, flows] = await Promise.all([indexDetail(client, "001", "day"), indexDetail(client, "101", "day"), listSectorFlow(200)]);
  const closesK = kp.candles.map((c) => c.close);
  const closesQ = kq.candles.map((c) => c.close);
  const dateOf = (dt: string) => `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`;
  const qIdx = new Map<string, number>();
  kq.candles.forEach((c, i) => qIdx.set(c.dt, i));
  const smaAt = (xs: number[], end: number, n: number): number | null => (end - n + 1 < 0 ? null : xs.slice(end - n + 1, end + 1).reduce((a, b) => a + b, 0) / n);
  const trendAt = (xs: number[], end: number) => {
    const ma20 = smaAt(xs, end, 20);
    const ma20p = smaAt(xs, end - 5, 20);
    if (ma20 === null) return null;
    return xs[end] > ma20 && (ma20p === null || ma20 > ma20p);
  };
  const flowAt = (date: string, subj: number): number => {
    const upto = flows.filter((f) => f.date <= date).slice(-5);
    let sum = 0;
    for (const day of upto) for (const m of ["kospi", "kosdaq"] as const) sum += day[m].find((r) => r.code === TOTAL_CODE[m])?.v[subj] ?? 0;
    return upto.length >= 3 ? sum : 0;
  };
  const out: MarketSignalDay[] = [];
  const n = kp.candles.length;
  for (let i = Math.max(60, n - 60); i < n; i++) {
    const dt = kp.candles[i].dt;
    const date = dateOf(dt);
    const qi = qIdx.get(dt);
    const tK = trendAt(closesK, i);
    const tQ = qi !== undefined ? trendAt(closesQ, qi) : null;
    const f = flowAt(date, IDX_FOREIGN);
    const g = flowAt(date, IDX_INSTITUTION);
    let gained = 0;
    const bothOk = tK === true && tQ === true;
    const oneOk = (tK === true) !== (tQ === true) && (tK !== null || tQ !== null);
    if (bothOk) gained += 30;
    else if (oneOk) gained += 15;
    if (f > 1000) gained += 15;
    else if (f >= -1000) gained += 7.5;
    if (g > 1000) gained += 15;
    else if (g >= -1000) gained += 7.5;
    const score = Math.round((gained / 60) * 100);
    let level: Level = score >= 70 ? "green" : score >= 40 ? "yellow" : "red";
    if (level === "green" && oneOk) level = "yellow";
    const regime: RegimeKey = oneOk ? "split" : bothOk && (f > 1000 || g > 1000) ? "up" : tK === false && tQ === false && f < -1000 && g < -1000 ? "down" : "range";
    out.push({ date, level, score, regime, kospi: closesK[i], backfilled: true });
  }
  if (out.length === 0) return;
  await fs.mkdir(dirname(HIST_FILE), { recursive: true });
  await fs.writeFile(HIST_FILE, JSON.stringify(out), "utf8");
}

/**
 * 장 마감 뒤 판정을 스스로 남긴다 — 화면이 안 열린 날도 기록이 쌓여야 검증이 된다.
 *
 * 창(15:35~16:30)은 9/14 KRX 애프터마켓 개편 뒤에도 그대로다 — 이유는 `recordIfClose` 주석에.
 */
export function startMarketSignalRecorder(client: KiwoomClient): void {
  setTimeout(() => void backfillHistory(client).catch(() => undefined), 60_000);
  setInterval(() => {
    const k = new Date(Date.now() + 9 * 3600_000);
    const hm = k.getUTCHours() * 60 + k.getUTCMinutes();
    if (!isTradingDay()) return; // (2026-09-10 전수 점검)
    /* (2026-09-10 전수 점검) (I) 오늘 기록이 이미 남았으면 강제 재평가를 멈춘다 — 5분마다 지수·수급을 다시 부를 이유가 없다 */
    if (recordedDay === k.toISOString().slice(0, 10)) return;
    if (hm >= 935 && hm <= 990) void evaluateMarket(client, true).catch(() => undefined);
  }, 5 * 60_000);
}

export interface SignalVerification {
  days: number;
  backfilled: number;
  rows: { level: Level; n: number; avg5: number | null; avg20: number | null; win5: number | null; win20: number | null }[];
  byRegime: { regime: string; n: number; avg5: number | null; avg20: number | null; win5: number | null }[];
  latest: MarketSignalDay[];
}

/**
 * 「신호등이 맞았나」 — 초록이었던 날의 5·20거래일 뒤 코스피 수익률, 빨강이었던 날의 수익률.
 * 이 표가 나쁘면 문턱을 고칠 근거가 생긴다. 문턱은 그때까지 그대로다.
 */
export async function verifyMarketSignal(client: KiwoomClient): Promise<SignalVerification> {
  const hist = await readHistory();
  const d = await indexDetail(client, "001", "day").catch(() => null);
  const candles = d?.candles ?? [];
  const idx = new Map<string, number>();
  candles.forEach((c, i) => idx.set(`${c.dt.slice(0, 4)}-${c.dt.slice(4, 6)}-${c.dt.slice(6, 8)}`, i));
  const fwd = (date: string, n: number): number | null => {
    const i = idx.get(date);
    if (i === undefined || i + n >= candles.length) return null;
    const a = candles[i].close;
    const b = candles[i + n].close;
    return a > 0 ? ((b - a) / a) * 100 : null;
  };
  const stat = (rows: MarketSignalDay[]) => {
    const r5 = rows.map((h) => fwd(h.date, 5)).filter((x): x is number => x !== null);
    const r20 = rows.map((h) => fwd(h.date, 20)).filter((x): x is number => x !== null);
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const win = (xs: number[]) => (xs.length ? (xs.filter((x) => x > 0).length / xs.length) * 100 : null);
    return { avg5: avg(r5), avg20: avg(r20), win5: win(r5), win20: win(r20) };
  };
  const rows = (["green", "yellow", "red"] as Level[]).map((lv) => {
    const rs = hist.filter((h) => h.level === lv);
    return { level: lv, n: rs.length, ...stat(rs) };
  });
  const backfilled = hist.filter((h) => h.backfilled).length;
  const regimes = [...new Set(hist.map((h) => h.regime))];
  const byRegime = regimes.map((rg) => {
    const rs = hist.filter((h) => h.regime === rg);
    const st = stat(rs);
    return { regime: rg, n: rs.length, avg5: st.avg5, avg20: st.avg20, win5: st.win5 };
  });
  return { days: hist.length, backfilled, rows, byRegime, latest: hist.slice(-30).reverse() };
}

/** AI 리포트 프롬프트에 넣을 형태 */
export function toMarketSignalDigest(sig: MarketSignal): string {
  if (sig.level === "unknown") return "";
  const lines = sig.checks
    .map((c) => `${c.label}: ${c.value} [${c.pass === true ? "우호" : c.pass === false ? "비우호" : "중립"}]`)
    .join("\n");
  return `\n[시장 신호등 — ${sig.level === "green" ? "초록" : sig.level === "yellow" ? "노랑" : "빨강"} ${sig.score}점. 개별 종목이 아니라 시장 전체의 상태다]\n${lines}`;
}
