import { monitorEventLoopDelay } from "node:perf_hooks";
import { noteLife } from "./lifecycle.js";

/**
 * **이벤트 루프가 실제로 멈추는지 잰다** (2026-10-14).
 *
 * 벤티지: "핸드폰은 빠른데 태블릿은 느리다" → "아니다 지금 둘 다 느려."
 *
 * 둘 다면 서버다. 그런데 로그에서 이런 줄을 보고도 **원인을 못 짚었다** —
 *
 *     GET /assets/index-1e1XMbkv.js  +9MB  9520ms
 *
 * 자바스크립트 번들 하나 내주는 데 9.5초. 가설을 둘 세웠는데 둘 다 틀렸다:
 *   ① 일봉 캐시(84MB)가 버려졌다 다시 읽히나 → **아니다**(복구 0회, 그 줄은 손으로 비운 것)
 *   ② 정적 파일이 과부하 관문에 줄 서나 → **아니다**(`loadGate` 는 `/api/` 가 아니면 통과)
 *
 * 추측을 더 쌓는 대신 **갈라 주는 값**을 잰다. 외줄인 node 에서 정적 파일까지 늦다면
 * 둘 중 하나다 — 이벤트 루프가 동기 작업에 막혔거나(서버 탓), 아니면 네트워크·기기 탓이다.
 * 루프 지연이 그 둘을 가른다. 지연이 수 초로 뛰면 **서버가 멈춘 것**이고, 멀쩡하면
 * 서버는 결백하다. 지금은 그 답이 없어서 양쪽을 다 뒤지고 있다.
 *
 * `monitorEventLoopDelay` 는 **네이티브 히스토그램**이라 재는 값이 거의 공짜다
 * (JS 타이머로 재면 재는 행위가 다시 루프를 건드린다).
 *
 * ⚠️ 느릴 때만 한 줄 남긴다(최대 지연 1초 넘김). 평소에는 로그가 한 줄도 안 쌓인다 —
 * 이 파일의 목적은 **느린 순간의 증거**지 상시 기록이 아니다.
 */
const h = monitorEventLoopDelay({ resolution: 20 });

/**
 * **크게 멈춘 순간의 증거** — 도는 길목 + 할당 상위 + 쪼들림.
 *
 * 세 가지를 한 줄에 같이 둔다. 따로 있으면 시각을 맞춰 보느라 사람이 품을 들이고,
 * 그 품 때문에 안 보게 된다.
 *
 * ⚠️ 여기서 던지면 안 된다 — 진단이 서버를 흔들면 본말이 뒤집힌다. 전부 삼킨다.
 */
async function noteStall(maxMs: number): Promise<void> {
  try {
    const [{ liveRoutes }, { pressure }, { heapWho }] = await Promise.all([
      import("./routeStats.js"),
      import("./recovery.js"),
      import("./heapWho.js"),
    ]);
    const p = pressure();
    const 도는것 = liveRoutes(6);
    const who = await heapWho(5).catch(() => null);
    const 길 = 도는것.length > 0 ? 도는것.map((r) => `${r.길}(${r.초}s)`).join(" · ") : "없음";
    const 먹은이 =
      who?.그사이 && who.그사이.length > 0
        ? who.그사이.slice(0, 3).map((r) => `${r.MB}MB ${r.곳}`).join(" · ")
        : "(못 쟀다)";
    noteLife(
      "WARN",
      `멈춤 ${Math.round(maxMs / 100) / 10}초 — 쪼들림 ${Math.round(p.비율 * 100)}%(${p.무엇}, 남은 램 ${p.남은램MB}MB) · 도는 길목: ${길} · 할당: ${먹은이}`,
    );
  } catch {
    /* 진단이 실패해도 서버는 돈다 */
  }
}

/** 창 하나(1분) 동안의 최고 지연 ms — health.json 이 읽어 간다 */
let lastMaxMs = 0;
let lastMeanMs = 0;
/** 오늘 1초를 넘긴 횟수 */
let stalls = 0;

export function startLoopLag(): void {
  h.enable();
  const timer = setInterval(() => {
    const maxMs = h.max / 1e6;
    const meanMs = h.mean / 1e6;
    h.reset();
    lastMaxMs = Math.round(maxMs);
    lastMeanMs = Math.round(meanMs * 10) / 10;
    /*
     * 1초. 사람이 「멈췄다」고 느끼는 자리이고, 평소 지연은 한 자리 ms 라 오탐이 없다.
     * 넘으면 그 순간의 메모리도 같이 적는다 — GC 때문인지 가르려면 둘이 같이 있어야 한다.
     */
    if (lastMaxMs >= 1000) {
      stalls += 1;
      const mem = process.memoryUsage();
      noteLife(
        "WARN",
        `루프멈춤 최대 ${lastMaxMs}ms · 평균 ${lastMeanMs}ms · heap ${Math.round(mem.heapUsed / 1048576)}/${Math.round(mem.heapTotal / 1048576)}MB`,
      );
      /*
       * **크게 멈추면 그 순간의 범인 후보까지 적는다** (2026-11-16 — 벤티지가 고른 것:
       * "느려질 때 자동으로 기록").
       *
       * 위 한 줄로는 「멈췄다」까지만 안다. 정작 **무엇이 돌고 있었고 누가 할당했는지**는
       * 어디에도 안 남아서, 길목 최대값이 `/list-track` 79,133ms · `/super` 79,126ms 로
       * **나란히** 찍혀 있어도 그 공통 벽이 무엇인지 물을 자리가 없었다.
       *
       * 문턱을 5초로 둔 까닭: 1초 멈춤은 하루에도 여러 번이라 그때마다 적으면 로그가
       * 불어나고, 5초는 사람이 「멈췄다」를 넘어 **「고장났나」로 느끼는 자리**다.
       */
      if (lastMaxMs >= 5000) void noteStall(lastMaxMs);
    }
  }, 60_000);
  timer.unref?.();
}

export function loopLagStats(): { 최고지연ms: number; 평균지연ms: number; 멈춤횟수: number } {
  return { 최고지연ms: lastMaxMs, 평균지연ms: lastMeanMs, 멈춤횟수: stalls };
}
