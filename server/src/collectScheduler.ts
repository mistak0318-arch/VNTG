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

/** 마감 뒤 — 16:10 KST. 대차·공매도 집계가 끝난 뒤라야 확정값이 온다 */
const START_HHMM = 16 * 60 + 10;

let timer: ReturnType<typeof setInterval> | null = null;
/** 이번 프로세스에서 끝낸 날 — 하루 한 번만 */
let doneDay = "";
let warnedDay = "";

function kst(at = Date.now()): Date {
  const d = new Date(at);
  return new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
}

function dayKey(at = Date.now()): string {
  return kst(at).toISOString().slice(0, 10);
}

/** 오늘 수집할 날인가 — 주말은 쉰다 */
function shouldRun(at = Date.now()): boolean {
  const k = kst(at);
  const day = k.getDay();
  if (day === 0 || day === 6) return false;
  return k.getHours() * 60 + k.getMinutes() >= START_HHMM;
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
    if (doneDay === day) {
      await warnIfFull();
      return;
    }
    if (!shouldRun()) return;
    if (collectProgress().running) return;

    /*
     * **일봉이 먼저다.** 장세·테마·ETF·전종목 모집단이 전부 이걸 바탕으로 돈다 —
     * 반은 오늘 것이고 반은 어제 것인 상태로 하루를 보내면 안 된다.
     */
    await buildCloses(client).catch(() => undefined);
    await startCollectDaily(client).catch(() => undefined);

    doneDay = day;
    await warnIfFull();
  };

  timer = setInterval(() => void tick(), TICK_MS);
  timer.unref?.();
  /* 켜자마자 한 번 — 저녁에 미니PC 를 켰으면 그날 수집이 바로 돈다 */
  void tick();
}
