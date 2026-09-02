/**
 * 신호등 전면 재검토 — 2부: **시총 중립** 초과수익으로 기준별 힘 + 문턱 격자
 *
 * exs20 = d20 − (같은 날 · 같은 시총 5분위) 중앙값.  1부에서 시총이 전부를 지배하는 것이
 * 드러났다 — 이걸 빼야 수급·추세·위험 기준의 「자기 힘」이 보인다.
 * 실적(profitFill.json)이 있으면 그 시점에 공시된 것만 붙인다(signalBacktest 와 같은 규칙).
 *
 * 실행: server 디렉토리에서  npx tsx <이 파일>
 */
import { pathToFileURL } from "node:url";
import { writeFileSync, readFileSync, existsSync } from "node:fs";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const SRC = dirname(fileURLToPath(import.meta.url)) + "/../../src/";
const SP = "C:/Users/Jaemin Kim/AppData/Local/Temp/claude/K--0000-3740--------------00-----2-AI------260810------/7fd40f4e-1d14-4899-892f-e551fe467027/scratchpad/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);
const { loadSamples, MA_PERIODS } = await imp("signalSamples.ts");
const { regimeMap } = await imp("signalSimulate.ts");
const { getConfig } = await imp("signalLight.ts");

type S = any;
const file = await loadSamples();
const S: S[] = file.samples;
const cfg = await getConfig();
const out: string[] = [];
const P = (s = "") => { out.push(s); console.log(s); };

/* ---------- 실적 붙이기 ---------- */
let profitN = 0, quarterN = 0;
if (existsSync(SP + "profitFill.json")) {
  const db = JSON.parse(readFileSync(SP + "profitFill.json", "utf-8"));
  const knownAt = (period: string) => { const y=+period.slice(0,4), m=+period.slice(4,6); if (!y||!m) return "99999999"; const d=new Date(Date.UTC(y,m,0)); d.setUTCDate(d.getUTCDate()+(m===12?90:45)); return d.toISOString().slice(0,10).replace(/-/g,""); };
  for (const s of S) {
    const rec = db[s.code]; if (!rec) continue;
    /* 연간 — 4월부터 직전 연도 */
    const byYear = new Map<number, number>();
    for (const p of rec.annual ?? []) { const y=Number(String(p.label).replace(/[^0-9]/g,"").slice(0,4)); if (y>1990 && p.op!==null && p.op!==undefined) byYear.set(y,p.op); }
    if (byYear.size>=2) { const y=+s.date.slice(0,4), m=+s.date.slice(4,6); const latest = m>=4? y-1 : y-2; const cur=byYear.get(latest), prev=byYear.get(latest-1); if (cur!==undefined && prev!==undefined && prev!==0) { s.profitYoY = ((cur-prev)/Math.abs(prev))*100; profitN++; } }
    /* 분기 — 그 시점에 공시된 것만 */
    const rows = (rec.quarters ?? []).map((r: any)=>({ r, known: knownAt(r.period) }));
    if (rows.length>=2) { const seen = rows.filter((x: any)=>x.known<=s.date); if (seen.length) { const last=seen[0].r; const vals=seen.map((x: any)=>x.r.operatingProfit).filter((v: any)=>v!==null); let streak: number|null=null; if (vals.length>=2){ streak=0; for (let i=0;i<vals.length-1;i++){ if (vals[i]>vals[i+1]) streak++; else break; } } s.qStreak=streak; s.qYoY=last.yoy; s.qQoQ=last.qoq; s.qMargin=last.margin; quarterN++; } }
  }
}

