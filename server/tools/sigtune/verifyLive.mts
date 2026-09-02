/**
 * 실전 채점기(`scoreFeat` + `getConfig`)가 표본에서 재검토 제안과 같은 성적을 내는지 확인.
 * 표본의 실적 칸은 `financeCache` 로 채운다(파이프라인 ⑨가 하는 것과 같은 방식).
 *
 * 실행: server 에서  npx tsx tools/sigtune/verifyLive.mts
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
const cfg = await getConfig();
const fin = await loadFinanceCache();
let filled = 0;
for (const s of S) {
  const rec = fin[s.code];
  if (!rec) continue;
  s.profitYoY = profitAt(rec, s.date);
  Object.assign(s, quarterAt(rec, s.date));
  if (s.qYoY !== null) filled++;
}
console.log(`설정 세대 ${cfg.configVersion} · greenAt ${cfg.greenAt} · 켜진 기준: ${cfg.checks.filter((c: any) => c.enabled).map((c: any) => `${c.key}${c.weight ? "" : "(veto)"}`).join(" ")}`);
console.log(`표본 ${S.length} · 분기 YoY 채움 ${filled}`);

const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
const med = (a: number[]) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
for (const [, rows] of byDate) {
  const wc = rows.filter((r) => r.mktCap !== null).sort((a, b) => a.mktCap - b.mktCap);
  wc.forEach((r, i) => { r.q = Math.min(4, Math.floor((i * 5) / wc.length)); });
  const qMed = [0, 1, 2, 3, 4].map((q) => med(wc.filter((r) => r.q === q).map((r) => r.d20).filter((v): v is number => v !== null)));
  const m20 = med(rows.map((r) => r.d20).filter((v): v is number => v !== null));
  for (const r of rows) { r.ex20 = r.d20 === null ? null : r.d20 - m20; r.exs20 = r.d20 === null || r.q === undefined ? null : r.d20 - qMed[r.q]; }
}
const reg = regimeMap(S, cfg);
const dates = [...byDate.keys()].sort();
const mid = dates[Math.floor(dates.length / 2)];
const cut = (rows: S[], key = "exs20") => { const v = rows.map((r) => r[key]).filter((x): x is number => x !== null && Number.isFinite(x)); if (!v.length) return "—"; return `n${v.length} ${med(v) >= 0 ? "+" : ""}${med(v).toFixed(1)}/${(100 * v.filter((x) => x > 0).length / v.length).toFixed(0)}`; };

const scored = S.map((s) => ({ s, r: scoreFeat(s, cfg, reg.get(s.date)) })).filter((x) => x.r);
const green = scored.filter((x) => x.r.level === "green").map((x) => x.s);
const thin = scored.filter((x) => x.r.low).length;
const red = scored.filter((x) => x.r.level === "red").length;
console.log(`채점 ${scored.length} · 덜잼 ${thin} · 초록 ${green.length} (${(100 * green.length / scored.length).toFixed(1)}%) · 빨강 ${red}`);
console.log(`초록 exs20  전체 ${cut(green)} · 강 ${cut(green.filter((s) => reg.get(s.date) === "bull"))} · 약 ${cut(green.filter((s) => reg.get(s.date) === "bear"))} · 앞 ${cut(green.filter((s) => s.date < mid))} · 뒤 ${cut(green.filter((s) => s.date >= mid))}`);
console.log(`초록 ex20   전체 ${cut(green, "ex20")} · 절대 d20 ${cut(green, "d20")}`);
for (let b = 0; b < 4; b++) { const from = dates[b * 20], to = dates[Math.min(dates.length - 1, b * 20 + 19)]; console.log(`  블록 ${b + 1} (${from}~${to}) 초록 ${cut(green.filter((s) => s.date >= from && s.date <= to))}`); }
