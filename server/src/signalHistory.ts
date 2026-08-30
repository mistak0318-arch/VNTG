import { appendFile, mkdir, readFile, readdir } from "node:fs/promises";
import { dropPhantomToday } from "./candleGuard.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 신호등 점수 축적 — **오늘 안 쌓으면 영영 못 쌓는다.**
 *
 * ## 왜 필요했나
 *
 * 조건 백테스트를 만들고 나니 **신호등 점수로는 못 돌린다**는 게 드러났다.
 * 신호등은 지금 시점만 계산할 수 있다 — 차트는 되짚을 수 있지만 그때의 수급·재무·
 * 목표주가는 되살릴 방법이 없다. 그래서 **「70점이 진짜 40점보다 나은가」**를
 * 물을 수가 없었다. 이 앱의 핵심 숫자인데 그것만 검증이 안 되는 상태였다.
 *
 * ## 추적기와 무엇이 다른가
 *
 * 추적기(`signalTrack`)는 **문턱을 넘은 것만** 담는다. 그건 「담은 것이 어땠나」를
 * 보는 자리다. 그런데 문턱의 값어치를 재려면 **떨어진 것도 있어야 한다** —
 * 70점이 좋았는지는 40점이 어땠는지를 알아야 말할 수 있다.
 *
 * ## 공짜다
 *
 * 추적기가 이미 모집단 전체를 평가하고 **문턱 아래는 버리고 있었다.** 버리기 전에
 * 한 줄 적는 것뿐이라 **조회가 0회 늘어난다.** 그래서 추적기가 도는 자리에 붙였다.
 *
 * ## 저장 방식
 *
 * 날짜별 JSONL 에 덧붙인다. 통째로 다시 쓰면 쓰는 도중에 서버가 죽었을 때 그날 것이
 * 통째로 날아간다 — 실시간 저장에서 같은 이유로 덧붙이기로 바꿨다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "signalHistory");

export interface SignalDayRow {
  code: string;
  name: string;
  score: number;
  level: string;
  /** 위험 축이 초록을 막았나 — 「그 차단이 옳았나」를 나중에 묻는다 */
  riskCapped: boolean;
  /** 그날 종가 */
  price: number;
}

/** 하루치를 덧붙인다. 실패해도 조용히 넘긴다 — 축적이 추적기를 막으면 안 된다 */
export async function appendSignalDay(date: string, rows: SignalDayRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    await mkdir(DIR, { recursive: true });
    await appendFile(
      join(DIR, `${date}.jsonl`),
      rows.map((r) => `${JSON.stringify(r)}\n`).join(""),
      "utf-8",
    );
  } catch {
    /* 쌓기 실패가 추적기를 죽이면 안 된다 */
  }
}

