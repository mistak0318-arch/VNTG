/**
 * 8부 — 벤티지 안 (2026-09-03): 「기본조건 → 눌림목·수급 누적·이격·거래량·섹터」
 *
 *   기본조건: 분기 영업이익률 좋아지는 추세 · 거래대금 ≥100억 · 시총 ≥1000억 · 섹터 이익률도 좋아지는 중
 *   최고점:  이전에 올랐다 잠깐 내려온 눌림목 · 외인/기관 수급을 모아감 · 이격 좁음 ·
 *            섹터 안에서도 그 종목이 좋아지는 중 · 거래량이 최고점 뒤 줄거나 커지는 중
 *
 * 각 요소를 표본(2026-04~08)에서 시총 중립 초과수익(exs20)으로 재고, 전부 합친 안을
 * 세대 4 와 같은 자(날짜별 상위 20 고정)로 견준다. 실행: server 에서 npx tsx tools/sigtune/sigtune8.mts
 *
 * ⚠️ 표본 계절 주의: 쏠림 → 급락 → 반등. 벤티지 말대로 정상 장이 아니다. 여기 숫자는
 * 「이 계절에 어땠나」지 「늘 그렇다」가 아니다. 그래서 강/약·앞/뒤를 늘 같이 낸다.
 */
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = HERE + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);
const { loadSamples, scoreFeat } = await imp("signalSamples.ts");
const { regimeMap } = await imp("signalSimulate.ts");
const { getConfig } = await imp("signalLight.ts");
const { loadFinanceCache } = await imp("financeCache.ts");
const { loadCloses } = await imp("dailyCloses.ts");
const { loadThemes, isIndexLikeTheme } = await imp("naverThemes.ts");

type S = any;
const file = await loadSamples();
const S: S[] = file.samples;
const base = await getConfig();
const fin = await loadFinanceCache();
const { bars } = await loadCloses();
const themeStore = await loadThemes();
const out: string[] = [];
const P = (s = "") => { out.push(s); console.log(s); };

