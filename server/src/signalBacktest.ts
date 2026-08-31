import { getSharesMap } from "./stockListCache.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { dropPhantomToday } from "./candleGuard.js";
import { getConfig, type CheckConfig, type SignalConfig } from "./signalLight.js";
import { loadCloses } from "./dailyCloses.js";
import {
  MA_PERIODS,
  gradeOf,
  saveSamples,
  scoreFeat,
  type Feat,
  type Sample,
} from "./signalSamples.js";
import { isIndexLikeTheme, loadThemes } from "./naverThemes.js";
import { yahooChart } from "./yahooChart.js";

/**
 * 신호등 백테스트 — **과거의 그날로 돌아가 같은 기준으로 다시 매긴다.**
 *
 * ## 무엇을 답하나
 *
 * 「이 기준으로 초록을 준 종목이 그 뒤 어떻게 됐나」. 기준을 바꿔 가며 돌리면
 * 가중치와 문턱을 감이 아니라 숫자로 정할 수 있다.
 *
 * ## ⚠️ 재현할 수 있는 것과 없는 것
 *
 * 신호등의 모든 기준을 과거로 되돌릴 수는 없다. **일봉만 있으면 되는 것**은 그대로
 * 재현된다 — 정배열·신고가·이격도·매물 부담·거래대금. 어느 날의 일봉은 지금도
 * 그때와 같기 때문이다.
 *
 * **수급 3종도 2026-08-31 부터 재현한다** — `ka10060` 이 하루하루를 주기 때문이다.
 * 「조회가 더 나간다」는 이유로 빼 두었는데, 채점 밖에 여섯이나 두는 편이 더 나빴다.
 * 종목당 최대 6콜이 더 나가고 전체가 몇 배 느려진다(`withFlow` 로 끌 수 있다).
 *
 * 아직 재현 못 하는 것은 **그때의 구성·공시를 모르는 것들**이다:
 *   · ETF 뒷배 — 그때의 편입 비중을 모른다
 *   · 영업이익 증가 — 그 시점에 공시돼 있던 분기가 무엇인지 알아야 한다
 *   · 시가총액 — 그때의 상장주식수를 모른다(오늘 것으로 근사할 수는 있다)
 *
 * 테마 강세는 **최근 60여 일만** 되짚히고 그마저 구성은 오늘 것이다(아래 주석).
 *
 * 빠진 기준이 무엇인지 결과에 적어 보낸다 — 「전부 재현했다」고 보이면 그 숫자를
 * 잘못 믿게 된다. 그리고 그 판단은 목록이 아니라 **실제 표본**으로 한다.
 *
 * 없는 것을 지어내지 않는 대신, 있는 것만으로 답할 수 있는 물음이 있다:
 * **가격이 그린 모양만으로 얼마나 갈 수 있나.**
 */

const CHART = "/api/dostk/chart";

/**
 * 백테스트가 재현할 수 있는 기준 — 나머지는 계산에서 빠진다.
 *
 * `naverTheme` 는 2026-08-28 부터 **최근 60여 일 한정으로** 재현된다 — 일봉 캐시
 * (2,300여 종목 × 70일)로 테마의 하루하루 평균 등락률을 되짚을 수 있어서다.
 * ⚠️ 정직한 한계: **구성은 오늘 것**이다. 두 달 안에서 편입이 크게 안 바뀐다고
 * 가정한다 — 그 밖의 기간은 판단 불가(null)로 빠진다(0 으로 지어내지 않는다).
 */
export const BACKTESTABLE = new Set([
  "trend",
  "newHigh",
  "nearHigh",
  "disparity",
  "ma5Gap",
  "overhead",
  "volume",
  "naverTheme",
  /*
   * 수급 3종 (2026-08-31) — `ka10060` 이 **날짜별로** 주므로 되짚힌다.
   * 「받아올 수는 있지만 조회가 더 나간다」는 이유로 빼 두었던 것인데, 그 조회를
   * 감수하기로 했다(`withFlow`). 이걸로 채점 밖이 여섯에서 셋으로 줄었다.
   */
  "foreignFlow",
  "instFlow",
  "flowStreak",
  /*
   * 수급 개편 (2026-09-01) — 60일·주포는 **같은 응답 안에 있어 조회가 안 는다.**
   * 시가총액은 상장주식수(하루 캐시) × 그날 종가라 역시 안 는다.
   */
  "flowPersist",
  "flowAccel",
  "smartMoney",
  "marketCap",
  "flowRatio",
  /* 종목당 3콜이 더 나가지만, 이걸로 「검증 못 한 기준」이 셋 줄었다 (2026-09-01) */
  "shortSaleUp",
  "lendingUp",
  "foreignRatioUp",
]);

/* ------------------------------------------------------------------ */
/* 테마 렌즈 재구성                                                     */
/* ------------------------------------------------------------------ */

interface ThemeCtx {
  /** 테마 no → 하루하루 평균 등락률(%). k=0 이 캐시의 마지막 날, 커질수록 과거 */
  rate: Map<number, number[]>;
  /** 종목 → 든 사업 테마 no 들 (지수성 제외) */
  themesOf: Map<string, number[]>;
  /** 재현 가능한 날 수 */
  span: number;
}

/**
 * 일봉 캐시에서 테마별 일일 등락률을 되짚는다 — 조회 0회.
 * 구성원 절반 이상이 값을 내야 그날을 센다(모자라면 그 날은 없음).
 */