/* ---------- 초과수익: 날짜 중앙값 · 날짜×시총5분위 중앙값 ---------- */
const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
const med = (a: number[]) => { if (!a.length) return NaN; const b=[...a].sort((x,y)=>x-y); const m=b.length>>1; return b.length%2?b[m]:(b[m-1]+b[m])/2; };
for (const [, rows] of byDate) {
  const m20 = med(rows.map(r=>r.d20).filter((v): v is number=>v!==null));
  const withCap = rows.filter(r=>r.mktCap!==null).sort((a,b)=>a.mktCap-b.mktCap);
  withCap.forEach((r,i)=>{ r.q = Math.min(4, Math.floor(i*5/withCap.length)); });
  const qMed: number[] = [0,1,2,3,4].map(q=> med(withCap.filter(r=>r.q===q).map(r=>r.d20).filter((v): v is number=>v!==null)));
  for (const r of rows) { r.ex20 = r.d20===null? null : r.d20-m20; r.exs20 = (r.d20===null || r.q===undefined) ? null : r.d20 - qMed[r.q]; }
}
const reg = regimeMap(S, cfg);
const dates = [...byDate.keys()].sort();
const midDate = dates[Math.floor(dates.length/2)];
for (const s of S) { s.reg = reg.get(s.date) ?? "?"; s.half = s.date<midDate?"F":"B"; }

interface Cut { n: number; med: number; win: number }
function cut(rows: S[], key="exs20"): Cut { const v=rows.map(r=>r[key]).filter((x): x is number=>x!==null&&Number.isFinite(x)); if(!v.length) return {n:0,med:NaN,win:NaN}; return { n:v.length, med:med(v), win:100*v.filter(x=>x>0).length/v.length }; }
const f1=(x:number)=>Number.isFinite(x)?(x>=0?"+":"")+x.toFixed(1):" — ";
const f0=(x:number)=>Number.isFinite(x)?x.toFixed(0):"—";
const cell=(c: Cut)=>`${String(c.n).padStart(5)} ${f1(c.med).padStart(5)}/${f0(c.win).padStart(2)}`;
function line(label: string, rows: S[], key="exs20"): string {
  const a=cut(rows,key), bu=cut(rows.filter(r=>r.reg==="bull"),key), be=cut(rows.filter(r=>r.reg==="bear"),key), F=cut(rows.filter(r=>r.half==="F"),key), B=cut(rows.filter(r=>r.half==="B"),key);
  const ok = [bu,be,F,B].every(c=>c.n>=150 && c.med>0 && c.win>50) ? " ✅" : [bu,be,F,B].every(c=>c.n>=150 && c.med<0 && c.win<50) ? " ❌" : "";
  return `${label.padEnd(16)}|${cell(a)} |강${cell(bu)} |약${cell(be)} |앞${cell(F)} |뒤${cell(B)}${ok}`;
}
const HEAD = `${"구간".padEnd(16)}|    n  med/win |강세장         |약세장         |앞             |뒤`;