/* ---------- 실적: 그날 알 수 있던 분기들 ---------- */
function knownAt(period: string): string {
  const y = Number(period.slice(0, 4)), m = Number(period.slice(4, 6));
  const d = new Date(Date.UTC(y, m, 0)); d.setUTCDate(d.getUTCDate() + (m === 12 ? 90 : 45));
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}
const qMemo = new Map<string, { m0: number | null; m1: number | null; m2: number | null; yoy: number | null; op0: number | null; op1: number | null } | null>();
function quartersAt(code: string, date: string) {
  const k = code + date; if (qMemo.has(k)) return qMemo.get(k)!;
  const rows = (fin[code]?.quarters ?? []).filter((r: any) => knownAt(r.period) <= date);
  const r = rows.length ? { m0: rows[0]?.margin ?? null, m1: rows[1]?.margin ?? null, m2: rows[2]?.margin ?? null, yoy: rows[0]?.yoy ?? null, op0: rows[0]?.operatingProfit ?? null, op1: rows[1]?.operatingProfit ?? null } : null;
  qMemo.set(k, r); return r;
}
/* ---------- 일봉 파생 ---------- */
const barIdx = new Map<string, Map<string, number>>();
function idxOf(code: string, date: string): number | undefined {
  const bs = bars?.[code]; if (!bs) return undefined;
  let m = barIdx.get(code); if (!m) { m = new Map(); bs.forEach((b: any, i: number) => m!.set(b.d, i)); barIdx.set(code, m); }
  return m.get(date);
}
const retMemo = new Map<string, number | null>();
function ret20Of(code: string, date: string): number | null {
  const k = code + date; if (retMemo.has(k)) return retMemo.get(k)!;
  const bs = bars?.[code]; const i = idxOf(code, date); let v: number | null = null;
  if (bs && i !== undefined && i >= 20 && bs[i - 20].c > 0) v = ((bs[i].c - bs[i - 20].c) / bs[i - 20].c) * 100;
  retMemo.set(k, v); return v;
}
for (const s of S) {
  const bs = bars?.[s.code]; const i = idxOf(s.code, s.date); if (!bs || i === undefined || i < 61) continue;
  const c = (k: number) => bs[i - k].c;
  s.ret20 = c(20) > 0 ? ((c(0) - c(20)) / c(20)) * 100 : null; s.ret60 = c(60) > 0 ? ((c(0) - c(60)) / c(60)) * 100 : null;
  const v20 = bs.slice(i - 20, i).reduce((a: number, b: any) => a + b.v, 0) / 20; s.volRatio = v20 > 0 ? bs[i].v / v20 : null;
  s.turnover = s.mktCap && s.volEok !== null ? (s.volEok / s.mktCap) * 100 : null;
  const lr: number[] = []; for (let k = 19; k >= 0; k--) { const a = c(k + 1), b = c(k); if (a > 0 && b > 0) lr.push(Math.log(b / a)); }
  const mean = lr.reduce((a, b) => a + b, 0) / lr.length; s.volat20 = lr.length >= 15 ? Math.sqrt(lr.reduce((a, b) => a + (b - mean) ** 2, 0) / lr.length) * 100 : null;
  const lo60 = Math.min(...bs.slice(i - 60, i).map((b: any) => b.l)); s.lo60Pct = lo60 > 0 ? (c(0) / lo60) * 100 : null;
  s.gap = c(1) > 0 ? ((bs[i].o - c(1)) / c(1)) * 100 : null; s.range = bs[i].l > 0 ? ((bs[i].h - bs[i].l) / bs[i].l) * 100 : null;
  /* 눌림목: 60일 최고 종가 대비, 그리고 그 고점이 60일 전보다 얼마나 위였나(먼저 올랐나) */
  let hi = 0, hiK = 0; for (let k = 0; k <= 60; k++) if (c(k) > hi) { hi = c(k); hiK = k; }
  s.dd = hi > 0 ? (c(0) / hi - 1) * 100 : null; s.hiAgo = hiK;
  s.rise = c(60) > 0 ? (hi / c(60) - 1) * 100 : null;
  /* 이격: 20·60일선 */
  const ma = (n: number) => bs.slice(i - n + 1, i + 1).reduce((a: number, b: any) => a + b.c, 0) / n;
  s.gap20 = ((c(0) / ma(20)) - 1) * 100; s.gap60 = ((c(0) / ma(60)) - 1) * 100;
  /* 거래량 패턴: 최근 5일 평균 / 20일 최고, 최근 5일 평균 / 20일 평균 */
  const v5 = bs.slice(i - 4, i + 1).reduce((a: number, b: any) => a + b.v, 0) / 5;
  const vmax = Math.max(...bs.slice(i - 19, i + 1).map((b: any) => b.v));
  s.vDry = vmax > 0 ? v5 / vmax : null; s.vGrow = v20 > 0 ? v5 / v20 : null;
  /* 실적 */
  const q = quartersAt(s.code, s.date);
  s.m0 = q?.m0 ?? null; s.mTrend = q && q.m0 !== null && q.m1 !== null ? q.m0 - q.m1 : null;
  s.mUp2 = q && q.m0 !== null && q.m1 !== null && q.m2 !== null ? (q.m0 > q.m1 && q.m1 > q.m2 ? 1 : 0) : null;
  s.qYoY = q?.yoy ?? null; s.opUp = q && q.op0 !== null && q.op1 !== null ? (q.op0 > q.op1 ? 1 : 0) : null;
  /* 수급 누적: 20일 순매수가 양이고 60일 평균 속도보다 빠르다 */
  s.fgnAcc = s.fgn20 != null && s.fgn60 != null ? (s.fgn20 > 0 && s.fgn20 > s.fgn60 / 3 ? 1 : 0) : null;
  s.instAcc = s.inst20 != null && s.inst60 != null ? (s.inst20 > 0 && s.inst20 > s.inst60 / 3 ? 1 : 0) : null;
  s.smartAcc = s.smart20 != null && s.smart60 != null ? (s.smart20 > 0 && s.smart20 > s.smart60 / 3 ? 1 : 0) : null;
}
/* ---------- 섹터(네이버 테마) 이익률 추세 · 섹터 내 상대 ---------- */
const members = new Map<number, string[]>(); const themesOf = new Map<string, number[]>();
for (const t of themeStore.themes ?? []) {
  if (isIndexLikeTheme(t.name)) continue;
  const codes = (t.stocks ?? []).map((x: any) => x.code); members.set(t.no, codes);
  for (const c of codes) (themesOf.get(c) ?? themesOf.set(c, []).get(c)!).push(t.no);
}
const med = (a: number[]) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const nn = (a: (number | null | undefined)[]) => a.filter((v): v is number => v != null && Number.isFinite(v));
const secMemo = new Map<string, { mt: number; rel: number; n: number } | null>();
for (const s of S) {
  const ts = themesOf.get(s.code) ?? []; if (!ts.length) { s.secMT = null; s.secRel = null; continue; }
  /* 종목의 테마 중 실적 있는 회원이 가장 많은 것을 「섹터」로 */
  let best: { mt: number; rel: number; n: number } | null = null;
  for (const no of ts) {
    const k = no + ":" + s.date; let v = secMemo.get(k);
    if (v === undefined) {
      const cs = (members.get(no) ?? []).filter((c) => c !== s.code);
      const mts = nn(cs.map((c) => { const q = quartersAt(c, s.date); return q && q.m0 !== null && q.m1 !== null ? q.m0 - q.m1 : null; }));
      const r20 = nn(cs.map((c) => ret20Of(c, s.date)));
      v = mts.length >= 3 ? { mt: med(mts), rel: med(r20), n: mts.length } : null; secMemo.set(k, v);
    }
    if (v && (!best || v.n > best.n)) best = v;
  }
  s.secMT = best ? best.mt : null; s.secN = best ? best.n : null;
  s.secRel = best && s.ret20 != null && Number.isFinite(best.rel) ? s.ret20 - best.rel : null;
}
/* ---------- 초과수익 · 상대강도 · 분할 ---------- */
const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
for (const [, rows] of byDate) {
  const wc = rows.filter((r) => r.mktCap !== null).sort((a, b) => a.mktCap - b.mktCap);
  wc.forEach((r, i) => { r.q = Math.min(4, Math.floor((i * 5) / wc.length)); });
  const qMed = [0, 1, 2, 3, 4].map((q) => med(nn(wc.filter((r) => r.q === q).map((r) => r.d20))));
  const m20 = med(nn(rows.map((r) => r.d20))), r20 = med(nn(rows.map((r) => r.ret20))), r60 = med(nn(rows.map((r) => r.ret60)));
  for (const r of rows) {
    r.exs20 = r.d20 === null || r.q === undefined ? null : r.d20 - qMed[r.q];
    r.ex20 = r.d20 === null ? null : r.d20 - m20;
    r.rs20 = r.ret20 == null ? null : r.ret20 - r20; r.rs60 = r.ret60 == null ? null : r.ret60 - r60;
  }
}
const reg = regimeMap(S, base);
const dates = [...byDate.keys()].sort();
const mid = dates[Math.floor(dates.length / 2)];
for (const s of S) { s.reg = reg.get(s.date) ?? "?"; s.half = s.date < mid ? "F" : "B"; s.blk = Math.min(3, Math.floor(dates.indexOf(s.date) / 20)); }
const hot = (s: S) => s.turnover >= 3 || s.range >= 12 || s.volRatio >= 2.5 || s.gap >= 3 || s.volat20 >= 7;
const late = (s: S) => s.rs20 >= 20 || s.rs60 >= 30 || s.lo60Pct >= 150;
const alert = (s: S) => hot(s) || (s.reg === "bear" && late(s));
const basic = (s: S) => s.volEok !== null && s.volEok >= 100 && s.mktCap !== null && s.mktCap >= 1000;

