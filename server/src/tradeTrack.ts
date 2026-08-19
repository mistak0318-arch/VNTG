import type { KiwoomClient } from "./kiwoomClient.js";
import { listEntries, type JournalTrade } from "./tradeJournal.js";

/**
 * 내 매매 판단 추적 — **「그때 그 판단이 옳았나」.**
 *
 * ## 왜 실현손익으로는 안 되나
 *
 * 복기 노트에는 이미 매수·매도가 쌓이고, 통계도 있다. 그런데 그건 FIFO 로 짝을 지어
 * **번 돈**을 세는 것이다. 그것만으로는 답이 안 나오는 질문이 있다 —
 *
 *   "이런 이유로 팔았는데, 지나고 보니 이거 봐라?"
 *
 * 판 뒤에 20% 오른 종목은 실현손익에 **아무 흔적도 남기지 않는다.** 장부상으로는
 * 얌전히 수익을 낸 거래이고, 놓친 것은 어디에도 안 적힌다. 그런데 복기에서 봐야 하는 건
 * 바로 그거다.
 *
 * ## 그래서 판단을 따로 센다
 *
 * 매매 하나하나를 **그날의 판단**으로 보고, 그 뒤 1·5·20·60 거래일에 값이 어디로 갔는지 본다.
 *
 *   매수 → 오르면 맞은 판단
 *   매도 → **내리면 맞은 판단**
 *
 * 매도는 **부호가 뒤집힌다.** 이게 이 모듈의 핵심이다. 팔고 나서 −10% 면 잘 판 것이고,
 * +10% 면 못 판 것이다. 수익률 그대로 더하면 매수와 매도가 서로를 상쇄해 아무 말도
 * 안 하는 숫자가 나온다.
 *
 * 거래일로 센다 — 달력으로 세면 주말·휴장이 섞여 거래마다 기준이 달라진다.
 * ([[signalTrack]] 이 같은 이유로 같은 방식을 쓴다)
 */

export const HORIZONS = [1, 5, 20, 60] as const;
export type Horizon = (typeof HORIZONS)[number];

export interface TradeOutcome {
  days: Horizon;
  price: number;
  /** 체결가 대비 값의 변화(%) — 방향은 아직 안 뒤집은 날것 */
  move: number;
  /**
   * 그 판단이 옳았던 정도(%).
   * 매수면 `move` 그대로, **매도면 부호를 뒤집은 값**이다.
   */
  edge: number;
}

export interface TrackedTrade extends JournalTrade {
  date: string;
  outcomes: TradeOutcome[];
  /** 일봉을 못 받았으면 왜인지 */
  error?: string;
}

export interface HorizonStat {
  days: Horizon;
  n: number;
  /** 판단이 맞은 비율(%) — 매수는 오른 것, 매도는 내린 것 */
  hitRate: number;
  avgEdge: number;
  best: number;
  worst: number;
}

export interface TradeTrackResult {
  trades: TrackedTrade[];
  buy: HorizonStat[];
  sell: HorizonStat[];
  /**
   * 판 뒤에 오히려 오른 것들 — **이 화면의 본론.**
   * 실현손익 어디에도 안 남는 값이라 여기서 보지 않으면 볼 곳이 없다.
   */
  soldTooEarly: { date: string; name: string; days: Horizon; move: number; note: string }[];
  fetched: number;
  failed: number;
}

