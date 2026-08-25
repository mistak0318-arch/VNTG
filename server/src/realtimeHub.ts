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

/**
 * 지금 **몇 종목을 걸어 뒀나.**
 *
 * 스케줄러가 시작될 때 실제 함수로 바뀐다. 안 돌고 있으면 0 이다.
 * `store.health.keys`(값이 온 종목)와 **다른 숫자**라 따로 둔다.
 */
let subCount: () => number = () => 0;
export function subscribedCount(): number {
  return subCount();
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
 * **코스피 500 + 코스닥 500** 으로 잡는다(2026-08-24).
 *
 * 위 표는 **통째로 다시 쓰던 시절**의 것이다. 그때 기준이면 1000 종목은 20초마다
 * 1.6초를 무는 셈이라 못 할 짓이었다. 그래서 저장을 **덧붙이기**로 바꿨다 — 새로 들어온
 * 샘플만 적으므로 쓰는 시간이 종목 수가 아니라 **그 20초 동안 실제로 온 양**에 붙는다.
 * 천 종목이든 삼백 종목이든 한 번에 적는 건 수십 KB다.
 *
 * 편한 게 목적이 아니라 **화면을 열었을 때 이미 쌓여 있는 것**이 목적이다. 목록 밖의
 * 종목을 열면 그 자리에서 구독이 걸리지만 지나간 시간은 아무도 못 되살린다.
 *
 * 그 밖의 종목은 **여는 순간부터** 쌓인다(화면이 물으면 그때 건다). 지난 시간은
 * 아무도 못 되살린다 — 실시간은 놓치면 끝이라 「그때 안 물었다」가 정답이다.
 */
/**
 * 시장 하나당 몇 종목.
 *
 * ## ⚠️ 「코스피 500 + 코스닥 500」은 **키움이 안 해 준다** (2026-08-25 실측)
 *
 * 1000종목을 걸어 놓고 「걸렸나」를 오래 확인 못 하고 있었다. 답은 서버가 계속
 * 말하고 있었는데 우리가 안 보고 있었다:
 *
 *     105118  등록 종목이 **그룹번호**에 등록할 수 있는 허용 개수(200)를 초과
 *     105115  등록 **종목이** 허용 개수(200)를 초과
 *     105110  해당 TRNM 으로 허용된 **요청 건수**를 초과 (TRNM=REG)
 *
 * 셋을 같이 놓고 보면 규칙이 나온다 — **한 연결에 200종목**, 그룹을 나눠도 총합은
 * 그대로고, 나눠 보내면 이번엔 요청 횟수에 걸린다.
 *
 * 그런데 소켓은 「연결됨 · healthy」였다. **등록이 통째로 거절돼도 상태창은 멀쩡하다** —
 * 그래서 하루 종일 몰랐다. 그 실패를 이제 `/api/realtime/status` 의 `regErrors` 에 남긴다.
 *
 * ## 그래서 200 을 무엇으로 채우나
 *
 * 관심종목이 먼저다(잘려 나가면 안 되는 쪽). 나머지를 코스피·코스닥 거래대금 상위로
 * 반씩 채운다. **200 은 적지만 0 보다는 훨씬 낫다** — 지금까지는 사실상 0 이었다.
 */
const PER_MARKET = 95;
/**
 * 스케줄러가 채우는 몫.
 *
 * ⚠️ **200 을 꽉 채우면 안 된다.** 화면이 종목을 볼 때도 구독이 늘어나는데
 * (`/series`·`/latest` 가 보고 있는 종목을 그 자리에서 건다), 정원이 이미 꽉 차 있으면
 * 그 종목은 **영영 못 들어온다** — 거래상위에서 아무 종목이나 눌러 보는 게 이 앱을
 * 쓰는 방식인데 그때마다 빈 화면이 된다.
 *
 * 그래서 190 만 쓰고 **열 자리는 화면 몫으로 비워 둔다.** 화면이 그 열 자리를 다 쓰면
 * 오래 본 것부터 빠진다(`subscribeTransient`) — 스케줄러 몫은 안 밀린다.
 */
const MAX_CODES = 190;
/** 순위를 몇 분마다 다시 볼지 — 거래대금 상위는 이보다 빨리 안 뒤집힌다 */
const RANK_REFRESH_MS = 5 * 60 * 1000;

let rankCache: { at: number; codes: string[] } = { at: 0, codes: [] };

/**
 * 거래대금 상위 — 돈이 몰린 곳이 곧 오늘 볼 종목이다.
 *
 * ⚠️ **시장별로 따로 받는다.** 전체(`000`)로 한 번에 받으면 상위가 코스피로 채워져
 * **코스닥이 거의 안 들어온다** — 거래대금 절대액이 다르기 때문이다. 그런데 코스닥에서
 * 새 종목을 발견하는 일이 오히려 잦다. 코스피 상위 N, 코스닥 상위 N 을 따로 잡는다.
 */
async function hotCodes(kiwoom: KiwoomClient): Promise<string[]> {
  if (Date.now() - rankCache.at < RANK_REFRESH_MS) return rankCache.codes;
  /*
   * ⚠️ **실패를 조용히 삼키면 안 된다.**
   *
   * 예전엔 `catch` 에서 아무 말 없이 지난 값을 쓰고 `at` 을 지금으로 갱신했다. 그러면
   * 처음부터 실패했을 때 **빈 목록이 5분마다 그대로 되살아난다** — 다시 해 보지도 않는다.
   * 실제로 그래서 하루 종일 **관심종목 여섯 개만** 쌓였다(2026-08-21 파일이 그 꼴이다).
   * 거래대금 상위 300 을 건다고 적어 놓고 실제로는 하나도 안 걸린 것이다.
   *
   * 실패하면 **말하고, `at` 을 0 으로 둬 다음 차례에 곧바로 다시 해 본다.**
   */
  try {
    // 보통주만 걸러서 준다(ETF·우선주를 실시간으로 물 이유가 없다)
    const [kospi, kosdaq] = await Promise.allSettled([
      tradeValueTop(kiwoom, "001", PER_MARKET),
      tradeValueTop(kiwoom, "101", PER_MARKET),
    ]);
    for (const [name, r] of [["코스피", kospi], ["코스닥", kosdaq]] as const) {
      if (r.status === "rejected") {
        console.log(`실시간: ${name} 거래대금 상위 실패 —`, r.reason instanceof Error ? r.reason.message : r.reason);
      }
    }
    const codes = [kospi, kosdaq]
      .flatMap((r) => (r.status === "fulfilled" ? r.value : []))
      .map((t) => t.code)
      .filter(Boolean);
    if (codes.length === 0) {
      // 빈 목록으로 덮으면 구독이 통째로 풀린다. 지난 값을 쓰되 곧바로 다시 해 본다
      console.log("실시간: 거래대금 상위가 비었다 — 관심종목만 걸린다");
      rankCache = { at: 0, codes: rankCache.codes };
    } else {
      rankCache = { at: Date.now(), codes };
    }
  } catch (e) {
    console.log("실시간: 순위 조회 실패 —", e instanceof Error ? e.message : e);
    rankCache = { at: 0, codes: rankCache.codes };
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

  /*
   * 지금 몇 종목을 걸었나 — **밖에서 볼 수 있어야 한다.**
   *
   * `/api/realtime/store` 의 `keys` 는 **값이 실제로 온 종목** 수라 구독 수와 다르다.
   * 거래가 뜸한 종목은 걸려 있어도 키가 안 생긴다. 그래서 「keys 가 129 인데 1000 을
   * 건 게 맞나」를 눈으로 못 가렸다 — 확인할 때마다 헷갈리던 자리다. 둘을 갈라 적는다.
   */
  let subscribed = new Set<string>();
  subCount = () => subscribed.size - (subscribed.has("__vi__") ? 1 : 0);

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
        /* VI 는 전체 종목이 오므로 종목 하나로 족하다. 정원을 먹지 않게 고정으로 둔다 */
        rt.subscribeKeep("1h", "005930");
      }

      const codes = await targets(kiwoom);
      let added = 0;
      for (const code of codes) {
        if (subscribed.has(code)) continue;
        subscribed.add(code);
        /*
          `subscribeKeep` — **밀려나면 안 되는 쪽**이다.
          화면이 종목을 볼 때도 구독이 늘어나는데(`/series`·`/latest`), 그쪽이 상한에
          닿으면 오래된 **화면 종목**부터 빠진다. 관심종목·순위는 하루 종일 필요하다.
        */
        rt.subscribeKeep("0F", code);
        rt.subscribeKeep("0w", code);
        /*
          체결도 상시로 건다 — 복기하려면 「그때 얼마에 얼마나」가 있어야 한다.
          프레임은 체결마다 오지만 30초에 한 점만 남기므로 쌓이는 양은 나머지와 같다.
        */
        rt.subscribeKeep("0B", code);
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
