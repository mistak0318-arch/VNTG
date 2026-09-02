/**
 * 7부 — 최소 집합·구조 확정 검증 (6부의 후보를 정직하게 다시 잰다)
 *   · 후보 집합들을 K=10/20/40 전체 지표로
 *   · 뒤에서 빼기를 **앞 절반에서만 골라 뒤 절반에서 채점** (반대도) — in-sample 이 아닌 답
 *   · 경보 → 탈락 승격 실험
 *   · 고른 집합의 leave-one-out · 민감도
 * 실행: server 에서  npx tsx tools/sigtune/sigtune7.mts
 */
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = HERE + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);
const { loadSamples, scoreFeat, rawOf } = await imp("signalSamples.ts");
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
const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
const med = (a: number[]) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
const nn = (a: (number | null | undefined)[]) => a.filter((v): v is number => v != null && Number.isFinite(v));
for (const [, rows] of byDate) {
  const wc = rows.filter((r) => r.mktCap !== null).sort((a, b) => a.mktCap - b.mktCap);
  wc.forEach((r, i) => { r.q = Math.min(4, Math.floor((i * 5) / wc.length)); });
  const qMed = [0, 1, 2, 3, 4].map((q) => med(nn(wc.filter((r) => r.q === q).map((r) => r.d20))));
  const m20 = med(nn(rows.map((r) => r.d20))), r20 = med(nn(rows.map((r) => r.ret20))), r60 = med(nn(rows.map((r) => r.ret60)));
  for (const r of rows) { r.exs20 = r.d20 === null || r.q === undefined ? null : r.d20 - qMed[r.q]; r.ex20 = r.d20 === null ? null : r.d20 - m20; r.rs20 = r.ret20 == null ? null : r.ret20 - r20; r.rs60 = r.ret60 == null ? null : r.ret60 - r60; }
}
const reg = regimeMap(S, base);
const dates = [...byDate.keys()].sort();
const mid = dates[Math.floor(dates.length / 2)];
for (const s of S) { s.reg = reg.get(s.date) ?? "?"; s.half = s.date < mid ? "F" : "B"; s.blk = Math.min(3, Math.floor(dates.indexOf(s.date) / 20)); }
const hot = (s: S) => s.turnover >= 3 || s.range >= 12 || s.volRatio >= 2.5 || s.gap >= 3 || s.volat20 >= 7;
const late = (s: S) => s.rs20 >= 20 || s.rs60 >= 30 || s.lo60Pct >= 150;
const alert = (s: S) => hot(s) || (s.reg === "bear" && late(s));
/* 탈락 승격 후보 (6부 7절: 상위 K 안에서도 마이너스였던 것) */
const hardKill = (s: S) => s.volat20 >= 7 || s.range >= 12 || (s.reg === "bear" && (s.rs60 >= 30 || s.lo60Pct >= 150));
const softAlert = (s: S) => s.turnover >= 3 || s.volRatio >= 2.5 || s.gap >= 3 || (s.reg === "bear" && s.rs20 >= 20);

const f1 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(1) : "  — ");
const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : "—");
function cut(rows: S[], key = "exs20") { const v = nn(rows.map((r) => r[key])); if (!v.length) return { n: 0, med: NaN, win: NaN }; return { n: v.length, med: med(v), win: (100 * v.filter((x) => x > 0).length) / v.length }; }
const c3 = (rows: S[], key = "exs20") => { const c = cut(rows, key); return `${f1(c.med).padStart(5)}/${f0(c.win).padStart(2)}`; };
function line(label: string, picks: S[], K: number, perDay: number[]) {
  const c = cut(picks), ex = cut(picks, "ex20"), d = cut(picks, "d20");
  const v = nn(picks.map((r) => r.exs20)).sort((a, b) => a - b); const bot = v.slice(0, Math.max(1, Math.floor(v.length * 0.1))); const botMean = bot.length ? bot.reduce((a, b) => a + b, 0) / bot.length : NaN;
  const crash = nn(picks.map((r) => r.d20)); const crashPct = crash.length ? (100 * crash.filter((x) => x <= -10).length) / crash.length : NaN;
  const uniq = new Set(picks.map((r) => r.code)).size;
  const blk = [0, 1, 2, 3].map((b) => f1(cut(picks.filter((r) => r.blk === b)).med)).join(" ");
  const el = [...perDay].sort((a, b) => a - b); const short = perDay.filter((x) => x < K).length;
  return `${label.padEnd(36)}|${String(c.n).padStart(5)} ${f1(c.med).padStart(5)}/${f0(c.win)} |ex${f1(ex.med).padStart(5)} 절대${f1(d.med).padStart(5)} |하위10% ${f1(botMean).padStart(5)} -10%↓ ${f0(crashPct).padStart(2)}% |강${c3(picks.filter((r) => r.reg === "bull"))} 약${c3(picks.filter((r) => r.reg === "bear"))} |앞${c3(picks.filter((r) => r.half === "F"))} 뒤${c3(picks.filter((r) => r.half === "B"))} |${blk} |고유 ${String(uniq).padStart(3)} |후보/일 ${String(el[el.length >> 1] ?? 0).padStart(3)} 부족 ${short}`;
}
const HEAD = `${"집합".padEnd(36)}|    n  exs20/승 |ex20   절대d20 |하방            |강세장  약세장 |앞      뒤     |블록1 2 3 4 |고유 |하루 후보`;

