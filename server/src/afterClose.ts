import type { KiwoomClient } from "./kiwoomClient.js";
import { buildCloses } from "./dailyCloses.js";
import { collectProgress, startCollectDaily } from "./collectDaily.js";
import { ledgerStatus } from "./dailyStore.js";
import { regimeCheck } from "./regimeWatch.js";
import { startEnroll } from "./signalTrack.js";
import { runSuperSignal } from "./superSignal.js";
import { runListTrack } from "./listTrack.js";
import { marketPulse } from "./marketPulse.js";
import { getTradeStats } from "./tradeStats.js";
import { pushNotice } from "./notifyCenter.js";
import { buildSamplesFromLedger } from "./samplesFromLedger.js";
import { sendTelegram } from "./telegram.js";

/**
 * **마감 뒤 파이프라인** (2026-09-01) — 시각이 아니라 **차례**로 돈다.
 *
 * 벤티지: "근데 타이밍이 이게 맞나? 장 마감하고 일봉이랑 데이터 다 받아오고 나서
 * 트리거를 통해서 신호등 분석이랑 슈퍼신호등 한번 돌려야 하는 거 아냐?"
 *
 * 맞는 지적이었다. 여태 **시각으로만** 잡혀 있었고, 앞 작업이 안 끝나도 다음이
 * 시작했다:
 *
 *   15:45  슈퍼신호등    ← **일봉보다 먼저** 돌아 어제 종가로 테마·ETF 를 채점
 *   16:00  일봉 (30~40분)
 *   16:10  장세 점검     ← 일봉이 **아직 도는 중**. 반쯤 갱신된 캐시로 판정
 *   16:30  신호등 분석   ← **17:30 원장보다 먼저.** flow-* 목록이 영영 빈 채로 돈다
 *   17:30  원장 수집
 *   18:30  표본 재수집
 *
 * 마지막이 특히 나빴다. 신호등 분석의 「주포·투신·연기금·기관계 순매수 상위」는
 * **원장을 읽는데** 그 수집이 한 시간 뒤였다 — 순서가 거꾸로라 그 네 목록은
 * 내일도 모레도 어제 원장으로만 돌게 된다.
 *
 * ## 차례
 *
 *   ① 일봉 전종목        모두가 이걸 바탕으로 한다 (장세·테마·ETF·전종목 모집단)
 *   ② 원장 전종목        수급 13주체·공매도·대차·지분율·프로그램
 *   ③ 장세 점검          ①이 있어야 20일선 위 비율이 오늘 것이다
 *   ④ 신호등 추적기      문턱별 편입
 *   ⑤ 신호등 분석        **①②가 다 있어야** 열세 목록이 제 값으로 돈다
 *   ⑥ 슈퍼신호등         ⑤가 받아 둔 목록으로 교집합 + 점수대 그룹 동기화
 *   ⑦ 교차 신호          주도주 태그 ∩ 슈퍼신호등
 *   ⑧ 수출입 동향        관세청 발표
 *   ⑨ 검증 표본          ①②로 다시 만든다 (조회 0회)
 *
 * ## ⚠️ 하나가 실패해도 멈추지 않는다
 *
 * 일봉을 못 받았다고 슈퍼신호등을 안 돌리면 그날 원장이 통째로 빈다. 실패한
 * 단계는 **기록에 남기고 다음으로 간다** — 다만 「①이 실패했으니 뒤의 것들은
 * 낡은 일봉으로 돈 것」임을 알 수 있어야 하므로 요약에 적는다.
 *
 * ## 시작 시각
 *
 * **15:40** — 장 마감(15:30) 10분 뒤. 종가가 확정됐고, 전체가 2시간 남짓이라
 * 18시 전후에 끝난다.
 */

const TICK_MS = 5 * 60_000;
const START_HHMM = 15 * 60 + 40;

/**
 * 단계의 차례와 이름 — **시작 알림이 「무엇을 돌릴 것인가」를 적을 때** 쓴다.
 * 아래 `runAfterClose` 의 실제 차례와 같아야 한다(거기서 `want(key)` 로 거른다).
 */
