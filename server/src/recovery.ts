import { memoryUsage } from "node:process";
import v8 from "node:v8";
import { noteLife } from "./lifecycle.js";
import { dropSamplesCache } from "./signalSamples.js";
import { dropAccountCache } from "./orders.js";

/**
 * 복구 루틴 — **나빠진 뒤 스스로 돌아온다** (2026-10-07 밤).
 *
 * 벤티지: "한번 느려지면 다른 포인트에서 전부 영향 받자나. 복구 루틴을 짜야할거 아냐" ·
 * "느려지는 순간 전체 메뉴가 영향을 받아 새로고침해도 마찬가지."
 *
 * ## 왜 새로고침이 소용없나
 *
 * 느려진 것은 **화면이 아니라 서버**다. heap 이 상한 가까이 차면 V8 이 시간을 거의 다
 * GC 에 쓴다 — 요청 하나가 40초씩 걸리는 것이 그 때문이고, 그 상태는 **저절로 안 풀린다.**
 * 쓰는 사람이 새로고침을 하면 오히려 요청이 더 쏟아져 더 나빠진다.
 *
 * 여태 만든 것은 전부 **막는 것**(관문·상한)이었다. 막기만 하면 나빠진 상태에 갇힌다.
 * 돌아오는 길이 있어야 한다.
 *
 * ## 상태 넷
 *
 * ```
 *   정상 ──65%──> 경계 ──78%──> 복구 ──(45초 안에 못 내려오면)──> 재시작
 *     <────────────────50%────────────┘
 * ```
 *
 *  · **경계**: 아직 쓸 만하다. 기록만 남기고 관문을 조인다.
 *  · **복구**: 놓을 수 있는 캐시를 놓고 **전체 GC 를 직접 부른다**. V8 이 알아서 하기를
 *    기다리는 대신 지금 하게 만드는 것이 핵심이다 — 기다리면 그 사이 요청이 또 쌓인다.
 *  · **재시작**: 복구로도 45초 안에 안 내려오면 **깨끗하게 내려간다.** 감시자가 10초 뒤
 *    다시 띄운다. OOM 으로 즉사하는 것과 다르다 — 그때는 쓰던 응답이 통째로 날아간다.
 *
 * 내려올 때 기준(50%)을 올라갈 때(65%)보다 낮게 둔다. 같게 두면 문턱 근처에서 상태가
 * 깜빡이며 캐시를 놓았다 채웠다 반복한다.
 *
 * ⚠️ **일봉 캐시(84MB)는 안 놓는다.** 놓으면 다음 요청이 다시 읽으면서 7초 동안 이벤트
 * 루프를 막고, 그 사이 또 쌓여 **맴돌이**가 된다(10/07 새벽에 겪었다). 놓는 것은 다시
 * 만드는 값이 싼 것만.
 */

const LIMIT_MB = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);

/** 올라갈 때 문턱 */
const WARN_AT = 0.65;
const RECOVER_AT = 0.78;
/** 내려올 때 문턱 — 올라갈 때보다 낮아야 깜빡이지 않는다 */
const CLEAR_AT = 0.5;
/** 복구를 이만큼 해도 안 내려오면 깨끗하게 내려간다 */
const GIVE_UP_MS = 45_000;
/** 스스로 내려간 뒤 이만큼은 다시 안 내려간다 — 맴돌이 방지 */
const RESTART_GAP_MS = 10 * 60_000;

export type HealthState = "정상" | "경계" | "복구";

let state: HealthState = "정상";
let since = Date.now();
let recoverFrom = 0;
let lastRestart = 0;
let gcCount = 0;
let recoverCount = 0;
let lastNote = 0;

/** 전체 GC 를 직접 부를 수 있나 — `node --expose-gc` 로 떴을 때만 */
const canGc = typeof (globalThis as { gc?: () => void }).gc === "function";

export function recoveryStats(): {
  상태: HealthState;
  heapMB: number;
  상한MB: number;
  퍼센트: number;
  복구횟수: number;
  GC호출: number;
  GC가능: boolean;
} {
  const used = Math.round(memoryUsage().heapUsed / 1048576);
  return {
    상태: state,
    heapMB: used,
    상한MB: LIMIT_MB,
    퍼센트: LIMIT_MB > 0 ? Math.round((used / LIMIT_MB) * 100) : 0,
    복구횟수: recoverCount,
    GC호출: gcCount,
    GC가능: canGc,
  };
}

/** 관문이 물어본다 — 복구 중이면 더 적게 받는다 */
export function isStressed(): boolean {
  return state !== "정상";
}

/**
 * **손으로 지금 비운다** (2026-10-08).
 *
 * 벤티지: "모니터 3개에 보드 창을 연동해서 사용하고 있고… 캐시 지우기나 메모리 비우기
 * 같은 버튼을 만들던가 수동으로 처리할 수 있는 로직을 만들어라."
 *
 * 보드를 세 창에 띄우고 종목연동을 쓰면 **종목 하나를 누를 때 화면 셋이 같은 길을 동시에**
 * 연다. 요청이 3배가 되니 봉우리도 3배다. 자동 복구는 78% 를 넘어야 도는데, 그 아래에서도
 * 「지금 굼뜨다」가 느껴지는 구간이 있다 — 그때 사람이 직접 누를 길이 있어야 한다.
 *
 * 자동 복구와 **같은 일**을 한다(캐시 놓기 + 전체 GC). 다른 길로 만들면 둘이 어긋난다.
 * `/api/sys/` 는 과부하 관문을 안 타므로 **서버가 바쁠 때도 이 버튼은 먹는다** — 바쁠 때
 * 못 누르는 버튼은 있으나 마나다.
 */
