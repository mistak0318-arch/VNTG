/**
 * **표본이 장을 제대로 담고 있나** (2026-11-17).
 *
 * 재료의 성적을 재기 전에 **자(표본)부터 의심한다.** 130일이 전부 약세장으로 분류됐는데,
 * 2026년 장은 반도체가 끌고 올라간 해다([[market-2026-supercycle]]). 둘 중 하나는 틀렸다.
 *
 * 세 가지를 본다.
 *   ① 날짜별 전 종목 d20 중앙값 — 표본이 본 「시장」의 실제 움직임
 *   ② 같은 기간 코스피 실제 등락 — 일봉에서
 *   ③ 장세 판정(regimeMap)이 무엇을 보고 약세라 했나
 *
 * 실행: server 에서  npx tsx tools/sigtune/sanityCheck.mts
 */
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url)) + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);
const { loadSamples } = await imp("signalSamples.ts");
const { regimeMap } = await imp("signalSimulate.ts");
const { getConfig } = await imp("signalLight.ts");

type S = Record<string, any>;
const file = await loadSamples();
const S: S[] = file.samples;
const cfg = await getConfig();
const reg = regimeMap(S, cfg);

const med = (a: number[]) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

const byDate = new Map<string, S[]>();
for (const s of S) {
  const arr = byDate.get(s.date);
  if (arr) arr.push(s);
  else byDate.set(s.date, [s]);
}
const dates = [...byDate.keys()].sort();

console.log("## ① 표본이 본 시장 — 날짜별 전 종목 중앙값 (월별로 묶어서)\n");
console.log("월       |  날짜  표본 | d1 중앙 | d5 중앙 | d20 중앙 | d20 양수비율 | mTrend 중앙");
const byMonth = new Map<string, S[]>();
for (const s of S) {
  const m = s.date.slice(0, 6);
  const a = byMonth.get(m);
  if (a) a.push(s);
  else byMonth.set(m, [s]);
}
for (const m of [...byMonth.keys()].sort()) {
  const rows = byMonth.get(m)!;
  const g = (k: string) => rows.map((r) => r[k]).filter((v): v is number => v !== null && Number.isFinite(v));
  const d20 = g("d20");
  const days = new Set(rows.map((r) => r.date)).size;
  console.log(
    `${m}  |${String(days).padStart(5)}${String(rows.length).padStart(7)} |${med(g("d1")).toFixed(2).padStart(8)} |${med(g("d5")).toFixed(2).padStart(8)} |${med(d20).toFixed(2).padStart(9)} |${(d20.length ? (100 * d20.filter((v) => v > 0).length) / d20.length : NaN).toFixed(0).padStart(12)}% |${med(g("mTrend")).toFixed(1).padStart(11)}`,
  );
}

console.log("\n## ② 같은 기간 코스피 실제 — 일봉에서\n");
try {
  const { loadCloses } = await imp("dailyCloses.ts");
  const closes = await loadCloses();
  const bars = closes.bars ?? {};
  /* 삼성전자를 시장 대신 — 지수 일봉이 같은 창고에 없으면 대형주로 본다 */
  for (const [code, name] of [["005930", "삼성전자"], ["000660", "SK하이닉스"]] as const) {
    const bs = bars[code] ?? [];
    const at = (d: string) => bs.find((b: any) => b.d === d)?.c ?? null;
    const first = at(dates[0]);
    const last = at(dates[dates.length - 1]);
    if (first && last) {
      console.log(`${name}  ${dates[0]} ${first.toLocaleString("ko-KR")} → ${dates[dates.length - 1]} ${last.toLocaleString("ko-KR")}  = ${(((last / first) - 1) * 100).toFixed(1)}%`);
    } else {
      console.log(`${name} — 그 날짜의 봉이 없다 (first=${first} last=${last})`);
    }
  }
} catch (e) {
  console.log("일봉을 못 읽었다:", e instanceof Error ? e.message : e);
}

console.log("\n## ③ 장세 판정은 무엇을 보나\n");
const bull = [...reg.values()].filter((v) => v === "bull").length;
console.log(`강세 ${bull} · 약세 ${reg.size - bull} · 판정 없음 ${dates.length - reg.size}`);
const rc = (cfg as any).regimeCheck ?? (cfg as any).regime ?? null;
console.log("설정의 장세 관련 값:", JSON.stringify({ regimeSwitch: (cfg as any).regimeSwitch, regimeBullAt: (cfg as any).regimeBullAt, regimeKey: (cfg as any).regimeKey, rc }));
/* regimeMap 이 mTrend 중앙값을 보는지 확인 — 날짜별 mTrend 중앙값의 분포 */
const mt = dates.map((d) => med(byDate.get(d)!.map((r) => r.mTrend).filter((v): v is number => v !== null && Number.isFinite(v))));
const mtSorted = [...mt].filter(Number.isFinite).sort((a, b) => a - b);
console.log(`날짜별 mTrend 중앙값: 최소 ${mtSorted[0]?.toFixed(1)} · 25% ${mtSorted[Math.floor(mtSorted.length * 0.25)]?.toFixed(1)} · 중앙 ${mtSorted[Math.floor(mtSorted.length * 0.5)]?.toFixed(1)} · 75% ${mtSorted[Math.floor(mtSorted.length * 0.75)]?.toFixed(1)} · 최대 ${mtSorted[mtSorted.length - 1]?.toFixed(1)}`);
console.log(`강세로 찍힌 날: ${dates.filter((d) => reg.get(d) === "bull").slice(0, 10).join(" ") || "(없음)"}`);
