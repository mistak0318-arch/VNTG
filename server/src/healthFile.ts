import { afterProbeSnapshot } from "./afterProbe.js";
import { closeBetScanHealth } from "./closeBetScan.js";
import { KiwoomClient } from "./kiwoomClient.js";
import { flowAfterSnapshot } from "./flowAfterProbe.js";
import { hantooFutProbeSnapshot } from "./hantooFutProbe.js";
import { hantooUsRankProbeSnapshot } from "./hantooUsRankProbe.js";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import os from "node:os";
import v8 from "node:v8";
import { lifeSummary, noteLife, selfHeal } from "./lifecycle.js";
import { loadGateStats } from "./loadGate.js";
import { recoveryStats } from "./recovery.js";
import { shareGetStats } from "./shareGet.js";
import { dropSamplesCache } from "./signalSamples.js";
import { peekRealtime, subscribedCount } from "./realtimeHub.js";
import { hantooRealtimeStatus } from "./hantooRealtime.js";
import { hantooQueueDepth } from "./hantooClient.js";
import { afterCloseStatus, afterCloseStateSummary } from "./afterClose.js";
import { tradingDayStatus } from "./tradingDay.js";
import { getUsage } from "./apiUsage.js";
import { cisWhyNotSnapshot } from "./cisWhyNot.js";
import { alertHealthLines } from "./alertHealth.js";
import { getCisConfig } from "./cisConfig.js";
import { streamStats } from "./routes/realtime.js";

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
export const healthFileState: {
  dir: string | null;
  /** 그 경로를 어디서 알았나 — 환경변수인지 자동 탐지인지 */
  source: string | null;
  wrote: number;
  lastOk: string | null;
  lastError: string | null;
} = { dir: null, source: null, wrote: 0, lastOk: null, lastError: null };

/**
 * 어디에 적을까.
 *
 * `HEALTH_OUT_DIR` 이 먼저다. 없으면 **배포 폴더를 스스로 찾는다** — 실측(2026-09-09):
 * 환경변수를 넣었다는데 서버는 `dir: null` 이었다. `server/.env` 가 아닌 다른 자리에
 * 넣으면 안 닿는데, 그걸 사람이 매번 맞추게 할 이유가 없다.
 *
 * ⚠️ **아무 데나 안 쓴다.** 후보 폴더에 `deploy.status` 가 **있을 때만** 그 자리를 쓴다 —
 * 그 파일이 있다는 것은 배포가 실제로 쓰는 폴더라는 증거다. 없으면 아무 일도 안 한다.
 */
let resolved: string | null | undefined;

async function findDir(): Promise<string | null> {
  const fromEnv = (process.env.HEALTH_OUT_DIR ?? "").trim();
  if (fromEnv) return fromEnv;
  for (const c of ["C:\\vntg-deploy", "D:\\vntg-deploy", "/vntg-deploy"]) {
    try {
      await stat(join(c, "deploy.status"));
      return c;
    } catch {
      /* 그 자리가 아니다 */
    }
  }
  return null;
}

async function outDir(): Promise<string> {
  if (resolved === undefined) {
    resolved = await findDir();
    healthFileState.dir = resolved;
    healthFileState.source = process.env.HEALTH_OUT_DIR?.trim() ? "환경변수" : resolved ? "배포 폴더 자동 탐지" : null;
  }
  return resolved ?? "";
}

/**
 * 메모리·생애 — health 에 실을 숫자 몇 개 (2026-10-07).
 *
 * `rss` 가 프로세스가 실제로 쓰는 메모리, `heap` 이 V8 안쪽이다. 노드 기본 heap 상한은 시스템 메모리로 정해지는데,
 * 그 선에 닿아 죽는 것이 OOM 이다 — `heapLimit` 을 같이 적어야 「상한에 닿아서 죽었나」를 나중에 판정할 수 있다.
 * rss 가 상한의 85% 를 넘으면 `lifecycle.log` 에 경고 한 줄을 남긴다 — 죽기 전에 흔적을 만들어 두는 것이다.
 */
