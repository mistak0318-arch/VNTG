import { fixSector } from "./sectorFix.js";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getSection, getSectorStocks, type Sectors, type StockRow } from "./marketOverview.js";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 전종목 시세 스냅샷.
 *
 * 수동 테마의 등락률을 내려면 구성종목의 현재가와 시가총액이 필요하다.
 * 종목마다 조회하면 테마 10개 × 10종목 = 100회라 초당 5회 제한에 걸려 못 쓴다.
 *
 * **모든 종목은 업종 하나에 속한다.** 그래서 업종 구성종목을 전부 모으면
 * 65회(코스피 31 + 코스닥 34) 호출로 전종목 등락률·시총이 나온다.
 * 한 번 만들어두면 테마가 몇 개든 계산만 하면 되므로 추가 호출이 0이다.
 *
 * 65회를 초당 5회로 나눠 부르면 13초쯤 걸린다. 그래서:
 *   - 5분 캐시를 둔다
 *   - 만들어지는 동안 들어온 요청은 같은 약속을 기다린다 (중복 조회 방지)
 *   - 실패한 업종이 있어도 나머지로 스냅샷을 만든다 (전부 아니면 무 방식은 취약하다)
 */

export interface SnapshotStock {
  code: string;
  name: string;
  changeRate: number;
  price: number;
  /** 시가총액(억원). 키움이 안 주는 종목이 있다 */
  marketCap: number | null;
  /** 거래대금 어림값(억원) — 거래량 × 현재가. `StockRow.tradeValue` 주석 참고 */
  tradeValue: number | null;
  sector: string;
  market: "kospi" | "kosdaq";
}

/**
 * 산업 업종이 아닌 「업종」 코드.
 *
 * 키움 업종 목록 65개를 전부 뽑아 보니 **19개가 산업이 아니었다.**
 *
 *   지수·규모  001 종합(KOSPI) · 002 대형주 · 003 중형주 · 004 소형주 · 101 종합(KOSDAQ)
 *              138 KOSDAQ 100 · 139 MID 300 · 140 SMALL · 150 KOSDAQ 150 · 151 코스닥글로벌
 *   스타일     603 변동성지수 · 604 코스피고배당50 · 605 코스피배당성장50
 *   등급       142 우량기업 · 143 벤처기업 · 144 중견기업 · 145 신성장기업
 *   선물       160 F-KOSDAQ150 · 165 F-KOSDAQ150인버스   ← 종목이 아니다
 *
 * **이름이 아니라 코드로 거른다.** 이름은 「코스닥 우량기업」처럼 제각각이라 규칙으로
 * 잡기 어렵고 바뀔 수도 있지만, 코드는 안 바뀐다.
 *
 * ## 왜 이게 문제였나
 *
 * 종목은 **산업과 규모·지수 묶음에 동시에 들어간다.** 그래서 먼저 훑은 쪽이 이기면
 * SK하이닉스 업종이 「종합(KOSPI)」로 굳는다. 실제로 주도 섹터를 세어 보니
 * **「오늘 강한 섹터 1위: 대형주」**가 나왔다 — 아무 말도 아닌 결과다.
 *
 * 덤으로 **조회가 19회 줄어든다**(65 → 46). 스냅샷 만드는 시간도 그만큼 짧아진다.
 */
const NON_SECTOR_CODES = new Set([
  // KOSPI
  "001", "002", "003", "004", "603", "604", "605",
  // KOSDAQ
  "101", "138", "139", "140", "142", "143", "144", "145", "150", "151", "160", "165",
]);

export function isRealSectorCode(code: string): boolean {
  return !NON_SECTOR_CODES.has(String(code).trim());
}

/** 이름만 있을 때 쓰는 예비 판정 — 저장된 옛 스냅샷을 읽을 때가 있다 */
export function isRealSector(name: string): boolean {
  if (!name) return false;
  return !/^종합|^대형주$|^중형주$|^소형주$|KOSDAQ\s|KOSPI\s*\d|코스닥\s|코스피고배당|코스피배당|변동성지수|F-KOSDAQ/.test(
    name,
  );
}

