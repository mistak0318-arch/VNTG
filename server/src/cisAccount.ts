import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CIS 계좌 — 시스가 굴리는 **모의 계좌**의 원장.
 *
 * ⚠️ **여기서 실제 주문은 나가지 않는다.** 이 HTS 는 조회 전용이고 주문 API 자체가
 * 없다. 이 파일이 하는 일은 「그때 그 값에 샀다면」을 장부로 남기는 것뿐이다.
 * 그 전제가 흔들리면 이 기능 전체의 뜻이 바뀌므로 맨 위에 적어 둔다.
 *
 * ## 왜 장부를 직접 쓰나
 *
 * 수익률만 남기면 **왜 그렇게 됐는지가 사라진다.** 「+12%」는 다음에 아무것도 안
 * 알려 준다. 그래서 체결 하나하나에 그때의 판단 근거(`why`)와 **어느 화면을 봤는지**
 * (`used`)를 붙여 남긴다. 이 계좌의 목적은 돈이 아니라 **HTS 사용법의 기록**이다.
 *
 * ## 신용·미수
 *
 * 벤티지 요청대로 둘 다 쓴다. 다만 **성격이 다르므로 따로 센다.**
 *
 *   - **미수**: 결제일(D+2)까지 갚는 외상. 이자가 없는 대신 못 갚으면 반대매매다.
 *     짧게 치고 빠질 때만 쓴다. 여기서는 **2거래일 안에 정리**를 규칙으로 둔다.
 *   - **신용**: 이자를 내고 며칠~몇 달 끄는 융자. 스윙으로 끌 때 쓴다.
 *
 * 둘을 한 덩어리로 「레버리지」라고 뭉뚱그리면, 미수를 며칠씩 끌어 놓고 성적이 좋게
 * 나오는 **현실에 없는 기록**이 된다. 미수 만기는 `dueDate` 로 강제한다.
 *
 * ## 금액은 원 단위 정수
 *
 * 주식은 원 단위로 체결된다. 소수를 쓰면 평단이 0.3333 원씩 어긋나고, 그게 몇 달
 * 쌓이면 잔고가 안 맞는다. 들어올 때 반올림하고 그 뒤로는 정수만 다룬다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data", "cis");
const ACCOUNT_FILE = join(DATA_DIR, "account.json");

/** 처음 넣는 돈 — 벤티지가 정한 4천만 원 */
export const SEED = 40_000_000;

/**
 * 빌릴 수 있는 한도.
 *
 * 실제 증권사는 종목마다 보증금률이 달라 한도가 제각각인데, 그걸 흉내 내면 종목별
 * 보증금률 표가 필요하고 그 표는 우리에게 없다. **없는 데이터를 지어내느니 규칙을
 * 단순하게 두고 그 규칙을 적어 두는 쪽**을 고른다.
 *
 *   - 미수: 예수금의 2배까지 (증거금 40% 어림)
 *   - 신용: 순자산의 1배까지 (담보유지비율 140% 어림)
 *
 * 합쳐서 순자산의 2.5배를 넘지 않게 막는다. 스윙 트레이더가 늘 풀로 당겨 쓰면
 * 한 번의 갭하락에 계좌가 끝나고, 그러면 이 일지는 딱 한 번 쓰고 끝난다.
 */
export const MAX_LEVERAGE = 2.5;
/** 미수는 산 날부터 이 거래일 안에 정리한다 (D+2 결제) */
export const MISU_DAYS = 2;
/** 신용 이자 — 연 8% 어림, 하루치로 나눠 보유일수만큼 뗀다 */
export const CREDIT_RATE_YEAR = 0.08;

/**
 * 매매 비용. 안 떼면 성적이 **거짓으로 좋아진다** — 하루에 몇 번씩 도는 전략일수록
 * 심하다. 실제 값(2026년 기준 일반적인 온라인 수수료·세금)으로 뗀다.
 */
export const FEE_RATE = 0.00015; // 매수·매도 각각 0.015%
export const TAX_RATE = 0.0018; // 매도에만, 농특세 포함 0.18%

