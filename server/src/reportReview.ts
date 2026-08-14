import { listThemes } from "./customThemes.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { listReports, loadReport } from "./reportStore.js";
import type { Checkpoint, CheckDirection } from "./checkpoints.js";

/**
 * 체크포인트 채점 — 예측 → 결과 → 복기 루프의 두 번째 단계.
 *
 * **채점은 기계가 한다.** AI에게 지난 리포트를 다시 읽혀 판단시키면 비용이 들고
 * 무엇보다 부정확하다. 실제 등락은 숫자로 확인되는 것이므로 코드가 붙이는 게 맞다.
 *
 * 판정 기준은 느슨하게 잡았다. **±1% 안쪽은 중립**으로 본다 —
 * 0.2% 움직인 것을 "상승 적중"이라고 세면 적중률이 부풀려져 복기가 무의미해진다.
 */

const FLAT_BAND = 1.0;

export type Verdict = "hit" | "miss" | "partial" | "pending" | "unknown";

export interface ScoredCheckpoint extends Checkpoint {
  /** 발행일 종가 */
  basePrice: number | null;
  /** 채점일 종가 */
  lastPrice: number | null;
  /** 실제 등락률(%) */
  actual: number | null;
  verdict: Verdict;
  /** 왜 그렇게 판정했는지 (화면 설명용) */
  note: string;
}

export interface ReviewResult {
  date: string;
  edition: string;
  label: string;
  publishedAt: string;
  /** 며칠 뒤 결과인지 */
  elapsedDays: number;
  items: ScoredCheckpoint[];
  hit: number;
  miss: number;
  partial: number;
}

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? Math.abs(n) : 0;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

/** 일봉에서 (날짜 → 종가) — 최신순으로 온다 */
async function dailyCloses(
  client: KiwoomClient,
  code: string,
): Promise<{ date: string; close: number }[]> {
  const { data } = await client.request<{ stk_dt_pole_chart_qry?: Record<string, unknown>[] }>(
    "/api/dostk/chart",
    "ka10081",
    { stk_cd: code, base_dt: ymd(new Date()), upd_stkpc_tp: "1" },
  );
  const rows = Array.isArray(data.stk_dt_pole_chart_qry) ? data.stk_dt_pole_chart_qry : [];
  return rows
    .map((r) => {
      const raw = String(r.dt ?? "");
      return {
        date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
        close: toNum(r.cur_prc),
      };
    })
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.close > 0);
}

/**
 * 발행일 이후의 등락률.
 * 발행일에 거래가 없었으면(주말·휴장) 그 **이전 가장 가까운 거래일**을 기준으로 삼는다.
 */
function changeSince(rows: { date: string; close: number }[], from: string): {
  base: number | null;
  last: number | null;
  rate: number | null;
} {
  if (rows.length === 0) return { base: null, last: null, rate: null };
  const asc = [...rows].sort((a, b) => a.date.localeCompare(b.date));
  // 발행일 이하 중 가장 늦은 날
  const baseRow = [...asc].reverse().find((r) => r.date <= from);
  const lastRow = asc[asc.length - 1];
  if (!baseRow || !lastRow || baseRow.date === lastRow.date) {
    return { base: baseRow?.close ?? null, last: lastRow?.close ?? null, rate: null };
  }
  return {
    base: baseRow.close,
    last: lastRow.close,
    rate: ((lastRow.close - baseRow.close) / baseRow.close) * 100,
  };
}

function judge(direction: CheckDirection, actual: number | null): { verdict: Verdict; note: string } {
  if (actual === null) return { verdict: "pending", note: "아직 비교할 거래일이 없습니다" };

  const moved = Math.abs(actual) >= FLAT_BAND;
  const actualDir: CheckDirection = !moved ? "flat" : actual > 0 ? "up" : "down";

  if (direction === actualDir) {
    return {
      verdict: "hit",
      note: direction === "flat" ? `±${FLAT_BAND}% 안에서 머물렀습니다` : "방향이 맞았습니다",
    };
  }
  // 상승/하락을 봤는데 실제로는 거의 안 움직인 경우 — 완전히 틀렸다고 보긴 어렵다
  if (actualDir === "flat") {
    return { verdict: "partial", note: `방향은 맞히지 못했지만 움직임이 ±${FLAT_BAND}% 안이었습니다` };
  }
  if (direction === "flat") {
    return { verdict: "partial", note: "중립으로 봤으나 실제로는 크게 움직였습니다" };
  }
  return { verdict: "miss", note: "방향이 반대였습니다" };
}

