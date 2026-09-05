import type { KiwoomClient } from "./kiwoomClient.js";
import { asOf, backAt, isLagged, maAt, series, seriesDef, stockBars, type Point } from "./simSeries.js";
import type { Cond, SimRule } from "./simRules.js";
import { FEE_RATE, TAX_RATE } from "./cisAccount.js";

/**
 * 시뮬레이터 **엔진** (2026-09-04).
 *
 * ## 하루를 처리하는 함수는 **하나뿐**이다
 *
 * 백테스트와 실전 진행이 같은 `step()` 을 지난다. 이게 이 파일의 전부다.
 *
 * 두 길로 만들면 반드시 어긋난다 — 이 코드베이스에서 세 번 겪었다(호가 정렬, 버즈
 * 문턱, 현재가 출처). 그리고 여기서 어긋나면 **백테스트가 실전과 다른 성적을 낸다.**
 * 그건 이 도구의 존재 이유를 무너뜨린다. 「과거에 이랬으면 이랬다」가 거짓이면
 * 안 만드느니만 못하다.
 *
 * ## 수수료와 세금
 *
 * 매수 0.015%, 매도 0.015% + 거래세 0.18%(2026년 코스피·코스닥 기준).
 * 안 넣으면 잦은 매매 규칙이 실제보다 훨씬 좋아 보인다 — 하루짜리 규칙에서는
 * 왕복 0.21% 가 성적의 대부분을 먹는다. 넣지 않으면 그 사실이 안 보인다.
 */

/**
 * 왕복 비용 — **`cisAccount` 것을 그대로 쓴다** (2026-09-04 전수 점검에서 고침).
 *
 * 처음엔 여기에 `0.00015` · `0.0018` 을 다시 적었다. 항해일지 계좌가 이미 같은 값을
 * 들고 있는데(`FEE_RATE` · `TAX_RATE`) 모르고 두 벌을 만든 것이다 — 이 코드베이스가
 * 반복해서 데인 바로 그 병이다. 세율이 바뀌는 날 한쪽만 고치면, 시뮬레이터가 낸 성적과
 * 항해일지가 낸 성적을 **더 이상 나란히 놓을 수 없다.**
 *
 * 이름을 남겨 두는 이유는 이 파일 안에서 「매수 수수료 / 매도 수수료 / 매도세」가
 * 갈려 읽혀야 해서다. 값은 한 곳에서 온다.
 */
export const FEE_BUY = FEE_RATE;
export const FEE_SELL = FEE_RATE;
export const TAX_SELL = TAX_RATE;

export interface SimTrade {
  d: string;
  side: "buy" | "sell";
  qty: number;
  price: number;
  amount: number;
  /** 매도일 때 — 이 거래로 확정된 손익(비용 뺀 뒤) */
  pnl?: number;
  why: string;
}

export interface SimState {
  cash: number;
  qty: number;
  /** 평단 — 비용을 얹은 값이라 실제 본전이다 */
  avg: number;
  trades: SimTrade[];
  /** 날마다 찍는 평가액 — 곡선과 최대낙폭의 재료 */
  curve: { d: string; equity: number }[];
}

export function newState(seed: number): SimState {
  return { cash: seed, qty: 0, avg: 0, trades: [], curve: [] };
}

