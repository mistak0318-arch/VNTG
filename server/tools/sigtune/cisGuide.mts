/**
 * 트레이더 넷 가이드(docs/항해일지_트레이더_가이드.md)의 **숫자 제안**을 표본으로 잰다 (2026-09-07 밤, 벤티지 "가자").
 *
 * 실행: server/ 에서 `npx tsx tools/sigtune/cisGuide.mts`  — 조회 0회. 표본(04~08월) + 전종목 일봉만.
 *
 * 재는 것
 *  ① 단기 추세: 5일선 이격 구간별 성적(「조용한 쪽부터」「+8 늦음」) · 국면(bull/bear) 문 · 분할 60/40 · 절반 익절+20일선 이탈
 *  ② 종배: 상위 K 종가매수→다음 날 시가. 마감 강도(윗꼬리 3%·대금 1.5배·외인 연속) 문이 가르는가
 *  ③ 연금 코어: KODEX200(069500)·코스닥150(229200) 2년 — 상시 보유 vs 20일선 위에서만 vs 60일선 위에서만
 *
 * 못 재는 것: 섹터 폭(표본에 섹터 이름 없음) · NXT 애프터 값 +1.5% · 「최근 10일 실현 플러스」(순서 의존)
 *
 * 규칙: 같은 날 손절·익절 둘 다 찍으면 손절(나쁜 쪽). 앞/뒤 반이 다 플러스일 때만 ✅.
 */
import { loadCloses, type DayBar } from "../../src/dailyCloses.js";
import { getConfig } from "../../src/signalLight.js";
import { loadSamples, scoreFeat, type Sample } from "../../src/signalSamples.js";
import { regimeMap } from "../../src/signalSimulate.js";
import { DEFAULT_RULES, type CisRules } from "../../src/cisTrader.js";

const f = (n: number | null, w = 6) => (n === null ? "-".padStart(w) : (n >= 0 ? "+" : "") + n.toFixed(2).padStart(w - 1));
const pct = (n: number) => n.toFixed(0).padStart(3);

const file = await loadSamples();
if (!file) throw new Error("표본 없음");
const cfg = await getConfig();
const { bars } = await loadCloses();
const barsOf = bars ?? {};
const S = file.samples;
const regimeOf = regimeMap(S, cfg);
const R: CisRules = { ...DEFAULT_RULES };

const idx = new Map<string, Map<string, number>>();
const indexFor = (code: string) => {
  const hit = idx.get(code);
  if (hit) return hit;
  const bs = barsOf[code];
  if (!bs) return null;
  const m = new Map<string, number>();
  bs.forEach((b, i) => m.set(b.d, i));
  idx.set(code, m);
  return m;
};

/* ── 실전 문을 통과한 자리(적극 모드 기본값) ── */
interface Spot {
  s: Sample;
  bs: DayBar[];
  at: number;
  score: number;
}
const spots: Spot[] = [];
for (const s of S) {
  if (R.minTradeValue > 0 && s.volEok !== null && s.volEok < R.minTradeValue) continue;
  if (R.minMarketCap > 0 && s.mktCap !== null && s.mktCap < R.minMarketCap) continue;
  const sc = scoreFeat(s, cfg, regimeOf.get(s.date));
  if (!sc || sc.lowCoverage || sc.score < R.minScore) continue;
  const m = indexFor(s.code);
  const bs = barsOf[s.code];
  if (!m || !bs) continue;
  const at = m.get(s.date);
  if (at === undefined || !bs[at + 1] || !(bs[at + 1].o > 0)) continue;
  spots.push({ s, bs, at, score: sc.score });
}
console.log(`문 통과 자리 ${spots.length} (점수 ${R.minScore}↑ · 대금 ${R.minTradeValue}억 · 시총 ${R.minMarketCap}억) · 표본 ${S.length}`);

