import { loadCloses } from "./dailyCloses.js";
import { loadSamples, scoreFeat, type Sample } from "./signalSamples.js";
import { getConfig } from "./signalLight.js";
import { topicPulse } from "./topicPulse.js";
import type { KiwoomClient } from "./kiwoomClient.js";
import { regimeMap } from "./signalSimulate.js";

/**
 * **데일리 리포트에 붙는 종목 목록** (2026-10-21).
 *
 * 벤티지: "지금 일련의 구현한 것들이 실제 도움이 되려면 내가 가장 중요시 여기는 게
 * 되어야 할 거 같아. 데일리 브리핑 아침 조간 석간에 이거 넣자 — 외국인 수급 순매수
 * (5·10·20일) / 기관 수급 / 쌍끌이 / 정배열 전환 / 52주 신고가 / 눌림목."
 *
 * ## 조회가 0 이다
 *
 * 재료가 **이미 다 있다.** 신호등 표본(`signalSamples`)이 종목마다 그날의 이동평균
 * 다섯·수급 5/10/20/60일·낙폭·시총을 들고 있고, 일봉 창고(`dailyCloses`)에 2년치
 * 봉이 있다. 둘을 맞대면 된다 — **키움을 한 번도 안 부른다.**
 *
 * ## ⚠️ 목록만 내면 거짓말이 된다
 *
 * 2026-09-11 재검증(29,570관측·87거래일, 시총 중립 초과수익)에서 나온 것들이다:
 *
 *   · **쌍끌이는 단독 신호로 못 쓴다.** 빨강 안에서 −0.1, 시총 상위 5분위 −2.0/44.
 *     20일 신호이고(5일은 −0.2) 약세장·소형주에서만 값이 있다. 그래서 「외국인 세 칸」
 *     (+3.2/59, 하루 17.3개)이 본체이고 쌍끌이는 그중 더 좁은 갈래다.
 *   · **눌림목은 방향이 거꾸로였다.** 신호등에서 끄면 초록이 +1.8 → +2.5 로 올랐다.
 *
 * 그래서 각 묶음에 **그 실측을 한 줄로 달아 내보낸다**(`note`). 숫자를 보여 주면서
 * 그 숫자가 어떤 성적이었는지를 같이 말하지 않으면, 목록이 추천으로 읽힌다.
 */

export interface Pick {
  code: string;
  name: string;
  /** 한 줄 근거 — 화면에 그대로 */
  why: string;
}

export interface PickGroup {
  key: string;
  label: string;
  picks: Pick[];
  /** 이 묶음을 어떻게 읽어야 하나 — 실측이 있으면 그 말 */
  note: string;
}

export interface ReportPicks {
  /** 어느 날 원장으로 뽑았나 (YYYYMMDD) */
  date: string;
  /**
   * 그 원장이 **며칠 묵었나**. 0 이면 오늘, 1 이면 어제.
   *
   * ⚠️ 리포트에 **반드시 같이 보인다.** 표본은 마감 뒤 정리에서 다시 만들어지는데,
   * 그게 하루 걸러지면 목록이 조용히 옛날 것이 된다 — 숫자는 멀쩡해 보이고 날짜만
   * 틀린 꼴이라 제일 위험하다. 실제로 로컬 표본이 한 달 묵어 있던 것을 보고 넣었다.
   */
  ageDays: number;
  groups: PickGroup[];
}

/** 원장이 이보다 묵었으면 목록을 안 낸다 — 옛 종목을 오늘 것처럼 보여 주느니 비운다 */
const MAX_AGE_DAYS = 4;

const TOP = 8;
/** 너무 작은 종목은 뺀다 — 목록에 올라도 들어갈 자리가 아니다 */
const MIN_CAP_EOK = 1000;
/** 그날 거래대금이 이만큼(억)은 돼야 */
const MIN_VOL_EOK = 30;