export type Funding = "cash" | "misu" | "credit";

/** 보유 한 줄 — 같은 종목이라도 **자금 종류가 다르면 따로 잡는다**(만기·이자가 다르다) */
export interface Position {
  code: string;
  name: string;
  qty: number;
  /** 평단 (수수료 포함) */
  avg: number;
  funding: Funding;
  /** 산 날 (YYYY-MM-DD) */
  openedAt: string;
  /** 미수만 — 이 날까지 정리해야 한다 */
  dueDate?: string;
  /** 왜 샀나 — 일지가 아니라 **장부에** 남긴다. 나중에 성적과 붙여 세려면 여기 있어야 한다 */
  why: string;
  /** 어느 화면·지표를 보고 정했나 (예: ["신호등:초록", "주도주", "테마:AI전력"]) */
  used: string[];
  /** 손절·익절 계획 — 세운 값을 남겨야 「계획대로 했나」를 물을 수 있다 */
  stop: number | null;
  target: number | null;
}

/** 체결 한 줄 — 이미 끝난 일이라 절대 고치지 않는다 */
export interface Fill {
  id: string;
  date: string;
  /** 언제 — 아침/점심/저녁 중 어느 판단에서 나왔나 */
  slot: "morning" | "noon" | "evening";
  side: "buy" | "sell";
  code: string;
  name: string;
  qty: number;
  price: number;
  funding: Funding;
  /** 수수료+세금 합계 */
  cost: number;
  /** 매도일 때만 — 실현손익(비용 뺀 값) */
  pnl?: number;
  /** 매도일 때만 — 며칠 들고 있었나 */
  heldDays?: number;
  why: string;
  used: string[];
}

export interface CisAccount {
  /** 예수금 — 빌린 돈은 여기 안 들어간다 */
  cash: number;
  /** 갚아야 할 미수 */
  misu: number;
  /** 갚아야 할 신용 */
  credit: number;
  positions: Position[];
  fills: Fill[];
  /** 날마다 찍는 평가액 — 수익률 곡선의 원재료 */
  equityCurve: { date: string; equity: number; cash: number; debt: number }[];
  startedAt: string;
}

const EMPTY: CisAccount = {
  cash: SEED,
  misu: 0,
  credit: 0,
  positions: [],
  fills: [],
  equityCurve: [],
  startedAt: "",
};

let cache: CisAccount | null = null;

export async function loadAccount(): Promise<CisAccount> {
  if (cache) return cache;
  try {
    const raw = await readFile(ACCOUNT_FILE, "utf8");
    const j = JSON.parse(raw) as Partial<CisAccount>;
    cache = {
      ...EMPTY,
      ...j,
      positions: Array.isArray(j.positions) ? j.positions : [],
      fills: Array.isArray(j.fills) ? j.fills : [],
      equityCurve: Array.isArray(j.equityCurve) ? j.equityCurve : [],
    };
  } catch {
    cache = { ...EMPTY, startedAt: today() };
  }
  return cache;
}

export async function saveAccount(a: CisAccount): Promise<void> {
  cache = a;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(ACCOUNT_FILE, JSON.stringify(a, null, 2), "utf8");
}

/** KST 오늘 (YYYY-MM-DD) */
export function today(): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return d.toISOString().slice(0, 10);
}

const r = (n: number) => Math.round(n);

/**
 * 지금 얼마짜리 계좌인가.
 *
 * ⚠️ **빌린 돈을 뺀다.** 주식 평가액만 보면 미수를 두 배로 당긴 계좌가 두 배로
 * 잘한 것처럼 보인다. 순자산 = 예수금 + 주식평가 − 미수 − 신용.
 */
