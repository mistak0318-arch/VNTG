import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * **미니스파크를 분봉으로** (2026-10-21).
 *
 * ## 왜 바꾸나
 *
 * 벤티지: "우리 지금 전 종목의 당일 흐름 클릭하면 나오잖아. 그러면 당일 흐름은 어디서
 * 갖고 오고 있는 거 아니야? 굳이 미니스파크 만드는 데 소켓에까지 연결해야 되나?
 * … 지금도 내가 보낸 거 보이지? ETF는 비어 있잖아."
 *
 * 맞는 지적이다. 시세분석 표의 미니스파크는 **실시간 소켓 저장소(`0B`)만** 읽었다.
 * 그래서 구독 못 한 종목은 통째로 빈칸이다. 실측(health):
 *
 *     실시간대상 = {관심종목 67, 조회순위 20, 거래대금 86, 합계 168, 정원 185}
 *
 * 거래대금에서 **86종목만** 들어간다 — 100을 보고 있으면 하위 14는 **구조적으로** 빈다.
 * ETF 는 거래대금 3·4위여도 소켓에 체결이 안 쌓여 늘 비었고, 프리마켓에는 체결 점이
 * 두 개가 안 돼 거의 다 비었다.
 *
 * 그런데 종목 상세의 「당일 흐름」은 소켓이 아니라 **분봉 조회(ka10080) 한 건**으로
 * 그린다 — 프리부터 애프터까지 다 들어 있다. 같은 재료를 표에도 쓰면 위의 셋이
 * 한꺼번에 사라진다.
 *
 * ## 비용을 어떻게 감당하나
 *
 * 분봉은 **종목당 1콜**이라 100종목이면 100콜이다. 그래서 여태 소켓을 썼다.
 * 여기서는 **요청이 온 종목을 대기열에 넣고 배경에서 천천히 받는다**:
 *
 *   · 화면은 **기다리지 않는다** — 캐시에 있는 것만 바로 주고, 없는 것은 다음 번에 채워진다
 *   · 워커는 `GAP_MS` 간격으로 **한 건씩** 받는다. 키움 큐를 막지 않는다
 *   · 캐시가 신선하면 조회하지 않는다 (장중 `FRESH_LIVE_MS`, 장 밖 `FRESH_IDLE_MS`)
 *
 * ⚠️ **코드를 거르지 않는다.** ETF 는 `0091P0` 처럼 숫자가 아닌 코드가 있어서,
 * `^\d{6}$` 같은 거름망을 두면 정작 고치려던 ETF 가 또 조용히 사라진다(세 번 당했다).
 */

/** 한 종목을 받고 다음 종목까지 쉬는 간격 — 키움 큐(초당 4.5건)를 막지 않을 만큼 */
const GAP_MS = 700;
/** 장중에는 이만큼 지나야 다시 받는다 */
const FRESH_LIVE_MS = 3 * 60_000;
/** 장 밖에서는 값이 거의 안 변한다 */
const FRESH_IDLE_MS = 30 * 60_000;
/** 들고 있을 종목 수 — 넘치면 **오래 안 쓴 것**부터 버린다 */
const MAX_CODES = 400;
/** 선 하나에 담을 점 수 */
const MAX_PTS = 40;

interface Entry {
  line: number[];
  at: number;
  /** 마지막으로 화면이 찾은 때 — 자리가 모자랄 때 버릴 것을 고른다 */
  used: number;
}

const cache = new Map<string, Entry>();
/** 받아야 할 종목 — 넣은 차례대로 */
const queue: string[] = [];
const queued = new Set<string>();
let running = false;
let stat = { 받음: 0, 실패: 0, 마지막: "" };

/** 화면이 찾는 선. 없으면 null 이고, 그 종목은 대기열로 간다 */
export function getSpark(code: string): number[] | null {
  const e = cache.get(code);
  if (!e) return null;
  e.used = Date.now();
  return e.line;
}

/**
 * 이 종목들을 받아 두라고 알린다. **기다리지 않는다.**
 * 이미 신선하거나 줄에 서 있으면 아무 일도 안 한다.
 */
export function requestSparks(codes: string[], live: boolean): void {
  const fresh = live ? FRESH_LIVE_MS : FRESH_IDLE_MS;
  const now = Date.now();
  for (const code of codes) {
    if (!code || queued.has(code)) continue;
    const e = cache.get(code);
    if (e && now - e.at < fresh) continue;
    queue.push(code);
    queued.add(code);
  }
}

/** health.json 「미니스파크」 — 몇 개를 들고 있고 몇이 줄 서 있나 */
export function sparkCacheStat(): Record<string, unknown> {
  return { 캐시: cache.size, 대기: queue.length, ...stat };
}

/**
 * 배경 워커 — 한 건씩 받아 캐시에 넣는다.
 *
 * ⚠️ 실패해도 **멈추지 않는다.** 한 종목이 안 된다고 나머지가 통째로 빈칸이 되면
 * 소켓 시절과 다를 게 없다. 실패는 세어서 health 로 낸다.
 */
export function startSparkWorker(client: KiwoomClient): void {
  if (running) return;
  running = true;
  const tick = async () => {
    const code = queue.shift();
    if (code) {
      queued.delete(code);
      try {
        const { data } = await client.request<Record<string, unknown>>(
          "/api/dostk/chart",
          "ka10080",
          { stk_cd: code, tic_scope: "3", upd_stkpc_tp: "1" },
          { noAl: true },
        );
        const line = lineFrom(data);
        if (line.length >= 2) {
          cache.set(code, { line, at: Date.now(), used: Date.now() });
          stat.받음 += 1;
          stat.마지막 = code;
          evict();
        } else {
          stat.실패 += 1;
        }
      } catch {
        stat.실패 += 1;
      }
    }
    setTimeout(() => void tick(), code ? GAP_MS : 2_000);
  };
  void tick();
}

/**
 * 분봉 응답 → 선. **가장 최근 날짜**의 봉만, 시간순으로.
 *
 * 응답은 최신순이라 날짜가 바뀌는 데서 멈추면 된다 — 화면의 `todayPoints` 와 같은 규칙이다.
 */
function lineFrom(data: Record<string, unknown>): number[] {
  const rows = (data?.stk_min_pole_chart_qry ?? []) as Record<string, unknown>[];
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const day = String(rows[0]?.cntr_tm ?? "").slice(0, 8);
  const prices: number[] = [];
  for (const r of rows) {
    const tm = String(r.cntr_tm ?? "");
    if (tm.slice(0, 8) !== day) break;
    const v = Math.abs(Number(r.cur_prc));
    if (Number.isFinite(v) && v > 0) prices.push(v);
  }
  prices.reverse(); // 최신순 → 시간순
  if (prices.length <= MAX_PTS) return prices;
  /* 솎되 **마지막 점은 꼭 남긴다** — 떨어뜨리면 선 끝이 과거가 된다 */
  const step = Math.ceil(prices.length / MAX_PTS);
  const out: number[] = [];
  for (let i = 0; i < prices.length; i += step) out.push(prices[i]);
  if (out[out.length - 1] !== prices[prices.length - 1]) out.push(prices[prices.length - 1]);
  return out;
}

function evict(): void {
  if (cache.size <= MAX_CODES) return;
  const rows = [...cache.entries()].sort((a, b) => a[1].used - b[1].used);
  for (let i = 0; i < rows.length - MAX_CODES; i += 1) cache.delete(rows[i][0]);
}
