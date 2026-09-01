import type { KiwoomClient } from "./kiwoomClient.js";
import { buildCloses } from "./dailyCloses.js";
import { collectProgress, startCollectDaily } from "./collectDaily.js";
import { ledgerStatus } from "./dailyStore.js";
import { sendTelegram } from "./telegram.js";

/**
 * **전종목 일별 수집 — 마감 뒤 하루 한 번** (2026-09-01).
 *
 * 벤티지: "지금 로직상에 수집하는 모든것 전종목 기준으로 데이터 다 받아."
 *
 * ## 왜 밤에 도나
 *
 * 종목당 5콜 × 2,444종목 = **약 41분**이고 그동안 키움 한도를 거의 다 쓴다.
 * 장중에 돌리면 신호등·시세분석·알림이 다 느려진다. 그리고 장중 값은 미집계라
 * (대차잔고가 0 으로 온다) 담아 봐야 다시 받아야 한다.
 *
 * ## 시각을 어떻게 맞추나
 *
 * 이 서버의 다른 정기 작업들과 **같은 방식**이다 — `setInterval` + 「지금이 그
 * 시각을 지났나」. cron 을 섞으면 시간대 처리가 두 가지가 된다.
 *
 * 「지났나」로 보는 것이 중요하다. 정각에 딱 맞추면 그 순간 서버가 재시작 중일 때
 * 그날은 영영 안 돈다. 미니PC 가 저녁에 켜져도 그날 수집이 남는다.
 *
 * ## 순서 — 일봉이 먼저다
 *
 * 일봉(`dailyCloses`)은 장세 판정·테마·ETF·전종목 모집단이 전부 쓰는 바탕이다.
 * 그게 낡은 채로 나머지를 받으면, 반은 오늘 것이고 반은 어제 것인 상태로 하루를
 * 보낸다. 일봉을 먼저 끝내고 그다음에 수급·공매도를 받는다.
 *
 * ## 한도 알림
 *
 * 벤티지: "최대 2년치로 설정하고 2년 되는날 나한테 알려줘 리셋할건지 백업할건지."
 *
 * 한 바퀴가 끝나면 현황을 재서, 한도의 90% 를 넘었으면 **텔레그램으로 알린다.**
 * 자동 삭제는 기본이 꺼져 있다 — 지운 데이터는 다시 받을 수 없으므로(키움은 과거
 * 수급을 100일치쯤만 준다) **사람이 정하는 편이 맞다.**
 */

const TICK_MS = 5 * 60_000;

/**
 * **17:30 KST** — 마감 뒤이면서, 앞의 작업들과 **안 겹치는** 시각.
 *
 * ⚠️ 처음엔 16:10 으로 뒀다가 고쳤다. 그 시각에 이미 둘이 돌고 있었다:
 *
 *   15:40  신호등 추적기
 *   15:45  슈퍼신호등
 *   16:10  장세 점검
 *   16:30  **신호등 분석** — 목록 전부 500씩, 합집합 1,200~1,800종목, **40분**
 *   18:30  표본 재수집(오래됐으면)
 *
 * 16:10 에 시작하면 41분짜리 수집이 16:30 의 신호등 분석과 **20분간 겹친다.**
 * 둘 다 키움 조회를 초당 한도까지 먹는 작업이라, 겹치면 서로 느려지고 429 가 난다.
 *
 * 17:30 이면 신호등 분석(16:30~17:10)이 끝난 뒤이고, 41분이 걸려도 18:11 에
 * 끝나 18:30 표본 재수집과도 안 겹친다.
 */
const START_HHMM = 17 * 60 + 30;

/**
 * **일봉 갱신 — 16:00.** 뒤에 오는 것들이 전부 이걸 바탕으로 돈다.
 *
 * ⚠️ **자동으로 안 돌고 있었다** (2026-09-01 발견). `buildCloses` 를 부르는 곳이
 * 화면 라우트뿐이라, 누가 그 화면을 열어야만 갱신됐다. 그런데:
 *
 *   16:10  장세 점검     ← 전종목 20일선 위 비율. **일봉으로 낸다**
 *   16:30  신호등 분석   ← 테마·ETF 뒷배 렌즈가 **일봉 캐시를 쓴다**
 *
 * 둘 다 낡은 일봉으로 돌고 있었을 수 있다. **어제 종가로 오늘을 채점**한 셈이다.
 * 조용한 종류의 오류라 화면만 봐서는 알 수 없다.
 *
 * 16:00 인 이유: 장 마감(15:30) 뒤라 종가가 확정됐고, 전종목 2,444콜에 약 9분이라
 * 16:09 에 끝나 **16:10 장세 점검 직전**에 맞는다.
 */