const clone = (o: any) => JSON.parse(JSON.stringify(o));
function cfgOf(keys: string[], opts: { w1?: boolean; axis1?: boolean; extra?: Record<string, any>; top?: any } = {}) {
  const c = clone(base);
  for (const x of c.checks) { const on = keys.includes(x.key); x.enabled = on; if (!on) x.veto = false; if (opts.w1 && on && x.weight > 0) x.weight = 1; }
  if (opts.axis1) c.axisWeights = { trend: 1, flow: 1, value: 1 };
  for (const k of Object.keys(opts.extra ?? {})) { const i = c.checks.findIndex((x: any) => x.key === k); if (i >= 0) { Object.assign(c.checks[i], opts.extra![k]); if (opts.extra![k].regime === null) delete c.checks[i].regime; } }
  Object.assign(c, opts.top ?? {});
  return c;
}
interface Scored { s: S; score: number; level: string; low: boolean }
function scoreAll(cfg: any): Scored[] { const r = regimeMap(S, cfg); return S.map((s) => { const x = scoreFeat(s, cfg, r.get(s.date)); return x ? { s, score: x.score, level: x.level, low: x.low } : null; }).filter((x): x is Scored => x !== null); }
const FGN = base.checks.find((c: any) => c.key === "fgnRatio20");
function topK(rows: Scored[], K: number, eligible: (x: Scored) => boolean, onlyDates?: string[]) {
  const byD = new Map<string, Scored[]>(); for (const x of rows) if (eligible(x)) (byD.get(x.s.date) ?? byD.set(x.s.date, []).get(x.s.date)!).push(x);
  const picks: S[] = []; const perDay: number[] = [];
  for (const d of onlyDates ?? dates) { const list = (byD.get(d) ?? []).sort((a, b) => b.score - a.score || (rawOf(b.s, FGN, base) ?? -9) - (rawOf(a.s, FGN, base) ?? -9)); perDay.push(list.length); for (const x of list.slice(0, K)) picks.push(x.s); }
  return { picks, perDay };
}
const notRed = (x: Scored) => x.level !== "red" && !x.low;
const ALL = base.checks.filter((c: any) => c.enabled).map((c: any) => c.key) as string[];

/* ================= 1. 후보 집합 ================= */
const SETS: [string, string[], any][] = [
  ["세대 3 (11개)", ALL, {}],
  ["세대 3 · 무게1 · 축1/1/1", ALL, { w1: true, axis1: true }],
  ["S9 = 세대3 − fgnRatio20 − overhead", ALL.filter((k) => !["fgnRatio20", "overhead"].includes(k)), { w1: true, axis1: true }],
  ["S7 = S9 − flowPersist − flowAccel", ALL.filter((k) => !["fgnRatio20", "overhead", "flowPersist", "flowAccel"].includes(k)), { w1: true, axis1: true }],
  ["S7b = S7 + fgnRatio20(w1) − foreignRatioUp", ["newHigh", "flowRatio", "fgnRatio20", "shortLevel", "qYoY", "qMargin", "ma5Gap"], { w1: true, axis1: true }],
  ["S6 = S7 − shortLevel", ["newHigh", "flowRatio", "foreignRatioUp", "qYoY", "qMargin", "ma5Gap"], { w1: true, axis1: true }],
  ["S5 = S6 − ma5Gap", ["newHigh", "flowRatio", "foreignRatioUp", "qYoY", "qMargin"], { w1: true, axis1: true }],
  ["S7 + 정배열(강세 w1)", [...ALL.filter((k) => !["fgnRatio20", "overhead", "flowPersist", "flowAccel"].includes(k)), "trend"], { w1: true, axis1: true, extra: { trend: { regime: "bull" } } }],
  ["S7 + 수급지속(w1)", [...ALL.filter((k) => !["fgnRatio20", "overhead", "flowAccel"].includes(k))], { w1: true, axis1: true }],
];
P(`표본 ${S.length} · ${dates.length}일 · 상위 K = 날짜별 점수 순(탈락·덜 잼 제외). 무게1 = 켜진 기준 무게 전부 1(탈락 전용 0 유지)`);
for (const K of [10, 20, 40]) {
  P(`\n## 1. 후보 집합 · K = ${K}`); P(HEAD);
  for (const [name, keys, opts] of SETS) {
    const R = scoreAll(cfgOf(keys, opts));
    const a = topK(R, K, notRed); P(line(`A ${name}`, a.picks, K, a.perDay));
    const c = topK(R, K, (x) => notRed(x) && !alert(x.s)); P(line(`C 〃 −경보`, c.picks, K, c.perDay));
  }
}