/* ── 한 자리 굴리기 (cisBacktest.runOne 과 같은 규칙 + 옵션) ── */
interface Opt {
  /** 분할: 첫 매수 비중(0~1). 종가가 addAt% 넘으면 다음 날 시가에 나머지 */
  first?: number;
  addAt?: number;
  /** 익절에 절반만 팔고 나머지는 본전 손절 + 20일선 이탈(종가) · 최대 보유 restHold */
  halfTarget?: boolean;
  restHold?: number;
}
interface Out {
  rate: number;
  days: number;
  kind: string;
}
function ma(bs: DayBar[], i: number, n: number): number | null {
  if (i - n + 1 < 0) return null;
  let s = 0;
  for (let k = i - n + 1; k <= i; k++) s += bs[k].c;
  return s / n;
}
function run(bs: DayBar[], at: number, r: CisRules, o: Opt = {}): Out | null {
  const entry = bs[at + 1].o;
  const stopAt = entry * (1 + r.stopPct / 100);
  const targetAt = r.targetPct > 0 ? entry * (1 + r.targetPct / 100) : Infinity;
  let armed = false;
  const first = o.first ?? 1;
  let w1 = first; // 첫 몫
  let w2 = 0; // 추가 몫 (진입가 entry2)
  let entry2 = 0;
  let addPending = false;
  const wrate = (px: number) => {
    /* 자본 100 기준 — 안 채운 몫은 0% */
    const a = w1 * ((px - entry) / entry) * 100;
    const b = w2 > 0 ? w2 * ((px - entry2) / entry2) * 100 : 0;
    return a + b;
  };
  for (let k = 1; k <= r.maxHoldDays; k++) {
    const b = bs[at + k];
    if (!b) break;
    if (addPending && b.o > 0) {
      w2 = 1 - first;
      entry2 = b.o;
      addPending = false;
    }
    const armedStop = armed ? entry : stopAt;
    if (b.l <= armedStop) {
      const px = Math.min(armedStop, b.o > 0 ? b.o : armedStop);
      return { rate: wrate(px), days: k, kind: armed ? "trail" : "stop" };
    }
    if (b.h >= targetAt) {
      const px = Math.max(targetAt, b.o > 0 ? b.o : targetAt);
      if (!o.halfTarget) return { rate: wrate(px), days: k, kind: "target" };
      /* 절반 팔고 나머지는 본전 손절 · 20일선 이탈 · restHold 일 */
      const half = wrate(px) / 2;
      const restHold = o.restHold ?? 40;
      for (let j = k + 1; j <= restHold; j++) {
        const c = bs[at + j];
        if (!c) break;
        if (c.l <= entry) return { rate: half + wrate(entry) / 2, days: j, kind: "half+본전" };
        const m20 = ma(bs, at + j, 20);
        if (m20 !== null && c.c < m20) return { rate: half + wrate(c.c) / 2, days: j, kind: "half+20선" };
      }
      const last = bs[Math.min(at + restHold, bs.length - 1)];
      return { rate: half + wrate(last.c) / 2, days: restHold, kind: "half+time" };
    }
    if (!armed && ((b.c - entry) / entry) * 100 >= r.trailAfterPct) armed = true;
    if (o.first !== undefined && o.first < 1 && w2 === 0 && !addPending && ((b.c - entry) / entry) * 100 >= (o.addAt ?? 3)) addPending = true;
  }
  const lastIdx = Math.min(at + r.maxHoldDays, bs.length - 1);
  const last = bs[lastIdx];
  if (!last || lastIdx <= at) return null;
  return { rate: wrate(last.c), days: lastIdx - at, kind: lastIdx - at < r.maxHoldDays ? "open" : "time" };
}

