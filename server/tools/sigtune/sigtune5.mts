/**
 * 5부 — 「후보 추리기」: 세대 3 초록에서 경보(뜨거움)를 빼면, 조용한 초입과 겹치면 얼마나 남고 얼마나 좋아지나.
 * 실행: server 에서  npx tsx tools/sigtune/sigtune5.mts
 */
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";

const SRC = dirname(fileURLToPath(import.meta.url)) + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);
const { loadSamples, scoreFeat } = await imp("signalSamples.ts");
const { regimeMap } = await imp("signalSimulate.ts");
const { getConfig } = await imp("signalLight.ts");
const { loadFinanceCache, profitAt, quarterAt } = await imp("financeCache.ts");
const { loadCloses } = await imp("dailyCloses.ts");

type S = any;
const file = await loadSamples();
const S: S[] = file.samples;
const cfg = await getConfig();
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
  const ret = (k: number) => (c(k) > 0 ? ((c(0) - c(k)) / c(k)) * 100 : null);
  s.ret20 = ret(20); s.ret60 = ret(60);
  const v20 = bs.slice(i - 20, i).reduce((a: number, b: any) => a + b.v, 0) / 20;
  s.volRatio = v20 > 0 ? bs[i].v / v20 : null;
  s.turnover = s.mktCap && s.volEok !== null ? (s.volEok / s.mktCap) * 100 : null;
  const lr: number[] = []; for (let k = 19; k >= 0; k--) { const a = c(k + 1), b = c(k); if (a > 0 && b > 0) lr.push(Math.log(b / a)); }
  const mean = lr.reduce((a, b) => a + b, 0) / lr.length;
  s.volat20 = lr.length >= 15 ? Math.sqrt(lr.reduce((a, b) => a + (b - mean) ** 2, 0) / lr.length) * 100 : null;
  const lo60 = Math.min(...bs.slice(i - 60, i).map((b: any) => b.l));
  s.lo60Pct = lo60 > 0 ? (c(0) / lo60) * 100 : null;
  s.gap = c(1) > 0 ? ((bs[i].o - c(1)) / c(1)) * 100 : null;
  s.range = bs[i].l > 0 ? ((bs[i].h - bs[i].l) / bs[i].l) * 100 : null;
}
const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
const med = (a: number[]) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
for (const [, rows] of byDate) {
  const wc = rows.filter((r) => r.mktCap !== null).sort((a, b) => a.mktCap - b.mktCap);
  wc.forEach((r, i) => { r.q = Math.min(4, Math.floor((i * 5) / wc.length)); });
  const qMed = [0, 1, 2, 3, 4].map((q) => med(wc.filter((r) => r.q === q).map((r) => r.d20).filter((v): v is number => v !== null)));
  const m20 = med(rows.map((r) => r.ret20).filter((v): v is number => v != null)), m60 = med(rows.map((r) => r.ret60).filter((v): v is number => v != null));
  for (const r of rows) { r.exs20 = r.d20 === null || r.q === undefined ? null : r.d20 - qMed[r.q]; r.rs20 = r.ret20 == null ? null : r.ret20 - m20; r.rs60 = r.ret60 == null ? null : r.ret60 - m60; }
}
const reg = regimeMap(S, cfg);
const dates = [...byDate.keys()].sort();
const f1 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(1) : " — ");
const cut = (rows: S[], key = "exs20") => { const v = rows.map((r) => r[key]).filter((x): x is number => x !== null && Number.isFinite(x)); if (!v.length) return "    —     "; return `${String(v.length).padStart(5)} ${f1(med(v)).padStart(5)}/${((100 * v.filter((x) => x > 0).length) / v.length).toFixed(0).padStart(2)}`; };
function row(label: string, rows: S[]) {
  const blk = [0, 1, 2, 3].map((b) => { const from = dates[b * 20], to = dates[Math.min(dates.length - 1, b * 20 + 19)]; const v = rows.filter((s) => s.date >= from && s.date <= to).map((r) => r.exs20).filter((x: any): x is number => x != null); return v.length >= 20 ? f1(med(v)).padStart(5) : "   — "; }).join(" ");
  const perDay = (rows.length / dates.length).toFixed(0);
  P(`${label.padEnd(44)}|${cut(rows)} |강${cut(rows.filter((s) => reg.get(s.date) === "bull"))} |약${cut(rows.filter((s) => reg.get(s.date) === "bear"))} | ${blk} | 절대${cut(rows, "d20").slice(5)} | 하루 ${perDay}`);
}
const HEAD = `${"집합".padEnd(44)}|    n  med/win |강세장          |약세장          | 블록1   2     3     4 | 절대 d20 | 하루 후보`;

const isGreen = new Map<S, boolean>();
for (const s of S) isGreen.set(s, scoreFeat(s, cfg, reg.get(s.date))?.level === "green");
const G = S.filter((s) => isGreen.get(s));

