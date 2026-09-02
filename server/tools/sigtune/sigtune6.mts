/**
 * 6부 — 신호등 체계 확립 (docs/신호등_튜닝_프롬프트.md 의 규칙대로)
 *
 *   · 성능 = 날짜별 상위 K개(10·20·40) 고정 비교 + 하방 + 일별 개수 + 고유 종목 + 단조성
 *   · 구조 A(가산 점수) / B(거르개 + 한 축 순위) / C(거르개 뒤 가산 점수)
 *   · 강건성 = 문턱 ±20% · leave-one-out · 무게 1 통일 · 장세 전환 끄기 · bullAt 40/60
 *   · 최소 집합 = 뒤에서 하나씩 빼기
 *
 * 실행: server 에서  npx tsx tools/sigtune/sigtune6.mts   (기본값·파일 안 건드림)
 */
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = HERE + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);
const { loadSamples, scoreFeat, gradeOf, rawOf } = await imp("signalSamples.ts");
const { regimeMap } = await imp("signalSimulate.ts");
const { getConfig } = await imp("signalLight.ts");
const { loadFinanceCache, profitAt, quarterAt } = await imp("financeCache.ts");
const { loadCloses } = await imp("dailyCloses.ts");

type S = any;
const file = await loadSamples();
const S: S[] = file.samples;
const base = await getConfig();
const fin = await loadFinanceCache();
const { bars } = await loadCloses();
const out: string[] = [];
const P = (s = "") => { out.push(s); console.log(s); };

