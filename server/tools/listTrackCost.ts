/**
 * **`/list-track` 한 번이 메모리를 얼마나 쓰나** (2026-10-10).
 *
 * 10/09 `lifecycle.log`: `GET /list-track` 449번, 합 60GB, 한 번에 최고 1.9GB.
 * 그 1.9GB 가 **어디서** 나오는지를 가른다 — 원장 파싱인가, 테마 강도인가, 나머지인가.
 * 짐작으로 고치면 엉뚱한 데를 고친다.
 *
 *   npx tsx tools/listTrackCost.ts
 *
 * ⚠️ 서버를 띄우지 않는다. 같은 앱키로 실시간 소켓을 또 붙이면 미니PC 것이 끊긴다.
 * 파일만 읽는 함수들이라 그대로 불러도 된다(조회 0회).
 */
import "dotenv/config";
import { listTrackSummary } from "../src/listTrack.js";
import { themeMapNow } from "../src/stockLens.js";

const gc = globalThis.gc as (() => void) | undefined;
const mb = (n: number) => Math.round(n / 1048576);

async function measure(label: string, fn: () => Promise<unknown>, times = 3) {
  /* 재기 전에 치운다 — 앞사람이 남긴 쓰레기를 이 사람 몫으로 세면 안 된다 */
  gc?.();
  await new Promise((r) => setTimeout(r, 50));
  const before = process.memoryUsage();
  const t0 = Date.now();
  let peak = before.heapUsed;
  for (let i = 0; i < times; i++) {
    await fn();
    peak = Math.max(peak, process.memoryUsage().heapUsed);
  }
  const ms = Date.now() - t0;
  const after = process.memoryUsage();
  gc?.();
  await new Promise((r) => setTimeout(r, 50));
  const settled = process.memoryUsage();
  console.log(
    `${label.padEnd(26)} ${times}회 · ${String(Math.round(ms / times)).padStart(5)}ms/회 · ` +
      `봉우리 +${String(mb(peak - before.heapUsed)).padStart(4)}MB · ` +
      `끝나고 +${String(mb(after.heapUsed - before.heapUsed)).padStart(4)}MB · ` +
      `치운 뒤 +${String(mb(settled.heapUsed - before.heapUsed)).padStart(4)}MB`,
  );
}

console.log(`시작 heap ${mb(process.memoryUsage().heapUsed)}MB · gc ${gc ? "쓸 수 있음" : "없음(--expose-gc 로 돌리세요)"}`);
console.log("");

/* 첫 호출은 파일을 처음 읽어 캐시를 채우는 몫이 섞인다 — 따로 적는다 */
await measure("① 첫 호출 (캐시 채움)", () => listTrackSummary(), 1);
await measure("② 테마 강도만", () => themeMapNow(), 3);
await measure("③ 요약 (캐시 더운 뒤)", () => listTrackSummary(), 3);

console.log("");
console.log(`끝 heap ${mb(process.memoryUsage().heapUsed)}MB`);
process.exit(0);
