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
  /**
   * **실제로 견준 두 날** (2026-08-31).
   *
   * 「4일 경과」라고 적으면서 속으로는 8/27→8/28 하루치를 재고 있었다. 주말·휴장이
   * 끼면 달력 날수와 거래일 수가 벌어지는데, 화면이 달력 날수만 말하면 읽는 사람은
   * 나흘치 결과로 읽는다. 무엇과 무엇을 견줬는지 그대로 적는다.
   */
  baseDate?: string;
  lastDate?: string;
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
 * 지수 일봉 (`ka20006`).
 *
 * **지수를 100배로 준다** — 686983 이 6,869.83 이다. 등락률만 쓰므로 배율이 상쇄되긴
 * 하지만, 나중에 값을 그대로 쓰게 될 때를 대비해 여기서 나눠 둔다.
 */
async function indexCloses(
  client: KiwoomClient,
  indsCode: string,
): Promise<{ date: string; close: number }[]> {
  const { data } = await client.request<{ inds_dt_pole_qry?: Record<string, unknown>[] }>(
    "/api/dostk/chart",
    "ka20006",
    { inds_cd: indsCode, base_dt: ymd(new Date()) },
  );
  const rows = Array.isArray(data.inds_dt_pole_qry) ? data.inds_dt_pole_qry : [];
  return rows
    .map((r) => {
      const raw = String(r.dt ?? "");
      return {
        date: `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`,
        close: toNum(r.cur_prc) / 100,
      };
    })
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && r.close > 0);
}

/**
 * 발행일 이후의 등락률.
 * 발행일에 거래가 없었으면(주말·휴장) 그 **이전 가장 가까운 거래일**을 기준으로 삼는다.
 */
/**
 * **종가가 확정된 마지막 날** (YYYY-MM-DD, KST).
 *
 * 15:40 이전이면 오늘 종가는 아직 없다 — 그날은 채점에 쓸 수 없다. 주말·휴일은
 * 애초에 봉이 없으니 걸러진다(있어도 하루 뒤로 밀릴 뿐 해가 없다).
 */
function lastClosedDay(): string {
  const kst = new Date(Date.now() + 9 * 3600_000);
  const closed = kst.getUTCHours() > 15 || (kst.getUTCHours() === 15 && kst.getUTCMinutes() >= 40);
  if (!closed) kst.setUTCDate(kst.getUTCDate() - 1);
  return kst.toISOString().slice(0, 10);
}

