/**
 * 4부 — 표본에 없던 지표를 **일봉에서 바로 뽑아** 붙여 잰다 (기본값은 안 건드린다).
 *   상대강도 rs20·rs60(그날 시장 중앙값 대비) · ret5 · 거래량 배수 volRatio(오늘÷20일 평균) ·
 *   회전율 turnover(거래대금÷시총 %) · 변동성 volat20(일수익률 표준편차 %) · 상승일 수 upDays20 ·
 *   5일선 회복 reclaim5 · 60일 저점 대비 lo60Pct · 20일선 부호 있는 이격 disp20s · 갭 gap
 * 그리고 「세대 3 초록 안에서」 그 지표가 진짜를 더 골라내는지.
 *
 * 실행: server 에서  npx tsx tools/sigtune/sigtune4.mts
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

/* ---------- 일봉에서 지표 ---------- */
const barIdx = new Map<string, Map<string, number>>();
for (const s of S) {
  const bs = bars?.[s.code]; if (!bs) continue;
  let m = barIdx.get(s.code); if (!m) { m = new Map(); bs.forEach((b: any, i: number) => m!.set(b.d, i)); barIdx.set(s.code, m); }
  const i = m.get(s.date); if (i === undefined || i < 61) continue;
  const c = (k: number) => bs[i - k].c;
  const ret = (k: number) => (c(k) > 0 ? ((c(0) - c(k)) / c(k)) * 100 : null);
  s.ret5 = ret(5); s.ret20 = ret(20); s.ret60 = ret(60);
  const v20 = bs.slice(i - 20, i).reduce((a: number, b: any) => a + b.v, 0) / 20;
  s.volRatio = v20 > 0 ? bs[i].v / v20 : null;
  s.turnover = s.mktCap && s.volEok !== null ? (s.volEok / s.mktCap) * 100 : null;
  const lr: number[] = []; for (let k = 19; k >= 0; k--) { const a = c(k + 1), b = c(k); if (a > 0 && b > 0) lr.push(Math.log(b / a)); }
  const mean = lr.reduce((a, b) => a + b, 0) / lr.length;
  s.volat20 = lr.length >= 15 ? Math.sqrt(lr.reduce((a, b) => a + (b - mean) ** 2, 0) / lr.length) * 100 : null;
  s.upDays20 = lr.filter((x) => x > 0).length;
  const m5 = bs.slice(i - 4, i + 1).reduce((a: number, b: any) => a + b.c, 0) / 5;
  const m5prev = bs.slice(i - 5, i).reduce((a: number, b: any) => a + b.c, 0) / 5;
  s.reclaim5 = c(0) >= m5 && c(1) < m5prev ? 1 : c(0) >= m5 ? 2 : 0; // 0 아래 · 1 오늘 회복 · 2 계속 위
  const lo60 = Math.min(...bs.slice(i - 60, i).map((b: any) => b.l));
  s.lo60Pct = lo60 > 0 ? (c(0) / lo60) * 100 : null;
  const m20 = bs.slice(i - 19, i + 1).reduce((a: number, b: any) => a + b.c, 0) / 20;
  s.disp20s = m20 > 0 ? ((c(0) - m20) / m20) * 100 : null;
  s.gap = c(1) > 0 ? ((bs[i].o - c(1)) / c(1)) * 100 : null;
  s.range = bs[i].l > 0 ? ((bs[i].h - bs[i].l) / bs[i].l) * 100 : null; // 그날 진폭
}