export interface MarketSnapshot {
  /** 6자리 종목코드 → 시세. `_AL` 접미사는 떼서 넣는다 */
  byCode: Map<string, SnapshotStock>;
  at: number;
  /** 조회에 실패한 업종 수 — 스냅샷이 얼마나 온전한지 판단용 */
  failedSectors: number;
  totalSectors: number;
  /**
   * 거래가 반영된 스냅샷인가.
   *
   * 개장 전에 부르면 키움은 전일 종가를 주면서 등락률만 전부 0으로 준다. 그걸 그대로
   * 저장하면 "전 테마 0.00%"가 되고, 조간 리포트에서 내 테마가 통째로 쓸모없어진다.
   * 그래서 만들 때 판정해 두고, **0짜리가 멀쩡한 직전 종가 스냅샷을 덮어쓰지 못하게** 한다.
   */
  traded: boolean;
}

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "marketSnapshot.json");

/**
 * 장중 캐시 수명.
 *
 * 65업종을 훑는 데 15초쯤 걸린다. 그래서 만료된 뒤 화면에 들어가면 그 15초를 기다리게 된다 —
 * 내 테마 메뉴를 열 때마다 로딩이 걸리던 게 그것이다.
 * 아래 스케줄러가 **만료되기 전에 미리** 갱신해 두므로, 화면은 항상 완성된 캐시를 받는다.
 */
const INTRADAY_TTL_MS = 10 * 60_000;

let cache: MarketSnapshot | null = null;
/** 만드는 중이면 같은 약속을 돌려줘서 65회 조회가 겹치지 않게 한다 */
let building: Promise<MarketSnapshot> | null = null;
/** 디스크에서 한 번만 읽어오면 되므로 */
let restored = false;
/** 개장 전 0짜리라 버린 시각 — 1분마다 65회 조회를 되풀이하지 않으려고 */
let rejectedAt = 0;

/**
 * 스냅샷이 언제까지 쓸 만한가.
 *
 * 장이 끝나면 종가는 더 안 바뀐다. 그런데 예전엔 5분 TTL을 그대로 써서 마감 후에도,
 * 주말에도 5분마다 65업종을 다시 불렀다 — 같은 숫자를 받으려고 15초를 쓴 셈이다.
 *
 * 그래서 장중에만 5분을 쓰고, 그 밖에는 **다음 개장(09:00 KST)까지** 유지한다.
 * 주말이면 자연히 월요일 09시까지 간다. 공휴일 달력은 없지만, 휴장일에 만료돼 봐야
 * 직전 거래일 종가를 다시 받아올 뿐이라 손해가 없다.
 */
function expiryOf(at: number): number {
  const d = new Date(at);
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  const minutes = kst.getHours() * 60 + kst.getMinutes();
  const weekday = kst.getDay() !== 0 && kst.getDay() !== 6;
  const duringSession = weekday && minutes >= 9 * 60 && minutes < 15 * 60 + 40;

  if (duringSession) return at + INTRADAY_TTL_MS;

  // 다음 개장 09:00 KST — 오늘 09시가 아직 안 지났으면 오늘, 지났으면 그다음 평일
  const next = new Date(kst);
  next.setHours(9, 0, 0, 0);
  if (next.getTime() <= kst.getTime()) next.setDate(next.getDate() + 1);
  // 주말을 건너뛴다. 안 그러면 토·일 아침마다 같은 종가를 받으려고 65회를 다시 부른다
  while (next.getDay() === 0 || next.getDay() === 6) next.setDate(next.getDate() + 1);
  return at + (next.getTime() - kst.getTime());
}

function isFresh(snap: MarketSnapshot | null): snap is MarketSnapshot {
  return Boolean(snap && Date.now() < expiryOf(snap.at));
}

// ---------------------------------------------------------------- 디스크 보관

interface StoredSnapshot {
  at: number;
  failedSectors: number;
  totalSectors: number;
  traded?: boolean;
  stocks: SnapshotStock[];
}

/**
 * 재시작해도 다시 안 부르도록 디스크에 남긴다.
 * 미니PC를 껐다 켜는 일이 잦은데, 그때마다 65회 조회를 다시 하면 15초를 기다려야 한다.
 */
async function persist(snap: MarketSnapshot): Promise<void> {
  const stored: StoredSnapshot = {
    at: snap.at,
    failedSectors: snap.failedSectors,
    totalSectors: snap.totalSectors,
    traded: snap.traded,
    stocks: [...snap.byCode.values()],
  };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(stored), "utf-8");
}