/* ---------- 지표 ---------- */
const f1 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(1) : "  — ");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "—");
function cut(rows: S[], key = "exs20") { const v = nn(rows.map((r) => r[key])); if (!v.length) return { n: 0, med: NaN, win: NaN }; return { n: v.length, med: med(v), win: (100 * v.filter((x) => x > 0).length) / v.length }; }
const c3 = (rows: S[]) => { const c = cut(rows); return `${f1(c.med).padStart(5)}/${f0(c.win).padStart(2)}`; };
function bucketTable(title: string, rows: S[], key: string, edges: [number, number, string][]) {
  P(`\n### ${title}`);
  P(`${"구간".padEnd(22)}|    n  exs20/승 |강세    약세   |앞     뒤     |블록1  2     3     4`);
  for (const [lo, hi, lab] of edges) {
    const r = rows.filter((x) => x[key] != null && x[key] >= lo && x[key] < hi);
    P(`${lab.padEnd(22)}|${String(r.length).padStart(5)} ${c3(r)} |${c3(r.filter((x) => x.reg === "bull"))} ${c3(r.filter((x) => x.reg === "bear"))} |${c3(r.filter((x) => x.half === "F"))} ${c3(r.filter((x) => x.half === "B"))} |${[0, 1, 2, 3].map((b) => f1(cut(r.filter((x) => x.blk === b)).med).padStart(5)).join(" ")}`);
  }
}
const B = S.filter(basic);
P(`표본 ${S.length} · 기본조건(대금≥100억·시총≥1000억) ${B.length} · ${dates.length}일 · 강세 ${dates.filter((d) => reg.get(d) === "bull").length}일 · exs20 = 같은 날 같은 시총 5분위 중앙값 대비 20일`);
P(`실적 칸 있음 ${B.filter((s) => s.mTrend != null).length} · 섹터 칸 있음 ${B.filter((s) => s.secMT != null).length}`);

