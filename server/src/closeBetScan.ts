import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { evaluateSignal } from "./signalLight.js";
import { fetchUniverse } from "./signalScreen.js";
import { enabledUniverses } from "./universeConfig.js";
import { MIN, afterMarketEra } from "./marketHours.js";
import { isTradingDay } from "./tradingDay.js";
import { getCisConfig } from "./cisConfig.js";
import { loadDay } from "./cisJournal.js";

/**
 * **종배 스캔 — 15:40 에 오늘 초록을 따로 잰다** (2026-09-15).
 *
 * 벤티지: "투두리스트 … 네가 지금 급하다고 한 거 있지 그거는 지금 하자."
 *
 * ## 왜 따로 재나
 *
 * 종배 계좌는 **오늘 신호등 분석 원장의 초록**에서 후보를 뽑는다(`cisCloseBet` ③). 9/13 까지는
 * 마감 뒤 정리가 15:40 에 돌아 원장이 16:30 무렵 쌓였고, 종배는 17:00 에 NXT 애프터에서 샀다.
 *
 * 9/14 부터 마감 뒤 정리가 **20:10** 으로 옮겨갔다(벤티지 09-10 "마감정리를 차라리 8시 10분에") —
 * 애프터마켓이 20:00 에 끝나야 그날 일봉이 굳기 때문이다. 그런데 애프터도 20:00 에 닫힌다.
 * **원장이 쌓일 때는 살 시장이 없다.** 스케줄러는 19:30 마감선에서 「오늘 원장이 없어 종배 안 함」을
 * 적고 끝났다 — 9/14 부터 종배는 **한 주도 안 샀다.**
 *
 * ## 원장을 한 번 더 돌리지 않는 이유
 *
 * 신호등 분석(`runListTrack`)을 15:40 에 한 번 더 돌리면 같은 날 두 번 편입된다 — 이어진 날
 * (`seenCount`)이 하루에 둘씩 늘고, 편입가가 두 번 적힌다. 12월에 문턱을 정할 원장이 흐려진다.
 * 그래서 **같은 목록·같은 신호등으로 초록만 재고, 원장엔 한 글자도 안 쓴다.** 결과는 이 파일
 * 하나(`data/closeBetScan.json`, 오늘 것만)다.
 *
 * ## 왜 15:40 인가
 *
 * 15:30~16:00 은 **KRX 가** 안 연다(애프터는 16:00 부터 — NXT 는 이때도 돌 수 있다). 신호등이 보는 일봉은
 * KRX 것이라, 이 사이에 재면 오늘 일봉이 **정규장만으로** 굳어 있다 — 신호등 표본·원장이 쓰는
 * 「정규장 종가」와 같은 자다. (2026-09-15 점검에서 「어느 시장도 안 연다」를 바로잡음) 한 바퀴 15분 안팎이라 16:00 전후에 끝나고,
 * 종배는 17:00(`eveningAt`)에 애프터 값으로 산다. 옛 흐름(15:40 원장 → 17:00 종배)과 같은 박자다.
 *
 * 수급 칸(`flow-*` 목록)은 원장 파일을 읽으므로 **어제까지의 수급**이다 — 그 목록들은 여러 날
 * 누적이라 하루 빠진 차이만 난다. 대신 종배는 뽑은 뒤 종목마다 신호등을 **다시 재고**(오늘 수급
 * TR 포함) 수급 축 50 을 따로 본다.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const FILE = resolve(__dirname, "..", "data", "closeBetScan.json");

export interface CloseBetScanRow {
  code: string;
  name: string;
  /** 목록이 준 가격 — 스냅샷을 못 읽을 때만 쓴다 */
  price: number;
  score: number;
  /** 몇 개 목록에 걸렸나 */
  lists: number;
}

export interface CloseBetScan {
  date: string;
  startedAt: string;
  finishedAt: string;
  /** 목록 수 · 합집합 종목 수 */
  lists: number;
  universe: number;
  green: CloseBetScanRow[];
}

interface Job {
  status: "idle" | "running" | "done" | "error";
  done: number;
  total: number;
  error?: string;
}

let job: Job = { status: "idle", done: 0, total: 0 };
export const closeBetScanJob = (): Job => job;