/* ---------- 실적 · 일봉 파생 ---------- */
for (const s of S) { const rec = fin[s.code]; if (rec) { s.profitYoY = profitAt(rec, s.date); Object.assign(s, quarterAt(rec, s.date)); } }
const barIdx = new Map<string, Map<string, number>>();
for (const s of S) {
  const bs = bars?.[s.code]; if (!bs) continue;
  let m = barIdx.get(s.code); if (!m) { m = new Map(); bs.forEach((b: any, i: number) => m!.set(b.d, i)); barIdx.set(s.code, m); }
  const i = m.get(s.date); if (i === undefined || i < 61) continue;
  const c = (k: number) => bs[i - k].c;
  s.ret20 = c(20) > 0 ? ((c(0) - c(20)) / c(20)) * 100 : null; s.ret60 = c(60) > 0 ? ((c(0) - c(60)) / c(60)) * 100 : null;
  const v20 = bs.slice(i - 20, i).reduce((a: number, b: any) => a + b.v, 0) / 20; s.volRatio = v20 > 0 ? bs[i].v / v20 : null;
  s.turnover = s.mktCap && s.volEok !== null ? (s.volEok / s.mktCap) * 100 : null;
  const lr: number[] = []; for (let k = 19; k >= 0; k--) { const a = c(k + 1), b = c(k); if (a > 0 && b > 0) lr.push(Math.log(b / a)); }
  const mean = lr.reduce((a, b) => a + b, 0) / lr.length; s.volat20 = lr.length >= 15 ? Math.sqrt(lr.reduce((a, b) => a + (b - mean) ** 2, 0) / lr.length) * 100 : null;
  const lo60 = Math.min(...bs.slice(i - 60, i).map((b: any) => b.l)); s.lo60Pct = lo60 > 0 ? (c(0) / lo60) * 100 : null;
  s.gap = c(1) > 0 ? ((bs[i].o - c(1)) / c(1)) * 100 : null; s.range = bs[i].l > 0 ? ((bs[i].h - bs[i].l) / bs[i].l) * 100 : null;
}
/* ---------- 초과수익 · 상대강도 ---------- */
const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
const med = (a: number[]) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const nn = (a: (number | null | undefined)[]) => a.filter((v): v is number => v != null && Number.isFinite(v));
for (const [, rows] of byDate) {
  const wc = rows.filter((r) => r.mktCap !== null).sort((a, b) => a.mktCap - b.mktCap);
  wc.forEach((r, i) => { r.q = Math.min(4, Math.floor((i * 5) / wc.length)); });
  const qMed = [0, 1, 2, 3, 4].map((q) => med(nn(wc.filter((r) => r.q === q).map((r) => r.d20))));
  const qMed5 = [0, 1, 2, 3, 4].map((q) => med(nn(wc.filter((r) => r.q === q).map((r) => r.d5))));
  const m20 = med(nn(rows.map((r) => r.d20))), r20 = med(nn(rows.map((r) => r.ret20))), r60 = med(nn(rows.map((r) => r.ret60)));
  for (const r of rows) {
    r.exs20 = r.d20 === null || r.q === undefined ? null : r.d20 - qMed[r.q];
    r.exs5 = r.d5 === null || r.q === undefined ? null : r.d5 - qMed5[r.q];
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

/* ---------- 지표 ---------- */
const f1 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(1) : "  — ");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "—");
function cut(rows: S[], key = "exs20") { const v = nn(rows.map((r) => r[key])); if (!v.length) return { n: 0, med: NaN, win: NaN, trim: NaN }; const s = [...v].sort((a, b) => a - b); const k = s.length >= 50 ? Math.floor(s.length * 0.02) : 0; const inner = k ? s.slice(k, s.length - k) : s; return { n: v.length, med: med(v), win: (100 * v.filter((x) => x > 0).length) / v.length, trim: inner.reduce((a, b) => a + b, 0) / inner.length }; }
const c3 = (rows: S[], key = "exs20") => { const c = cut(rows, key); return `${f1(c.med).padStart(5)}/${f0(c.win).padStart(2)}`; };
/** 상위 K 집합의 종합 지표 한 줄 */
function topKLine(label: string, picks: S[], K: number, perDayEligible: number[]) {
  const c = cut(picks), ex = cut(picks, "ex20"), d = cut(picks, "d20"), d5 = cut(picks, "exs5");
  const v = nn(picks.map((r) => r.exs20)).sort((a, b) => a - b);
  const bot = v.length ? v.slice(0, Math.max(1, Math.floor(v.length * 0.1))) : [];
  const botMean = bot.length ? bot.reduce((a, b) => a + b, 0) / bot.length : NaN;
  const crash = nn(picks.map((r) => r.d20)); const crashPct = crash.length ? (100 * crash.filter((x) => x <= -10).length) / crash.length : NaN;
  const uniq = new Set(picks.map((r) => r.code)).size;
  const byD = new Map<string, Set<string>>(); for (const r of picks) (byD.get(r.date) ?? byD.set(r.date, new Set()).get(r.date)!).add(r.code);
  let rep = 0, tot = 0; for (let i = 1; i < dates.length; i++) { const a = byD.get(dates[i - 1]), b = byD.get(dates[i]); if (!a || !b) continue; for (const c of b) { tot++; if (a.has(c)) rep++; } }
  const el = [...perDayEligible].sort((a, b) => a - b); const elMed = el.length ? el[el.length >> 1] : 0; const short = perDayEligible.filter((x) => x < K).length;
  const bull = picks.filter((r) => r.reg === "bull"), bear = picks.filter((r) => r.reg === "bear");
  const blk = [0, 1, 2, 3].map((b) => f1(cut(picks.filter((r) => r.blk === b)).med)).join(" ");
  return `${label.padEnd(30)}|${String(c.n).padStart(5)} ${f1(c.med).padStart(5)}/${f0(c.win)} 절${f1(c.trim).padStart(5)} |ex${f1(ex.med).padStart(5)} 절대${f1(d.med).padStart(5)} d5${f1(d5.med).padStart(5)} |하위10% ${f1(botMean).padStart(5)} -10%↓ ${f0(crashPct).padStart(2)}% |강${c3(bull)} 약${c3(bear)} |${blk} |고유 ${String(uniq).padStart(3)} 반복 ${f0((100 * rep) / Math.max(1, tot)).padStart(2)}% |후보/일 중앙 ${String(elMed).padStart(3)} 부족일 ${short}`;
}
const HEAD = `${"집합".padEnd(30)}|    n  exs20/승  절사 |ex20   절대d20  exs5 |하방          |강세장  약세장 |블록1 2 3 4 |고유종목·연속반복 |하루 후보 수`;