export function recoverNow(): {
  놓은것: string;
  이전MB: number;
  이후MB: number;
  거둔MB: number;
  GC가능: boolean;
} {
  const before = Math.round(memoryUsage().heapUsed / 1048576);
  const 놓은것 = dropWhatWeCan();
  forceGc();
  const after = Math.round(memoryUsage().heapUsed / 1048576);
  noteLife("WARN", `손으로 비움 — ${놓은것}, ${before} → ${after}MB`);
  return { 놓은것, 이전MB: before, 이후MB: after, 거둔MB: before - after, GC가능: canGc };
}

/** 놓을 수 있는 것만 놓는다. 다시 만드는 값이 비싼 것(일봉)은 건드리지 않는다 */
function dropWhatWeCan(): string {
  const out: string[] = [];
  try {
    if (dropSamplesCache()) out.push("검증표본");
  } catch {
    /* 놓다가 실패해도 복구는 계속한다 */
  }
  try {
    dropAccountCache();
    out.push("계좌");
  } catch {
    /* 같은 이유 */
  }
  return out.length > 0 ? out.join("·") : "놓을 것 없음";
}

/** 전체 GC. `--expose-gc` 가 없으면 아무 일도 안 한다(그래도 캐시는 놓았다) */
function forceGc(): number {
  const g = (globalThis as { gc?: () => void }).gc;
  if (!g) return 0;
  const before = memoryUsage().heapUsed;
  g();
  gcCount += 1;
  return Math.round((before - memoryUsage().heapUsed) / 1048576);
}

/**
 * 3초마다 불린다. **이 함수 하나가 상태를 바꾸는 유일한 자리**다 —
 * 두 곳에서 재시작을 결정하면 서로 싸운다(감시자와 start-prod 가 그랬다).
 */
export function recoveryTick(selfExit: (why: string) => void): void {
  if (LIMIT_MB <= 0) return;
  const usedMB = Math.round(memoryUsage().heapUsed / 1048576);
  const ratio = usedMB / LIMIT_MB;
  const now = Date.now();
  const pct = Math.round(ratio * 100);

  /* ── 내려왔다 ── */
  if (state !== "정상" && ratio <= CLEAR_AT) {
    const secs = Math.round((now - since) / 1000);
    noteLife("WARN", `복구됨 — heap ${usedMB}/${LIMIT_MB}MB (${pct}%), ${state} 상태로 ${secs}초 있었다`);
    state = "정상";
    since = now;
    recoverFrom = 0;
    return;
  }

  /* ── 복구 ── */
  if (ratio >= RECOVER_AT) {
    if (state !== "복구") {
      state = "복구";
      since = now;
      recoverFrom = now;
      recoverCount += 1;
      noteLife("WARN", `복구 시작 — heap ${usedMB}/${LIMIT_MB}MB (${pct}%)`);
    }
    /* 캐시를 놓고 GC 를 직접 부른다. 매 틱마다 — 들어오는 쪽이 계속 밀어 넣고 있다 */
    const dropped = dropWhatWeCan();
    const freed = forceGc();
    if (now - lastNote > 10_000) {
      lastNote = now;
      noteLife("WARN", `복구 중 — ${dropped}, GC 로 ${freed}MB 거둠 (지금 ${Math.round(memoryUsage().heapUsed / 1048576)}MB)`);
    }
    /*
     * 그래도 안 내려오면 **깨끗하게** 내려간다. OOM 즉사와 다르다 —
     * 지금 쓰고 있던 응답이 마저 나가고, 감시자가 다시 띄운다.
     */
    if (recoverFrom > 0 && now - recoverFrom > GIVE_UP_MS && now - lastRestart > RESTART_GAP_MS && process.uptime() > 120) {
      lastRestart = now;
      noteLife("FATAL", `복구 실패 — ${Math.round(GIVE_UP_MS / 1000)}초 동안 ${pct}% 에서 안 내려온다. 스스로 내려간다`);
      selfExit("복구 실패 재시작");
    }
    return;
  }

  /* ── 경계 ── */
  if (ratio >= WARN_AT) {
    if (state === "정상") {
      state = "경계";
      since = now;
      noteLife("WARN", `경계 — heap ${usedMB}/${LIMIT_MB}MB (${pct}%). 관문을 조인다`);
    }
    return;
  }

  /* 경계와 복구 사이로 내려왔으면 경계로 */
  if (state === "복구" && ratio < RECOVER_AT) {
    state = "경계";
    since = now;
    recoverFrom = 0;
  }
}

/** 3초마다 돈다. 서버가 뜰 때 한 번 부른다 */
export function startRecovery(selfExit: (why: string) => void): void {
  noteLife("START", `복구 루틴 시작 — heap 상한 ${LIMIT_MB}MB, 직접 GC ${canGc ? "가능" : "불가(--expose-gc 없음)"}`);
  setInterval(() => {
    try {
      recoveryTick(selfExit);
    } catch {
      /* 복구 루틴이 서버를 죽이면 안 된다 */
    }
  }, 3000).unref?.();
}
