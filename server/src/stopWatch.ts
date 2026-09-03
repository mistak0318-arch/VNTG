import { getMarketSnapshot } from "./marketSnapshot.js";
import { peekRealtime } from "./realtimeHub.js";
import { openPositions, type OpenPosition } from "./tradeJournal.js";
import { sendTelegram, stockNameHtml } from "./telegram.js";
import { pushNotice, stockLink } from "./notifyCenter.js";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 손절 감시 — **적어 둔 선이 깨지면 알린다.**
 *
 * ## 왜 이게 다른 알림과 다른가
 *
 * 다른 시그널(급변·거래량 급증·수급 전환)은 **「봐라」**는 말이다. 안 봐도 손해가
 * 안 난다. 그런데 손절선은 **내가 미리 정해 둔 규칙**이고, 그게 깨진 걸 못 보면
 * 그날 손실이 계획보다 커진다. 그래서 이것만 규칙이 다르다:
 *
 *   · **1분마다** 본다 (다른 시그널은 기본 10분)
 *   · 검사에 **조회를 안 쓴다** — 실시간과 스냅샷에 이미 있는 값만 쓴다
 *   · 종목당 **하루 한 번**만 울린다
 *
 * ## ⚠️ 자동으로 팔지 않는다
 *
 * 이 앱은 조회 전용이다. 알림은 **「지금 네 규칙이 깨졌다」**까지만 말한다.
 * 파는 건 사람이 한다 — 그래서 알림에 종목명과 지금 값, 적어 둔 선을 같이 적는다.
 * 창을 열어 확인할 필요 없이 그 한 줄로 판단할 수 있어야 한다.
 *
 * ## 무엇을 보고 「지금 값」이라 하나
 *
 *   1. **실시간 체결**(`0B` 의 FID `10`) — 있으면 이게 제일 정확하고 공짜다
 *   2. 전종목 스냅샷 — 실시간에 안 걸린 종목(상위 1000 밖)을 메운다
 *
 * 둘 다 없으면 **아무 말도 안 한다.** 값을 모르면서 「깨졌다」고 하면 안 되고,
 * 여기서 종목마다 조회를 부르면 초당 5회 한도를 손절 감시가 다 먹는다.
 */

/** 오늘 이미 알린 자리 — `날짜:종목:손절선` */
const firedToday = new Set<string>();

/** 한국 날짜 */
function kstDay(now = new Date()): string {
  return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
}

export interface StopBreak {
  code: string;
  name: string;
  /** 지금 값 */
  price: number;
  /** 적어 둔 손절선 */
  stop: number;
  /** 평균 진입가 */
  entry: number;
  qty: number;
  /** 진입 대비 지금 손실(%) */
  lossPct: number;
  /** 값의 출처 — 화면에 적는다 */
  from: "실시간" | "스냅샷";
}

/**
 * 지금 값을 찾는다. **조회를 새로 부르지 않는다.**
 *
 * 스냅샷은 이미 만들어 둔 것만 쓴다(`getMarketSnapshot` 은 캐시가 있으면 즉시 준다).
 * 캐시가 없으면 46회 조회가 나가는데, 그건 손절 감시가 할 일이 아니다 — 그때는
 * 실시간에 걸린 종목만 보고 나머지는 다음 tick 으로 미룬다.
 */
function priceOf(code: string, snap: Map<string, number> | null): { price: number; from: StopBreak["from"] } | null {
  const { store } = peekRealtime();
  /* 손절 판정은 **KRX 체결만** — NXT 는 호가가 얇아 한 틱에 헛울린다 (2026-08-31) */
  const tick = store?.getLatestKrx("0B", code);
  // FID 10 = 현재가. 키움은 하락이면 음수로 준다
  const raw = tick?.values?.["10"];
  if (raw) {
    const n = Math.abs(Number(String(raw).replace(/[+,\s]/g, "")));
    if (Number.isFinite(n) && n > 0) return { price: n, from: "실시간" };
  }
  const s = snap?.get(code);
  if (s && s > 0) return { price: s, from: "스냅샷" };
  return null;
}

/**
 * 한 번 검사한다.
 *
 * @param opts.send 거짓이면 찾기만 하고 안 보낸다 (화면의 「지금 확인」용)
 */
