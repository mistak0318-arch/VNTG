/**
 * 지금 기본값(getConfig) 위에 기준 하나씩 얹어 실전 채점기(scoreFeat)로 초록 성적을 견준다.
 * 실행: server 에서  npx tsx tools/sigtune/tryVariants.mts
 */
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url)) + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);
const { loadSamples, scoreFeat } = await imp("signalSamples.ts");
const { regimeMap } = await imp("signalSimulate.ts");
const { getConfig } = await imp("signalLight.ts");
const { loadFinanceCache, profitAt, quarterAt } = await imp("financeCache.ts");

type S = any;
const file = await loadSamples();
const S: S[] = file.samples;
const base = await getConfig();
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
const reg = regimeMap(S, base);
const dates = [...byDate.keys()].sort();
const mid = dates[Math.floor(dates.length / 2)];
const cut = (rows: S[]) => { const v = rows.map((r) => r.exs20).filter((x): x is number => x !== null && Number.isFinite(x)); if (!v.length) return "  —  "; return `${String(v.length).padStart(5)} ${med(v) >= 0 ? "+" : ""}${med(v).toFixed(1)}/${(100 * v.filter((x) => x > 0).length / v.length).toFixed(0)}`; };

const clone = (o: any) => JSON.parse(JSON.stringify(o));
function variant(patch: Record<string, any>) {
  const c = clone(base);
  for (const k of Object.keys(patch)) { const i = c.checks.findIndex((x: any) => x.key === k); if (i >= 0) { Object.assign(c.checks[i], patch[k]); if (patch[k].regime === null) delete c.checks[i].regime; } }
  return c;
}
const V: [string, any][] = [
  ["세대 3 그대로", base],
  ["+고점근접 85/90 cap100 w1 무관", variant({ nearHigh: { enabled: true, weight: 1, threshold: 85, strongAt: 90, capAt: 100, regime: null } })],
  ["+고점근접 80/85 cap95 w1 무관", variant({ nearHigh: { enabled: true, weight: 1, threshold: 80, strongAt: 85, capAt: 95, regime: null } })],
  ["+고점근접 85/90 cap100 w2 무관", variant({ nearHigh: { enabled: true, weight: 2, threshold: 85, strongAt: 90, capAt: 100, regime: null } })],
  ["+고점근접 85/90 cap100 w1 약세만", variant({ nearHigh: { enabled: true, weight: 1, threshold: 85, strongAt: 90, capAt: 100, regime: "bear" } })],
  ["+정배열 w1 무관", variant({ trend: { enabled: true, weight: 1, regime: null } })],
  ["+정배열 w1 강세만", variant({ trend: { enabled: true, weight: 1, regime: "bull" } })],
  ["+정배열 w2 강세만", variant({ trend: { enabled: true, weight: 2, regime: "bull" } })],
  ["+고점근접 85/90 w1 무관 +정배열 w1 강세", variant({ nearHigh: { enabled: true, weight: 1, threshold: 85, strongAt: 90, capAt: 100, regime: null }, trend: { enabled: true, weight: 1, regime: "bull" } })],
];
console.log(`${"변형".padEnd(40)}| 초록   전체       | 강세        | 약세        | 앞          | 뒤          | 블록1 2 3 4`);
for (const [name, cfg] of V) {
  const sc = S.map((s) => ({ s, r: scoreFeat(s, cfg, reg.get(s.date)) })).filter((x) => x.r);
  const g = sc.filter((x) => x.r.level === "green").map((x) => x.s);
  const blk = [0, 1, 2, 3].map((b) => { const from = dates[b * 20], to = dates[Math.min(dates.length - 1, b * 20 + 19)]; const v = g.filter((s) => s.date >= from && s.date <= to).map((r) => r.exs20).filter((x: any): x is number => x !== null); return v.length ? `${med(v) >= 0 ? "+" : ""}${med(v).toFixed(1)}` : "—"; }).join(" ");
  console.log(`${name.padEnd(40)}|${cut(g)} |${cut(g.filter((s) => reg.get(s.date) === "bull"))} |${cut(g.filter((s) => reg.get(s.date) === "bear"))} |${cut(g.filter((s) => s.date < mid))} |${cut(g.filter((s) => s.date >= mid))} | ${blk}`);
}