let peakRss = 0;
let warnedAt = 0;
/**
 * **한 시간에 한 줄, 몸무게를 적는다** (2026-10-07 — 벤티지: "추이를 보고 하자").
 *
 * `health.json` 은 30초마다 **덮어쓰므로** 과거가 안 남고, `최고rss` 는 이번 생애의 값이라 재시작하면 0 으로 돌아간다.
 * 그래서 「요즘 늘고 있나」를 볼 자리가 어디에도 없었다 — 상한을 올린 것이 시간을 번 조치인 이상, 그 시간이
 * 얼마나 남았는지는 추이로만 안다. `lifecycle.log` 에 시간마다 한 줄이면 하루 24줄, 2MB 회전 안에서 몇 달이 쌓인다.
 */
let memHour = -1;
function noteHourlyMem(): void {
  const h = new Date(Date.now() + 9 * 3600_000).getUTCHours();
  if (h === memHour) return;
  memHour = h;
  noteLife("MEM", `최고rss=${Math.round(peakRss / 1048576)}MB`);
}

function processStats(): Record<string, unknown> {
  const m = process.memoryUsage();
  const mb = (n: number) => Math.round(n / 1048576);
  peakRss = Math.max(peakRss, m.rss);
  const limit = (() => {
    try {
      /* heap 상한 — v8 모듈은 동기이고 싸다 */
      return mb(v8.getHeapStatistics().heap_size_limit);
    } catch {
      return 0;
    }
  })();
  /* 숨이 가빠지면 스스로 손을 쓴다 — 캐시를 놓고, 그래도 안 되면 깨끗이 내려간다 (lifecycle.selfHeal) */
  /*
   * ⚠️ **일봉 캐시는 놓지 않는다** (2026-10-07 — 넣자마자 거둬들인 조항).
   * 놓으면 다음 요청이 84MB 를 다시 읽고 파싱하는데, 그게 **이벤트 루프를 몇 초 막는다.** 그동안 health 가
   * 대답을 못 해 감시자가 죽은 줄 알고 끊고, 다시 뜨면 또 파싱하고 — 메모리를 아끼려다 맴돌이를 만든다.
   * 메모리 폭주의 진짜 원인은 캐시가 아니라 **동시 파싱**이었고 그건 단일 비행으로 막았다.
   * 여기서는 다시 읽어도 싼 표본(38MB)만 놓는다.
   */
  /*
   * ⚠️ `selfHeal` 은 **더 이상 여기서 안 부른다** (2026-10-07 밤).
   *
   * 복구를 `recovery.ts` 가 맡게 하면서, 이 자리는 **상태를 바꾸지 않고 적기만** 한다.
   * 재시작을 결정하는 곳이 둘이면 서로 싸운다 — 감시자와 `start-prod.cmd` 가 그랬고
   * 그때도 「책임은 한 곳에」로 풀었다. 게다가 이 함수는 health.json 을 쓸 때만 불려서
   * 주기가 들쭉날쭉했고, 복구는 **3초마다 또박또박** 봐야 한다.
   */
  noteHourlyMem();
  return {
    rssMB: mb(m.rss),
    최고rssMB: mb(peakRss),
    heapUsedMB: mb(m.heapUsed),
    heapTotalMB: mb(m.heapTotal),
    heap상한MB: limit,
    /* 이 기계가 가진 메모리 — 상한을 얼마까지 올려도 되는지 판단할 근거 (2026-10-07) */
    램MB: Math.round(os.totalmem() / 1048576),
    남은램MB: Math.round(os.freemem() / 1048576),
    pid: process.pid,
    런처: (process.env.VNTG_LAUNCHER ?? "직접").trim(),
    ...lifeSummary(),
  };
}