/* 경보(뜨거움) — 4부에서 ❌ 였던 구간. 못 재면 경보 아님 */
const ALERT: [string, (s: S) => boolean][] = [
  ["회전율 ≥3%", (s) => s.turnover != null && s.turnover >= 3],
  ["회전율 ≥1%", (s) => s.turnover != null && s.turnover >= 1],
  ["변동성 σ ≥5%", (s) => s.volat20 != null && s.volat20 >= 5],
  ["변동성 σ ≥7%", (s) => s.volat20 != null && s.volat20 >= 7],
  ["RS20 ≥20%p", (s) => s.rs20 != null && s.rs20 >= 20],
  ["RS20 ≥15%p", (s) => s.rs20 != null && s.rs20 >= 15],
  ["RS60 ≥30%p", (s) => s.rs60 != null && s.rs60 >= 30],
  ["60일 저점 대비 ≥150%", (s) => s.lo60Pct != null && s.lo60Pct >= 150],
  ["갭 ≥3%", (s) => s.gap != null && s.gap >= 3],
  ["진폭 ≥12%", (s) => s.range != null && s.range >= 12],
  ["진폭 ≥8%", (s) => s.range != null && s.range >= 8],
  ["거래량 ≥2.5배", (s) => s.volRatio != null && s.volRatio >= 2.5],
  ["거래량 <0.4배(죽음)", (s) => s.volRatio != null && s.volRatio < 0.4],
];
P(`표본 ${S.length} · 80일 · 세대 3 초록 ${G.length}`);
P("\n## A. 초록에서 경보를 하나씩 뺐을 때");
P(HEAD);
row("초록 그대로", G);
for (const [name, fn] of ALERT) row(`초록 − ${name}  (걸림 ${G.filter(fn).length})`, G.filter((s) => !fn(s)));

const SETS: [string, (s: S) => boolean][] = [
  ["세트 강: 회전율≥3 ∪ σ≥7 ∪ RS20≥20 ∪ 저점≥150 ∪ 갭≥3 ∪ 진폭≥12", (s) => (s.turnover >= 3) || (s.volat20 >= 7) || (s.rs20 >= 20) || (s.lo60Pct >= 150) || (s.gap >= 3) || (s.range >= 12)],
  ["세트 중: 회전율≥1 ∪ σ≥5 ∪ RS20≥15 ∪ RS60≥30 ∪ 저점≥150 ∪ 갭≥3 ∪ 진폭≥8 ∪ 거래량≥2.5", (s) => (s.turnover >= 1) || (s.volat20 >= 5) || (s.rs20 >= 15) || (s.rs60 >= 30) || (s.lo60Pct >= 150) || (s.gap >= 3) || (s.range >= 8) || (s.volRatio >= 2.5)],
];
const hot = (s: S) => (s.turnover >= 3) || (s.range >= 12) || (s.volRatio >= 2.5) || (s.gap >= 3) || (s.volat20 >= 7);
const late = (s: S) => (s.rs20 >= 20) || (s.rs60 >= 30) || (s.lo60Pct >= 150);
SETS.push(
  ["쏠림(회전율≥3 ∪ 진폭≥12 ∪ 거래량≥2.5 ∪ 갭≥3 ∪ σ≥7) — 늘", hot],
  ["늦음(RS20≥20 ∪ RS60≥30 ∪ 저점≥150) — 늘", late],
  ["쏠림 늘 + 늦음 약세장만", (s) => hot(s) || (reg.get(s.date) === "bear" && late(s))],
  ["쏠림(빡빡: 회전율≥1 ∪ 진폭≥8 ∪ 거래량≥2.5 ∪ 갭≥3 ∪ σ≥5) 늘 + 늦음 약세장만", (s) => (s.turnover >= 1) || (s.range >= 8) || (s.volRatio >= 2.5) || (s.gap >= 3) || (s.volat20 >= 5) || (reg.get(s.date) === "bear" && late(s))],
);
P("\n## B. 초록에서 경보 세트를 뺐을 때 / 전체 표본에 경보만 걸었을 때");
P(HEAD);
for (const [name, fn] of SETS) { row(`초록 − ${name}`, G.filter((s) => !fn(s))); row(`전체 − 같은 세트 (신호등 없이)`, S.filter((s) => !fn(s))); }

const CALM: [string, (s: S) => boolean][] = [
  ["조용한 초입: 회전율<1 & σ<4 & RS20 -5~15 & 거래량 0.6~2배", (s) => s.turnover < 1 && s.volat20 < 4 && s.rs20 >= -5 && s.rs20 < 15 && s.volRatio >= 0.6 && s.volRatio < 2],
  ["조용한 초입(느슨): 회전율<2 & σ<5 & RS20 -10~20", (s) => s.turnover < 2 && s.volat20 < 5 && s.rs20 >= -10 && s.rs20 < 20],
  ["저점 근처: 60일 저점 +25% 안 & RS20 -5~10", (s) => s.lo60Pct < 125 && s.rs20 >= -5 && s.rs20 < 10],
];
P("\n## C. 조용한 초입 조건과 겹치기 (초록 ∩ / 신호등 없이 조건만)");
P(HEAD);
for (const [name, fn] of CALM) { row(`초록 ∩ ${name}`, G.filter(fn)); row(`전체 ∩ 같은 조건 (신호등 없이)`, S.filter(fn)); }
writeFileSync(dirname(fileURLToPath(import.meta.url)) + "/sigtune-5.txt", out.join("\n"), "utf-8");