async function buildThemeCtx(): Promise<ThemeCtx | null> {
  const [{ themes }, { closes }] = await Promise.all([loadThemes(), loadCloses()]);
  if (themes.length === 0 || Object.keys(closes).length === 0) return null;

  const rate = new Map<number, number[]>();
  const themesOf = new Map<string, number[]>();
  let span = 0;

  for (const t of themes) {
    if (isIndexLikeTheme(t.name)) continue;
    const members = t.stocks.map((s) => closes[s.code]).filter((a) => a && a.length >= 2);
    if (members.length < Math.max(2, t.stocks.length * 0.5)) continue;

    const maxK = Math.min(...members.map((a) => a.length - 1));
    const rates: number[] = [];
    for (let k = 0; k < maxK; k++) {
      let sum = 0;
      let n2 = 0;
      for (const a of members) {
        const i = a.length - 1 - k;
        if (i >= 1 && a[i - 1] > 0) {
          sum += ((a[i] - a[i - 1]) / a[i - 1]) * 100;
          n2 += 1;
        }
      }
      if (n2 < members.length * 0.5) break;
      rates.push(sum / n2);
    }
    if (rates.length < 5) continue;
    rate.set(t.no, rates);
    span = Math.max(span, rates.length);
    for (const s of t.stocks) {
      const list = themesOf.get(s.code) ?? [];
      list.push(t.no);
      themesOf.set(s.code, list);
    }
  }
  return rate.size > 0 ? { rate, themesOf, span } : null;
}

/**
 * 캐시의 「끝에서 k번째」가 어느 날짜인가 — **종가를 맞대 보고 정한다.**
 *
 * 캐시에는 날짜가 없다(종가 배열뿐). 대충 「마지막 = 오늘」로 두면 장중에 받은
 * 캐시와 하루 어긋나 모든 판정이 한 칸 밀린다 — 그건 조용한 거짓이다.
 * 그래서 같은 종목의 **일봉(날짜 있음)과 종가 다섯 개를 맞대** 오프셋을 찾는다.
 * 다섯 개가 다 맞는 자리만 믿고, 못 찾으면 그 종목으로는 정하지 않는다.
 */
function alignDates(cache: number[] | undefined, bars: Bar[]): Map<string, number> | null {
  if (!cache || cache.length < 6 || bars.length < 8) return null;
  for (let off = 0; off <= 2; off++) {
    let match = true;
    for (let j = 0; j < 5; j++) {
      const a = cache[cache.length - 1 - j];
      const b = bars[bars.length - 1 - off - j]?.close;
      if (!b || Math.abs(a - b) > Math.max(1, a * 0.001)) {
        match = false;
        break;
      }
    }
    if (match) {
      const map = new Map<string, number>();
      for (let k = 0; k < cache.length - 1; k++) {
        const bar = bars[bars.length - 1 - off - k];
        if (!bar) break;
        map.set(bar.date, k);
      }
      return map;
    }
  }
  return null;
}

export interface BacktestRow {
  /** 신호가 켜진 날 (YYYYMMDD) */
  date: string;
  code: string;
  name: string;
  score: number;
  level: "green" | "yellow" | "red";
  /** 그날 종가 */
  close: number;
  /** N거래일 뒤 수익률(%) — 아직 그만큼 안 지났으면 null */
  d1: number | null;
  d5: number | null;
  d20: number | null;
}

export interface BacktestResult {
  /** 실제로 쓴 기준 */
  used: string[];
  /** 과거를 몰라 뺀 기준 */
  skipped: string[];
  days: number;
  codes: number;
  rows: BacktestRow[];
  /** 초록만 모은 성적 */
  green: Summary;
  /** 견줄 대상 — 같은 기간 **모든 날·모든 종목**의 평균. 이걸 못 이기면 뜻이 없다 */
  base: Summary;
  /**
   * 점수대별 성적 — **이 표가 기준이 맞는지를 스스로 증명한다.**
   *
   * 70점 초록과 95점 초록이 한 칸에 섞여 있으면 「초록이 좋다」까지만 알 수 있다.
   * 점수를 나눠 놓고 **위 칸이 아래 칸보다 잘 갔는지** 보면, 점수라는 것이 실제로
   * 무언가를 재고 있는지가 드러난다. 순서가 뒤집혀 있으면(80점대가 60점대보다 못
   * 가면) 그 기준 조합은 점수를 잘못 매기고 있는 것이다.
   */
  buckets: { label: string; from: number; to: number; s: Summary }[];
  note: string;
}

export interface Summary {
  n: number;
  d1: { avg: number | null; win: number | null };
  d5: { avg: number | null; win: number | null };
  d20: { avg: number | null; win: number | null };
}

interface Bar {
  date: string;
  /** 다음 날 시가 — **매수가**로 쓴다 (2026-08-31). 아래 fwd 주석 참고 */
  open: number;
  close: number;
  high: number;
  low: number;
  vol: number;
}

function n(v: unknown): number {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
}

/** 일봉 — 옛날→최신 */
async function bars(client: KiwoomClient, code: string): Promise<Bar[]> {
  const base = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const res = await client.request<Record<string, unknown>>(CHART, "ka10081", {
    stk_cd: code,
    base_dt: base,
    upd_stkpc_tp: "1",
  });
  return (dropPhantomToday((res.data?.stk_dt_pole_chart_qry ?? []) as Record<string, unknown>[]))
    .map((r) => ({
      date: String(r.dt ?? ""),
      open: Math.abs(n(r.open_pric)),
      close: Math.abs(n(r.cur_prc)),
      high: Math.abs(n(r.high_pric)),
      low: Math.abs(n(r.low_pric)),
      vol: Math.abs(n(r.trde_qty)),
    }))
    .filter((b) => /^\d{8}$/.test(b.date) && b.close > 0 && b.open > 0)
    .reverse();
}

