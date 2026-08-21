import type { KiwoomClient } from "./kiwoomClient.js";
import { RealtimeClient } from "./realtimeClient.js";
import { RealtimeStore } from "./realtimeStore.js";
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
function shouldRun(now = new Date()): boolean {
  const k = new Date(now.getTime() + 9 * 3600 * 1000);
  const day = k.getUTCDay();
  if (day === 0 || day === 6) return false;
  const mins = k.getUTCHours() * 60 + k.getUTCMinutes();
  return mins >= 7 * 60 + 50 && mins <= 20 * 60 + 10;
}

/** 무엇을 구독할까 — 관심종목 + 늘 보는 것 */
async function targets(): Promise<string[]> {
  try {
    const items = await listWatchlist();
    const codes = items.map((w) => w.code).filter(Boolean);
    return [...new Set(codes)].slice(0, 60);
  } catch {
    return [];
  }
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
      const { client: c } = peekRealtime();

      if (!run) {
        if (c) {
          c.close();
          subscribed = new Set();
        }
        return;
      }

      const { client: rt } = await getRealtime(kiwoom);
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

      const codes = await targets();
      for (const code of codes) {
        if (subscribed.has(code)) continue;
        subscribed.add(code);
        rt.subscribe("0F", code);
        rt.subscribe("0w", code);
      }
    } catch (e) {
      // 붙는 데 실패해도 서버는 계속 돈다 — 다음 분에 다시 해 본다
      console.log("실시간 스케줄러:", e instanceof Error ? e.message : e);
    }
  };

  void tick();
  setInterval(() => void tick(), 60_000);
  console.log("실시간 스케줄러 시작 (평일 07:50~20:10)");
}
