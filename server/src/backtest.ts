import type { KiwoomClient } from "./kiwoomClient.js";
import { tradeValueTop } from "./signalScreen.js";

/**
 * 조건 백테스트 — **「이 조건으로 들어갔으면 과거에 어땠나」**.
 *
 * ## 왜 필요했나
 *
 * 이 앱은 스스로를 「내 매매 논리를 찾는 훈련 도구」라고 부른다. 그런데 정작
 * 「그 논리가 과거에 통했나」를 물을 수단이 없었다. 한 번 해 본 적은 있다 —
 * 국채금리와 종가배팅을 486건으로 검증해 「도움이 안 된다」는 결론을 냈다.
 * **그게 도구가 아니라 일회성 조사였다는 게 문제다.**
 *
 * ## ⚠️ 미래를 안 쓴다
 *
 * 백테스트가 거짓말하는 가장 흔한 방식은 **판정에 쓴 값으로 사는 것**이다.
 * 조건은 그날 **종가**로 판정한다. 그 종가로 사면 장이 끝난 뒤의 값으로 산 것이라
 * 실제로는 불가능하다. 그래서 **다음 날 시가**로 산다. 일봉에 시가가 있으므로
 * 이건 계산할 수 있고, 이 한 줄이 결과를 몇 %p 씩 바꾼다.
 *
 * ## ⚠️ 기준선을 같이 잰다
 *
 * 「평균 +2.1%」만 적으면 좋아 보인다. 그런데 **그 기간에 아무거나 샀어도 +2.0%**
 * 였다면 그 조건은 아무것도 아니다. 상승장에서는 어떤 조건이든 좋아 보인다.
 *
 * 그래서 **같은 종목·같은 날짜 범위에서 조건을 안 걸고 잰 평균**을 같이 낸다.
 * 볼 것은 「평균 수익률」이 아니라 **그 차이(edge)** 다.
 *
 * ## 무엇을 못 하나
 *
 *   · **신호등 점수로는 못 돌린다.** 신호등은 지금 시점만 계산할 수 있고 과거
 *     점수는 저장을 시작한 지 얼마 안 됐다. 여기 조건은 전부 **일봉으로 계산되는 것**뿐이다.
 *   · 수수료·세금·슬리피지를 안 뺀다. 상대 비교용이라 양쪽에 똑같이 빠진다.
 *   · 상장폐지된 종목이 모집단에 없다(생존 편향). 거래대금 상위에서 고르므로
 *     **오늘 살아서 잘 돌고 있는 종목들**이다 — 결과를 그만큼 좋게 본다.
 */

const CHART = "/api/dostk/chart";

export type RuleKey = "maAlign" | "aboveMa" | "volSurge" | "newHigh" | "minRate";

export interface RuleDef {
  key: RuleKey;
  label: string;
  hint: string;
  /** 기준값이 있는 규칙인가 */
  hasValue: boolean;
  defaultValue: number;
}

export const RULES: RuleDef[] = [
  {
    key: "maAlign",
    label: "정배열",
    hint: "5일선 > 20일선 > 60일선. 추세추종의 기본 전제",
    hasValue: false,
    defaultValue: 0,
  },
  {
    key: "aboveMa",
    label: "이평선 위",
    hint: "종가가 N일선 위에 있다",
    hasValue: true,
    defaultValue: 20,
  },
  {
    key: "volSurge",
    label: "거래량 급증",
    hint: "그날 거래량이 20일 평균의 N배 이상",
    hasValue: true,
    defaultValue: 2,
  },
  {
    key: "newHigh",
    label: "N일 신고가",
    hint: "그날 고가가 지난 N일 중 제일 높다",
    hasValue: true,
    defaultValue: 60,
  },
  {
    key: "minRate",
    label: "당일 등락률",
    hint: "그날 등락률이 N% 이상",
    hasValue: true,
    defaultValue: 3,
  },
];