const sma = (xs: number[], p: number): number | null =>
  xs.length < p ? null : xs.slice(-p).reduce((a, b) => a + b, 0) / p;

function grade(value: number, c: CheckConfig): number {
  const hi = Math.max(c.threshold, c.strongAt);
  const lo = Math.min(c.threshold, c.strongAt);
  if (value >= hi) return 100;
  if (value >= lo) return 50;
  return 0;
}

/**
 * 그날의 **원시값**만 뽑는다 — 설정은 안 본다.
 *
 * 채점(`scoreFeat`)과 갈라 둔 이유는 시뮬레이터 때문이다. 비싼 것은 일봉이지
 * 채점이 아니라서, 원시값만 파일로 남겨 두면 설정을 바꿔도 다시 안 받아도 된다.
 * 여기서 낸 값과 백테스트가 쓰는 값이 **같아야** 두 화면의 숫자가 맞는다.
 */
/** 하루치 수급 — 금액(백만원), 신호등과 **같은 단위** */
interface FlowDay {
  date: string;
  fgn: number;
  inst: number;
  /** 주포 — 투신 + 연기금등 + 사모펀드. 같은 응답 안에 있어 조회가 안 는다 */
  smart: number;
}

/**
 * 종목 하나의 **날짜별 수급** — `ka10060` 은 하루하루를 주므로 과거도 되짚힌다.
 *
 * ⚠️ 파라미터를 신호등(`signalLight`)과 **한 글자도 다르게 쓰면 안 된다.**
 * `amt_qty_tp:"1"`(금액·백만원), `unit_tp:"1000"`, `stk_cd` 는 통합(_AL) 이 아닌
 * 순수 코드다. 저장된 문턱이 그 단위 기준이라, 다르게 부르면 같은 종목을 놓고
 * 신호등과 백테스트가 **다른 숫자**를 보게 된다.
 *
 * 한 쪽에 100줄쯤 오므로 400일을 채우려면 연속조회가 필요하다.
 */
async function flowDays(client: KiwoomClient, code: string, want: number): Promise<FlowDay[]> {
  const params = {
    stk_cd: code,
    dt: new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, ""),
    amt_qty_tp: "1",
    trde_tp: "0",
    unit_tp: "1000",
  };
  const first = await client.request<Record<string, unknown>>(CHART, "ka10060", params);
  const rows = ((first.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[]).slice();
  let contYn = first.contYn;
  let nextKey = first.nextKey;
  /* 다섯 쪽이면 500줄 — 400일을 달라 해도 넘친다. 무한 루프 방지도 겸한다 */
  for (let page = 0; page < 5 && rows.length < want && contYn === "Y" && nextKey; page += 1) {
    const more = await client.request<Record<string, unknown>>(CHART, "ka10060", params, {
      contYn: "Y",
      nextKey,
    });
    const add = (more.data?.stk_invsr_orgn_chart ?? []) as Record<string, unknown>[];
    if (add.length === 0) break;
    rows.push(...add);
    contYn = more.contYn;
    nextKey = more.nextKey;
  }
  return rows
    .map((r) => ({
      date: String(r.dt ?? ""),
      fgn: n(r.frgnr_invsr),
      inst: n(r.orgn),
      /*
       * 주포 — 투신 + 연기금등 + 사모펀드 (2026-09-01).
       * **같은 응답 안에 있다.** 조회가 하나도 안 는다. `algoScan` 과 신호등의
       * `smartMoney` 가 쓰는 것과 같은 세 칸이라 이름도 같게 둔다.
       */
      smart: n(r.invtrt) + n(r.penfnd_etc) + n(r.samo_fund),
    }))
    .filter((r) => /^\d{8}$/.test(r.date))
    .sort((a, b) => a.date.localeCompare(b.date));
}

/* ------------------------------------------------------------------ */
/* 공매도 · 대차 · 외국인 지분율 — 되짚을 수 있는 시계열 세 개          */
/* ------------------------------------------------------------------ */

const SHSA = "/api/dostk/shsa";
const SLB = "/api/dostk/slb";
const FRGNISTT = "/api/dostk/frgnistt";

type SupplySums = Pick<
  Feat,
  "short5" | "short20" | "loan" | "loanUp20" | "fgnRatio" | "fgnRatioUp20"
>;

const NO_SUPPLY: SupplySums = {
  short5: null,
  short20: null,
  loan: null,
  loanUp20: null,
  fgnRatio: null,
  fgnRatioUp20: null,
};

/** YYYYMMDD 로 정규화 — 세 TR 이 날짜 칸 이름이 제각각이다 */
function ymd8(v: unknown): string {
  const t = String(v ?? "").replace(/[^0-9]/g, "");
  return /^\d{8}$/.test(t) ? t : "";
}

/**
 * 셋을 받아 **날짜 → 값**으로 되돌린다.
 *
 * ⚠️ 일봉 인덱스로 맞추지 않는다. 세 TR 은 거래일 집합이 서로 다르고(공매도가
 * 없는 날, 대차 기록이 없는 날) 일봉과도 어긋난다. 인덱스로 맞추면 **조용히
 * 하루씩 밀린다** — 수급에서 이미 겪은 문제다.
 *
 * 못 받은 TR 은 그 칸만 null 이다. 셋 다 실패해도 일봉 표본은 그대로 남는다.
 */
