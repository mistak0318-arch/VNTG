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
  // 금리 곡선을 보려면 짧은 쪽도 있어야 한다 — 장단기 역전은 둘을 견줘야 나온다
  { key: "irx", label: "미국 3개월", symbol: "^IRX", isRate: true, digits: 3 },
  { key: "fvx", label: "미국 5년물", symbol: "^FVX", isRate: true, digits: 3 },
  { key: "tnx", label: "미국 10년물", symbol: "^TNX", isRate: true, digits: 3 },
  { key: "tyx", label: "미국 30년물", symbol: "^TYX", isRate: true, digits: 3 },
  { key: "vix", label: "VIX", symbol: "^VIX", digits: 2 },
  { key: "wti", label: "WTI", symbol: "CL=F", digits: 2 },
  { key: "brent", label: "브렌트", symbol: "BZ=F", digits: 2 },
  // 유가만 두면 「원자재」라기엔 반쪽이다. 금은 금리·달러의 반대편을 읽는 자리다
  { key: "gold", label: "금", symbol: "GC=F", digits: 2 },
];

/** 줄 단위 경고 — 시장 신호등(green/yellow/red)과는 다른 개념이다 */
export type RowLevel = "danger" | "warn" | "ok";

export interface RowSignal {
  level: RowLevel;
  /** 왜 그렇게 봤는지 한 줄 — 색만 있으면 왜 빨간지 모른다 */
  why: string;
}

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
  /** 이 줄이 지금 눈여겨볼 상태인가 (없으면 평범한 것) */
  signal: RowSignal | null;
  error: string | null;
}

export interface UsBoardSignal {
  level: "green" | "yellow" | "red";
  /** 한 줄 요약 — 화면·리포트가 그대로 쓴다 */
  summary: string;
  /** 무엇 때문에 그런지 — 색만 있으면 이유를 모른다 */
  reasons: string[];
}