export interface BacktestConfig {
  market: string;
  /** 거래대금 상위 몇 종목을 대상으로 */
  universe: number;
  /** 며칠 들고 있다 파나 (거래일) */
  holdDays: number;
  /** 켠 규칙과 기준값 */
  rules: { key: RuleKey; value: number }[];
}

export interface BacktestStat {
  count: number;
  avg: number;
  median: number;
  winRate: number;
  best: number;
  worst: number;
}

export interface BacktestResult {
  config: BacktestConfig;
  /** 조건에 걸린 진입들 */
  hit: BacktestStat;
  /** 같은 종목·같은 기간에서 조건 없이 잰 것 — 이게 없으면 위 숫자는 못 읽는다 */
  base: BacktestStat;
  /** 조건이 만든 차이(%p). 이게 진짜 봐야 할 숫자다 */
  edge: number | null;
  /** 실제로 훑은 종목 수 */
  codes: number;
  /** 일봉을 못 받은 종목 수 */
  failed: number;
  /** 훑은 날짜 범위 */
  from: string;
  to: string;
  /** 조건에 제일 잘 맞은 사례 — 눈으로 확인하라고 */
  samples: { code: string; name: string; date: string; rate: number }[];
}

export interface BacktestJob {
  status: "running" | "done" | "error";
  total: number;
  done: number;
  startedAt: string;
  result: BacktestResult | null;
  error?: string;
}

