import type { KiwoomClient } from "./kiwoomClient.js";
import { fetchAll, type EtfListRow } from "./routes/etf.js";
import { dropPhantomToday } from "./candleGuard.js";
import { themeStrength } from "./themeStrength.js";
import { leaderScan } from "./leaderScan.js";
import { groupOf, type EtfGroup } from "./cisPension.js";
import { isSafeAsset } from "./cisAccounts.js";

/**
 * ETF 분석 — **테마를 축으로 본다.**
 *
 * ## 왜 주도주 연관률이 아닌가 (2026-08-31)
 *
 * 벤티지: "ETF는 어떻게 판단하지? 주도주 연관률 이런걸로 봐야 하냐?" 그리고
 * "etf는 테마랑 봐야되지 않나 싶은데."
 *
 * 뒤쪽이 맞다. 개별 주도주 신호는 ETF 안에서 **희석된다** — 반도체 주도주가
 * 아무리 강해도 KODEX 200 안에서 그 비중은 얼마 안 되고, 신호가 그만큼 묽어진다.
 *
 * 반면 **테마·섹터 강세는 ETF 와 단위가 같다.** 「반도체 소부장이 3일 연속
 * 강세」면 그것을 담은 ETF 는 그 강세를 그대로 받는다. 우리는 이미 테마 강세를
 * 계산하고 있으므로(themeStrength·leaderScan.sectors) 그것을 ETF 에 이어 주면 된다.
 *
 * ## 네 축
 *
 *   ① **테마 연계** — 지금 돈이 몰리는 판을 담은 ETF 인가
 *   ② **상대강도** — 코스피 대비 초과수익. 「오르는 것」이 아니라 「남보다 오르는 것」
 *   ③ **추세** — 이평 배열. 오래 들고 갈 자리라 방향이 중요하다
 *   ④ **품질** — 괴리율·추적오차·거래대금. NAV 보다 비싸게 사면 시작부터 손해다
 *
 * ## 조회를 아끼는 법
 *
 * ETF 가 900종이 넘는데 전부 일봉을 부르면 호출 한도에 걸린다. ①④(거래대금·
 * 괴리율·테마 매칭)는 **전체 시세 한 번**으로 다 되므로 그것으로 먼저 좁히고,
 * 무거운 ②③(일봉)은 **좁혀진 것에만** 부른다.
 */