/* ---------- 채점 · 상위 K ---------- */
const clone = (o: any) => JSON.parse(JSON.stringify(o));
function withChecks(cfg: any, patch: Record<string, any>, top: any = {}) { const c = clone(cfg); Object.assign(c, top); for (const k of Object.keys(patch)) { const i = c.checks.findIndex((x: any) => x.key === k); if (i >= 0) { Object.assign(c.checks[i], patch[k]); if (patch[k].regime === null) delete c.checks[i].regime; } } return c; }
interface Scored { s: S; score: number; level: string; low: boolean }
function scoreAll(cfg: any): Scored[] { const r = regimeMap(S, cfg); return S.map((s) => { const x = scoreFeat(s, cfg, r.get(s.date)); return x ? { s, score: x.score, level: x.level, low: x.low } : null; }).filter((x): x is Scored => x !== null); }
/** 후보 = 탈락(빨강)·덜 잼 제외. 순위 = 점수 → 외인 시총대비 */
function topK(rows: Scored[], K: number, eligible: (x: Scored) => boolean, key: (x: Scored) => number = (x) => x.score) {
  const byD = new Map<string, Scored[]>(); for (const x of rows) if (eligible(x)) (byD.get(x.s.date) ?? byD.set(x.s.date, []).get(x.s.date)!).push(x);
  const picks: S[] = []; const perDay: number[] = [];
  for (const d of dates) { const list = (byD.get(d) ?? []).sort((a, b) => key(b) - key(a) || (rawOf(b.s, FGN, base) ?? -9) - (rawOf(a.s, FGN, base) ?? -9)); perDay.push(list.length); for (const x of list.slice(0, K)) picks.push(x.s); }
  return { picks, perDay };
}
const FGN = base.checks.find((c: any) => c.key === "fgnRatio20");
const notRed = (x: Scored) => x.level !== "red" && !x.low;
const isGreen = (x: Scored) => x.level === "green";

P(`표본 ${S.length} · ${dates.length}일 · 강세 ${dates.filter((d) => reg.get(d) === "bull").length}일 · 시총 중립 exs20. 상위 K = 날짜별 점수 순(탈락·덜 잼 제외).`);

/* ================= 1. 구조 A / B / C ================= */
P("\n## 1. 구조 — 같은 하루 K개로 견준다");
const A = scoreAll(base);
const greenPerDay = dates.map((d) => A.filter((x) => x.s.date === d && isGreen(x)).length);
P(`세대 3 초록/일: 중앙 ${[...greenPerDay].sort((a, b) => a - b)[40]} · 최소 ${Math.min(...greenPerDay)} · 최대 ${Math.max(...greenPerDay)} · 0개인 날 ${greenPerDay.filter((x) => x === 0).length}`);
for (const K of [10, 20, 40]) {
  P(`\n### K = ${K}`); P(HEAD);
  { const { picks, perDay } = topK(A, K, notRed); P(topKLine(`A 세대3 점수 순`, picks, K, perDay)); }
  { const { picks, perDay } = topK(A, K, (x) => isGreen(x)); P(topKLine(`A 세대3 초록 안에서만`, picks, K, perDay)); }
  { const { picks, perDay } = topK(A, K, (x) => notRed(x) && !alert(x.s)); P(topKLine(`C 세대3 − 경보 → 점수 순`, picks, K, perDay)); }
  { const { picks, perDay } = topK(A, K, (x) => isGreen(x) && !alert(x.s)); P(topKLine(`C 초록 − 경보`, picks, K, perDay)); }
  /* B: 거르개(탈락 둘 + 경보) 뒤 한 축 순위 — 점수 없음 */
  const tent = (x: Scored) => { const v = rawOf(x.s, FGN, base); if (v === null) return -99; return v <= 1 ? v : 1 - (v - 1); };
  const vetoOK = (x: Scored) => x.level !== "red"; // 세대 3 탈락(시총대비 -1↓·적자)만
  { const { picks, perDay } = topK(A, K, (x) => vetoOK(x) && !alert(x.s), tent); P(topKLine(`B 탈락+경보 거르고 외인시총대비 순`, picks, K, perDay)); }
  { const { picks, perDay } = topK(A, K, (x) => vetoOK(x) && !alert(x.s), (x) => (rawOf(x.s, base.checks.find((c: any) => c.key === "flowPersist"), base) ?? -1) * 10 + Math.max(-1, Math.min(2, tent(x)))); P(topKLine(`B 〃 수급지속→외인시총대비 순`, picks, K, perDay)); }
  { const { picks, perDay } = topK(A, K, (x) => vetoOK(x) && !alert(x.s), (x) => -(x.s.turnover ?? 99)); P(topKLine(`B 〃 회전율 낮은 순`, picks, K, perDay)); }
  { const { picks, perDay } = topK(A, K, () => true, () => Math.random()); P(topKLine(`무작위 (기준선)`, picks, K, perDay)); }
  { const { picks, perDay } = topK(A, K, (x) => !alert(x.s), () => Math.random()); P(topKLine(`경보만 빼고 무작위`, picks, K, perDay)); }
}