export function equityOf(a: CisAccount, priceOf: (code: string) => number | null): {
  equity: number;
  stockValue: number;
  debt: number;
  /** 순자산 대비 몇 배로 굴리고 있나 */
  leverage: number;
} {
  let stockValue = 0;
  for (const p of a.positions) {
    const px = priceOf(p.code);
    stockValue += (px ?? p.avg) * p.qty;
  }
  const debt = a.misu + a.credit;
  const equity = r(a.cash + stockValue - debt);
  return {
    equity,
    stockValue: r(stockValue),
    debt: r(debt),
    leverage: equity > 0 ? Number(((stockValue) / equity).toFixed(2)) : 0,
  };
}

/**
 * 더 살 수 있는 금액.
 *
 * 한도를 넘겨 사는 것을 **여기 한 곳에서만** 막는다. 판단하는 쪽(LLM)에 「한도를
 * 지켜라」라고 적어 두는 것으로는 못 막는다 — 지키라는 말은 지켜지지 않을 때가 있고,
 * 그때 장부가 현실에 없는 계좌가 된다. 규칙은 코드로 강제해야 규칙이다.
 */
export function buyingPower(
  a: CisAccount,
  funding: Funding,
  priceOf: (code: string) => number | null,
): number {
  const { equity, stockValue } = equityOf(a, priceOf);
  if (equity <= 0) return 0;
  /* 전체 천장 — 어느 자금이든 이걸 넘길 수 없다 */
  const roomTotal = Math.max(0, equity * MAX_LEVERAGE - stockValue);
  if (funding === "cash") return r(Math.min(a.cash, roomTotal));
  if (funding === "misu") return r(Math.min(Math.max(0, a.cash * 2 - a.misu), roomTotal));
  return r(Math.min(Math.max(0, equity - a.credit), roomTotal));
}

function newId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** 거래일 기준으로 n 일 뒤 — 주말만 건너뛴다(공휴일 표가 없어 근사) */
export function addTradingDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  let left = n;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) left -= 1;
  }
  return d.toISOString().slice(0, 10);
}

export interface BuyOrder {
  code: string;
  name: string;
  qty: number;
  price: number;
  funding: Funding;
  why: string;
  used: string[];
  stop?: number | null;
  target?: number | null;
  slot: Fill["slot"];
}

/**
 * 산다. **한도를 넘으면 수량을 줄이고, 그래도 안 되면 안 산다** — 거절이 아니라
 * 조용한 실패로 두면 장부에 없는 주식이 생긴다. 줄인 사실은 되돌려 준다.
 */
export function buy(
  a: CisAccount,
  o: BuyOrder,
  priceOf: (code: string) => number | null,
  date = today(),
): { ok: boolean; qty: number; reason?: string } {
  if (o.qty <= 0 || o.price <= 0) return { ok: false, qty: 0, reason: "수량·가격이 없다" };
  const power = buyingPower(a, o.funding, priceOf);
  const unit = o.price * (1 + FEE_RATE);
  let qty = Math.min(o.qty, Math.floor(power / unit));
  if (qty <= 0) return { ok: false, qty: 0, reason: `${o.funding} 여력 없음` };

  const gross = o.price * qty;
  const fee = r(gross * FEE_RATE);
  const total = gross + fee;

  /* 자금 종류별로 어디서 돈이 나가는지 갈린다 */
  if (o.funding === "cash") a.cash -= total;
  else if (o.funding === "misu") a.misu += total;
  else a.credit += total;

  /* 같은 종목·같은 자금이면 합쳐서 평단을 다시 낸다 */
  const had = a.positions.find((p) => p.code === o.code && p.funding === o.funding);
  if (had) {
    const cost = had.avg * had.qty + total;
    had.qty += qty;
    had.avg = r(cost / had.qty);
    /* 계획은 **새 판단으로 덮는다** — 물타기하며 손절가를 안 옮기면 계획이 거짓이 된다 */
    if (o.stop !== undefined) had.stop = o.stop;
    if (o.target !== undefined) had.target = o.target;
  } else {
    a.positions.push({
      code: o.code,
      name: o.name,
      qty,
      avg: r(total / qty),
      funding: o.funding,
      openedAt: date,
      dueDate: o.funding === "misu" ? addTradingDays(date, MISU_DAYS) : undefined,
      why: o.why,
      used: o.used,
      stop: o.stop ?? null,
      target: o.target ?? null,
    });
  }

  a.fills.push({
    id: newId(),
    date,
    slot: o.slot,
    side: "buy",
    code: o.code,
    name: o.name,
    qty,
    price: o.price,
    funding: o.funding,
    cost: fee,
    why: o.why,
    used: o.used,
  });
  return { ok: true, qty, reason: qty < o.qty ? "여력에 맞춰 수량을 줄였다" : undefined };
}

