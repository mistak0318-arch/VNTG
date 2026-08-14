import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";
import { listThemes } from "./customThemes.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { listLinks } from "./usKrLinks.js";

/**
 * 미국 ↔ 국내 연동 2단계 — 상관계수 검증.
 *
 * 1단계에서 만든 매핑은 **사람이 적은 가설**이다. 상관관계는 변하므로 그 가설이
 * 아직 유효한지 숫자로 확인해야 한다. 그러지 않으면 낡은 매핑을 계속 믿게 된다.
 *
 * 두 가지를 잰다:
 *   sameDay  — 미국 D일 ↔ 국내 D일. 국내 장이 **먼저** 끝나므로 인과가 아니다. 참고용.
 *   nextDay  — 미국 D일 ↔ 국내 D+1일. **이쪽이 진짜 연동**이다.
 *              미국장은 한국 시각 새벽에 끝나므로 그 결과가 국내에 반영되는 건 다음 날이다.
 *
 * 테마의 일별 등락률은 키움이 주지 않아 **구성종목 일봉에서 직접 계산**한다.
 * 가중은 하지 않고 **단순평균**을 쓴다 — 과거 시점의 시가총액을 구할 수 없어서
 * 오늘 시총으로 과거를 가중하면 미래 정보를 끌어다 쓰는 셈(look-ahead)이 되기 때문이다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "usKrCorrelation.json");
const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

/** 날짜(YYYY-MM-DD) → 등락률(%) */
type Series = Map<string, number>;

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function dashed(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/** 종가 배열을 일별 등락률로. 첫날은 비교 대상이 없어 버린다 */
function toReturns(closes: { date: string; close: number }[]): Series {
  const asc = [...closes].sort((a, b) => a.date.localeCompare(b.date));
  const out: Series = new Map();
  for (let i = 1; i < asc.length; i++) {
    const prev = asc[i - 1].close;
    if (prev > 0) out.set(asc[i].date, ((asc[i].close - prev) / prev) * 100);
  }
  return out;
}

// ---------------------------------------------------------------- 국내

/** 오늘(YYYYMMDD) — ka10081 의 base_dt 는 필수라서 반드시 채워야 한다 */
function todayYmd(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

async function krCloses(client: KiwoomClient, code: string): Promise<{ date: string; close: number }[]> {
  const { data } = await client.request<{ stk_dt_pole_chart_qry?: Record<string, unknown>[] }>(
    "/api/dostk/chart",
    "ka10081",
    // base_dt 를 빈 값으로 보내면 "필수 입력 값 없음"으로 전부 실패한다
    { stk_cd: code, base_dt: todayYmd(), upd_stkpc_tp: "1" },
  );
  const rows = Array.isArray(data.stk_dt_pole_chart_qry) ? data.stk_dt_pole_chart_qry : [];
  return rows
    .map((r) => ({ date: dashed(String(r.dt ?? "")), close: toNum(r.cur_prc) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.close > 0);
}

/**
 * 테마별 일별 등락률.
 * 구성종목 일봉을 모아 **같은 날짜의 등락률을 단순평균**한다.
 * 종목이 하나도 안 잡히는 날은 그 테마의 그날 값을 만들지 않는다.
 */
async function themeReturns(
  client: KiwoomClient,
  themeNames: string[],
  days: number,
): Promise<{ series: Map<string, Series>; fetched: number; failed: number }> {
  const themes = (await listThemes()).filter((t) => themeNames.includes(t.name));
  const codes = [...new Set(themes.flatMap((t) => t.codes))];

  const byCode = new Map<string, Series>();
  let failed = 0;

  // 초당 5회 제한 — 5개씩 끊어 부른다
  for (let i = 0; i < codes.length; i += 5) {
    const chunk = codes.slice(i, i + 5);
    const got = await Promise.all(
      chunk.map(async (code) => {
        try {
          return { code, rows: await krCloses(client, code) };
        } catch {
          return { code, rows: [] as { date: string; close: number }[] };
        }
      }),
    );
    for (const g of got) {
      if (g.rows.length < 5) {
        failed += 1;
        continue;
      }
      byCode.set(g.code, toReturns(g.rows.slice(0, days + 1)));
    }
    if (i + 5 < codes.length) await new Promise((r) => setTimeout(r, 1100));
  }

  const series = new Map<string, Series>();
  for (const t of themes) {
    const members = t.codes.map((c) => byCode.get(c)).filter((s): s is Series => Boolean(s));
    if (members.length === 0) continue;
    const dates = new Set(members.flatMap((m) => [...m.keys()]));
    const out: Series = new Map();
    for (const d of dates) {
      const vals = members.map((m) => m.get(d)).filter((v): v is number => v !== undefined);
      if (vals.length > 0) out.set(d, vals.reduce((a, b) => a + b, 0) / vals.length);
    }
    series.set(t.name, out);
  }

  return { series, fetched: byCode.size, failed };
}

// ---------------------------------------------------------------- 미국

async function usReturns(symbol: string, days: number): Promise<Series> {
  const url = `${YAHOO_BASE}/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!res.ok) {
    void recordApiCall("yahoo", symbol, res.status === 429 ? "rateLimited" : "failed");
    return new Map();
  }
  void recordApiCall("yahoo", symbol, "ok");
  const body = (await res.json()) as {
    chart?: {
      result?: Array<{
        timestamp?: number[];
        indicators?: { quote?: Array<{ close?: (number | null)[] }> };
      }>;
    };
  };
  const r = body.chart?.result?.[0];
  const ts = r?.timestamp ?? [];
  const closes = r?.indicators?.quote?.[0]?.close ?? [];

  const rows: { date: string; close: number }[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (typeof c !== "number" || !Number.isFinite(c)) continue;
    rows.push({ date: new Date(ts[i] * 1000).toISOString().slice(0, 10), close: c });
  }
  return toReturns(rows.slice(-(days + 1)));
}

// ---------------------------------------------------------------- 상관계수

/** 피어슨 상관계수. 표본이 적으면 우연히 큰 값이 나오므로 개수도 같이 돌려준다 */
function pearson(pairs: [number, number][]): number | null {
  const n = pairs.length;
  if (n < 10) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n;
  const my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of pairs) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  const d = Math.sqrt(sxx * syy);
  return d > 0 ? sxy / d : null;
}

/** 다음 거래일을 찾는다 — 국내 달력이 없으므로 국내 시계열에 실제로 있는 날짜에서 고른다 */
function nextTradingDay(krDates: string[], after: string): string | undefined {
  return krDates.find((d) => d > after);
}

export interface LinkCorrelation {
  label: string;
  us: string;
  kr: string;
  /** 미국 D ↔ 국내 D (국내가 먼저 끝나므로 인과가 아니다) */
  sameDay: number | null;
  /** 미국 D ↔ 국내 D+1 — 이쪽이 진짜 연동 */
  nextDay: number | null;
  /** nextDay 계산에 쓰인 표본 수 */
  samples: number;
  /** 미국이 1% 움직였을 때 국내가 평균 몇 % 따라갔는가 (nextDay 회귀 기울기) */
  beta: number | null;
}

export interface CorrelationResult {
  at: string;
  days: number;
  pairs: LinkCorrelation[];
  krFetched: number;
  krFailed: number;
}

export async function computeCorrelations(
  client: KiwoomClient,
  days = 60,
): Promise<CorrelationResult> {
  const links = await listLinks();
  const themeNames = [...new Set(links.flatMap((l) => l.kr))];
  const symbols = [...new Set(links.flatMap((l) => l.us))];

  const [{ series: krSeries, fetched, failed }, usEntries] = await Promise.all([
    themeReturns(client, themeNames, days),
    (async () => {
      const out = new Map<string, Series>();
      for (let i = 0; i < symbols.length; i += 5) {
        const chunk = symbols.slice(i, i + 5);
        const got = await Promise.all(chunk.map(async (s) => [s, await usReturns(s, days)] as const));
        for (const [s, v] of got) out.set(s, v);
        if (i + 5 < symbols.length) await new Promise((r) => setTimeout(r, 300));
      }
      return out;
    })(),
  ]);

  const pairs: LinkCorrelation[] = [];
  for (const link of links) {
    for (const us of link.us) {
      const usR = usEntries.get(us);
      if (!usR || usR.size === 0) continue;
      for (const kr of link.kr) {
        const krR = krSeries.get(kr);
        if (!krR || krR.size === 0) continue;

        const krDates = [...krR.keys()].sort();
        const same: [number, number][] = [];
        const next: [number, number][] = [];
        for (const [d, uv] of usR) {
          const sv = krR.get(d);
          if (sv !== undefined) same.push([uv, sv]);
          const nd = nextTradingDay(krDates, d);
          const nv = nd ? krR.get(nd) : undefined;
          if (nv !== undefined) next.push([uv, nv]);
        }

        // 회귀 기울기 — "미국 1% 움직이면 국내는 평균 몇 %" (예상치 계산에 쓴다)
        let beta: number | null = null;
        if (next.length >= 10) {
          const mx = next.reduce((s, p) => s + p[0], 0) / next.length;
          const my = next.reduce((s, p) => s + p[1], 0) / next.length;
          let sxy = 0;
          let sxx = 0;
          for (const [x, y] of next) {
            sxy += (x - mx) * (y - my);
            sxx += (x - mx) ** 2;
          }
          beta = sxx > 0 ? sxy / sxx : null;
        }

        pairs.push({
          label: link.label,
          us,
          kr,
          sameDay: pearson(same),
          nextDay: pearson(next),
          samples: next.length,
          beta,
        });
      }
    }
  }

  // 연동이 강한 순
  pairs.sort((a, b) => Math.abs(b.nextDay ?? 0) - Math.abs(a.nextDay ?? 0));

  const result: CorrelationResult = {
    at: new Date().toISOString(),
    days,
    pairs,
    krFetched: fetched,
    krFailed: failed,
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(result), "utf-8");
  return result;
}

/** 저장된 결과. 무거운 계산이라 화면은 이걸 읽고, 갱신은 사용자가 누를 때만 한다 */
export async function loadCorrelations(): Promise<CorrelationResult | null> {
  try {
    return JSON.parse(await readFile(FILE, "utf-8")) as CorrelationResult;
  } catch {
    return null;
  }
}