async function supplyIndex(
  client: KiwoomClient,
  code: string,
  days: number,
): Promise<Map<string, SupplySums>> {
  const end = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  /* 달력일로 넉넉히 — 거래일 400 이면 달력으로 580 쯤이다 */
  const startD = new Date(Date.now() + 9 * 3600_000 - Math.round(days * 1.5) * 86400_000);
  const start = startD.toISOString().slice(0, 10).replace(/-/g, "");
  const al = code.endsWith("_AL") ? code : `${code}_AL`;

  const [sh, ln, fr] = await Promise.all([
    /* 공매도 (ka10014) — 통합(_AL). KRX 단독은 매매비중 분모가 작아 비중이 부푼다 */
    client
      .request<Record<string, unknown>>(SHSA, "ka10014", {
        stk_cd: al,
        tm_tp: "1",
        strt_dt: start,
        end_dt: end,
      })
      .catch(() => null),
    client
      .request<Record<string, unknown>>(SLB, "ka20068", {
        strt_dt: start,
        end_dt: end,
        all_tp: "0",
        stk_cd: code,
      })
      .catch(() => null),
    client
      .request<Record<string, unknown>>(FRGNISTT, "ka10008", { stk_cd: code })
      .catch(() => null),
  ]);

  /** 오래된 것 → 새것 순으로 정렬해 둔다 — 「그날까지」를 세려면 그 방향이라야 한다 */
  const asc = (rows: Record<string, unknown>[], dateKey: string) =>
    rows
      .map((r) => ({ d: ymd8(r[dateKey]), r }))
      .filter((x) => x.d !== "")
      .sort((a, b) => a.d.localeCompare(b.d));

  const shRows = asc((sh?.data?.shrts_trnsn ?? []) as Record<string, unknown>[], "dt");
  const lnRows = asc((ln?.data?.dbrt_trde_trnsn ?? []) as Record<string, unknown>[], "dt");
  const frRows = asc((fr?.data?.stk_frgnr ?? []) as Record<string, unknown>[], "dt");

  const out = new Map<string, SupplySums>();
  const touch = (d: string): SupplySums => {
    let v = out.get(d);
    if (!v) {
      v = { ...NO_SUPPLY };
      out.set(d, v);
    }
    return v;
  };

  /* 공매도 — 그날까지 5일 평균과 그 이전 15일 평균 */
  for (let i = 0; i < shRows.length; i++) {
    const v = touch(shRows[i].d);
    const mean = (from: number, to: number): number | null => {
      if (from < 0) return null;
      let acc = 0;
      for (let j = from; j <= to; j++) acc += n(shRows[j].r.trde_wght);
      return acc / (to - from + 1);
    };
    v.short5 = mean(i - 4, i);
    v.short20 = mean(i - 19, i - 5);
  }

  /* 대차잔고 — 그날 값과 20일 전 대비 */
  for (let i = 0; i < lnRows.length; i++) {
    const v = touch(lnRows[i].d);
    const now = n(lnRows[i].r.rmnd);
    v.loan = now;
    if (i >= 20) {
      const before = n(lnRows[i - 20].r.rmnd);
      v.loanUp20 = before > 0 ? ((now - before) / before) * 100 : null;
    }
  }

  /* 외국인 지분율 — 그날 값과 20일 전 대비 %p */
  for (let i = 0; i < frRows.length; i++) {
    const v = touch(frRows[i].d);
    const now = n(frRows[i].r.wght);
    v.fgnRatio = now > 0 ? now : null;
    if (i >= 20) {
      const before = n(frRows[i - 20].r.wght);
      v.fgnRatioUp20 = now > 0 && before > 0 ? now - before : null;
    }
  }

  return out;
}

type FlowSums = Pick<
  Feat,
  | "fgn5"
  | "fgn10"
  | "fgn20"
  | "fgn60"
  | "inst5"
  | "inst10"
  | "inst20"
  | "inst60"
  | "smart5"
  | "smart20"
  | "smart60"
  | "fgnStreak"
>;

/**
 * 날짜 → 그날까지의 수급 요약.
 *
 * ⚠️ 일봉 인덱스를 그대로 쓰면 안 된다. 일봉과 수급은 **거래일이 어긋날 수 있어**
 * (한쪽에만 있는 날) 인덱스로 맞추면 조용히 하루씩 밀린다. 그래서 수급 배열 자체의
 * 순서로 합을 내고 **날짜를 열쇠로** 되돌려 준다.
 */
function flowIndex(rows: FlowDay[]): Map<string, FlowSums> {
  const m = new Map<string, FlowSums>();
  for (let i = 0; i < rows.length; i++) {
    /** 그날까지 k 거래일 합 — 그만큼의 과거가 없으면 null (0 으로 지어내지 않는다) */
    const sum = (k: number, pick: (r: FlowDay) => number): number | null => {
      if (i + 1 < k) return null;
      let acc = 0;
      for (let j = i; j > i - k; j--) acc += pick(rows[j]);
      return acc;
    };
    /* 그날부터 거꾸로 세는 연속 순매수 — 신호등(`flowStreak`)과 같은 규칙 */
    let streak = 0;
    for (let j = i; j >= 0; j--) {
      if (rows[j].fgn > 0) streak += 1;
      else break;
    }
    m.set(rows[i].date, {
      fgn5: sum(5, (r) => r.fgn),
      fgn10: sum(10, (r) => r.fgn),
      fgn20: sum(20, (r) => r.fgn),
      /* 60일 (2026-09-01) — 벤티지가 본다고 한 네 구간 중 마지막 */
      fgn60: sum(60, (r) => r.fgn),
      inst5: sum(5, (r) => r.inst),
      inst10: sum(10, (r) => r.inst),
      inst20: sum(20, (r) => r.inst),
      inst60: sum(60, (r) => r.inst),
      smart5: sum(5, (r) => r.smart),
      smart20: sum(20, (r) => r.smart),
      smart60: sum(60, (r) => r.smart),
      fgnStreak: streak,
    });
  }
  return m;
}