P("\n## 1. 요소별 — 기본조건 안에서");
bucketTable("분기 영업이익률 추세 (최근 분기 − 직전 분기, %p)", B, "mTrend", [[-99, -5, "-5 아래 (나빠짐)"], [-5, 0, "-5~0"], [0, 3, "0~3 (조금 좋아짐)"], [3, 8, "3~8"], [8, 999, "8 이상 (크게 좋아짐)"]]);
bucketTable("두 분기 연속 이익률 개선", B, "mUp2", [[0, 1, "아니오"], [1, 2, "예"]]);
bucketTable("영업이익 직전 분기보다 늘었나", B, "opUp", [[0, 1, "아니오"], [1, 2, "예"]]);
bucketTable("영업이익 YoY (지금 봉우리형 기준 — 하이닉스가 0점 받은 자리)", B, "qYoY", [[-9999, -50, "-50 아래"], [-50, 0, "-50~0"], [0, 50, "0~50"], [50, 100, "50~100"], [100, 300, "100~300"], [300, 99999, "300 이상"]]);
bucketTable("섹터(테마 회원) 이익률 추세 중앙값 (%p)", B, "secMT", [[-99, -2, "-2 아래"], [-2, 0, "-2~0"], [0, 2, "0~2"], [2, 999, "2 이상"]]);
bucketTable("눌림목: 60일 고점 대비 (%)", B, "dd", [[-100, -25, "-25 아래 (무너짐)"], [-25, -15, "-25~-15"], [-15, -8, "-15~-8 (눌림)"], [-8, -3, "-8~-3 (얕은 눌림)"], [-3, 1, "-3~0 (고점 근처)"]]);
const risen = B.filter((s) => s.rise != null && s.rise >= 10);
bucketTable("눌림목 — 먼저 올랐던 것(고점이 60일 전보다 +10%↑)만", risen, "dd", [[-100, -25, "-25 아래"], [-25, -15, "-25~-15"], [-15, -8, "-15~-8 (눌림)"], [-8, -3, "-8~-3"], [-3, 1, "-3~0"]]);
bucketTable("20일선 이격 (%)", B, "gap20", [[-99, -10, "-10 아래"], [-10, -5, "-10~-5"], [-5, -2, "-5~-2"], [-2, 2, "-2~+2 (붙음)"], [2, 6, "+2~+6"], [6, 99, "+6 이상 (벌어짐)"]]);
bucketTable("60일선 이격 (%)", B, "gap60", [[-99, -10, "-10 아래"], [-10, -3, "-10~-3"], [-3, 3, "-3~+3 (붙음)"], [3, 10, "+3~+10"], [10, 99, "+10 이상"]]);
bucketTable("외국인 모아감 (20일 순매수 > 0 이고 60일 속도보다 빠름)", B, "fgnAcc", [[0, 1, "아니오"], [1, 2, "예"]]);
bucketTable("기관 모아감", B, "instAcc", [[0, 1, "아니오"], [1, 2, "예"]]);
bucketTable("주포(투신·연기금·사모) 모아감", B, "smartAcc", [[0, 1, "아니오"], [1, 2, "예"]]);
bucketTable("거래량 — 최근 5일 평균 / 20일 최고 (줄어듦)", B, "vDry", [[0, 0.3, "0.3 미만 (바짝 마름)"], [0.3, 0.5, "0.3~0.5"], [0.5, 0.8, "0.5~0.8"], [0.8, 9, "0.8 이상 (최고 근처)"]]);
bucketTable("거래량 — 최근 5일 평균 / 20일 평균 (커짐)", B, "vGrow", [[0, 0.6, "0.6 미만"], [0.6, 1, "0.6~1"], [1, 1.5, "1~1.5"], [1.5, 99, "1.5 이상 (커짐)"]]);
bucketTable("섹터 안 상대 (종목 20일 − 섹터 회원 중앙 20일, %p)", B, "secRel", [[-99, -10, "-10 아래"], [-10, -3, "-10~-3"], [-3, 3, "-3~+3"], [3, 10, "+3~+10"], [10, 99, "+10 이상"]]);