/**
 * 한 리포트의 체크포인트를 채점한다.
 *
 * 테마는 구성종목 일봉을 모아 **단순평균**으로 낸다 — 과거 시총을 알 수 없어
 * 오늘 시총으로 가중하면 미래 정보를 끌어다 쓰는 셈이 된다 (usKrCorrelation 과 같은 이유).
 */
export async function reviewReport(
  client: KiwoomClient,
  date: string,
  edition: string,
): Promise<ReviewResult | null> {
  const report = await loadReport(date, edition);
  if (!report?.summary.checkpoints?.length) return null;

  const themes = await listThemes().catch(() => []);
  const items: ScoredCheckpoint[] = [];

  for (const cp of report.summary.checkpoints) {
    let base: number | null = null;
    let last: number | null = null;
    let rate: number | null = null;

    try {
      if (cp.kind === "stock") {
        const r = changeSince(await dailyCloses(client, cp.key), date);
        base = r.base;
        last = r.last;
        rate = r.rate;
      } else if (cp.kind === "theme") {
        const t = themes.find((x) => x.name === cp.key);
        if (t) {
          const rates: number[] = [];
          // 테마 하나에 열 종목이면 열 번 조회다. 초당 5회 제한을 지킨다
          for (const code of t.codes.slice(0, 10)) {
            const r = changeSince(await dailyCloses(client, code), date);
            if (r.rate !== null) rates.push(r.rate);
            await new Promise((x) => setTimeout(x, 220));
          }
          if (rates.length > 0) rate = rates.reduce((a, b) => a + b, 0) / rates.length;
        }
      } else {
        // 시장 — 지수를 대표하는 ETF 로 대신한다 (키움이 지수 일봉을 종목처럼 주지 않아서)
        const proxy = cp.key.toUpperCase().includes("KOSDAQ") ? "229200" : "069500";
        const r = changeSince(await dailyCloses(client, proxy), date);
        base = r.base;
        last = r.last;
        rate = r.rate;
      }
    } catch {
      // 한 항목 실패가 전체 채점을 막지 않게
    }

    const { verdict, note } = judge(cp.direction, rate);
    items.push({ ...cp, basePrice: base, lastPrice: last, actual: rate, verdict, note });
  }

  const elapsedDays = Math.max(
    0,
    Math.round((Date.now() - new Date(report.publishedAt).getTime()) / 86400_000),
  );

  return {
    date: report.date,
    edition: report.edition,
    label: report.label,
    publishedAt: report.publishedAt,
    elapsedDays,
    items,
    hit: items.filter((i) => i.verdict === "hit").length,
    miss: items.filter((i) => i.verdict === "miss").length,
    partial: items.filter((i) => i.verdict === "partial").length,
  };
}

/** 체크포인트가 있는 리포트 목록 — 복기 화면이 고를 수 있도록 */
export async function listReviewable(limit = 30): Promise<
  { date: string; edition: string; label: string; publishedAt: string; count: number }[]
> {
  const rows = await listReports(limit);
  const out: { date: string; edition: string; label: string; publishedAt: string; count: number }[] = [];
  for (const r of rows) {
    const full = await loadReport(r.date, r.edition);
    const n = full?.summary.checkpoints?.length ?? 0;
    if (n > 0 && full) {
      out.push({
        date: full.date,
        edition: full.edition,
        label: full.label,
        publishedAt: full.publishedAt,
        count: n,
      });
    }
  }
  return out;
}
