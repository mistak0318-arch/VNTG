import type { KiwoomClient } from "./kiwoomClient.js";
import { regimeCheck, regimeConfig } from "./regimeWatch.js";
import { pushNotice } from "./notifyCenter.js";
import { backtestProgress, startBacktestJob } from "./signalBacktest.js";
import { samplesMeta } from "./signalSamples.js";
import { runListTrack } from "./listTrack.js";
import { simulate } from "./signalSimulate.js";
import { getConfig } from "./signalLight.js";
import { tradeValueTop } from "./signalScreen.js";

/**
 * 장세 점검 스케줄러 (2026-08-31).
 *
 * ## 왜 만들었나
 *
 * `RegimeConfig.enabled` 를 「매일 저절로 잰다」로 만들어 놓고 **실제로 도는 곳을
 * 안 붙였다.** 화면에서 눌러야만 돌았다 — 설정이 아무 일도 안 하고 있었던 셈이다.
 *
 * 그리고 벤티지 요청: "알림을 주는데 알아서 신호등 돌리면 안되? 내가 놓칠수도
 * 있으니깐." 맞는 말이다. 알림만 주면 못 보면 그만이고, 표본은 계속 낡는다.
 *
 * ## 언제 도나
 *
 *   16:10  장세 점검 — 종가가 확정된 뒤다. 걸리면 🔔 알림
 *   18:30  표본 자동 재수집 — 오래됐을 때만. 장이 끝나 조회가 한가한 시간
 *
 * 슈퍼신호등(15:45)·CIS(15:45)와 **겹치지 않게** 뒤로 뺐다. 백테스트는 조회를
 * 3,500번쯤 쓰므로 다른 자동 작업과 부딪히면 둘 다 느려진다.
 *
 * ## ⚠️ 한 행동에 대해 충분히 알린다
 *
 * "한 행동에 대해서 나한테 충분한 정보를 주는 구조로 해줘. 점점 방대해지고
 * 있으니깐."
 *
 * 저절로 도는 것이 늘수록 **「왜 이게 일어났지」를 모르면 통제를 잃는다.**
 * 그래서 이 스케줄러가 만드는 알림은 네 가지를 다 담는다:
 *
 *   ① 무엇을 했나
 *   ② 왜 했나 (어떤 판정·문턱 때문에)
 *   ③ 결과가 어땠나 (숫자로)
 *   ④ 그래서 무엇을 보면 되나 (누르면 갈 자리)
 *
 * 「표본을 새로 모았습니다」만 있으면 그건 통보지 정보가 아니다.
 */

const TICK_MS = 60_000;

let timer: ReturnType<typeof setInterval> | null = null;
/** 오늘 이미 한 일 — 하루 한 번씩만 */
let doneCheck = "";
let doneRebuild = "";
let doneList = "";
let rebuilding = false;

function kst(now = new Date()): Date {
  return new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
}