const STEPS: { key: string; label: string }[] = [
  { key: "bars", label: "일봉" },
  { key: "ledger", label: "원장" },
  { key: "regime", label: "장세" },
  { key: "track", label: "추적기" },
  { key: "listTrack", label: "신호등 분석" },
  { key: "super", label: "슈퍼신호등" },
  { key: "cross", label: "교차" },
  { key: "trade", label: "수출입" },
  { key: "samples", label: "표본" },
];

export interface StepResult {
  key: string;
  label: string;
  ok: boolean;
  ms: number;
  note?: string;
  error?: string;
}

export interface AfterCloseRun {
  day: string;
  startedAt: string;
  finishedAt?: string;
  running: boolean;
  /** 지금 어느 단계인가 */
  at?: string;
  steps: StepResult[];
}

let run: AfterCloseRun | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * **오늘 이미 돌았나 — 파일에서 읽는다** (2026-09-01).
 *
 * ⚠️ 처음엔 `let doneDay = ""` 라는 **메모리 변수**였다. 그러면 서버가 재시작될
 * 때마다 초기화되고, 기동 직후의 `void tick()` 이 「오늘 아직 안 돌았다」로 판단해
 * **두 시간짜리를 처음부터 다시 시작한다.**
 *
 * 배포·코드 수정이 잦은 날에는 그게 하루에 몇 번씩 벌어진다. 실제로 그날
 * 로컬과 미니PC 가 같은 수집을 동시에 돌아 키움 한도를 나눠 먹고 둘 다 느려졌다.
 *
 * 이력 파일(`collectHistory`)에 오늘 회차가 `done` 으로 있으면 안 돈다.
 */
async function alreadyDone(day: string): Promise<boolean> {
  try {
    const { loadCollectHistory } = await import("./dailyStore.js");
    return (await loadCollectHistory()).some((r) => r.day === day && r.status === "done");
  } catch {
    return false;
  }
}

export function afterCloseStatus(): AfterCloseRun | null {
  return run ? { ...run, steps: [...run.steps] } : null;
}

function kst(at = Date.now()): Date {
  const d = new Date(at);
  return new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
}

function dayKey(at = Date.now()): string {
  return kst(at).toISOString().slice(0, 10);
}

function shouldStart(at = Date.now()): boolean {
  const k = kst(at);
  const day = k.getDay();
  if (day === 0 || day === 6) return false;
  return k.getHours() * 60 + k.getMinutes() >= START_HHMM;
}

/**
 * 한 단계를 돌린다 — 실패해도 던지지 않는다.
 *
 * 걸린 시간을 재 둔다. 「일봉이 30분이라더니 실제로는 40분」 같은 것을 나중에
 * 사람이 볼 수 있어야 시각을 다시 잡을 수 있다.
 */
