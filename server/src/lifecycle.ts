import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * **서버가 언제 뜨고 언제 죽었나** (2026-10-07 — 벤티지: "오늘 PC에서 작업하다가 서버가 몇번 죽었어. 이유 좀 찾아봐").
 *
 * ## 왜 필요했나
 *
 * 10/6 밤에 서버가 10분 간격으로 몇 번이나 죽었는데 **왜 죽었는지 볼 자리가 한 군데도 없었다.**
 * 작업 스케줄러가 `node dist\index.js` 를 띄우면서 stdout·stderr 를 아무 데도 안 보냈기 때문이다 —
 * `index.ts` 의 `uncaughtException` 핸들러가 `console.error` 로 아무리 적어도 허공이었고, 미니PC 의
 * 이벤트 로그는 밖에서 못 읽는다(원격 조회 권한 거부, 실측). 남은 흔적은 `health.json` 의 `uptimeSec` 하나뿐이라
 * 「방금 재시작됐다」만 알 수 있고 사인은 영영 모른다.
 *
 * ## 무엇을 적나
 *
 * 배포 폴더(`C:\vntg-deploy`)의 `lifecycle.log` 에 **한 줄씩**. 그 폴더는 SMB 로 공유돼 있어 밖에서 바로 읽힌다 —
 * 미니PC 에 들어가지 않고도 「오늘 몇 번 죽었나 · 각각 몇 분 살았나 · 마지막 말이 무엇이었나」를 본다.
 *
 *   START  뜰 때      pid·노드판·런처·커밋
 *   EXIT   정상 종료   종료코드 (배포의 `schtasks /End` 도 여기로 온다)
 *   FATAL  예외        스택 앞부분
 *   WARN   거부·경고   메모리 임계 넘김 등
 *
 * ## 동기(sync)로 적는다
 *
 * 죽는 순간에 적는 글이라 비동기면 못 남는다. 한 줄 append 라 블로킹이 문제될 양이 아니다.
 * 적는 자리를 못 찾거나 실패하면 **조용히 포기한다** — 로그를 남기려다 서버를 죽이면 본말전도다.
 */

const FILE = "lifecycle.log";
/** 2MB 넘으면 뒤 절반만 남긴다 — 자동 재시작이 걸리면 줄이 빨리 는다 */
const MAX_BYTES = 2 * 1024 * 1024;

let dirCache: string | null | undefined;

/** `healthFile.ts` 와 같은 규칙 — `deploy.status` 가 있는 폴더만 쓴다(아무 데나 안 적는다) */
function outDir(): string | null {
  if (dirCache !== undefined) return dirCache;
  const fromEnv = (process.env.HEALTH_OUT_DIR ?? "").trim();
  const cands = fromEnv ? [fromEnv] : ["C:\\vntg-deploy", "D:\\vntg-deploy", "/vntg-deploy"];
  dirCache = null;
  for (const c of cands) {
    try {
      statSync(join(c, "deploy.status"));
      dirCache = c;
      break;
    } catch {
      /* 그 자리가 아니다 */
    }
  }
  return dirCache;
}

function kst(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().replace("T", " ").slice(0, 19);
}

function rotate(path: string): void {
  try {
    if (statSync(path).size <= MAX_BYTES) return;
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.slice(Math.floor(text.length / 2)), "utf8");
  } catch {
    /* 못 자르면 그냥 둔다 */
  }
}

export type LifeKind = "START" | "EXIT" | "FATAL" | "WARN" | "MEM";

/** 한 줄 남긴다. 어떤 이유로든 실패하면 조용히 넘어간다 */
export function noteLife(kind: LifeKind, note: string): void {
  const dir = outDir();
  if (!dir) return;
  const path = join(dir, FILE);
  try {
    mkdirSync(dir, { recursive: true });
    rotate(path);
    const mem = process.memoryUsage();
    const mb = (n: number) => Math.round(n / 1048576);
    const line =
      `${kst()} ${kind.padEnd(5)} pid=${process.pid} up=${Math.round(process.uptime())}s ` +
      `rss=${mb(mem.rss)}MB heap=${mb(mem.heapUsed)}/${mb(mem.heapTotal)}MB ${note.replace(/\s+/g, " ").slice(0, 400)}\n`;
    appendFileSync(path, line, "utf8");
  } catch {
    /* 로그 때문에 서버가 멈추면 안 된다 */
  }
}

/**
 * 지난 생애를 들춰 본다 — 화면이 「오늘 N번 죽었다」를 말할 수 있게.
 * 파일이 없으면 빈 값. 읽기 실패도 빈 값(이 값 때문에 health 쓰기가 깨지면 안 된다).
 */
export function lifeSummary(): { 오늘재시작: number; 마지막사망: string | null; 마지막사유: string | null } {
  const dir = outDir();
  const empty = { 오늘재시작: 0, 마지막사망: null, 마지막사유: null };
  if (!dir) return empty;
  try {
    const today = kst().slice(0, 10);
    const lines = readFileSync(join(dir, FILE), "utf8").trim().split("\n");
    let starts = 0;
    let lastDeath: string | null = null;
    let lastWhy: string | null = null;
    for (const l of lines) {
      if (!l.startsWith(today)) continue;
      if (l.includes(" START ")) starts += 1;
      if (l.includes(" FATAL ") || l.includes(" EXIT ")) {
        lastDeath = l.slice(0, 19);
        lastWhy = l.slice(20, 200);
      }
    }
    /* 첫 기동도 START 하나라 「재시작」은 그보다 하나 적다 */
    return { 오늘재시작: Math.max(0, starts - 1), 마지막사망: lastDeath, 마지막사유: lastWhy };
  } catch {
    return empty;
  }
}

/**
 * 프로세스 생애 훅을 건다 — `index.ts` 맨 위에서 한 번.
 *
 * ⚠️ **종료를 막지 않는다.** `exit` 는 동기 작업만 할 수 있으므로 여기 적는 것도 동기다.
 * OOM(V8 heap out of memory)은 이 훅이 돌 틈도 없이 죽는다 — 그때는 `START` 뒤에 아무 줄도 없고,
 * `start-prod.cmd` 가 받아 둔 `server.log` 의 `FATAL ERROR ... heap out of memory` 로 가린다.
 */
export function installLifecycleHooks(): void {
  const launcher = (process.env.VNTG_LAUNCHER ?? "직접").trim();
  /* 어느 코드로 떠 있나 — 배포가 적어 둔 해시를 그대로 읽는다(둘째 줄) */
  let commit = "";
  try {
    const d = outDir();
    if (d) commit = (readFileSync(join(d, "deploy.status"), "utf8").split("\n")[1] ?? "").trim();
  } catch {
    /* 없으면 안 적는다 */
  }
  noteLife("START", `node=${process.version} launcher=${launcher} commit=${commit} tz=${process.env.TZ ?? ""}`);

  let bye = false;
  const once = (kind: LifeKind, note: string) => {
    if (bye) return;
    bye = true;
    noteLife(kind, note);
  };
  process.on("exit", (code) => once("EXIT", `code=${code}`));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"] as const) {
    process.on(sig, () => {
      once("EXIT", `signal=${sig}`);
      process.exit(0);
    });
  }
}