/** 일봉 — 편입일 이후 몇 번째 거래일인지를 세려면 이게 있어야 한다 */
async function dailyCloses(
  client: KiwoomClient,
  code: string,
): Promise<{ date: string; close: number }[]> {
  const d = new Date();
  const base = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const res = await client.request<Record<string, unknown>>("/api/dostk/chart", "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = (res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  return rows
    .map((r) => ({
      date: String(r.dt ?? ""),
      close: Math.abs(Number(String(r.cur_prc ?? "").replace(/[+,]/g, ""))),
    }))
    .filter((r) => /^\d{8}$/.test(r.date) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function stat(days: Horizon, edges: number[]): HorizonStat {
  if (edges.length === 0) {
    return { days, n: 0, hitRate: 0, avgEdge: 0, best: 0, worst: 0 };
  }
  return {
    days,
    n: edges.length,
    hitRate: (edges.filter((e) => e > 0).length / edges.length) * 100,
    avgEdge: edges.reduce((a, b) => a + b, 0) / edges.length,
    best: Math.max(...edges),
    worst: Math.min(...edges),
  };
}

/**
 * 최근 매매를 훑어 결과를 채운다.
 *
 * 종목마다 일봉을 **한 번만** 받는다 — 같은 종목을 여러 날 사고팔았을 수 있다.
 * 키움은 TR 당 초당 5건이라 종목 사이에 간격을 둔다.
 */
export async function trackTrades(
  client: KiwoomClient,
  opts: { days?: number } = {},
): Promise<TradeTrackResult> {
  // 60거래일을 봐야 하므로 그보다 넉넉히 거슬러 본다
  const lookback = Math.min(Math.max(opts.days ?? 180, 30), 730);
  const since = new Date(Date.now() - lookback * 24 * 3600_000).toISOString().slice(0, 10);

  const entries = (await listEntries(400)).filter((e) => e.date >= since);
  const flat: { date: string; trade: JournalTrade }[] = [];
  for (const e of entries) {
    for (const t of e.trades) {
      // 종목코드가 없으면 값을 찾을 수가 없다 — 손으로 이름만 적은 줄이 있다
      if (t.code && t.price > 0) flat.push({ date: e.date, trade: t });
    }
  }

  const codes = [...new Set(flat.map((f) => f.trade.code))];
  const charts = new Map<string, { date: string; close: number }[]>();
  let failed = 0;
  for (const code of codes) {
    const rows = await dailyCloses(client, code).catch(() => []);
    if (rows.length > 0) charts.set(code, rows);
    else failed += 1;
    await new Promise((r) => setTimeout(r, 260));
  }

  const trades: TrackedTrade[] = [];
  const byKind = { buy: new Map<Horizon, number[]>(), sell: new Map<Horizon, number[]>() };
  const soldTooEarly: TradeTrackResult["soldTooEarly"] = [];

  for (const { date, trade } of flat) {
    const rows = charts.get(trade.code);
    if (!rows) {
      trades.push({ ...trade, date, outcomes: [], error: "일봉을 받지 못했습니다" });
      continue;
    }
    const ymd = date.replace(/-/g, "");
    // 매매일 **이후** 첫 봉부터 센다. 당일 봉은 0일째라 결과가 아니다
    const start = rows.findIndex((r) => r.date > ymd);
    const outcomes: TradeOutcome[] = [];
    if (start >= 0) {
      for (const h of HORIZONS) {
        const row = rows[start + h - 1];
        if (!row) break; // 아직 그만큼 지나지 않았다
        const move = ((row.close - trade.price) / trade.price) * 100;
        // 매도는 부호를 뒤집는다 — 팔고 나서 내렸으면 잘 판 것이다
        const edge = trade.kind === "sell" ? -move : move;
        outcomes.push({ days: h, price: row.close, move, edge });
        const m = byKind[trade.kind];
        m.set(h, [...(m.get(h) ?? []), edge]);

        // 판 뒤에 오른 것 — 실현손익 어디에도 안 남는 값이다
        if (trade.kind === "sell" && move > 5) {
          soldTooEarly.push({ date, name: trade.name, days: h, move, note: trade.note });
        }
      }
    }
    trades.push({ ...trade, date, outcomes });
  }

  return {
    trades: trades.sort((a, b) => b.date.localeCompare(a.date)),
    buy: HORIZONS.map((h) => stat(h, byKind.buy.get(h) ?? [])),
    sell: HORIZONS.map((h) => stat(h, byKind.sell.get(h) ?? [])),
    /*
     * 같은 매도가 5·20·60일에 다 걸리면 세 줄이 된다.
     * **가장 크게 오른 구간 하나만** 남긴다 — 놓친 크기가 요점이지 몇 번 걸렸는지가 아니다.
     */
    soldTooEarly: [...soldTooEarly]
      .sort((a, b) => b.move - a.move)
      .filter((x, i, arr) => arr.findIndex((y) => y.date === x.date && y.name === x.name) === i)
      .slice(0, 20),
    fetched: codes.length - failed,
    failed,
  };
}