function changeSince(rows: { date: string; close: number }[], from: string): {
  base: number | null;
  last: number | null;
  rate: number | null;
  baseDate?: string;
  lastDate?: string;
} {
  if (rows.length === 0) return { base: null, last: null, rate: null };
  /*
   * ⚠️ **종가가 아직 안 나온 날은 빼고 센다** (2026-08-31).
   *
   * 키움 일봉은 **장 전에도 오늘 봉을 준다.** 그 봉의 「종가」는 아직 종가가 아니고
   * 흔히 전일 종가와 같은 값이 온다. 그대로 채점하면 기준일과 채점일이 **다른
   * 날인데 등락이 정확히 0%** 로 나오고, ±1% 안이라 「부분 적중」으로 세어진다.
   *
   * 실측: 8/29(토) 발행분을 「2일 경과」로 채점했더니 다섯 항목이 **전부 0% ·
   * 부분 적중**이었다. 거래일은 하루도 안 지났는데 채점이 끝난 것처럼 보였다 —
   * 이대로면 적중률이 통째로 거짓말이 된다.
   */
  const asc = [...rows].sort((a, b) => a.date.localeCompare(b.date)).filter((r) => r.date <= lastClosedDay());
  if (asc.length === 0) return { base: null, last: null, rate: null };
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
    baseDate: baseRow.date,
    lastDate: lastRow.date,
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
    let baseDate: string | undefined;
    let lastDate: string | undefined;

    try {
      if (cp.kind === "stock") {
        const r = changeSince(await dailyCloses(client, cp.key), date);
        base = r.base;
        last = r.last;
        rate = r.rate;
        baseDate = r.baseDate;
        lastDate = r.lastDate;
      } else if (cp.kind === "theme") {
        const t = themes.find((x) => x.name === cp.key);
        /*
         * 「내 테마」에 없는 이름이면 채점할 방법이 없다. 예전엔 조용히 넘어가서
         * **영원히 "대기"** 로 남았다 — 며칠이 지나도 안 바뀌니 화면만 차지했다.
         * 채점 불가는 대기와 다르다. 그렇게 밝힌다.
         */
        if (!t) {
          items.push({
            ...cp,
            basePrice: null,
            lastPrice: null,
            actual: null,
            verdict: "unknown",
            note: `「내 테마」에 «${cp.key}» 가 없어 채점할 수 없습니다`,
          });
          continue;
        }
        {
          const rates: number[] = [];
          // 테마 하나에 열 종목이면 열 번 조회다. 초당 5회 제한을 지킨다
          for (const code of t.codes.slice(0, 10)) {
            const r = changeSince(await dailyCloses(client, code), date);
            if (r.rate !== null) {
              rates.push(r.rate);
              baseDate ??= r.baseDate;
              lastDate ??= r.lastDate;
            }
            await new Promise((x) => setTimeout(x, 220));
          }
          if (rates.length > 0) rate = rates.reduce((a, b) => a + b, 0) / rates.length;
        }
      } else {
        /*
         * 시장 — **업종일봉(`ka20006`)** 을 쓴다.
         *
         * 예전엔 ETF(069500·229200)를 지수 대용으로 삼았는데 그게 틀렸다.
         * 069500 은 하루 등락폭이 20% 씩 벌어지고 회전율이 17% 나 되는 날이 있어
         * 지수와 전혀 다른 값이 나온다 — 지수가 -1% 인 날 대용치는 -8% 였다.
         * 지수 채점을 지수가 아닌 것으로 하고 있었던 셈이다.
         */
        const idxCode = cp.key.toUpperCase().includes("KOSDAQ") ? "101" : "001";
        const r = changeSince(await indexCloses(client, idxCode), date);
        base = r.base;
        last = r.last;
        rate = r.rate;
        baseDate = r.baseDate;
        lastDate = r.lastDate;
      }
    } catch {
      // 한 항목 실패가 전체 채점을 막지 않게
    }

    const { verdict, note } = judge(cp.direction, rate);
    items.push({ ...cp, basePrice: base, lastPrice: last, actual: rate, verdict, note, baseDate, lastDate });
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
/**
 * 복기할 수 있는 리포트 목록.
 *
 * **「즉시 발행」은 뺀다.** 저장된 28건 중 14건이 `now-` 였는데, 그건 개발하며 눌러 본
 * 것이라 복기 대상이 아니다. 목록의 절반이 테스트로 차 있으면 정작 볼 것을 못 찾는다.
 *
 * 정기 발행(조간·장중·석간·주말)만 남기면 하루 3~4건이라 **한 달치가 100건 안쪽**이다.
 */
export async function listReviewable(limit = 30): Promise<
  {
    date: string;
    edition: string;
    label: string;
    publishedAt: string;
    count: number;
    elapsedDays: number;
  }[]
> {
  const rows = await listReports(limit * 2);
  const out: {
    date: string;
    edition: string;
    label: string;
    publishedAt: string;
    count: number;
    elapsedDays: number;
  }[] = [];
  for (const r of rows) {
    // `now-HHMM` 은 즉시 발행이다. 정기 판은 morning/intraday/closing/weekend
    if (r.edition.startsWith("now")) continue;
    const full = await loadReport(r.date, r.edition);
    const n = full?.summary.checkpoints?.length ?? 0;
    if (n > 0 && full) {
      out.push({
        date: full.date,
        edition: full.edition,
        label: full.label,
        publishedAt: full.publishedAt,
        count: n,
        /*
         * 경과일을 목록에도 실어 보낸다.
         *
         * 화면이 「채점할 수 있는 것 중 가장 최근」을 고르려면 이게 있어야 한다.
         * 예전엔 화면이 `날짜 < 오늘` 로 어림잡았는데, 그건 **오늘 발행분을 고르는 걸 막을 뿐**
         * 채점 가능한지는 말해 주지 않는다. 실제로 복기를 열면 늘 「대기」만 보였다.
         * 채점 쪽과 같은 식을 쓴다 — 두 곳이 다르면 목록과 결과가 어긋난다.
         */
        elapsedDays: Math.max(
          0,
          Math.round((Date.now() - new Date(full.publishedAt).getTime()) / 86400_000),
        ),
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}