function summarize(label: string, rows: { rate: number; days: number; date: string; kind: string }[]): void {
  if (rows.length === 0) {
    console.log(`${label.padEnd(40)} | n    0`);
    return;
  }
  const avg = rows.reduce((a, b) => a + b.rate, 0) / rows.length;
  const sorted = [...rows.map((r) => r.rate)].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)];
  const win = (rows.filter((r) => r.rate > 0).length / rows.length) * 100;
  const days = rows.reduce((a, b) => a + b.days, 0) / rows.length;
  const wins = rows.filter((r) => r.rate > 0).map((r) => r.rate);
  const losses = rows.filter((r) => r.rate < 0).map((r) => -r.rate);
  const payoff = wins.length && losses.length ? wins.reduce((a, b) => a + b, 0) / wins.length / (losses.reduce((a, b) => a + b, 0) / losses.length) : 0;
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const cut = dates[Math.floor(dates.length / 2)] ?? "";
  const fr = rows.filter((r) => r.date < cut);
  const bk = rows.filter((r) => r.date >= cut);
  const favg = fr.length ? fr.reduce((a, b) => a + b.rate, 0) / fr.length : 0;
  const bavg = bk.length ? bk.reduce((a, b) => a + b.rate, 0) / bk.length : 0;
  /* 기대값 = 평균 × 자리 수 / 100 — 「자리를 줄이는 문」은 평균이 올라도 총합이 줄 수 있다 */
  const total = (avg * rows.length) / 100;
  console.log(
    `${label.padEnd(40)} | n ${String(rows.length).padStart(5)} 평균 ${f(avg)} 중앙 ${f(med)} 승률 ${pct(win)} 보유 ${days.toFixed(1).padStart(4)}일 손익비 ${payoff.toFixed(2)} 합계 ${f(total, 8)} | 앞 ${f(favg)} 뒤 ${f(bavg)} ${fr.length && bk.length && favg > 0 && bavg > 0 ? "✅" : "❌"}`,
  );
}

function trial(label: string, pick: (sp: Spot) => boolean, o: Opt = {}, patch: Partial<CisRules> = {}): void {
  const r = { ...R, ...patch };
  const rows: { rate: number; days: number; date: string; kind: string }[] = [];
  for (const sp of spots) {
    if (!pick(sp)) continue;
    const t = run(sp.bs, sp.at, r, o);
    if (t) rows.push({ ...t, date: sp.s.date });
  }
  summarize(label, rows);
}

console.log("\n### ① 단기 추세 — 5일선 이격 구간 (기본 규칙: 손절 -7 · 본전 +6 · 익절 +15 · 12일)");
trial("기본 (전부)", () => true);
trial("이격 < 0 (5일선 아래)", (sp) => sp.s.ma5Gap !== null && sp.s.ma5Gap < 0);
trial("이격 0~3", (sp) => sp.s.ma5Gap !== null && sp.s.ma5Gap >= 0 && sp.s.ma5Gap < 3);
trial("이격 3~5", (sp) => sp.s.ma5Gap !== null && sp.s.ma5Gap >= 3 && sp.s.ma5Gap < 5);
trial("이격 5~8", (sp) => sp.s.ma5Gap !== null && sp.s.ma5Gap >= 5 && sp.s.ma5Gap < 8);
trial("이격 8~12", (sp) => sp.s.ma5Gap !== null && sp.s.ma5Gap >= 8 && sp.s.ma5Gap < 12);
trial("이격 ≥ 12", (sp) => sp.s.ma5Gap !== null && sp.s.ma5Gap >= 12);
trial("제안: 이격 ≤ 8 만", (sp) => sp.s.ma5Gap !== null && sp.s.ma5Gap <= 8);
trial("제안: 이격 ≤ 5 만", (sp) => sp.s.ma5Gap !== null && sp.s.ma5Gap <= 5);

console.log("\n### ① 국면 문 (표본 폭: 20일선 위 비율 ≥ bullAt → bull)");
const bullDays = [...regimeOf.values()].filter((v) => v === "bull").length;
console.log(`bull 날 ${bullDays} / 판정 날 ${regimeOf.size}`);
trial("bull 날만", (sp) => regimeOf.get(sp.s.date) === "bull");
trial("bear 날만", (sp) => regimeOf.get(sp.s.date) === "bear");

