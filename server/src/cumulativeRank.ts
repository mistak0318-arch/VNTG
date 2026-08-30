import type { KiwoomClient } from "./kiwoomClient.js";
import { dropPhantomToday } from "./candleGuard.js";
import { etfAll } from "./routes/etf.js";
import { tradeValueTop } from "./signalScreen.js";

/**
 * 누적등락률 상위 — **우리가 계산한다.**
 *
 * ## 왜 만들었나
 *
 * HTS [0796] 순위분석의 「누적등락상위」를 쓰고 있었는데, 키움 REST 순위정보 26개를
 * **전수 확인한 결과 없다.** `ka10027` 은 전일대비뿐이고 기간 옵션이 없다.
 *
 * 다행히 재료는 다 있다 — 거래대금 상위(어느 종목을 볼지)와 일봉(N일 전 종가).
 * 없는 걸 있는 척 하지 않되, **만들 수 있는 건 만든다.**
 *
 * ## 왜 거래대금 상위에서만 고르나
 *
 * 전 종목을 훑으려면 2천 번을 불러야 하고 30분이 걸린다. 그리고 **거래대금이 얇은
 * 종목은 아무리 올라도 못 산다** — 계산대로 체결이 안 된다. 살 수 있는 것만 본다.
 *
 * ## 왜 캐시가 필수인가
 *
 * 종목당 일봉 한 번, 260ms 간격이라 100종목이면 **26초**다. 화면이 열릴 때마다
 * 이러면 못 쓴다. 한 번 계산해 두고 10분간 그대로 준다 — 누적등락률은 그 사이에
 * 순위가 뒤집힐 값이 아니다.
 */

const CHART = "/api/dostk/chart";
/** 몇 분 동안 계산한 것을 그대로 줄지 */
const TTL_MS = 10 * 60 * 1000;

export interface CumRow {
  code: string;
  name: string;
  price: number;
  /** 기간 누적 등락률(%) */
  cumRate: number;
  /** 오늘 등락률(%) — 누적이 좋아도 오늘 빠지고 있으면 다른 이야기다 */
  todayRate: number;
  /** 기간 시작 종가 */
  from: number;
  tradeValue: number;
  /**
   * 구간별 누적 (2026-08-27 — ETF 표가 3·5·10·20·60일을 한 표에 편다).
   * 일봉은 어차피 다 받았으니 공짜다. 봉이 모자란 구간은 null — 짧은 걸로
   * 대신 세면 거짓말이다(위 days 필터와 같은 원칙).
   */
  r3: number | null;
  r5: number | null;
  r10: number | null;
  r20: number | null;
  r60: number | null;
}

export interface CumResult {
  days: number;
  market: string;
  rows: CumRow[];
  at: string;
  note: string;
}

interface Cached {
  at: number;
  result: CumResult;
}

const cache = new Map<string, Cached>();
/** 같은 조건을 동시에 여러 번 계산하지 않는다 */
const inflight = new Map<string, Promise<CumResult>>();

function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

/** 일봉 종가 배열 (오래된 것 → 최근) */
async function closes(client: KiwoomClient, code: string): Promise<number[]> {
  const d = new Date(Date.now() + 9 * 3600 * 1000);
  const base = d.toISOString().slice(0, 10).replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART, "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = dropPhantomToday((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]);
  return rows
    .map((r) => ({ dt: String(r.dt ?? ""), c: Math.abs(n(r.cur_prc)) }))
    .filter((r) => /^\d{8}$/.test(r.dt) && r.c > 0)
    .sort((a, b) => a.dt.localeCompare(b.dt))
    .map((r) => r.c);
}

export async function cumulativeRank(
  client: KiwoomClient,
  market = "000",
  days = 5,
  universe = 100,
): Promise<CumResult> {
  const key = `${market}:${days}:${universe}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.result;

  const running = inflight.get(key);
  if (running) return running;

  const job = (async (): Promise<CumResult> => {
    /*
     * 모집단. market="ETF" 면 **ETF 전체시세(ka40004)의 거래대금 상위**에서 고른다
     * (2026-08-27 — ETF 메뉴의 기간 등락률). 개별주의 거래대금 상위 TR 은 ETF 를
     * 순위에 잘 안 올리므로 모집단 자체를 갈아끼우는 게 맞다. 일봉(ka10081)은
     * ETF 도 똑같이 나온다.
     */
    const top =
      market === "ETF"
        ? (await etfAll(client))
            .sort((a, b) => b.tradeValue - a.tradeValue)
            .slice(0, universe)
            .map((r) => ({ code: r.code, name: r.name, tradeValue: r.tradeValue }))
        : await tradeValueTop(client, market, universe).catch((e: unknown) => {
            throw new Error(`거래대금 상위 조회 실패: ${e instanceof Error ? e.message : String(e)}`);
          });
    if (top.length === 0) throw new Error("거래대금 상위가 0건입니다");
    const rows: CumRow[] = [];
    const failed: string[] = [];

    for (const t of top) {
      try {
        const cs = await closes(client, t.code);
        // 「N일 누적」인데 데이터가 모자라면 그 종목은 못 센다 — 짧은 걸로 대신 세면 거짓말이다
        if (cs.length < days + 1) continue;
        const last = cs[cs.length - 1];
        const from = cs[cs.length - 1 - days];
        const prev = cs[cs.length - 2];
        if (from <= 0 || prev <= 0) continue;
        const rateAt = (n: number): number | null => {
          const base = cs[cs.length - 1 - n];
          return base && base > 0 ? ((last - base) / base) * 100 : null;
        };
        rows.push({
          code: t.code,
          name: t.name,
          price: last,
          cumRate: ((last - from) / from) * 100,
          todayRate: ((last - prev) / prev) * 100,
          from,
          tradeValue: t.tradeValue ?? 0,
          r3: rateAt(3),
          r5: rateAt(5),
          r10: rateAt(10),
          r20: rateAt(20),
          r60: rateAt(60),
        });
      } catch (e) {
        // 한 종목이 실패해도 나머지는 센다 — 다만 전부 실패하면 아래에서 알린다
        failed.push(`${t.code} ${e instanceof Error ? e.message : ""}`);
      }
      // 키움은 TR 당 초당 5건 — 넉넉히 벌린다
      await new Promise((r) => setTimeout(r, 260));
    }

    if (rows.length === 0 && failed.length > 0) {
      throw new Error(`일봉 조회가 전부 실패했습니다 (${failed.length}건). 예: ${failed[0]}`);
    }
    rows.sort((a, b) => b.cumRate - a.cumRate);
    const result: CumResult = {
      days,
      market,
      rows,
      at: new Date().toISOString(),
      note:
        `거래대금 상위 ${universe}종목 중 ${rows.length}개. ` +
        `키움에 누적등락률 TR 이 없어 **일봉으로 직접 계산**한 값입니다 — ` +
        `거래대금이 얇은 종목은 애초에 빼고 봅니다(못 사는 종목을 순위에 올릴 이유가 없습니다).`,
    };
    cache.set(key, { at: Date.now(), result });
    return result;
  })().finally(() => inflight.delete(key));

  inflight.set(key, job);
  return job;
}
