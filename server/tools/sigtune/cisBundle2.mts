/**
 * **항해일지 꾸러미 후보** (2026-11-17) — 블록별로 버티는지까지 본다.
 *
 * ## 앞에서 확정된 것
 *
 *   · 표본 130일(2026-04-07~10-19)은 **전부 약세장**이다. 벤티지 확인: "실제로 약세장이
 *     맞았어. 시장이 계속 빠졌었거든". 일봉으로 다시 세도 0.7%p 안에서 일치했다.
 *   · 지금 신호등 초록은 **+0.6 / 승률 52%**(시총 중립 20일) — 가르는 힘이 없다.
 *   · CIS 의 `minScore: 55` 는 **죽은 조건**이다 — 초록은 전부 55 이상이라 하나도 안 걸린다.
 *   · 이 구간에서 **추세 재료가 전부 마이너스**다(rise20 -7.0 · secRel -8.2 · RS60 -7.8).
 *
 * ## 그래서 조심할 것
 *
 * 「약세장이었으니 추세를 버려라」로 가면 **한 계절짜리 답**이다. 강세장 표본이 0일이라
 * 반대쪽을 잴 길이 자체가 없다. 그래서 두 가지를 지킨다.
 *
 *   ① **블록 넷에서 다 살아야** 후보로 친다. 한두 블록에서만 좋은 것은 안 쓴다.
 *   ② **고유 종목 수**를 같이 본다. n 이 1,300 이어도 고유가 34 면 그건 34개 회사의
 *      운이지 재료의 힘이 아니다. 단일 재료 1등이던 분기 이익률이 정확히 그 꼴이었다.
 *
 * 그리고 **시스 신조는 안 건드린다** — ①체 ②추세 ③진입 뒤 추종. 추세를 빼는 꾸러미는
 * 후보로도 안 올린다([[cis-creed-filter-then-trend]]). 대신 「끝까지 오른 것」과
 * 「적당히 오른 것」을 갈라서 잰다 — 신조가 말하는 추세가 어느 쪽인지는 잰 적이 없다.
 *
 * 실행: server 에서  npx tsx tools/sigtune/cisBundle2.mts
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
const HOR = ["d5", "d10", "d20"] as const;
for (const [, rows] of byDate) {
  const wc = rows.filter((r) => r.mktCap !== null).sort((a, b) => a.mktCap - b.mktCap);
  wc.forEach((r, i) => {
    r.q = Math.min(4, Math.floor((i * 5) / wc.length));
  });
  for (const h of HOR) {
    const qMed = [0, 1, 2, 3, 4].map((q) =>
      med(wc.filter((r) => r.q === q).map((r) => r[h]).filter((v): v is number => v !== null)),
    );
    for (const r of rows) {
      r[`x${h}`] = r[h] === null || r.q === undefined || !Number.isFinite(qMed[r.q]) ? null : r[h] - qMed[r.q];
    }
  }
}

function stopped(s: S): boolean | null {
  if (s.mae20 === null || s.mae20 === undefined) return null;
  if (s.mae20 > -7) return false;
  if (s.maeDay === null || s.mfeDay === null) return null;
  return s.maeDay <= 12 && s.maeDay <= s.mfeDay;
}

/* 블록 넷 — 날짜를 넷으로 가른다 */
const BLK = 4;
const blockOf = (d: string) => Math.min(BLK - 1, Math.floor((dates.indexOf(d) * BLK) / dates.length));

function cut(rows: S[], key = "xd20"): { m: number; n: number } {
  const v = rows.map((r) => r[key]).filter((x): x is number => x !== null && Number.isFinite(x));
  return { m: v.length ? med(v) : NaN, n: v.length };
}

const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "  —");

