import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "leaderScan.json");

/**
 * 주도주 탐색기 성적 — **「그때 뽑은 게 그 뒤 어떻게 됐나」.**
 *
 * 탐색기는 매일 「오늘 반응하는 섹터·종목」을 골라 놓는다. 그런데 **고르는 것만으로는
 * 눈이 안 자란다.** 골라 놓고 결과를 안 보면, 맞은 것만 기억하고 틀린 것은 잊는다.
 *
 * ## 이 화면이 답하려는 것
 *
 * 「탐색기가 맞나」가 아니다. 그것도 보지만 진짜 물음은 이쪽이다 —
 *
 *   **나는 어떤 종류의 신호를 잘 고르나?**
 *
 * 신고가로 걸린 것과 거래량 급증으로 걸린 것은 성격이 완전히 다르다. 어느 쪽이
 * 내 손에 맞는지는 **세어 봐야** 안다. 그래서 태그별로 갈라서 센다 —
 * 이게 이 모듈의 핵심이고, 탐색기가 태그를 남긴 이유다.
 *
 * 섹터도 같이 본다. **그때 강했던 섹터가 그 뒤에도 강했나** — 그게 「주도 섹터」와
 * 「하루 반짝」을 가르는 사후 검증이다.
 *
 * 거래일로 센다. 달력으로 세면 주말·휴장이 섞여 종목마다 기준이 달라진다.
 * ([[signalTrack]] · [[tradeTrack]] 이 같은 이유로 같은 방식을 쓴다)
 */

export const HORIZONS = [1, 5, 20, 60] as const;
export type Horizon = (typeof HORIZONS)[number];

interface Pick {
  code: string;
  name: string;
  sector: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  tags: string[];
}

interface DayRecord {
  date: string;
  sectors: Record<string, string[]>;
  picks?: Pick[];
}

export interface Outcome {
  days: Horizon;
  price: number;
  /** 편입가 대비(%) */
  rate: number;
}

export interface TrackedPick extends Pick {
  date: string;
  outcomes: Outcome[];
}

export interface GroupStat {
  key: string;
  n: number;
  byHorizon: {
    days: Horizon;
    n: number;
    /** 오른 비율(%) */
    winRate: number;
    avg: number;
    /** 몇 종목이 크게 튀면 평균이 거짓말을 한다 */
    median: number;
    best: number;
    worst: number;
  }[];
}

export interface LeaderTrackResult {
  picks: TrackedPick[];
  /** 태그별 — **이 화면의 본론.** 내가 어떤 신호를 잘 고르는지 */
  byTag: GroupStat[];
  /** 섹터별 — 그때 강했던 섹터가 그 뒤에도 강했나 */
  bySector: GroupStat[];
  /** 전체 */
  overall: GroupStat;
  days: number;
  codes: number;
  failed: number;
  note: string;
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

function stat(key: string, rows: { days: Horizon; rate: number }[]): GroupStat {
  const byHorizon = HORIZONS.map((h) => {
    const rates = rows.filter((r) => r.days === h).map((r) => r.rate);
    if (rates.length === 0) {
      return { days: h, n: 0, winRate: 0, avg: 0, median: 0, best: 0, worst: 0 };
    }
    return {
      days: h,
      n: rates.length,
      winRate: (rates.filter((r) => r > 0).length / rates.length) * 100,
      avg: rates.reduce((a, b) => a + b, 0) / rates.length,
      median: median(rates),
      best: Math.max(...rates),
      worst: Math.min(...rates),
    };
  });
  // n 은 「몇 건을 담았나」다. 1일 기준이 가장 많이 채워지므로 그걸 쓴다
  return { key, n: byHorizon[0].n, byHorizon };
}

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

export async function leaderTrack(client: KiwoomClient): Promise<LeaderTrackResult> {
  let days: DayRecord[] = [];
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as { days?: DayRecord[] };
    days = Array.isArray(raw.days) ? raw.days : [];
  } catch {
    days = [];
  }

  /*
   * **오늘 것은 안 센다.** 편입 당일은 결과가 없다 —
   * 결과는 다음 거래일부터다. 넣어 두면 「1일 성적」이 0% 로 희석된다.
   */
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const usable = days.filter((d) => d.date < today && (d.picks?.length ?? 0) > 0);

  const flat: { date: string; pick: Pick }[] = [];
  for (const d of usable) for (const p of d.picks ?? []) if (p.price > 0) flat.push({ date: d.date, pick: p });

  const codes = [...new Set(flat.map((f) => f.pick.code))];
  const charts = new Map<string, { date: string; close: number }[]>();
  let failed = 0;
  for (const code of codes) {
    const rows = await dailyCloses(client, code).catch(() => []);
    if (rows.length > 0) charts.set(code, rows);
    else failed += 1;
    // 신호등 하나가 여러 TR 을 부르는 스캐너와 같은 간격 — 키움은 TR 당 초당 5건이다
    await new Promise((r) => setTimeout(r, 260));
  }

  const picks: TrackedPick[] = [];
  const tagRows = new Map<string, { days: Horizon; rate: number }[]>();
  const secRows = new Map<string, { days: Horizon; rate: number }[]>();
  const allRows: { days: Horizon; rate: number }[] = [];

  for (const { date, pick } of flat) {
    const rows = charts.get(pick.code);
    const outcomes: Outcome[] = [];
    if (rows) {
      const ymd = date.replace(/-/g, "");
      // 편입일 **이후** 첫 봉부터. 당일 봉은 0일째라 결과가 아니다
      const start = rows.findIndex((r) => r.date > ymd);
      if (start >= 0) {
        for (const h of HORIZONS) {
          const row = rows[start + h - 1];
          if (!row) break; // 아직 그만큼 지나지 않았다
          const rate = ((row.close - pick.price) / pick.price) * 100;
          outcomes.push({ days: h, price: row.close, rate });
          allRows.push({ days: h, rate });
          for (const t of pick.tags) {
            if (!tagRows.has(t)) tagRows.set(t, []);
            tagRows.get(t)!.push({ days: h, rate });
          }
          if (pick.sector) {
            if (!secRows.has(pick.sector)) secRows.set(pick.sector, []);
            secRows.get(pick.sector)!.push({ days: h, rate });
          }
        }
      }
    }
    picks.push({ ...pick, date, outcomes });
  }

  return {
    picks: picks.sort((a, b) => b.date.localeCompare(a.date)),
    byTag: [...tagRows.entries()]
      .map(([k, v]) => stat(k, v))
      .sort((a, b) => b.n - a.n),
    bySector: [...secRows.entries()]
      .map(([k, v]) => stat(k, v))
      .filter((s) => s.n >= 2)
      .sort((a, b) => b.n - a.n),
    overall: stat("전체", allRows),
    days: usable.length,
    codes: codes.length,
    failed,
    note:
      usable.length === 0
        ? "아직 결과를 볼 기록이 없습니다. 편입 다음 거래일부터 채워집니다."
        : `${usable.length}일치 · ${codes.length}종목을 따라갑니다.`,
  };
}
