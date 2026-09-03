import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { loadCloses } from "./dailyCloses.js";
import { getCommonStockCodes, getStockIndex } from "./stockListCache.js";
import { betaFrom, buildEtfCtx, buildThemeCtx } from "./signalBacktest.js";
import { yahooChart } from "./yahooChart.js";
import { MA_PERIODS, saveSamples, type Feat, type Sample } from "./signalSamples.js";
import type { DailyLedger, FlowRow } from "./dailyStore.js";
import { loadFinanceCache, marginTrendAt, profitAt, quarterAt, type FinanceCache } from "./financeCache.js";
import { peerMarginTrend, peerRet, sectorPeersOf } from "./sectorPeers.js";

/**
 * **원장으로 표본을 만든다** (2026-09-01) — 조회 0회.
 *
 * ## 왜
 *
 * 여태 표본은 종목마다 조회를 새로 해서 만들었다 — 500종목 × 여러 콜에 40~60분,
 * 그 사이 서버를 건드리면 통째로 날아갔다(실제로 8/500 에서 겪었다).
 *
 * 그런데 이제 그 재료가 **이미 다 있다**:
 *
 *   일봉 `dailyCloses.bars`   2,751종목 × 500봉 (2년) — 시가·고가·저가·종가·거래량
 *   원장 `data/daily/*.json`  2,627종목 × 100일 — 수급 13주체·공매도·대차·지분율
 *
 * 둘을 맞대면 표본이 나온다. **키움을 한 번도 안 부른다.**
 *
 * ## 무엇이 좋아지나
 *
 *   종목  500 → **2,627**   실측에서 가장 좋았던 소형주가 표본에 들어온다
 *   시간  40~60분 → 몇 분
 *   위험  중간에 죽으면 처음부터 → 파일만 읽으므로 다시 돌리면 그만
 *
 * ⚠️ **구간은 짧아진다.** 수급 원장이 100일뿐이라 그 안에서만 만들 수 있다
 * (기존 표본은 400일). 대신 종목이 다섯 배라 관측 수는 비슷하고, **매일 하루씩
 * 자란다** — 한 달 뒤면 기존을 넘는다.
 *
 * ## 「모른다」를 0 으로 만들지 않는다
 *
 * 원장에 그날이 없으면 그 칸은 `null` 이다. 커버리지 규칙이 그런 관측을 알아서
 * 걸러 낸다 — 억지로 채우면 오늘 아침에 겪은 「덜 잰 점수가 부풀려지는」 병이
 * 그대로 돌아온다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DAILY_DIR = join(here, "..", "data", "daily");

/** 며칠 뒤 수익률까지 볼까 — 그만큼 최근 날은 채점할 수 없다 */
const HORIZON = 20;

/**
 * ## **거래대금 하한(억)** — 이게 없으면 표본이 거짓말을 한다
 *
 * 벤티지: "거래대금이 너무 적으면 오히려 데이터가 이상해져. 신뢰할만한 데이터에
 * 돌리는 게 맞아." 그리고 신호등에 대해서도 "거래대금 최소 100억 이상은 되는
 * 종목으로 해야지. 호가 슬리피지 나겠어."
 *
 * 둘 다 맞고, **표본에서는 더 심각하다.** 전종목으로 처음 만들었더니:
 *
 *   문턱 없음   207,135관측 · 20일 중앙값 **-5.36%**
 *   10억 이상    79,814관측 · 중앙값 **-11.23%**
 *
 * 문턱을 없앴더니 성적이 **좋아졌다.** 거래가 거의 없는 종목은 종가가 며칠씩
 * 안 변해서 수익률이 그냥 **0** 으로 쌓이기 때문이다 — 실제로 「60일 신고가」에
 * 걸린 관측의 20일 중앙값이 정확히 `0.00` 이었다. 오르지도 내리지도 않은 것이
 * 표본의 3분의 2였던 셈이라, 그 0 들이 시장 기준선을 끌어올려 **모든 기준의
 * 초과수익이 실제보다 나빠 보이게** 만든다.
 *
 * 게다가 그런 종목은 **살 수가 없다.** 하루 3억 도는 종목에 천만 원을 넣으면
 * 호가가 밀린다 — 표본에서 좋게 나와도 실전에서 그 값을 못 받는다.
 *
 * 그래서 **못 사는 것은 표본에 넣지 않는다.**
 */
const MIN_VOL_EOK_DEFAULT = 100;

