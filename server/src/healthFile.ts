import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { peekRealtime, subscribedCount } from "./realtimeHub.js";
import { hantooRealtimeStatus } from "./hantooRealtime.js";
import { afterCloseStatus } from "./afterClose.js";

/**
 * **상태를 파일로 떨군다** (2026-09-09).
 *
 * 벤티지: "클라우드 서비스 토큰 너한테 발급해 주면 보안의 이슈는 없는 거야?"
 *
 * 있다 — 그 토큰은 이메일 로그인을 건너뛰는 열쇠라, 진단용 두 줄을 보려고 **앱 전체**
 * (잔고·포지션·매매 기록)에 닿는 문을 여는 셈이다. 게다가 어딘가 저장돼야 하는데 그 자리가
 * 깃이든 로그든 벤티지가 통제할 수 없는 곳이다. 얻는 것은 편의뿐이라 거래가 안 맞는다.
 *
 * 그래서 **자격증명 없는 길**로 간다. 배포 깃발을 주고받는 공유 폴더는 이미 우리 둘만 닿는
 * 자리다 — 서버가 거기에 상태를 적어 두면 새 열쇠도, 바깥으로 열리는 문도 없이 상태가 보인다.
 *
 * ## 무엇을 적나 — **진단에 필요한 것만**
 *
 * 소켓이 붙었나 · 자리가 몇이나 남았나 · 프레임이 오나 · 마감 정리가 어디까지 갔나.
 * **계좌·잔고·종목·키는 한 줄도 안 적는다.** 이 파일은 「무엇이 고장났나」를 말하는 자리지
 * 데이터를 옮기는 자리가 아니다. 파일이 어디로 새더라도 잃을 것이 없어야 한다.
 *
 * `HEALTH_OUT_DIR` 이 없으면 아무 일도 안 한다 — 배포본에서만 켜진다.
 */

const FILE = "health.json";
const EVERY_MS = 30_000;

/**
 * **왜 안 써졌나** (2026-09-09). 처음 붙였을 때 파일이 안 생겼는데 이유를 볼 길이 없었다 —
 * 실패를 조용히 삼키고 있었기 때문이다. 배포 로그에 찍히는 `/api/health` 에 이걸 실어
 * 밖에서 원인을 읽을 수 있게 한다. 경로만 적고 **값은 안 적는다**(경로는 비밀이 아니다).
 */
export const healthFileState: { dir: string | null; wrote: number; lastOk: string | null; lastError: string | null } = {
  dir: null,
  wrote: 0,
  lastOk: null,
  lastError: null,
};

function outDir(): string {
  return (process.env.HEALTH_OUT_DIR ?? "").trim();
}

async function writeOnce(): Promise<void> {
  const dir = outDir();
  if (!dir) return;

  const { client: rt, store } = peekRealtime();
  const us = hantooRealtimeStatus();
  const ac = afterCloseStatus();
  const health = store?.health ?? null;

  const body = {
    at: new Date().toISOString(),
    /* 서버가 언제 떴나 — 「방금 재시작했다」와 「하루째 돈다」는 다른 이야기다 */
    uptimeSec: Math.round(process.uptime()),
    국내실시간: rt
      ? {
          state: rt.state,
          healthy: rt.healthy,
          subscribed: subscribedCount(),
          seats: rt.seats,
          /* 자리가 없어 못 건 구독 — 0 이 아니면 정원 배분이 틀린 것이다 */
          seatRefusals: rt.seatRefusals,
          lastRefused: rt.lastRefused,
          regErrors: rt.registrationErrors.slice(-3),
        }
      : { state: "안 붙음" },
    해외실시간: {
      state: us.state,
      subscribed: us.subscribed.length,
      frames: us.frames,
      lastFrameAgoSec: us.lastFrameAgoSec,
      connectedForSec: us.connectedForSec,
      rejects: us.rejects.slice(0, 3),
    },
    저장소: health,
    마감뒤정리: ac
      ? { day: ac.day, running: ac.running, at: ac.at, step: `${ac.stepNo ?? 0}/${ac.stepTotal ?? 0}`, 실패: ac.steps.filter((s) => !s.ok).map((s) => s.label) }
      : null,
  };

  try {
    await mkdir(dir, { recursive: true });
    const tmp = join(dir, `${FILE}.tmp`);
    await writeFile(tmp, JSON.stringify(body, null, 2), "utf8");
    await rename(tmp, join(dir, FILE));
    healthFileState.wrote += 1;
    healthFileState.lastOk = new Date().toISOString();
    healthFileState.lastError = null;
  } catch (e) {
    /* 공유가 잠깐 끊겨도 서버는 계속 돈다 — 다만 **왜 안 됐는지는 남긴다** */
    healthFileState.lastError = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 200) : String(e).slice(0, 200);
  }
}

export function startHealthFile(): void {
  healthFileState.dir = outDir() || null;
  if (!outDir()) {
    console.log("[상태파일] HEALTH_OUT_DIR 이 없어 꺼짐");
    return;
  }
  void writeOnce();
  setInterval(() => void writeOnce(), EVERY_MS);
  console.log(`[상태파일] ${outDir()} 에 30초마다 health.json`);
}