/** 조건 하나가 그날 맞았나 — 못 재면 `null`(= 「모른다」, 안 맞은 것과 다르다) */
function evalCond(
  c: Cond,
  d: string,
  stock: Point[],
  ext: Map<string, Point[]>,
): { ok: boolean | null; text: string } {
  const key = c.key ?? "";
  const rows = c.src === "stock" ? stock : (ext.get(key) ?? []);
  /*
   * **바깥 시계로 도는 변수는 그날 값을 못 쓴다.** 한국 종가 15:30 에 미국장·프리장은
   * 아직 시작도 안 했다. `lag` 가 켜지면 조회가 그날을 빼고 그 이전 마지막 값을 읽는다.
   * 이 한 칸이 백테스트의 진위를 가른다(`simSeries` 머리말의 표).
   */
  const lag = c.src === "series" && isLagged(key);
  const def = c.src === "series" ? seriesDef(key) : null;
  const label = c.src === "stock" ? "종목" : `${def?.label ?? (key || "?")}${lag ? "(전일)" : ""}`;
  const now = asOf(rows, d, lag);
  if (now === null) return { ok: null, text: `${label} 값을 못 읽음` };

  let v: number | null = null;
  let unit = "";
  /** 무엇을 잰 값인지 — 이게 없으면 기록의 `-0.53%` 가 등락률인지 이평 이격인지 모른다 */
  let measure = "";
  if (c.metric === "close") {
    v = now;
    unit = c.src === "series" ? (def?.unit ?? "") : "원";
  } else if (c.metric === "chg1") {
    const prev = backAt(rows, d, 1, lag);
    v = prev !== null && prev !== 0 ? ((now - prev) / prev) * 100 : null;
    unit = "%";
    measure = "전일비 ";
  } else if (c.metric === "chgN") {
    const n = c.n ?? 5;
    const prev = backAt(rows, d, n, lag);
    v = prev !== null && prev !== 0 ? ((now - prev) / prev) * 100 : null;
    unit = "%";
    measure = `${n}일전비 `;
  } else if (c.metric === "vsMa") {
    const n = c.n ?? 20;
    const ma = maAt(rows, d, n, lag);
    v = ma !== null && ma !== 0 ? ((now - ma) / ma) * 100 : null;
    unit = "%";
    measure = `${n}일선비 `;
  }
  if (v === null) return { ok: null, text: `${label} ${measure}을 못 잼` };

  /*
   * `absLte`·`absGt` 는 **부호를 뺀 크기**를 잰다 — 「보합(0 근처)」을 부등호 하나로
   * 적기 위한 것이다. 문턱도 절대값으로 읽는다: 사람이 `-0.1` 을 넣어도 ±0.1 로 본다.
   */
  const target = Math.abs(c.value);
  const ok =
    c.op === "lt"
      ? v < c.value
      : c.op === "lte"
        ? v <= c.value
        : c.op === "gt"
          ? v > c.value
          : c.op === "gte"
            ? v >= c.value
            : c.op === "absLte"
              ? Math.abs(v) <= target
              : Math.abs(v) > target;

  /*
   * **기호로 적지 않는다** (2026-09-05). 벤티지: "기호만 있어서 전일 대비 상승에 거는
   * 건지 하락에 거는 건지도 모르겠고." 거래 기록의 이 줄은 나중에 「왜 샀나」를 되짚는
   * 유일한 자리라, 되짚는 사람이 부등호 방향을 머리로 뒤집어야 하면 안 된다.
   */
  const word =
    c.op === "lt"
      ? "미만"
      : c.op === "lte"
        ? "이하"
        : c.op === "gt"
          ? "초과"
          : c.op === "gte"
            ? "이상"
            : c.op === "absLte"
              ? "이내"
              : "밖";
  const bound =
    c.op === "absLte" || c.op === "absGt" ? `±${target}${unit}` : `${c.value}${unit}`;
  /*
   * 부호에 뜻이 있는 변수(프리장)가 0 을 기준으로 걸렸으면 **그 말로 적는다.**
   * 「+3.01% (0% 초과)」보다 「+3.01% 양봉」이 되짚을 때 한 박자 빠르다.
   */
  const named =
    def?.zero && target === 0 && c.op !== "absGt"
      ? c.op === "gt" || c.op === "gte"
        ? def.zero.up
        : c.op === "absLte"
          ? def.zero.flat
          : def.zero.down
      : null;
  /* 등락률은 부호와 소수 둘째 자리까지, 값 자체(지수·주가)는 그냥 그 값으로 */
  const shown =
    unit === "%"
      ? `${v > 0 ? "+" : ""}${v.toFixed(2)}%`
      : `${(Math.round(v * 100) / 100).toLocaleString("ko-KR")}${unit}`;
  return { ok, text: `${label} ${measure}${shown} ${named ?? `(${bound} ${word})`}` };
}

/**
 * 조건 묶음 — **모두** 맞아야 한다.
 *
 * ⚠️ 조건이 **하나도 없으면 안 맞은 것**으로 본다. 빈 조건을 「늘 참」으로 두면
 * 규칙을 만들다 만 사람이 매일 사는 규칙을 갖게 된다.
 *
 * ⚠️ 못 잰 조건이 하나라도 있으면 **안 맞은 것**이다. 「모른다」를 「맞았다」로
 * 세면 자료가 빈 구간에서 거래가 쏟아진다.
 */
