/**
 * **항해일지가 무엇을 보고 사야 하나** (2026-11-17) — 벤티지: "신호등이 신뢰할만한 값이
 * 아닌거 같아. 니가 생각하는 신뢰할만한 데이터 꾸러미 조합을 해서 다시 항해일지의
 * 투자 로직을 재편성 해서 구성해볼래?"
 *
 * ## 무엇을 재나
 *
 * 항해일지(CIS)는 **하루에 몇 개를 골라** 손절 -7%, 최대 12거래일로 들고 간다. 그러니
 * 「초록 전체의 평균」이 아니라 **날짜별 상위 N 개**의 성적을 재야 한다 — 실제로 사는
 * 것이 그것이기 때문이다.
 *
 * 성적은 세 가지로 본다.
 *   exs      **시총 중립 초과수익** — 그날 같은 시총 5분위의 중앙값을 뺀다.
 *            (2026-09-02 에 확인했다 — 시총이 표본을 지배해서 빼지 않으면 크기만 잰다)
 *   승률      exs > 0 인 비율
 *   손절      -7% 에 먼저 닿은 비율. **여태 재던 d20 은 「손절 없는 사람」의 성적이다**
 *
 * ⚠️ 손절 판정은 **근사**다. 표본에는 20일 최대/최저와 그 날짜만 있고 가는 길은 없다.
 * 최저가 -7% 아래이고 그 날이 최고 날보다 앞이면 손절된 것으로 센다. 길을 모르므로
 * 「확실히 손절」과 「확실히 아님」 사이는 가를 수 없다 — 그래서 이 숫자는 **서로 견주는
 * 데만** 쓰고 절대값으로 읽지 않는다.
 *
 * 실행: server 에서  npx tsx tools/sigtune/cisBundle.mts
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

const med = (a: number[]) => {
  if (!a.length) return NaN;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
};

/* ── 시총 중립 ── 날짜별 5분위마다 중앙값을 뺀다 */
const byDate = new Map<string, S[]>();
for (const s of S) {
  const arr = byDate.get(s.date);
  if (arr) arr.push(s);
  else byDate.set(s.date, [s]);
}
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

/** -7% 에 먼저 닿았나 (근사 — 머리말 참고) */
function stopped(s: S): boolean | null {
  if (s.mae20 === null || s.mae20 === undefined) return null;
  if (s.mae20 > -7) return false;
  if (s.maeDay === null || s.mfeDay === null) return null;
  return s.maeDay <= 12 && s.maeDay <= s.mfeDay;
}

interface Row {
  n: number;
  x5: number;
  x10: number;
  x20: number;
  win: number;
  stop: number;
  uniq: number;
}

function stat(rows: S[]): Row {
  const g = (k: string) => rows.map((r) => r[k]).filter((v): v is number => v !== null && Number.isFinite(v));
  const x20 = g("xd20");
  const st = rows.map(stopped).filter((v): v is boolean => v !== null);
  return {
    n: rows.length,
    x5: med(g("xd5")),
    x10: med(g("xd10")),
    x20: med(x20),
    win: x20.length ? (100 * x20.filter((v) => v > 0).length) / x20.length : NaN,
    stop: st.length ? (100 * st.filter(Boolean).length) / st.length : NaN,
    uniq: new Set(rows.map((r) => r.code)).size,
  };
}

