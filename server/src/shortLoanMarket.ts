import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadCloses } from "./dailyCloses.js";
import { getStockIndex } from "./stockListCache.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import type { DailyLedger } from "./dailyStore.js";

/**
 * **시장 전체 공매도·대차잔고** (2026-11-27).
 *
 * 벤티지: "시황 대시보드 마지막에 그 카드도 넣을 수 있나? 전체 시장의 대차잔고 수량이나
 * 공매도 수량, 왜냐면 그게 또 외국인의 포지션을 결정하는 거라고 하더라고."
 *
 * ## 조회 0회 — 이미 받아 둔 것을 더한다
 *
 * 시장 합계를 주는 TR 은 키움에도 한투에도 **없다**([[vntg-hts-api-constraints]]).
 * 그런데 `collectDaily` 가 마감 뒤에 **전종목** 공매도(`ka10014`)·대차잔고(`ka20068`)를
 * 받아 원장에 쌓고 있다. 그러니 밖에서 받아올 것이 아니라 **우리 원장을 더하면 된다** —
 * 새 조회도, 새 크롤링도 없다. 「답은 우리 코드에 있었다」([[answer-already-in-our-code]])
 * 와 같은 자리다.
 *
 * 금액은 원장의 수량 × 그날 **정규장 종가**(`dailyCloses` 의 `c`)다. 잔고는 「몇 주」로는
 * 크기를 가늠할 수 없다 — 1,000원짜리 1억주와 10만원짜리 1억주는 100배 차이다.
 *
 * ## 「비중」은 일부러 안 낸다
 *
 * 공매도 거래대금 ÷ 전체 거래대금을 내고 싶었는데, 두 숫자의 **분모가 다르다**:
 * 공매도는 통합(`_AL` — KRX+NXT)으로 받고 일봉(`ka10081`)은 접미 없는 **KRX 단독**이다.
 * 그대로 나누면 분모가 작아 비중이 **부푼다**(실측으로 5~8% 가 나왔는데 공표치는 3~5%대).
 * 틀린 숫자를 그럴싸하게 적느니 **안 적는다** — 대신 금액과 수량, 그리고 20일 평균선으로
 * 「요즘 평소보다 센가」를 말한다. ([[number-units-verify-by-product]])
 *
 * ## 덜 잰 날은 버린다
 *
 * 대차잔고는 **전 종목에 다 있는 잔고**라 커버리지가 떨어지면 그건 장이 아니라 **수집이
 * 끊긴 것**이다. 그 날을 그대로 그리면 잔고가 뚝 꺼진 것처럼 보인다 —
 * [[signal-coverage-rule]] 이 말하는 「덜 잰 점수」다. 그래서 그날 담긴 종목이 최대치의
 * 80% 에 못 미치면 **그 날짜를 아예 뺀다**. (실측 2026-11-27: 140거래일 전부 99% 이상이라
 * 평소엔 한 날도 안 빠진다. 수집이 중간에 죽은 날을 위한 문단속이다)
 *
 * ## 언제 다시 세나
 *
 * 2,659개 파일을 훑는 일이라 **요청마다 하면 안 된다**(실측 1.5초 · heap +18MB).
 * 하루 한 번, **20:10 마무리 회차**에서 공매도·대차 확정값을 받은 직후에 센다
 * (`afterClose` 의 `ledgerFinal`). 그 밖에는 파일에 적어 둔 것을 그대로 준다.
 * 배포로 서버가 다시 떠도 파일이 남아 있어 다시 세지 않는다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data");
const LEDGER_DIR = join(DIR, "daily");
const FILE = join(DIR, "shortLoanMarket.json");

/** 차트가 60거래일을 쓰고 20일 비교까지 하니 90일이면 넉넉하다 */
const WINDOW = 90;
/**
 * 종목마다 읽을 줄 수 — 창보다 **넉넉히** 읽는다.
 *
 * ⚠️ 딱 `WINDOW` 만 자르면 **창의 앞쪽이 거짓으로 비어 보인다.** 원장이 140줄인 종목은
 * 뒤 90줄만 내놓고, 80줄인 종목은 전부 내놓는다 — 그러면 141-90=51번째보다 앞선 날짜는
 * **짧은 원장을 가진 몇 종목만 든 날**이 되어 합계가 뚝 떨어진다. 실측(2026-11-27): 이대로
 * 두었더니 50일이 「덜 받은 날」로 빠졌는데, 수집은 멀쩡했고 **자르기가 틀린 것**이었다.
 * 넉넉히 읽어 두고 **날짜로 창을 끊은 뒤에** 커버리지를 본다.
 */