function sma(closes: number[], n: number): number | null {
  if (closes.length < n) return null;
  const w = closes.slice(-n);
  return w.reduce((a, b) => a + b, 0) / n;
}

/** 합계 — **한 줄이라도 값이 있어야** 낸다. 전부 null 이면 「모른다」다 */
function sumOf(rows: FlowRow[], pick: (r: FlowRow) => number | null): number | null {
  const v = rows.map(pick).filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0);
}

/** 주포 = 투신 + 연기금 + 사모 — 실측으로 확정한 셋(2026-09-01 orgn_tp) */
const smartOf = (r: FlowRow): number | null => {
  const v = [r.trust, r.pen, r.samo].filter((x): x is number => x !== null);
  return v.length === 0 ? null : v.reduce((a, b) => a + b, 0);
};

export interface BuildProgress {
  running: boolean;
  done: number;
  total: number;
  obs: number;
  skipped: number;
  /** 거래대금이 모자라 버린 **날** 수 — 문턱이 얼마나 세게 걸렸는지 보이게 */
  thinDays: number;
  /** 이번에 쓴 거래대금 하한(억) */
  minVolEok: number;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

let progress: BuildProgress = {
  running: false,
  done: 0,
  total: 0,
  obs: 0,
  skipped: 0,
  thinDays: 0,
  minVolEok: MIN_VOL_EOK_DEFAULT,
  startedAt: "",
};
let running: Promise<BuildProgress> | null = null;

export function ledgerSamplesProgress(): BuildProgress {
  return { ...progress };
}

/**
 * 원장 + 일봉 → 표본.
 *
 * @param minFlowDays 수급이 이만큼은 있어야 그 종목을 쓴다. 적으면 커버리지가
 *                    미달이라 어차피 채점에서 빠진다 — 미리 걸러 파일을 가볍게 한다
 */
export function buildSamplesFromLedger(
  client: KiwoomClient,
  minFlowDays = 60,
  /** 그날 거래대금이 이만큼(억)은 돼야 표본에 넣는다 — `MIN_VOL_EOK_DEFAULT` 주석 참고 */
  minVolEok = MIN_VOL_EOK_DEFAULT,
): Promise<BuildProgress> {
  if (running) return running;

  running = (async () => {
    progress = {
      running: true,
      done: 0,
      total: 0,
      obs: 0,
      skipped: 0,
      thinDays: 0,
      minVolEok,
      startedAt: new Date().toISOString(),
    };

    try {
      const [{ bars }, index, common, themeCtx, etfCtx, rateByDate, finDb] = await Promise.all([
        loadCloses(),
        getStockIndex(client).catch(() => new Map()),
        /*
         * **보통주만.** 스팩·우선주·리츠가 섞이면 표본이 그쪽으로 기운다 —
         * 전종목 사전훑기에서 스팩이 상위를 뒤덮은 적이 있다.
         * 목록을 못 받으면 거르지 않는다(빈 표본보다 낫다).
         */
        getCommonStockCodes(client).catch(() => null),
        /*
         * ## 렌즈 셋 — **전체에서 한 번씩만** 만든다
         *
         * 테마·ETF 는 파일 둘(테마 분류·일봉 캐시)을 읽을 뿐이라 조회가 0회고,
         * 금리는 야후를 **딱 한 번** 부른다. 종목당이 아니므로 2,600종목을 돌아도
         * 비용이 안 는다.
         *
         * 이 셋이 비면 그 기준들이 통째로 「모른다」가 되고, 그러면 커버리지
         * 문턱에 걸려 **관측이 통째로 채점 밖으로 나간다.** 처음 만들었을 때
         * 실제로 그랬다 — 207,135 중 202,862 가 빠졌다.
         */
        buildThemeCtx().catch(() => null),
        buildEtfCtx().catch(() => null),
        yahooChart("^TNX", "2y")
          .then((r) => {
            const m = new Map<string, number>();
            for (const c of r.candles) {
              /* 야후는 `YYYY-MM-DD`, 국내 일봉은 `YYYYMMDD` — 열쇠를 국내 쪽에 맞춘다 */
              const d = String(c.t).slice(0, 10).replace(/-/g, "");
              if (/^\d{8}$/.test(d) && c.close > 0) m.set(d, c.close);
            }
            return m;
          })
          .catch(() => new Map<string, number>()),
        /*
         * **실적 캐시** (2026-09-02) — 이 칸이 상수 null 이라 약세 전용 `profitGrowth`(w2)가
         * 늘 결손 → 커버리지 0.857 → **약세장 관측이 전부 채점 밖**이었다(감사 1-4).
         * 파이프라인 ⑧-2 가 주 1회 채운다. 없으면 예전처럼 null.
         */
        loadFinanceCache().catch((): FinanceCache => ({})),
      ]);
      const barsOf = bars ?? {};

      /*
       * **그날 전종목 60일 수익률 중앙값** (2026-09-02 밤, 세대 4) — 상대강도(rs60)의 기준선.
       * 실전(`hotAlerts.marketReturns`)은 오늘 하나만 내지만 표본은 날짜마다 필요하다.
       * 일봉 캐시 전종목을 한 번 훑는다 — 조회 0회, 1초 안팎.
       */
      const mkt60: Map<string, number[]> = new Map();
      for (const bs of Object.values(barsOf)) {
        for (let i = 60; i < bs.length; i++) {
          const c0 = bs[i].c;
          const c60 = bs[i - 60].c;
          if (!(c0 > 0 && c60 > 0)) continue;
          (mkt60.get(bs[i].d) ?? mkt60.set(bs[i].d, []).get(bs[i].d)!).push(((c0 - c60) / c60) * 100);
        }
      }
      const mkt60Med = new Map<string, number>();
      for (const [d, arr] of mkt60) {
        if (arr.length < 100) continue;
        const s = arr.sort((a, b) => a - b);
        const m = s.length >> 1;
        mkt60Med.set(d, s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
      }

      const files = (await readdir(DAILY_DIR)).filter((f) => f.endsWith(".json"));
      progress.total = files.length;
      /* 세대 5 섹터 칸 메모 — (테마 번호:날짜) → 중앙값. 종목이 달라도 같은 테마·날짜면 같은 값 */
      const secMTMemo = new Map<string, number | null>();
      const secRetMemo = new Map<string, number | null>();

      const out: Sample[] = [];

      for (const f of files) {
        progress.done += 1;
        const code = f.replace(/\.json$/, "");
        if (common && !common.has(code)) {
          progress.skipped += 1;
          continue;
        }
        const bs = barsOf[code];
        if (!bs || bs.length < 65) {
          progress.skipped += 1;
          continue;
        }

        let led: DailyLedger;
        try {
          led = JSON.parse(await readFile(join(DAILY_DIR, f), "utf-8")) as DailyLedger;
        } catch {
          progress.skipped += 1;
          continue;
        }
        const flow = led.flow ?? [];
        if (flow.length < minFlowDays) {
          progress.skipped += 1;
          continue;
        }

        /* 날짜 → 몇 번째 봉인가. 원장과 일봉을 **날짜로** 맞춘다 */
        const barAt = new Map<string, number>();
        bs.forEach((b, i) => barAt.set(b.d, i));

        const shortRows = led.short ?? [];
        const loanRows = led.loan ?? [];
        const ratioRows = led.fgnRatio ?? [];
        const shortAt = new Map(shortRows.map((r, i) => [r.d, i]));
        const loanAt = new Map(loanRows.map((r, i) => [r.d, i]));
        const ratioAt = new Map(ratioRows.map((r, i) => [r.d, i]));

        const entry = index.get(code);
        const share = entry && entry.shares > 0 ? entry.shares : null;
        const name = entry?.name ?? code;
        const fin = finDb[code];

        /* 종가 배열은 **종목당 한 번만** 만든다 — 날마다 만들면 21만 번이 된다 */
        const closesAll = bs.map((b) => b.c);

        /*
         * ## 렌즈의 인덱스 맞추기
         *
         * 테마·ETF 렌즈는 「끝에서 k번째」로 값을 들고 있다(k=0 이 마지막 날).
         * 백테스트는 캐시에 날짜가 없어 종가 다섯 개를 맞대 오프셋을 찾아야 했는데
         * (`alignDates`), 여기서는 **같은 `bars` 를 직접 쓰므로** 그럴 게 없다 —
         * `k = 마지막 - bi` 가 그대로 맞다.
         */
        const kOf = (bi: number) => bs.length - 1 - bi;
        const myThemes = themeCtx?.themesOf.get(code) ?? [];
        const etfRates = etfCtx?.rate.get(code);
        /* 금리 베타가 쓸 날짜 열 — 종목당 한 번 */
        const datesAll = bs.map((b) => b.d);
        /*
         * 세대 5 섹터 칸 — 종목당 섹터(테마 회원사)는 한 번, (테마·날짜)별 중앙값은 메모.
         * 회원사 실적·일봉은 전부 파일이라 조회가 없다. ⚠️ 테마 구성은 오늘 것(`sectorPeers` 주석).
         */
        const peers = await sectorPeersOf(code).catch(() => null);
        const secMTAt = async (date: string): Promise<number | null> => {
          if (!peers) return null;
          const k = `${peers.no}:${date}`;
          if (!secMTMemo.has(k)) secMTMemo.set(k, (await peerMarginTrend(peers.codes, date))?.med ?? null);
          return secMTMemo.get(k) ?? null;
        };
        const secRetAt = async (date: string): Promise<number | null> => {
          if (!peers) return null;
          const k = `${peers.no}:${date}`;
          if (!secRetMemo.has(k)) secRetMemo.set(k, (await peerRet(peers.codes, 20, date))?.med ?? null);
          return secRetMemo.get(k) ?? null;
        };
        const secRet10At = async (date: string): Promise<number | null> => {
          if (!peers) return null;
          const k = `${peers.no}:10:${date}`;
          if (!secRetMemo.has(k)) secRetMemo.set(k, (await peerRet(peers.codes, 10, date))?.med ?? null);
          return secRetMemo.get(k) ?? null;
        };

        /*
         * 수급이 있는 날만 표본이 된다. 일봉은 2년치지만 수급이 100일이라,
         * 그 교집합이 곧 쓸 수 있는 구간이다.
         */
        for (let fi = 0; fi < flow.length; fi++) {
          const date = flow[fi].d;
          const bi = barAt.get(date);
          if (bi === undefined) continue;
          /* 20일 뒤가 없으면 채점을 못 한다 — 최근 20봉은 표본이 아니다 */
          if (bi + HORIZON >= bs.length) continue;
          if (bi < 64) continue;

          const cur = closesAll[bi];
          if (!(cur > 0)) continue;

          /*
           * **못 사는 날은 표본이 아니다.** 거래대금이 문턱 아래면 버린다 —
           * 종목이 아니라 **그날**을 본다. 평소 잘 도는 종목도 어느 날은 말라붙고,
           * 그날 산다고 가정하면 실전에서 못 받을 값을 재게 된다.
           */
          const volEok = (bs[bi].v * cur) / 100_000_000;
          if (volEok < minVolEok) {
            progress.thinDays += 1;
            continue;
          }

          const closes = closesAll.slice(0, bi + 1);
          const win60 = closes.slice(-61, -1);
          const hi60 = win60.length > 0 ? Math.max(...win60) : 0;
          const m20 = sma(closes, 20);
          const m5 = sma(closes, 5);

          /* 탈락 승격 넷의 재료 (세대 4) — 실전 `hotAlerts.computeAlerts` 와 같은 정의 */
          const lr: number[] = [];
          for (let k = bi - 19; k <= bi; k++) {
            const a = closesAll[k - 1];
            const b = closesAll[k];
            if (a > 0 && b > 0) lr.push(Math.log(b / a));
          }
          let volat20: number | null = null;
          if (lr.length >= 15) {
            const mean = lr.reduce((s, x) => s + x, 0) / lr.length;
            volat20 = Math.sqrt(lr.reduce((s, x) => s + (x - mean) ** 2, 0) / lr.length) * 100;
          }
          const range = bs[bi].l > 0 && bs[bi].h > bs[bi].l ? ((bs[bi].h - bs[bi].l) / bs[bi].l) * 100 : null;
          const c60 = bi >= 60 ? closesAll[bi - 60] : 0;
          const mm60 = mkt60Med.get(date);
          const rs60 = c60 > 0 && mm60 !== undefined ? ((cur - c60) / c60) * 100 - mm60 : null;
          const lo60 = bi >= 60 ? Math.min(...bs.slice(bi - 60, bi).map((b) => b.l).filter((x) => x > 0)) : 0;
          const lo60Pct = Number.isFinite(lo60) && lo60 > 0 ? (cur / lo60) * 100 : null;

          /* ── 세대 5 칸 (2026-09-03) — 실전 `evaluateSignal` 과 같은 정의 ── */
          const win61 = closesAll.slice(bi - 60, bi + 1);
          const hi61 = Math.max(...win61);
          const dd60 = hi61 > 0 ? (cur / hi61 - 1) * 100 : null;
          const rise60 = c60 > 0 && hi61 > 0 ? (hi61 / c60 - 1) * 100 : null;
          /* 20일 창 — 세대 5 기본 (단기 스윙) */
          const win21 = closesAll.slice(bi - 20, bi + 1);
          const hi21 = Math.max(...win21);
          const c20 = closesAll[bi - 20];
          const dd20 = hi21 > 0 ? (cur / hi21 - 1) * 100 : null;
          const rise20 = c20 > 0 && hi21 > 0 ? (hi21 / c20 - 1) * 100 : null;
          const gap20 = m20 ? ((cur - m20) / m20) * 100 : null;
          const vol20 = bs.slice(bi - 19, bi + 1).map((b) => b.v);
          const v5 = vol20.slice(-5).reduce((s, v) => s + v, 0) / 5;
          const v20 = vol20.reduce((s, v) => s + v, 0) / 20;
          const vGrow = v20 > 0 ? v5 / v20 : null;
          let dnV = 0, dnN = 0, upV = 0, upN = 0;
          for (let k = bi - 19; k <= bi; k++) {
            const a = closesAll[k - 1], b = closesAll[k];
            if (!(a > 0 && b > 0)) continue;
            if (b < a) { dnV += bs[k].v; dnN += 1; } else if (b > a) { upV += bs[k].v; upN += 1; }
          }
          const vDist = dnN > 0 && upN > 0 ? (dnV / dnN) / (upV / upN) : null;
          const mTrend = marginTrendAt(fin, date)?.trend ?? null;
          const secMT = await secMTAt(date);
          const secRet = await secRetAt(date);
          const ret20 = bi >= 20 && closesAll[bi - 20] > 0 ? ((cur - closesAll[bi - 20]) / closesAll[bi - 20]) * 100 : null;
          const secRel = secRet !== null && ret20 !== null ? ret20 - secRet : null;
          /* 10일 — 세대 5 기본 */
          const secRet10 = await secRet10At(date);
          const ret10 = bi >= 10 && closesAll[bi - 10] > 0 ? ((cur - closesAll[bi - 10]) / closesAll[bi - 10]) * 100 : null;
          const secRel10 = secRet10 !== null && ret10 !== null ? ret10 - secRet10 : null;

          /*
           * **위쪽 매물** — 이제 거래량으로 잰다. 일봉에 고가·저가·거래량이
           * 들어오기 전에는 못 내던 값이고, 전종목 사전훑기에서는 날짜 비중으로
           * 근사하고 있었다.
           */
          const win120 = bs.slice(Math.max(0, bi - 119), bi + 1);
          const hi = Math.max(...win120.map((b) => b.h));
          const lo = Math.min(...win120.map((b) => b.l));
          let over: number | null = null;
          if (hi > lo) {
            const above = win120
              .filter((b) => (b.h + b.l) / 2 > cur)
              .reduce((s, b) => s + b.v, 0);
            const tot = win120.reduce((s, b) => s + b.v, 0);
            if (tot > 0) over = (above / tot) * 100;
          }

          /** 최근 n거래일 수급 — 원장은 옛날 → 최신 순이다 */
          const win = (n: number) => flow.slice(Math.max(0, fi + 1 - n), fi + 1);

          /* 외국인 연속 순매수 — 오늘부터 거슬러 */
          let fgnStreak = 0;
          for (let k = fi; k >= 0; k--) {
            const v = flow[k].fgn;
            if (v === null || v <= 0) break;
            fgnStreak += 1;
          }

          const si = shortAt.get(date);
          const li = loanAt.get(date);
          const ri = ratioAt.get(date);

          const avg = (arr: (number | null)[]) => {
            const v = arr.filter((x): x is number => x !== null);
            return v.length === 0 ? null : v.reduce((a, b) => a + b, 0) / v.length;
          };

          const feat: Feat = {
            cur,
            ma: MA_PERIODS.map((p) => sma(closes, p)),
            hiPct: hi60 > 0 ? (cur / hi60) * 100 : null,
            disp: m20 ? Math.max(0, ((cur - m20) / m20) * 100) : null,
            ma5Gap: m5 ? Math.max(0, ((cur - m5) / m5) * 100) : null,
            over,
            /* 거래대금(억) = 종가 × 거래량 ÷ 1억 */
            volEok,
            /* 그날 이 종목이 든 테마 중 **가장 강한** 것 — 신호등과 같은 규칙 */
            theme: (() => {
              if (myThemes.length === 0) return null;
              const k = kOf(bi);
              let best: number | null = null;
              for (const no of myThemes) {
                const v = themeCtx?.rate.get(no)?.[k];
                if (v !== undefined && (best === null || v > best)) best = v;
              }
              return best;
            })(),
            etfBack: etfRates?.[kOf(bi)] ?? null,
            fgn5: sumOf(win(5), (r) => r.fgn),
            fgn10: sumOf(win(10), (r) => r.fgn),
            fgn20: sumOf(win(20), (r) => r.fgn),
            fgn60: sumOf(win(60), (r) => r.fgn),
            inst5: sumOf(win(5), (r) => r.org),
            inst10: sumOf(win(10), (r) => r.org),
            inst20: sumOf(win(20), (r) => r.org),
            inst60: sumOf(win(60), (r) => r.org),
            smart5: sumOf(win(5), smartOf),
            smart20: sumOf(win(20), smartOf),
            smart60: sumOf(win(60), smartOf),
            fgnStreak,
            /* 그 날짜에 **이미 공시돼 있던** 실적만 — look-ahead 없음 (`financeCache` 참고) */
            profitYoY: profitAt(fin, date),
            ...quarterAt(fin, date),
            /* 그날 종가 × 오늘 상장주식수 — 증자·분할이 있었으면 그만큼 어긋난다 */
            mktCap: share !== null && share > 0 ? (share * cur) / 100_000_000 : null,
            short5:
              si === undefined ? null : avg(shortRows.slice(Math.max(0, si - 4), si + 1).map((r) => r.ratio)),
            short20:
              si === undefined || si < 5
                ? null
                : avg(shortRows.slice(Math.max(0, si - 19), si - 4).map((r) => r.ratio)),
            loan: li === undefined ? null : loanRows[li].rmnd,
            loanUp20:
              li === undefined || li < 20 || !loanRows[li - 20].rmnd || !loanRows[li].rmnd
                ? null
                : ((loanRows[li].rmnd! - loanRows[li - 20].rmnd!) / loanRows[li - 20].rmnd!) * 100,
            fgnRatio: ri === undefined ? null : ratioRows[ri].ratio,
            fgnRatioUp20:
              ri === undefined || ri < 20 || ratioRows[ri].ratio === null || ratioRows[ri - 20].ratio === null
                ? null
                : ratioRows[ri].ratio! - ratioRows[ri - 20].ratio!,
            rateBeta: betaFrom(datesAll, closesAll, bi, rateByDate),
            volat20,
            range,
            rs60,
            lo60Pct,
            dd60,
            rise60,
            dd20,
            rise20,
            secRel10,
            gap20,
            vGrow,
            vDist,
            mTrend,
            secMT,
            secRel,
          };

          /*
           * ## ⚠️ **다음 날 시가에 산다** — 오늘 종가가 아니다
           *
           * 처음엔 오늘 종가에서 재고 있었다. 그런데 **점수도 그 종가까지 보고
           * 낸 것**이라, 종가를 보고 판단해 그 종가에 사는 불가능한 매매가 된다.
           * 점수가 높은 날은 대개 그날 오른 날이므로 수익률이 통째로 부풀려진다.
           *
           * 백테스트(`signalBacktest`)는 이미 다음 날 시가로 사고 있었다 —
           * 같은 앱의 두 표본이 서로 다른 규칙으로 재고 있으면 비교가 안 된다.
           *
           * d1 은 다음 날 시가에 사서 **그날 종가**에 파는 하루짜리다.
           */
          const fwd = (k: number): number | null => {
            const entry = bs[bi + 1];
            const exit = bs[bi + k];
            if (!entry || !exit || !(entry.o > 0)) return null;
            return ((exit.c - entry.o) / entry.o) * 100;
          };

          out.push({
            ...feat,
            code,
            name,
            date,
            d1: fwd(1),
            d5: fwd(5),
            d20: fwd(20),
          });
        }
      }

      progress.obs = out.length;
      await saveSamples({
        builtAt: new Date().toISOString(),
        days: HORIZON,
        codeCount: files.length - progress.skipped,
        samples: out,
      });
    } catch (e) {
      progress.error = e instanceof Error ? e.message : String(e);
    }

    progress.running = false;
    progress.finishedAt = new Date().toISOString();
    return progress;
  })().finally(() => {
    running = null;
  });

  return running;
}