/* ================= 2. 정직한 뒤에서 빼기 — 한쪽에서 고르고 반대쪽에서 채점 ================= */
P("\n## 2. 뒤에서 빼기를 앞/뒤 절반으로 나눠서 (고른 쪽 → 반대쪽 채점, K=20, 무게1·축1/1/1)");
const k20 = (keys: string[], onlyDates: string[]) => { const R = scoreAll(cfgOf(keys, { w1: true, axis1: true })); const { picks } = topK(R, 20, notRed, onlyDates); return cut(picks); };
const F = dates.filter((d) => d < mid), B = dates.filter((d) => d >= mid);
for (const [trainName, train, test, testName] of [["앞 절반", F, B, "뒤 절반"], ["뒤 절반", B, F, "앞 절반"]] as [string, string[], string[], string][]) {
  let on = [...ALL]; let cur = k20(on, train);
  P(`-- ${trainName}에서 고른다. 시작 11개: ${trainName} ${f1(cur.med)}/${f0(cur.win)} → ${testName} ${c3(topK(scoreAll(cfgOf(on, { w1: true, axis1: true })), 20, notRed, test).picks)}`);
  while (on.length > 4) {
    let best: { key: string; med: number; win: number } | null = null;
    for (const k of on) { const t = k20(on.filter((x) => x !== k), train); if (!best || t.med > best.med) best = { key: k, med: t.med, win: t.win }; }
    if (!best) break;
    on = on.filter((k) => k !== best!.key);
    const t = topK(scoreAll(cfgOf(on, { w1: true, axis1: true })), 20, notRed, test).picks;
    P(`   − ${best.key.padEnd(15)} → ${on.length}개  ${trainName} ${f1(best.med)}/${f0(best.win)}  |  ${testName} ${c3(t)}  ${on.length <= 8 ? "[" + on.join(" ") + "]" : ""}`);
    cur = { ...cur, med: best.med, win: best.win };
  }
}

/* ================= 3. 경보 → 탈락 승격 ================= */
P("\n## 3. 경보를 어디까지 탈락으로 올리나 (S7, K=20)");
P(HEAD);
const R7 = scoreAll(cfgOf(SETS[3][1], { w1: true, axis1: true }));
{ const a = topK(R7, 20, notRed); P(line("S7 그대로", a.picks, 20, a.perDay)); }
{ const a = topK(R7, 20, (x) => notRed(x) && !hardKill(x.s)); P(line("S7 − 탈락승격(σ7·진폭12·약세RS60·저점150)", a.picks, 20, a.perDay)); }
{ const a = topK(R7, 20, (x) => notRed(x) && !hardKill(x.s) && !softAlert(x.s)); P(line("S7 − 탈락승격 − 나머지 경보", a.picks, 20, a.perDay)); }
{ const a = topK(R7, 20, (x) => notRed(x) && !alert(x.s)); P(line("S7 − 경보 전부 (=C)", a.picks, 20, a.perDay)); }
for (const K of [10, 40]) { const a = topK(R7, K, (x) => notRed(x) && !hardKill(x.s)); P(line(`S7 − 탈락승격 · K=${K}`, a.picks, K, a.perDay)); }