function report(label: string, rows: S[]): void {
  const a20 = cut(rows);
  const a10 = cut(rows, "xd10");
  const a5 = cut(rows, "xd5");
  const win = (() => {
    const v = rows.map((r) => r.xd20).filter((x): x is number => x !== null && Number.isFinite(x));
    return v.length ? (100 * v.filter((x) => x > 0).length) / v.length : NaN;
  })();
  const st = rows.map(stopped).filter((v): v is boolean => v !== null);
  const stop = st.length ? (100 * st.filter(Boolean).length) / st.length : NaN;
  const blocks = [0, 1, 2, 3].map((b) => cut(rows.filter((r) => blockOf(r.date) === b)).m);
  const uniq = new Set(rows.map((r) => r.code)).size;
  const perDay = rows.length / new Set(rows.map((r) => r.date)).size;
  const alive = blocks.filter((v) => Number.isFinite(v) && v > 0).length;
  console.log(
    `${label.padEnd(34)}|${String(a20.n).padStart(6)} |${f1(a5.m).padStart(6)}${f1(a10.m).padStart(7)}${f1(a20.m).padStart(7)} |${win.toFixed(0).padStart(4)}%|${stop.toFixed(0).padStart(4)}%|${blocks.map((v) => f1(v).padStart(6)).join("")} |${String(alive)}/4 |${String(uniq).padStart(4)}|${perDay.toFixed(1).padStart(5)}`,
  );
}
const HEAD = `${"꾸러미".padEnd(34)}|${"n".padStart(6)} |${"x5".padStart(6)}${"x10".padStart(7)}${"x20".padStart(7)} |${"승률".padStart(3)}|${"손절".padStart(3)}|${"블록1".padStart(6)}${"2".padStart(6)}${"3".padStart(6)}${"4".padStart(6)} |산 |${"고유".padStart(4)}|${"하루".padStart(5)}`;

/** 날짜마다 상위 N */
function topN(score: (s: S) => number | null, n: number, filter?: (s: S) => boolean): S[] {
  const out: S[] = [];
  for (const [, rows] of byDate) {
    const ok = filter ? rows.filter(filter) : rows;
    const sc = ok.map((r) => ({ r, v: score(r) })).filter((x) => x.v !== null && Number.isFinite(x.v!));
    sc.sort((a, b) => b.v! - a.v!);
    for (const x of sc.slice(0, n)) out.push(x.r);
  }
  return out;
}

/* ── 체 (공통) — 신조 ①. 살 수 있는 것만 남긴다 ── */
const 유동 = (s: S) => (s.volEok ?? 0) >= 50 && (s.mktCap ?? 0) >= 1000;
/** 쏠림·과열 — 실전 🔥 와 같은 뜻. 거래량 2.5배↑ 또는 20일선 +25% 이상 뜬 것 */
const 안쏠림 = (s: S) => !((s.vGrow ?? 0) >= 150 || (s.gap20 ?? 0) >= 25);
/** 적자는 뺀다 — 실전 신호등의 qMargin 탈락과 같은 자리 */
const 흑자 = (s: S) => s.qMargin === null || s.qMargin > 0;
const 체 = (s: S) => 유동(s) && 안쏠림(s) && 흑자(s);

/** 점수를 0~100 으로 — 날짜 안에서 백분위. 재료마다 단위가 달라 그냥 더하면 큰 단위가 이긴다 */
function pctRank(key: string, dir = 1): (s: S) => number | null {
  const ranks = new Map<S, number>();
  for (const [, rows] of byDate) {
    const v = rows.filter((r) => r[key] !== null && Number.isFinite(r[key]));
    v.sort((a, b) => dir * (a[key] - b[key]));
    v.forEach((r, i) => ranks.set(r, v.length > 1 ? (100 * i) / (v.length - 1) : 50));
  }
  return (s: S) => ranks.get(s) ?? null;
}
/** 가운데가 제일 높은 점수 — 「적당히」를 재는 자 */
function band(key: string, lo: number, hi: number): (s: S) => number | null {
  return (s: S) => {
    const v = s[key];
    if (v === null || !Number.isFinite(v)) return null;
    if (v < lo || v > hi) return 0;
    const mid = (lo + hi) / 2;
    return 100 * (1 - Math.abs(v - mid) / ((hi - lo) / 2));
  };
}
const sum = (...fs: ((s: S) => number | null)[]) => (s: S) => {
  let t = 0;
  let got = 0;
  for (const f of fs) {
    const v = f(s);
    if (v === null) continue;
    t += v;
    got++;
  }
  return got === 0 ? null : t / got;
};

const rVol = pctRank("volat20", -1); // 변동성 낮을수록 높은 점수
const rMargin = pctRank("qMargin", 1);
const rGapTight = (s: S) => (s.gap20 === null ? null : Math.max(0, 100 - Math.abs(s.gap20) * 4));
const rFgn = pctRank("fgn20", 1);
const rSec = pctRank("secRel", 1);
const rRise = pctRank("rise20", 1);