/* 코스피200 ETF 5일 모멘텀 — 「빚은 이길 때만」의 대리 */
const k200 = barsOf["069500"] ?? [];
const k200i = new Map(k200.map((b, i) => [b.d, i]));
const mom5 = (date: string): number | null => {
  const i = k200i.get(date);
  if (i === undefined || i < 5) return null;
  return ((k200[i].c - k200[i - 5].c) / k200[i - 5].c) * 100;
};
trial("bull + 코스피200 5일 모멘텀 > 0", (sp) => regimeOf.get(sp.s.date) === "bull" && (mom5(sp.s.date) ?? -1) > 0);
trial("코스피200 5일 모멘텀 > 0 만", (sp) => (mom5(sp.s.date) ?? -1) > 0);
trial("코스피200 5일 모멘텀 ≤ 0 만", (sp) => (mom5(sp.s.date) ?? 1) <= 0);
/* 연금 코어에서 이긴 문(60일선·골든)을 단기 추세의 시장 문으로 써 보면 */
const k200ma = (date: string, n: number): number | null => {
  const i = k200i.get(date);
  return i === undefined ? null : ma(k200, i, n);
};
const above60 = (date: string) => {
  const i = k200i.get(date);
  const m = k200ma(date, 60);
  return i !== undefined && m !== null && k200[i].c > m;
};
const golden = (date: string) => {
  const a = k200ma(date, 20);
  const b = k200ma(date, 60);
  return a !== null && b !== null && a > b;
};
trial("코스피200 > 60일선 날만", (sp) => above60(sp.s.date));
trial("코스피200 ≤ 60일선 날만", (sp) => !above60(sp.s.date));
trial("코스피200 골든(20>60) 날만", (sp) => golden(sp.s.date));
trial("코스피200 데드(20≤60) 날만", (sp) => !golden(sp.s.date));
trial("골든 + 이격 < 12", (sp) => golden(sp.s.date) && sp.s.ma5Gap !== null && sp.s.ma5Gap < 12);
trial("골든 + 이격 < 12 + 60 비중", (sp) => golden(sp.s.date) && sp.s.ma5Gap !== null && sp.s.ma5Gap < 12, { first: 0.6, addAt: 999 });

console.log("\n### ① 분할 60/40 (+3% 종가 확인 뒤 다음 날 시가에 나머지) — 자본 100 기준");
trial("전액 즉시 (기본)", () => true);
trial("60 먼저, +3% 에 40", () => true, { first: 0.6, addAt: 3 });
trial("60 먼저, +2% 에 40", () => true, { first: 0.6, addAt: 2 });
trial("50 먼저, +3% 에 50", () => true, { first: 0.5, addAt: 3 });
trial("60 만 (추가 없음 = 비중 축소)", () => true, { first: 0.6, addAt: 999 });

console.log("\n### ① 절반 익절 + 나머지 20일선 이탈 (본전 손절)");
trial("익절 +15 전량 (기본)", () => true);
trial("+15 절반 · 나머지 20선 이탈 · 40일", () => true, { halfTarget: true, restHold: 40 });
trial("+15 절반 · 나머지 20선 이탈 · 60일", () => true, { halfTarget: true, restHold: 60 });
trial("+12 절반 · 나머지 20선 이탈 · 40일", () => true, { halfTarget: true, restHold: 40 }, { targetPct: 12 });