/* ---------- 2. 합친 안 — 날짜별 상위 20 ---------- */
P("\n## 2. 합친 안 — 날짜별 상위 20 고정 (세대 4 와 같은 자)");
function topKLine(label: string, picks: S[], K: number, perDay: number[]) {
  const c = cut(picks), ex = cut(picks, "ex20"), d = cut(picks, "d20");
  const v = nn(picks.map((r) => r.exs20)).sort((a, b) => a - b);
  const bot = v.length ? v.slice(0, Math.max(1, Math.floor(v.length * 0.1))) : [];
  const botMean = bot.length ? bot.reduce((a, b) => a + b, 0) / bot.length : NaN;
  const crash = nn(picks.map((r) => r.d20)); const crashPct = crash.length ? (100 * crash.filter((x) => x <= -10).length) / crash.length : NaN;
  const uniq = new Set(picks.map((r) => r.code)).size;
  const el = [...perDay].sort((a, b) => a - b); const elMed = el.length ? el[el.length >> 1] : 0;
  const blk = [0, 1, 2, 3].map((b) => f1(cut(picks.filter((r) => r.blk === b)).med).padStart(5)).join(" ");
  return `${label.padEnd(36)}|${String(c.n).padStart(5)} ${f1(c.med).padStart(5)}/${f0(c.win)} |ex${f1(ex.med).padStart(5)} 절대${f1(d.med).padStart(5)} |하위10% ${f1(botMean).padStart(5)} -10%↓ ${f0(crashPct).padStart(2)}% |강${c3(picks.filter((r) => r.reg === "bull"))} 약${c3(picks.filter((r) => r.reg === "bear"))} |${blk} |고유 ${String(uniq).padStart(3)} |후보/일 ${String(elMed).padStart(3)} 부족일 ${perDay.filter((x) => x < K).length}`;
}
P(`${"집합".padEnd(36)}|    n  exs20/승 |ex20   절대d20 |하방          |강세장  약세장 |블록1     2     3     4 |고유 |하루 후보`);
function topK(rows: S[], K: number, key: (s: S) => number, tie: (s: S) => number = (s) => (s.fgn20 ?? 0) / Math.max(1, s.mktCap ?? 1)) {
  const byD = new Map<string, S[]>(); for (const s of rows) (byD.get(s.date) ?? byD.set(s.date, []).get(s.date)!).push(s);
  const picks: S[] = []; const perDay: number[] = [];
  for (const d of dates) { const list = (byD.get(d) ?? []).sort((a, b) => key(b) - key(a) || tie(b) - tie(a)); perDay.push(list.length); for (const s of list.slice(0, K)) picks.push(s); }
  return { picks, perDay };
}
/* 세대 4 */
const r4 = regimeMap(S, base);
const g4 = new Map<S, { score: number; level: string; low: boolean }>();
for (const s of S) { const x = scoreFeat(s, base, r4.get(s.date)); if (x) g4.set(s, { score: x.score, level: x.level, low: x.lowCoverage }); }
{ const rows = S.filter((s) => { const g = g4.get(s); return g && g.level !== "red" && !g.low; }); const { picks, perDay } = topK(rows, 20, (s) => g4.get(s)!.score); P(topKLine("세대 4 점수 순 (탈락·덜 잼 제외)", picks, 20, perDay)); }
/* 벤티지 안 */
const inZone = (s: S) => s.dd != null && s.dd >= -15 && s.dd <= -3 && s.rise != null && s.rise >= 10;
const tight = (s: S) => s.gap20 != null && Math.abs(s.gap20) <= 5;
const volOK = (s: S) => (s.vDry != null && s.vDry <= 0.5) || (s.vGrow != null && s.vGrow >= 1.3);
const vScore = (s: S) => (inZone(s) ? 1 : 0) + (tight(s) ? 1 : 0) + (s.fgnAcc === 1 ? 1 : 0) + (s.instAcc === 1 || s.smartAcc === 1 ? 1 : 0) + (volOK(s) ? 1 : 0) + (s.secMT != null && s.secMT > 0 ? 1 : 0) + (s.secRel != null && s.secRel > 0 ? 1 : 0);
const basicV = (s: S) => basic(s) && s.mTrend != null && s.mTrend > 0 && !hot(s);
{ const rows = S.filter(basicV); const { picks, perDay } = topK(rows, 20, vScore); P(topKLine("V 기본조건(이익률↑·잡주X·쏠림X) → 7점 순", picks, 20, perDay)); }
{ const rows = S.filter((s) => basicV(s) && s.secMT != null && s.secMT > 0); const { picks, perDay } = topK(rows, 20, vScore); P(topKLine("V + 섹터 이익률↑ 도 기본조건", picks, 20, perDay)); }
{ const rows = S.filter((s) => basic(s) && !hot(s)); const { picks, perDay } = topK(rows, 20, vScore); P(topKLine("V 이익률 조건 없이 (잡주X·쏠림X) → 7점 순", picks, 20, perDay)); }
{ const rows = S.filter((s) => basicV(s)); const { picks, perDay } = topK(rows, 20, (s) => (inZone(s) ? 1 : 0) + (tight(s) ? 1 : 0) + (s.fgnAcc === 1 ? 1 : 0)); P(topKLine("V 셋만: 눌림·이격·외인", picks, 20, perDay)); }
{ const rows = S.filter((s) => basicV(s)); const { picks, perDay } = topK(rows, 20, (s) => (s.fgnAcc === 1 ? 1 : 0) + (s.instAcc === 1 || s.smartAcc === 1 ? 1 : 0)); P(topKLine("V 수급 둘만", picks, 20, perDay)); }
{ const rows = S.filter((s) => basicV(s)); const { picks, perDay } = topK(rows, 20, (s) => (inZone(s) ? 1 : 0) + (tight(s) ? 1 : 0) + (volOK(s) ? 1 : 0)); P(topKLine("V 차트 셋만: 눌림·이격·거래량", picks, 20, perDay)); }
{ const rows = S.filter((s) => basicV(s) && vScore(s) >= 5); P(topKLine("V 7점 중 5점 이상 전부 (집합 크기 무관)", rows, 20, dates.map((d) => rows.filter((s) => s.date === d).length))); }
{ const rows = S.filter((s) => basicV(s) && vScore(s) >= 6); P(topKLine("V 6점 이상 전부", rows, 20, dates.map((d) => rows.filter((s) => s.date === d).length))); }
/* 세대 4 + 벤티지 기본조건 */
{ const rows = S.filter((s) => { const g = g4.get(s); return g && g.level !== "red" && !g.low && s.mTrend != null && s.mTrend > 0; }); const { picks, perDay } = topK(rows, 20, (s) => g4.get(s)!.score); P(topKLine("세대 4 + 이익률↑ 기본조건", picks, 20, perDay)); }
{ const rows = S.filter((s) => { const g = g4.get(s); return g && g.level !== "red" && !g.low; }); const { picks, perDay } = topK(rows, 20, (s) => g4.get(s)!.score + vScore(s) * 5); P(topKLine("세대 4 점수 + V 7점×5 가산", picks, 20, perDay)); }
{ const rows = S.filter(basic); const { picks, perDay } = topK(rows, 20, () => Math.random()); P(topKLine("무작위 (기본조건 안)", picks, 20, perDay)); }

