import { memoryUsage } from "node:process";
import v8 from "node:v8";
import type { NextFunction, Request, Response } from "express";
import { noteLife } from "./lifecycle.js";
import { isStressed, pressure, stressLevel } from "./recovery.js";

/**
 * 과부하 관문 — **서버가 죽는 대신 느려지게 한다** (2026-10-07 밤).
 *
 * 벤티지: "이게 죽는게 원인이 여러가지 인데 궁긍적인 해법은 없어??"
 *
 * ## 죽는 구조는 하나다
 *
 * 원인이 여러 가지로 보였지만 모양은 늘 같았다 — **봉우리 = 기본 + 동시에 도는 것들의 합.**
 *
 *   · 기본 940MB. 일봉(84MB)·표본(38MB) 같은 큰 파일을 통째로 들고 있어서다.
 *   · 종목 화면 한 장이 길 **열다섯 개를 동시에** 연다. 하나하나가 수십~수백MB.
 *   · 보드에 차트 카드 세 장이면 그게 곱절이 된다.
 *
 * 그 합이 한도를 넘는 순간 V8 이 `FATAL ERROR: ... heap out of memory` 로 즉사한다.
 * 10/07 밤에 두 번 그랬다(22:13:53·22:20:30, 둘 다 뜬 지 5분 안에). 그때그때 마지막
 * 한 방울이 ETF였다 테마 종목이었다 달랐을 뿐, **같은 병이다.**
 *
 * ## 그래서 합을 묶는다
 *
 * 한도를 올리는 것은 시간 벌기지 치료가 아니다. 합이 자라는 것을 막아야 한다.
 *
 *  1. **동시에 도는 수를 센다.** 넘치면 뒤에 온 요청을 **기다리게** 한다(거절이 아니다).
 *     몰릴 때 조금 느려지는 대신 봉우리가 안 자란다.
 *  2. **한계 가까이 가면 거절한다.** heap 이 상한의 82% 를 넘으면 새 요청을 503 으로
 *     돌려보낸다. 카드 하나가 「못 받았습니다」로 뜨는 건 괜찮다 — **죽으면 전부를 잃는다.**
 *
 * ⚠️ **가벼운 길은 안 막는다.** `/api/health` 는 감시자가 생사를 보는 길이라, 여기서
 * 막히면 **멀쩡한 서버를 죽은 걸로 보고 되살린다.** 실시간·설정처럼 짧은 길도 같이 뺀다 —
 * 줄에 세워 봐야 봉우리에 보태는 것이 없고 화면만 굼떠진다.
 */

/**
 * 동시에 도는 무거운 요청 수 — **메모리 여유에 따라 늘었다 줄었다 한다** (2026-10-08).
 *
 * ⚠️ 처음엔 8로 박아 뒀다가 실측에서 당했다. 벤티지가 보드를 **모니터 셋**에 띄우고
 * 종목연동으로 쓰니 종목 하나에 화면 셋이 같은 길을 동시에 연다 — 카드가 수십 장인데
 * 자리가 여덟이라 **165건이 15초를 기다리다 503 으로 나갔다.** 그런데 그때 heap 은
 * **상한의 32%** 였다. 메모리를 지키려고 만든 관문이 **메모리가 멀쩡한데도 목을 조른 것**이다.
 *
 * 이 관문의 목적은 「동시 실행을 적게 하는 것」이 아니라 **봉우리를 상한 아래로 묶는 것**이다.
 * 여유가 있으면 넓히고, 차오르면 조인다. 조이는 판단은 복구 루틴이 이미 하고 있으니
 * 그 상태를 그대로 쓴다 — 문턱을 두 벌로 만들면 둘이 어긋난다.
 */
function maxInflight(): number {
  const s = stressLevel();
  if (s === "복구") return 6;
  if (s === "경계") return 14;
  /*
   * 20 → 32 (2026-10-08). 벤티지: "동시에 도는요청 20개 말고 더 여유롭게 둘 수는 없어?
   * 지금도 거절되는게 많은데."
   *
   * 실측으로 값을 잡는다 — 20개가 돌 때 heap 2,502MB 였고 기본이 940MB 이니
   * **요청 하나가 약 80MB** 다. 32개면 0.9 + 2.6 = 3.5GB, 상한 6.3GB 의 55% 로
   * 경계(65%) 아래다. 넘치면 관문이 스스로 14 로, 다시 6 으로 줄인다.
   *
   * 거절이 많았던 진짜 까닭은 자리 수가 아니라 **한투를 기다리는 요청이 자리를 쥔 채
   * 20초를 버틴 것**이었다. 그쪽을 8초로 줄여 자리가 빨리 돌게 했고, 이 수는 그 위에 얹는다.
   */
  return 32;
}
/** 줄에서 기다리는 최대 시간 — 이보다 길면 화면이 이미 포기했다 */
const MAX_WAIT_MS = 15_000;
/** 이 비율을 넘으면 새 요청을 받지 않는다 */
const SHED_AT = 0.82;