/** 쌓인 날짜들 — 최근 것부터 */
export async function signalDays(): Promise<string[]> {
  try {
    return (await readdir(DIR))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => f.replace(/\.jsonl$/, ""))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

/** 깨진 줄은 버린다 — 한 줄 때문에 그날치가 통째로 날아가면 안 된다 */
async function readDay(date: string): Promise<SignalDayRow[]> {
  try {
    const text = await readFile(join(DIR, `${date}.jsonl`), "utf-8");
    const out: SignalDayRow[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line) as SignalDayRow);
      } catch {
        /* 이 줄만 버린다 */
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * 백테스트용 점수 지도 — **날짜(YYYYMMDD) → 종목 → 점수** (2026-08-25).
 *
 * 「신호등 N점 이상」을 백테스트 조건으로 쓰려면 과거 점수가 있어야 하는데,
 * 그건 여기 쌓인 날만 있다(2026-08-25 축적 시작). 없는 날은 조건이 그냥
 * 안 걸린다 — 표본이 며칠치뿐이라는 걸 화면이 같이 말해야 한다.
 */
export async function signalScoreMap(): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  for (const d of await signalDays()) {
    const m = new Map<string, number>();
    for (const r of await readDay(d)) m.set(r.code, r.score);
    if (m.size > 0) out.set(d.replace(/-/g, ""), m); // 일봉 날짜 형식에 맞춘다
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 채점                                                                 */
/* ------------------------------------------------------------------ */

const CHART = "/api/dostk/chart";

/** 점수 구간 — 신호등 문턱(70·80·90)에 맞춰 가른다 */
const BANDS = [
  { key: "90+", min: 90, max: 101 },
  { key: "80-89", min: 80, max: 90 },
  { key: "70-79", min: 70, max: 80 },
  { key: "60-69", min: 60, max: 70 },
  { key: "~59", min: -1, max: 60 },
];

export interface BandStat {
  key: string;
  count: number;
  avg: number;
  median: number;
  winRate: number;
}

export interface SignalGrade {
  /** 며칠 뒤로 쟀나 (거래일) */
  days: number;
  /** 쓴 기록의 날짜 범위 */
  from: string;
  to: string;
  bands: BandStat[];
  /** 전체 평균 — 구간별 값은 이것과 견줘야 뜻이 생긴다 */
  all: BandStat;
  /** 채점한 종목 수 / 일봉을 못 받은 수 */
  codes: number;
  failed: number;
}

function num(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function stat(key: string, xs: number[]): BandStat {
  if (xs.length === 0) return { key, count: 0, avg: 0, median: 0, winRate: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return {
    key,
    count: xs.length,
    avg: xs.reduce((a, b) => a + b, 0) / xs.length,
    median: s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2,
    winRate: (xs.filter((x) => x > 0).length / xs.length) * 100,
  };
}

/**
 * **점수가 실제로 값어치가 있었나.**
 *
 * 쌓인 기록의 각 줄을 「그날 종가에 샀다면 N거래일 뒤 어땠나」로 채점해 점수 구간별로
 * 모은다. 전체 평균을 같이 내는 이유는 백테스트와 같다 — **구간별 숫자만 보면
 * 상승장에서는 어느 구간이든 좋아 보인다.**
 *
 * ⚠️ 종목당 일봉 한 번이다. 쌓인 종목이 많으면 몇 분 걸린다.
 */
export async function gradeSignalHistory(
  client: KiwoomClient,
  days = 5,
): Promise<SignalGrade | null> {
  const dates = (await signalDays()).slice().reverse();
  if (dates.length === 0) return null;

  /** 종목 → [그날, 그날 점수] */
  const byCode = new Map<string, { date: string; score: number }[]>();
  for (const d of dates) {
    for (const r of await readDay(d)) {
      const arr = byCode.get(r.code) ?? [];
      arr.push({ date: d.replace(/-/g, ""), score: r.score });
      byCode.set(r.code, arr);
    }
  }

  const buckets = new Map<string, number[]>();
  const all: number[] = [];
  let failed = 0;

  for (const [code, marks] of byCode) {
    let rows: { dt: string; close: number }[] = [];
    try {
      const d = new Date(Date.now() + 9 * 3600_000);
      const res = await client.request<Record<string, unknown>>(CHART, "ka10081", {
        stk_cd: code,
        base_dt: d.toISOString().slice(0, 10).replace(/-/g, ""),
        upd_stkpc_tp: "1",
      });
      rows = (dropPhantomToday((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]))
        .map((r) => ({ dt: String(r.dt ?? ""), close: num(r.cur_prc) }))
        .filter((r) => /^\d{8}$/.test(r.dt) && r.close > 0)
        .sort((a, b) => a.dt.localeCompare(b.dt));
    } catch {
      failed += 1;
    }
    await new Promise((r) => setTimeout(r, 260));
    if (rows.length === 0) continue;

    for (const m of marks) {
      const i = rows.findIndex((r) => r.dt === m.date);
      // 아직 N일이 안 지난 기록은 **세지 않는다** — 결과가 없는 걸 성적에 넣으면 안 된다
      if (i < 0 || i + days >= rows.length) continue;
      const rate = ((rows[i + days].close - rows[i].close) / rows[i].close) * 100;
      const band = BANDS.find((b) => m.score >= b.min && m.score < b.max);
      if (band) buckets.set(band.key, [...(buckets.get(band.key) ?? []), rate]);
      all.push(rate);
    }
  }

  return {
    days,
    from: dates[0],
    to: dates[dates.length - 1],
    bands: BANDS.map((b) => stat(b.key, buckets.get(b.key) ?? [])).filter((b) => b.count > 0),
    all: stat("전체", all),
    codes: byCode.size,
    failed,
  };
}