/* ---------- 초과수익 · 상대강도 ---------- */
const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
const med = (a: number[]) => { if (!a.length) return NaN; const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2; };
for (const [, rows] of byDate) {
  const wc = rows.filter((r) => r.mktCap !== null).sort((a, b) => a.mktCap - b.mktCap);
  wc.forEach((r, i) => { r.q = Math.min(4, Math.floor((i * 5) / wc.length)); });
  const qMed = [0, 1, 2, 3, 4].map((q) => med(wc.filter((r) => r.q === q).map((r) => r.d20).filter((v): v is number => v !== null)));
  const m20 = med(rows.map((r) => r.ret20).filter((v): v is number => v != null)), m60 = med(rows.map((r) => r.ret60).filter((v): v is number => v != null)), m5 = med(rows.map((r) => r.ret5).filter((v): v is number => v != null));
  for (const r of rows) {
    r.exs20 = r.d20 === null || r.q === undefined ? null : r.d20 - qMed[r.q];
    r.rs20 = r.ret20 == null ? null : r.ret20 - m20; r.rs60 = r.ret60 == null ? null : r.ret60 - m60; r.rs5 = r.ret5 == null ? null : r.ret5 - m5;
  }
}
const reg = regimeMap(S, cfg);
const dates = [...byDate.keys()].sort();
const mid = dates[Math.floor(dates.length / 2)];
for (const s of S) { s.reg = reg.get(s.date) ?? "?"; s.half = s.date < mid ? "F" : "B"; }
interface Cut { n: number; med: number; win: number }
const cut = (rows: S[]): Cut => { const v = rows.map((r) => r.exs20).filter((x): x is number => x !== null && Number.isFinite(x)); if (!v.length) return { n: 0, med: NaN, win: NaN }; return { n: v.length, med: med(v), win: (100 * v.filter((x) => x > 0).length) / v.length }; };
const f1 = (x: number) => (Number.isFinite(x) ? (x >= 0 ? "+" : "") + x.toFixed(1) : " — ");
const cell = (c: Cut) => `${String(c.n).padStart(5)} ${f1(c.med).padStart(5)}/${Number.isFinite(c.win) ? c.win.toFixed(0).padStart(2) : "—"}`;
function line(label: string, rows: S[]) {
  const a = cut(rows), bu = cut(rows.filter((r) => r.reg === "bull")), be = cut(rows.filter((r) => r.reg === "bear")), F = cut(rows.filter((r) => r.half === "F")), B = cut(rows.filter((r) => r.half === "B"));
  const ok = [bu, be, F, B].every((c) => c.n >= 150 && c.med > 0 && c.win > 50) ? " ✅" : [bu, be, F, B].every((c) => c.n >= 150 && c.med < 0 && c.win < 50) ? " ❌" : "";
  return `${label.padEnd(14)}|${cell(a)} |강${cell(bu)} |약${cell(be)} |앞${cell(F)} |뒤${cell(B)}${ok}`;
}
const HEAD = `${"구간".padEnd(14)}|    n  med/win |강세장         |약세장         |앞             |뒤`;

const FEAT: [string, string, number[]][] = [
  ["rs20", "상대강도 20일 (시장 중앙값 대비 %p)", [-99, -15, -10, -5, -2, 0, 2, 5, 10, 20, 30]],
  ["rs60", "상대강도 60일", [-99, -30, -20, -10, -5, 0, 5, 10, 20, 40]],
  ["rs5", "상대강도 5일", [-99, -8, -5, -3, -1, 0, 1, 3, 5, 8, 15]],
  ["volRatio", "거래량 배수 (오늘 ÷ 20일 평균)", [0, 0.4, 0.6, 0.8, 1, 1.3, 1.7, 2.5, 4, 7]],
  ["turnover", "회전율 (거래대금 ÷ 시총 %)", [0, 0.3, 0.5, 1, 2, 3, 5, 8, 15]],
  ["volat20", "변동성 20일 (일수익률 σ %)", [0, 1.5, 2, 2.5, 3, 3.5, 4, 5, 7]],
  ["upDays20", "20일 중 상승일 수", [0, 6, 8, 9, 10, 11, 12, 13, 15]],
  ["reclaim5", "5일선: 0 아래 · 1 오늘 회복 · 2 계속 위", [0, 1, 2]],
  ["lo60Pct", "60일 저점 대비 (%)", [100, 105, 110, 115, 120, 130, 150, 200]],
  ["disp20s", "20일선 이격 (부호 있음 %)", [-99, -15, -10, -5, -2, 0, 2, 5, 10, 15]],
  ["gap", "그날 시가 갭 (%)", [-99, -3, -1, -0.3, 0.3, 1, 3, 6]],
  ["range", "그날 진폭 (%)", [0, 2, 3, 4, 6, 8, 12]],
];
P(`표본 ${S.length} · 일봉 지표 붙음 ${S.filter((s) => s.rs20 != null).length} · exs20 = 같은 날·같은 시총 5분위 중앙값 대비`);
for (const [key, title, edges] of FEAT) {
  const vals = S.filter((s) => s[key] != null && Number.isFinite(s[key]));
  P(`\n#### ${key} · ${title} · 커버 ${((100 * vals.length) / S.length).toFixed(0)}%`);
  P(HEAD);
  for (let i = 0; i < edges.length; i++) { const lo = edges[i], hi = i + 1 < edges.length ? edges[i + 1] : Infinity; const rows = vals.filter((s) => s[key] >= lo && s[key] < hi); if (rows.length) P(line(`${lo <= -98 ? "<" : lo}~${hi === Infinity ? "" : hi}`, rows)); }
}