/* ================= 4. S7 의 leave-one-out · 민감도 ================= */
P("\n## 4. S7 leave-one-out (K=20 · 탈락승격 적용)");
const S7 = SETS[3][1];
const evalS = (label: string, keys: string[], extra?: Record<string, any>) => { const R = scoreAll(cfgOf(keys, { w1: true, axis1: true, extra })); const a = topK(R, 20, (x) => notRed(x) && !hardKill(x.s)); const g = R.filter((x) => x.level === "green").length; P(`${label.padEnd(30)}|K20 ${c3(a.picks)} 강${c3(a.picks.filter((r) => r.reg === "bull"))} 약${c3(a.picks.filter((r) => r.reg === "bear"))} 앞${c3(a.picks.filter((r) => r.half === "F"))} 뒤${c3(a.picks.filter((r) => r.half === "B"))} |${[0, 1, 2, 3].map((b) => f1(cut(a.picks.filter((r) => r.blk === b)).med)).join(" ")} |초록 ${(g / dates.length).toFixed(0)}/일 부족 ${a.perDay.filter((x) => x < 20).length}`); };
evalS("S7", S7);
for (const k of S7) evalS(`− ${k}`, S7.filter((x) => x !== k));
P("-- S7 민감도");
for (const k of S7) for (const f of [0.8, 1.2]) { const c = base.checks.find((x: any) => x.key === k); if (!c || c.weight === 0) continue; evalS(`  ${k} ×${f}`, S7, { [k]: { threshold: c.threshold * f, strongAt: c.strongAt * f, ...(c.capAt !== undefined ? { capAt: c.capAt * f } : {}) } }); }
evalS("장세 전환 끔", S7, undefined); // placeholder (below with top)
{ const R = scoreAll(cfgOf(S7, { w1: true, axis1: true, top: { regimeSwitch: false } })); const a = topK(R, 20, (x) => notRed(x) && !hardKill(x.s)); P(`${"장세 전환 끔 (실제)".padEnd(30)}|K20 ${c3(a.picks)} 강${c3(a.picks.filter((r) => r.reg === "bull"))} 약${c3(a.picks.filter((r) => r.reg === "bear"))}`); }
for (const g of [55, 60, 65, 70]) { const R = scoreAll(cfgOf(S7, { w1: true, axis1: true, top: { greenAt: g } })); const gr = R.filter((x) => x.level === "green"); const gk = gr.filter((x) => !hardKill(x.s)); P(`greenAt ${g}: 초록 ${(gr.length / dates.length).toFixed(0)}/일 ${c3(gr.map((x) => x.s))} · 탈락승격 뒤 ${(gk.length / dates.length).toFixed(0)}/일 ${c3(gk.map((x) => x.s))} · 거기서 경보 뺀 ${(gk.filter((x) => !softAlert(x.s)).length / dates.length).toFixed(0)}/일 ${c3(gk.filter((x) => !softAlert(x.s)).map((x) => x.s))}`); }

