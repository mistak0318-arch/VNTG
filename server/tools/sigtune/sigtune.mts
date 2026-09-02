/**
 * 신호등 전면 재검토 — 1부: 기준별 원시값 분포 × 앞으로의 초과수익
 *
 * 실행: server 디렉토리에서  npx tsx <이 파일>
 *
 * 수익률은 **그날 시장 중앙값 대비 초과분**(ex20 = d20 − 같은 날 표본 중앙값)으로 잰다.
 * 쏠림→급락 한 계절 표본이라 절대 수익률로 재면 장세가 판정을 통째로 끌고 간다.
 */
import { pathToFileURL } from "node:url";
import { writeFileSync } from "node:fs";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const SRC = dirname(fileURLToPath(import.meta.url)) + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);

const { loadSamples, MA_PERIODS } = await imp("signalSamples.ts");
const { regimeMap } = await imp("signalSimulate.ts");
const { getConfig, DEFAULT_CONFIG } = await imp("signalLight.ts");

type S = any;
const file = await loadSamples();
const S: S[] = file.samples;
const cfg = await getConfig();

/* ---------- 초과수익 ---------- */
const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
const med = (a: number[]) => { if (!a.length) return NaN; const b=[...a].sort((x,y)=>x-y); const m=b.length>>1; return b.length%2?b[m]:(b[m-1]+b[m])/2; };
const dayMed20 = new Map<string, number>(), dayMed5 = new Map<string, number>();
for (const [d, rows] of byDate) {
  dayMed20.set(d, med(rows.map(r=>r.d20).filter((v): v is number => v!==null)));
  dayMed5.set(d, med(rows.map(r=>r.d5).filter((v): v is number => v!==null)));
}
for (const s of S) {
  s.ex20 = s.d20===null ? null : s.d20 - dayMed20.get(s.date)!;
  s.ex5 = s.d5===null ? null : s.d5 - dayMed5.get(s.date)!;
}
const reg = regimeMap(S, cfg);
const dates = [...byDate.keys()].sort();
const midDate = dates[Math.floor(dates.length/2)];
for (const s of S) { s.reg = reg.get(s.date) ?? "?"; s.half = s.date < midDate ? "F" : "B"; }

/* ---------- 요약 통계 ---------- */
interface Cut { n: number; med: number; trim: number; win: number }
function cut(rows: S[], key = "ex20"): Cut {
  const v = rows.map(r=>r[key]).filter((x): x is number => x!==null && Number.isFinite(x)).sort((a,b)=>a-b);
  if (!v.length) return { n:0, med:NaN, trim:NaN, win:NaN };
  const k = v.length>=50 ? Math.floor(v.length*0.02) : 0;
  const inner = k ? v.slice(k, v.length-k) : v;
  return { n:v.length, med:med(v), trim: inner.reduce((a,b)=>a+b,0)/inner.length, win: 100*v.filter(x=>x>0).length/v.length };
}
const f1 = (x: number) => Number.isFinite(x) ? (x>=0?"+":"")+x.toFixed(2) : "  —  ";
const f0 = (x: number) => Number.isFinite(x) ? x.toFixed(1) : " — ";
function line(label: string, rows: S[]): string {
  const a = cut(rows), bu = cut(rows.filter(r=>r.reg==="bull")), be = cut(rows.filter(r=>r.reg==="bear")), F = cut(rows.filter(r=>r.half==="F")), B = cut(rows.filter(r=>r.half==="B"));
  const c = (x: Cut) => `${String(x.n).padStart(6)} ${f1(x.med)} ${f1(x.trim)} ${f0(x.win).padStart(5)}`;
  return `${label.padEnd(22)} | ${c(a)} | 강 ${c(bu)} | 약 ${c(be)} | 앞 ${c(F)} | 뒤 ${c(B)}`;
}
const HEAD = `${"구간".padEnd(22)} | ${"n".padStart(6)}  중앙   절사   승률 | 강세장 n med trim win | 약세장 … | 앞 … | 뒤 …`;