console.log(`표본 ${S.length} · 날짜 ${dates.length} (${dates[0]}~${dates[dates.length - 1]}) · 전부 약세장\n`);
console.log("## 꾸러미 후보 — 날짜별 상위 5 (항해일지가 하루에 사는 수에 가깝게)\n");
console.log(HEAD);

report("기준선 — 전체", S);
report("A. 지금: 신호등 점수 상위", topN((s) => s.sig, 5, (s) => s.lvl !== "red"));
report("A'. 신호등 + 체", topN((s) => s.sig, 5, (s) => s.lvl !== "red" && 체(s)));
report("B. 추세 끝까지 (rise20 상위)", topN(rRise, 5, 체));
report("C. 추세 적당히 (rise20 0~15%)", topN(band("rise20", 0, 15), 5, 체));
report("C'. 섹터 상대 적당히 (-3~+10)", topN(band("secRel", -3, 10), 5, 체));
report("D. 저변동 홀로", topN(rVol, 5, 체));
report("E. 저변동 + 이익률", topN(sum(rVol, rMargin), 5, 체));
report("F. 저변동 + 이익률 + 외인", topN(sum(rVol, rMargin, rFgn), 5, 체));
report("G. 체 + 저변동 + 추세적당", topN(sum(rVol, band("rise20", 0, 15)), 5, 체));
report("H. 체 + 저변동 + 이격좁음 + 추세적당", topN(sum(rVol, rGapTight, band("rise20", 0, 15)), 5, 체));
report("I. H + 신호등 점수", topN(sum(rVol, rGapTight, band("rise20", 0, 15), pctRank("sig", 1)), 5, (s) => 체(s) && s.lvl !== "red"));

console.log("\n## 같은 꾸러미를 상위 10 으로 (후보가 모자랄 때를 본다)\n");
console.log(HEAD);
report("A. 신호등", topN((s) => s.sig, 10, (s) => s.lvl !== "red"));
report("H. 저변동+이격+추세적당", topN(sum(rVol, rGapTight, band("rise20", 0, 15)), 10, 체));
report("I. H + 신호등", topN(sum(rVol, rGapTight, band("rise20", 0, 15), pctRank("sig", 1)), 10, (s) => 체(s) && s.lvl !== "red"));

console.log("\n## 체만 따로 — 거르기가 얼마나 하나 (상위 뽑기 없이 전부)\n");
console.log(HEAD);
report("유동성만", S.filter(유동));
report("유동성 + 안쏠림", S.filter((s) => 유동(s) && 안쏠림(s)));
report("유동성 + 안쏠림 + 흑자 (= 체)", S.filter(체));
report("체 + 신호등 빨강 제외", S.filter((s) => 체(s) && s.lvl !== "red"));

console.log("\n## 4/4 를 버티는 조합만 — C' 둘레로 (상위 5/일)\n");
console.log(HEAD);
const rSecBand = band("secRel", -3, 10);
const rRiseBand = band("rise20", 0, 15);
report("C'. 섹터 상대 적당히 (기준)", topN(rSecBand, 5, 체));
report("C' + 추세 적당히", topN(sum(rSecBand, rRiseBand), 5, 체));
report("C' + 저변동", topN(sum(rSecBand, rVol), 5, 체));
report("C' + 추세적당 + 저변동", topN(sum(rSecBand, rRiseBand, rVol), 5, 체));
report("C' + 추세적당 + 이격좁음", topN(sum(rSecBand, rRiseBand, rGapTight), 5, 체));
report("C' + 추세적당 + 외인20", topN(sum(rSecBand, rRiseBand, rFgn), 5, 체));
report("C' + 추세적당 + 이익률", topN(sum(rSecBand, rRiseBand, rMargin), 5, 체));
report("C' + 추세적당 + 저변동 + 이격", topN(sum(rSecBand, rRiseBand, rVol, rGapTight), 5, 체));
report("〃 + 신호등 빨강만 제외", topN(sum(rSecBand, rRiseBand, rVol, rGapTight), 5, (s) => 체(s) && s.lvl !== "red"));

console.log("\n## 추천안을 상위 3 / 5 / 10 으로 — 하루에 몇 개까지 믿을 수 있나\n");
console.log(HEAD);
for (const n of [3, 5, 10, 20]) {
  report(`추천안 상위 ${n}/일`, topN(sum(rSecBand, rRiseBand, rVol, rGapTight), n, (s) => 체(s) && s.lvl !== "red"));
}
