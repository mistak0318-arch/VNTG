import { memoryUsage } from "node:process";
import v8 from "node:v8";
import type { NextFunction, Request, Response } from "express";
import { noteLife } from "./lifecycle.js";
import { isStressed } from "./recovery.js";

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
 * 동시에 도는 무거운 요청 수.
 *
 * 종목 화면 한 장이 길 열다섯 개를 던지므로, 이 값이 작으면 두세 물결로 나뉘어 화면이
 * 굼떠진다. 크면 봉우리가 자란다. 요청 하나가 평균 150MB 안팎이니 8이면 1.2GB —
 * 기본 940MB 를 더해도 상한 6GB 에 한참 못 미친다.
 */
const MAX_INFLIGHT = 8;
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
let maxInflight = 0;
let lastShedNote = 0;

export function loadGateStats(): { 지금도는것: number; 최고동시: number; 되돌려보냄: number; 상한MB: number } {
  return { 지금도는것: inflight, 최고동시: maxInflight, 되돌려보냄: shed, 상한MB: limitMB };
}

function release(): void {
  inflight -= 1;
  const next = waiters.shift();
  if (next) next();
}

export function loadGate(req: Request, res: Response, next: NextFunction): void {
  if (!req.path.startsWith("/api/") || light(req.path)) {
    next();
    return;
  }

  /*
   * 지금 쓰는 양을 본다. `heapUsed` 는 GC 직후가 아니면 실제보다 커 보이지만, 여기서는
   * **크게 보이는 쪽이 안전**하다 — 늦게 막느니 일찍 막는다.
   */
  const usedMB = Math.round(memoryUsage().heapUsed / 1048576);
  /*
   * **복구 중이면 더 적게 받는다** (2026-10-07 밤). 복구 루틴이 캐시를 놓고 GC 를 도는
   * 동안에도 들어오는 쪽이 계속 밀어 넣으면 영영 못 내려온다 — 내보내는 것보다 들어오는
   * 것이 많으면 복구가 아니라 버티기일 뿐이다. 잠깐 더 거절해서 내려올 틈을 준다.
   */
  const shedAt = isStressed() ? 0.7 : SHED_AT;
  if (usedMB > limitMB * shedAt) {
    shed += 1;
    /* 로그가 초당 수십 줄로 불어나지 않게 10초에 한 번만 적는다 */
    if (Date.now() - lastShedNote > 10_000) {
      lastShedNote = Date.now();
      noteLife("WARN", `과부하 — ${usedMB}/${limitMB}MB${isStressed() ? " (복구 중)" : ""}, 되돌려보냄 ${shed}건 (${req.path})`);
    }
    res
      .status(503)
      .json({ error: "서버가 잠깐 바쁩니다 — 잠시 뒤 다시 눌러 주세요.", 과부하: true });
    return;
  }

  const run = () => {
    inflight += 1;
    if (inflight > maxInflight) maxInflight = inflight;
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

  if (inflight < MAX_INFLIGHT) {
    run();
    return;
  }

  /* 줄에 세운다. 너무 오래 기다리면 포기하고 503 — 끝없이 쌓이면 그것도 메모리다 */
  let timer: NodeJS.Timeout | null = null;
  const start = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      run();
    }
  };
  waiters.push(start);
  timer = setTimeout(() => {
    timer = null;
    const i = waiters.indexOf(start);
    if (i >= 0) waiters.splice(i, 1);
    shed += 1;
    res.status(503).json({ error: "서버가 많이 바쁩니다 — 잠시 뒤 다시 눌러 주세요.", 과부하: true });
  }, MAX_WAIT_MS);
}