/** 수급을 못 받은 종목·날 — **없음**이지 0 이 아니다 */
const NO_FLOW: FlowSums = {
  fgn5: null,
  fgn10: null,
  fgn20: null,
  fgn60: null,
  inst5: null,
  inst10: null,
  inst20: null,
  inst60: null,
  smart5: null,
  smart20: null,
  smart60: null,
  fgnStreak: null,
};

/**
 * 그날의 **원시값**만 뽑는다 — 설정은 안 본다.
 *
 * 채점(`scoreFeat`)과 갈라 둔 이유는 시뮬레이터 때문이다. 비싼 것은 일봉이지
 * 채점이 아니라서, 원시값만 파일로 남겨 두면 설정을 바꿔도 다시 안 받아도 된다.
 *
 * ⚠️ 뒤쪽(미래) 봉을 실수로 쓰면 백테스트가 통째로 거짓이 되므로, 자를 때 항상
 * `slice(0, at + 1)` 로 끊는다.
 */
function featuresAt(
  all: Bar[],
  at: number,
  themeRate: number | null,
  rateBeta: number | null,
  /**
   * 상장주식수 — 그날 종가와 곱해 **그날의 시총**을 낸다.
   * `stockListCache` 가 하루 캐시로 들고 있어 조회가 안 는다. 모르면 null.
   */
  shares: number | null,
): Feat | null {
  const hist = all.slice(0, at + 1);
  if (hist.length < 65) return null; // 60일 지표를 내려면 그만큼은 있어야 한다
  const closes = hist.map((b) => b.close);
  const cur = closes[closes.length - 1];

  const win60 = closes.slice(-61, -1);
  const hi60 = win60.length > 0 ? Math.max(...win60) : 0;
  const m20 = sma(closes, 20);
  const m5 = sma(closes, 5);

  const win120 = hist.slice(-120);
  const hi = Math.max(...win120.map((b) => b.high));
  const lo = Math.min(...win120.map((b) => b.low));
  let over: number | null = null;
  if (hi > lo) {
    const above = win120.filter((b) => (b.high + b.low) / 2 > cur).reduce((s2, b) => s2 + b.vol, 0);
    const tot = win120.reduce((s2, b) => s2 + b.vol, 0);
    if (tot > 0) over = (above / tot) * 100;
  }

  return {
    cur,
    ma: MA_PERIODS.map((p) => sma(closes, p)),
    hiPct: hi60 > 0 ? (cur / hi60) * 100 : null,
    disp: m20 ? Math.max(0, ((cur - m20) / m20) * 100) : null,
    ma5Gap: m5 ? Math.max(0, ((cur - m5) / m5) * 100) : null,
    over,
    volEok: (hist[hist.length - 1].vol * cur) / 100_000_000,
    /* 상장주식수 × 그날 종가 ÷ 1억 = 억원 */
    mktCap: shares !== null && shares > 0 ? (shares * cur) / 100_000_000 : null,
    /* 아래 여섯은 별도 조회에서 온다 — 여기서는 자리만 만든다 (`NO_SUPPLY` 가 덮는다) */
    ...NO_SUPPLY,
    theme: themeRate,
    rateBeta,
    ...NO_FLOW,
  };
}

/**
 * 금리 민감도 — **직전 60거래일의 회귀계수.**
 *
 * 금리가 1%p 움직일 때 이 종목이 몇 % 움직였나. 두 시계열을 **날짜로 맞춰** 쓴다 —
 * 야후(미국 휴장)와 국내 일봉은 쉬는 날이 달라서, 인덱스로 맞추면 조용히 밀린다.
 *
 * 스무 쌍이 안 되면 `null` 이다 — 적은 표본의 회귀계수는 아무 값이나 나온다.
 */
function betaAt(
  bars: Bar[],
  at: number,
  /** 날짜(YYYYMMDD) → 그날 금리(%) */
  rate: Map<string, number>,
): number | null {
  if (rate.size === 0) return null;
  const xs: number[] = [];
  const ys: number[] = [];
  /* 그날까지 60거래일 — 뒤쪽(미래) 봉은 절대 안 본다 */
  for (let i = Math.max(1, at - 59); i <= at; i++) {
    const r1 = rate.get(bars[i].date);
    const r0 = rate.get(bars[i - 1].date);
    if (r1 === undefined || r0 === undefined) continue;
    const px0 = bars[i - 1].close;
    if (!(px0 > 0)) continue;
    xs.push(r1 - r0); // 금리 변화(%p)
    ys.push(((bars[i].close - px0) / px0) * 100); // 종목 수익률(%)
  }
  if (xs.length < 20) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let cov = 0;
  let varx = 0;
  for (let i = 0; i < xs.length; i++) {
    cov += (xs[i] - mx) * (ys[i] - my);
    varx += (xs[i] - mx) ** 2;
  }
  /* 금리가 거의 안 움직인 구간이면 기울기가 폭발한다 — 그럴 땐 안 낸다 */
  if (varx < 1e-6) return null;
  const b = cov / varx;
  return Number.isFinite(b) ? Math.round(b * 100) / 100 : null;
}

function summarize(rows: { d1: number | null; d5: number | null; d20: number | null }[]): Summary {
  const one = (key: "d1" | "d5" | "d20") => {
    const vs = rows.map((r) => r[key]).filter((v): v is number => v !== null);
    if (vs.length === 0) return { avg: null, win: null };
    return {
      avg: Math.round((vs.reduce((a, b) => a + b, 0) / vs.length) * 100) / 100,
      win: Math.round((vs.filter((v) => v > 0).length / vs.length) * 100),
    };
  };
  return { n: rows.length, d1: one("d1"), d5: one("d5"), d20: one("d20") };
}