const READ_ROWS = WINDOW + 40;
/** 이 비율에 못 미치는 날은 「수집이 끊긴 날」로 보고 뺀다 */
const COVERAGE_MIN = 0.8;
/** 대차 증감 상위에 올릴 최소 잔고 금액(원) — 잡주의 100% 증가가 윗자리를 먹지 않게 */
const MOVER_MIN_AMT = 10_000_000_000;
/**
 * 고를 수 있는 구간 (거래일). 벤티지: "당일 5일 10일 20일 선택해서 볼 수 있게 하자" (2026-11-27).
 * 1 = 전 거래일 대비.
 */
const SPANS = [1, 5, 10, 20] as const;
/** 종목별로 들고 있을 대차 줄 수 — 가장 긴 구간(20)에 오늘까지 더해 넉넉히 */
const TAIL_ROWS = 24;

export interface ShortLoanDay {
  /** YYYY-MM-DD */
  date: string;
  /** 공매도 **거래량**(주) — 그날 판 수량이지 잔고가 아니다 */
  shortQty: number;
  /** 공매도 거래대금(**원**) = 수량 × 그날 정규장 종가 */
  shortAmt: number;
  /** 공매도가 있었던 종목 수 — 없는 날은 줄이 아예 없어서 날마다 다르다(정상) */
  shortCodes: number;
  /** 대차 **잔고** 수량(주) — 빌려 간 채 안 갚은 주식 */
  loanQty: number;
  /** 대차잔고 금액(**원**) */
  loanAmt: number;
  /** 대차잔고가 담긴 종목 수 — 커버리지 눈금 */
  loanCodes: number;
  /** 시장별 쪼갠 값(원). 종목 목록을 못 받았으면 0 */
  shortAmtKospi: number;
  shortAmtKosdaq: number;
  loanAmtKospi: number;
  loanAmtKosdaq: number;
}

export interface ShortLoanMover {
  code: string;
  name: string;
  /** 지금 대차잔고 수량(주) */
  rmnd: number;
  /** 5거래일 전 수량(주) */
  prev: number;
  /** 늘어난 **금액**(원) — 포지션 크기는 수량이 아니라 금액이다 */
  diffAmt: number;
  /** 늘어난 비율(%) */
  diffPct: number;
  /** 지금 잔고 금액(원) */
  amt: number;
}

/**
 * 한 구간의 대차잔고 증감 상위.
 *
 * 벤티지: "당일 5일 10일 20일 선택해서 볼 수 있게 하자" (2026-11-27) — 네 구간을 **한 바퀴에
 * 같이 센다.** 구간마다 따로 세면 원장을 네 번 훑게 된다.
 */
export interface ShortLoanSpan {
  /** 며칠 전과 견줬나 (1 = 당일, 곧 전 거래일 대비) */
  days: number;
  /** 견준 상대 날짜 (YYYY-MM-DD) */
  from: string;
  /** 가장 많이 **는** 종목 (금액 기준) */
  up: ShortLoanMover[];
  /** 가장 많이 **준** 종목 — 숏커버링 자리 */
  down: ShortLoanMover[];
}

export interface ShortLoanMarket {
  /** 언제 셌나 (ISO) */
  builtAt: string;
  /** 가장 최근 거래일 (YYYY-MM-DD) */
  upTo: string;
  /** 옛날 → 최신 */
  days: ShortLoanDay[];
  /** 구간별 증감 상위 — 당일·5·10·20일 */
  spans: ShortLoanSpan[];
  /** 더한 종목 수 */
  codes: number;
  /** 수량은 있는데 그날 종가가 없어 금액을 못 낸 횟수 */
  noPrice: number;
  /** 커버리지 미달로 뺀 날짜 */
  dropped: string[];
}

function dash(ymd: string): string {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
}

interface Acc {
  shortQty: number;
  shortAmt: number;
  shortCodes: number;
  loanQty: number;
  loanAmt: number;
  loanCodes: number;
  shortAmtKospi: number;
  shortAmtKosdaq: number;
  loanAmtKospi: number;
  loanAmtKosdaq: number;
}

function emptyAcc(): Acc {
  return {
    shortQty: 0,
    shortAmt: 0,
    shortCodes: 0,
    loanQty: 0,
    loanAmt: 0,
    loanCodes: 0,
    shortAmtKospi: 0,
    shortAmtKosdaq: 0,
    loanAmtKospi: 0,
    loanAmtKosdaq: 0,
  };
}

/**
 * 원장을 한 바퀴 돌며 날짜별로 더한다.
 *
 * ⚠️ 파일을 **하나씩** 읽는다. 전부 메모리에 올리면 100MB 짜리 덩어리가 생긴다 —
 * 서버가 OOM 으로 죽던 그 꼴이다([[server-oom-and-autorevive]]). `await` 가 파일마다
 * 들어가 이벤트 루프도 같이 돈다.
 */