const limitMB = Math.round(v8.getHeapStatistics().heap_size_limit / 1048576);

/** 줄을 안 세우는 길 — 생사 확인·짧은 것 */
function light(path: string): boolean {
  return (
    /* 감시자가 생사를 보는 길 — 여기서 막히면 **멀쩡한 서버를 죽은 걸로 보고 되살린다** */
    path === "/api/health" ||
    path.startsWith("/api/health/") ||
    /* 실시간은 SSE 라 응답이 안 끝난다 — 줄에 세우면 자리를 영영 안 놓아 관문이 막힌다 */
    path.startsWith("/api/realtime/") ||
    /* 로그인은 과부하일수록 더 돼야 한다 — 못 들어가면 손쓸 길이 없다 */
    path.startsWith("/api/auth/") ||
    path.startsWith("/api/settings/") ||
    path.startsWith("/api/sys/")
  );
}

let inflight = 0;
const waiters: (() => void)[] = [];
/** 거절한 횟수 — health.json 이 적어 둔다. 늘어나면 ①상한 ②동시수를 다시 본다 */
let shed = 0;
let peakInflight = 0;
let peakWaiters = 0;
let maxWaitedMs = 0;
let lastShedNote = 0;

export function loadGateStats(): {
  지금도는것: number;
  동시한도: number;
  기다리는것: number;
  최고동시: number;
  최고기다림: number;
  최대기다림ms: number;
  되돌려보냄: number;
  /** 보던 화면을 떠나 줄에서 뺀 요청 수 (2026-11-10) */
  떠나서버림: number;
  상한MB: number;
} {
  /*
   * ⚠️ **「기다리는 것」이 없어서 한 번 헤맸다** (2026-10-08). 화면이 굼뜰 때
   * 「증권사 줄인가 내 관문인가」를 물었는데, 관문이 `지금도는것` 만 적고 있어서
   * 답을 못 했다. 줄 길이와 **가장 오래 기다린 시간**이 있어야 그 물음에 답이 된다.
   */
  return {
    지금도는것: inflight,
    동시한도: maxInflight(),
    기다리는것: waiters.length,
    최고동시: peakInflight,
    최고기다림: peakWaiters,
    최대기다림ms: maxWaitedMs,
    되돌려보냄: shed,
    떠나서버림: dropped,
    상한MB: limitMB,
  };
}

function release(): void {
  inflight -= 1;
  passTurn();
}

/**
 * **차례만 넘긴다** — 도는 수(`inflight`)는 건드리지 않는다.
 *
 * 떠난 요청은 자리를 **차지한 적이 없다.** 그래서 여기서 `release()` 를 부르면 한 건
 * 끝났을 때 `inflight` 가 두 번 줄어 동시 상한이 조용히 늘어난다 — 과부하 관문이 스스로
 * 문을 여는 셈이다. 자리를 쓴 쪽만 `release()`, 줄만 비켜 주는 쪽은 이쪽이다.
 */
function passTurn(): void {
  const next = waiters.shift();
  if (next) next();
}

/**
 * 이 요청을 **아직 누가 기다리고 있나.**
 *
 * 브라우저가 연결을 끊으면(화면을 떠나거나 `AbortController` 로 취소하면) 소켓이 죽는다.
 * 그때 돌려줄 곳이 없는 값을 받으려고 증권사 조회를 내보낼 이유가 없다.
 */
function gone(res: Response): boolean {
  return res.destroyed || res.writableEnded || !res.socket || res.socket.destroyed;
}

/** 떠난 화면 것이라 줄에서 뺀 수 — 화면이 「아낀 조회」처럼 읽는다 */
let dropped = 0;