P("\n## 3. V 점수 단조성 (기본조건 + 이익률↑ + 쏠림X)");
P(`${"V 점수".padEnd(10)}|    n  exs20/승 |강세    약세   |앞     뒤     |블록1  2     3     4`);
for (let v = 0; v <= 7; v++) { const r = S.filter((s) => basicV(s) && vScore(s) === v); P(`${String(v).padEnd(10)}|${String(r.length).padStart(5)} ${c3(r)} |${c3(r.filter((x) => x.reg === "bull"))} ${c3(r.filter((x) => x.reg === "bear"))} |${c3(r.filter((x) => x.half === "F"))} ${c3(r.filter((x) => x.half === "B"))} |${[0, 1, 2, 3].map((b) => f1(cut(r.filter((x) => x.blk === b)).med).padStart(5)).join(" ")}`); }

/* ---------- 4. 하이닉스 자리 — YoY ≥100% 를 이익률 추세로 가르면 ---------- */
P("\n## 4. 영업이익 YoY ≥100% (지금 0점) 를 「이익률이 아직 좋아지는 중인가」로 가르면");
P(`${"구간".padEnd(34)}|    n  exs20/승 |강세    약세   |앞     뒤     |블록1  2     3     4`);
for (const [lab, f] of [
  ["YoY≥100 · 이익률 개선 중 (m0>m1)", (s: S) => s.qYoY >= 100 && s.mTrend > 0],
  ["YoY≥100 · 이익률 꺾임 (m0≤m1)", (s: S) => s.qYoY >= 100 && s.mTrend <= 0],
  ["YoY≥100 · 영업이익 QoQ 증가", (s: S) => s.qYoY >= 100 && s.opUp === 1],
  ["YoY≥100 · 영업이익 QoQ 감소", (s: S) => s.qYoY >= 100 && s.opUp === 0],
  ["YoY 0~100 · 이익률 개선 중", (s: S) => s.qYoY >= 0 && s.qYoY < 100 && s.mTrend > 0],
  ["YoY 0~100 · 이익률 꺾임", (s: S) => s.qYoY >= 0 && s.qYoY < 100 && s.mTrend <= 0],
] as [string, (s: S) => boolean][]) {
  const r = B.filter((s) => s.qYoY != null && s.mTrend != null && f(s));
  P(`${lab.padEnd(34)}|${String(r.length).padStart(5)} ${c3(r)} |${c3(r.filter((x) => x.reg === "bull"))} ${c3(r.filter((x) => x.reg === "bear"))} |${c3(r.filter((x) => x.half === "F"))} ${c3(r.filter((x) => x.half === "B"))} |${[0, 1, 2, 3].map((b) => f1(cut(r.filter((x) => x.blk === b)).med).padStart(5)).join(" ")}`);
}
/* 0점의 정체 — 축이 비어서 0 인 것이 얼마나 되나 */
{
  const zero = S.filter((s) => g4.get(s)?.score === 0);
  const bearZero = zero.filter((s) => s.reg === "bear").length;
  P(`\n세대 4 점수 0 인 관측: ${zero.length} (${((100 * zero.length) / S.length).toFixed(1)}%) · 그중 약세장 ${bearZero} — 약세장은 추세 축이 비어 수급·실적 둘로만 점수가 나온다`);
  P(`0점 집합의 20일 뒤: ${c3(zero)} (강 ${c3(zero.filter((s) => s.reg === "bull"))} 약 ${c3(zero.filter((s) => s.reg === "bear"))})`);
}