/* ================= 5. 점수 단조성 (S7) ================= */
P("\n## 5. S7 점수 단조성 (탈락·덜 잼·탈락승격 제외)");
for (const [lo, hi] of [[0, 45], [45, 55], [55, 65], [65, 75], [75, 85], [85, 101]]) { const rows = R7.filter((x) => notRed(x) && !hardKill(x.s) && x.score >= lo && x.score < hi).map((x) => x.s); P(`${`${lo}~${hi - 1}`.padEnd(8)}|${String(rows.length).padStart(5)} ${c3(rows)} |강${c3(rows.filter((r) => r.reg === "bull"))} 약${c3(rows.filter((r) => r.reg === "bear"))} |앞${c3(rows.filter((r) => r.half === "F"))} 뒤${c3(rows.filter((r) => r.half === "B"))}`); }
/* ================= 6. S9 — 정직한 후보의 마무리 ================= */
P("\n## 6. S9 (세대3 − overhead − fgnRatio20 · 무게1 · 축1/1/1) 마무리");
const S9 = SETS[2][1];
const S9cfg = cfgOf(S9, { w1: true, axis1: true });
const R9 = scoreAll(S9cfg);
for (const K of [10, 20, 40]) {
  P(`-- K = ${K}`); P(HEAD);
  { const a = topK(scoreAll(base), K, notRed); P(line("세대 3", a.picks, K, a.perDay)); }
  { const a = topK(scoreAll(base), K, (x) => notRed(x) && !hardKill(x.s)); P(line("세대 3 + 탈락승격", a.picks, K, a.perDay)); }
  { const a = topK(R9, K, notRed); P(line("S9", a.picks, K, a.perDay)); }
  { const a = topK(R9, K, (x) => notRed(x) && !hardKill(x.s)); P(line("S9 + 탈락승격", a.picks, K, a.perDay)); }
  { const a = topK(R9, K, (x) => notRed(x) && !hardKill(x.s) && !softAlert(x.s)); P(line("S9 + 탈락승격 − 나머지 경보", a.picks, K, a.perDay)); }
  { const a = topK(R9, K, (x) => x.level === "green" && !hardKill(x.s)); P(line("S9 초록 안에서 + 탈락승격", a.picks, K, a.perDay)); }
  { const R = scoreAll(cfgOf(S9, { w1: true, axis1: true, top: { regimeSwitch: false } })); const a = topK(R, K, (x) => notRed(x) && !hardKill(x.s)); P(line("S9 + 탈락승격 · 장세 전환 끔", a.picks, K, a.perDay)); }
  { const R = scoreAll(cfgOf([...S9, "trend"], { w1: true, axis1: true, extra: { trend: { regime: "bull" } } })); const a = topK(R, K, (x) => notRed(x) && !hardKill(x.s)); P(line("S9 + 정배열(강세) + 탈락승격", a.picks, K, a.perDay)); }
}
P("-- S9 leave-one-out (K=20 · 탈락승격)");
const evalS9 = (label: string, keys: string[], extra?: Record<string, any>, top?: any) => { const R = scoreAll(cfgOf(keys, { w1: true, axis1: true, extra, top })); const a = topK(R, 20, (x) => notRed(x) && !hardKill(x.s)); const g = R.filter((x) => x.level === "green").length; P(`${label.padEnd(28)}|K20 ${c3(a.picks)} 강${c3(a.picks.filter((r) => r.reg === "bull"))} 약${c3(a.picks.filter((r) => r.reg === "bear"))} 앞${c3(a.picks.filter((r) => r.half === "F"))} 뒤${c3(a.picks.filter((r) => r.half === "B"))} |${[0, 1, 2, 3].map((b) => f1(cut(a.picks.filter((r) => r.blk === b)).med)).join(" ")} |초록 ${(g / dates.length).toFixed(0)}/일`); };
evalS9("S9", S9);
for (const k of S9) evalS9(`− ${k}`, S9.filter((x) => x !== k));
P("-- S9 민감도 (±20%)");
for (const k of S9) for (const f of [0.8, 1.2]) { const c = base.checks.find((x: any) => x.key === k); if (!c || c.weight === 0) continue; evalS9(`  ${k} ×${f}`, S9, { [k]: { threshold: c.threshold * f, strongAt: c.strongAt * f, ...(c.capAt !== undefined ? { capAt: c.capAt * f } : {}) } }); }
evalS9("bullAt 40", S9, undefined, { bullAt: 40 }); evalS9("bullAt 60", S9, undefined, { bullAt: 60 });
P("-- S9 초록 문턱 (탈락승격 적용 뒤 하루 개수·성적)");
for (const g of [55, 60, 65, 70]) { const R = scoreAll(cfgOf(S9, { w1: true, axis1: true, top: { greenAt: g } })); const gr = R.filter((x) => x.level === "green"); const gk = gr.filter((x) => !hardKill(x.s)); const perDay = dates.map((d) => gk.filter((x) => x.s.date === d).length).sort((a, b) => a - b); P(`greenAt ${g}: 초록 ${(gr.length / dates.length).toFixed(0)}/일 ${c3(gr.map((x) => x.s))} → 탈락승격 뒤 ${(gk.length / dates.length).toFixed(0)}/일 (최소 ${perDay[0]} 중앙 ${perDay[perDay.length >> 1]} 최대 ${perDay[perDay.length - 1]}) ${c3(gk.map((x) => x.s))} 강${c3(gk.filter((x) => x.s.reg === "bull").map((x) => x.s))} 약${c3(gk.filter((x) => x.s.reg === "bear").map((x) => x.s))} · 경보까지 뺀 ${(gk.filter((x) => !softAlert(x.s)).length / dates.length).toFixed(0)}/일 ${c3(gk.filter((x) => !softAlert(x.s)).map((x) => x.s))}`); }
P("-- S9 점수 단조성 (탈락·덜 잼·탈락승격 제외)");
for (const [lo, hi] of [[0, 45], [45, 55], [55, 65], [65, 75], [75, 85], [85, 101]]) { const rows = R9.filter((x) => notRed(x) && !hardKill(x.s) && x.score >= lo && x.score < hi).map((x) => x.s); P(`${`${lo}~${hi - 1}`.padEnd(8)}|${String(rows.length).padStart(5)} ${c3(rows)} |강${c3(rows.filter((r) => r.reg === "bull"))} 약${c3(rows.filter((r) => r.reg === "bear"))} |앞${c3(rows.filter((r) => r.half === "F"))} 뒤${c3(rows.filter((r) => r.half === "B"))} |${[0, 1, 2, 3].map((b) => f1(cut(rows.filter((r) => r.blk === b)).med)).join(" ")}`); }
writeFileSync(HERE + "/sigtune-7.txt", out.join("\n"), "utf-8");
