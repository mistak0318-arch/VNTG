import type { KiwoomClient } from "./kiwoomClient.js";
import { RealtimeClient } from "./realtimeClient.js";
import { RealtimeStore } from "./realtimeStore.js";
import { tradeValueTop } from "./signalScreen.js";
import { usStexMap } from "./usKiwoomDetail.js";
import { listGroups as listUsGroups } from "./usWatchlist.js";
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

/* ------------------------------------------------------------------ */
/* 두 번째 연결 — 정원 190 → 380 (2026-08-25 실측 근거)                  */
/* ------------------------------------------------------------------ */

/**
 * ## 왜 두 번째 연결인가
 *
 * 키움은 **연결 하나에 200종목**이다(105115·105118 실측). 그런데 같은 토큰으로
 * 소켓을 하나 더 열어 봤더니 **LOGIN·REG 둘 다 return_code 0 이고 첫 소켓도
 * 산다**(probe-second, 2026-08-25). 연결마다 정원이 따로라는 뜻이다.
 *
 * 2번 연결은 **거래대금 순위의 다음 구간**(96~190위 × 코스피/코스닥)을 **0B(체결)만**
 * 건다 — 목적이 시세분석 오버레이의 가격 커버리지라 거래원(0F)·프로그램(0w)
 * 시계열까지는 필요 없고, 타입을 줄여야 프레임 양도 준다. 프레임은 같은
 * 저장소(store.attach)로 합쳐지므로 화면은 어느 소켓의 값인지 모른다.
 *
 * ## 롤백 스위치
 *
 * `.env` 에 `REALTIME_DUAL=0` 을 넣으면 **다음 재시작부터 한 연결로 돌아간다**
 * (기본은 켬). 장중에 REG 거절·첫 소켓 이상이 보이면 이 한 줄이 롤백이다.
 * 2번 연결이 실패해도 1번은 건드리지 않는다 — 얹는 것이지 대체가 아니다.
 */
export function dualEnabled(): boolean {
  return RealtimeClient.enabled && process.env.REALTIME_DUAL?.trim() !== "0";
}

let client2: RealtimeClient | null = null;

async function getSecond(kiwoom: KiwoomClient): Promise<RealtimeClient> {
  if (!client2) {
    client2 = new RealtimeClient(kiwoom);
    // 저장소는 1번 것을 같이 쓴다 — getRealtime 이 먼저 만들어 둔 상태다
    store?.attach(client2);
  }
  return client2;
}

