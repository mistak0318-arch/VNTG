import type { KiwoomClient } from "./kiwoomClient.js";
import { brokerFlow } from "./brokerFlow.js";
import { listWatchlist } from "./watchlist.js";
import { getScreenRun, listScreenRuns } from "./signalScreen.js";

/**
 * **장중 거래원 시계열 자동 수집** (2026-09-01).
 *
 * 벤티지: "종목 클릭하면 나오는 종목상세에 일별 수급 그래프 그려놨잖아. 그거 한번
 * 클릭해야 동작한다고 써있던데. 그냥 모든 종목 받아오면 안되 이것도?"
 * (뒤에 정정: "당일 장중 수급 그래프 의미한거야")
 *
 * ## 왜 클릭해야 동작했나
 *
 * `ka10040`(당일주요거래원)은 **지금까지의 누적**만 준다. 시간대별을 주는 TR 이
 * 없어서, `brokerFlow()` 를 부를 때마다 **한 점씩 찍어** 시계열을 만든다. 그런데
 * 그걸 부르는 것이 화면과 알림뿐이라 — **내가 열어 둔 종목만** 쌓였다.
 *
 * ## 전종목은 물리적으로 안 된다
 *
 * 종목당 1콜이고 키움은 **초당 5회**다.
 *
 *   30초 주기 × 2,444종목 = 초당 **81콜** (제한의 16배)
 *   5분 주기 × 2,444종목 = 초당 **8콜** (여전히 초과)
 *   10분 주기 × 2,444종목 = 초당 4콜 — 되긴 하지만 **장중 내내 다른 조회를 전부
 *   막는다.** 신호등·시세분석·알림이 다 멈춘다
 *
 * 그래서 전종목이 아니라 **볼 만한 종목**을 자동으로 고른다.
 *
 * ## 예산 — 초당 1콜만 쓴다
 *
 * 제한의 20%다. 나머지는 신호등·시세분석·알림 몫으로 남긴다. 1초에 한 종목씩
 * 도니까 대상이 80종목이면 **한 바퀴가 80초**다 — 거래원 누적은 그 정도 간격이면
 * 흐름을 잃지 않는다(화면이 열려 있을 때 쓰는 주기가 30초다).
 *
 * ## 무엇을 고르나
 *
 *   ① 관심종목 — 내가 담아 둔 것. 가장 우선이다
 *   ② 오늘 신호등 찾기에서 **초록**으로 걸린 종목
 *
 * ①이 상한을 넘으면 ②는 안 넣는다. 「내가 보는 것」이 먼저다.
 */

/** 한 바퀴에 쓸 상한 — 초당 1콜 × 80초 */
const MAX_CODES = 80;

/** 종목 하나 사이의 간격(ms) — 초당 1콜 */
const STEP_MS = 1000;

/** 대상 목록을 다시 세우는 주기 */
const REFRESH_MS = 5 * 60_000;

/** 장중인가 — 평일 09:00~15:30 KST */
function inSession(at = Date.now()): boolean {
  const d = new Date(at);
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  const day = kst.getDay();
  if (day === 0 || day === 6) return false;
  const m = kst.getHours() * 60 + kst.getMinutes();
  return m >= 9 * 60 && m <= 15 * 60 + 30;
}

let codes: string[] = [];
let at = 0;
let codesAt = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const stat = { rounds: 0, points: 0, fails: 0, lastAt: "" };

/** 무엇을 따라가고 있나 — 화면이 「지금 N종목을 자동으로 쌓는 중」이라고 말할 수 있게 */
export function brokerAutoStatus() {
  return {
    running: timer !== null,
    inSession: inSession(),
    codes: codes.length,
    max: MAX_CODES,
    ...stat,
  };
}

/**
 * 따라갈 종목을 세운다.
 *
 * ⚠️ 실패해도 예전 목록을 지우지 않는다 — 목록을 못 세웠다고 수집이 멈추면,
 * 그날 하루가 통째로 빈다. 「어제 목록으로라도 계속」이 낫다.
 */
async function buildCodes(): Promise<void> {
  try {
    const watch = await listWatchlist().catch(() => []);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const w of watch) {
      if (seen.has(w.code)) continue;
      seen.add(w.code);
      out.push(w.code);
    }

    /* 자리가 남으면 오늘 초록으로 걸린 종목을 채운다 */
    if (out.length < MAX_CODES) {
      const runs = await listScreenRuns().catch(() => []);
      const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      const latest = runs.find((r) => String(r.at ?? "").slice(0, 10) === today);
      if (latest) {
        const run = await getScreenRun(latest.id).catch(() => null);
        for (const h of run?.results ?? []) {
          if (out.length >= MAX_CODES) break;
          if (h.level !== "green" || seen.has(h.code)) continue;
          seen.add(h.code);
          out.push(h.code);
        }
      }
    }

    if (out.length > 0) codes = out.slice(0, MAX_CODES);
    codesAt = Date.now();
  } catch {
    /* 예전 목록으로 계속 돈다 */
  }
}

/**
 * 자동 수집을 시작한다. 장 밖에는 아무것도 안 부른다 — 타이머만 돈다.
 *
 * ⚠️ **한 번에 하나씩**이다. 한 바퀴를 몰아서 부르면 그 순간 키움 한도를 다 먹어
 * 다른 화면이 429 를 맞는다. 1초에 하나가 지루해 보여도 그게 맞다.
 */
export function startBrokerAuto(client: KiwoomClient): void {
  if (timer) return;
  timer = setInterval(() => {
    void (async () => {
      if (!inSession()) return;
      if (codes.length === 0 || Date.now() - codesAt > REFRESH_MS) await buildCodes();
      if (codes.length === 0) return;

      const code = codes[at % codes.length];
      if (at % codes.length === 0) stat.rounds += 1;
      at += 1;
      try {
        /* 부르는 것만으로 시계열에 한 점이 찍힌다 — 그게 이 TR 을 쌓는 유일한 길이다 */
        await brokerFlow(client, code);
        stat.points += 1;
        stat.lastAt = new Date().toISOString();
      } catch {
        stat.fails += 1;
      }
    })();
  }, STEP_MS);
  /* 서버 종료를 막지 않는다 */
  timer.unref?.();
}

export function stopBrokerAuto(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
