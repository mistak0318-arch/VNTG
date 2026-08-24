import type { KiwoomClient } from "./kiwoomClient.js";
import { RealtimeClient } from "./realtimeClient.js";
import { RealtimeStore } from "./realtimeStore.js";
import { tradeValueTop } from "./signalScreen.js";
import { listWatchlist } from "./watchlist.js";

/**
 * 실시간 하나를 **서버 전체가 나눠 쓴다.**
 *
 * 예전엔 라우터가 필요할 때 만들었다. 그러면 화면이 한 번도 안 열린 날은 아무것도
 * 안 쌓이고, 스케줄러가 따로 만들면 **연결이 둘**이 된다 — 토큰이 하나뿐인데.
 * 만드는 자리를 여기 하나로 둔다.
 */

let client: RealtimeClient | null = null;
let store: RealtimeStore | null = null;

export async function getRealtime(
  kiwoom: KiwoomClient,
): Promise<{ client: RealtimeClient; store: RealtimeStore }> {
  if (!client) {
    client = new RealtimeClient(kiwoom);
    // 저장소는 붙기 전에 걸어 둔다 — 첫 프레임부터 받아야 한다
    store = new RealtimeStore(client);
    await store.start();
  }
  return { client, store: store as RealtimeStore };
}

export function peekRealtime(): { client: RealtimeClient | null; store: RealtimeStore | null } {
  return { client, store };
}

/* ------------------------------------------------------------------ */
/* 장 시간                                                              */
/* ------------------------------------------------------------------ */

/**
 * 지금 붙어 있어야 하나.
 *
 * KRX 는 09:00~15:30 이지만 **NXT 가 앞뒤로 더 돈다** — 프리마켓 08:00,
 * 애프터마켓 20:00 까지. 종가배팅을 NXT 마감에 하는 것이 전략의 일부이므로
 * 그 시간도 쌓아야 한다.
 *
 * 앞뒤로 조금 여유를 둔다. 정확히 08:00 에 붙으면 첫 체결을 놓친다.
 */
export function shouldRun(now = new Date()): boolean {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = k.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  return mins >= 7 * 60 + 50 && mins <= 20 * 60 + 10;
}

/**
 * 몇 종목까지 물고 있을까.
 *
 * ## 왜 전 종목이 아닌가
 *
 * 「내가 열어 본 것만 쌓이면 새로 보려는 종목은 데이터가 없다」 — 맞는 말이라 재봤다.
 * 오늘 파일(6종목)을 배수로 부풀려 측정한 값이다.
 *
 * | 종목 | 하루 파일 | 20초마다 저장 | 그 순간 힙 |
 * |------|-----------|---------------|-----------|
 * | 120  | 22MB      | 167ms         | +52MB     |
 * | 600  | 110MB     | 963ms         | +230MB    |
 * | 2800 | 514MB     | **4.4초**     | **+1GB**  |
 *
 * 저장이 **파일을 통째로 다시 쓰는** 방식이라 종목 수에 정비례한다. 전 종목이면
 * 20초마다 4.4초를 물고 CPU 가 상시 22% 붙는다. 게다가 그걸 메모리에도 들고 있어야 해서
 * 힙이 수 GB 로 간다 — 미니 PC 가 못 버틴다.
 *
 * **디스크는 병목이 아니다**(하루 0.5GB는 지웠다 쓰면 된다). 병목은 쓰는 방식이다.
 *
 * ## 그래서 어디까지
 *
 * 300 이면 55MB · 0.5초 · CPU 2.5% 로 편안하다. 그리고 그 300 을
 * **거래대금·등락률 상위**로 채우면 「새로 보려는 종목」이 대개 그 안에 있다 —
 * 종목을 새로 발견하는 경로가 애초에 그 두 순위다.
 *
 * 그 밖의 종목은 **여는 순간부터** 쌓인다(화면이 물으면 그때 건다). 지난 시간은
 * 아무도 못 되살린다 — 실시간은 놓치면 끝이라 「그때 안 물었다」가 정답이다.
 */
const MAX_CODES = 300;
/** 순위를 몇 분마다 다시 볼지 — 거래대금 상위는 이보다 빨리 안 뒤집힌다 */
const RANK_REFRESH_MS = 5 * 60 * 1000;

let rankCache: { at: number; codes: string[] } = { at: 0, codes: [] };

