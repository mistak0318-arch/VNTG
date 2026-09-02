/**
 * 종배 계좌의 성적 미리 재기 (2026-09-03) — 「신호등 상위에 종가배팅하면」.
 *
 * 실행: server/ 에서 `npx tsx tools/sigtune/closeBetSig.mts`
 * 조회: 야후 일봉 다섯(선물·유가·환율·10년·30년)만. 키움 0회.
 *
 * 표본(signalSamples.json, 2026-04~08 81일)의 날짜마다 실전 채점기(scoreFeat, 세대 4)로
 * 점수를 매겨 **날짜별 상위 K** 를 고르고, 그날 종가에 사서 ① 다음 날 시가 ② 다음 날 종가에
 * 판 수익률을 센다. 같은 날 전 표본 중앙값을 빼서 「시장보다 더 먹었나」도 본다.
 * 그리고 종가배팅 연습기의 게이지(`closeBet.gaugeHistory`)로 그날 미국 선물 몸통·금리를
 * 붙여 「미국장 분위기 문」이 실제로 가르는지 본다.
 *
 * ⚠️ 수급 축 문(FLOW_MIN)은 표본에 축 점수가 없어 여기선 못 잰다. 시장 문(marketGate)도.
 */
import { loadSamples, scoreFeat } from "../../src/signalSamples.js";
import { getConfig } from "../../src/signalLight.js";
import { regimeMap } from "../../src/signalSimulate.js";
import { loadCloses } from "../../src/dailyCloses.js";
import { gaugeHistory } from "../../src/closeBet.js";

const file = await loadSamples();
if (!file) throw new Error("표본 없음");
const cfg = await getConfig();
const { bars } = await loadCloses();
const barsOf = bars ?? {};
const S = file.samples;
const regimeOf = regimeMap(S, cfg);

/* 게이지 — 표본 구간을 덮게 넉넉히 */
const gauges = await gaugeHistory(200);
const gaugeBy = new Map(gauges.map((g) => [g.date.replace(/-/g, ""), g]));
/*
 * ⚠️ **같은 날 선물 몸통은 미래를 본다.** 야후 일봉의 ES=F 몸통은 그날 미국 세션(한국 종가
 * 뒤 밤)까지 포함한 확정값이라, 17:00 에 보이는 「진행 중 몸통」과 다르다. 그래서 「전날
 * 몸통」(17:00 에 확실히 아는 값)으로 가른 줄을 같이 낸다 — 둘의 차이가 미래 보기의 크기다.
 */
const prevGaugeBy = new Map(gauges.map((g, i) => [g.date.replace(/-/g, ""), gauges[i - 1]]));

interface Row {
  date: string;
  code: string;
  score: number;
  gapOpen: number; // 종가 → 다음 날 시가 %
  gapClose: number; // 종가 → 다음 날 종가 %
}

const idx = new Map<string, Map<string, number>>();
const indexFor = (code: string) => {
  const hit = idx.get(code);
  if (hit) return hit;
  const bs = barsOf[code];
  if (!bs) return null;
  const m = new Map<string, number>();
  bs.forEach((b, i) => m.set(b.d, i));
  idx.set(code, m);
  return m;
};

const byDate = new Map<string, Row[]>();
let scanned = 0;
for (const s of S) {
  if (s.volEok !== null && s.volEok < 500) continue;
  if (s.mktCap !== null && s.mktCap < 1000) continue;
  const sc = scoreFeat(s, cfg, regimeOf.get(s.date));
  if (!sc || sc.lowCoverage || sc.level !== "green") continue;
  const m = indexFor(s.code);
  const bs = barsOf[s.code];
  if (!m || !bs) continue;
  const at = m.get(s.date);
  if (at === undefined) continue;
  const b0 = bs[at];
  const b1 = bs[at + 1];
  if (!b0 || !b1 || !(b0.c > 0) || !(b1.o > 0) || !(b1.c > 0)) continue;
  scanned += 1;
  const row: Row = {
    date: s.date,
    code: s.code,
    score: sc.score,
    gapOpen: ((b1.o - b0.c) / b0.c) * 100,
    gapClose: ((b1.c - b0.c) / b0.c) * 100,
  };
  const arr = byDate.get(s.date) ?? [];
  arr.push(row);
  byDate.set(s.date, arr);
}

const med = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const v = [...xs].sort((a, b) => a - b);
  return v[v.length >> 1];
};
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const f = (n: number, w = 6) => (n >= 0 ? "+" : "") + n.toFixed(2).padStart(w - 1);

