/**
 * **실전 꾸러미 코드가 실측 숫자를 그대로 내나** (2026-11-17).
 *
 * 앞의 `cisBundle2.mts` 는 꾸러미를 **그 파일 안에서** 다시 짜서 쟀다. 그 숫자를 근거로
 * 로직을 바꾸는데, 정작 서버가 쓰는 것은 `cisBundleScore.ts` 다 — 둘이 조금이라도 다르면
 * **실측에서 통과한 설정이 실전에서 다른 것을 고른다**(`scoreFeat` 머리말의 그 병).
 *
 * 그래서 여기서는 **배포되는 그 함수**(`passesSieve`·`rankBundle`)로 같은 표본을 다시 잰다.
 * 숫자가 맞아야 그 꾸러미를 믿을 수 있다.
 *
 * 실행: server 에서  npx tsx tools/sigtune/bundleVerify.mts
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
const { passesSieve, rankBundle } = await imp("cisBundleScore.ts");

type S = Record<string, any>;
const file = await loadSamples();
const S: S[] = file.samples;
const cfg = await getConfig();
const fin = await loadFinanceCache();
for (const s of S) {
  const rec = fin[s.code];
  if (!rec) continue;
  s.profitYoY = profitAt(rec, s.date);
  Object.assign(s, quarterAt(rec, s.date));
}
const reg = regimeMap(S, cfg);
for (const s of S) {
  const r = scoreFeat(s, cfg, reg.get(s.date));
  s.sig = r ? r.score : null;
  s.lvl = r ? r.level : null;
}

const med = (a: number[]) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

const byDate = new Map<string, S[]>();
for (const s of S) {
  const a = byDate.get(s.date);
  if (a) a.push(s);
  else byDate.set(s.date, [s]);
}
const dates = [...byDate.keys()].sort();
for (const [, rows] of byDate) {
  const wc = rows.filter((r) => r.mktCap !== null).sort((a, b) => a.mktCap - b.mktCap);
  wc.forEach((r, i) => {
    r.q = Math.min(4, Math.floor((i * 5) / wc.length));
  });
  for (const h of ["d5", "d10", "d20"]) {
    const qMed = [0, 1, 2, 3, 4].map((q) =>
      med(wc.filter((r) => r.q === q).map((r) => r[h]).filter((v): v is number => v !== null)),
    );
    for (const r of rows) {
      r[`x${h}`] = r[h] === null || r.q === undefined || !Number.isFinite(qMed[r.q]) ? null : r[h] - qMed[r.q];
    }
  }
}
const blockOf = (d: string) => Math.min(3, Math.floor((dates.indexOf(d) * 4) / dates.length));

function stopped(s: S): boolean | null {
  if (s.mae20 === null || s.mae20 === undefined) return null;
  if (s.mae20 > -7) return false;
  if (s.maeDay === null || s.mfeDay === null) return null;
  return s.maeDay <= 12 && s.maeDay <= s.mfeDay;
}

const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "  —");

function report(label: string, rows: S[]): void {
  const g = (k: string) => rows.map((r) => r[k]).filter((x): x is number => x !== null && Number.isFinite(x));
  const x20 = g("xd20");
  const st = rows.map(stopped).filter((v): v is boolean => v !== null);
  const blocks = [0, 1, 2, 3].map((b) => {
    const v = rows.filter((r) => blockOf(r.date) === b).map((r) => r.xd20).filter((x): x is number => x !== null && Number.isFinite(x));
    return v.length ? med(v) : NaN;
  });
  console.log(
    `${label.padEnd(30)}|${String(x20.length).padStart(6)} |${f1(med(g("xd5"))).padStart(6)}${f1(med(g("xd10"))).padStart(7)}${f1(med(x20)).padStart(7)} |${((100 * x20.filter((v) => v > 0).length) / x20.length).toFixed(0).padStart(4)}%|${((100 * st.filter(Boolean).length) / st.length).toFixed(0).padStart(4)}%|${blocks.map((v) => f1(v).padStart(6)).join("")} |${blocks.filter((v) => Number.isFinite(v) && v > 0).length}/4 |${String(new Set(rows.map((r) => r.code)).size).padStart(4)}`,
  );
}
console.log(`${"집합".padEnd(30)}|${"n".padStart(6)} |${"x5".padStart(6)}${"x10".padStart(7)}${"x20".padStart(7)} |${"승률".padStart(3)}|${"손절".padStart(3)}|${"블록1".padStart(6)}${"2".padStart(6)}${"3".padStart(6)}${"4".padStart(6)} |산 |${"고유".padStart(4)}`);

/** 실전과 **똑같이** — 체를 지난 것만 넘기고, 상위 5 를 받는다 */
function pickBy(n: number): S[] {
  const out: S[] = [];
  for (const [, rows] of byDate) {
    const pool = rows.filter((r) => passesSieve(r));
    const m = new Map(pool.map((r) => [r.code, r]));
    for (const p of rankBundle(pool).slice(0, n)) {
      const s = m.get(p.code);
      if (s) out.push(s);
    }
  }
  return out;
}
const picked = pickBy(5);
report("기준선 — 전체", S);
report("지금: 신호등 상위 5/일", (() => {
  const out: S[] = [];
  for (const [, rows] of byDate) {
    const ok = rows.filter((r) => r.lvl !== "red" && r.sig !== null);
    ok.sort((a, b) => b.sig - a.sig);
    out.push(...ok.slice(0, 5));
  }
  return out;
})());
report("실전 코드: 꾸러미 상위 5/일", picked);
report("실전 코드: 꾸러미 상위 3/일", pickBy(3));
report("실전 코드: 꾸러미 상위 10/일", pickBy(10));

console.log(`\n하루 평균 체 통과: ${(med([...byDate.values()].map((rows) => rows.filter((r) => passesSieve(r)).length))).toFixed(0)}종목`);