async function restore(): Promise<MarketSnapshot | null> {
  try {
    const stored = JSON.parse(await readFile(FILE, "utf-8")) as StoredSnapshot;
    if (!Array.isArray(stored.stocks) || stored.stocks.length === 0) return null;
    return {
      byCode: new Map(stored.stocks.map((s) => [s.code, s])),
      at: stored.at,
      failedSectors: stored.failedSectors ?? 0,
      totalSectors: stored.totalSectors ?? 0,
      // 이 필드가 생기기 전에 저장된 파일은 실제 등락률로 되짚는다
      traded:
        stored.traded ??
        stored.stocks.filter((s) => s.changeRate !== 0).length > stored.stocks.length * 0.1,
    };
  } catch {
    return null;
  }
}

/** 키움은 종목코드에 `_AL`(NXT 통합) 접미사를 붙여 준다. 우리 기준은 6자리다 */
export function bareCode(code: string): string {
  return code.replace(/_AL$/, "").trim();
}

async function build(client: KiwoomClient): Promise<MarketSnapshot> {
  const section = await getSection("sectors", client).catch(() => null);
  const sectors = (section?.data ?? null) as Sectors | null;

  const targets: { market: "kospi" | "kosdaq"; code: string; name: string }[] = [];
  for (const market of ["kospi", "kosdaq"] as const) {
    for (const s of (market === "kospi" ? sectors?.kospi : sectors?.kosdaq) ?? []) {
      // 산업이 아닌 것은 **아예 안 부른다** — 조회도 아끼고 업종 배정도 안 더럽힌다
      if (s.code && isRealSectorCode(s.code)) targets.push({ market, code: s.code, name: s.name });
    }
  }

  const byCode = new Map<string, SnapshotStock>();
  let failed = 0;

  // 초당 5회 제한 — 5개씩 묶어 돌린다
  for (let i = 0; i < targets.length; i += 5) {
    const chunk = targets.slice(i, i + 5);
    const results = await Promise.all(
      chunk.map((t) =>
        getSectorStocks(client, t.market, t.code)
          .then((rows) => ({ t, rows }))
          .catch(() => ({ t, rows: [] as StockRow[] })),
      ),
    );

    for (const { t, rows } of results) {
      if (rows.length === 0) {
        failed += 1;
        continue;
      }
      for (const r of rows) {
        const code = bareCode(r.code);
        if (!code) continue;
        /*
         * 같은 종목이 **두 업종에 다 나온다.** 산업 업종과 「대형주」·「종합(KOSPI)」 같은
         * 규모·지수 묶음에 동시에 속하기 때문이다.
         * 먼저 온 것을 유지하면 SK하이닉스 업종이 「종합(KOSPI)」로 굳어버린다 —
         * **산업 쪽을 이긴 것으로 친다.**
         */
        const had = byCode.get(code);
        if (had && (isRealSector(had.sector) || !isRealSector(t.name))) continue;
        byCode.set(code, {
          code,
          name: r.name,
          changeRate: r.changeRate,
          price: r.price ?? 0,
          marketCap: r.marketCap ?? null,
          tradeValue: r.tradeValue ?? null,
          /* 지주사를 금융에 넣는 거래소 분류를 여기서도 고친다 — `sectorFix` 참고 */
          sector: fixSector(code, t.name),
          market: t.market,
        });
      }
    }

    if (i + 5 < targets.length) await new Promise((r) => setTimeout(r, 1100));
  }

  /*
   * 거래 반영 여부. 개장 전에는 전 종목이 0으로 오므로 한 종목이라도 움직였는지로 본다.
   * 시각으로 짐작하지 않으므로 공휴일에도 자동으로 맞는다.
   */
  const moved = [...byCode.values()].filter((s) => s.changeRate !== 0).length;

  return {
    byCode,
    at: Date.now(),
    failedSectors: failed,
    totalSectors: targets.length,
    // 소수 종목만 0이 아닌 건 시간외 단일가 같은 잡음이라 거래로 보지 않는다
    traded: byCode.size > 0 && moved > byCode.size * 0.1,
  };
}