/* ================= 2. 단조성 ================= */
P("\n## 2. 점수 단조성 (세대 3, 탈락·덜 잼 제외)");
P(`${"구간".padEnd(10)}|    n  exs20/승 |강세    약세   |앞     뒤     |블록1 2 3 4`);
for (const [lo, hi] of [[0, 45], [45, 55], [55, 65], [65, 75], [75, 85], [85, 101]]) {
  const rows = A.filter((x) => notRed(x) && x.score >= lo && x.score < hi).map((x) => x.s);
  P(`${`${lo}~${hi - 1}`.padEnd(10)}|${String(rows.length).padStart(5)} ${c3(rows)} |${c3(rows.filter((r) => r.reg === "bull"))} ${c3(rows.filter((r) => r.reg === "bear"))} |${c3(rows.filter((r) => r.half === "F"))} ${c3(rows.filter((r) => r.half === "B"))} |${[0, 1, 2, 3].map((b) => f1(cut(rows.filter((r) => r.blk === b)).med)).join(" ")}`);
}

/* ================= 3. 강건성 ================= */
P("\n## 3. 강건성 — K=20 점수 순(탈락·덜 잼 제외) 기준. 세대 3 대비 exs20 중앙/승률과 초록 수");
function evalCfgLine(label: string, cfg: any) {
  const R = scoreAll(cfg); const g = R.filter(isGreen).length;
  const { picks, perDay } = topK(R, 20, notRed); const c = cut(picks); const b = cut(picks.filter((r) => r.reg === "bull")), e = cut(picks.filter((r) => r.reg === "bear"));
  const blk = [0, 1, 2, 3].map((k) => f1(cut(picks.filter((r) => r.blk === k)).med)).join(" ");
  const gd = R.filter((x) => isGreen(x) && !alert(x.s)).map((x) => x.s); const gc = cut(gd);
  P(`${label.padEnd(34)}|K20 ${f1(c.med).padStart(5)}/${f0(c.win)} 강${f1(b.med).padStart(5)} 약${f1(e.med).padStart(5)} |${blk} |초록 ${String(g).padStart(4)} (${(g / dates.length).toFixed(0)}/일) 초록−경보 ${f1(gc.med)}/${f0(gc.win)} n${gc.n} |부족일 ${perDay.filter((x) => x < 20).length}`);
}
evalCfgLine("세대 3", base);
P("-- 무게 둔감성");
evalCfgLine("무게 전부 1 (실적 탈락 0 유지)", withChecks(base, Object.fromEntries(base.checks.filter((c: any) => c.enabled && c.weight > 0).map((c: any) => [c.key, { weight: 1 }]))));
evalCfgLine("축 무게 1/1/1", withChecks(base, {}, { axisWeights: { trend: 1, flow: 1, value: 1 } }));
evalCfgLine("무게 1 + 축 1/1/1", withChecks(base, Object.fromEntries(base.checks.filter((c: any) => c.enabled && c.weight > 0).map((c: any) => [c.key, { weight: 1 }])), { axisWeights: { trend: 1, flow: 1, value: 1 } }));
P("-- 문턱 민감도 (켜진 기준 전부의 50점·100점·상한을 한꺼번에)");
for (const f of [0.8, 1.2]) {
  const patch: Record<string, any> = {};
  for (const c of base.checks) if (c.enabled) patch[c.key] = { threshold: Math.round(c.threshold * f * 1000) / 1000, strongAt: Math.round(c.strongAt * f * 1000) / 1000, ...(c.capAt !== undefined ? { capAt: Math.round(c.capAt * f * 1000) / 1000 } : {}) };
  /* 신고가·매물·이격은 %눈금이라 ±20%가 뜻이 다르다 — 그래도 같은 규칙으로 흔든다 */
  evalCfgLine(`문턱 ×${f}`, withChecks(base, patch));
}
P("-- 문턱 민감도 (기준 하나씩 ±20%)");
for (const c of base.checks) if (c.enabled && c.weight > 0) for (const f of [0.8, 1.2]) evalCfgLine(`  ${c.key} ×${f}`, withChecks(base, { [c.key]: { threshold: c.threshold * f, strongAt: c.strongAt * f, ...(c.capAt !== undefined ? { capAt: c.capAt * f } : {}) } }));
P("-- 장세");
evalCfgLine("장세 전환 끔", withChecks(base, {}, { regimeSwitch: false }));
evalCfgLine("bullAt 40", withChecks(base, {}, { bullAt: 40 }));
evalCfgLine("bullAt 60", withChecks(base, {}, { bullAt: 60 }));
P("-- 초록 문턱");
for (const g of [55, 60, 65, 70, 75]) evalCfgLine(`greenAt ${g}`, withChecks(base, {}, { greenAt: g }));