export async function runStopWatch(
  client: KiwoomClient,
  opts: { send?: boolean } = {},
): Promise<{ positions: number; watched: number; breaks: StopBreak[]; sent: boolean }> {
  const positions = await openPositions();
  const watched = positions.filter((p): p is OpenPosition & { stop: number } => p.stop !== null);
  if (watched.length === 0) {
    return { positions: positions.length, watched: 0, breaks: [], sent: false };
  }

  /*
   * 스냅샷은 **이미 만들어져 있을 때만** 쓴다. 여기서 만들게 하면 손절 감시가
   * 1분마다 46회 조회를 부르는 일이 된다.
   */
  const snapshot = await getMarketSnapshot(client).catch(() => null);
  const byCode = snapshot
    ? new Map([...snapshot.byCode].map(([c, s]) => [c, s.price]))
    : null;

  const day = kstDay();
  const breaks: StopBreak[] = [];
  for (const p of watched) {
    const now = priceOf(p.code, byCode);
    if (!now) continue;
    if (now.price > p.stop) continue;

    /*
     * 종목당 하루 한 번. 손절선까지 왔다면 그 근처에서 계속 오르내리는데,
     * 그때마다 울리면 **그 방을 안 보게 된다** — 알림이 죽는 가장 흔한 이유다.
     * 손절선을 고쳐 적으면 키가 달라져 다시 울린다(그건 새 규칙이니 맞다).
     */
    const key = `${day}:${p.code}:${p.stop}`;
    if (firedToday.has(key)) continue;
    firedToday.add(key);

    breaks.push({
      code: p.code,
      name: p.name,
      price: now.price,
      stop: p.stop,
      entry: p.price,
      qty: p.qty,
      lossPct: ((now.price - p.price) / p.price) * 100,
      from: now.from,
    });
  }

  if (breaks.length === 0 || opts.send === false) {
    return { positions: positions.length, watched: watched.length, breaks, sent: false };
  }

  /*
   * **알림함에도.** 손절선이 깨진 것은 그날 가장 급한 소식이라 두 곳 다 남긴다 —
   * 텔레그램을 못 보면 영영 모르는 종류의 알림이 아니어야 한다.
   */
  /* 종목마다 — 「바로가기」가 그 종목으로 가야 한다 (2026-09-03, 옛 `#/watchlist` 는 없는 탭이었다) */
  for (const b of breaks) {
    await pushNotice({
      source: "stopWatch",
      kind: "stock",
      level: "urgent",
      title: `${b.name} 손절선 이탈`,
      body: `손절선 ${won(b.stop)} 아래 — 지금 ${won(b.price)} (${b.lossPct.toFixed(1)}%)`,
      code: b.code,
      name: b.name,
      link: stockLink(b.code, b.name),
      dedupeKey: `stopWatch:${b.code}:${b.stop}`,
      dedupeHours: 6,
    }).catch(() => undefined);
  }

  const res = await sendTelegram(formatStopBreaks(breaks), "signal");
  return { positions: positions.length, watched: watched.length, breaks, sent: res.ok };
}

const won = (n: number) => Math.round(n).toLocaleString("ko-KR");

/**
 * 알림 문구.
 *
 * **한 줄로 판단할 수 있어야 한다.** 앱을 열어 확인해야 하는 알림은 회사에서는
 * 못 본다 — 그게 이 기능이 필요한 바로 그 상황이다.
 */
export function formatStopBreaks(breaks: StopBreak[]): string {
  // 종목명이 딥링크다 — 알림에서 한 번 눌러 개별종목분석으로 (HTS_WEB_URL 설정 시)
  const lines = breaks.map(
    (b) =>
      `• ${stockNameHtml(b.code, b.name)} ${won(b.price)}원 — 손절선 ${won(b.stop)} 아래\n` +
      `  진입 ${won(b.entry)} · ${b.qty}주 · ${b.lossPct.toFixed(1)}% (${b.from})`,
  );
  return (
    `🛑 손절선이 깨졌습니다 (${breaks.length}건)\n\n${lines.join("\n\n")}\n\n` +
    `— 이 앱은 주문을 넣지 않습니다. 파는 건 직접 하세요.`
  );
}

/** 날짜가 바뀌면 어제 것은 잊는다 — 세트가 무한히 커지지 않게 */
export function pruneStopWatch(now = new Date()): void {
  const day = kstDay(now);
  for (const k of firedToday) {
    if (!k.startsWith(`${day}:`)) firedToday.delete(k);
  }
}
