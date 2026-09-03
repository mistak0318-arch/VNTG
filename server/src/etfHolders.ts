import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { recordApiCall } from "./apiUsage.js";
import { isEnabled, markRun } from "./naverSyncConfig.js";

/**
 * **이 종목을 담고 있는 ETF** (2026-08-27) — 역인덱스.
 *
 * ## 왜 인덱스를 미리 만드나
 *
 * 「ETF → 구성종목」은 있는데(네이버 etfAnalysis) **「종목 → 그 종목을 담은 ETF」는
 * 어디에도 없다.** 실측으로 확인했다 — 네이버 relatedEtf·etfList·includedEtf 는 전부
 * 404 고, 종목 integration 응답에도 ETF 참조가 없다. 키움 ETF 묶음(ka40001~40010)에도
 * 구성종목 자체가 없다.
 *
 * 그래서 **뒤집어 만든다**: 거래대금 상위 ETF 를 훑어 각자의 구성종목을 받고,
 * `종목코드 → [담은 ETF]` 로 뒤집어 파일에 둔다. 화면은 그 파일만 읽으므로 **조회 0회**다.
 *
 * ## 한계를 화면이 말해야 한다
 *
 * 네이버가 주는 건 **Top10 구성종목**뿐이다. 삼성전자처럼 큰 종목은 잘 잡히지만,
 * 비중이 낮은 종목은 그 ETF 에 들어 있어도 Top10 밖이라 안 잡힌다.
 * 「없음」이 「안 담겼음」을 뜻하지 않는다 — 화면에 그대로 적는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "etfHolders.json");

/** 어느 ETF 가 이 종목을 얼마나 담았나 */
export interface EtfHolder {
  code: string;
  name: string;
  /** 이 ETF 안에서 그 종목의 비중(%) */
  weight: number | null;
  /** 순자산총액 — 사람이 읽는 형태("25조 4,885억") */
  aum: string;
  /** 순자산 원 단위 — 정렬용 */
  aumRaw: number;
  /** 오늘 등락률 */
  changeRate: number | null;
  /** 기간 수익률(%) — 1주·1개월·3개월. 네이버 returnPerformanceList */
  w1: number | null;
  m1: number | null;
  m3: number | null;
  /** 추적지수 */
  index: string;
}

interface Store {
  builtAt: string;
  /** 훑은 ETF 수 */
  scanned: number;
  /** 종목코드 → 담은 ETF 목록 */
  byStock: Record<string, EtfHolder[]>;
}

