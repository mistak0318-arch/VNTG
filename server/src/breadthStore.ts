import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSection, type HighLow, type IndexCard, type MarketFlow } from "./marketOverview.js";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 시장 폭(Breadth) 일별 누적.
 *
 * 지금 화면들은 전부 "오늘 스냅샷"만 보여준다. 오늘 상승 900 / 하락 700 이라는 숫자는
 * 그 자체로는 아무 의미가 없고, 지난 20일 흐름 위에 놓아야 비로소 읽힌다.
 * 상승종목 수가 계속 줄어드는데 지수만 오르고 있다면 소수 대형주가 끌고 가는 장이고,
 * 신저가 종목 수가 바닥을 찍고 꺾이면 하락이 마무리 국면일 수 있다.
 *
 * 문제는 이 데이터를 **소급해서 구할 방법이 없다는 것**이다. 키움 API는 과거 날짜의
 * 등락종목수를 주지 않는다. 오늘 저장을 시작하지 않으면 한 달 뒤에도 한 달치가 없다.
 * 그래서 계산도 분석도 나중으로 미루고, 일단 매일 한 줄씩 남기는 것만 먼저 한다.
 *
 * 하루 한 줄 ≒ 300바이트. 1년 모아도 100KB 남짓이라 미니PC 용량에 영향이 없다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "breadth.json");

/** 한 시장의 하루치 폭 */
export interface MarketBreadth {
  /** 지수 종가 (그날 폭이 지수와 어떻게 어긋났는지 보려면 같이 있어야 한다) */
  price: number;
  changeRate: number;
  upperLimit: number;
  rising: number;
  flat: number;
  falling: number;
  lowerLimit: number;
  /** 투자자 순매수 (억원 아님 — API 원단위 그대로) */
  foreign: number;
  institution: number;
  individual: number;
}

export interface BreadthDay {
  /** YYYY-MM-DD */
  date: string;
  /** 이 스냅샷을 찍은 시각 — 장중 저장분인지 종가 확정분인지 구분용 */
  at: string;
  /** 장 마감(15:30) 이후에 찍은 값인지. false면 아직 확정 전 */
  afterClose: boolean;
  kospi: MarketBreadth;
  kosdaq: MarketBreadth;
  /** 250일 신고가/신저가 종목 수 (시장 통합) */
  newHigh: number;
  newLow: number;
}

// ---------------------------------------------------------------- 저장소

async function readAll(): Promise<BreadthDay[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf-8")) as BreadthDay[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function writeAll(rows: BreadthDay[]): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(rows, null, 2), "utf-8");
}

/** 오래된 것부터 날짜순. 기간을 주면 뒤에서 잘라 최근 N일만 */
export async function listBreadth(days?: number): Promise<BreadthDay[]> {
  const rows = await readAll();
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return days && days > 0 ? rows.slice(-days) : rows;
}

// ---------------------------------------------------------------- 수집

function todayKst(): { date: string; at: string; afterClose: boolean } {
  // 서버가 어느 타임존이든 한국 장 기준으로 판단해야 한다
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  const date = `${kst.getFullYear()}-${String(kst.getMonth() + 1).padStart(2, "0")}-${String(
    kst.getDate(),
  ).padStart(2, "0")}`;
  const minutes = kst.getHours() * 60 + kst.getMinutes();
  return { date, at: now.toISOString(), afterClose: minutes >= 15 * 60 + 30 };
}

function pickIndex(cards: IndexCard[], name: string): IndexCard | undefined {
  return cards.find((c) => c.name === name);
}

function toMarketBreadth(
  card: IndexCard | undefined,
  flow: MarketFlow[keyof MarketFlow] | undefined,
): MarketBreadth {
  return {
    price: card?.price ?? 0,
    changeRate: card?.changeRate ?? 0,
    upperLimit: card?.upperLimit ?? 0,
    rising: card?.rising ?? 0,
    flat: card?.flat ?? 0,
    falling: card?.falling ?? 0,
    lowerLimit: card?.lowerLimit ?? 0,
    foreign: flow?.foreign ?? 0,
    institution: flow?.institution ?? 0,
    individual: flow?.individual ?? 0,
  };
}

/**
 * 오늘치를 한 줄 남긴다.
 *
 * 같은 날 여러 번 불려도 한 줄만 유지한다. 다만 **장 마감 후 값이 장중 값을 덮어쓰도록**
 * 했다 — 종가 확정치가 더 정확하기 때문이다. 반대로 이미 마감 후 값이 저장돼 있으면
 * 장중 값으로 되돌리지 않는다.
 */
