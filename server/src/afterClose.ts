import type { KiwoomClient } from "./kiwoomClient.js";
import { buildCloses } from "./dailyCloses.js";
import { collectProgress, startCollectDaily } from "./collectDaily.js";
import { ledgerStatus } from "./dailyStore.js";
import { regimeCheck } from "./regimeWatch.js";
import { startEnroll } from "./signalTrack.js";
import { runSuperSignal } from "./superSignal.js";
import { runListTrack } from "./listTrack.js";
import { samplesMeta } from "./signalSamples.js";
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
 *   ⑤ 슈퍼신호등         교집합 편입/이탈 + 점수대 그룹 동기화
 *   ⑥ 신호등 분석        **①②가 다 있어야** 열세 목록이 제 값으로 돈다
 *   ⑦ 표본 재수집        오래됐으면
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
let doneDay = "";
let timer: ReturnType<typeof setInterval> | null = null;

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
export async function runAfterClose(client: KiwoomClient, force = false): Promise<AfterCloseRun> {
  if (run?.running) return run;
  const day = dayKey();
  if (!force && doneDay === day && run) return run;

  run = { day, startedAt: new Date().toISOString(), running: true, steps: [] };

  /* ① 일봉 — 모두가 이걸 바탕으로 한다 */
  const bars = await step("bars", "일봉 전종목", async () => {
    const s = await buildCloses(client);
    return `${Object.keys(s.bars ?? {}).length}종목`;
  });

  /* ② 원장 — 신호등 분석의 flow-* 목록이 이걸 읽는다 */
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
  await step("regime", "장세 점검", async () => {
    await regimeCheck(client, { notify: true });
    return bars.ok ? undefined : "⚠️ 일봉이 실패해 낡은 캐시로 판정";
  });

  /* ④ 추적기 — 문턱별 편입 */
  await step("track", "신호등 추적기", async () => {
    const j = startEnroll(client, false);
    while (j.status === "running") await new Promise((r) => setTimeout(r, 2000));
    return j.status === "error" ? `실패: ${j.error ?? ""}` : `${j.added ?? 0}건 담음`;
  });

  /* ⑤ 슈퍼신호등 — 교집합 편입/이탈 + 점수대 그룹 동기화 */
  await step("super", "슈퍼신호등", async () => {
    const s = await runSuperSignal(client);
    return `${s.entries.filter((e) => e.active !== false).length}종목 추적 중`;
  });

  /* ⑥ 신호등 분석 — ①②가 다 있어야 열세 목록이 제 값으로 돈다 */
  await step("listTrack", "신호등 분석 (목록별)", async () => {
    const s = await runListTrack(client, { limit: 500, force: true });
    return `${s.entries.length}건`;
  });

  /*
   * ⑦ 표본 — **상태만 본다.** 실제 재수집은 `regimeScheduler` 의 18:30 이 한다.
   *
   * 재수집은 종목당 여러 콜에 40~60분이라 이 파이프라인(이미 2시간 남짓) 뒤에
   * 붙이면 밤이 다 간다. 여기서는 「얼마나 낡았나」만 적어 요약에 싣는다.
   */
  await step("samples", "검증 표본", async () => {
    const meta = await samplesMeta();
    if (!meta.has) return "표본이 없어 건너뜀 — 설정에서 처음 모아야 합니다";
    const age = meta.builtAt
      ? Math.floor((Date.now() - new Date(meta.builtAt).getTime()) / 86_400_000)
      : 99;
    return age >= 7 ? `${age}일 지남 — 재수집이 필요합니다` : `${age}일 전 것 (아직 쓸 만함)`;
  });

  run.running = false;
  run.finishedAt = new Date().toISOString();
  run.at = undefined;
  doneDay = day;

  /* 요약을 보낸다 — 무엇이 실패했는지 아침에 알 수 있어야 한다 */
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

  return run;
}

export function startAfterCloseScheduler(client: KiwoomClient): void {
  if (timer) return;
  const tick = async () => {
    if (doneDay === dayKey()) return;
    if (!shouldStart()) return;
    if (run?.running) return;
    await runAfterClose(client).catch(() => undefined);
  };
  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  /* 켜자마자 한 번 — 저녁에 미니PC 를 켰으면 그날 몫이 돈다 */
  void tick();
}
