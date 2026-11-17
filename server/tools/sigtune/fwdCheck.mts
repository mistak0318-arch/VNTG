/**
 * **표본의 앞날 수익률이 맞나** — 일봉으로 직접 다시 센다 (2026-11-17).
 *
 * 표본의 전 종목 d20 중앙값이 달마다 −18%, −20% 로 나온다. 같은 기간 삼성전자는
 * +13.7%, 하이닉스는 +42.4% 였다. **둘 다 사실일 수는 있다**(좁은 장이면 대형 반도체만
 * 오르고 나머지는 빠진다) — 그러니 내 상식으로 판정하지 않고([[market-2026-supercycle]])
 * **다른 창고로 다시 센다.**
 *
 * 표본은 `signalSamples.json`, 여기는 `dailyCloses.json` 이다. 둘이 같으면 장이 정말
 * 그랬던 것이고, 다르면 **자가 틀린 것**이라 그 위에서 잰 모든 성적이 거짓이다.
 *
 * 실행: server 에서  npx tsx tools/sigtune/fwdCheck.mts
 */
import { pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = dirname(fileURLToPath(import.meta.url)) + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);
const { loadSamples } = await imp("signalSamples.ts");
const { loadCloses } = await imp("dailyCloses.ts");

type S = Record<string, any>;
const file = await loadSamples();
const S: S[] = file.samples;
const closes = await loadCloses();
const bars: Record<string, { d: string; c: number }[]> = closes.bars ?? {};

const med = (a: number[]) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

/** 일봉에서 그 날짜의 자리 — 없으면 -1 */
const idxCache = new Map<string, Map<string, number>>();
function indexOf(code: string, date: string): number {
  let m = idxCache.get(code);
  if (!m) {
    m = new Map();
    const bs = bars[code] ?? [];
    bs.forEach((b, i) => m!.set(b.d, i));
    idxCache.set(code, m);
  }
  return m.get(date) ?? -1;
}

/** 일봉으로 다시 센 n일 뒤 수익률 */
function fwd(code: string, date: string, n: number): number | null {
  const bs = bars[code];
  if (!bs) return null;
  const i = indexOf(code, date);
  if (i < 0 || i + n >= bs.length) return null;
  const a = bs[i].c;
  const b = bs[i + n].c;
  if (!(a > 0) || !(b > 0)) return null;
  return ((b / a) - 1) * 100;
}

console.log("## 표본의 d20 vs 일봉으로 다시 센 20일 — 월별 중앙값\n");
console.log("월      | 표본 d20 | 일봉 d20 |   차이  | 맞춘 짝 | 표본 cur 와 일봉 종가가 다른 비율");

const byMonth = new Map<string, S[]>();
for (const s of S) {
  const m = s.date.slice(0, 6);
  const a = byMonth.get(m);
  if (a) a.push(s);
  else byMonth.set(m, [s]);
}

for (const m of [...byMonth.keys()].sort()) {
  const rows = byMonth.get(m)!;
  const mine: number[] = [];
  const theirs: number[] = [];
  let paired = 0;
  let priceDiff = 0;
  let priceSeen = 0;
  for (const s of rows) {
    const f = fwd(s.code, s.date, 20);
    if (f !== null && s.d20 !== null && Number.isFinite(s.d20)) {
      mine.push(f);
      theirs.push(s.d20);
      paired++;
    }
    const i = indexOf(s.code, s.date);
    if (i >= 0 && s.cur) {
      priceSeen++;
      const c = bars[s.code][i].c;
      if (Math.abs(c - s.cur) / s.cur > 0.005) priceDiff++;
    }
  }
  const a = med(theirs);
  const b = med(mine);
  console.log(
    `${m} |${a.toFixed(2).padStart(9)} |${b.toFixed(2).padStart(9)} |${(b - a).toFixed(2).padStart(8)} |${String(paired).padStart(8)} |${priceSeen ? ((100 * priceDiff) / priceSeen).toFixed(1) : "—"}%`,
  );
}

console.log("\n## 한 종목 손으로 — 삼성전자 몇 날\n");
for (const d of ["20260508", "20260602", "20261002"]) {
  const s = S.find((x) => x.code === "005930" && x.date === d);
  const i = indexOf("005930", d);
  const bs = bars["005930"] ?? [];
  if (i >= 0 && i + 20 < bs.length) {
    console.log(
      `${d}  일봉 ${bs[i].c.toLocaleString("ko-KR")} → ${bs[i + 20].d} ${bs[i + 20].c.toLocaleString("ko-KR")} = ${fwd("005930", d, 20)!.toFixed(2)}%   |  표본 cur ${s?.cur?.toLocaleString("ko-KR") ?? "—"} d20 ${s?.d20 ?? "—"}`,
    );
  } else {
    console.log(`${d} — 일봉에 없다`);
  }
}

console.log("\n## 20일 뒤 봉이 아예 없는 표본은 몇이나 되나\n");
let noFwd = 0;
let hasD20 = 0;
for (const s of S) {
  const f = fwd(s.code, s.date, 20);
  if (f === null) {
    noFwd++;
    if (s.d20 !== null && Number.isFinite(s.d20)) hasD20++;
  }
}
console.log(`일봉으로 20일 뒤를 못 찾는 표본 ${noFwd} / ${S.length} — 그런데 d20 값이 있는 것 ${hasD20}`);