let running = false;
let progress = { done: 0, total: 0 };
export const backtestProgress = () => ({ ...progress, running });

/**
 * 백그라운드 잡 (2026-08-28) — **요청이 결과를 기다리지 않는다.**
 *
 * 150종목 × 220ms 면 30초가 넘는데, 그동안 요청 하나가 붙잡혀 있었고
 * **페이지를 떠나면 결과를 통째로 잃었다** — 돌아와도 다시 돌려야 한다.
 * 신호등 찾기(signalScreen)와 같은 꼴로 바꾼다: 시작 → 즉시 응답 →
 * 진행 폴링 → 끝나면 결과 조회. 마지막 결과는 메모리에 남아, 탭을 떠났다
 * 돌아와도 그대로 있다 (서버 재시작이면 사라진다 — 백테스트는 다시 돌리면 된다).
 */
let lastResult: { result: BacktestResult; at: string; error?: never } | { result?: never; at: string; error: string } | null = null;

export function backtestResult() {
  return lastResult ?? { result: null, at: "" };
}

export function startBacktestJob(
  client: KiwoomClient,
  opts: {
    codes: { code: string; name: string }[];
    days?: number;
    config?: Partial<SignalConfig>;
    /** 수급까지 받을까 — 종목당 최대 6콜이 더 나간다. 기본 켬 */
    withFlow?: boolean;
  },
): { started: boolean } {
  if (running) return { started: false }; // 하나면 된다 — 겹치면 키움 한도가 터진다
  void runSignalBacktest(client, opts)
    .then((result) => {
      lastResult = { result, at: new Date().toISOString() };
    })
    .catch((err) => {
      lastResult = { error: err instanceof Error ? err.message : "실패했습니다", at: new Date().toISOString() };
    });
  return { started: true };
}

/**
 * 돌린다.
 *
 * 종목마다 일봉 한 번(600봉 안팎)이라 100종목이면 100콜, 초당 5건 제한으로 20초쯤이다.
 * 설정은 **저장하지 않는다** — 조절해 보는 자리라 지금 쓰는 기준을 건드리면 안 된다.
 */