/** 2번 연결 상태 — 상태창용. 없으면 null */
export function secondInfo(): { state: string; healthy: boolean; subscribed: number } | null {
  if (!client2) return null;
  return { state: client2.state, healthy: client2.healthy, subscribed: sub2Count() };
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

/** 2번 연결이 건 종목 수 — 스케줄러가 시작되면 실제 함수로 바뀐다 */
let sub2Count: () => number = () => 0;

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
 * 미국 실시간(FE)이 돌 시간인가 — **뉴욕 시각으로** 잰다.
 *
 * KST 로 재면 서머타임 전환 때 한 시간이 통째로 어긋난다. Node 의 타임존 데이터로
 * 뉴욕 현지 요일·시각을 얻는다. 프리마켓 04:00 ~ 애프터 20:00 ET, 앞뒤 10분 여유.
 * ⚠️ 요일도 뉴욕 기준이다 — 한국 토요일 아침은 뉴욕 금요일 저녁이라 **돌아야 한다.**
 */
export function usShouldRun(now = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return false;
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  return mins >= 3 * 60 + 50 && mins <= 20 * 60 + 10;
}

/**
 * 하루를 세 국면으로 가른다 — **정원 200 을 국내와 미국이 나눠 쓰는 방법**이다.
 *
 *   낮    KRX 장중 (미국이 겹쳐도 아침 애프터장 꼬리뿐) — 국내가 전부 갖는다
 *   저녁  NXT 애프터(∼20:00) 와 미국 프리장(17:00∼)이 겹친다 — 나눈다
 *   밤    국내는 닫혔다 — 미국이 전부 갖는다
 *
 * 국면이 바뀔 때 소켓을 끊고 **처음부터 다시 짠다.** 빼기(REMOVE)를 하나씩 보내는
 * 것보다 판을 새로 짜는 쪽이 단순하고, 키움 재접속은 싸다(LOGIN 한 번).
 */
type Phase = "낮" | "저녁" | "밤" | "쉼";

export function phaseOf(now = new Date()): Phase {
  const dom = shouldRun(now);
  const us = usShouldRun(now);
  if (dom && us) {
    // 아침 07:50~09:00 겹침은 미국 애프터장 꼬리 — 국내 개장 준비가 먼저다
    const kh = new Date(now.getTime() + 9 * 3600 * 1000).getUTCHours();
    return kh >= 16 ? "저녁" : "낮";
  }
  if (dom) return "낮";
  if (us) return "밤";
  return "쉼";
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
 * 2번 연결의 시장당 몫 — 1번이 못 담은 **다음 구간**(96~190위)을 가져간다.
 * 0B 하나만 걸므로 190종목이어도 연결 정원(200) 안이다. 5는 여유.
 */
const DUAL_PER_MARKET = 95;
/** 순위 캐시를 몇 위까지 받아 둘지 — 1번(95) + 2번(95) 몫 */
const RANK_DEPTH = PER_MARKET + DUAL_PER_MARKET;
/** 저녁(국내 애프터 + 미국 프리장 겹침)의 국내 몫 — 미국에 60 을 내준다 */
const PER_MARKET_EVENING = 50;
/** 저녁의 미국 몫. 관심(해외) 앞 그룹부터 이만큼 */
const US_EVENING = 60;
/** 밤의 미국 몫 — 국내는 닫혔으니 크게. 화면 몫 10 은 여전히 비워 둔다 */
const US_NIGHT = 150;
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

let rankCache: { at: number; kospi: string[]; kosdaq: string[] } = { at: 0, kospi: [], kosdaq: [] };

/**
 * 거래대금 상위 — 돈이 몰린 곳이 곧 오늘 볼 종목이다.
 *
 * ⚠️ **시장별로 따로 받는다.** 전체(`000`)로 한 번에 받으면 상위가 코스피로 채워져
 * **코스닥이 거의 안 들어온다** — 거래대금 절대액이 다르기 때문이다. 그런데 코스닥에서
 * 새 종목을 발견하는 일이 오히려 잦다. 코스피 상위 N, 코스닥 상위 N 을 따로 잡는다.
 */
async function hotCodes(kiwoom: KiwoomClient, perMarket: number): Promise<string[]> {
  // 시장별로 따로 들고 있다가 국면에 맞게 자른다 — 저녁엔 50/50, 낮엔 95/95
  const cut = () => [
    ...rankCache.kospi.slice(0, perMarket),
    ...rankCache.kosdaq.slice(0, perMarket),
  ];
  if (Date.now() - rankCache.at < RANK_REFRESH_MS) return cut();
  return refreshRank(kiwoom).then(cut);
}

/** 2번 연결 몫 — 순위 캐시의 **다음 구간**(from~to위). 캐시가 식었으면 새로 받는다 */
async function hotCodesSlice(kiwoom: KiwoomClient, from: number, to: number): Promise<string[]> {
  if (Date.now() - rankCache.at >= RANK_REFRESH_MS) await refreshRank(kiwoom);
  return [...rankCache.kospi.slice(from, to), ...rankCache.kosdaq.slice(from, to)];
}

async function refreshRank(kiwoom: KiwoomClient): Promise<void> {
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
    // 깊이는 RANK_DEPTH(190) — 2번 연결이 다음 구간(96~190위)을 가져간다
    const [kospi, kosdaq] = await Promise.allSettled([
      tradeValueTop(kiwoom, "001", RANK_DEPTH),
      tradeValueTop(kiwoom, "101", RANK_DEPTH),
    ]);
    for (const [name, r] of [["코스피", kospi], ["코스닥", kosdaq]] as const) {
      if (r.status === "rejected") {
        console.log(`실시간: ${name} 거래대금 상위 실패 —`, r.reason instanceof Error ? r.reason.message : r.reason);
      }
    }
    const pick = (r: PromiseSettledResult<{ code: string }[]>) =>
      r.status === "fulfilled" ? r.value.map((t) => t.code).filter(Boolean) : [];
    const ks = pick(kospi);
    const kq = pick(kosdaq);
    if (ks.length === 0 && kq.length === 0) {
      // 빈 목록으로 덮으면 구독이 통째로 풀린다. 지난 값을 쓰되 곧바로 다시 해 본다
      console.log("실시간: 거래대금 상위가 비었다 — 관심종목만 걸린다");
      rankCache = { ...rankCache, at: 0 };
    } else {
      rankCache = { at: Date.now(), kospi: ks, kosdaq: kq };
    }
  } catch (e) {
    console.log("실시간: 순위 조회 실패 —", e instanceof Error ? e.message : e);
    rankCache = { ...rankCache, at: 0 };
  }
}

/**
 * 미국 FE 로 걸 티커 — 관심종목(해외) **그룹 순서대로**, 미국 거래소만.
 *
 * 그룹 순서가 곧 우선순위다(첫 그룹이 늘 제일 자주 보는 묶음). 유럽·일본 티커는
 * FE 가 안 받으므로 usExchanges 지도(ND/NY/NA)에 있는 것만 남긴다.
 */
const US_REFRESH_MS = 5 * 60 * 1000;
let usCache: { at: number; symbols: string[] } = { at: 0, symbols: [] };

async function usSymbols(): Promise<string[]> {
  if (Date.now() - usCache.at < US_REFRESH_MS) return usCache.symbols;
  try {
    const [groups, stex] = await Promise.all([listUsGroups(), usStexMap()]);
    const out: string[] = [];
    const seen = new Set<string>();
    for (const g of groups) {
      for (const s of g.stocks) {
        const sym = s.symbol.toUpperCase();
        if (seen.has(sym) || !stex[sym]) continue;
        seen.add(sym);
        out.push(sym);
      }
    }
    usCache = { at: Date.now(), symbols: out };
  } catch (e) {
    console.log("실시간: 해외 관심종목 읽기 실패 —", e instanceof Error ? e.message : e);
    usCache = { ...usCache, at: 0 };
  }
  return usCache.symbols;
}

/**
 * 무엇을 구독할까 — **관심종목이 먼저, 그다음 거래대금 상위.**
 *
 * 관심종목을 앞에 두는 이유는 한도에 걸렸을 때 **잘려 나가면 안 되는 쪽**이기 때문이다.
 */
async function targets(kiwoom: KiwoomClient, perMarket: number, max: number): Promise<string[]> {
  const codes: string[] = [];
  try {
    const items = await listWatchlist();
    codes.push(...items.map((w) => w.code).filter(Boolean));
  } catch {
    /* 관심종목을 못 읽어도 순위는 걸린다 */
  }
  codes.push(...(await hotCodes(kiwoom, perMarket)));
  return [...new Set(codes)].slice(0, max);
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
  /** 2번 연결이 건 것 — 1번과 겹치지 않는 다음 순위 구간 */
  let subscribed2 = new Set<string>();
  sub2Count = () => subscribed2.size;
  /** 지금 어느 국면으로 판을 짰나 — 바뀌면 끊고 처음부터 다시 짠다 */
  let phase: Phase = "쉼";

  const tick = async () => {
    try {
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

      const next = phaseOf();

      /* 2번 연결을 접는 공통 경로 — 쉼·밤·롤백(REALTIME_DUAL=0) 전부 이 길이다 */
      const dropSecond = () => {
        if (client2 && client2.state !== "끊김") client2.close();
        client2?.resetSubscriptions();
        subscribed2 = new Set();
      };

      if (next === "쉼") {
        // 「끊김」은 소켓이 아예 없다는 뜻 — 그때 또 닫으면 매 분 헛일이다
        if (rt.state !== "끊김") {
          rt.close();
          rt.resetSubscriptions();
          subscribed = new Set();
        }
        dropSecond();
        phase = "쉼";
        return;
      }

      /*
       * 국면이 바뀌면 **판을 새로 짠다** — 끊고, 구독을 백지로 하고, 아래에서 다시 건다.
       * 낮 190(국내)을 밤 150(미국)으로 갈아끼우는 방법이 이것이다. REMOVE 를 하나씩
       * 보내며 교체하는 것보다 단순하고, 키움 재접속은 LOGIN 한 번이라 싸다.
       */
      if (next !== phase) {
        if (rt.state !== "끊김") rt.close();
        rt.resetSubscriptions();
        subscribed = new Set();
        dropSecond();
        console.log(`실시간: 국면 전환 → ${next}`);
        phase = next;
      }

      await rt.connect();

      /*
       * VI 는 **한 번만** 건다. 종목을 지정해도 전체 종목이 오므로(문서 명시)
       * 종목마다 걸 이유가 없다 — 오히려 요청만 늘어난다. 밤엔 KRX 가 닫혀 안 건다.
       */
      if (phase !== "밤" && !subscribed.has("__vi__")) {
        subscribed.add("__vi__");
        /* VI 는 전체 종목이 오므로 종목 하나로 족하다. 정원을 먹지 않게 고정으로 둔다 */
        rt.subscribeKeep("1h", "005930");
      }

      /*
       * 국면별 정원. 합이 MAX_CODES(190)를 넘지 않아야 한다 — 나머지 10 은 화면 몫.
       *
       *   낮    국내 190 (관심 + 95/95) · 미국 0
       *   저녁  국내 관심 + 50/50 · 미국 60  (관심 ~25 로 잡으면 185)
       *   밤    국내 0 · 미국 150
       */
      let added = 0;

      if (phase !== "밤") {
        const perMarket = phase === "저녁" ? PER_MARKET_EVENING : PER_MARKET;
        const usAllow = phase === "저녁" ? US_EVENING : 0;
        const codes = await targets(kiwoom, perMarket, MAX_CODES - usAllow);
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
      }

      if (phase !== "낮") {
        /*
         * 미국 FE — 해외 관심종목, 그룹 순서대로. ⚠️ 프레임 실측은 아직이다
         * (등록은 통과 — regErrors 0). 안 오면 밤에 로그로 원인이 남는다.
         */
        const allow = phase === "밤" ? US_NIGHT : US_EVENING;
        for (const sym of (await usSymbols()).slice(0, allow)) {
          if (subscribed.has(sym)) continue;
          subscribed.add(sym);
          rt.subscribeKeep("FE", sym);
          added += 1;
        }
      }

      /*
       * 2번 연결 — 낮·저녁에만 (밤은 국내가 닫혔고 FE 는 프레임을 안 준다 — 실측).
       * 1번의 다음 순위 구간을 0B 만 건다. 실패해도 1번은 안 건드린다.
       * 롤백: REALTIME_DUAL=0 이면 이 블록이 통째로 안 돌고, 켜져 있던 소켓은 접는다.
       */
      if (phase !== "밤" && dualEnabled()) {
        try {
          const rt2 = await getSecond(kiwoom);
          await rt2.connect();
          const perMarket = phase === "저녁" ? PER_MARKET_EVENING : PER_MARKET;
          const slice = await hotCodesSlice(kiwoom, perMarket, perMarket + DUAL_PER_MARKET);
          let added2 = 0;
          for (const code of slice) {
            if (subscribed.has(code) || subscribed2.has(code)) continue;
            if (subscribed2.size >= 190) break; // 연결 정원 200 에 여유 10
            subscribed2.add(code);
            rt2.subscribeKeep("0B", code);
            added2 += 1;
          }
          if (added2 > 0) console.log(`실시간(${phase}·2번): ${added2}종목 추가 (총 ${sub2Count()})`);
        } catch (e) {
          console.log("실시간 2번 연결:", e instanceof Error ? e.message : e);
        }
      } else if (!dualEnabled() && client2) {
        dropSecond();
      }

      if (added > 0)
        console.log(`실시간(${phase}): ${added}종목 추가 (총 ${subCount()})`);
    } catch (e) {
      // 붙는 데 실패해도 서버는 계속 돈다 — 다음 분에 다시 해 본다
      console.log("실시간 스케줄러:", e instanceof Error ? e.message : e);
    }
  };

  void tick();
  setInterval(() => void tick(), 60_000);
  console.log("실시간 스케줄러 시작 (국내 평일 07:50~20:10 · 미국 ET 03:50~20:10)");
}
