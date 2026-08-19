import { fetchQuotes } from "./globalMarket.js";
import { hantooGet, hantooReady } from "./hantooClient.js";
import { kospi200Futures } from "./kospiFutures.js";

/**
 * 미장 주요지수 — 아침에 "밤사이 무슨 일이 있었나"를 한 표로.
 *
 * 「글로벌 시황지수」에서 미국 **현물**을 뺐다. 선물과 나란히 놓으니 같은 지수가 두 줄씩
 * 떠서 어느 게 지금 값인지 헷갈렸기 때문이다. 그 현물이 갈 자리가 여기다.
 *
 * **여기 값은 전부 "전일 마감"이다.** 미국 현물은 우리 시간 05:30 에 닫히므로 낮에는
 * 움직이지 않는다 — 움직이는 걸 보려면 「글로벌 시황지수」의 선물을 봐야 한다.
 * 두 화면의 성격이 다르다는 게 이 표의 전제다.
 *
 * 코스피 야간선물만 예외다. 미국장이 열려 있는 동안 **한국 지수가 어디로 가는지**를
 * 현물 개장 전에 보여 주므로, 밤사이 흐름을 읽는 이 표에 같이 있어야 한다.
 */

interface Target {
  key: string;
  label: string;
  symbol: string;
  /** 금리는 %p 로 읽어야 한다 — 4.72 가 4.72% 다 */
  isRate?: boolean;
  /** 소수 몇 자리로 보여줄지 */
  digits?: number;
}

const TARGETS: Target[] = [
  { key: "gspc", label: "S&P 500", symbol: "^GSPC" },
  { key: "ndx", label: "나스닥 100", symbol: "^NDX" },
  { key: "rut", label: "러셀 2000", symbol: "^RUT" },
  { key: "sox", label: "필라델피아 반도체", symbol: "^SOX" },
  { key: "tnx", label: "미국 10년물", symbol: "^TNX", isRate: true, digits: 3 },
  { key: "tyx", label: "미국 30년물", symbol: "^TYX", isRate: true, digits: 3 },
  { key: "vix", label: "VIX", symbol: "^VIX", digits: 2 },
  { key: "wti", label: "WTI", symbol: "CL=F", digits: 2 },
  { key: "brent", label: "브렌트", symbol: "BZ=F", digits: 2 },
];

export interface UsMajorRow {
  key: string;
  label: string;
  symbol: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  isRate: boolean;
  digits: number;
  /** 언제 찍힌 값인가 (ms) — "전일 마감"이 정말 전일인지 화면이 스스로 답해야 한다 */
  quotedAt: number | null;
  /** 어디서 받은 값인가. 두 출처가 섞이므로 화면에 밝힌다 */
  source: "yahoo" | "hantoo";
  error: string | null;
}

export interface UsMajorResult {
  rows: UsMajorRow[];
  /** 코스피 야간선물 — 한투에서만 온다 */
  nightFutures: UsMajorRow | null;
  fetchedAt: number;
}

/**
 * 코스피 야간선물.
 *
 * **전광판은 `CM` 을 안 받는다**(`rt_cd 2`). 대신 시세 조회가 **주간물과 같은 코드**로
 * 야간 값을 준다 — 같은 A01609 를 `F` 로 부르면 주간 종가(1,078.25),
 * `CM` 으로 부르면 야간 현재가(1,031.95)가 나온다.
 *
 * 그래서 월물코드는 주간 전광판에서 받아 `CM` 으로 시세만 다시 묻는다.
 * 미국장이 열려 있는 동안 **한국 지수가 어디로 가는지**를 현물 개장 전에 보여 준다.
 */
async function nightFutures(): Promise<UsMajorRow | null> {
  if (!hantooReady()) return null;
  try {
    const front = await kospi200Futures(null);
    if (!front) return null;

    const body = await hantooGet<{ output1?: Record<string, unknown> }>(
      "/uapi/domestic-futureoption/v1/quotations/inquire-price",
      "FHMIF10000000",
      { FID_COND_MRKT_DIV_CODE: "CM", FID_INPUT_ISCD: front.code },
      "미장 주요지수",
    );
    const o = body.output1 ?? {};
    const price = Math.abs(Number(o.futs_prpr));
    if (!Number.isFinite(price) || price === 0) return null;
    return {
      key: "kospiNight",
      label: "코스피 야간선물",
      symbol: front.code,
      price,
      change: Number(o.futs_prdy_vrss) || 0,
      changeRate: Number(o.futs_prdy_ctrt) || 0,
      isRate: false,
      digits: 2,
      quotedAt: null,
      source: "hantoo",
      error: null,
    };
  } catch {
    return null;
  }
}

