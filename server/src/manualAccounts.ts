import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = resolve(__dirname, "..", "data", "manualAccounts.json");

/**
 * 수동 계좌 — 키움 외 증권사 보유 종목을 직접 적어두고 수익률만 확인하는 용도.
 *
 * 설계 원칙: **평가금액·손익은 저장하지 않는다.** 평단가와 수량만 저장하고,
 * 현재가는 조회할 때마다 키움에서 가져와 계산한다. 저장하면 값이 낡는다.
 *
 * 이 앱은 조회 전용이므로 여기서도 주문·이체는 다루지 않는다.
 */

export const BROKERS = [
  "미래에셋증권",
  "삼성증권",
  "NH투자증권",
  "한국투자증권",
  "KB증권",
  "신한투자증권",
  "하나증권",
  "메리츠증권",
  "대신증권",
  "토스증권",
  "카카오페이증권",
  "유안타증권",
  "기타",
];

export interface ManualHolding {
  code: string;
  name: string;
  /** 평균 매입단가 */
  avgPrice: number;
  qty: number;
  /**
   * **평단을 적은 날** (2026-09-14 — 벤티지: "내가 오늘 사서 넣었는데 당일 수익률을 해당 종목의
   * 오늘 총 마이너스를 반영해서 넣으면 어떡하니. 매수단가랑 내가 넣었잖아").
   *
   * 수동 계좌의 당일 손익은 어제 종가부터 잰다 — 어제도 들고 있었다는 뜻이다. 그런데 **오늘
   * 사서 오늘 적은 종목**은 그게 아니다. 내가 낸 값은 평단이지 어제 종가가 아니라서, 그 종목이
   * 오늘 −5% 였다면 사지도 않은 −5% 가 내 손익으로 잡힌다.
   *
   * 평단을 **오늘 적었으면 당일 손익도 평단부터** 잰다. 옛 종목의 평단을 오늘 고쳐 적어도 마찬가지다 —
   * 그 값이 내가 아는 가장 최근의 「내 가격」이기 때문이다. ISO 시각을 남긴다.
   */
  pricedAt?: string;
  /**
   * **산 날** (2026-09-14 — 벤티지: "내가 산 종목의 매수날짜랑 다 있잖아 … 누적도 오늘 입력한
   * 거니깐 당일과 똑같아야겠지?").
   *
   * 당일 손익의 기준선을 이 날짜가 정한다.
   *   오늘 샀으면  → 기준선은 **내가 적은 평단** (당일 = 누적이 된다. 맞는 말이다)
   *   전에 샀으면  → 기준선은 **어제 종가** (하루치만 잰다)
   *
   * 담을 때 오늘로 채워 두고 손으로 고칠 수 있게 한다. **없으면 없는 대로 둔다** —
   * 예전에 적어 둔 종목은 산 날을 알 길이 없어서 지어내지 않고 예전 방식(어제 종가)을 쓴다.
   * 화면이 「산 날을 적으면 더 맞는다」고 말한다.
   */
  boughtAt?: string;
}

export interface ManualAccount {
  id: string;
  broker: string;
  /** 계좌 별칭 (예: 연금저축, ISA) */
  name: string;
  holdings: ManualHolding[];
  /**
   * 예수금(현금).
   *
   * 주식 평가액만 있으면 **총 잔고를 알 수 없다.** 같은 1억 계좌라도 전액 매수한 것과
   * 절반이 현금인 것은 완전히 다른 상태인데, 그 차이가 화면에 아예 안 보였다.
   * 수동 계좌라 자동으로 받아올 방법이 없으므로 직접 적는다.
   */
  cash?: number;
  /** 예수금을 마지막으로 손댄 시각 — 오래된 값을 그대로 믿지 않도록 */
  cashUpdatedAt?: string;
  /**
   * **무엇을 붙박이로 둘 것인가** (2026-09-08).
   *
   * 벤티지: "잔고에 총자산 입력할 수 있게 해줘. 그래야 매도 매수 할 때마다 자동으로
   * 예수금이랑 주식잔고랑 연동되지. 지금은 내가 예수금을 수동으로 넣어야 되네."
   *
   * 예수금을 붙박이로 두면 **주식을 살 때마다 총자산이 늘어난다** — 계좌 안에서 현금이
   * 주식으로 바뀐 것뿐인데 없던 돈이 생긴 것처럼 보인다. 그래서 살 때마다 예수금을
   * 손으로 깎아야 했다.
   *
   * 총자산을 붙박이로 두면 그 일이 없어진다. `예수금 = 총자산 − 주식평가액` 으로 매번
   * 다시 내므로, 종목을 담거나 빼면 예수금이 알아서 따라온다. 계좌에 돈을 넣거나 뺐을
   * 때만 총자산을 고치면 된다 — 그게 실제로 일어난 일과 같다.
   *
   * `cash`(기본) 는 옛 계좌를 위해 남긴다. 안 적혀 있으면 예전처럼 예수금 기준이다.
   */
  anchor?: "cash" | "total";
  /** anchor 가 "total" 일 때 붙박이로 두는 값 */
  totalAnchor?: number;
}