/**
 * 판다. **빌린 돈부터 갚는다** — 팔아서 생긴 현금을 그냥 예수금에 넣으면 빚이
 * 영영 안 줄고 이자만 쌓인다. 미수 → 신용 → 예수금 순서다(미수가 만기가 급하다).
 */
export function sell(
  a: CisAccount,
  code: string,
  funding: Funding,
  qty: number,
  price: number,
  why: string,
  used: string[],
  slot: Fill["slot"],
  date = today(),
): { ok: boolean; pnl: number; reason?: string } {
  const p = a.positions.find((x) => x.code === code && x.funding === funding);
  if (!p) return { ok: false, pnl: 0, reason: "보유 없음" };
  const n = Math.min(qty, p.qty);
  if (n <= 0) return { ok: false, pnl: 0, reason: "수량 없음" };

  const gross = price * n;
  const fee = r(gross * FEE_RATE);
  const tax = r(gross * TAX_RATE);
  let net = gross - fee - tax;

  /* 신용은 판 시점까지의 이자를 뗀다 — 며칠 끌면 그만큼 성적이 깎여야 맞다 */
  let interest = 0;
  if (funding === "credit") {
    const days = Math.max(0, Math.round((Date.parse(date) - Date.parse(p.openedAt)) / 86400_000));
    interest = r(p.avg * n * (CREDIT_RATE_YEAR / 365) * days);
    net -= interest;
  }

  const cost = p.avg * n;
  const pnl = r(net - cost);

  /* 빚부터 갚는다 */
  let left = net;
  if (funding === "misu") {
    const pay = Math.min(a.misu, cost);
    a.misu -= pay;
    left -= pay;
  } else if (funding === "credit") {
    const pay = Math.min(a.credit, cost);
    a.credit -= pay;
    left -= pay;
  }
  a.cash += r(left);

  p.qty -= n;
  if (p.qty <= 0) a.positions = a.positions.filter((x) => x !== p);

  a.fills.push({
    id: newId(),
    date,
    slot,
    side: "sell",
    code,
    name: p.name,
    qty: n,
    price,
    funding,
    cost: fee + tax + interest,
    pnl,
    heldDays: Math.max(
      0,
      Math.round((Date.parse(date) - Date.parse(p.openedAt)) / 86400_000),
    ),
    why,
    used,
  });
  return { ok: true, pnl };
}

/**
 * 하루가 끝나면 평가액을 찍는다.
 *
 * **같은 날은 덮어쓴다** — 장중에 여러 번 찍히면 곡선이 톱니가 되고, 그 톱니를
 * 「변동성」으로 읽게 된다. 하루에 한 점이다.
 */
export function markToMarket(
  a: CisAccount,
  priceOf: (code: string) => number | null,
  date = today(),
): void {
  const { equity, debt } = equityOf(a, priceOf);
  const row = { date, equity, cash: r(a.cash), debt };
  const at = a.equityCurve.findIndex((x) => x.date === date);
  if (at >= 0) a.equityCurve[at] = row;
  else a.equityCurve.push(row);
  a.equityCurve.sort((x, y) => x.date.localeCompare(y.date));
}

/** 만기가 오늘까지인 미수 — 저녁 루틴이 이걸 보고 강제로 정리한다 */
export function misuDue(a: CisAccount, date = today()): Position[] {
  return a.positions.filter((p) => p.funding === "misu" && p.dueDate && p.dueDate <= date);
}