/*
 * 야후가 막혔을 때의 예비 경로.
 *
 * 야후는 **공식 API 가 아니라** 언제 막혀도 이상하지 않다. 이 표는 전일 마감값이라
 * 하루 한 번만 맞으면 되는데, 그 한 번이 안 되면 아침에 볼 게 없어진다.
 *
 * 한투로 **전부는 못 채운다.** 실측(2026-08-19):
 *   되는 것   SPX(S&P500) · SOX(필라델피아 반도체) · VIX · COMP(나스닥 종합) · .DJI(다우)
 *   안 되는 것 NDX(rt_cd 1) · RUT · TNX · TYX · 환율 — 0 을 주거나 거절한다
 *
 * 그래서 **주 경로는 야후 그대로** 두고, 값을 못 받은 줄만 한투로 메운다.
 * 두 출처를 섞는 건 원래 피하려는 일이지만, "값이 없는 것"보다는 낫다 —
 * 대신 어디서 온 값인지 화면에 밝힌다.
 */
const KIS_FALLBACK: Record<string, string> = {
  "^GSPC": "SPX",
  "^SOX": "SOX",
  "^VIX": "VIX",
};

async function kisIndex(iscd: string): Promise<{ price: number; changeRate: number } | null> {
  try {
    const today = new Date();
    const ymd = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
    const body = await hantooGet<{ output1?: Record<string, unknown> }>(
      "/uapi/overseas-price/v1/quotations/inquire-daily-chartprice",
      "FHKST03030100",
      {
        FID_COND_MRKT_DIV_CODE: "N",
        FID_INPUT_ISCD: iscd,
        FID_INPUT_DATE_1: ymd(new Date(today.getTime() - 7 * 86400_000)),
        FID_INPUT_DATE_2: ymd(today),
        FID_PERIOD_DIV_CODE: "D",
      },
      "미장 주요지수",
    );
    const o = body.output1 ?? {};
    const price = Number(o.ovrs_nmix_prpr);
    // 0 을 주는 종목이 있다 — 그건 "없음"이지 "0원"이 아니다
    if (!Number.isFinite(price) || price === 0) return null;
    return { price, changeRate: Number(o.prdy_ctrt) || 0 };
  } catch {
    return null;
  }
}

/** 60초면 충분하다 — 미국 현물은 낮에 아예 안 움직인다 */
const TTL_MS = 60_000;
let cache: { at: number; data: UsMajorResult } | null = null;

export async function usMajorIndices(force = false): Promise<UsMajorResult> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;

  const [quotes, night] = await Promise.all([
    fetchQuotes(TARGETS.map((t) => t.symbol)),
    nightFutures(),
  ]);

  const rows: UsMajorRow[] = TARGETS.map((t) => {
    const q = quotes.get(t.symbol);
    return {
      key: t.key,
      label: t.label,
      symbol: t.symbol,
      price: q?.price ?? null,
      change: q?.change ?? null,
      changeRate: q?.changeRate ?? null,
      isRate: t.isRate ?? false,
      digits: t.digits ?? 2,
      quotedAt: q?.quotedAt ?? null,
      source: "yahoo" as const,
      error: q?.error ?? null,
    };
  });

  /*
   * 야후가 못 준 줄만 한투로 메운다. 야후가 잘 돌면 이 루프는 아무 일도 하지 않는다
   * (`missing` 이 비어 있어 호출 자체가 없다).
   */
  const missing = rows.filter((r) => r.price === null && KIS_FALLBACK[r.symbol]);
  for (const r of missing) {
    const got = await kisIndex(KIS_FALLBACK[r.symbol]);
    if (got) {
      r.price = got.price;
      r.changeRate = got.changeRate;
      r.change = null; // 한투는 전일대비 절대값을 안 준다 — 없는 값을 지어내지 않는다
      r.error = null;
      r.source = "hantoo";
    }
  }

  const data: UsMajorResult = { rows, nightFutures: night, fetchedAt: Date.now() };
  cache = { at: Date.now(), data };
  return data;
}