/* ---------- 기준별 원시값 (gradeOf 의 value 단계와 같은 규칙) ---------- */
function rawOf(f: S, key: string, c: any): number | null {
  const fd = cfg.flowDays;
  const pick = (d5: any, d10: any, d20: any) => { const o=[[5,d5],[10,d10],[20,d20]] as [number, number|null][]; let b=o[0]; for (const x of o) if (Math.abs(x[0]-fd)<Math.abs(b[0]-fd)) b=x; return b[1]; };
  switch (key) {
    case "trend": { const vs=[...cfg.maLines].sort((a: number,b: number)=>a-b).map((p: number)=>f.ma[MA_PERIODS.indexOf(p)]); if (vs.some((v: any)=>v==null)) return null; const full = f.cur>=vs[0] && vs.every((x: number,i: number)=>i===0||vs[i-1]>=x); return full?2:f.cur>=vs[0]?1:0; }
    case "newHigh": case "nearHigh": return f.hiPct;
    case "pullback": { if (f.hiPct===null) return null; const m20=f.ma[MA_PERIODS.indexOf(20)]; if (m20==null) return null; return (f.hiPct>=85 && f.hiPct<=95 && f.cur>=m20) ? 1 : 0; }
    case "disparity": return f.disp; case "ma5Gap": return f.ma5Gap; case "overhead": return f.over; case "volume": return f.volEok;
    case "naverTheme": return f.theme; case "etfBacking": return f.etfBack;
    case "foreignFlow": return pick(f.fgn5,f.fgn10,f.fgn20); case "instFlow": return pick(f.inst5,f.inst10,f.inst20);
    case "flowStreak": return f.fgnStreak;
    case "flowPersist": { const spans=[5,10,20,60].filter(n=>n<=(c.span??60)); const by: any={5:[f.fgn5,f.inst5],10:[f.fgn10,f.inst10],20:[f.fgn20,f.inst20],60:[f.fgn60,f.inst60]}; const vals: any[]=[]; for (const n of spans) vals.push(by[n][0],by[n][1]); const m=vals.filter(v=>v!==null&&Number.isFinite(v)); if (m.length<Math.max(2,spans.length)) return null; return m.filter((v: number)=>v>0).length; }
    case "flowAccel": { const long=c.span??20; const [sv,sn,lv,ln]= long>=60?[f.fgn20,20,f.fgn60,60]: long>=20?[f.fgn5,5,f.fgn20,20]:[f.fgn5,5,f.fgn10,10]; if (sv===null||lv===null) return null; const dS=sv/sn, dL=lv/ln; if (dL>0) return dS/dL; return dS>0 ? 99 : -99; }
    case "smartMoney": { const long=c.span??20; return long>=60?f.smart60: long>=20?f.smart20:f.smart5; }
    case "marketCap": case "largeCap": return f.mktCap;
    case "flowRatio": { const long=c.span??20; const fg= long>=60?f.fgn60: long>=20?f.fgn20:f.fgn5; const it= long>=60?f.inst60: long>=20?f.inst20:f.inst5; if (fg===null||it===null||f.mktCap===null||f.mktCap<=0) return null; return (((fg+it)/100)/f.mktCap)*100; }
    case "shortSaleUp": { if (f.short5===null) return null; const diff = f.short20===null?0:f.short5-f.short20; return diff + Math.max(0,(f.short5-20)/20); }
    case "lendingUp": return f.loanUp20; case "foreignRatioUp": return f.fgnRatioUp20;
    case "profitGrowth": return f.profitYoY; case "qStreak": return f.qStreak; case "qYoY": return f.qYoY; case "qMargin": return f.qMargin;
    default: return null;
  }
}

/* 버킷 경계 — 기준마다 뜻이 있는 눈금. 없으면 십분위 */
const EDGES: Record<string, number[]> = {
  trend: [0,1,2], pullback: [0,1],
  newHigh: [0,80,85,90,93,95,97,98,99,100], nearHigh: [0,80,85,90,93,95,97,98,99,100],
  disparity: [0,0.01,2,4,6,8,10,15,20,25], ma5Gap: [-99,0,1,2,3,4,6,8,12],
  overhead: [0,5,10,20,30,40,50,60,70,80], volume: [100,150,200,300,500,1000,2000,5000],
  naverTheme: [-99,-2,-1,-0.5,0,0.5,1,1.5,2,3], etfBacking: [-99,-2,-1,-0.5,0,0.5,1,1.5,2,3],
  foreignFlow: [-1e9,-30000,-10000,-3000,-1000,0,1000,3000,10000,30000], instFlow: [-1e9,-20000,-5000,-1000,0,1000,5000,20000],
  flowStreak: [0,1,2,3,5,8], flowPersist: [0,1,2,3,4,5,6,7,8],
  flowAccel: [-99.5,-98,0,0.5,1,1.5,2,2.5,4,98.5], smartMoney: [-1e9,-5000,-2000,-500,0,500,2000,5000,20000],
  marketCap: [0,1000,3000,5000,10000,30000,100000,300000], largeCap: [0,1000,3000,5000,10000,30000,100000,300000],
  flowRatio: [-99,-1,-0.5,-0.25,0,0.25,0.5,0.75,1,2], shortSaleUp: [-99,-2,-1,-0.5,0,0.5,1,2,5],
  lendingUp: [-999,-30,-15,-5,0,5,15,30,60], foreignRatioUp: [-99,-1,-0.5,-0.1,0,0.1,0.5,1,2],
};
const KEYS: string[] = cfg.checks.map((c: any)=>c.key);
const out: string[] = [];
const P = (s: string) => { out.push(s); console.log(s); };