/* ---------- 5. 세대 4 위에 살아남은 요소를 얹으면 ---------- */
P("\n## 5. 세대 4 위에 얹기 — 날짜별 상위 20 (탈락·덜 잼 제외). 가산은 점수에 더한 뒤 순위");
P(`${"집합".padEnd(36)}|    n  exs20/승 |ex20   절대d20 |하방          |강세장  약세장 |블록1     2     3     4 |고유 |하루 후보`);
const ok4 = (s: S) => { const g = g4.get(s); return !!g && g.level !== "red" && !g.low; };
const sc4 = (s: S) => g4.get(s)!.score;
const tight20 = (s: S) => s.gap20 != null && s.gap20 >= -5 && s.gap20 <= 2;
const relZone = (s: S) => s.secRel != null && s.secRel >= -3 && s.secRel <= 10;
const secUp = (s: S) => s.secMT != null && s.secMT >= 2;
const volMod = (s: S) => s.vGrow != null && s.vGrow >= 1 && s.vGrow <= 1.5;
const pull = (s: S) => s.reg === "bear" && inZone(s);
const kill60 = (s: S) => s.reg === "bear" && s.gap60 != null && s.gap60 >= 10;
const killDry = (s: S) => s.vGrow != null && s.vGrow < 0.6;
const line = (label: string, elig: (s: S) => boolean, key: (s: S) => number) => { const { picks, perDay } = topK(S.filter(elig), 20, key); P(topKLine(label, picks, 20, perDay)); };
line("세대 4 (기준)", ok4, sc4);
line("+ 탈락: 약세장 60일선 이격 +10↑", (s) => ok4(s) && !kill60(s), sc4);
line("+ 탈락: 거래량 5일/20일 < 0.6 (마름)", (s) => ok4(s) && !killDry(s), sc4);
line("+ 탈락 둘 다", (s) => ok4(s) && !kill60(s) && !killDry(s), sc4);
line("+ 가산 외인 모아감 ×10", ok4, (s) => sc4(s) + (s.fgnAcc === 1 ? 10 : 0));
line("+ 가산 20일선 이격 좁음 ×10", ok4, (s) => sc4(s) + (tight20(s) ? 10 : 0));
line("+ 가산 섹터 내 상대 -3~+10 ×10", ok4, (s) => sc4(s) + (relZone(s) ? 10 : 0));
line("+ 가산 섹터 이익률 ≥2 ×10", ok4, (s) => sc4(s) + (secUp(s) ? 10 : 0));
line("+ 가산 거래량 1~1.5배 ×10", ok4, (s) => sc4(s) + (volMod(s) ? 10 : 0));
line("+ 가산 약세장 눌림목 ×10", ok4, (s) => sc4(s) + (pull(s) ? 10 : 0));
const bonus = (s: S) => (s.fgnAcc === 1 ? 10 : 0) + (tight20(s) ? 10 : 0) + (relZone(s) ? 10 : 0) + (secUp(s) ? 10 : 0) + (volMod(s) ? 10 : 0) + (pull(s) ? 10 : 0);
line("+ 가산 여섯 전부 ×10", ok4, (s) => sc4(s) + bonus(s));
line("+ 탈락 둘 + 가산 여섯", (s) => ok4(s) && !kill60(s) && !killDry(s), (s) => sc4(s) + bonus(s));
line("+ 탈락 둘 + 가산 넷(외인·이격·섹터상대·섹터이익률)", (s) => ok4(s) && !kill60(s) && !killDry(s), (s) => sc4(s) + (s.fgnAcc === 1 ? 10 : 0) + (tight20(s) ? 10 : 0) + (relZone(s) ? 10 : 0) + (secUp(s) ? 10 : 0));
line("〃 가산 ×5", (s) => ok4(s) && !kill60(s) && !killDry(s), (s) => sc4(s) + 0.5 * ((s.fgnAcc === 1 ? 10 : 0) + (tight20(s) ? 10 : 0) + (relZone(s) ? 10 : 0) + (secUp(s) ? 10 : 0)));
line("〃 가산 ×20", (s) => ok4(s) && !kill60(s) && !killDry(s), (s) => sc4(s) + 2 * ((s.fgnAcc === 1 ? 10 : 0) + (tight20(s) ? 10 : 0) + (relZone(s) ? 10 : 0) + (secUp(s) ? 10 : 0)));
/* 하이닉스 구제: YoY≥100 이고 이익률 개선 중이면 실적 축 0 → 50 상당 (평균 셋이라 ≈ +17) */
line("+ YoY≥100·이익률 개선 중이면 +17 (하이닉스 구제)", ok4, (s) => sc4(s) + (s.qYoY >= 100 && s.mTrend > 0 ? 17 : 0));

writeFileSync(HERE + "/sigtune-8.txt", out.join("\n"), "utf8");