function evalAll(
  list: Cond[],
  d: string,
  stock: Point[],
  ext: Map<string, Point[]>,
): { ok: boolean; why: string } {
  if (list.length === 0) return { ok: false, why: "조건 없음" };
  const parts: string[] = [];
  for (const c of list) {
    const r = evalCond(c, d, stock, ext);
    parts.push(r.text);
    if (r.ok !== true) return { ok: false, why: parts.join(" · ") };
  }
  return { ok: true, why: parts.join(" · ") };
}

/**
 * **하루를 진행한다.** 백테스트도 실전도 이 함수만 부른다.
 *
 * 순서는 **팔고 나서 산다.** 같은 날 둘 다 맞으면 자리를 비운 뒤 다시 잡는 것이
 * 사람이 하는 순서이고, 반대로 하면 예수금이 없어 못 사는 날이 생겨 규칙이 아니라
 * 잔고가 성적을 정한다.
 */
export function step(
  rule: SimRule,
  st: SimState,
  d: string,
  price: number,
  stock: Point[],
  ext: Map<string, Point[]>,
): void {
  if (price <= 0) return;

  /* ① 판다 — 들고 있을 때만 */
  if (st.qty > 0) {
    const s = evalAll(rule.sell, d, stock, ext);
    if (s.ok) {
      const gross = st.qty * price;
      const net = gross * (1 - FEE_SELL - TAX_SELL);
      const cost = st.qty * st.avg;
      st.trades.push({
        d,
        side: "sell",
        qty: st.qty,
        price,
        amount: Math.round(net),
        pnl: Math.round(net - cost),
        why: s.why,
      });
      st.cash += net;
      st.qty = 0;
      st.avg = 0;
    }
  }

  /* ② 산다 — 이미 들고 있으면 `addOn` 이 켜져 있을 때만 */
  if (st.qty === 0 || rule.addOn) {
    const b = evalAll(rule.buy, d, stock, ext);
    if (b.ok) {
      const budget = Math.min(rule.buyAmount, st.cash);
      const qty = Math.floor(budget / (price * (1 + FEE_BUY)));
      if (qty > 0) {
        const spend = qty * price * (1 + FEE_BUY);
        /* 평단은 비용을 얹은 값 — 그래야 「본전」이 실제 본전이다 */
        st.avg = (st.avg * st.qty + spend) / (st.qty + qty);
        st.qty += qty;
        st.cash -= spend;
        st.trades.push({ d, side: "buy", qty, price, amount: Math.round(spend), why: b.why });
      }
    }
  }

  st.curve.push({ d, equity: Math.round(st.cash + st.qty * price) });
}

export interface SimResult {
  from: string;
  to: string;
  days: number;
  seed: number;
  equity: number;
  /** 시드 대비(%) */
  ret: number;
  /** 같은 기간 그 종목을 그냥 들고 있었다면(%) — 규칙이 값을 했는지 견줄 자 */
  buyHold: number | null;
  trades: SimTrade[];
  /** 판 거래 수와 그중 이긴 수 */
  closed: number;
  wins: number;
  /** 최대낙폭(%) — 곡선의 고점 대비 */
  mdd: number;
  curve: { d: string; equity: number }[];
  /** 왜 한 건도 없었나 — 빈 결과는 이유를 말해야 한다 */
  note: string | null;
  /**
   * **이 성적을 믿을 수 없게 만드는 것들** (2026-09-05).
   *
   * 조건에 쓴 바깥 변수가 백테스트 구간을 다 못 덮으면 여기 적힌다. 프리장처럼 뒤로
   * 60일뿐인 변수를 250일 구간에서 쓰면 **앞의 190일은 조건이 「못 잼」이라 안 맞은
   * 것으로 세어진다** — 거래가 없는 것이 규칙 탓인지 자료 탓인지 화면에서 구분이
   * 안 되면 이 도구는 거짓말을 하는 것이다. 비어 있으면 덮은 것이다.
   */
  limits: string[];
}