const eok = (v: number) => `${Math.round(v).toLocaleString("ko-KR")}억`;
const sign = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v).toLocaleString("ko-KR")}`;

/** 수급 칸은 **백만원** 단위로 쌓여 있다 — 억으로 고쳐 읽는다 */
const toEok = (v: number) => v / 100;

function tradable(s: Sample): boolean {
  return (s.mktCap ?? 0) >= MIN_CAP_EOK && (s.volEok ?? 0) >= MIN_VOL_EOK;
}

/** 정배열 — 5 > 20 > 60 (MA_PERIODS 는 [5,10,20,60,120]) */
function aligned(s: Sample): boolean {
  const [m5, , m20, m60] = s.ma;
  return m5 != null && m20 != null && m60 != null && m5 > m20 && m20 > m60;
}

export async function buildReportPicks(client?: KiwoomClient): Promise<ReportPicks | null> {
  const file = await loadSamples();
  if (!file || file.samples.length === 0) return null;

  /* 가장 최근 날짜 줄만 — 그 전날은 「전환」을 가리는 데 쓴다 */
  const days = [...new Set(file.samples.map((s) => s.date))].sort();
  const today = days[days.length - 1];
  const prevDay = days[days.length - 2] ?? "";
  if (!today) return null;

  const cur = file.samples.filter((s) => s.date === today && tradable(s));
  const prev = new Map(file.samples.filter((s) => s.date === prevDay).map((s) => [s.code, s]));

  /* 며칠 묵었나 — 달력 날짜로 센다(주말이 끼면 2~3일이 정상이다) */
  const asDate = new Date(
    Number(today.slice(0, 4)),
    Number(today.slice(4, 6)) - 1,
    Number(today.slice(6, 8)),
  );
  const ageDays = Math.max(0, Math.round((Date.now() - asDate.getTime()) / 86400_000));
  if (ageDays > MAX_AGE_DAYS) {
    console.warn(`[reportPicks] 원장이 ${ageDays}일 묵었다(${today}) — 목록을 안 낸다`);
    return { date: today, ageDays, groups: [] };
  }

  const groups: PickGroup[] = [];
  const add = (key: string, label: string, picks: Pick[], note: string) => {
    if (picks.length > 0) groups.push({ key, label, picks, note });
  };

  /* ── 외국인·기관 순매수 (5·10·20일) ───────────────────────── */
  const flowTop = (
    pick: (s: Sample) => number | null | undefined,
    label: string,
    note: string,
    key: string,
  ) => {
    const rows = cur
      .map((s) => ({ s, v: pick(s) }))
      .filter((x): x is { s: Sample; v: number } => Number.isFinite(x.v as number) && (x.v as number) > 0)
      .sort((a, b) => b.v - a.v)
      .slice(0, TOP);
    add(
      key,
      label,
      rows.map(({ s, v }) => ({
        code: s.code,
        name: s.name,
        why: `${eok(toEok(v))} · 시총 ${eok(s.mktCap ?? 0)}`,
      })),
      note,
    );
  };

  const FGN_NOTE =
    "외국인 5·10·20일이 모두 순매수인 「외국인 세 칸」이 재검증에서 가장 넓고 좋았다 (20일 +3.2%p · 승률 59 · 하루 17.3개).";
  flowTop((s) => s.fgn5, "외국인 순매수 5일", FGN_NOTE, "fgn5");
  flowTop((s) => s.fgn10, "외국인 순매수 10일", FGN_NOTE, "fgn10");
  flowTop((s) => s.fgn20, "외국인 순매수 20일", FGN_NOTE, "fgn20");

  const INST_NOTE =
    "기관 단독은 힘이 약하다 — 인덱스·헤지 물량이 섞인다. 외국인과 같이 볼 때만 뜻이 있다(아래 쌍끌이).";
  flowTop((s) => s.inst5, "기관 순매수 5일", INST_NOTE, "inst5");
  flowTop((s) => s.inst10, "기관 순매수 10일", INST_NOTE, "inst10");
  flowTop((s) => s.inst20, "기관 순매수 20일", INST_NOTE, "inst20");

  /* ── 쌍끌이 — 외인·기관이 5·10·20일 **모두** 순매수 ─────────── */
  const twin = cur
    .filter(
      (s) =>
        (s.fgn5 ?? 0) > 0 && (s.fgn10 ?? 0) > 0 && (s.fgn20 ?? 0) > 0 &&
        (s.inst5 ?? 0) > 0 && (s.inst10 ?? 0) > 0 && (s.inst20 ?? 0) > 0,
    )
    .sort((a, b) => (b.fgn20 ?? 0) + (b.inst20 ?? 0) - ((a.fgn20 ?? 0) + (a.inst20 ?? 0)))
    .slice(0, TOP);
  add(
    "twin",
    "쌍끌이 (외인·기관 5·10·20 모두 순매수)",
    twin.map((s) => ({
      code: s.code,
      name: s.name,
      why: `외인 ${sign(toEok(s.fgn20 ?? 0))}억 · 기관 ${sign(toEok(s.inst20 ?? 0))}억 (20일)`,
    })),
    "⚠️ 단독 신호로는 못 쓴다 — 재검증에서 빨강 안 −0.1, 시총 상위 5분위 −2.0. 20일 신호라 5일로 보면 −0.2 다. 약세장·소형주에서만 값이 있었다.",
  );

  /* ── 정배열 전환 — 오늘 5>20>60 인데 어제는 아니었다 ────────── */
  const maTurn = cur
    .filter((s) => aligned(s) && prev.has(s.code) && !aligned(prev.get(s.code)!))
    .sort((a, b) => (b.volEok ?? 0) - (a.volEok ?? 0))
    .slice(0, TOP);
  add(
    "maTurn",
    "정배열 전환 (오늘 5>20>60)",
    maTurn.map((s) => ({
      code: s.code,
      name: s.name,
      why: `거래대금 ${eok(s.volEok ?? 0)} · 20일선 이격 ${(s.gap20 ?? 0).toFixed(1)}%`,
    })),
    "어제까지 아니었다가 오늘 처음 선 것만. 추세의 시작 자리이지 그 자체가 매수 신호는 아니다 (신조 ②추세).",
  );

  /* ── 52주 신고가 — 일봉 250봉 최고 ──────────────────────── */
  const store = await loadCloses().catch(() => null);
  const high52: { p: Pick; vol: number }[] = [];
  if (store?.bars) {
    for (const s of cur) {
      const bars = store.bars[s.code];
      if (!bars || bars.length < 60) continue;
      const win = bars.slice(-250);
      const last = win[win.length - 1];
      if (!last || !(last.c > 0)) continue;
      /* 오늘 종가가 창 안에서 가장 높다 — 직전 최고와 같아도 신고가로 본다 */
      const prevMax = Math.max(...win.slice(0, -1).map((b) => b.c));
      if (last.c >= prevMax && prevMax > 0) {
        high52.push({
          p: {
            code: s.code,
            name: s.name,
            why: `${win.length}봉 최고 · 거래대금 ${eok(s.volEok ?? 0)}`,
          },
          vol: s.volEok ?? 0,
        });
      }
    }
  }
  /* 거래대금 큰 것부터 — 신고가는 많이 나오므로 들어갈 자리가 있는 것 먼저 */
  high52.sort((a, b) => b.vol - a.vol);
  add(
    "high52",
    "52주 신고가",
    high52.slice(0, TOP).map((x) => x.p),
    "250봉(약 1년) 안에서 종가가 가장 높은 종목. 봉이 모자란 신규 상장은 빠진다.",
  );

  /* ── 눌림목 — 올랐다가 20일 고점에서 물러난 자리 ───────────── */
  const pullback = cur
    .filter((s) => (s.rise20 ?? 0) >= 8 && (s.dd20 ?? 0) <= -5 && (s.dd20 ?? 0) >= -15 && aligned(s))
    .sort((a, b) => (b.volEok ?? 0) - (a.volEok ?? 0))
    .slice(0, TOP);
  add(
    "pullback",
    "눌림목 (20일 +8%↑ 뒤 고점 대비 −5~−15%, 정배열)",
    pullback.map((s) => ({
      code: s.code,
      name: s.name,
      why: `20일 ${(s.rise20 ?? 0).toFixed(0)}% 오른 뒤 고점 대비 ${(s.dd20 ?? 0).toFixed(1)}%`,
    })),
    "⚠️ 재검증에서 **방향이 거꾸로였다** — 신호등에서 이 기준을 끄면 초록 성적이 +1.8 → +2.5 로 올랐다. 참고로만 본다.",
  );

  /* ── 기술적 특징주 — 일봉만으로 (2026-10-21) ─────────────────
   *
   * 벤티지가 인포스탁 조간을 주며 "우리꺼에 충분히 녹여봐봐 … 장중 특이사항들에
   * 대해서도 잘 나오더라고". 그쪽 「기술적 분석 특징주」가 이런 묶음이었다 —
   * 고점돌파(3개월/1년) · 첫·연속 상한가 · 거래 급증 · 골든크로스 · MACD · 일목 ·
   * Stochastic.
   *
   * ⚠️ **가격·거래량 쪽만 넣는다.** MACD·일목·Stochastic 은 우리 표본으로 **한 번도
   * 검증한 적이 없다.** 신호등을 19만 관측으로 재면서 기각한 가설이 셋이었는데, 그
   * 잣대를 안 거친 지표를 같은 리포트에 나란히 놓으면 둘이 같은 무게로 읽힌다.
   * 골든크로스는 장기(60·180)만 넣는다 — 위의 정배열(5>20>60)과 다른 축이라서다.
   */
  if (store?.bars) {
    const ma = (xs: number[], n: number, back = 0) => {
      const end = xs.length - back;
      if (end < n) return null;
      let sum = 0;
      for (let i = end - n; i < end; i += 1) sum += xs[i];
      return sum / n;
    };
    const brk3m: { p: Pick; vol: number }[] = [];
    const surge: { p: Pick; x: number }[] = [];
    const limitUp: Pick[] = [];
    const goldLong: { p: Pick; vol: number }[] = [];

    for (const s2 of cur) {
      const bars = store.bars[s2.code];
      if (!bars || bars.length < 30) continue;
      const closes = bars.map((b) => b.c).filter((v) => v > 0);
      const last = bars[bars.length - 1];
      const prev = bars[bars.length - 2];
      if (!last || !prev || !(last.c > 0) || !(prev.c > 0)) continue;

      /* 고점돌파 3개월 — 60봉. 1년(위 `high52`)에 든 것은 빼서 겹치지 않게 */
      const win60 = closes.slice(-60);
      if (win60.length >= 40) {
        const prevMax = Math.max(...win60.slice(0, -1));
        const in52 = high52.some((h) => h.p.code === s2.code);
        if (last.c >= prevMax && !in52) {
          brk3m.push({ p: { code: s2.code, name: s2.name, why: `60봉 최고 · 거래대금 ${eok(s2.volEok ?? 0)}` }, vol: s2.volEok ?? 0 });
        }
      }

      /* 상한가 — 한국은 ±30%. 종가가 전일 대비 +29% 넘으면 상한가로 본다 */
      const rate = ((last.c - prev.c) / prev.c) * 100;
      if (rate >= 29) {
        const prev2 = bars[bars.length - 3];
        const back2 = prev2 && prev2.c > 0 ? ((prev.c - prev2.c) / prev2.c) * 100 : 0;
        limitUp.push({
          code: s2.code,
          name: s2.name,
          why: back2 >= 29 ? "연속 상한가" : `상한가 (+${rate.toFixed(1)}%)`,
        });
      }

      /* 거래 급증 — 오늘 거래량 ÷ 직전 10일 평균 */
      const vols = bars.map((b) => b.v ?? 0).filter((v) => v > 0);
      if (vols.length >= 12 && (last.v ?? 0) > 0) {
        const base = vols.slice(-11, -1);
        const avg = base.reduce((a, b) => a + b, 0) / base.length;
        const x = avg > 0 ? (last.v as number) / avg : 0;
        if (x >= 3) {
          surge.push({ p: { code: s2.code, name: s2.name, why: `10일 평균의 ${x.toFixed(1)}배 · 거래대금 ${eok(s2.volEok ?? 0)}` }, x });
        }
      }

      /* 장기 골든크로스 — 오늘 60선이 180선을 넘었고 어제는 아니었다 */
      const a0 = ma(closes, 60);
      const b0 = ma(closes, 180);
      const a1 = ma(closes, 60, 1);
      const b1 = ma(closes, 180, 1);
      if (a0 != null && b0 != null && a1 != null && b1 != null && a0 > b0 && a1 <= b1) {
        goldLong.push({ p: { code: s2.code, name: s2.name, why: `60일선이 180일선 위로 · 거래대금 ${eok(s2.volEok ?? 0)}` }, vol: s2.volEok ?? 0 });
      }
    }

    brk3m.sort((a, b) => b.vol - a.vol);
    surge.sort((a, b) => b.x - a.x);
    goldLong.sort((a, b) => b.vol - a.vol);

    add("brk3m", "고점돌파 (3개월)", brk3m.slice(0, TOP).map((x) => x.p),
      "60봉 안에서 종가가 가장 높은 종목. 위의 52주 신고가에 든 것은 뺐다 — 같은 종목이 두 줄에 나오지 않게.");
    add("limitUp", "상한가", limitUp.slice(0, TOP),
      "종가가 전일 대비 +29% 이상. 「연속」은 어제도 상한가였다는 뜻이다.");
    add("volSurge", "거래 급증 (10일 평균의 3배↑)", surge.slice(0, TOP).map((x) => x.p),
      "거래량이 평소의 몇 배인지. 방향은 안 본다 — 몰린 자리가 고점이었던 계절도 있다(신조 ①체).");
    add("goldLong", "장기 골든크로스 (60일선 > 180일선)", goldLong.slice(0, TOP).map((x) => x.p),
      "오늘 처음 넘어선 것만. 위의 정배열(5>20>60)보다 느린 축이라 둘이 같이 서면 더 무겁다. ⚠️ 우리 표본으로 따로 검증한 기준은 아니다.");
  }

  /* ── 초록 ∩ 외인 3칸 — **실측 근거가 있는 유일한 조합** ──────────
   *
   * 2026-09-11 재검증(29,570관측·87거래일, 시총 중립 초과수익)에서 **가장 넓고 좋았다**:
   *
   *     초록 ∩ 외국인 3칸   20일 +3.2%p · 승률 59 · 하루 17.3개
   *     초록 ∩ 쌍끌이(6칸)  20일 +3.1%p · 승률 58 · 하루  6.2개
   *
   * 성적은 같은데 후보가 **세 배**고, 5일로 봐도 외인3칸은 +0.7 인데 쌍끌이는 −0.1 이다.
   * 그래서 위의 쌍끌이 묶음보다 이쪽을 **맨 아래 결론 자리**에 둔다.
   *
   * ⚠️ 신호등 점수는 **저장된 설정**으로 낸다(`getConfig`) — 화면의 신호등과 같은 값이어야
   * 한다. 백테스트가 코드 기본값으로 채점하던 버그를 한 번 겪었다.
   * ⚠️ 장세(`regimeMap`)를 넘긴다. 실제 신호등이 장세에 따라 기준을 갈아 끼우므로,
   * 안 넘기면 여기 초록과 화면 초록이 다른 날이 생긴다.
   */
  try {
    const cfg = await getConfig();
    const todayRows = file.samples.filter((s2) => s2.date === today);
    const regimeOf = regimeMap(file.samples, cfg);
    const reg = regimeOf.get(today);
    const greenFgn: { p: Pick; vol: number }[] = [];
    for (const s2 of cur) {
      const fg3 = (s2.fgn5 ?? 0) > 0 && (s2.fgn10 ?? 0) > 0 && (s2.fgn20 ?? 0) > 0;
      if (!fg3) continue;
      const sc = scoreFeat(s2, cfg, reg);
      if (sc?.level !== "green") continue;
      greenFgn.push({
        p: {
          code: s2.code,
          name: s2.name,
          why: `신호등 초록 ${Math.round(sc.score)}점 · 외인 20일 ${sign(toEok(s2.fgn20 ?? 0))}억`,
        },
        vol: s2.volEok ?? 0,
      });
    }
    greenFgn.sort((a, b) => b.vol - a.vol);
    void todayRows;
    add(
      "greenFgn",
      "★ 신호등 초록 ∩ 외국인 3칸",
      greenFgn.slice(0, TOP).map((x) => x.p),
      "재검증에서 **가장 넓고 좋았던 조합**이다 — 20일 +3.2%p · 승률 59 · 하루 17.3개. 쌍끌이(+3.1·6.2개)와 성적은 같은데 후보가 세 배다. 위의 묶음들 중 이것만 실측으로 뒷받침된다.",
    );
  } catch (e) {
    console.warn("[reportPicks] 초록∩외인3칸 실패 —", e instanceof Error ? e.message : e);
  }

  /* ── 오늘의 화제 → 관련 종목 (2026-10-21) ────────────────────
   *
   * 벤티지: "얘네는 … 뉴스나 이런 것도 되게 풍부하고" — 인포스탁의 「주요이슈」·
   * 「특징테마」 자리다. 우리는 그 재료가 **이미 있었다**: `topicPulse` 가 채널(빠르고
   * 투기적)과 뉴스(느리고 공식적)를 낱말별로 합쳐 두고, 낱말마다 **관련 종목(`codes`)**
   * 과 **실제 문장(`quote`)** 을 달아 둔다. 여태 글로만 쓰이던 것을 목록으로도 낸다.
   *
   * ⚠️ **둘 다 뜬 것(`where: "both"`)이 먼저다.** 빠른 쪽이 먼저 말하고 느린 쪽이
   * 확인해 준 것이라 질이 다르다 — `topicPulse` 가 이미 그 순서로 정렬해 준다.
   * ⚠️ 종목이 안 붙은 낱말은 **건너뛴다.** 「관세」만 적어 두면 매매에 쓸 수가 없다.
   * ⚠️ `client` 가 없으면 종목명을 못 붙이므로 이 묶음 자체를 안 만든다.
   */
  if (client) {
    try {
      const pulse = await topicPulse("today", client);
      const names = pulse.names ?? {};
      let made = 0;
      for (const it of pulse.items) {
        if (made >= 4) break;
        const codes = it.codes.filter((c) => names[c]).slice(0, 6);
        /*
         * ⚠️ **종목이 둘 이상 엮인 낱말만** 화제로 친다 (2026-10-21 실측으로 조였다).
         *
         * 처음엔 하나만 붙어도 냈는데 이런 것이 섞였다:
         *
         *     화제 — 이닉스 … 「삼성전자·**SK하이닉스** 자사주 매입에만 매달린 코스피」
         *
         * 「하이닉스」 안의 「이닉스」에 걸린 **거짓 연결**이다. 낱말을 자루로 읽어
         * 엉뚱한 기사를 근거로 다는 것 — 사이드카 오보와 같은 종류다.
         *
         * 종목 하나짜리는 애초에 「화제」가 아니라 그냥 그 종목 뉴스이기도 하다.
         * 둘 이상이 같이 엮여야 **테마**가 된다(위 「증권」이 그랬다 — 5종목·기사 144건).
         * 진짜 단일 종목 뉴스를 놓치는 대가는 치르되, 거짓 근거는 안 낸다.
         */
        if (codes.length < 2) continue;
        made += 1;
        const seen = it.where === "both" ? "채널·뉴스 둘 다" : it.where === "channel" ? "채널" : "뉴스";
        add(
          `topic:${it.term}`,
          `화제 — ${it.term}`,
          codes.map((c) => ({ code: c, name: names[c], why: `${it.term} 관련` })),
          `${seen} · 채널 ${it.buzzCount}건 · 기사 ${it.newsCount}건${it.fresh ? " · 처음 나온 말" : ""}` +
            (it.quote ? ` — 「${it.quote.slice(0, 60)}」` : ""),
        );
      }
    } catch (e) {
      console.warn("[reportPicks] 화제 묶음 실패 —", e instanceof Error ? e.message : e);
    }
  }

  return { date: today, ageDays, groups };
}