/* ---------- 원시값 ---------- */
function rawOf(f: S, key: string, c: any): number | null {
  const fd = cfg.flowDays;
  const pick=(d5:any,d10:any,d20:any)=>{const o=[[5,d5],[10,d10],[20,d20]] as [number,number|null][]; let b=o[0]; for(const x of o) if(Math.abs(x[0]-fd)<Math.abs(b[0]-fd)) b=x; return b[1];};
  switch(key){
    case "trend": { const vs=[...cfg.maLines].sort((a:number,b:number)=>a-b).map((p:number)=>f.ma[MA_PERIODS.indexOf(p)]); if(vs.some((v:any)=>v==null)) return null; const full=f.cur>=vs[0]&&vs.every((x:number,i:number)=>i===0||vs[i-1]>=x); return full?2:f.cur>=vs[0]?1:0; }
    case "newHigh": case "nearHigh": return f.hiPct;
    case "pullback": { if(f.hiPct===null) return null; const m20=f.ma[MA_PERIODS.indexOf(20)]; if(m20==null) return null; return (f.hiPct>=85&&f.hiPct<=95&&f.cur>=m20)?1:0; }
    case "disparity": return f.disp; case "ma5Gap": return f.ma5Gap; case "overhead": return f.over; case "volume": return f.volEok;
    case "naverTheme": return f.theme; case "etfBacking": return f.etfBack;
    case "foreignFlow": return pick(f.fgn5,f.fgn10,f.fgn20); case "instFlow": return pick(f.inst5,f.inst10,f.inst20);
    case "flowStreak": return f.fgnStreak;
    case "flowPersist": { const spans=[5,10,20,60].filter(n=>n<=(c.span??60)); const by:any={5:[f.fgn5,f.inst5],10:[f.fgn10,f.inst10],20:[f.fgn20,f.inst20],60:[f.fgn60,f.inst60]}; const vals:any[]=[]; for(const n of spans) vals.push(by[n][0],by[n][1]); const m=vals.filter(v=>v!==null&&Number.isFinite(v)); if(m.length<Math.max(2,spans.length)) return null; return m.filter((v:number)=>v>0).length; }
    case "flowAccel": { const long=c.span??20; const [sv,sn,lv,ln]= long>=60?[f.fgn20,20,f.fgn60,60]: long>=20?[f.fgn5,5,f.fgn20,20]:[f.fgn5,5,f.fgn10,10]; if(sv===null||lv===null) return null; const dS=sv/sn, dL=lv/ln; if(dL>0) return dS/dL; return dS>0?99:-99; }
    case "smartMoney": { const long=c.span??20; return long>=60?f.smart60: long>=20?f.smart20:f.smart5; }
    case "marketCap": case "largeCap": return f.mktCap;
    case "flowRatio": { const long=c.span??20; const fg= long>=60?f.fgn60: long>=20?f.fgn20:f.fgn5; const it= long>=60?f.inst60: long>=20?f.inst20:f.inst5; if(fg===null||it===null||f.mktCap===null||f.mktCap<=0) return null; return (((fg+it)/100)/f.mktCap)*100; }
    case "shortSaleUp": { if(f.short5===null) return null; const diff=f.short20===null?0:f.short5-f.short20; return diff+Math.max(0,(f.short5-20)/20); }
    case "lendingUp": return f.loanUp20; case "foreignRatioUp": return f.fgnRatioUp20;
    case "profitGrowth": return f.profitYoY??null; case "qStreak": return f.qStreak??null; case "qYoY": return f.qYoY??null; case "qMargin": return f.qMargin??null;
    default: return null;
  }
}
/* 파생 — 기준에 없지만 벤티지가 짚은 것 */
const EXTRA: Record<string,(f:S)=>number|null> = {
  fgnRatioNow: f=>f.fgnRatio,                           // 외국인 지분율 수준
  fgnRatio20: f=>f.mktCap&&f.fgn20!==null? (f.fgn20/100)/f.mktCap*100 : null,   // 외국인만 시총대비 20일
  instRatio20: f=>f.mktCap&&f.inst20!==null? (f.inst20/100)/f.mktCap*100 : null, // 기관만
  smartRatio20: f=>f.mktCap&&f.smart20!==null? (f.smart20/100)/f.mktCap*100 : null, // 주포
  fgnRatio60: f=>f.mktCap&&f.fgn60!==null? (f.fgn60/100)/f.mktCap*100 : null,
  qQoQ: f=>f.qQoQ??null,
  shortDiff: f=>(f.short5!==null&&f.short20!==null)? f.short5-f.short20 : null, // 공매도 비중 변화만
  shortLevel: f=>f.short5,                                                       // 공매도 비중 수준
};
const EDGES: Record<string, number[]> = {
  trend:[0,1,2], pullback:[0,1],
  newHigh:[0,70,80,85,90,93,95,97,99,100], nearHigh:[0,70,80,85,90,93,95,97,99,100],
  disparity:[0,0.01,2,4,6,8,10,15,20,25], ma5Gap:[-99,0,1,2,3,4,6,8,12],
  overhead:[0,5,10,20,30,40,50,60,70,80], volume:[100,150,200,300,500,1000,2000,5000],
  naverTheme:[-99,-2,-1,-0.5,0,0.5,1,1.5,2,3], etfBacking:[-99,-2,-1,-0.5,0,0.5,1,1.5,2,3],
  foreignFlow:[-1e9,-30000,-10000,-3000,-1000,0,1000,3000,10000,30000], instFlow:[-1e9,-20000,-5000,-1000,0,1000,5000,20000],
  flowStreak:[0,1,2,3,5,8], flowPersist:[0,1,2,3,4,5,6,7,8],
  flowAccel:[-99.5,-98,0,0.5,1,1.5,2,2.5,4,98.5], smartMoney:[-1e9,-5000,-2000,-500,0,500,2000,5000,20000],
  marketCap:[0,1000,3000,5000,10000,30000,100000,300000], largeCap:[0,1000,3000,5000,10000,30000,100000,300000],
  flowRatio:[-99,-1,-0.5,-0.25,0,0.25,0.5,0.75,1,1.5,2,3], shortSaleUp:[-99,-2,-1,-0.5,0,0.5,1,2,5],
  lendingUp:[-999,-30,-15,-5,0,5,15,30,60], foreignRatioUp:[-99,-1,-0.5,-0.1,0,0.1,0.5,1,2],
  profitGrowth:[-1e9,-50,-20,0,10,20,50,100], qStreak:[0,1,2,3,4,5], qYoY:[-1e9,-50,-20,0,10,20,50,100,300], qMargin:[-1e9,0,3,5,10,15,20,30],
  fgnRatioNow:[0,1,3,5,10,20,30,40,50], fgnRatio20:[-99,-1,-0.5,-0.25,0,0.25,0.5,1,2], instRatio20:[-99,-1,-0.5,-0.25,0,0.25,0.5,1,2], smartRatio20:[-99,-0.5,-0.25,-0.1,0,0.1,0.25,0.5,1], fgnRatio60:[-99,-2,-1,-0.5,0,0.5,1,2,4],
  qQoQ:[-1e9,-50,-20,0,10,20,50,100,300], shortDiff:[-99,-3,-2,-1,-0.5,0,0.5,1,2,3,5], shortLevel:[0,0.5,1,2,3,5,8,12,20,30],
};
const lo$=(lo:number)=> lo<=-98? "<" : String(lo);