function stat(label: string, rows: { o: number; c: number; eo: number; ec: number }[]) {
  const o = rows.map((r) => r.o);
  const c = rows.map((r) => r.c);
  const eo = rows.map((r) => r.eo);
  const ec = rows.map((r) => r.ec);
  const win = (xs: number[]) => (xs.length ? Math.round((xs.filter((x) => x > 0).length / xs.length) * 100) : 0);
  console.log(
    `${label.padEnd(30)} | n ${String(rows.length).padStart(4)} | 시가 ${f(mean(o))} 승 ${String(win(o)).padStart(3)} 초과 ${f(mean(eo))} 승 ${String(win(eo)).padStart(3)}` +
      ` | 종가 ${f(mean(c))} 승 ${String(win(c)).padStart(3)} 초과 ${f(mean(ec))} 승 ${String(win(ec)).padStart(3)}`,
  );
}

/* 날짜별 상위 K + 그날 전 표본 중앙값 대비 초과 */
function pick(K: number, filter?: (g: ReturnType<typeof gaugeBy.get>) => boolean, usePrev = false) {
  const out: { o: number; c: number; eo: number; ec: number }[] = [];
  const base: { o: number; c: number; eo: number; ec: number }[] = [];
  for (const [date, rows] of byDate) {
    const g = usePrev ? prevGaugeBy.get(date) : gaugeBy.get(date);
    if (filter && !filter(g)) continue;
    const mo = med(rows.map((r) => r.gapOpen));
    const mc = med(rows.map((r) => r.gapClose));
    const top = [...rows].sort((a, b) => b.score - a.score).slice(0, K);
    for (const r of top) out.push({ o: r.gapOpen, c: r.gapClose, eo: r.gapOpen - mo, ec: r.gapClose - mc });
    for (const r of rows) base.push({ o: r.gapOpen, c: r.gapClose, eo: r.gapOpen - mo, ec: r.gapClose - mc });
  }
  return { out, base };
}

console.log(`표본 ${S.length} · 초록(대금 500억↑·시총 1000억↑·다음 봉 있음) ${scanned} · 날짜 ${byDate.size} · 게이지 ${gauges.length}일`);
console.log("종가에 사서 → 다음 날 시가 / 종가. 「초과」= 같은 날 초록 전체 중앙값 대비 %p");
console.log("");
console.log("### 신호등 점수 상위 K (모든 날)");
for (const K of [3, 5, 8]) stat(`상위 ${K}`, pick(K).out);
stat("초록 전체 (기준선)", pick(9999).base);

console.log("");
console.log("### 미국장 분위기 문 — 상위 5, 그날 게이지로 가른다");
const has = (g: ReturnType<typeof gaugeBy.get>) => g !== undefined;
stat("게이지 있는 날 전부 · 상위 5", pick(5, has).out);
stat("선물 몸통 > +0.2% (좋음)", pick(5, (g) => !!g && g.futuresBody !== null && g.futuresBody > 0.2).out);
stat("선물 몸통 -0.2~+0.2 (방향 없음)", pick(5, (g) => !!g && g.futuresBody !== null && Math.abs(g.futuresBody) <= 0.2).out);
stat("선물 몸통 < -0.2% (나쁨)", pick(5, (g) => !!g && g.futuresBody !== null && g.futuresBody < -0.2).out);
stat("10년물 하루 +6bp↑ (나쁨)", pick(5, (g) => !!g && g.y10Move !== null && g.y10Move >= 6).out);
stat("10년물 +6bp 미만", pick(5, (g) => !!g && g.y10Move !== null && g.y10Move < 6).out);
stat("유가 |4%|↑ 또는 환율 |1%|↑ (나쁨)", pick(5, (g) => !!g && ((g.oilMove !== null && Math.abs(g.oilMove) >= 4) || (g.fxMove !== null && Math.abs(g.fxMove) >= 1))).out);
const okGauge = (g: ReturnType<typeof gaugeBy.get>) =>
  !!g &&
  !(g.futuresBody !== null && g.futuresBody < -0.2) &&
  !(g.y10Move !== null && g.y10Move >= 6) &&
  !(g.y30Move !== null && g.y30Move >= 8) &&
  !(g.oilMove !== null && Math.abs(g.oilMove) >= 4) &&
  !(g.fxMove !== null && Math.abs(g.fxMove) >= 1);
stat("문 통과(나쁨 없음) · 상위 5", pick(5, okGauge).out);
stat("문 막힘 · 상위 5", pick(5, (g) => has(g) && !okGauge(g)).out);

console.log("");
console.log("### 같은 문을 「전날 확정 게이지」로 — 17:00 에 확실히 아는 값 (미래 보기 없음)");
stat("전날 선물 몸통 > +0.2%", pick(5, (g) => !!g && g.futuresBody !== null && g.futuresBody > 0.2, true).out);
stat("전날 선물 몸통 < -0.2%", pick(5, (g) => !!g && g.futuresBody !== null && g.futuresBody < -0.2, true).out);
stat("전날 문 통과 · 상위 5", pick(5, okGauge, true).out);
stat("전날 문 막힘 · 상위 5", pick(5, (g) => has(g) && !okGauge(g), true).out);
