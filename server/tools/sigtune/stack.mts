/**
 * 「다 좋은 애」는 정말 좋은가 — 좋은 조건 몇 개가 겹치나로 시총 중립 초과수익을 본다.
 * 실행: server 에서  npx tsx tools/sigtune/stack.mts
 */
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url)) + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);
const { loadSamples, MA_PERIODS } = await imp("signalSamples.ts");
const { regimeMap } = await imp("signalSimulate.ts");
const { getConfig } = await imp("signalLight.ts");
const { loadFinanceCache, profitAt, quarterAt } = await imp("financeCache.ts");

type S = any;
const file = await loadSamples();
const S: S[] = file.samples;
const cfg = await getConfig();
const fin = await loadFinanceCache();
for (const s of S) { const rec = fin[s.code]; if (!rec) continue; s.profitYoY = profitAt(rec, s.date); Object.assign(s, quarterAt(rec, s.date)); }
const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
const med = (a: number[]) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
for (const [, rows] of byDate) {
  const wc = rows.filter((r) => r.mktCap !== null).sort((a, b) => a.mktCap - b.mktCap);
  wc.forEach((r, i) => { r.q = Math.min(4, Math.floor((i * 5) / wc.length)); });
  const qMed = [0, 1, 2, 3, 4].map((q) => med(wc.filter((r) => r.q === q).map((r) => r.d20).filter((v): v is number => v !== null)));
  for (const r of rows) r.exs20 = r.d20 === null || r.q === undefined ? null : r.d20 - qMed[r.q];
}
const reg = regimeMap(S, cfg);
const cut = (rows: S[]) => { const v = rows.map((r) => r.exs20).filter((x): x is number => x !== null && Number.isFinite(x)); if (v.length < 30) return `${String(v.length).padStart(5)}    —   `; const tr = [...v].sort((a, b) => a - b); const k = Math.floor(tr.length * 0.02); const inner = k ? tr.slice(k, tr.length - k) : tr; return `${String(v.length).padStart(5)} ${med(v) >= 0 ? "+" : ""}${med(v).toFixed(1)}/${(inner.reduce((a, b) => a + b, 0) / inner.length).toFixed(1)}/${(100 * v.filter((x) => x > 0).length / v.length).toFixed(0)}`; };

/* 좋은 조건 — 재검토에서 ✅ 였던 구간. 못 재면 null(세지 않음) */
const COND: [string, (f: S) => boolean | null][] = [
  ["차트: 60일 고가의 85~99%", (f) => f.hiPct === null ? null : f.hiPct >= 85 && f.hiPct < 100],
  ["차트: 정배열(5≥20≥60)", (f) => { const v = [5, 20, 60].map((p) => f.ma[MA_PERIODS.indexOf(p)]); if (v.some((x: any) => x == null)) return null; return f.cur >= v[0] && v[0] >= v[1] && v[1] >= v[2]; }],
  ["차트: 5일선 이격 <8%", (f) => f.ma5Gap === null ? null : f.ma5Gap < 8],
  ["수급: 외인 시총대비 20일 0.25~1%", (f) => (f.fgn20 === null || !f.mktCap) ? null : (() => { const r = (f.fgn20 / 100 / f.mktCap) * 100; return r >= 0.25 && r < 1; })()],
  ["수급: 가속 1~2배", (f) => (f.fgn5 === null || f.fgn20 === null) ? null : (f.fgn20 > 0 ? (() => { const r = (f.fgn5 / 5) / (f.fgn20 / 20); return r >= 1 && r < 2; })() : false)],
  ["수급: 지속 ≥5구간", (f) => { const v = [f.fgn5, f.fgn10, f.fgn20, f.fgn60, f.inst5, f.inst10, f.inst20, f.inst60].filter((x) => x !== null); if (v.length < 4) return null; return v.filter((x: number) => x > 0).length >= 5; }],
  ["이익: 분기 YoY 0~50%", (f) => f.qYoY == null ? null : f.qYoY >= 0 && f.qYoY < 50],
  ["이익: 분기 흑자", (f) => f.qMargin == null ? null : f.qMargin > 0],
  ["공매도: 비중 ≥8%", (f) => f.short5 === null ? null : f.short5 >= 8],
  ["공매도: 식는 중(5일 < 이전 15일)", (f) => (f.short5 === null || f.short20 === null) ? null : f.short5 < f.short20],
  ["대차: 갚는 중(20일 -5%↓)", (f) => f.loanUp20 === null ? null : f.loanUp20 <= -5],
];
console.log("조건 하나씩 (시총 중립 exs20 · n 중앙/절사/승률) — 만족 vs 불만족");
console.log(`${"조건".padEnd(34)}| 만족                 | 불만족`);
for (const [name, fn] of COND) {
  const yes: S[] = [], no: S[] = [];
  for (const s of S) { const v = fn(s); if (v === null) continue; (v ? yes : no).push(s); }
  console.log(`${name.padEnd(34)}| ${cut(yes)} | ${cut(no)}`);
}
/* 겹침 — 재는 조건 중 몇 %를 만족하나 (못 재는 조건은 분모에서 뺀다) */
console.log("\n겹침 — 잰 조건 중 만족 비율 (같은 종목이 며칠씩 겹치니 n 은 관측 수)");
console.log(`${"만족 비율".padEnd(14)}| 전체                 | 강세장               | 약세장`);
const bands: [string, number, number][] = [["~30%", 0, 0.3], ["30~50%", 0.3, 0.5], ["50~70%", 0.5, 0.7], ["70~85%", 0.7, 0.85], ["85~100%", 0.85, 1.01]];
const ratio = (s: S) => { let y = 0, n = 0; for (const [, fn] of COND) { const v = fn(s); if (v === null) continue; n++; if (v) y++; } return n >= 7 ? y / n : null; };
for (const s of S) s.stack = ratio(s);
for (const [label, lo, hi] of bands) {
  const rows = S.filter((s) => s.stack !== null && s.stack >= lo && s.stack < hi);
  console.log(`${label.padEnd(14)}| ${cut(rows)} | ${cut(rows.filter((s) => reg.get(s.date) === "bull"))} | ${cut(rows.filter((s) => reg.get(s.date) === "bear"))}`);
}
/* 「전부」에 가장 가까운 것들 — 어떤 종목·날인가 */
const top = S.filter((s) => s.stack !== null && s.stack >= 0.85).sort((a, b) => b.stack - a.stack || (b.exs20 ?? -99) - (a.exs20 ?? -99));
console.log(`\n85% 이상 만족 ${top.length}관측 · 종목 ${new Set(top.map((s) => s.code)).size}개. 예:`);
for (const s of top.slice(0, 12)) console.log(`  ${s.date} ${s.name.padEnd(10)} 만족 ${(s.stack * 100).toFixed(0)}% · 20일 뒤 ${s.d20 >= 0 ? "+" : ""}${s.d20?.toFixed(1)}% (시총중립 ${s.exs20 >= 0 ? "+" : ""}${s.exs20?.toFixed(1)})`);