const BARS_HHMM = 16 * 60;

let timer: ReturnType<typeof setInterval> | null = null;
/** 이번 프로세스에서 끝낸 날 — 하루 한 번만 */
let doneDay = "";
let doneBars = "";
let warnedDay = "";

function kst(at = Date.now()): Date {
  const d = new Date(at);
  return new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
}

function dayKey(at = Date.now()): string {
  return kst(at).toISOString().slice(0, 10);
}

/** 평일이고 그 시각을 지났나 — 주말은 쉰다 */
function past(hhmm: number, at = Date.now()): boolean {
  const k = kst(at);
  const day = k.getDay();
  if (day === 0 || day === 6) return false;
  return k.getHours() * 60 + k.getMinutes() >= hhmm;
}

/**
 * 한도가 찼는지 보고 알린다.
 *
 * ⚠️ **하루 한 번만** 알린다. 5분마다 같은 말을 보내면 그다음부터 아무도 안 읽는다.
 */
async function warnIfFull(): Promise<void> {
  const day = dayKey();
  if (warnedDay === day) return;
  const st = await ledgerStatus().catch(() => null);
  if (!st || !st.atLimit) return;
  warnedDay = day;

  const gb = (st.bytes / 1024 / 1024 / 1024).toFixed(2);
  const years = (st.keep / 250).toFixed(1);
  await sendTelegram(
    [
      `📦 <b>일별 원장이 보관 한도에 닿았습니다</b>`,
      ``,
      `쌓인 것 — ${st.codes.toLocaleString("ko-KR")}종목 · ${gb}GB`,
      `가장 긴 원장 ${st.maxDays}거래일 (한도 ${st.keep}일 ≈ ${years}년) · <b>${st.fullPct}%</b>`,
      st.from && st.to ? `${st.from} ~ ${st.to}` : "",
      ``,
      st.trim
        ? `자동 삭제가 <b>켜져</b> 있습니다 — 한도를 넘으면 앞에서부터 지웁니다.`
        : `자동 삭제는 <b>꺼져</b> 있습니다. 지금은 계속 쌓이기만 합니다.`,
      ``,
      `<b>정해야 할 것</b> — 백업할지, 리셋할지, 한도를 늘릴지.`,
      `한도는 <code>VNTG_DAILY_KEEP</code>(거래일, 최대 1300 ≈ 5년),`,
      `자동 삭제는 <code>VNTG_DAILY_TRIM=1</code> 로 켭니다.`,
      ``,
      `⚠️ 지운 데이터는 <b>다시 못 받습니다</b> — 키움이 과거 수급을 100일치쯤만 줍니다.`,
    ]
      .filter((l) => l !== "")
      .join("\n"),
  ).catch(() => undefined);
}

export function startCollectScheduler(client: KiwoomClient): void {
  if (timer) return;

  const tick = async () => {
    const day = dayKey();

    /*
     * ① **16:00 일봉** — 뒤에 오는 것들(16:10 장세 점검, 16:30 신호등 분석)이
     * 전부 이걸 바탕으로 돈다. 여태 자동으로 안 돌고 있었다.
     */
    if (doneBars !== day && past(BARS_HHMM)) {
      doneBars = day;
      await buildCloses(client).catch(() => undefined);
    }

    /* ② 17:30 전종목 일별 수집 — 16:30 신호등 분석(40분)이 끝난 뒤다 */
    if (doneDay !== day && past(START_HHMM) && !collectProgress().running) {
      doneDay = day;
      await startCollectDaily(client).catch(() => undefined);
    }

    await warnIfFull();
  };

  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  /* 켜자마자 한 번 — 저녁에 미니PC 를 켰으면 그날 수집이 바로 돈다 */
  void tick();
}