function kstNow(): { date: string; min: number } {
  const d = new Date(Date.now() + 9 * 3600_000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

export async function loadCloseBetScan(): Promise<CloseBetScan | null> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as CloseBetScan;
    return raw && typeof raw.date === "string" && Array.isArray(raw.green) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * health.json 한 칸 — 개수와 시각뿐. 종목은 싣지 않는다.
 *
 * **종배 저녁 일지도 같이** (2026-09-15 점검 — 17:00 종배가 스캔으로 샀는지를 밖에서 볼 길이 없었다).
 * 썼는지·시장 문·후보 수·한 일 수만. 모의 장부라 계좌 값은 아니지만 종목 이름은 여기서도 안 싣는다.
 */
export async function closeBetScanHealth(): Promise<Record<string, unknown>> {
  const s = await loadCloseBetScan();
  const hm = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(11, 16);
  const today = kstNow().date;
  const ev = (await loadDay(today, "close").catch(() => null))?.evening ?? null;
  return {
    진행: job.status === "running" ? `${job.done}/${job.total}` : job.status,
    ...(job.error ? { 오류: job.error } : {}),
    마지막: s ? { day: s.date, 시작: hm(s.startedAt), 끝: hm(s.finishedAt), 목록: s.lists, 합집합: s.universe, 초록: s.green.length } : null,
    종배저녁: ev
      ? {
          썼다: hm(ev.at),
          시장문: ev.market ? (ev.market.ok ? "열림" : "닫힘") : "모름",
          사유: String(ev.market?.reason ?? "").slice(0, 90),
          후보: ev.candidates.length,
          한일: ev.actions.length,
        }
      : "아직 안 씀",
  };
}

/** 오늘 스캔이 끝났나 — 종배 스케줄러가 1분마다 묻는다 */
export async function closeBetScanDate(): Promise<string | null> {
  return (await loadCloseBetScan())?.date ?? null;
}

export async function runCloseBetScan(client: KiwoomClient): Promise<CloseBetScan> {
  if (job.status === "running") throw new Error("종배 스캔이 이미 돌고 있다");
  const startedAt = new Date().toISOString();
  const date = kstNow().date;
  job = { status: "running", done: 0, total: 0 };
  try {
    const lists = await enabledUniverses();
    job.total = lists.length;
    /* 목록은 신호등 분석과 같은 것·같은 길이(500) — 원장과 같은 세계에서 고른다 */
    const union = new Map<string, { name: string; price: number; lists: number }>();
    for (const u of lists) {
      try {
        const rows = await fetchUniverse(client, u.key, "000", 500, u.span);
        for (const r of rows) {
          const had = union.get(r.code);
          if (had) had.lists += 1;
          else union.set(r.code, { name: r.name, price: r.price, lists: 1 });
        }
      } catch {
        /* 한 목록이 실패해도 나머지로 간다 */
      }
      job.done += 1;
      await new Promise((r) => setTimeout(r, 400));
    }

    job.done = 0;
    job.total = union.size;
    const green: CloseBetScanRow[] = [];
    for (const [code, u] of union) {
      try {
        const sig = await evaluateSignal(client, code);
        if (sig.level === "green") green.push({ code, name: u.name, price: u.price, score: sig.score, lists: u.lists });
      } catch {
        /* 이 종목만 건너뛴다 */
      }
      job.done += 1;
      /* 초당 5회 제한 — 신호등 평가는 종목당 여러 조회다 (`runListTrack` 과 같은 간격) */
      await new Promise((r) => setTimeout(r, 220));
    }
    green.sort((a, b) => b.score - a.score);

    const out: CloseBetScan = {
      date,
      startedAt,
      finishedAt: new Date().toISOString(),
      lists: lists.length,
      universe: union.size,
      green,
    };
    await mkdir(dirname(FILE), { recursive: true });
    await writeFile(FILE, JSON.stringify(out), "utf-8");
    job = { status: "done", done: union.size, total: union.size };
    console.log(`[종배 스캔] ${date} 목록 ${lists.length} · 합집합 ${union.size} → 초록 ${green.length}`);
    return out;
  } catch (e) {
    job = { ...job, status: "error", error: e instanceof Error ? e.message : String(e) };
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* 스케줄러 — 애프터마켓 시대의 거래일 15:40~20:00, 하루 한 번              */
/* ------------------------------------------------------------------ */

let timer: ReturnType<typeof setInterval> | null = null;
/** 오늘 실패 횟수 — 세 번이면 그만둔다(1분마다 15분짜리를 다시 때리지 않게) */
let fails: { date: string; n: number; at: number } = { date: "", n: 0, at: 0 };

async function tick(client: KiwoomClient): Promise<void> {
  const { date, min } = kstNow();
  if (!afterMarketEra(date) || !isTradingDay()) return;
  /* 15:40 부터 — 정규장 종가가 굳고 10분. 20:00 을 넘기면 살 시장이 없으니 잴 이유도 없다 */
  if (min < MIN.regularClose + 10 || min >= MIN.afterClose) return;
  if (job.status === "running") return;
  const cfg = await getCisConfig();
  if (!cfg.enabled || !cfg.auto) return; // 종배를 안 돌리는 날 15분치 조회를 태우지 않는다
  if ((await closeBetScanDate()) === date) return;
  if (fails.date === date && (fails.n >= 3 || Date.now() - fails.at < 5 * 60_000)) return;
  try {
    await runCloseBetScan(client);
  } catch (e) {
    fails = { date, n: (fails.date === date ? fails.n : 0) + 1, at: Date.now() };
    console.warn(`[종배 스캔] 실패 ${fails.n}/3: ${e instanceof Error ? e.message : e}`);
  }
}

export function startCloseBetScanScheduler(client: KiwoomClient): void {
  if (timer) return;
  void tick(client);
  timer = setInterval(() => void tick(client), 60_000);
  timer.unref?.();
}