const EMPTY: Store = { builtAt: "", scanned: 0, byStock: {} };
let cache: Store | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(FILE, "utf-8")) as Store;
  } catch {
    cache = { ...EMPTY };
  }
  return cache;
}

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[%,+\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * **오늘 등락률은 파일이 아니라 시세에서** (2026-09-03 버그 — 벤티지: "ETF 뒷배가 현재가를
 * 반영 안 하고 있다. 슈퍼신호등에 ETF 뒷배 상승률이 어제 꺼가 나오고 있어").
 *
 * 파일의 `changeRate` 는 **인덱스를 만든 순간**(16시 이후 하루 한 번)의 값이다. 다음 날
 * 16시까지 그 값이 그대로 남으니 장중엔 늘 어제 등락률이었다 — 「매일 갱신되어 들어온다」는
 * 주석이 틀렸었다. 구성·비중은 하루 한 번이면 되지만 등락률은 아니다.
 *
 * 그래서 읽을 때 키움 ETF 전체시세(ka40004, 3분 캐시)로 등락률만 덮어 쓴다. 한 번에 ~1,000
 * 행이 오므로 종목 수와 무관하게 3분에 한 번이다. 여러 종목이 동시에 부르면(슈퍼 대시보드)
 * 한 번만 받도록 진행 중인 약속을 나눠 쓴다. 시세를 못 받으면 파일 값으로 — 없는 것보다
 * 어제 값이 낫다.
 */
let liveClient: KiwoomClient | null = null;
let liveRates: { at: number; map: Map<string, number> } | null = null;
let liveInflight: Promise<Map<string, number>> | null = null;
const LIVE_TTL = 3 * 60_000;

export function setEtfHoldersClient(client: KiwoomClient): void {
  liveClient = client;
}

async function liveRateMap(): Promise<Map<string, number> | null> {
  if (!liveClient) return null;
  if (liveRates && Date.now() - liveRates.at < LIVE_TTL) return liveRates.map;
  if (!liveInflight) {
    const client = liveClient;
    liveInflight = (async () => {
      const { etfAll } = await import("./routes/etf.js");
      const map = new Map<string, number>();
      for (const r of await etfAll(client)) map.set(r.code, r.changeRate);
      liveRates = { at: Date.now(), map };
      return map;
    })().finally(() => {
      liveInflight = null;
    });
  }
  try {
    return await liveInflight;
  } catch {
    return liveRates?.map ?? null;
  }
}

/** 화면이 부르는 조회 — 구성·비중은 파일, 오늘 등락률은 시세(3분 캐시) */
export async function etfHoldersOf(code: string): Promise<{
  holders: EtfHolder[];
  builtAt: string;
  scanned: number;
}> {
  const s = await load();
  const live = await liveRateMap();
  const holders = [...(s.byStock[code] ?? [])]
    .map((h) => {
      const r = live?.get(h.code);
      return r === undefined ? h : { ...h, changeRate: r };
    })
    .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  return { holders, builtAt: s.builtAt, scanned: s.scanned };
}

/**
 * 인덱스를 다시 만든다 — 거래대금 상위 `limit` 개 ETF 를 훑는다.
 *
 * 네이버는 인증이 없지만 예의는 지킨다(간격 250ms). 150개면 40초쯤 걸리고,
 * 하루 한 번이면 충분하다 — ETF 구성은 그보다 자주 바뀌지 않는다.
 */
export async function buildEtfHolders(
  client: KiwoomClient,
  limit = 150,
): Promise<{ scanned: number; stocks: number }> {
  const { etfAll } = await import("./routes/etf.js");
  const all = await etfAll(client);
  const targets = [...all].sort((a, b) => b.tradeValue - a.tradeValue).slice(0, limit);

  const byStock: Record<string, EtfHolder[]> = {};
  let scanned = 0;

  for (const etf of targets) {
    try {
      const res = await fetch(`https://m.stock.naver.com/api/stock/${etf.code}/etfAnalysis`, {
        headers: { "user-agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) {
        void recordApiCall("naver", "etfAnalysis", res.status === 404 ? "ok" : "failed");
        continue;
      }
      const d = (await res.json()) as Record<string, unknown>;
      void recordApiCall("naver", "etfAnalysis", "ok");
      const top = Array.isArray(d.etfTop10MajorConstituentAssets)
        ? (d.etfTop10MajorConstituentAssets as Record<string, unknown>[])
        : [];
      if (top.length === 0) continue;
      scanned += 1;

      const perf = Array.isArray(d.returnPerformanceList)
        ? (d.returnPerformanceList as Record<string, unknown>[])
        : [];
      const at = (k: string) => num(perf.find((p) => p.periodTypeCode === k)?.value);

      const base: Omit<EtfHolder, "weight"> = {
        code: etf.code,
        name: etf.name,
        aum: String(d.marketValue ?? ""),
        aumRaw: num(d.marketValueRaw) ?? 0,
        changeRate: etf.changeRate,
        w1: at("W1"),
        m1: at("M1"),
        m3: at("M3"),
        index: String(d.etfBaseIndex ?? etf.index ?? ""),
      };

      for (const t of top) {
        const stockCode = String(t.itemCode ?? "").trim();
        if (!/^\d{6}$/.test(stockCode)) continue;
        const row: EtfHolder = { ...base, weight: num(t.etfWeight) };
        byStock[stockCode] = [...(byStock[stockCode] ?? []), row];
      }
    } catch {
      /* 이 ETF 만 건너뛴다 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  /* 한 건도 못 받았으면 **덮지 않는다** — 있던 인덱스가 빈 파일로 날아가면 안 된다 */
  if (scanned === 0) return { scanned: 0, stocks: 0 };

  const store: Store = { builtAt: new Date().toISOString(), scanned, byStock };
  await mkdir(dirname(FILE), { recursive: true });
  await writeFile(FILE, JSON.stringify(store), "utf-8");
  cache = store;
  return { scanned, stocks: Object.keys(byStock).length };
}

// ---------------------------------------------------------------- 스케줄러

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** 하루 한 번(장 마감 뒤) — 그리고 인덱스가 아예 없으면 기동 후 한 번 */
export function startEtfHoldersScheduler(client: KiwoomClient): void {
  setEtfHoldersClient(client);
  if (timer) return;
  const tick = async () => {
    if (running) return;
    const s = await load();
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const built = s.builtAt.slice(0, 10);
    const kst = new Date(Date.now() + 9 * 3600_000);
    const hour = kst.getUTCHours();
    /* 16시 이후 하루 한 번. 인덱스가 통째로 없으면 시간과 무관하게 한 번 만든다 */
    if (built === today) return;
    if (s.builtAt && hour < 16) return;
    if (!(await isEnabled("etfHolders"))) return;
    running = true;
    try {
      const r = await buildEtfHolders(client);
      if (r.scanned > 0) {
        console.log(`[etfHolders] 인덱스 갱신 — ETF ${r.scanned}곳 · 종목 ${r.stocks}개`);
      }
      await markRun("etfHolders", true, `ETF ${r.scanned}곳 · 종목 ${r.stocks}개`);
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      console.error("[etfHolders] 실패:", m);
      await markRun("etfHolders", false, m);
    } finally {
      running = false;
    }
  };
  setTimeout(() => void tick(), 90_000); // 기동 직후는 다른 초기화에 자리를 내준다
  timer = setInterval(() => void tick(), 30 * 60_000);
  console.log("[etfHolders] ETF 보유 인덱스 스케줄러 시작 (하루 1회, 16시 이후)");
}