/** 결과를 요약한다 — 백테스트와 실전이 같은 요약을 쓴다 */
export function summarize(
  rule: SimRule,
  st: SimState,
  bars: { d: string; c: number }[],
): SimResult {
  const first = bars[0];
  const last = bars[bars.length - 1];
  const equity = st.curve.length > 0 ? st.curve[st.curve.length - 1].equity : rule.seed;

  let peak = 0;
  let mdd = 0;
  for (const p of st.curve) {
    if (p.equity > peak) peak = p.equity;
    if (peak > 0) mdd = Math.min(mdd, ((p.equity - peak) / peak) * 100);
  }

  const sells = st.trades.filter((t) => t.side === "sell");
  return {
    from: first?.d ?? "",
    to: last?.d ?? "",
    days: bars.length,
    seed: rule.seed,
    equity,
    ret: rule.seed > 0 ? Number((((equity - rule.seed) / rule.seed) * 100).toFixed(2)) : 0,
    buyHold:
      first && last && first.c > 0 ? Number((((last.c - first.c) / first.c) * 100).toFixed(2)) : null,
    trades: st.trades,
    closed: sells.length,
    wins: sells.filter((t) => (t.pnl ?? 0) > 0).length,
    mdd: Number(mdd.toFixed(2)),
    curve: st.curve,
    /*
     * 빈 결과는 **왜 비었는지**를 말해야 한다. 셋을 갈라 적는다 —
     * 「아직 안 갔다」와 「조건이 안 맞았다」를 뭉뚱그리면, 방금 켠 실전 규칙이
     * 마치 조건이 나쁜 것처럼 읽힌다(2026-09-04 화면에서 실제로 그렇게 보였다).
     */
    note:
      st.curve.length === 0
        ? "아직 하루도 안 갔습니다 — 다음 일봉이 들어오면 한 걸음 나갑니다"
        : st.trades.length === 0
          ? rule.buy.length === 0
            ? "매수 조건이 비어 있습니다 — 조건이 없으면 사지 않습니다"
            : "이 구간에서 매수 조건이 한 번도 다 맞지 않았습니다"
          : null,
    limits: [],
  };
}

/**
 * 쓴 바깥 변수가 구간을 **덮었나**.
 *
 * 백테스트에만 붙인다. 실전 진행은 켠 날부터 앞으로만 가서 60일짜리 변수로도 안 모자라고,
 * 조회가 통째로 실패하는 경우는 백테스트를 한 번 돌리면 여기서 바로 보인다.
 */
function coverageLimits(ext: Map<string, Point[]>, bars: { d: string }[]): string[] {
  const out: string[] = [];
  const from = bars[0]?.d ?? "";
  for (const [k, rows] of ext) {
    const name = seriesDef(k)?.label ?? k;
    if (rows.length === 0) {
      out.push(`「${name}」 값을 하나도 못 받았습니다 — 이 조건은 이 구간 내내 안 맞은 것으로 셌습니다`);
      continue;
    }
    if (from && rows[0].d > from) {
      const miss = bars.filter((b) => b.d < rows[0].d).length;
      out.push(
        `「${name}」 는 ${rows[0].d.slice(0, 4)}-${rows[0].d.slice(4, 6)}-${rows[0].d.slice(6)} 부터만 있습니다 — ` +
          `앞의 ${miss}거래일은 못 재서 안 맞은 것으로 셌습니다. 구간을 줄여서 다시 보세요`,
      );
    }
  }
  return out;
}

/**
 * **백테스트** — 저장해 둔 일봉으로 과거를 다시 산다.
 *
 * ⚠️ 창고가 500일뿐이라 그보다 길게는 못 본다. 못 하는 것을 되는 척하지 않고
 * 실제로 쓴 구간(`from`~`to`)을 결과에 적어 화면이 그대로 보여 준다.
 */
export async function backtest(
  client: KiwoomClient,
  rule: SimRule,
  days = 250,
): Promise<SimResult> {
  const all = await stockBars(rule.code);
  const bars = all.slice(-Math.max(20, Math.min(500, days)));
  if (bars.length === 0) {
    return {
      ...summarize(rule, newState(rule.seed), []),
      note: "이 종목의 일봉이 창고에 없습니다 — 설정 › 일봉 수집에서 받아야 합니다",
    };
  }

  /* 바깥 변수는 규칙이 실제로 쓰는 것만 받는다 — 안 쓰는 것을 받으면 조회만 는다 */
  const keys = [...new Set([...rule.buy, ...rule.sell].filter((c) => c.src === "series").map((c) => c.key ?? ""))].filter(Boolean);
  const ext = new Map<string, Point[]>();
  for (const k of keys) ext.set(k, await series(client, k));

  const stock: Point[] = all.map((b) => ({ d: b.d, c: b.c }));
  const st = newState(rule.seed);
  for (const b of bars) step(rule, st, b.d, b.c, stock, ext);
  return { ...summarize(rule, st, bars), limits: coverageLimits(ext, bars) };
}