export async function buildShortLoanMarket(client: KiwoomClient | null): Promise<ShortLoanMarket> {
  const store = await loadCloses();
  const bars = store.bars ?? {};

  /*
   * 시장·이름 — 하루 캐시된 목록(`ka10099`)이라 **조회가 안 는다**.
   * 못 받으면 쪼개기와 이름만 포기하고 합계는 그대로 낸다.
   */
  const market = new Map<string, string>();
  const names = new Map<string, string>();
  if (client) {
    try {
      const idx = await getStockIndex(client);
      for (const [code, e] of idx) {
        market.set(code, e.marketName);
        names.set(code, e.name);
      }
    } catch {
      market.clear();
      names.clear();
    }
  }

  const acc = new Map<string, Acc>();
  const get = (d: string): Acc => {
    let a = acc.get(d);
    if (!a) {
      a = emptyAcc();
      acc.set(d, a);
    }
    return a;
  };

  /** 종목별 최근 대차잔고 몇 줄 — 구간별 증감 상위를 내려고 들고 있는다(종목당 스물넷이라 가볍다) */
  const tailLoan = new Map<string, { d: string; rmnd: number }[]>();

  let files: string[] = [];
  try {
    files = (await readdir(LEDGER_DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    files = [];
  }

  let codes = 0;
  let noPrice = 0;

  for (const f of files) {
    let l: DailyLedger;
    try {
      l = JSON.parse(await readFile(join(LEDGER_DIR, f), "utf-8")) as DailyLedger;
    } catch {
      continue;
    }
    const code = f.replace(/\.json$/, "");
    const short = l.short ?? [];
    const loan = l.loan ?? [];
    if (short.length === 0 && loan.length === 0) continue;
    codes++;

    /* 그날 종가를 찾을 쪽지 — 종목마다 만들고 버린다 */
    const arr = bars[code];
    const px = new Map<string, number>();
    if (Array.isArray(arr)) for (const b of arr.slice(-(READ_ROWS + 10))) px.set(b.d, b.c);

    const mk = market.get(code) ?? "";

    for (const r of short.slice(-READ_ROWS)) {
      if (r.qty === null) continue;
      const a = get(r.d);
      a.shortQty += r.qty;
      a.shortCodes++;
      const c = px.get(r.d);
      if (!c) {
        noPrice++;
        continue;
      }
      const amt = r.qty * c;
      a.shortAmt += amt;
      if (mk === "코스닥") a.shortAmtKosdaq += amt;
      else if (mk === "거래소") a.shortAmtKospi += amt;
    }

    const tail: { d: string; rmnd: number }[] = [];
    for (const r of loan.slice(-READ_ROWS)) {
      if (r.rmnd === null) continue;
      const a = get(r.d);
      a.loanQty += r.rmnd;
      a.loanCodes++;
      const c = px.get(r.d);
      if (c) {
        const amt = r.rmnd * c;
        a.loanAmt += amt;
        if (mk === "코스닥") a.loanAmtKosdaq += amt;
        else if (mk === "거래소") a.loanAmtKospi += amt;
      } else noPrice++;
      tail.push({ d: r.d, rmnd: r.rmnd });
    }
    if (tail.length > 0) tailLoan.set(code, tail.slice(-TAIL_ROWS));
  }

  /*
   * 덜 잰 날 빼기 — 대차잔고는 전 종목에 있는 잔고라 커버리지가 곧 수집 상태다.
   * 공매도 종목 수는 날마다 다른 게 정상이라(판 사람이 없으면 줄이 없다) 눈금으로 안 쓴다.
   */
  const all = [...acc.keys()].sort();
  /* **창을 날짜로 먼저 끊는다** — 넉넉히 읽은 앞쪽은 버리는 것이지 「덜 받은 날」이 아니다 */
  const window = all.slice(-WINDOW);
  const maxCov = Math.max(1, ...window.map((d) => acc.get(d)!.loanCodes));
  const dropped: string[] = [];
  const pick: string[] = [];
  for (const d of window) {
    if (acc.get(d)!.loanCodes < maxCov * COVERAGE_MIN) dropped.push(dash(d));
    else pick.push(d);
  }

  const days: ShortLoanDay[] = pick.map((d) => {
    const a = acc.get(d)!;
    return { date: dash(d), ...a };
  });

  /*
   * 구간별 증감 상위 — 당일(전 거래일 대비)·5·10·20일.
   *
   * 금액은 **지금 종가 하나로** 양쪽을 친다. 그래야 「주가가 올라서 금액이 늘었다」가 섞이지
   * 않고 **빌려 간 수량이 는 것만** 남는다. 구간이 길수록 가격이 많이 움직이니 더 중요하다.
   */
  const lastD = pick[pick.length - 1] ?? "";
  const spans: ShortLoanSpan[] = [];
  for (const n of SPANS) {
    const fromD = pick[pick.length - 1 - n] ?? "";
    if (!lastD || !fromD || fromD === lastD) continue;
    const movers: ShortLoanMover[] = [];
    for (const [code, tail] of tailLoan) {
      const now = tail.find((r) => r.d === lastD)?.rmnd;
      const was = tail.find((r) => r.d === fromD)?.rmnd;
      if (now === undefined || was === undefined || was <= 0) continue;
      const c = bars[code]?.at(-1)?.c;
      if (!c) continue;
      const amt = now * c;
      if (amt < MOVER_MIN_AMT) continue;
      movers.push({
        code,
        name: names.get(code) ?? code,
        rmnd: now,
        prev: was,
        diffAmt: (now - was) * c,
        diffPct: ((now - was) / was) * 100,
        amt,
      });
    }
    spans.push({
      days: n,
      from: dash(fromD),
      up: [...movers].filter((m) => m.diffAmt > 0).sort((a, b) => b.diffAmt - a.diffAmt).slice(0, 5),
      down: [...movers].filter((m) => m.diffAmt < 0).sort((a, b) => a.diffAmt - b.diffAmt).slice(0, 5),
    });
  }

  return {
    builtAt: new Date().toISOString(),
    upTo: days.length > 0 ? days[days.length - 1].date : "",
    days,
    spans,
    codes,
    noPrice,
    dropped,
  };
}

/* ------------------------------------------------------------------ */
/* 저장 · 캐시                                                          */
/* ------------------------------------------------------------------ */

let cache: ShortLoanMarket | null = null;
let building: Promise<ShortLoanMarket> | null = null;
/** 원장이 자랐나를 마지막으로 들여다본 때 — 요청마다 보면 그것도 파일 읽기다 */
let probedAt = 0;
const PROBE_GAP_MS = 10 * 60_000;

async function readFileCache(): Promise<ShortLoanMarket | null> {
  try {
    const raw = JSON.parse(await readFile(FILE, "utf-8")) as ShortLoanMarket;
    if (!Array.isArray(raw.days)) return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * 원장의 가장 최근 대차 날짜 — **삼성전자 한 파일만** 들여다본다.
 *
 * 「다시 셀 때가 됐나」를 알려면 원장이 자랐는지 봐야 하는데, 그걸 보겠다고 2,659개를
 * 다시 읽으면 본말이 뒤집힌다. 전종목 수집은 코드순으로 도니 005930 은 늘 들어 있다.
 */
async function probeUpTo(): Promise<string> {
  try {
    const l = JSON.parse(await readFile(join(LEDGER_DIR, "005930.json"), "utf-8")) as DailyLedger;
    const last = (l.loan ?? []).filter((r) => r.rmnd !== null).at(-1);
    return last ? dash(last.d) : "";
  } catch {
    return "";
  }
}

async function save(m: ShortLoanMarket): Promise<void> {
  try {
    await mkdir(DIR, { recursive: true });
    await writeFile(FILE, JSON.stringify(m), "utf-8");
  } catch (err) {
    console.warn("[shortLoan] 저장 실패 —", (err as Error).message);
  }
}

/** 다시 세고 적는다 — 마감 뒤 정리(`ledgerFinal`)가 부른다 */
export async function rebuildShortLoanMarket(client: KiwoomClient | null): Promise<ShortLoanMarket> {
  if (building) return building;
  building = (async () => {
    const t0 = Date.now();
    const m = await buildShortLoanMarket(client);
    await save(m);
    cache = m;
    probedAt = Date.now();
    console.log(
      `[shortLoan] ${m.days.length}일 · ${m.codes}종목 · ${m.upTo} 까지 · ${((Date.now() - t0) / 1000).toFixed(1)}초` +
        (m.dropped.length ? ` · 뺀 날 ${m.dropped.length}` : ""),
    );
    return m;
  })();
  try {
    return await building;
  } finally {
    building = null;
  }
}

/**
 * 화면이 부르는 자리. **세지 않고 적어 둔 것을 준다** — 원장이 자랐을 때만 다시 센다.
 */
export async function shortLoanMarket(client: KiwoomClient | null): Promise<ShortLoanMarket> {
  if (building) return building;
  if (!cache) cache = await readFileCache();
  if (!cache) return rebuildShortLoanMarket(client);
  if (Date.now() - probedAt >= PROBE_GAP_MS) {
    probedAt = Date.now();
    const upTo = await probeUpTo();
    /* 빈 문자열이면 「못 봤다」다 — 그걸로 다시 세지 않는다 */
    if (upTo && upTo > cache.upTo) return rebuildShortLoanMarket(client);
  }
  return cache;
}