let cache: ManualAccount[] | null = null;

async function load(): Promise<ManualAccount[]> {
  if (cache) return cache;
  try {
    const raw = await readFile(DATA_FILE, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    cache = Array.isArray(parsed) ? (parsed as ManualAccount[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(items: ManualAccount[]): Promise<void> {
  cache = items;
  await mkdir(dirname(DATA_FILE), { recursive: true });
  await writeFile(DATA_FILE, JSON.stringify(items, null, 2), "utf-8");
}

function kstToday(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

function newId(): string {
  return `ma_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export async function listAccounts(): Promise<ManualAccount[]> {
  return [...(await load())];
}

export async function addAccount(broker: string, name: string): Promise<ManualAccount[]> {
  if (!broker.trim()) throw new Error("증권사를 선택하세요.");
  const items = await load();
  const next = [...items, { id: newId(), broker: broker.trim(), name: name.trim() || broker.trim(), holdings: [] }];
  await persist(next);
  return next;
}

/**
 * 예수금을 적어 둔다.
 * 수동 계좌는 시세를 받아올 수 없으니 현금도 사람이 직접 넣는 수밖에 없다.
 * 대신 마지막으로 손댄 시각을 남겨 화면에서 "언제 적은 값인지"를 알 수 있게 한다.
 */
export async function setCash(
  id: string,
  cash: number,
  anchor: "cash" | "total" = "cash",
): Promise<ManualAccount[]> {
  const items = await load();
  const target = items.find((a) => a.id === id);
  if (!target) throw new Error("계좌를 찾을 수 없습니다.");
  const value = Number(cash);
  const what = anchor === "total" ? "총자산" : "예수금";
  if (!Number.isFinite(value) || value < 0) throw new Error(`${what}은 0 이상의 숫자여야 합니다.`);

  const next = items.map((a) =>
    a.id === id
      ? {
          ...a,
          /*
            총자산 기준이면 `cash` 는 안 쓴다 — 평가할 때 총자산에서 주식평가액을 빼서 낸다.
            그래도 지워 두지는 않는다. 기준을 되돌렸을 때 예전 예수금이 살아 있어야 한다.
          */
          ...(anchor === "total" ? { anchor: "total" as const, totalAnchor: Math.round(value) } : { anchor: "cash" as const, cash: Math.round(value) }),
          cashUpdatedAt: new Date().toISOString(),
        }
      : a,
  );
  await persist(next);
  return next;
}

/**
 * **계좌 차례를 바꾼다** (2026-09-16 — 벤티지: "수동계좌 순서 바꿀 수 있게 좀 해줘").
 * 화면이 보낸 id 차례대로 늘어놓는다. 목록에 없는 id 는 무시하고, 안 보낸 계좌는 뒤에 그대로 붙인다 —
 * 화면이 옛 목록으로 보내도 계좌가 사라지지 않는다.
 */
export async function reorderAccounts(ids: string[]): Promise<ManualAccount[]> {
  const items = await load();
  const by = new Map(items.map((a) => [a.id, a]));
  const next: ManualAccount[] = [];
  for (const id of ids) {
    const a = by.get(id);
    if (a && !next.includes(a)) next.push(a);
  }
  for (const a of items) if (!next.includes(a)) next.push(a);
  await persist(next);
  return next;
}

export async function removeAccount(id: string): Promise<ManualAccount[]> {
  const items = await load();
  const next = items.filter((a) => a.id !== id);
  await persist(next);
  return next;
}

/**
 * **종목을 담고 빼면 예수금이 따라 움직인다** (2026-09-14 — 벤티지: "종목 빼고 더하고 사거나
 * 하면 예수금에서 차감이 되야지 … 그래야 내가 종목만 교체해도 전체 잔고가 알아서 조정이 되겠지").
 *
 * 규칙은 하나다 — **예수금은 매입금액이 변한 만큼 반대로 움직인다.**
 *
 *   예수금 += (이전 매입금액 − 새 매입금액)
 *
 * 담으면 그만큼 현금이 나가고, 빼면 그만큼 들어온다. 수량만 고쳐도, 평단만 고쳐도 같은 규칙
 * 하나로 맞는다. 계좌 안에서 현금이 주식으로 바뀌었을 뿐이니 **원가 기준 총액은 그대로다** —
 * 그게 「종목만 교체해도 잔고가 알아서 조정된다」의 뜻이다.
 *
 * ## 왜 평가액이 아니라 매입금액인가
 *
 * 팔면 실제로는 그날 시세만큼 현금이 들어온다. 그런데 우리는 **얼마에 팔았는지 모른다** —
 * 수량만 고쳐 적을 뿐이다. 현재가로 치면 오타를 고칠 때도 현금이 엉뚱하게 늘어난다.
 * 매입금액으로 움직이면 **적은 대로만** 움직인다. 판 값과의 차이는 평단을 고쳐 적을 때 맞춘다.
 *
 * ## 총자산 기준 계좌는 건드리지 않는다
 *
 * `anchor: "total"` 은 예수금을 「총자산 − 주식평가액」으로 매번 다시 내므로 여기서 손댈 것이 없다.
 *
 * 현금이 모자라면 **음수로 둔다.** 0 으로 깎으면 없던 돈이 생겨 총액이 안 맞는다 —
 * 화면이 음수를 보여 주고 사람이 고치는 편이 낫다.
 */
function costOf(h: ManualHolding): number {
  return Math.round((Number(h.avgPrice) || 0) * (Number(h.qty) || 0));
}

function withCashShift(a: ManualAccount, before: number, after: number): ManualAccount {
  if ((a.anchor ?? "cash") === "total") return a;
  const shift = before - after;
  if (shift === 0) return a;
  return { ...a, cash: Math.round((a.cash ?? 0) + shift), cashUpdatedAt: new Date().toISOString() };
}

export async function upsertHolding(
  id: string,
  h: ManualHolding,
): Promise<ManualAccount[]> {
  if (!h.code) throw new Error("종목코드가 필요합니다.");
  if (!(h.qty > 0)) throw new Error("수량은 1주 이상이어야 합니다.");
  const items = await load();
  const next = items.map((a) => {
    if (a.id !== id) return a;
    const old = a.holdings.find((x) => x.code === h.code);
    const moved = withCashShift(a, old ? costOf(old) : 0, costOf(h));
    /* 평단이 새로 적혔으면 그 시각을 남긴다 — 수량만 고친 것은 값을 새로 낸 것이 아니다 */
    const priced: ManualHolding =
      !old || old.avgPrice !== h.avgPrice ? { ...h, pricedAt: new Date().toISOString() } : { ...h, pricedAt: old.pricedAt };
    /* 산 날 — 적어 보냈으면 그대로, 아니면 옛 값을 지키고, 처음 담는 것이면 오늘로 */
    priced.boughtAt = h.boughtAt ?? old?.boughtAt ?? (old ? undefined : kstToday());
    return {
      ...moved,
      // 같은 종목이면 덮어쓴다 (추가 매수 시 평단만 다시 적으면 되도록)
      holdings: old ? a.holdings.map((x) => (x.code === h.code ? priced : x)) : [...a.holdings, priced],
    };
  });
  await persist(next);
  return next;
}

export async function removeHolding(id: string, code: string): Promise<ManualAccount[]> {
  const items = await load();
  const next = items.map((a) => {
    if (a.id !== id) return a;
    const old = a.holdings.find((x) => x.code === code);
    const moved = withCashShift(a, old ? costOf(old) : 0, 0);
    return { ...moved, holdings: a.holdings.filter((x) => x.code !== code) };
  });
  await persist(next);
  return next;
}

/**
 * **입금·출금** (2026-09-14 — 벤티지: "예수금 내가 추가로 넣었을 때에는 예수금 추가 버튼으로
 * 추가되게 하고").
 *
 * 종목을 담고 빼는 것은 계좌 **안에서** 현금과 주식이 자리를 바꾸는 일이라 총액이 그대로다.
 * 밖에서 돈이 들어오고 나가는 것은 **다른 일**이라 단추를 따로 둔다 — 그래야 「잔고가 왜 늘었지」를
 * 되짚을 수 있다. 총자산 기준 계좌는 총자산을, 예수금 기준 계좌는 예수금을 그만큼 올린다.
 */
export async function depositCash(id: string, delta: number): Promise<ManualAccount[]> {
  const amount = Math.round(Number(delta));
  if (!Number.isFinite(amount) || amount === 0) throw new Error("입금·출금할 금액을 적으세요.");
  const items = await load();
  const target = items.find((a) => a.id === id);
  if (!target) throw new Error("계좌를 찾을 수 없습니다.");
  const next = items.map((a) => {
    if (a.id !== id) return a;
    const at = new Date().toISOString();
    if ((a.anchor ?? "cash") === "total") {
      return { ...a, totalAnchor: Math.round((a.totalAnchor ?? 0) + amount), cashUpdatedAt: at };
    }
    return { ...a, cash: Math.round((a.cash ?? 0) + amount), cashUpdatedAt: at };
  });
  await persist(next);
  return next;
}

// ---------------------------------------------------------------- 평가

export interface EvaluatedHolding extends ManualHolding {
  price: number;
  changeRate: number;
  /** 평가금액 */
  value: number;
  /** 매입금액 */
  cost: number;
  profit: number;
  returnRate: number | null;
}

export interface EvaluatedAccount extends Omit<ManualAccount, "holdings"> {
  holdings: EvaluatedHolding[];
  totalCost: number;
  /** 주식 평가금액 */
  totalValue: number;
  totalProfit: number;
  totalReturnRate: number | null;
  /** 예수금 (없으면 0) */
  cash: number;
  /** 주식 평가금액 + 예수금 — 이게 실제 계좌 잔고다 */
  totalAssets: number;
  /** 총자산 대비 주식 비중(%). 낮으면 현금을 들고 있는 것 */
  stockRatio: number | null;
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** 현재가 조회는 TR당 초당 5회 제한이 있어 순차로 돌린다 */
export async function evaluateAccounts(client: KiwoomClient): Promise<EvaluatedAccount[]> {
  const accounts = await load();

  // 여러 계좌에 같은 종목이 있으면 한 번만 조회한다
  const codes = new Set<string>();
  for (const a of accounts) for (const h of a.holdings) codes.add(h.code);

  const priceMap = new Map<string, { price: number; changeRate: number }>();
  for (const code of codes) {
    try {
      const { data } = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10001", {
        stk_cd: code,
      });
      priceMap.set(code, {
        price: Math.abs(toNum(data.cur_prc)),
        changeRate: toNum(data.flu_rt),
      });
    } catch {
      // 한 종목 실패가 전체를 막지 않게 한다
    }
  }

  return accounts.map((a) => {
    const holdings: EvaluatedHolding[] = a.holdings.map((h) => {
      const q = priceMap.get(h.code);
      const price = q?.price ?? 0;
      const value = price * h.qty;
      const cost = h.avgPrice * h.qty;
      const profit = value - cost;
      return {
        ...h,
        price,
        changeRate: q?.changeRate ?? 0,
        value,
        cost,
        profit,
        returnRate: cost > 0 && price > 0 ? (profit / cost) * 100 : null,
      };
    });

    const totalCost = holdings.reduce((s, h) => s + h.cost, 0);
    const totalValue = holdings.reduce((s, h) => s + h.value, 0);
    const totalProfit = totalValue - totalCost;
    /*
      총자산 기준이면 **예수금을 매번 다시 낸다** — 종목을 담거나 빼면 예수금이 따라온다.
      주식이 총자산보다 커지면 예수금은 0 이다(마이너스 현금은 표시할 뜻이 없다).
      그때는 화면이 「총자산보다 주식이 많다」고 알려 주므로 여기서는 0 으로 눌러 둔다.
    */
    const byTotal = a.anchor === "total" && Number.isFinite(a.totalAnchor ?? NaN);
    const cash = byTotal ? Math.max((a.totalAnchor ?? 0) - totalValue, 0) : Math.max(a.cash ?? 0, 0);
    const totalAssets = byTotal ? Math.max(a.totalAnchor ?? 0, totalValue) : totalValue + cash;
    return {
      ...a,
      holdings,
      totalCost,
      totalValue,
      totalProfit,
      totalReturnRate: totalCost > 0 ? (totalProfit / totalCost) * 100 : null,
      cash,
      totalAssets,
      // 총자산이 0이면 비중을 낼 수 없다 (0으로 나누면 안 되고, 0%도 사실이 아니다)
      stockRatio: totalAssets > 0 ? (totalValue / totalAssets) * 100 : null,
    };
  });
}