export interface UsMajorResult {
  rows: UsMajorRow[];
  /**
   * 미국 전광판 신호등.
   *
   * 줄마다 붙은 경고를 **한 덩어리로 굴린 것**이다. 열 줄을 눈으로 훑어서
   * "오늘 미국이 괜찮은가"를 세는 건 사람이 할 일이 아니다.
   *
   * 판정을 서버에서 하는 이유는 국내 신호등과 같다 — 화면에서 굴리면 리포트가
   * 같은 판정을 다시 짜야 하고, 두 곳이 다른 말을 하면 그때부터 무엇도 못 믿는다.
   */
  boardSignal: UsBoardSignal;
  /** 코스피 야간선물 — 한투에서만 온다 */
  nightFutures: UsMajorRow | null;
  /** 장단기 금리차 한 줄 — 표 어디에도 안 들어가는 값이라 따로 준다 */
  curveNote: string | null;
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
      signal: null,
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

/*
 * 신호등.
 *
 * 표에 열두 줄이 있으면 **어디를 봐야 할지 모른다.** 오늘 무엇이 평소와 다른지를
 * 색으로 먼저 말해 주고, 왜 그런지 한 줄로 붙인다.
 *
 * 기준은 "이 값이 국내 증시에 얼마나 직접 닿는가"로 잡았다.
 *
 *   · **금리** — 절대 변화폭(%p)으로 본다. 4.7% 에서 4.8% 로 가는 건 등락률로는 2% 지만
 *     시장이 반응하는 건 **0.1%p 라는 폭** 자체다. 하루 0.10%p 넘으면 성장주가 흔들린다.
 *   · **VIX** — 수준과 변화를 같이 본다. 20 은 불안의 문턱, 30 은 공포다.
 *   · **필라델피아 반도체** — 국내 지수와 가장 직접 붙어 있다. -3% 면 다음 날 국내
 *     반도체가 그대로 받는다.
 *   · **지수·유가** — 하루 폭만 본다.
 *
 * 숫자는 경험칙이지 법칙이 아니다. 그래서 색과 **함께 이유를 적는다** — 사람이
 * "이번엔 아니다"라고 판단할 여지를 남겨야 한다.
 */
function signalOf(key: string, price: number | null, rate: number | null): RowSignal | null {
  if (price === null || rate === null) return null;

  if (key === "tnx" || key === "tyx" || key === "fvx" || key === "irx") {
    // 등락률(%)을 절대 변화폭(%p)으로 되돌린다 — 4.706 의 +2% 는 +0.094%p 다
    const move = (price * rate) / 100;
    if (Math.abs(move) >= 0.1) {
      return {
        level: "danger",
        why: `하루 ${move > 0 ? "+" : ""}${move.toFixed(3)}%p — 0.1%p 넘는 움직임은 성장주 밸류에이션을 직접 흔든다`,
      };
    }
    if (Math.abs(move) >= 0.05) {
      return { level: "warn", why: `하루 ${move > 0 ? "+" : ""}${move.toFixed(3)}%p 이동` };
    }
    return null;
  }

  if (key === "vix") {
    if (price >= 30) return { level: "danger", why: "30 이상 — 공포 구간. 이런 날은 수급이 방향을 잃는다" };
    if (price >= 20) return { level: "warn", why: "20 이상 — 불안이 값에 반영되기 시작하는 문턱" };
    if (rate >= 20) return { level: "warn", why: `하루 +${rate.toFixed(1)}% 급등 — 수준은 낮아도 방향이 급하다` };
    return null;
  }

  if (key === "sox") {
    if (rate <= -3) return { level: "danger", why: "-3% 이상 하락 — 국내 반도체가 다음 날 그대로 받는다" };
    if (rate >= 3) return { level: "ok", why: "+3% 이상 상승 — 국내 반도체에 우호적" };
    return null;
  }

  if (key === "wti" || key === "brent") {
    if (Math.abs(rate) >= 4) return { level: "warn", why: `하루 ${rate > 0 ? "+" : ""}${rate.toFixed(1)}% — 정유·화학·항공에 바로 닿는다` };
    return null;
  }

  // 지수
  if (rate <= -2) return { level: "danger", why: `${rate.toFixed(1)}% — 하루 2% 넘는 하락` };
  if (rate <= -1) return { level: "warn", why: `${rate.toFixed(1)}% 하락` };
  if (rate >= 2) return { level: "ok", why: `+${rate.toFixed(1)}% — 하루 2% 넘는 상승` };
  return null;
}

/**
 * 장단기 금리 역전.
 *
 * 10년물이 3개월물보다 **낮으면** 역전이다. 역사적으로 침체에 앞서 나타났고, 무엇보다
 * **은행 수익성**에 직접 닿아 금융주가 먼저 반응한다. 한 줄이라 표 아래에 붙인다.
 */
function curveNote(rows: UsMajorRow[]): string | null {
  const ten = rows.find((r) => r.key === "tnx")?.price ?? null;
  const three = rows.find((r) => r.key === "irx")?.price ?? null;
  if (ten === null || three === null) return null;
  const spread = ten - three;
  if (spread < 0) {
    return `장단기 역전 — 10년물이 3개월물보다 ${Math.abs(spread).toFixed(2)}%p 낮습니다. 침체 신호로 읽히고 은행 수익성에 직접 닿습니다.`;
  }
  if (spread < 0.2) {
    return `장단기 금리차 ${spread.toFixed(2)}%p — 거의 붙어 있습니다. 역전에 가까운 구간입니다.`;
  }
  return null;
}

/**
 * 줄 경고들을 한 신호등으로 굴린다.
 *
 * 규칙은 단순하게 둔다 — **하나라도 빨강이면 빨강.** 미국 쪽 위험은 다음 날 국내 개장가로
 * 그대로 넘어오므로, 평균을 내서 희석하면 안 된다. 장단기 금리 역전도 빨강으로 친다.
 *
 * 좋은 쪽(ok)만 있고 나쁜 게 하나도 없을 때만 초록이다. 아무 일도 없으면 노랑이 아니라
 * **초록**이다 — 「특별히 나쁜 게 없다」가 곧 무난하다는 뜻이기 때문이다.
 */
function boardSignalOf(rows: UsMajorRow[], curve: string | null): UsBoardSignal {
  const danger = rows.filter((r) => r.signal?.level === "danger");
  const warn = rows.filter((r) => r.signal?.level === "warn");
  const ok = rows.filter((r) => r.signal?.level === "ok");

  const reasons = [
    ...danger.map((r) => `${r.label}: ${r.signal!.why}`),
    ...(curve ? [curve] : []),
    ...warn.map((r) => `${r.label}: ${r.signal!.why}`),
  ];

  if (danger.length > 0 || curve) {
    return {
      level: "red",
      summary:
        danger.length > 0
          ? `${danger.map((r) => r.label).join("·")} — 다음 날 국내가 그대로 받는 자리`
          : "장단기 금리 역전",
      reasons,
    };
  }
  if (warn.length > 0) {
    return {
      level: "yellow",
      summary: `${warn.map((r) => r.label).join("·")} 주의`,
      reasons,
    };
  }
  return {
    level: "green",
    summary:
      ok.length > 0
        ? `${ok.map((r) => r.label).join("·")} 강세 — 눈에 띄는 위험은 없습니다`
        : "눈에 띄는 위험은 없습니다",
    reasons: ok.map((r) => `${r.label}: ${r.signal!.why}`),
  };
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
      signal: signalOf(t.key, q?.price ?? null, q?.changeRate ?? null),
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

  const data: UsMajorResult = {
    rows,
    nightFutures: night,
    curveNote: curveNote(rows),
    boardSignal: boardSignalOf(rows, curveNote(rows)),
    fetchedAt: Date.now(),
  };
  cache = { at: Date.now(), data };
  return data;
}