/* ── ② 종배 ── */
console.log("\n### ② 종배 — 신호등 초록 상위 K, 종가 매수 → 다음 날 시가 (같은 날 표본 중앙값 대비 초과도)");
interface CRow {
  date: string;
  score: number;
  gap: number;
  wick: number;
  volX: number | null;
  fgnStreak: number;
  inst5: number;
  fgn5: number;
}
const byDate = new Map<string, CRow[]>();
const medOf = new Map<string, number>();
for (const s of S) {
  const m = indexFor(s.code);
  const bs = barsOf[s.code];
  if (!m || !bs) continue;
  const at = m.get(s.date);
  if (at === undefined) continue;
  const b0 = bs[at];
  const b1 = bs[at + 1];
  if (!b0 || !b1 || !(b0.c > 0) || !(b1.o > 0)) continue;
  const gap = ((b1.o - b0.c) / b0.c) * 100;
  const all = medOf.get(s.date);
  /* 중앙값은 나중에 — 우선 모아 둔다 */
  const arr = (byDate.get(s.date) ?? []) as CRow[];
  if (s.volEok !== null && s.volEok < R.minTradeValue) continue;
  if (s.mktCap !== null && s.mktCap < R.minMarketCap) continue;
  const sc = scoreFeat(s, cfg, regimeOf.get(s.date));
  if (!sc || sc.lowCoverage || sc.level !== "green") continue;
  let v20 = 0;
  let nv = 0;
  for (let k = at - 20; k < at; k++) if (k >= 0) (v20 += bs[k].v), (nv += 1);
  arr.push({
    date: s.date,
    score: sc.score,
    gap,
    wick: b0.h > 0 ? ((b0.h - b0.c) / b0.h) * 100 : 99,
    volX: nv > 0 && v20 > 0 ? b0.v / (v20 / nv) : null,
    fgnStreak: (s as unknown as { fgnStreak: number | null }).fgnStreak ?? 0,
    inst5: (s as unknown as { inst5: number | null }).inst5 ?? 0,
    fgn5: (s as unknown as { fgn5: number | null }).fgn5 ?? 0,
  });
  byDate.set(s.date, arr);
  void all;
}
/* 같은 날 전 표본 갭 중앙값 */
const gapAll = new Map<string, number[]>();
for (const s of S) {
  const m = indexFor(s.code);
  const bs = barsOf[s.code];
  if (!m || !bs) continue;
  const at = m.get(s.date);
  if (at === undefined) continue;
  const b0 = bs[at];
  const b1 = bs[at + 1];
  if (!b0 || !b1 || !(b0.c > 0) || !(b1.o > 0)) continue;
  const a = gapAll.get(s.date) ?? [];
  a.push(((b1.o - b0.c) / b0.c) * 100);
  gapAll.set(s.date, a);
}
for (const [d, a] of gapAll) {
  a.sort((x, y) => x - y);
  medOf.set(d, a[Math.floor(a.length / 2)]);
}
function closeTrial(label: string, K: number, pick: (r: CRow) => boolean): void {
  const rows: { date: string; gap: number; ex: number }[] = [];
  for (const [d, arr] of byDate) {
    const top = arr.filter(pick).sort((a, b) => b.score - a.score).slice(0, K);
    for (const r of top) rows.push({ date: d, gap: r.gap, ex: r.gap - (medOf.get(d) ?? 0) });
  }
  if (rows.length === 0) {
    console.log(`${label.padEnd(40)} | n 0`);
    return;
  }
  const avg = rows.reduce((a, b) => a + b.gap, 0) / rows.length;
  const ex = rows.reduce((a, b) => a + b.ex, 0) / rows.length;
  const win = (rows.filter((r) => r.gap > 0).length / rows.length) * 100;
  const dates = [...new Set(rows.map((r) => r.date))].sort();
  const cut = dates[Math.floor(dates.length / 2)] ?? "";
  const fa = rows.filter((r) => r.date < cut);
  const ba = rows.filter((r) => r.date >= cut);
  const favg = fa.length ? fa.reduce((a, b) => a + b.gap, 0) / fa.length : 0;
  const bavg = ba.length ? ba.reduce((a, b) => a + b.gap, 0) / ba.length : 0;
  const days = dates.length;
  console.log(
    `${label.padEnd(40)} | n ${String(rows.length).padStart(4)} (${days}일) 갭 평균 ${f(avg)} 초과 ${f(ex)} 승률 ${pct(win)} 합계 ${f((avg * rows.length) / 100, 8)} | 앞 ${f(favg)} 뒤 ${f(bavg)} ${favg > 0 && bavg > 0 ? "✅" : "❌"}`,
  );
}
for (const K of [1, 3, 5]) {
  console.log(`— 상위 ${K}`);
  closeTrial("문 없음", K, () => true);
  closeTrial("윗꼬리 ≤ 3%", K, (r) => r.wick <= 3);
  closeTrial("대금(거래량) ≥ 20일 평균 1.5배", K, (r) => r.volX !== null && r.volX >= 1.5);
  closeTrial("외인 3일 연속 순매수 또는 기관 5일 순매수", K, (r) => r.fgnStreak >= 3 || r.inst5 > 0);
  closeTrial("외인 3일 연속만", K, (r) => r.fgnStreak >= 3);
  closeTrial("셋 다", K, (r) => r.wick <= 3 && r.volX !== null && r.volX >= 1.5 && (r.fgnStreak >= 3 || r.inst5 > 0));
  closeTrial("윗꼬리 + 거래량", K, (r) => r.wick <= 3 && r.volX !== null && r.volX >= 1.5);
  closeTrial("거래량 ≥ 3배 (과열)", K, (r) => r.volX !== null && r.volX >= 3);
  closeTrial("거래량 1.5배 + 수급(외인3일 or 기관5일)", K, (r) => r.volX !== null && r.volX >= 1.5 && (r.fgnStreak >= 3 || r.inst5 > 0));
  closeTrial("거래량 1.5~3배 + 수급", K, (r) => r.volX !== null && r.volX >= 1.5 && r.volX < 3 && (r.fgnStreak >= 3 || r.inst5 > 0));
  closeTrial("거래량 1.2배 + 수급", K, (r) => r.volX !== null && r.volX >= 1.2 && (r.fgnStreak >= 3 || r.inst5 > 0));
}