P(`표본 ${S.length} · ${dates.length}일 (${dates[0]}~${dates.at(-1)}) · 앞/뒤 경계 ${midDate}`);
const regCount: Record<string, number> = {}; for (const d of dates) regCount[reg.get(d) ?? "?"] = (regCount[reg.get(d) ?? "?"] ?? 0)+1;
P(`장세(bullAt ${cfg.bullAt}): ${JSON.stringify(regCount)} 일`);
P(`전체 ex20 기준선: ${JSON.stringify(cut(S))}  (정의상 중앙값≈0)`);
P(`절대 d20: 강세 ${f1(cut(S.filter(s=>s.reg==="bull"),"d20").med)} · 약세 ${f1(cut(S.filter(s=>s.reg==="bear"),"d20").med)} · 앞 ${f1(cut(S.filter(s=>s.half==="F"),"d20").med)} · 뒤 ${f1(cut(S.filter(s=>s.half==="B"),"d20").med)}`);
P("");
P("날짜별 장세·시장 중앙값 d20:");
P(dates.map(d=>`${d.slice(4)}${reg.get(d)==="bull"?"강":"약"}${f1(dayMed20.get(d)!)}`).join("  "));
P("");

for (const c of cfg.checks) {
  const key = c.key;
  const vals = S.map(s=>({ v: rawOf(s,key,c), s })).filter(x=>x.v!==null) as {v:number,s:S}[];
  if (!vals.length) { P(`\n#### ${key} (${c.label}) — 표본에 없음`); continue; }
  const cov = (100*vals.length/S.length).toFixed(0);
  P(`\n#### ${key} · ${c.label} · 축 ${c.axis} · ${c.enabled?"켜짐":"꺼짐"} w${c.weight} · 50점 ${c.threshold} / 100점 ${c.strongAt}${c.regime?` · ${c.regime}`:""}${c.veto?` · veto ${c.vetoAt}`:""} · 커버 ${cov}%`);
  let edges = EDGES[key];
  if (!edges) { const v=vals.map(x=>x.v).sort((a,b)=>a-b); edges=[]; for (let i=0;i<10;i++) edges.push(v[Math.floor(i*v.length/10)]); }
  P(HEAD);
  for (let i=0;i<edges.length;i++) {
    const lo=edges[i], hi= i+1<edges.length? edges[i+1] : Infinity;
    const rows = vals.filter(x=> x.v>=lo && x.v<hi).map(x=>x.s);
    if (!rows.length) continue;
    P(line(`${lo === -1e9||lo===-99||lo===-999||lo===-99.5? "<" : lo}${hi===Infinity?"~":"~"+hi}`, rows));
  }
  /* 지금 문턱대로 0/50/100 */
  const g100 = vals.filter(x=> x.v>=Math.max(c.threshold,c.strongAt)).map(x=>x.s);
  const g50 = vals.filter(x=> x.v>=Math.min(c.threshold,c.strongAt) && x.v<Math.max(c.threshold,c.strongAt)).map(x=>x.s);
  const g0 = vals.filter(x=> x.v<Math.min(c.threshold,c.strongAt)).map(x=>x.s);
  P(line("  ▸ 지금 100점", g100)); P(line("  ▸ 지금 50점", g50)); P(line("  ▸ 지금 0점", g0));
}

writeFileSync("C:/Users/Jaemin Kim/AppData/Local/Temp/claude/K--0000-3740--------------00-----2-AI------260810------/7fd40f4e-1d14-4899-892f-e551fe467027/scratchpad/sigtune-1.txt", out.join("\n"), "utf-8");