P(`표본 ${S.length} · ${dates.length}일 · 앞/뒤 ${midDate} · 실적 붙임: 연간 ${profitN} · 분기 ${quarterN}`);
P(`exs20 = d20 − 같은날·같은 시총5분위 중앙값. 표: n med/win. ✅=강·약·앞·뒤 넷 다 med>0 & win>50 (n≥150) · ❌=넷 다 반대`);
P();
P("시총 5분위 자체 (exs20 는 정의상 0 근처, ex20 은 1부 그대로):");
P(HEAD);
for (const q of [0,1,2,3,4]) P(line(`Q${q+1} ex20`, S.filter(s=>s.q===q), "ex20"));

const ALL = [...cfg.checks.map((c:any)=>({key:c.key, c, get:(f:S)=>rawOf(f,c.key,c), title:`${c.key} · ${c.label} · ${c.axis} · ${c.enabled?"켜짐":"꺼짐"} w${c.weight} · ${c.threshold}/${c.strongAt}${c.regime?` · ${c.regime}`:""}`})),
  ...Object.entries(EXTRA).map(([key,get])=>({key, c:null as any, get, title:`${key} (파생)`}))];

for (const it of ALL) {
  const vals = S.map(s=>({v: it.get(s), s})).filter(x=>x.v!==null && Number.isFinite(x.v)) as {v:number,s:S}[];
  if (!vals.length) { P(`\n#### ${it.title} — 없음`); continue; }
  P(`\n#### ${it.title} · 커버 ${(100*vals.length/S.length).toFixed(0)}%`);
  P(HEAD);
  let edges = EDGES[it.key];
  if (!edges) { const v=vals.map(x=>x.v).sort((a,b)=>a-b); edges=[]; for(let i=0;i<10;i++) edges.push(v[Math.floor(i*v.length/10)]); }
  for (let i=0;i<edges.length;i++) { const lo=edges[i], hi=i+1<edges.length?edges[i+1]:Infinity; const rows=vals.filter(x=>x.v>=lo&&x.v<hi).map(x=>x.s); if(rows.length) P(line(`${lo$(lo)}~${hi===Infinity?"":hi}`, rows)); }
}

writeFileSync(SP + "sigtune-2.txt", out.join("\n"), "utf-8");