const f1 = (v: number) => (Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(1)}` : "  — ");
const f0 = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : " —");
function line(label: string, r: Row): string {
  return `${label.padEnd(38)}|${String(r.n).padStart(6)} |${f1(r.x5).padStart(6)}${f1(r.x10).padStart(7)}${f1(r.x20).padStart(7)} |${f0(r.win).padStart(5)}%|${f0(r.stop).padStart(5)}%|${String(r.uniq).padStart(5)}`;
}
const HEAD = `${"집합".padEnd(38)}|${"n".padStart(6)} |${"x5".padStart(6)}${"x10".padStart(7)}${"x20".padStart(7)} |${"승률".padStart(4)}|${"손절".padStart(4)}|${"고유".padStart(5)}`;

/** 날짜마다 점수 상위 N 개만 — 항해일지가 실제로 사는 방식 */
function topN(score: (s: S) => number | null, n: number, filter?: (s: S) => boolean): S[] {
  const out: S[] = [];
  for (const [, rows] of byDate) {
    const ok = rows.filter((r) => (filter ? filter(r) : true));
    const scored = ok.map((r) => ({ r, v: score(r) })).filter((x) => x.v !== null && Number.isFinite(x.v!));
    scored.sort((a, b) => b.v! - a.v!);
    for (const x of scored.slice(0, n)) out.push(x.r);
  }
  return out;
}

const dates = [...byDate.keys()].sort();
console.log(`표본 ${S.length} · 종목 ${file.codeCount} · 날짜 ${dates.length} (${dates[0]}~${dates[dates.length - 1]})`);
console.log(`설정 세대 ${cfg.configVersion} · greenAt ${cfg.greenAt} · 장세: 강 ${[...reg.values()].filter((v) => v === "bull").length} / 약 ${[...reg.values()].filter((v) => v === "bear").length}\n`);

/* 실전 채점 — 한 번만 하고 붙여 둔다 */
for (const s of S) {
  const r = scoreFeat(s, cfg, reg.get(s.date));
  s.sig = r ? r.score : null;
  s.lvl = r ? r.level : null;
}

console.log("## 1. 지금 항해일지가 보는 것 — 신호등\n");
console.log(HEAD);
console.log(line("전체 (기준선)", stat(S)));
console.log(line("초록", stat(S.filter((s) => s.lvl === "green"))));
console.log(line("초록 + 점수 55↑ (CIS 문턱)", stat(S.filter((s) => s.lvl === "green" && s.sig >= 55))));
console.log(line("노랑", stat(S.filter((s) => s.lvl === "yellow"))));
console.log(line("빨강", stat(S.filter((s) => s.lvl === "red"))));
console.log(line("신호등 점수 상위 10/일", stat(topN((s) => s.sig, 10, (s) => s.lvl !== "red"))));
console.log(line("신호등 점수 상위 3/일", stat(topN((s) => s.sig, 3, (s) => s.lvl !== "red"))));

console.log("\n## 2. 재료 하나씩 — 날짜별 상위 10 (거래대금 50억↑ · 시총 1,000억↑)\n");
const liquid = (s: S) => (s.volEok ?? 0) >= 50 && (s.mktCap ?? 0) >= 1000;
const FEATS: [string, (s: S) => number | null][] = [
  ["RS60 (60일 상대강도)", (s) => s.rs60],
  ["20일 상승폭 rise20", (s) => s.rise20],
  ["60일 상승폭 rise60", (s) => s.rise60],
  ["섹터 내 상대 secRel", (s) => s.secRel],
  ["섹터 10일 상대 secRel10", (s) => s.secRel10],
  ["섹터 추세 secMT", (s) => s.secMT],
  ["시장 추세 mTrend", (s) => s.mTrend],
  ["외국인 20일 fgn20", (s) => s.fgn20],
  ["외국인 60일 fgn60", (s) => s.fgn60],
  ["기관 20일 inst20", (s) => s.inst20],
  ["스마트머니 20일 smart20", (s) => s.smart20],
  ["외국인 연속일 fgnStreak", (s) => s.fgnStreak],
  ["외국인 지분율 변화 20일", (s) => s.fgnRatioUp20],
  ["분기 영업이익률 qMargin", (s) => s.qMargin],
  ["분기 YoY qYoY", (s) => s.qYoY],
  ["분기 QoQ qQoQ", (s) => s.qQoQ],
  ["흑자 연속 qStreak", (s) => s.qStreak],
  ["52주 고가 근접 hiPct", (s) => s.hiPct],
  ["60일 저점 대비 lo60Pct", (s) => s.lo60Pct],
  ["20일 낙폭 dd20 (작을수록 위)", (s) => (s.dd20 === null ? null : -s.dd20)],
  ["거래량 증가 vGrow", (s) => s.vGrow],
  ["테마 강도 theme", (s) => s.theme],
  ["ETF 뒷배 etfBack", (s) => s.etfBack],
  ["변동성 낮음 (-volat20)", (s) => (s.volat20 === null ? null : -s.volat20)],
  ["공매도 낮음 (-short20)", (s) => (s.short20 === null ? null : -s.short20)],
  ["20일선 이격 좁음 (-|gap20|)", (s) => (s.gap20 === null ? null : -Math.abs(s.gap20))],
];
console.log(HEAD);
const feats = FEATS.map(([k, f]) => ({ k, r: stat(topN(f, 10, liquid)) })).sort((a, b) => b.r.x10 - a.r.x10);
for (const x of feats) console.log(line(x.k, x.r));

console.log("\n## 3. 거꾸로 — 같은 재료의 **하위** 10/일 (방향이 맞는지 확인)\n");
console.log(HEAD);
for (const x of feats.slice(0, 6)) {
  const f = FEATS.find((y) => y[0] === x.k)![1];
  console.log(line(`${x.k} 하위`, stat(topN((s) => (f(s) === null ? null : -f(s)!), 10, liquid))));
}