/* ---------- 세대 3 초록 안에서 — 후보를 더 골라내나 ---------- */
const green = S.filter((s) => scoreFeat(s, cfg, reg.get(s.date))?.level === "green");
P(`\n\n## 세대 3 초록 ${green.length} 안에서 갈라 보기 (후보 추리기 관점)`);
P(line("초록 전체", green));
const SPLIT: [string, (s: S) => string | null][] = [
  ["rs20", (s) => s.rs20 == null ? null : s.rs20 < -5 ? "rs20 <-5" : s.rs20 < 0 ? "rs20 -5~0" : s.rs20 < 5 ? "rs20 0~5" : s.rs20 < 15 ? "rs20 5~15" : "rs20 15~"],
  ["rs60", (s) => s.rs60 == null ? null : s.rs60 < -10 ? "rs60 <-10" : s.rs60 < 0 ? "rs60 -10~0" : s.rs60 < 10 ? "rs60 0~10" : s.rs60 < 30 ? "rs60 10~30" : "rs60 30~"],
  ["volRatio", (s) => s.volRatio == null ? null : s.volRatio < 0.8 ? "vol <0.8" : s.volRatio < 1.5 ? "vol 0.8~1.5" : s.volRatio < 3 ? "vol 1.5~3" : "vol 3~"],
  ["turnover", (s) => s.turnover == null ? null : s.turnover < 1 ? "turn <1%" : s.turnover < 3 ? "turn 1~3" : s.turnover < 8 ? "turn 3~8" : "turn 8~"],
  ["volat20", (s) => s.volat20 == null ? null : s.volat20 < 2 ? "σ <2" : s.volat20 < 3 ? "σ 2~3" : s.volat20 < 4 ? "σ 3~4" : "σ 4~"],
  ["reclaim5", (s) => s.reclaim5 == null ? null : ["5일선 아래", "5일선 오늘 회복", "5일선 계속 위"][s.reclaim5]],
  ["lo60Pct", (s) => s.lo60Pct == null ? null : s.lo60Pct < 110 ? "저점+10%↓" : s.lo60Pct < 125 ? "저점+10~25" : s.lo60Pct < 150 ? "저점+25~50" : "저점+50%↑"],
  ["disp20s", (s) => s.disp20s == null ? null : s.disp20s < -5 ? "20선 -5↓" : s.disp20s < 0 ? "20선 -5~0" : s.disp20s < 5 ? "20선 0~5" : s.disp20s < 10 ? "20선 5~10" : "20선 10↑"],
  ["upDays20", (s) => s.upDays20 == null ? null : s.upDays20 < 9 ? "상승일 <9" : s.upDays20 < 12 ? "상승일 9~11" : "상승일 12↑"],
];
for (const [key, fn] of SPLIT) {
  P(`\n-- ${key}`);
  const groups = new Map<string, S[]>();
  for (const s of green) { const g = fn(s); if (g === null) continue; (groups.get(g) ?? groups.set(g, []).get(g)!).push(s); }
  for (const [g, rows] of [...groups.entries()].sort()) P(line(g, rows));
}
writeFileSync(dirname(fileURLToPath(import.meta.url)) + "/sigtune-4.txt", out.join("\n"), "utf-8");