export function loadGate(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/") || light(req.path)) {
    next();
    return;
  }

  /*
   * 지금 쓰는 양을 본다. `heapUsed` 는 GC 직후가 아니면 실제보다 커 보이지만, 여기서는
   * **크게 보이는 쪽이 안전**하다 — 늦게 막느니 일찍 막는다.
   */
  const p = pressure();
  const usedMB = p.heapMB;
  /*
   * **복구 중이면 더 적게 받는다** (2026-10-07 밤). 복구 루틴이 캐시를 놓고 GC 를 도는
   * 동안에도 들어오는 쪽이 계속 밀어 넣으면 영영 못 내려온다 — 내보내는 것보다 들어오는
   * 것이 많으면 복구가 아니라 버티기일 뿐이다. 잠깐 더 거절해서 내려올 틈을 준다.
   */
  const shedAt = isStressed() ? 0.7 : SHED_AT;
  /*
   * **heap 비율이 아니라 「쪼들림」으로 잰다** (2026-11-10). 상한이 램보다 크면 heap
   * 비율은 영영 이 문턱에 안 닿는다 — 11/09 낮에 루프가 21초씩 멈추는 동안 이 관문이
   * 한 건도 안 막았다. `pressure()` 가 heap 과 램 중 먼저 걸리는 쪽을 준다.
   */
  if (p.비율 > shedAt) {
    shed += 1;
    /* 로그가 초당 수십 줄로 불어나지 않게 10초에 한 번만 적는다 */
    if (Date.now() - lastShedNote > 10_000) {
      lastShedNote = Date.now();
      const 재료 = p.무엇 === "램" ? `남은 램 ${p.남은램MB}MB` : `heap ${usedMB}/${limitMB}MB`;
      noteLife(
        "WARN",
        `과부하 — ${재료} (${Math.round(p.비율 * 100)}%)${isStressed() ? " (복구 중)" : ""}, 되돌려보냄 ${shed}건 (${req.path})`,
      );
    }
    res
      .status(503)
      .json({ error: "서버가 잠깐 바쁩니다 — 잠시 뒤 다시 눌러 주세요.", 과부하: true });
    return;
  }

  const run = () => {
    inflight += 1;
    if (inflight > peakInflight) peakInflight = inflight;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      release();
    };
    /* `finish` 는 반드시 한 번만 — 둘 다 오는 경우가 있어 깃발로 막는다 */
    res.on("finish", finish);
    res.on("close", finish);
    next();
  };

  if (inflight < maxInflight()) {
    run();
    return;
  }

  /* 줄에 세운다. 너무 오래 기다리면 포기하고 503 — 끝없이 쌓이면 그것도 메모리다 */
  let timer: NodeJS.Timeout | null = null;
  /* 얼마나 기다렸나 — 「증권사 줄인가 내 관문인가」는 이 숫자로만 갈린다 */
  const queuedAt = Date.now();
  const start = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      /*
       * **떠난 화면 것은 자리를 안 쓴다** (2026-11-10 — 벤티지: "나는 내가 보는 화면에서만
       * 요청이 돌아가면 되는건데 왜 계속 누적이 되는거야?").
       *
       * 종목을 빠르게 넘기면 앞 종목 요청이 줄에 그대로 남아 있었다. 차례가 오면 **이미
       * 아무도 안 보는 화면**의 값을 받으려고 증권사 조회까지 나갔다 — 그게 줄을 더 밀고,
       * 지금 보는 종목이 그만큼 늦어진다.
       *
       * 끊긴 요청은 여기서 버리고 **차례를 다음 사람에게 넘긴다**(`passTurn`). 안 넘기면
       * 그 차례가 영영 돌지 않는다. `release()` 가 아니다 — 자리를 쓴 적이 없다.
       *
       * 대개는 아래 `res.on("close")` 가 먼저 잡아 줄에서 바로 뺀다. 여기까지 오는 것은
       * 소켓이 죽었는데 `close` 가 아직 안 온 틈뿐이다.
       */
      if (gone(res)) {
        dropped += 1;
        passTurn();
        return;
      }
      const waited = Date.now() - queuedAt;
      if (waited > maxWaitedMs) maxWaitedMs = waited;
      run();
    }
  };
  waiters.push(start);
  if (waiters.length > peakWaiters) peakWaiters = waiters.length;

  /*
   * 기다리는 **도중에** 끊기면 그 자리에서 줄을 뺀다. 차례를 기다렸다 버리는 것보다
   * 빨리 빠지는 만큼 뒤쪽이 앞당겨진다.
   */
  const dropIfGone = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    const i = waiters.indexOf(start);
    if (i >= 0) {
      waiters.splice(i, 1);
      dropped += 1;
    }
  };
  res.on("close", dropIfGone);

  timer = setTimeout(() => {
    timer = null;
    const i = waiters.indexOf(start);
    if (i >= 0) waiters.splice(i, 1);
    shed += 1;
    if (MAX_WAIT_MS > maxWaitedMs) maxWaitedMs = MAX_WAIT_MS;
    res.status(503).json({ error: "서버가 많이 바쁩니다 — 잠시 뒤 다시 눌러 주세요.", 과부하: true });
  }, MAX_WAIT_MS);
}