export async function runSignalBacktest(
  client: KiwoomClient,
  opts: {
    codes: { code: string; name: string }[];
    days?: number;
    config?: Partial<SignalConfig>;
    /** 수급까지 받을까 — 종목당 최대 6콜이 더 나간다. 기본 켬 */
    withFlow?: boolean;
  },
): Promise<BacktestResult> {
  /*
   * ⚠️ **바탕은 DEFAULT_CONFIG 가 아니라 「지금 저장된 설정」이다** (2026-08-31).
   *
   * 원래 `?? DEFAULT_CONFIG.checks` 였는데, 그래서 **화면의 신호등과 다른 것을
   * 채점하고 있었다.** 벤티지가 켜 둔 「고점 근접」·「거래대금」이 코드 기본값에서는
   * 꺼져 있어, 백테스트만 그 둘 없이 돌았다. 「내 설정이 맞나」를 묻는 도구가
   * 내 설정을 안 보고 있었던 셈이다.
   *
   * 조합을 시험할 때는 호출자가 `config` 를 통째로 넘긴다 — 그때만 그 값이 이긴다.
   */
  const saved = await getConfig();
  const cfg: SignalConfig = {
    ...saved,
    ...opts.config,
    axisWeights: { ...saved.axisWeights, ...(opts.config?.axisWeights ?? {}) },
    checks: opts.config?.checks ?? saved.checks,
    maLines: opts.config?.maLines ?? saved.maLines,
  };
  const days = Math.min(Math.max(opts.days ?? 120, 20), 400);
  const withFlow = opts.withFlow !== false;

  /*
   * **금리 시계열** (2026-08-31) — 미 10년물(^TNX) 일봉을 **한 번만** 받는다.
   * 종목마다 부르면 500번인데, 금리는 종목과 무관한 값이라 한 번이면 된다.
   *
   * ⚠️ `2y` 를 쓴다. `5y` 는 **주봉**이라 국내 일봉과 날짜가 거의 안 맞아 표본이
   * 통째로 사라진다 — yahooChart 의 RANGES 주석에 그 실측이 적혀 있다.
   *
   * 야후의 `^TNX` 는 금리를 **그대로** 준다(4.653 이면 4.653%). closeBet 이
   * 2026-08-20 에 실측해 둔 것을 그대로 믿는다.
   *
   * 못 받으면 베타만 null 이다 — 표본 수집 전체를 막지 않는다.
   */
  const rateByDate = await yahooChart("^TNX", "2y")
    .then((r) => {
      const m = new Map<string, number>();
      for (const c of r.candles) {
        /* 야후는 `YYYY-MM-DD`, 국내 일봉은 `YYYYMMDD` — 열쇠를 국내 쪽에 맞춘다 */
        const d = String(c.t).slice(0, 10).replace(/-/g, "");
        if (/^\d{8}$/.test(d) && c.close > 0) m.set(d, c.close);
      }
      return m;
    })
    .catch(() => new Map<string, number>());

  running = true;
  progress = { done: 0, total: opts.codes.length };
  /* 테마 렌즈 — 일봉 캐시로 최근 60여 일을 되짚는다. 캐시가 없으면 그 기준만 빠진다 */
  const themeCtx = cfg.checks.some((c) => c.enabled && c.key === "naverTheme")
    ? await buildThemeCtx()
    : null;
  const rows: BacktestRow[] = [];
  const all: { d1: number | null; d5: number | null; d20: number | null }[] = [];
  /* 점수대별로 나누려면 **초록이 아닌 것까지** 점수를 들고 있어야 한다 */
  const scored: { score: number; d1: number | null; d5: number | null; d20: number | null }[] = [];
  /*
   * **원시값 창고** (2026-08-31) — 이번에 받은 일봉에서 뽑은 값을 그대로 남긴다.
   * 다음부터 설정을 바꿔 볼 때는 이 파일만 다시 채점하면 되므로 7분이 아니라
   * 수십 밀리초에 답이 나온다. 백테스트 한 번이 시뮬레이터의 재료를 만드는 셈이다.
   */
  const samples: Sample[] = [];

  /*
   * 상장주식수 (2026-09-01) — **조회가 안 는다.**
   *
   * `stockListCache` 가 하루 캐시로 전종목 상장주식수를 들고 있다(ka10099 두 번,
   * 이미 다른 데서 부른다). 그날 종가와 곱하면 **그날의 시가총액**이 나오므로,
   * 과거 시총을 주는 조회를 따로 부를 필요가 없었다 — 재료가 양쪽에 흩어져
   * 있었을 뿐이다.
   *
   * 이게 있어야 수급 문턱을 **절대 금액 → 시총 대비 비율**로 바꿔 볼 수 있다.
   * 지금 훑기 1위 조합의 꼭대기가 시장을 못 이기는 원인이 그 절대 금액이다.
   */
  const sharesMap = await getSharesMap(client).catch(() => new Map<string, number>());

  try {
    for (const { code, name } of opts.codes) {
      try {
        const bs = await bars(client, code);
        const sharesOf = sharesMap.get(code) ?? null;
        /*
         * 테마 렌즈의 날짜 맞춤 — 이 종목의 캐시 종가와 일봉을 맞대 「끝에서 k번째가
         * 어느 날인가」를 정한다. 못 맞추면 이 종목의 테마 판정은 전부 null 이다.
         */
        /*
         * 수급 (2026-08-31) — 종목당 최대 6콜이 더 나간다. 500 종목이면 조회가
         * 세 배로 늘어 몇 분이 더 걸리지만, 그 대가로 **채점 밖이던 기준 셋**
         * (외국인 수급·기관 수급·외인 연속)이 안으로 들어온다.
         * 못 받으면 그 종목의 수급만 null 이다 — 일봉 표본은 그대로 남는다.
         */
        const flowMap = withFlow
          ? await flowDays(client, code, days + 25)
              .then(flowIndex)
              .catch(() => null)
          : null;

        /*
         * 공매도 · 대차 · 외국인 지분율 (2026-09-01) — 종목당 3콜이 더 나간다.
         *
         * 그 대가로 **한 번도 검증하지 못하던 기준 셋**이 채점 안으로 들어온다.
         * 「공매도 비중이 높으면 위험」은 화면에도 계산에도 있었지만 표본에 없어서
         * 맞는지 잰 적이 없었다.
         *
         * `withFlow` 와 같은 스위치를 쓴다 — 수급을 안 받는 가벼운 회차에서는
         * 이것도 안 받는 게 맞다.
         */
        const supplyMap = withFlow
          ? await supplyIndex(client, code, days).catch(() => null)
          : null;

        const myThemes = themeCtx?.themesOf.get(code) ?? [];
        const dateToK =
          themeCtx && myThemes.length > 0
            ? alignDates((await loadCloses()).closes[code], bs)
            : null;
        const themeRateAt = (date: string): number | null => {
          if (!themeCtx || !dateToK || myThemes.length === 0) return null;
          const k = dateToK.get(date);
          if (k === undefined) return null;
          let best: number | null = null;
          for (const no of myThemes) {
            const arr = themeCtx.rate.get(no);
            const v = arr?.[k];
            if (v !== undefined && (best === null || v > best)) best = v;
          }
          return best;
        };
        // 마지막 봉은 오늘(미완성)일 수 있으나 종가 기준이라 그대로 쓴다
        const from = Math.max(65, bs.length - days);
        for (let i = from; i < bs.length; i++) {
          /*
           * ⚠️ **다음 날 시가에 산다** (2026-08-31).
           *
           * 예전엔 `bs[i].close` 를 매수가로 썼다. 그런데 점수도 **그 종가까지 보고**
           * 낸 것이라, 종가를 보고 판단해 그 종가에 사는 **불가능한 매매**였다.
           * 점수가 높은 날은 대개 그날 오른 날이므로 수익률이 그만큼 부풀려진다.
           *
           * 조건 백테스트(backtest.ts)는 처음부터 다음 날 시가로 샀다 — 같은 앱의
           * 두 백테스트가 서로 다른 규칙으로 재고 있었던 셈이라 비교도 안 됐다.
           *
           * 이제 **다음 날 시가에 사서 k 거래일 뒤 종가에 판다.** d1 은 다음 날
           * 시가에 사서 그날 종가에 파는 하루짜리다.
           */
          const fwd = (k: number): number | null => {
            const entryIdx = i + 1;
            const exitIdx = i + k;
            if (entryIdx >= bs.length || exitIdx >= bs.length || exitIdx < entryIdx) return null;
            const entry = bs[entryIdx].open;
            return entry > 0 ? ((bs[exitIdx].close - entry) / entry) * 100 : null;
          };
          const f = { d1: fwd(1), d5: fwd(5), d20: fwd(20) };
          all.push(f);

          const tr = themeRateAt(bs[i].date);
          const feat = featuresAt(bs, i, tr, betaAt(bs, i, rateByDate), sharesOf ?? null);
          if (!feat) continue;
          /*
           * 수급은 **날짜로 맞춘다.** 일봉 인덱스를 그대로 쓰면, 어느 한쪽에만
           * 있는 날(거래정지 등) 때문에 하루씩 밀린 채로 조용히 틀린다.
           * 못 맞춘 날은 null 이다 — 0 으로 지어내면 「순매수 0」과 안 갈린다.
           */
          const fl = flowMap?.get(bs[i].date);
          const sp = supplyMap?.get(bs[i].date);
          const full: Feat = { ...feat, ...(fl ?? NO_FLOW), ...(sp ?? NO_SUPPLY) };
          samples.push({ code, name, date: bs[i].date, ...full, ...f });

          /*
           * 채점은 시뮬레이터와 **같은 함수**를 쓴다 (2026-08-31).
           *
           * 예전엔 여기 따로 있었다(`scoreAt`). 그런데 둘이 갈라지면 화면의 두 숫자가
           * **다른 규칙으로 나오면서도 같은 이름**을 달게 된다 — 실제로 그 부류의
           * 버그를 겪었다(백테스트가 저장된 설정이 아니라 코드 기본값을 채점하던 건).
           * 채점 규칙은 한 군데에만 있어야 한다.
           */
          const s = scoreFeat(full, cfg);
          if (!s) continue;
          scored.push({ score: s.score, ...f });
          /*
           * **전부 담는다** — 화면에서 점수대를 눌러 그 구간의 종목을 보기 때문이다.
           * 초록만 담았을 때는 「60점대는 무엇이었나」에 답할 수가 없었다.
           * 아래에서 점수 높은 순으로 잘라 보내므로 응답이 무한정 커지지는 않는다.
           */
          rows.push({ date: bs[i].date, code, name, close: bs[i].close, ...s, ...f });
        }
      } catch {
        /* 이 종목만 건너뛴다 */
      }
      progress = { done: progress.done + 1, total: opts.codes.length };
      await new Promise((r) => setTimeout(r, 220));
    }
  } finally {
    running = false;
  }

  /*
   * 표본을 남긴다 — **중간에 끊겼어도 받은 만큼은 쓴다.** 500 종목 중 300에서
   * 서버가 재시작돼도 그 300은 유효한 표본이라, 버리면 그만큼 또 받아야 한다.
   */
  if (samples.length > 0) {
    try {
      await saveSamples({
        builtAt: new Date().toISOString(),
        days,
        codeCount: opts.codes.length,
        samples,
      });
    } catch {
      /* 못 써도 백테스트 결과 자체는 낸다 */
    }
  }

  /*
   * 「되짚었나」는 **목록이 아니라 실제 표본으로** 판단한다 (2026-08-31).
   *
   * `BACKTESTABLE` 만 보고 적으면, 수급을 안 받은 회차(`withFlow:false`)나
   * 수급 조회가 다 실패한 경우에도 「수급을 썼다」고 적게 된다. 그건 결과를
   * 잘못 믿게 만드는 거짓말이라, 뽑힌 표본이 실제로 값을 내는지로 정한다.
   */
  const reproducible = (c: CheckConfig): boolean => {
    if (!BACKTESTABLE.has(c.key)) return false;
    if (c.key === "naverTheme" && themeCtx === null) return false;
    for (let i = 0; i < samples.length && i < 4000; i++) {
      if (gradeOf(samples[i], c, cfg) !== null) return true;
    }
    return false;
  };
  const used = cfg.checks.filter((c) => c.enabled && reproducible(c)).map((c) => c.label);
  const skipped = cfg.checks.filter((c) => c.enabled && !reproducible(c)).map((c) => c.label);

  /*
   * 점수대 — 신호등의 경계(45·70)에 맞춰 나눈다. 그래야 「노랑 안에서도 위쪽이
   * 나은가」·「초록 안에서 90점이 70점보다 나은가」를 각각 볼 수 있다.
   */
  const CUTS: { label: string; from: number; to: number }[] = [
    { label: "90~100 (초록)", from: 90, to: 101 },
    { label: "80~89 (초록)", from: 80, to: 90 },
    { label: "70~79 (초록)", from: 70, to: 80 },
    { label: "60~69 (노랑)", from: 60, to: 70 },
    { label: "45~59 (노랑)", from: 45, to: 60 },
    { label: "0~44 (빨강)", from: 0, to: 45 },
  ];
  const buckets = CUTS.map((c) => ({
    ...c,
    s: summarize(scored.filter((x) => x.score >= c.from && x.score < c.to)),
  }));

  return {
    used,
    skipped,
    days,
    codes: opts.codes.length,
    /*
     * 점수대마다 **골고루** 남긴다. 날짜순으로 300개를 자르면 최근 며칠이 다 먹어
     * 「60점대 목록」이 통째로 비는 일이 생긴다.
     */
    rows: CUTS.flatMap((c) =>
      rows
        .filter((r) => r.score >= c.from && r.score < c.to)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 60),
    ),
    green: summarize(rows.filter((r) => r.level === "green")),
    base: summarize(all),
    buckets,
    note:
      "일봉으로 되살릴 수 있는 기준을 씁니다. 테마 강세는 일봉 캐시로 **최근 60여 일만** 재현되며 " +
      "구성은 오늘 것을 씁니다(그 밖의 날은 판단 불가로 빠짐). ETF·수급·재무는 그때의 구성을 모르므로 뺐습니다. " +
      "「전체」는 같은 기간 모든 날·모든 종목의 평균입니다. 초록이 이걸 못 이기면 그 기준은 쓸모가 없습니다.",
  };
}
