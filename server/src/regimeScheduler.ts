import type { KiwoomClient } from "./kiwoomClient.js";
import { regimeCheck, regimeConfig } from "./regimeWatch.js";
import { pushNotice } from "./notifyCenter.js";
import { backtestProgress } from "./signalBacktest.js";
import { samplesMeta } from "./signalSamples.js";
import { buildSamplesFromLedger } from "./samplesFromLedger.js";
import { simulate } from "./signalSimulate.js";
import { getConfig } from "./signalLight.js";

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
 *   18:30  표본 다시 만들기 — 오래됐을 때만
 *
 * ⚠️ **장세 점검(16:10)과 신호등 분석(16:30)은 여기 없다.** `afterClose`
 * 파이프라인으로 옮겼다 — 시각으로만 잡혀 있으면 앞 작업이 안 끝나도 시작한다.
 * 이 머리말이 그 둘을 계속 적고 있어서 지웠다(2026-09-02).
 *
 * 18:30 은 예전에 **조회를 3,500번쯤 쓰던** 자리라 다른 자동 작업과 안 부딪히게
 * 뒤로 뺀 시각이다. 이제 원장에서 만들어 조회가 0 이지만, 마감 뒤 파이프라인이
 * ①일봉·②원장을 다 채운 뒤여야 하므로 시각은 그대로 둔다.
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
/**
 * 오늘 이미 한 일 — 하루 한 번씩만.
 *
 * ⚠️ `doneCheck`·`doneList` 는 **죽은 변수였다** (2026-09-02 정리). 장세 점검과
 * 신호등 분석을 `afterClose` 파이프라인으로 옮기면서 여기 호출은 지웠는데
 * 변수와 import 는 남아 있었다 — 읽는 사람이 「여기서도 도는구나」로 오해한다.
 */
let doneRebuild = "";
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
    /*
     * ## **원장에서 만든다** (2026-09-01) — 예전엔 조회로 새로 받았다
     *
     * 여기 있던 것: `tradeValueTop(500)` 으로 목록을 받아 400거래일 백테스트를
     * 돌리고 그 부산물로 표본을 남기는 방식. 20~60분이 걸렸고 **거래대금 상위
     * 500종목**이 한계였다.
     *
     * 그런데 그게 두 가지를 망가뜨리고 있었다:
     *
     * 1. **마감 뒤 파이프라인 ⑨가 만든 2,600종목 표본을 이게 덮어썼다.** 같은
     *    파일(`signalSamples.json`)을 쓰는데 이쪽이 한 시간 뒤에 돈다. 넓은 표본을
     *    만들어 놓고 좁은 것으로 갈아 끼우는 꼴이었다.
     * 2. **표본이 대형주로 기울었다.** 거래대금 상위 500이면 소형주가 통째로
     *    빠지는데, 실측에서 가장 성적이 좋았던 구간이 바로 1~3천억이다.
     *
     * 이제 원장(전종목 수급)과 일봉(전종목 500봉)이 매일 채워지므로 **파일만 읽어**
     * 만든다 — 조회 0회, 몇 분, 2,600종목. 백테스트 자체는 화면에서 손으로 돌리는
     * 도구로 남는다(표본 만들기가 그 부산물이 아니게 됐다).
     */
    await pushNotice({
      kind: "system",
      level: "info",
      title: "표본을 다시 만드는 중입니다",
      body:
        `${why} 원장과 일봉으로 다시 만듭니다 — **조회는 하지 않고** 몇 분이면 끝납니다. ` +
        `끝나면 「지금 설정이 새 표본에서도 통하나」를 알려 드립니다.`,
      link: "#/settings",
      dedupeKey: "regime:rebuild-start",
      dedupeHours: 20,
    });

    const built = await buildSamplesFromLedger(client);
    if (built.error) {
      await pushNotice({
        kind: "system",
        level: "warn",
        title: "표본을 다시 만들지 못했습니다",
        body: `${built.error} — 원장이나 일봉이 아직 없을 수 있습니다. 설정 > 마감 뒤 정리에서 ①②를 먼저 돌려 보세요.`,
        link: "#/settings",
        dedupeKey: "regime:rebuild-fail",
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

    /*
     * ⚠️ **①② 는 `afterClose` 파이프라인으로 옮겼다** (2026-09-01).
     *
     * 여기 있던 것: 16:10 장세 점검, 16:30 신호등 분석.
     *
     * 장세 점검은 **알림을 보내는 작업**이라 두 곳에서 부르면 텔레그램이 두 번
     * 간다. 파이프라인이 일봉을 끝낸 뒤에 부르므로 그쪽이 맞다 — 여기서 부르면
     * 일봉이 도는 중에 반쯤 갱신된 캐시로 판정한다.
     *
     * 시각으로만 잡혀 있어서 **앞 작업이 안 끝나도 시작했다.** 특히 신호등 분석의
     * 「주포·투신·연기금·기관계 순매수 상위」는 일별 원장을 읽는데, 그 수집이
     * 17:30 이라 **순서가 거꾸로**였다 — 그 네 목록은 내일도 모레도 어제 원장으로만
     * 돌게 된다.
     *
     * 이제 `afterClose` 가 일봉 → 원장 → 장세 → 추적기 → 슈퍼신호등 → 신호등 분석
     * → 표본 순으로 **차례로** 부른다.
     */
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
  /*
   * ⚠️ 문구가 **거짓말이었다** (2026-09-02). "16:10 장세 점검 · 16:30 신호등 분석"
   * 이라고 찍고 있었는데 그 둘은 파이프라인으로 옮긴 뒤였다. 로그가 코드와
   * 어긋나면 「그 시각에 돌겠거니」하고 아무도 안 본다.
   */
  console.log("[regime] 스케줄러 시작 (18:30 표본 다시 만들기 — 장세·신호등 분석은 afterClose 담당)");
}