interface Bar {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

function num(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s-]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

/** 일봉 (오래된 것 → 최근) */
async function bars(client: KiwoomClient, code: string): Promise<Bar[]> {
  const d = new Date(Date.now() + 9 * 3600_000);
  const base = d.toISOString().slice(0, 10).replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART, "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  const rows = (res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[];
  return rows
    .map((r) => ({
      date: String(r.dt ?? ""),
      open: num(r.open_pric),
      high: num(r.high_pric),
      low: num(r.low_pric),
      close: num(r.cur_prc),
      volume: num(r.trde_qty),
    }))
    .filter((b) => /^\d{8}$/.test(b.date) && b.close > 0 && b.open > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
}

function mean(xs: number[]): number {
  return xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function ma(bs: Bar[], i: number, n: number): number | null {
  if (i + 1 < n) return null;
  return mean(bs.slice(i + 1 - n, i + 1).map((b) => b.close));
}

/**
 * `i` 번째 날의 **종가 기준**으로 조건을 보나.
 *
 * 여기서 쓰는 값은 전부 `i` 날까지의 것이다 — 뒤를 보면 안 된다.
 */
function passes(bs: Bar[], i: number, rules: { key: RuleKey; value: number }[]): boolean {
  const b = bs[i];
  for (const r of rules) {
    switch (r.key) {
      case "maAlign": {
        const m5 = ma(bs, i, 5);
        const m20 = ma(bs, i, 20);
        const m60 = ma(bs, i, 60);
        if (m5 === null || m20 === null || m60 === null) return false;
        if (!(m5 > m20 && m20 > m60)) return false;
        break;
      }
      case "aboveMa": {
        const m = ma(bs, i, Math.max(2, Math.round(r.value)));
        if (m === null || b.close <= m) return false;
        break;
      }
      case "volSurge": {
        if (i < 20) return false;
        const avg = mean(bs.slice(i - 20, i).map((x) => x.volume));
        if (avg <= 0 || b.volume < avg * r.value) return false;
        break;
      }
      case "newHigh": {
        const n = Math.max(2, Math.round(r.value));
        if (i < n) return false;
        const prevHigh = Math.max(...bs.slice(i - n, i).map((x) => x.high));
        if (!(b.high > prevHigh)) return false;
        break;
      }
      case "minRate": {
        if (i < 1) return false;
        const prev = bs[i - 1].close;
        if (prev <= 0) return false;
        if (((b.close - prev) / prev) * 100 < r.value) return false;
        break;
      }
    }
  }
  return true;
}

function stat(xs: number[]): BacktestStat {
  if (xs.length === 0) {
    return { count: 0, avg: 0, median: 0, winRate: 0, best: 0, worst: 0 };
  }
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return {
    count: xs.length,
    avg: mean(xs),
    // 중앙값을 같이 둔다 — 한 종목이 +90% 면 평균이 혼자 올라간다
    median: sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2,
    winRate: (xs.filter((x) => x > 0).length / xs.length) * 100,
    best: sorted[sorted.length - 1],
    worst: sorted[0],
  };
}

const jobs = new Map<string, BacktestJob>();

export function getBacktestJob(id: string): BacktestJob | null {
  return jobs.get(id) ?? null;
}

export function startBacktest(client: KiwoomClient, input: Partial<BacktestConfig>): { id: string } {
  const cfg: BacktestConfig = {
    market: (["000", "001", "101"] as const).includes(input.market as "000")
      ? (input.market as string)
      : "000",
    universe: Math.min(Math.max(Math.round(input.universe ?? 100) || 100, 10), 300),
    holdDays: Math.min(Math.max(Math.round(input.holdDays ?? 5) || 5, 1), 60),
    rules: (input.rules ?? [])
      .filter((r) => RULES.some((d) => d.key === r.key))
      .map((r) => ({ key: r.key, value: Number(r.value) || 0 })),
  };

  const id = `bt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job: BacktestJob = {
    status: "running",
    total: 0,
    done: 0,
    startedAt: new Date().toISOString(),
    result: null,
  };
  jobs.set(id, job);
  // 오래된 것부터 지운다 — 메모리에만 두므로 몇 개만 남긴다
  if (jobs.size > 8) jobs.delete([...jobs.keys()][0]);

  void (async () => {
    try {
      const universe = await tradeValueTop(client, cfg.market, cfg.universe);
      job.total = universe.length;

      const hits: number[] = [];
      const baseRates: number[] = [];
      const samples: BacktestResult["samples"] = [];
      let failed = 0;
      let from = "";
      let to = "";

      for (const u of universe) {
        try {
          const bs = await bars(client, u.code);
          /*
           * 조건에 60일선이 들어갈 수 있고, 판 날까지 봐야 하므로
           * 최소한 그만큼은 있어야 한 건도 나온다.
           */
          if (bs.length >= 60 + cfg.holdDays + 2) {
            if (!from || bs[0].date < from) from = bs[0].date;
            if (!to || bs[bs.length - 1].date > to) to = bs[bs.length - 1].date;

            for (let i = 60; i + cfg.holdDays + 1 < bs.length; i += 1) {
              /*
               * **다음 날 시가에 사고, 거기서 holdDays 뒤 종가에 판다.**
               * 조건은 `i` 날 종가로 봤으므로 `i` 날 종가로 사면 미래를 쓴 것이다.
               */
              const entry = bs[i + 1].open;
              const exit = bs[i + 1 + cfg.holdDays].close;
              if (entry <= 0 || exit <= 0) continue;
              const rate = ((exit - entry) / entry) * 100;

              // 기준선 — 조건을 안 걸고 같은 날 같은 방식으로 산 것
              baseRates.push(rate);

              if (cfg.rules.length > 0 && passes(bs, i, cfg.rules)) {
                hits.push(rate);
                samples.push({ code: u.code, name: u.name, date: bs[i].date, rate });
              }
            }
          } else {
            failed += 1;
          }
        } catch {
          failed += 1;
        }
        job.done += 1;
        await new Promise((r) => setTimeout(r, 260));
      }

      const hit = stat(hits);
      const base = stat(baseRates);
      job.result = {
        config: cfg,
        hit,
        base,
        edge: hit.count > 0 && base.count > 0 ? hit.avg - base.avg : null,
        codes: universe.length - failed,
        failed,
        from,
        to,
        // 잘된 것만 보여주면 자기 기만이라 **양 끝을 같이** 보여준다
        samples: [...samples]
          .sort((a, b) => b.rate - a.rate)
          .filter((_, idx, arr) => idx < 5 || idx >= arr.length - 5),
      };
      job.status = "done";
    } catch (err) {
      job.status = "error";
      job.error = err instanceof Error ? err.message : "백테스트 실패";
    }
  })();

  return { id };
}