/* ================= 4. leave-one-out · 최소 집합 ================= */
P("\n## 4. leave-one-out (K=20 점수 순 · 초록−경보)");
evalCfgLine("세대 3", base);
for (const c of base.checks) if (c.enabled) evalCfgLine(`− ${c.key}${c.weight ? "" : "(탈락)"}`, withChecks(base, { [c.key]: { enabled: false, veto: false } }));
P("\n## 5. 뒤에서 하나씩 빼기 — K=20 exs20 중앙값이 가장 덜 떨어지는 것부터 뺀다");
let cur = clone(base); let on = base.checks.filter((c: any) => c.enabled).map((c: any) => c.key);
const k20 = (cfg: any) => { const R = scoreAll(cfg); const { picks } = topK(R, 20, notRed); const c = cut(picks); return { med: c.med, win: c.win, n: c.n }; };
let curScore = k20(cur); P(`시작 ${on.length}개: K20 ${f1(curScore.med)}/${f0(curScore.win)}`);
while (on.length > 3) {
  let best: { key: string; med: number; win: number } | null = null;
  for (const k of on) { const t = k20(withChecks(cur, { [k]: { enabled: false, veto: false } })); if (!best || t.med > best.med) best = { key: k, med: t.med, win: t.win }; }
  if (!best) break;
  P(`  − ${best.key.padEnd(16)} → ${on.length - 1}개  K20 ${f1(best.med)}/${f0(best.win)}  (Δ ${f1(best.med - curScore.med)})`);
  cur = withChecks(cur, { [best.key]: { enabled: false, veto: false } }); on = on.filter((k: string) => k !== best!.key); curScore = { ...curScore, med: best.med, win: best.win };
}

/* ================= 6. 겹침 ================= */
P("\n## 6. 겹침 — 켜진 기준 등급(0/50/100) 상관 (|r| ≥ 0.3 만)");
const en = base.checks.filter((c: any) => c.enabled && c.weight > 0);
const G = en.map((c: any) => S.map((s) => gradeOf(s, c, base)));
const corr = (a: (number | null)[], b: (number | null)[]) => { const xs: number[] = [], ys: number[] = []; for (let i = 0; i < a.length; i++) if (a[i] !== null && b[i] !== null) { xs.push(a[i]!); ys.push(b[i]!); } if (xs.length < 100) return NaN; const mx = xs.reduce((p, q) => p + q, 0) / xs.length, my = ys.reduce((p, q) => p + q, 0) / ys.length; let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < xs.length; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; } return sxy / Math.sqrt(sxx * syy); };
for (let i = 0; i < en.length; i++) for (let j = i + 1; j < en.length; j++) { const r = corr(G[i], G[j]); if (Math.abs(r) >= 0.3) P(`  ${en[i].key} × ${en[j].key}  r=${r.toFixed(2)}`); }
P("  (그 밖은 |r| < 0.3)");

/* ================= 7. 탈락 · 경보 · 점수 ================= */
P("\n## 7. 경보 하나씩 — 세대 3 K=20 에서 그 경보만 뺐을 때 (탈락 후보인가)");
const ALERTS: [string, (s: S) => boolean, "always" | "bear"][] = [["회전율≥3%", (s) => s.turnover >= 3, "always"], ["진폭≥12%", (s) => s.range >= 12, "always"], ["거래량≥2.5배", (s) => s.volRatio >= 2.5, "always"], ["갭≥3%", (s) => s.gap >= 3, "always"], ["σ≥7%", (s) => s.volat20 >= 7, "always"], ["RS20≥20", (s) => s.rs20 >= 20, "bear"], ["RS60≥30", (s) => s.rs60 >= 30, "bear"], ["저점+50%↑", (s) => s.lo60Pct >= 150, "bear"]];
{ const { picks, perDay } = topK(A, 20, notRed); P(HEAD); P(topKLine("세대 3 K20", picks, 20, perDay)); }
for (const [name, fn, when] of ALERTS) {
  const inK = topK(A, 20, notRed).picks.filter((s) => (when === "always" || s.reg === "bear") && fn(s));
  const { picks, perDay } = topK(A, 20, (x) => notRed(x) && !((when === "always" || x.s.reg === "bear") && fn(x.s)));
  P(topKLine(`− ${name}${when === "bear" ? "(약세)" : ""} (K20 안 ${inK.length}: ${c3(inK)})`, picks, 20, perDay));
}
writeFileSync(HERE + "/sigtune-6.txt", out.join("\n"), "utf-8");