/* ── ③ 연금 코어 ── */
console.log("\n### ③ 연금 코어 타이밍 — 2년 일봉, 다음 날 시가 체결, 갈아탈 때 0.05%");
function etfTrial(code: string, name: string): void {
  const bs = barsOf[code];
  if (!bs || bs.length < 100) {
    console.log(`${name} 일봉 없음`);
    return;
  }
  const rule = (label: string, hold: (i: number) => boolean | null): void => {
    let eq = 1;
    let inPos = false;
    let peak = 1;
    let mdd = 0;
    let switches = 0;
    let want = false;
    for (let i = 60; i < bs.length; i++) {
      /* 어제 종가로 정한 뜻을 오늘 시가에 실행 */
      if (want !== inPos && bs[i].o > 0) {
        if (inPos) eq *= (bs[i].o / bs[i - 1].c) * (1 - 0.0005);
        else eq *= (bs[i].c / bs[i].o) * (1 - 0.0005);
        inPos = want;
        switches += 1;
        if (inPos) {
          /* 이미 오늘 시가→종가 반영 */
        }
      } else if (inPos) {
        eq *= bs[i].c / bs[i - 1].c;
      }
      if (eq > peak) peak = eq;
      const dd = (eq / peak - 1) * 100;
      if (dd < mdd) mdd = dd;
      const h = hold(i);
      want = h === null ? want : h;
    }
    const hold2y = ((bs[bs.length - 1].c - bs[60].c) / bs[60].c) * 100;
    console.log(`${(name + " · " + label).padEnd(40)} | 수익 ${f((eq - 1) * 100, 8)} MDD ${f(mdd)} 갈아탐 ${String(switches).padStart(3)} | 상시 보유 ${f(hold2y, 8)}`);
  };
  rule("상시 보유", () => true);
  rule("종가 > 20일선", (i) => {
    const m = ma(bs, i, 20);
    return m === null ? null : bs[i].c > m;
  });
  rule("종가 > 20일선 & 20일선 상승", (i) => {
    const m = ma(bs, i, 20);
    const m5 = ma(bs, i - 5, 20);
    return m === null || m5 === null ? null : bs[i].c > m && m > m5;
  });
  rule("종가 > 60일선", (i) => {
    const m = ma(bs, i, 60);
    return m === null ? null : bs[i].c > m;
  });
  rule("20일선 > 60일선 (골든)", (i) => {
    const a = ma(bs, i, 20);
    const b = ma(bs, i, 60);
    return a === null || b === null ? null : a > b;
  });
}
etfTrial("069500", "KODEX200");
etfTrial("229200", "코스닥150");
process.exit(0);