type Row = Record<string, unknown>;
const CHART = "/api/dostk/chart";

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,%\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function yyyymmdd(): string {
  const d = new Date(Date.now() + 9 * 3600_000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
}

/* ------------------------------------------------------------------ 테마 잇기 */

/**
 * ETF 이름과 테마 이름을 잇는다.
 *
 * ⚠️ **이름으로 잇는다.** ETF 의 구성종목을 받아 테마와 대조하는 것이 정확하지만,
 * 키움 ETF 묶음(ka40001~40010)에는 **구성종목이 없다**(`etfInfo.ts` 에서 확인).
 * 없는 데이터를 지어내지 않는다는 원칙대로, 이름 매칭을 쓰고 그 사실을 적어 둔다.
 *
 * 국내 ETF 이름은 대체로 담는 것이 이름에 있다 — 「KODEX 반도체」,
 * 「TIGER 2차전지테마」, 「KODEX K-방산」. 운용사 접두(KODEX·TIGER·PLUS…)와
 * 흔한 꼬리(액티브·레버리지…)를 떼고 남는 말로 잇는다.
 */
const BRANDS = /^(KODEX|TIGER|PLUS|ACE|SOL|RISE|KOSEF|ARIRANG|HANARO|KBSTAR|TIMEFOLIO|WOORI|BNK|마이다스|파워|히어로즈|삼성|미래에셋|한국투자|신한|키움|우리)\s*/i;
const TAILS = /(액티브|레버리지|인버스|선물|합성|H|TR|\(합성\)|\(H\)|ETN|증권상장지수투자신탁|상장지수)/gi;

export function etfKeywords(name: string): string[] {
  const bare = name.replace(BRANDS, "").replace(TAILS, " ");
  /* 2글자 이상 한글 덩어리와 영문 낱말만 — 「200」 같은 숫자는 테마 이름이 아니다 */
  const words = bare.match(/[가-힣]{2,}|[A-Za-z]{3,}/g) ?? [];
  return [...new Set(words.map((w) => w.trim()).filter(Boolean))];
}

/**
 * 두 이름이 같은 판을 가리키나.
 *
 * ⚠️ **포함 관계로는 거의 안 걸린다.** 한글 합성어라서 그렇다 —
 * 「전력핵심설비」와 「AI 전력인프라」는 서로를 품지 않지만 같은 판이다.
 * 실측에서 상위 후보 중 테마가 이어진 것이 하나도 없었다.
 *
 * 그래서 **가장 긴 공통 부분문자열**로 잇는다. 두 글자면 이어진 것으로 보되,
 * 무엇으로 이어졌는지(`via`)를 화면에 그대로 띄운다 — 「전력」으로 이어졌다는
 * 사실이 보이면 잘못 이어진 것을 사람이 바로 안다. 감추면 못 고친다.
 */
function longestCommon(a: string, b: string): string {
  let best = "";
  for (let i = 0; i < a.length; i += 1) {
    for (let j = i + 2; j <= a.length; j += 1) {
      const sub = a.slice(i, j);
      if (sub.length <= best.length) continue;
      if (b.includes(sub)) best = sub;
    }
  }
  return best;
}

/**
 * 두 글자로 이어질 때 **믿으면 안 되는 말들.**
 *
 * 실측(2026-08-31)에서 「TIGER 코리아AI전력기기TOP3」가 **[기기]** 로
 * 「의료/정밀기기」와 이어졌다. 명백히 다른 판인데 흔한 꼬리말이 같아서다.
 * 세 글자 이상이면 대체로 그 판을 가리키지만, 두 글자는 이런 말이 태반이다.
 *
 * 「전력」·「방산」처럼 두 글자여도 판을 가리키는 말이 있으므로 길이로만
 * 자르지 않고, **흔한 것만 걸러낸다.**
 */
const WEAK2 = new Set([
  "기기", "장비", "전자", "기계", "산업", "소재", "부품", "설비", "제조", "시스",
  "금융", "화학", "코리", "미국", "한국", "국내", "해외", "지수", "그룹", "종합",
  "우량", "성장", "가치", "배당", "채권", "금리", "혼합", "선물", "핵심", "관련",
  "테마", "대표", "리츠", "고배", "플러", "액티", "토탈", "글로",
]);

function linked(etfWords: string[], themeName: string): { via: string; len: number } | null {
  const t = themeName.replace(/[\s()]/g, "");
  let best: { via: string; len: number } | null = null;
  for (const w of etfWords) {
    if (w.length < 2) continue;
    const c = longestCommon(w, t);
    /* 두 글자는 흔한 꼬리말이 아닐 때만 믿는다 — 「전력」은 되고 「기기」는 안 된다 */
    if (c.length < 2) continue;
    if (c.length === 2 && WEAK2.has(c)) continue;
    if (!best || c.length > best.len) best = { via: c, len: c.length };
  }
  return best;
}

/* ------------------------------------------------------------------ 결과 */

export interface EtfScore {
  code: string;
  name: string;
  price: number;
  changeRate: number;
  tradeValue: number;
  group: EtfGroup;
  safe: boolean;
  deviation: number | null;
  traceErr: number | null;

  /** ① 테마 — 이어진 테마·섹터와 그 강도 */
  theme: { name: string; rate: number; streak: number; via: string } | null;
  themeScore: number;
  /** ② 상대강도 — 코스피 대비 초과수익(%p). 못 쟀으면 null */
  rs20: number | null;
  rs60: number | null;
  rsScore: number;
  /** ③ 추세 — 이평 배열 */
  trend: { ma20: number; ma60: number; ma120: number | null; aligned: boolean; above20: boolean } | null;
  trendScore: number;
  /** ④ 품질 */
  qualityScore: number;

  /** 합 — 네 축의 가중합 */
  score: number;
  /** 왜 이 점수인가 — 사람이 읽을 한 줄 */
  why: string;
  /** 담을 수 없는 이유(연금 계좌 기준) */
  blocked?: string;
}

const sma = (xs: number[], n: number): number | null =>
  xs.length >= n ? xs.slice(0, n).reduce((a, b) => a + b, 0) / n : null;

/** 일봉 종가 (최근 것이 앞) */
async function closesOf(client: KiwoomClient, code: string): Promise<number[]> {
  try {
    const { data } = await client.request<{ stk_dt_pole_chart_qry?: Row[] }>(CHART, "ka10081", {
      stk_cd: code,
      base_dt: yyyymmdd(),
      upd_stkpc_tp: "1",
    });
    const rows = dropPhantomToday(
      Array.isArray(data.stk_dt_pole_chart_qry) ? (data.stk_dt_pole_chart_qry as Row[]) : [],
    );
    return rows.map((r) => Math.abs(toNum(r.cur_prc))).filter((n) => n > 0);
  } catch {
    return [];
  }
}

/** 기간 수익률(%) — 앞이 최근이므로 [0] 대 [n] */
const ret = (xs: number[], n: number): number | null =>
  xs.length > n && xs[n] > 0 ? ((xs[0] - xs[n]) / xs[n]) * 100 : null;

export interface EtfAnalysis {
  at: string;
  /** 지금 강한 판들 — ETF 를 여기에 잇는다. 화면이 「무엇에 이었나」를 보여 준다 */
  boards: { name: string; rate: number; streak: number }[];
  rows: EtfScore[];
  /** 안전자산은 **따로** — 순위에 끼면 「지금 뭐가 강한가」의 답이 망가진다 */
  safe: EtfScore[];
  /** 견준 지수 — 상대강도의 기준 */
  benchmark: { name: string; r20: number | null; r60: number | null } | null;
  scanned: number;
  detailed: number;
  note: string;
}

/**
 * 분석한다.
 *
 * @param detail 일봉까지 받아 상대강도·추세를 잴 종목 수. 크면 정확하고 느리다.
 */
export async function analyzeEtfs(
  client: KiwoomClient,
  opts: { detail?: number; minTradeValue?: number } = {},
): Promise<EtfAnalysis> {
  const detail = Math.min(Math.max(opts.detail ?? 40, 5), 80);
  const minTv = opts.minTradeValue ?? 20;

  const all: EtfListRow[] = await fetchAll(client);

  /* ── 테마·섹터 강세를 한 번만 받아 둔다 ── */
  /* 국내 테마만 본다 — 국내 ETF 이름과 이어야 하므로 미국 테마는 뜻이 없다 */
  const themeRes = await themeStrength("kr").catch(() => null);
  const themes = themeRes?.themes ?? [];
  const scan = await leaderScan(client).catch(() => null);
  const boards: { name: string; rate: number; streak: number }[] = [
    ...themes.map((t) => ({ name: t.name, rate: t.changeRate, streak: t.streak ?? 0 })),
    ...(scan?.sectors ?? []).map((s) => ({
      name: s.name,
      rate: s.weightedRate,
      streak: s.streak ?? 0,
    })),
  ];

  /* ── ①④ 로 먼저 좁힌다 (전체 시세 한 번이면 된다) ── */
  const pre: EtfScore[] = [];
  for (const e of all) {
    if (e.tradeValue < minTv) continue;
    const words = etfKeywords(e.name);

    /* 가장 강한 판을 고른다 — 여러 개에 걸리면 제일 센 것이 그 ETF 의 성격이다 */
    let theme: EtfScore["theme"] = null;
    let bestLen = 0;
    for (const b of boards) {
      const hit = linked(words, b.name);
      if (!hit) continue;
      /*
       * **더 길게 이어진 쪽**이 먼저다. 같은 길이면 더 센 판을 고른다 —
       * 「전력」으로 이어진 것보다 「이차전지」로 이어진 것이 확실한 연결이다.
       */
      if (hit.len > bestLen || (hit.len === bestLen && theme && b.rate > theme.rate)) {
        bestLen = hit.len;
        theme = { name: b.name, rate: b.rate, streak: b.streak, via: hit.via };
      }
    }

    /*
     * 테마 점수 — 강도와 **연속성**을 같이 본다. 하루짜리 테마는 다음 날 되돌리므로
     * 연속으로 강한 판에 가중을 준다(개별종목 후보 선정과 같은 원칙).
     */
    const themeScore = theme
      ? Math.max(0, Math.min(40, theme.rate * 4 + Math.min(theme.streak, 5) * 4))
      : 0;

    /*
     * 품질 — 괴리율과 추적오차. **값이 없으면 깎지 않는다**(못 잰 것이지 나쁜 게
     * 아니다). 거래대금은 로그로 — 1,000억과 2,000억의 차이는 50억과 100억의
     * 차이만큼 크지 않다.
     */
    let qualityScore = 10;
    if (e.deviation !== null) qualityScore -= Math.min(10, Math.abs(e.deviation) * 4);
    if (e.traceErr !== null) qualityScore -= Math.min(6, e.traceErr * 2);
    qualityScore += Math.min(10, Math.log10(Math.max(1, e.tradeValue)) * 3);

    pre.push({
      code: e.code,
      name: e.name,
      price: e.price,
      changeRate: e.changeRate,
      tradeValue: e.tradeValue,
      group: groupOf(e.name),
      safe: isSafeAsset(e.name),
      deviation: e.deviation,
      traceErr: e.traceErr,
      theme,
      themeScore,
      rs20: null,
      rs60: null,
      rsScore: 0,
      trend: null,
      trendScore: 0,
      qualityScore: Number(qualityScore.toFixed(1)),
      score: 0,
      why: "",
    });
  }

  /*
   * ⚠️ **안전자산은 순위에서 뺀다** (2026-08-31 실측에서 드러남).
   *
   * 하락장에서 CD금리·머니마켓 ETF 는 지수 대비 늘 이긴다 — 지수가 빠지는데
   * 얘들은 조금씩 오르니까. 그래서 상대강도 순위 맨 위를 현금성 ETF 가 차지했다.
   * 그건 「강한 ETF」가 아니라 **현금**이다. 담을 이유는 있지만(퇴직연금 30% 몫)
   * 「지금 뭐가 강한가」를 묻는 자리에 끼면 그 물음의 답이 망가진다.
   *
   * 빼는 게 아니라 **갈라서** 돌려준다 — IRP 는 안전자산도 골라야 하니까.
   */
  const risky = pre.filter((r) => !r.safe);
  const safeRows = pre.filter((r) => r.safe).sort((a, b) => b.qualityScore - a.qualityScore).slice(0, 8);

  /* 좁히는 기준은 **테마+품질** — 여기까지가 조회 없이 되는 판단이다 */
  risky.sort((a, b) => b.themeScore + b.qualityScore - (a.themeScore + a.qualityScore));
  const targets = risky.slice(0, detail);

  /* ── 견줄 지수 (KODEX 200) — 상대강도의 기준 ── */
  let benchmark: EtfAnalysis["benchmark"] = null;
  const bench = all.find((e) => /KODEX\s*200$/i.test(e.name.trim())) ?? all.find((e) => /200/.test(e.name));
  if (bench) {
    const c = await closesOf(client, bench.code);
    benchmark = { name: bench.name, r20: ret(c, 20), r60: ret(c, 60) };
  }

  /* ── ②③ 일봉 — 좁혀진 것에만 ── */
  for (const r of targets) {
    const c = await closesOf(client, r.code);
    if (c.length < 25) continue;

    const r20 = ret(c, 20);
    const r60 = ret(c, 60);
    /*
     * 상대강도 = 내 수익률 − 지수 수익률. **지수를 못 재면 상대강도도 없다** —
     * 절대수익률을 상대강도라고 적으면 상승장에서 전부 강해 보인다.
     */
    r.rs20 = r20 !== null && benchmark?.r20 != null ? Number((r20 - benchmark.r20).toFixed(2)) : null;
    r.rs60 = r60 !== null && benchmark?.r60 != null ? Number((r60 - benchmark.r60).toFixed(2)) : null;
    r.rsScore = Math.max(
      -10,
      Math.min(30, (r.rs20 ?? 0) * 1.2 + (r.rs60 ?? 0) * 0.6),
    );

    const ma20 = sma(c, 20);
    const ma60 = sma(c, 60);
    const ma120 = sma(c, 120);
    if (ma20 !== null && ma60 !== null) {
      const aligned = ma20 > ma60 && (ma120 === null || ma60 > ma120);
      const above20 = c[0] > ma20;
      r.trend = {
        ma20: Math.round(ma20),
        ma60: Math.round(ma60),
        ma120: ma120 === null ? null : Math.round(ma120),
        aligned,
        above20,
      };
      /* 정배열 + 20일선 위 = 추세가 살아 있다. 둘 다 아니면 방향이 없다 */
      r.trendScore = (aligned ? 12 : 0) + (above20 ? 8 : 0);
    }
  }

  /* ── 합산 ── */
  for (const r of targets) {
    r.score = Number((r.themeScore + r.rsScore + r.trendScore + r.qualityScore).toFixed(1));
    const bits: string[] = [];
    if (r.theme) {
      bits.push(
        `${r.theme.name} ${r.theme.rate > 0 ? "+" : ""}${r.theme.rate.toFixed(1)}%` +
          (r.theme.streak >= 2 ? ` ${r.theme.streak}일 연속` : ""),
      );
    }
    if (r.rs20 !== null) bits.push(`지수 대비 20일 ${r.rs20 > 0 ? "+" : ""}${r.rs20}%p`);
    if (r.trend?.aligned) bits.push("정배열");
    else if (r.trend && !r.trend.above20) bits.push("20일선 아래");
    if (r.deviation !== null && Math.abs(r.deviation) > 1) bits.push(`괴리 ${r.deviation.toFixed(2)}%`);
    r.why = bits.join(" · ") || "특별한 신호 없음";
  }

  targets.sort((a, b) => b.score - a.score);

  return {
    at: new Date().toISOString(),
    boards: [...boards].sort((a, b) => b.rate - a.rate).slice(0, 20),
    rows: targets,
    safe: safeRows,
    benchmark,
    scanned: all.length,
    detailed: targets.length,
    note:
      `ETF ${all.length}종 중 거래대금 ${minTv}억 이상 ${pre.length}종을 훑고, ` +
      `테마·품질로 좁힌 ${targets.length}종에만 일봉을 받아 상대강도·추세를 쟀습니다. ` +
      `안전자산(채권·금리형)은 순위에서 빼 따로 뒀습니다 — 하락장에서 늘 지수를 이겨 ` +
      `「지금 뭐가 강한가」의 답을 망칩니다. ` +
      `테마 연결은 **이름으로** 합니다(키움 ETF 조회에 구성종목이 없습니다) — ` +
      `무엇으로 이어졌는지 표에 그대로 띄우니 잘못 이어진 것은 바로 보입니다.`,
  };
}