const hhmm = (d: Date): string =>
  `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

const ymd = (d: Date): string => d.toISOString().slice(0, 10);

/** 평일인가 — 주말엔 종가가 안 바뀌므로 잴 것도 없다 */
function isWeekday(d: Date): boolean {
  const w = d.getDay();
  return w !== 0 && w !== 6;
}

/**
 * 표본을 다시 모으고, **끝나면 결과를 알림에 담는다.**
 *
 * 백테스트는 백그라운드로 돌므로 여기서 기다렸다가 시뮬레이터까지 돌려
 * 「지금 설정이 새 표본에서도 통하나」를 함께 적는다 — 그게 재수집의 목적이다.
 * 표본만 새로 모아 두고 아무 말도 안 하면 사람이 또 눌러 봐야 한다.
 */
async function rebuildAndReport(client: KiwoomClient, why: string): Promise<void> {
  if (rebuilding || backtestProgress().running) return;
  rebuilding = true;
  try {
    const top = await tradeValueTop(client, "000", 500);
    const codes = top.map((t) => ({ code: t.code, name: t.name }));
    if (codes.length === 0) return;

    await pushNotice({
      kind: "system",
      level: "info",
      title: "표본을 새로 모으는 중입니다",
      body:
        `${why} 거래대금 상위 ${codes.length}종목 × 400거래일을 다시 받습니다 — ` +
        `20분쯤 걸리고 백그라운드로 돕니다. 끝나면 「지금 설정이 새 표본에서도 통하나」를 ` +
        `다시 알려 드립니다.`,
      link: "#/settings",
      dedupeKey: "regime:rebuild-start",
      dedupeHours: 20,
    });

    startBacktestJob(client, { codes, days: 400 });

    /* 끝날 때까지 지켜본다 — 30초마다, 최대 한 시간 */
    const until = Date.now() + 60 * 60_000;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 30_000));
      if (!backtestProgress().running) break;
    }
    if (backtestProgress().running) {
      await pushNotice({
        kind: "system",
        level: "warn",
        title: "표본 수집이 한 시간을 넘겼습니다",
        body: "아직 돌고 있거나 중간에 멈췄을 수 있습니다. 신호등 찾기에서 진행률을 보세요.",
        link: "#/signalScreen",
        dedupeKey: "regime:rebuild-slow",
        dedupeHours: 20,
      });
      return;
    }

    /* 새 표본으로 **지금 설정**을 채점한다 — 이게 재수집의 진짜 목적이다 */
    const meta = await samplesMeta();
    const cfg = await getConfig();
    const sim = await simulate(cfg).catch(() => null);

    if (!sim) {
      await pushNotice({
        kind: "system",
        level: "info",
        title: `표본을 새로 모았습니다 — ${meta.obs?.toLocaleString("ko-KR")}관측`,
        body: `${meta.codeCount}종목 × ${meta.days}거래일. 채점은 설정 > 시뮬레이터에서 눌러 보세요.`,
        link: "#/settings",
        dedupeKey: "regime:rebuild-done",
        dedupeHours: 20,
      });
      return;
    }

    /*
     * **점수 구간이 단조인가** — 이 한 줄이 「점수가 아직 작동하나」의 답이다.
     * 90~100이 70~79보다 나쁘면 점수가 고장 난 것이고, 그건 초록 평균이 좋아도
     * 문제다(점수 높은 것부터 고르게 되므로).
     */
    const seq = sim.buckets
      .filter((b) => b.s.n > 0 && b.s.d20.avg !== null)
      .map((b) => b.s.d20.avg as number);
    const mono = seq.every((v, i) => i === 0 || seq[i - 1] >= v);
    const lift =
      sim.green.d20.avg !== null && sim.base.d20.avg !== null
        ? Math.round((sim.green.d20.avg - sim.base.d20.avg) * 100) / 100
        : null;

    await pushNotice({
      kind: "system",
      level: lift !== null && lift <= 0 ? "warn" : "info",
      title:
        lift !== null && lift <= 0
          ? "⚠️ 새 표본에서 초록이 시장을 못 이깁니다"
          : "표본을 새로 모으고 채점했습니다",
      body:
        `${why}\n` +
        `표본 ${sim.obs.toLocaleString("ko-KR")}관측 (${sim.codeCount}종목 × ${sim.days}거래일)\n` +
        `초록 ${sim.green.n.toLocaleString("ko-KR")}건 · 20일 ${sim.green.d20.avg}% ` +
        `(승률 ${sim.green.d20.win}%) · 시장 ${sim.base.d20.avg}%\n` +
        `초과 ${lift !== null ? `${lift > 0 ? "+" : ""}${lift}%p` : "-"} · ` +
        `점수 구간 ${mono ? "단조 증가 ✓" : "역전 ✗ — 점수가 고장 났을 수 있습니다"}\n` +
        `못 잰 기준 ${sim.skipped.length}개: ${sim.skipped.join(" · ")}\n` +
        `→ 설정 > 시뮬레이터에서 조건별·조합별로 더 파고들 수 있습니다.`,
      link: "#/settings",
      dedupeKey: "regime:rebuild-done",
      dedupeHours: 20,
    });
  } catch (err) {
    await pushNotice({
      kind: "system",
      level: "warn",
      title: "표본 재수집이 실패했습니다",
      body: `${err instanceof Error ? err.message : "알 수 없는 오류"} — 다음 날 다시 시도합니다.`,
      dedupeKey: "regime:rebuild-fail",
      dedupeHours: 20,
    }).catch(() => undefined);
  } finally {
    rebuilding = false;
  }
}

async function tick(client: KiwoomClient): Promise<void> {
  try {
    const { config } = await regimeConfig();
    if (!config.enabled) return;

    const now = kst();
    if (!isWeekday(now)) return;
    const t = hhmm(now);
    const today = ymd(now);

    /* ① 16:10 — 장세 점검. 종가가 확정된 뒤다 */
    if (t >= "16:10" && t < "16:20" && doneCheck !== today) {
      doneCheck = today;
      await regimeCheck(client, { notify: true });
    }

    /*
     * ② 16:30 — **신호등 분석** (목록별 추적).
     *
     * 슈퍼신호등(15:45)이 끝난 뒤, 표본 재수집(18:30) 전이다. 일곱 목록 각 500 을
     * 받아 합집합(1,200~1,800종목)의 신호등을 전부 잰다 — **상한을 안 둔다.**
     * 슈퍼신호등의 평가 상한(40개) 때문에 「초록이었을 수도 있는데 재보지도 못한」
     * 종목이 생기는 문제를 여기서는 원천 차단한다. 40분쯤 걸리지만 백그라운드다.
     */
    if (t >= "16:30" && t < "16:40" && doneList !== today) {
      doneList = today;
      void runListTrack(client, { limit: 500 });
    }

    /* ③ 18:30 — 표본이 오래됐으면 알아서 다시 모은다 */
    if (t >= "18:30" && t < "18:40" && doneRebuild !== today) {
      doneRebuild = today;
      const meta = await samplesMeta();
      if (!meta.has) {
        await rebuildAndReport(client, "검증 표본이 아직 없어서 처음 모읍니다.");
      } else if (meta.builtAt) {
        const age = Math.floor((Date.now() - new Date(meta.builtAt).getTime()) / 86_400_000);
        if (age >= config.sampleStaleDays) {
          await rebuildAndReport(
            client,
            `표본이 ${age}일 지나서(문턱 ${config.sampleStaleDays}일) 다시 모았습니다.`,
          );
        }
      }
    }
  } catch (err) {
    /* 스케줄러가 서버를 죽이면 안 된다 — 다음 tick 에서 다시 */
    console.error("[regime] 점검 실패:", err instanceof Error ? err.message : err);
  }
}

export function startRegimeScheduler(client: KiwoomClient): void {
  if (timer) return;
  timer = setInterval(() => void tick(client), TICK_MS);
  console.log("[regime] 스케줄러 시작 (16:10 장세 점검 · 16:30 신호등 분석 · 18:30 표본 재수집)");
}