export async function getMarketSnapshot(
  client: KiwoomClient,
  force = false,
): Promise<MarketSnapshot> {
  /*
   * ⚠️ 디스크 복원은 **force 여도** 한다 (2026-08-26).
   *
   * 예전엔 `!force` 안에 있어서, 재시작 직후 백그라운드 갱신(force)이 먼저 돌면
   * 복원을 건너뛴 채 cache=null 로 build 에 들어갔다. 그 순간 업종 목록 조회가
   * 실패하면 **빈 스냅샷이 캐시로 굳고 디스크의 멀쩡한 종가까지 덮어썼다** —
   * 마감 후엔 만료가 다음날 09시라, 마켓 브리핑 관심종목이 밤새 전부 「-」였다.
   * 복원된 캐시가 있어야 아래 「절반 미만이면 유지」 방어가 설 자리도 생긴다.
   */
  if (!restored) {
    restored = true;
    const saved = await restore();
    if (saved && (!cache || saved.at > cache.at)) cache = saved;
  }
  if (!force && isFresh(cache)) return cache;

  if (building) return building;

  building = build(client)
    .then(async (snap) => {
      // 절반도 못 받았으면 이전 스냅샷을 유지한다 — 반쪽 데이터로 테마 등락률을 내면 틀린다
      if (cache && snap.byCode.size < cache.byCode.size / 2) return cache;
      /*
       * 통째로 무너진 조회는 **캐시로 굳히지도 않는다** (2026-08-26).
       * 전종목 스냅샷은 정상일 때 2천 종목이 넘는다 — 몇백도 안 되면 데이터가 아니라
       * 장애다. 캐시가 있으면 그걸 지키고, 없으면 굳히지 않고 돌려만 준다
       * (rejectedAt 이 5분 뒤 재시도를 잡는다).
       */
      if (snap.byCode.size < 500) {
        rejectedAt = Date.now();
        return cache ?? snap;
      }
      /*
       * 개장 전 0짜리로 직전 거래일 종가를 덮지 않는다.
       *
       * 갱신 스케줄러는 만료 1분 전(= 개장 1분 전 08:59)에 미리 채우는데, 그때는 아직
       * 거래가 없어 전 종목 0으로 온다. 그걸 저장하면 디스크 파일까지 0으로 덮여서
       * 그 사이 재시작하면 하루치 전종목 시세를 잃는다. 0은 직전 종가가 담고 있지 않은
       * 정보가 없으므로 버려도 손해가 없다.
       */
      if (!snap.traded && cache?.traded) {
        rejectedAt = Date.now();
        return cache;
      }
      cache = snap;
      /* 0짜리(개장 전)는 메모리에만 — 디스크의 직전 종가 파일은 traded 일 때만 덮는다 */
      if (snap.traded) await persist(snap).catch(() => undefined);
      return snap;
    })
    .finally(() => {
      building = null;
    });

  return building;
}

/**
 * 백그라운드 갱신.
 *
 * 캐시가 만료되고 나서 사용자가 들어오면 15초를 기다려야 한다. 그래서 만료 **직전에**
 * 서버가 알아서 다시 만들어 둔다. 화면은 늘 만들어져 있는 캐시를 즉시 받는다.
 * 장이 안 열렸으면 값이 안 바뀌므로 돌지 않는다 (expiryOf 가 다음 개장까지로 잡아준다).
 */
export function startSnapshotRefresher(client: KiwoomClient): void {
  const tick = () => {
    if (building) return;
    // 만료 1분 전부터 미리 채운다
    const due = !cache || Date.now() > expiryOf(cache.at) - 60_000;
    if (!due) return;
    /*
     * 방금 0짜리를 받아 버렸다면 잠깐 쉰다. 만료 시각이 개장 09:00 이라 08:59부터 due 가
     * 계속 참이고, 버린 스냅샷은 cache.at 을 갱신하지 않으므로 그냥 두면 1분마다
     * 65회 조회를 되풀이한다.
     */
    if (Date.now() - rejectedAt < 5 * 60_000) return;
    /*
     * force 로 부른다. 아직 만료 전이라 그냥 부르면 getMarketSnapshot 이
     * "신선하다"고 판단해 캐시를 그대로 돌려주고 갱신이 일어나지 않는다.
     */
    void getMarketSnapshot(client, true).catch((err: unknown) => {
      console.error("[snapshot] 갱신 실패:", err instanceof Error ? err.message : err);
    });
  };
  setTimeout(tick, 20_000); // 서버가 뜨자마자 몰리지 않게 조금 늦춘다
  setInterval(tick, 60_000);
  console.log("[snapshot] 전종목 스냅샷 백그라운드 갱신 시작 (장중 10분 주기)");
}

/** 캐시에 있으면 준다. 없으면 null — 조회를 기다릴 수 없는 자리에서 쓴다 */
export function peekSnapshot(): MarketSnapshot | null {
  return isFresh(cache) ? cache : null;
}

/** 스냅샷이 언제 찍힌 것이고 언제까지 쓰는지 — 화면에 보여주기 위해 */
export function snapshotStatus(): { at: number; expiresAt: number; size: number } | null {
  return cache ? { at: cache.at, expiresAt: expiryOf(cache.at), size: cache.byCode.size } : null;
}