export async function captureBreadth(
  client: KiwoomClient,
  opts: { force?: boolean } = {},
): Promise<{ saved: boolean; reason?: string; row?: BreadthDay }> {
  const { date, at, afterClose } = todayKst();
  const rows = await readAll();
  const existing = rows.find((r) => r.date === date);

  if (existing && !opts.force) {
    // 확정치가 이미 있으면 더 볼 것 없다
    if (existing.afterClose) return { saved: false, reason: "이미 종가 확정분 저장됨" };
    // 장중 값끼리는 굳이 갱신하지 않는다 (마지막 값이 종가에 가장 가까우므로 마감 후에만 덮어쓴다)
    if (!afterClose) return { saved: false, reason: "장중 저장분 유지" };
  }

  const [indices, flows, highLow] = await Promise.all([
    getSection("indices", client),
    getSection("flow", client),
    getSection("highLow", client),
  ]);

  const cards = (indices.data ?? []) as IndexCard[];
  const flow = flows.data as MarketFlow | undefined;
  const hl = highLow.data as HighLow | undefined;

  const row: BreadthDay = {
    date,
    at,
    afterClose,
    kospi: toMarketBreadth(pickIndex(cards, "KOSPI"), flow?.kospi),
    kosdaq: toMarketBreadth(pickIndex(cards, "KOSDAQ"), flow?.kosdaq),
    newHigh: hl?.high.length ?? 0,
    newLow: hl?.low.length ?? 0,
  };

  // 지수를 하나도 못 받았으면 빈 줄을 남기지 않는다 — 나중에 0이 진짜 0인 줄 알면 곤란하다
  if (row.kospi.price === 0 && row.kosdaq.price === 0) {
    return { saved: false, reason: "지수 조회 실패 — 저장하지 않음" };
  }

  const next = rows.filter((r) => r.date !== date);
  next.push(row);
  next.sort((a, b) => a.date.localeCompare(b.date));
  await writeAll(next);
  return { saved: true, row };
}

// ---------------------------------------------------------------- 파생 지표

export interface BreadthPoint {
  date: string;
  /** 상승 - 하락 (Advance-Decline). 누적하면 A/D Line */
  advanceDecline: number;
  /** 누적 A/D Line — 지수와 벌어지면 다이버전스 */
  adLine: number;
  /** 상승 비율(%) — 전체 대비 상승 종목 비중 */
  risingPct: number;
  newHigh: number;
  newLow: number;
  /** 신고가 - 신저가 */
  highLowDiff: number;
  kospiRate: number;
  kosdaqRate: number;
}

/**
 * 저장된 원본에서 읽기 좋은 지표로 변환.
 * 코스피·코스닥을 합쳐서 "시장 전체"로 본다 — 폭은 시장을 가르지 않고 보는 게 낫다.
 */
export function toPoints(rows: BreadthDay[]): BreadthPoint[] {
  let adLine = 0;
  return rows.map((r) => {
    const rising = r.kospi.rising + r.kosdaq.rising;
    const falling = r.kospi.falling + r.kosdaq.falling;
    const flat = r.kospi.flat + r.kosdaq.flat;
    const total = rising + falling + flat;
    const advanceDecline = rising - falling;
    adLine += advanceDecline;
    return {
      date: r.date,
      advanceDecline,
      adLine,
      risingPct: total > 0 ? (rising / total) * 100 : 0,
      newHigh: r.newHigh,
      newLow: r.newLow,
      highLowDiff: r.newHigh - r.newLow,
      kospiRate: r.kospi.changeRate,
      kosdaqRate: r.kosdaq.changeRate,
    };
  });
}

/**
 * 최근 흐름을 한 문장으로. AI 리포트 프롬프트와 텔레그램에 그대로 넣는다.
 * 데이터가 며칠 안 쌓였으면 억지로 해석하지 않고 그렇다고 말한다.
 */
export function describeBreadth(points: BreadthPoint[]): string {
  if (points.length === 0) return "시장 폭 데이터 없음";
  const last = points[points.length - 1];
  const head = `상승비율 ${last.risingPct.toFixed(0)}% · A/D ${last.advanceDecline > 0 ? "+" : ""}${last.advanceDecline} · 신고가 ${last.newHigh}/신저가 ${last.newLow}`;

  /**
   * 지수와 폭의 어긋남은 **그날 데이터만으로** 판단된다 — 과거 누적이 필요 없다.
   * 지수는 올랐는데 상승 종목이 절반도 안 된다면 소수 대형주가 끌어올린 장이고,
   * 반대로 지수가 빠졌는데 상승 종목이 많다면 지수만 눌린 것이다.
   */
  const divergence =
    last.kospiRate > 0 && last.risingPct < 45
      ? " ⚠ 지수 상승 대비 상승종목 비중이 낮다(소수 주도)"
      : last.kospiRate < 0 && last.risingPct > 55
        ? " ⚠ 지수 하락에도 상승종목이 더 많다(지수만 눌림)"
        : "";

  // 추세 비교는 최소 5일이 있어야 의미가 있다
  if (points.length < 5) {
    return `${head}${divergence} (누적 ${points.length}일 — 추세 판단은 5일 이상부터)`;
  }

  const prev = points.slice(-6, -1);
  const avgRising = prev.reduce((s, p) => s + p.risingPct, 0) / prev.length;
  const diff = last.risingPct - avgRising;
  const trend =
    Math.abs(diff) < 5
      ? "직전 5일과 비슷한 수준"
      : diff > 0
        ? `직전 5일 평균(${avgRising.toFixed(0)}%)보다 확산`
        : `직전 5일 평균(${avgRising.toFixed(0)}%)보다 위축`;

  return `${head} — ${trend}${divergence}`;
}