/** 거래대금 상위 — 돈이 몰린 곳이 곧 오늘 볼 종목이다 */
async function hotCodes(kiwoom: KiwoomClient): Promise<string[]> {
  if (Date.now() - rankCache.at < RANK_REFRESH_MS) return rankCache.codes;
  try {
    // 보통주만 걸러서 준다(ETF·우선주를 실시간으로 물 이유가 없다)
    const top = await tradeValueTop(kiwoom, "000", MAX_CODES);
    rankCache = { at: Date.now(), codes: top.map((t) => t.code).filter(Boolean) };
  } catch {
    // 순위를 못 받아도 관심종목은 걸려야 한다 — 지난번 것을 그대로 쓴다
    rankCache = { at: Date.now(), codes: rankCache.codes };
  }
  return rankCache.codes;
}

/**
 * 무엇을 구독할까 — **관심종목이 먼저, 그다음 거래대금 상위.**
 *
 * 관심종목을 앞에 두는 이유는 한도에 걸렸을 때 **잘려 나가면 안 되는 쪽**이기 때문이다.
 */
async function targets(kiwoom: KiwoomClient): Promise<string[]> {
  const codes: string[] = [];
  try {
    const items = await listWatchlist();
    codes.push(...items.map((w) => w.code).filter(Boolean));
  } catch {
    /* 관심종목을 못 읽어도 순위는 걸린다 */
  }
  codes.push(...(await hotCodes(kiwoom)));
  return [...new Set(codes)].slice(0, MAX_CODES);
}

/**
 * 장 시간에 알아서 붙고, 끝나면 끊는다.
 *
 * ## 왜 서버가 하나
 *
 * 「화면을 안 봐도 쌓인다」가 이 구조의 요점인데, 화면이 열려야 붙으면 그게 거짓말이 된다.
 * 아침에 켜 두고 저녁에 보는 것이 실제 쓰는 방식이다.
 *
 * ## 무엇을 거나
 *
 * 시계열이 필요한 것만 — 거래원(`0F`)·프로그램매매(`0w`).
 * 체결(`0B`)·호가(`0D`)는 **보고 있을 때만** 뜻이 있으므로 화면이 물어볼 때 걸린다
 * (`/api/realtime/latest` 가 알아서 건다). 안 그러면 종목마다 초당 수십 프레임을
 * 하루 종일 받으면서 아무도 안 본다.
 */
export function startRealtimeScheduler(kiwoom: KiwoomClient): void {
  if (!RealtimeClient.enabled) {
    console.log("실시간: 꺼져 있음 (REALTIME_ENABLED=0)");
    return;
  }

  let subscribed = new Set<string>();

  const tick = async () => {
    try {
      const run = shouldRun();

      /*
       * ⚠️ **저장소는 장 시간과 상관없이 만든다.**
       *
       * 예전엔 붙을 때만 만들었다. 그러면 장이 닫힌 뒤 서버를 다시 띄웠을 때
       * **그날 파일을 아무도 안 읽어서** 화면이 통째로 빈다 — 저녁에 복기하려고 열면
       * 「데이터가 없습니다」가 뜬다. 정작 쌓아 둔 파일은 디스크에 멀쩡히 있는데.
       *
       * 만드는 것과 붙는 것은 다른 일이다. 만들면 파일을 읽어 들이고, 붙는 건 아래에서
       * 장 시간에만 한다.
       */
      const { client: rt } = await getRealtime(kiwoom);

      if (!run) {
        // 「끊김」은 소켓이 아예 없다는 뜻 — 그때 또 닫으면 매 분 헛일이다
        if (rt.state !== "끊김") {
          rt.close();
          subscribed = new Set();
        }
        return;
      }

      await rt.connect();

      /*
       * 관심종목은 **바뀐 것만** 새로 건다.
       * 매번 전부 다시 걸면 REG 요청이 쌓이고, 그건 105110 으로 돌아온다.
       */
      /*
       * VI 는 **한 번만** 건다. 종목을 지정해도 전체 종목이 오므로(문서 명시)
       * 종목마다 걸 이유가 없다 — 오히려 요청만 늘어난다.
       */
      if (!subscribed.has("__vi__")) {
        subscribed.add("__vi__");
        rt.subscribe("1h", "005930");
      }

      const codes = await targets(kiwoom);
      let added = 0;
      for (const code of codes) {
        if (subscribed.has(code)) continue;
        subscribed.add(code);
        rt.subscribe("0F", code);
        rt.subscribe("0w", code);
        added += 1;
      }
      if (added > 0) console.log(`실시간: ${added}종목 추가 (총 ${subscribed.size - 1})`);
    } catch (e) {
      // 붙는 데 실패해도 서버는 계속 돈다 — 다음 분에 다시 해 본다
      console.log("실시간 스케줄러:", e instanceof Error ? e.message : e);
    }
  };

  void tick();
  setInterval(() => void tick(), 60_000);
  console.log("실시간 스케줄러 시작 (평일 07:50~20:10)");
}