async function step(
  key: string,
  label: string,
  fn: () => Promise<string | void>,
): Promise<StepResult> {
  const t0 = Date.now();
  if (run) run.at = label;
  try {
    const note = await fn();
    const r: StepResult = { key, label, ok: true, ms: Date.now() - t0, note: note ?? undefined };
    run?.steps.push(r);
    return r;
  } catch (e) {
    const r: StepResult = {
      key,
      label,
      ok: false,
      ms: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
    run?.steps.push(r);
    return r;
  }
}

/** 분·초로 — 「2712초」보다 「45분」이 읽힌다 */
function dur(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}초` : `${Math.floor(s / 60)}분 ${s % 60}초`;
}

/**
 * 마감 뒤 전체를 차례로 돌린다.
 *
 * @param force 이미 오늘 돌았어도 다시
 */
export async function runAfterClose(
  client: KiwoomClient,
  force = false,
  /**
   * **어느 단계만** 돌릴까 — 안 주면 전부.
   *
   * 벤티지: "1번과 2번을 내가 수동으로도 시작할 수 있지? 지금 한 번 돌리게."
   *
   * 일봉·원장만 먼저 채워 두고 싶을 때가 있다 — 그 둘이 나머지의 바탕이라,
   * 그것만 있으면 신호등 분석은 내일 자동으로 돌아도 제 값이 난다.
   */
  only?: string[],
  /** 왜 도는가 — 시작 알림에 적는다. 안 주면 정규 회차(15:40) */
  reason?: string,
): Promise<AfterCloseRun> {
  if (run?.running) return run;
  const day = dayKey();
  /* 재시작해도 오늘 몫은 한 번이다 — 메모리가 아니라 이력을 본다 */
  if (!force && (await alreadyDone(day))) {
    return run ?? { day, startedAt: "", running: false, steps: [] };
  }

  const want = (k: string) => !only || only.length === 0 || only.includes(k);
  run = { day, startedAt: new Date().toISOString(), running: true, steps: [] };

  /*
   * ## **시작할 때도 알린다** (2026-09-02)
   *
   * 벤티지: "마감 뒤 정리하고 돌아가는 거 시작하고 끝날 때 알람으로 알려줘야겠다.
   * 시스템 알람 쪽으로."
   *
   * 끝 알림만 있으면 두 시간 동안 「지금 도는 중인가, 오늘은 안 도는 건가」를 알
   * 길이 설정 화면뿐이다. 시작 줄이 있으면 그 사이 신호등 분석이 비어 보여도
   * 「아직 ⑤ 전」임을 안다. 무엇을 돌리는지(전부 / 실패 단계만 / 손으로 고른 것)와
   * 왜(정규 · 재시도 · 손으로)를 적는다.
   *
   * 열쇠에 날짜·범위를 넣어 한 시간 안에 같은 것이 또 시작해도(재시작 직후의
   * 재실행 같은) 줄이 하나다 — 시각과 횟수만 올라간다.
   */
  const planned = STEPS.filter((s) => want(s.key));
  const scope = !only || only.length === 0 ? "전체 9단계" : `${planned.length}단계만`;
  const why = reason ?? "정규 회차";
  const startTitle = `마감 뒤 정리 시작 — ${scope} (${why})`;
  const startBody =
    planned.map((s, i) => `${i + 1}. ${s.label}`).join(" → ") +
    (planned.length >= 8 ? "\n\n두 시간 남짓 걸립니다. 끝나면 다시 알립니다." : "\n\n끝나면 다시 알립니다.");
  await sendTelegram(`🌙 <b>${startTitle}</b>\n${planned.map((s) => s.label).join(" → ")}`).catch(
    () => undefined,
  );
  await pushNotice({
    source: "afterClose",
    kind: "system",
    level: "info",
    title: startTitle,
    body: startBody,
    link: "#/settings",
    dedupeKey: `afterClose:start:${day}:${planned.map((s) => s.key).join(",")}`,
    dedupeHours: 1,
  }).catch(() => undefined);

  /* ① 일봉 — 모두가 이걸 바탕으로 한다 */
  const bars = !want("bars")
    ? { ok: true, key: "bars", label: "일봉", ms: 0 }
    : await step("bars", "일봉 전종목", async () => {
        const s = await buildCloses(client);
        return `${Object.keys(s.bars ?? {}).length}종목`;
      });

  /* ② 원장 — 신호등 분석의 flow-* 목록이 이걸 읽는다 */
  if (want("ledger"))
    await step("ledger", "일별 원장 전종목", async () => {
      if (collectProgress().running) return "이미 도는 중이라 건너뜀";
      const p = await startCollectDaily(client);
      const st = await ledgerStatus().catch(() => null);
      return `${p.done}/${p.total} · 실패 ${p.fails}${st ? ` · ${st.codes}종목` : ""}`;
    });

  /*
   * ③ 장세 — ①이 있어야 20일선 위 비율이 오늘 것이다.
   * ①이 실패했으면 낡은 캐시로 판정하게 되므로 그 사실을 적는다.
   */
  if (want("regime"))
    await step("regime", "장세 점검", async () => {
    await regimeCheck(client, { notify: true });
    return bars.ok ? undefined : "⚠️ 일봉이 실패해 낡은 캐시로 판정";
  });

  /* ④ 추적기 — 문턱별 편입 */
  if (want("track"))
    await step("track", "신호등 추적기", async () => {
    /*
     * **force 다.** 파이프라인이 명시적으로 부르는 자리라 lastRunDate 가드가
     * 걸리면 안 된다 — 실제로 그것 때문에 「6초 · 0건」으로 건너뛴 적이 있다.
     * 하루 한 번은 파이프라인 자체가 막는다.
     */
    const j = startEnroll(client, true);
    while (j.status === "running") await new Promise((r) => setTimeout(r, 2000));
    return j.status === "error" ? `실패: ${j.error ?? ""}` : `${j.added ?? 0}건 담음`;
  });

  /*
   * ⑤ **신호등 분석** — 열세 목록을 각각 받아 초록을 담는다.
   *
   * ⚠️ **슈퍼신호등보다 먼저다** (2026-09-01, 벤티지 지적으로 순서를 바꿨다).
   *
   * 슈퍼신호등은 「여러 목록에 **동시에** 걸린 초록」이다. 그 목록이 바로 여기서
   * 받는 것이라 — 분석이 먼저 돌아야 슈퍼가 오늘 목록으로 교집합을 낼 수 있다.
   *
   * 그리고 여기서 받은 목록을 슈퍼가 **그대로 쓴다**(`recentLists`). 따로 받으면
   * 조회가 두 배로 나가고, 그사이 순위가 바뀌어 「분석에서는 걸렸는데 슈퍼에서는
   * 안 걸린 종목」이 생긴다.
   */
  if (want("listTrack"))
    await step("listTrack", "신호등 분석 (목록별)", async () => {
      const s2 = await runListTrack(client, { limit: 500, force: true });
      return `${s2.entries.length}건`;
    });

  /* ⑥ 슈퍼신호등 — ⑤가 받아 둔 목록으로 교집합. 조회가 거의 안 는다 */
  if (want("super"))
    await step("super", "슈퍼신호등 (교집합)", async () => {
      const s2 = await runSuperSignal(client, true);
      return `${s2.entries.filter((e) => e.active !== false).length}종목 추적 중`;
    });

  /*
   * ⑦ **교차 신호** — 주도주 태그 ∩ 슈퍼신호등.
   *
   * ⚠️ 여태 **자동으로 안 돌았다** (2026-09-01 발견). `marketPulse` 를 부르는 곳이
   * 화면 라우트뿐이라, 「시장 흐름」 화면을 열어야만 계산되고 그때 관심종목
   * 「슈퍼신호등+교차」 그룹 편입·이탈이 일어났다. 화면을 안 열면 그 그룹이
   * 며칠이고 낡은 채로 남는다.
   *
   * ⑥ 다음이다 — 슈퍼신호등 원장을 읽어 교집합을 내기 때문이다.
   */
  if (want("cross"))
    await step("cross", "교차 신호 (주도주 ∩ 슈퍼)", async () => {
      const p2 = await marketPulse(client, true);
      const n = p2.cross?.stocks?.length ?? 0;
      return `${n}종목`;
    });

  /*
   * ⑧ **수출입 동향** — 관세청 발표를 받아 둔다.
   *
   * ⚠️ 여태 **자동으로 안 받았다** (2026-09-01 발견). `getTradeStats` 를 부르는
   * 곳이 화면 라우트뿐이라, 「수출 동향」 화면을 열어야만 갱신됐다. 발표가 나도
   * 아무도 안 알려 준다 — 벤티지: "오늘 수출입동향 발표 나오는 날인데 내 로직은
   * 안 읽어온 건지 읽어오고도 나한테 알림을 안 준 건지 모르겠네."
   *
   * 안 읽어온 쪽이었다. `tradeHistory.json` 이 8/31 에 멈춰 있었다.
   *
   * 발표는 매월 1일과 15일 언저리다 — 매일 불러도 값이 그대로면 캐시가 받고,
   * 새 값이 있으면 그날 알림에 실린다.
   */
  if (want("trade"))
    await step("trade", "수출입 동향", async () => {
      const r = await getTradeStats(true);
      const n = r.items?.length ?? 0;
      return n > 0 ? `${n}품목${r.error ? ` · ${r.error}` : ""}` : (r.error ?? "받은 것 없음");
    });

  /*
   * ⑨ **검증 표본 — 원장으로 다시 만든다** (2026-09-01).
   *
   * ⚠️ 여태 이 자리는 「얼마나 낡았나」만 적었다. 재수집이 종목당 여러 콜에
   * 40~60분이라 두 시간짜리 파이프라인 뒤에 붙일 수가 없었기 때문이다. 그래서
   * 표본은 **손으로 눌러야만** 갱신됐고, 실제로 며칠씩 낡은 채로 있었다.
   *
   * 이제 ①일봉과 ②원장이 방금 채워졌다. 그 둘이면 표본을 만들 수 있다 —
   * **키움을 한 번도 안 부르고** 몇 분이면 끝난다. 조회가 0이니 파이프라인에
   * 붙지 않을 이유가 없다.
   *
   * 그래서 표본이 **매일 하루씩 자란다.** 어제 문턱을 정하며 본 성적이 오늘도
   * 같은 표본에서 나온다.
   */
  if (want("samples"))
    await step("samples", "검증 표본 (원장으로)", async () => {
      const p = await buildSamplesFromLedger(client);
      if (p.error) return `실패: ${p.error}`;
      const note = `${p.obs.toLocaleString()}관측 · ${(p.total - p.skipped).toLocaleString()}종목`;
      /* ①②가 깨졌으면 표본도 그만큼 낡은 것으로 만들어진 것이다 */
      return bars.ok ? note : `${note} · ⚠️ 일봉이 실패해 어제까지로 만들어짐`;
    });

  run.running = false;
  run.finishedAt = new Date().toISOString();
  run.at = undefined;

  /*
   * ## **끝나면 알린다** — 텔레그램과 알림 센터 둘 다 (2026-09-01). 시작 알림은 위에.
   *
   * 벤티지: "데일리 리포트도 만들어졌으면 알람 줘야 하고, 시스템적으로 돌아가는
   * 배치들은 다 되면 나한테 알람 주는 구조로 만들어줘. 알람 메뉴 만들었잖아."
   *
   * 맞다. 여태 이 배치들은 **조용히 돌고 조용히 실패했다** — 오늘 하루에만
   * 일봉이 자동으로 안 돌던 것, 교차 신호가 화면을 열어야만 돌던 것, 수출입을
   * 아예 안 받던 것이 나왔는데 셋 다 **아무도 모르고 있었다.**
   *
   * 텔레그램은 자리를 비운 사이에 오고, 알림 센터는 화면에 남는다 — 둘은 서로를
   * 대신하지 못한다. 텔레그램을 놓치면 영영 못 보고, 알림 센터만 있으면 화면을
   * 안 열면 모른다.
   */
  const bad = run.steps.filter((s) => !s.ok);
  const total = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  await sendTelegram(
    [
      bad.length === 0
        ? `🌙 <b>마감 뒤 정리 완료</b> (${dur(total)})`
        : `🌙 <b>마감 뒤 정리 — ${bad.length}단계 실패</b> (${dur(total)})`,
      ``,
      ...run.steps.map(
        (s) =>
          `${s.ok ? "✅" : "⚠️"} ${s.label} · ${dur(s.ms)}${s.note ? ` — ${s.note}` : ""}${
            s.error ? ` — ${s.error}` : ""
          }`,
      ),
    ].join("\n"),
  ).catch(() => undefined);

  /*
   * 알림 센터에도 남긴다. **실패가 있으면 warn** 이라 화면에서 색이 다르다 —
   * 「돌긴 돌았다」와 「돌았는데 세 개가 깨졌다」는 다른 소식이다.
   */
  await pushNotice({
      source: "afterClose",
    kind: "system",
    level: bad.length > 0 ? "warn" : "info",
    title:
      bad.length === 0
        ? `마감 뒤 정리 완료 (${dur(total)})`
        : `마감 뒤 정리 — ${bad.length}단계 실패`,
    body: run.steps
      .map((s) => `${s.ok ? "✅" : "⚠️"} ${s.label}${s.note ? ` — ${s.note}` : ""}${s.error ? ` — ${s.error}` : ""}`)
      .join("\n"),
    link: "#/settings",
    /* 하루 한 번이면 충분하다 — 손으로 다시 돌리면 그때는 새 줄이 된다 */
    dedupeKey: `afterClose:${run.day}:${bad.length}`,
    dedupeHours: 12,
  }).catch(() => undefined);

  return run;
}

/**
 * ## **실패한 단계는 다시 돌린다** (2026-09-02)
 *
 * 벤티지: "수집이 오류나서 끊기면 하루는 놓치는 거잖니."
 *
 * 맞았다. 파이프라인은 하루 한 번만 돌고(`alreadyDone`), 어느 단계가 실패해도
 * **그대로 끝났다.** 실패는 요약 알림에 적히지만 그건 「알려 준다」이지
 * 「고친다」가 아니다 — 그 알림을 놓치면 그날 원장은 영영 빈다. 그리고
 * **편입 원장은 소급이 안 된다.**
 *
 * 실패의 대부분은 **일시적인 것**이다. 키움이 잠깐 막히거나, 초당 제한에
 * 걸리거나, 네트워크가 끊긴다. 그런 건 30분 뒤에 다시 하면 대개 된다.
 *
 * ## 규칙
 *
 *   · 실패한 단계**만** 다시 돈다 (성공한 것을 또 돌리면 조회만 낭비다)
 *   · 30분 간격, **두 번까지**. 그래도 안 되면 사람이 볼 문제다
 *   · 마지막 시도까지 실패하면 **따로 알린다** — 요약에 묻히지 않게
 */
const RETRY_GAP_MS = 30 * 60_000;
const RETRY_MAX = 2;
let retry: { day: string; tried: number; at: number } | null = null;

export function startAfterCloseScheduler(client: KiwoomClient): void {
  if (timer) return;
  const tick = async () => {
    if (!shouldStart()) return;
    if (run?.running) return;

    const day = dayKey();

    /* ① 실패한 단계가 있으면 그것만 다시 — 성공한 것은 안 건드린다 */
    if (run?.day === day && !run.running && retry?.day === day) {
      const failed = run.steps.filter((s) => !s.ok).map((s) => s.key);
      if (failed.length > 0 && retry.tried < RETRY_MAX && Date.now() - retry.at >= RETRY_GAP_MS) {
        retry = { day, tried: retry.tried + 1, at: Date.now() };
        console.log(`[afterClose] 실패 단계 재시도 ${retry.tried}/${RETRY_MAX} — ${failed.join(", ")}`);
        const r = await runAfterClose(client, true, failed, `재시도 ${retry.tried}/${RETRY_MAX}`).catch(
          () => null,
        );
        const still = r?.steps.filter((s) => !s.ok).map((s) => s.label) ?? [];
        if (still.length > 0 && retry.tried >= RETRY_MAX) {
          await pushNotice({
      source: "afterClose",
            kind: "system",
            level: "warn",
            title: `마감 뒤 정리 — ${still.length}단계가 끝내 실패했습니다`,
            body:
              `${still.join(" · ")}\n\n` +
              `30분 간격으로 ${RETRY_MAX}번 다시 시도했지만 안 됐습니다. ` +
              `편입 원장은 소급이 안 되므로 **오늘 몫은 손으로 돌려야** 합니다 — ` +
              `설정 > 마감 뒤 정리에서 그 단계만 누르면 됩니다.`,
            link: "#/settings",
            dedupeKey: `afterClose:retryFail:${day}`,
            dedupeHours: 12,
          }).catch(() => undefined);
        }
        return;
      }
      return;
    }

    /* ② 오늘 첫 실행 — `runAfterClose` 안에서 이력을 보고 판단한다 */
    const r = await runAfterClose(client).catch(() => null);
    /* 실패가 있으면 재시도 시계를 건다. 다 됐으면 걸 필요가 없다 */
    if (r && !r.running && r.steps.some((s) => !s.ok)) {
      retry = { day, tried: 0, at: Date.now() };
    }
  };
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  /* 켜자마자 한 번 — 저녁에 미니PC 를 켰으면 그날 몫이 돈다 */
  void tick();
}