let writing = false;
async function writeOnce(): Promise<void> {
  /* 공유 폴더가 30초보다 느리면 두 틱이 같은 tmp 를 쓴다 (2026-09-16 점검) — 앞 것이 끝나기 전엔 안 쓴다 */
  if (writing) return;
  writing = true;
  try {
    await writeOnceInner();
  } finally {
    writing = false;
  }
}
async function writeOnceInner(): Promise<void> {
  const dir = await outDir();
  if (!dir) return;

  const { client: rt, store } = peekRealtime();
  const us = hantooRealtimeStatus();
  const ac = afterCloseStatus();
  const health = store?.health ?? null;

  const body = {
    at: new Date().toISOString(),
    /* 서버가 언제 떴나 — 「방금 재시작했다」와 「하루째 돈다」는 다른 이야기다 */
    uptimeSec: Math.round(process.uptime()),
    /*
     * **죽기 직전의 몸무게** (2026-10-07). 30초마다 덮어쓰므로 서버가 죽으면 **마지막 30초 안의 값**이 남는다 —
     * 메모리가 치솟다 갔는지(OOM), 멀쩡하다 갔는지(예외·강제종료)를 가르는 유일한 단서다.
     * 숫자만 적는다(계좌·종목·키 없음). `최고` 는 이번 생애의 최대치.
     */
    프로세스: processStats(),
    /*
     * 과부하 관문 (2026-10-07 밤) — **「되돌려보냄」이 늘면 손볼 때다.**
     * 0 이면 관문이 하는 일 없이 지나가는 것이고, 꾸준히 늘면 ①heap 상한 ②동시 실행 수
     * ③큰 파일을 통째로 드는 것 — 셋 중 하나를 다시 봐야 한다.
     */
    과부하관문: loadGateStats(),
    /*
     * 복구 루틴 (2026-10-07 밤) — 「지금 어떤 상태인가」와 「몇 번 복구했나」.
     * `상태` 가 자주 「복구」면 봉우리가 구조적으로 큰 것이고, `GC가능: false` 면
     * `--expose-gc` 가 빠진 것이라 복구가 반쪽으로 돈다.
     */
    복구: recoveryStats(),
    /*
     * 같은 조회를 겹쳐서 아낀 건수 (2026-10-08). `/api/sys/mem` 에만 넣었다가 **여기 빠뜨려서**
     * 밖에서 효과를 확인할 수가 없었다 — 계기판은 두 곳이 같은 것을 적어야 한다.
     */
    합치기: shareGetStats(),
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
      /* 첫 토큰이 심볼(tr_key)이라 뗀다 — 오류코드·메시지만 남긴다. 이 파일엔 종목이 안 실린다 */
      rejects: us.rejects.slice(0, 3).map((l) => l.split(" ").slice(1).join(" ")),
    },
    /*
     * **오늘을 거래일로 보나** (2026-09-21). 스케줄러 열셋이 이 한 줄에 매달려 있는데, 거짓이면 아무 자국도
     * 안 남기고 그날이 빈다 — 「일본 증시 휴장」 한 줄로 저녁이 다 날아간 날이 있었다. 밖에서 바로 보이게.
     */
    거래일: tradingDayStatus(),
    /*
     * **무엇이 조회를 먹고 있나** (2026-09-22 — 벤티지: "오늘 새로고침 왜이렇게 느린거야?" ·
     * "지금 쓰기가 불편해졋어 속도도 느리고 갱신도 안되고").
     *
     * 키움 토큰버킷이 초당 4.5인데 초당 6~12 가 나가 줄이 끝없이 길어졌다. 그런데 **무엇이
     * 그러는지 밖에서 볼 길이 없었다** — 화면의 「API 사용량」 탭에만 있어서 사람에게 찍어 달라고
     * 해야 했다. 오늘치 TR별 상위 여덟 개를 여기 싣는다. 개수뿐 — 종목·계좌는 없다.
     */
    조회상위: await getUsage()
      .then((u) => {
        const k = u.providers.find((p) => p.provider === "kiwoom");
        return k
          ? {
              오늘합계: k.total,
              실패: k.failed,
              한도초과: k.rateLimited,
              상위: k.topEndpoints.slice(0, 10).map((e) => `${e.endpoint} ${e.count}`),
            }
          : null;
      })
      .catch(() => null),
    /*
     * **알림 갈래가 켜져 있나** (2026-09-22). 키워드 알림이 한 달 동안 안 왔는데 원인이 「벤티지가
     * 꺼 놓은 것」이었다 — 밖에서 「꺼짐」과 「고장」이 구분이 안 돼 코드를 한참 뒤졌다. 상태만 싣는다.
     */
    알림: await alertHealthLines(),
    /*
     * **항해일지가 오늘 왜 안 샀나** (2026-09-21 — 벤티지: "얘는 매매도 안하고 돈도 못벌고 이상해서").
     * 사유와 개수뿐 — 종목·금액은 안 싣는다. 켜져 있는지(`enabled`)도 같이 보여야 「안 돈 것」과 구분된다.
     */
    항해일지: {
      ...(await getCisConfig()
        .then((c) => ({ 켜짐: c.enabled, 자동: c.auto, 매수루프분: c.buyScanMin }))
        .catch(() => ({ 켜짐: null }))),
      ...cisWhyNotSnapshot(),
    },
    저장소: health,
    /* 키움 REST 토큰버킷에서 기다린 것 — 개수·ms 뿐 (2026-09-16). 크면 15:40~16:10 겹침이 그만큼이다 */
    /* `줄` 은 **지금 통 앞에 선 수** — 이게 수십이면 화면이 느린 이유가 메모리가 아니라 조회 적체다 (2026-10-07) */
    키움조회대기: { ...KiwoomClient.rateLimitStats(), 줄: KiwoomClient.queueDepth() },
    /* 한투는 초당 2.5건짜리 한 줄이다 — 느린 카드(재무·목표주가·신호등 근거·야간선물)가 전부 여기 선다 */
    한투조회줄: hantooQueueDepth(),
    /* 화면이 실시간을 실제로 받아 가고 있나 — 미니창이 따로 여는 스트림이 여기 잡힌다 */
    화면스트림: {
      open: streamStats.open,
      opened: streamStats.opened,
      keyCounts: streamStats.keyCounts,
      lastSentAt: streamStats.lastSentAt,
      refused: streamStats.refused,
    },
    마감뒤정리: ac
      ? { day: ac.day, running: ac.running, at: ac.at, step: `${ac.stepNo ?? 0}/${ac.stepTotal ?? 0}`, 실패: ac.steps.filter((s) => !s.ok).map((s) => s.label) }
      : null,
    /* 도는 중이 아닐 때도 「오늘 돌았나·언제 끝났나·무엇이 실패했나」 — 날짜·단계 이름뿐 (2026-09-16) */
    마감뒤정리_상태: await afterCloseStateSummary().catch(() => null),
    /*
     * 애프터마켓 관측창 (2026-09-14) — 첫날 실측 넷을 밖에서 보려고. **분류 값과 개수뿐**이다 —
     * 종목·계좌·키는 한 글자도 안 실린다(`afterProbe.ts` 가 애초에 코드를 안 받는다).
     * 서버가 다시 뜬 뒤부터 센다 — 그 전 시간대 칸은 비어 있는 것이 맞다.
     */
    애프터관측: await afterProbeSnapshot().catch(() => null),
    /*
     * 종배 스캔 (2026-09-15) — 15:40 회차가 돌았나를 밖에서 보려고. **개수와 시각뿐** — 종목 이름·코드는
     * 안 싣는다(초록 목록 자체는 서버 파일에만 있다).
     */
    종배스캔: await closeBetScanHealth().catch(() => null),
    /* 수급에 애프터가 들어가나 (2026-09-15) — 회차마다 달라진 종목 **수**만 */
    수급애프터: flowAfterSnapshot(),
    /* 해외선물 키2 시험 (2026-09-15) — 된다/사유 문장뿐. 키·계좌·값은 없다 */
    해외선물시험: hantooFutProbeSnapshot(),
    한투해외순위시험: hantooUsRankProbeSnapshot(),
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
  void (async () => {
    const dir = await outDir();
    if (!dir) {
      console.log("[상태파일] 쓸 자리를 못 찾아 꺼짐 (HEALTH_OUT_DIR 또는 deploy.status 가 있는 폴더)");
      return;
    }
    await writeOnce();
    setInterval(() => void writeOnce(), EVERY_MS);
    console.log(`[상태파일] ${dir} 에 30초마다 health.json (${healthFileState.source})`);
  })();
}
