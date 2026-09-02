/**
 * 신호등 전면 재검토 — 3부: 설정 조합 → 초록 집합 성적 · 20일 블록별 · walk-forward
 *
 * 채점기는 서버 scoreFeat 와 같은 규칙에 둘을 더한 것:
 *   capAt   값이 이보다 크면 0점 (봉우리형 기준 — 가속·시총대비 수급·이익 증가율)
 *   turnZero  flowAccel 의 「전환」(긴 쪽 순매도·짧은 쪽 순매수)을 100 이 아니라 0 으로
 * 새 기준 둘: fgnRatio20(외국인 시총대비 20일) · shortLevel(공매도 비중 수준)
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
const { loadSamples, MA_PERIODS, scoreFeat } = await imp("signalSamples.ts");
const { regimeMap } = await imp("signalSimulate.ts");
const { getConfig } = await imp("signalLight.ts");

type S = any;
const file = await loadSamples();
const S: S[] = file.samples;
const cfg0 = await getConfig();
const out: string[] = [];
const P = (s = "") => { out.push(s); console.log(s); };

/* ---------- 실적 붙이기 (2부와 같은 규칙) ---------- */
if (existsSync(SP + "profitFill.json")) {
  const db = JSON.parse(readFileSync(SP + "profitFill.json", "utf-8"));
  const knownAt = (period: string) => { const y=+period.slice(0,4), m=+period.slice(4,6); if (!y||!m) return "99999999"; const d=new Date(Date.UTC(y,m,0)); d.setUTCDate(d.getUTCDate()+(m===12?90:45)); return d.toISOString().slice(0,10).replace(/-/g,""); };
  for (const s of S) {
    const rec = db[s.code]; if (!rec) continue;
    const byYear = new Map<number, number>();
    for (const p of rec.annual ?? []) { const y=Number(String(p.label).replace(/[^0-9]/g,"").slice(0,4)); if (y>1990 && p.op!=null) byYear.set(y,p.op); }
    if (byYear.size>=2) { const y=+s.date.slice(0,4), m=+s.date.slice(4,6); const latest=m>=4?y-1:y-2; const cur=byYear.get(latest), prev=byYear.get(latest-1); if (cur!==undefined&&prev!==undefined&&prev!==0) s.profitYoY=((cur-prev)/Math.abs(prev))*100; }
    const rows=(rec.quarters??[]).map((r:any)=>({r,known:knownAt(r.period)}));
    if (rows.length>=2) { const seen=rows.filter((x:any)=>x.known<=s.date); if (seen.length) { const last=seen[0].r; const vals=seen.map((x:any)=>x.r.operatingProfit).filter((v:any)=>v!==null); let streak:number|null=null; if(vals.length>=2){streak=0; for(let i=0;i<vals.length-1;i++){ if(vals[i]>vals[i+1]) streak++; else break; }} s.qStreak=streak; s.qYoY=last.yoy; s.qQoQ=last.qoq; s.qMargin=last.margin; } }
  }
}

/* ---------- 초과수익 ---------- */
const byDate = new Map<string, S[]>();
for (const s of S) (byDate.get(s.date) ?? byDate.set(s.date, []).get(s.date)!).push(s);
const med = (a: number[]) => { if (!a.length) return NaN; const b=[...a].sort((x,y)=>x-y); const m=b.length>>1; return b.length%2?b[m]:(b[m-1]+b[m])/2; };
for (const [, rows] of byDate) {
  const m20 = med(rows.map(r=>r.d20).filter((v): v is number=>v!==null));
  const wc = rows.filter(r=>r.mktCap!==null).sort((a,b)=>a.mktCap-b.mktCap);
  wc.forEach((r,i)=>{ r.q=Math.min(4,Math.floor(i*5/wc.length)); });
  const qMed=[0,1,2,3,4].map(q=>med(wc.filter(r=>r.q===q).map(r=>r.d20).filter((v): v is number=>v!==null)));
  for (const r of rows) { r.ex20=r.d20===null?null:r.d20-m20; r.exs20=(r.d20===null||r.q===undefined)?null:r.d20-qMed[r.q]; }
}
const reg = regimeMap(S, cfg0);
const dates = [...byDate.keys()].sort();
const midDate = dates[Math.floor(dates.length/2)];
const blockOf = new Map<string, number>(); dates.forEach((d,i)=>blockOf.set(d, Math.min(3, Math.floor(i/20))));
for (const s of S) { s.reg=reg.get(s.date)??"?"; s.half=s.date<midDate?"F":"B"; s.blk=blockOf.get(s.date); }

interface Cut { n:number; med:number; win:number; trim:number }
function cut(rows: S[], key="exs20"): Cut { const v=rows.map(r=>r[key]).filter((x): x is number=>x!==null&&Number.isFinite(x)).sort((a,b)=>a-b); if(!v.length) return {n:0,med:NaN,win:NaN,trim:NaN}; const k=v.length>=50?Math.floor(v.length*0.02):0; const inner=k?v.slice(k,v.length-k):v; return { n:v.length, med:med(v), win:100*v.filter(x=>x>0).length/v.length, trim: inner.reduce((a,b)=>a+b,0)/inner.length }; }
const f1=(x:number)=>Number.isFinite(x)?(x>=0?"+":"")+x.toFixed(1):" — ";
const f0=(x:number)=>Number.isFinite(x)?x.toFixed(0):"—";
const cell=(c: Cut)=>`${String(c.n).padStart(5)} ${f1(c.med).padStart(5)}/${f0(c.win).padStart(2)}`;

/* ---------- 원시값 ---------- */
function rawOf(f: S, key: string, c: any, cfg: any): number | null {
  const fd = cfg.flowDays;
  const pick=(d5:any,d10:any,d20:any)=>{const o=[[5,d5],[10,d10],[20,d20]] as [number,number|null][]; let b=o[0]; for(const x of o) if(Math.abs(x[0]-fd)<Math.abs(b[0]-fd)) b=x; return b[1];};
  switch(key){
    case "trend": { const vs=[...cfg.maLines].sort((a:number,b:number)=>a-b).map((p:number)=>f.ma[MA_PERIODS.indexOf(p)]); if(vs.some((v:any)=>v==null)) return null; const full=f.cur>=vs[0]&&vs.every((x:number,i:number)=>i===0||vs[i-1]>=x); return full?100:f.cur>=vs[0]?50:0; }
    case "newHigh": case "nearHigh": return f.hiPct;
    case "disparity": return f.disp; case "ma5Gap": return f.ma5Gap; case "overhead": return f.over; case "volume": return f.volEok;
    case "naverTheme": return f.theme; case "etfBacking": return f.etfBack;
    case "foreignFlow": return pick(f.fgn5,f.fgn10,f.fgn20); case "instFlow": return pick(f.inst5,f.inst10,f.inst20);
    case "flowStreak": return f.fgnStreak;
    case "flowPersist": { const spans=[5,10,20,60].filter(n=>n<=(c.span??60)); const by:any={5:[f.fgn5,f.inst5],10:[f.fgn10,f.inst10],20:[f.fgn20,f.inst20],60:[f.fgn60,f.inst60]}; const vals:any[]=[]; for(const n of spans) vals.push(by[n][0],by[n][1]); const m=vals.filter(v=>v!==null&&Number.isFinite(v)); if(m.length<Math.max(2,spans.length)) return null; return m.filter((v:number)=>v>0).length; }
    case "flowAccel": { const long=c.span??20; const [sv,sn,lv,ln]= long>=60?[f.fgn20,20,f.fgn60,60]: long>=20?[f.fgn5,5,f.fgn20,20]:[f.fgn5,5,f.fgn10,10]; if(sv===null||lv===null) return null; const dS=sv/sn, dL=lv/ln; if(dL>0) return dS/dL; return dS>0?(c.turnZero? -1 : Number.POSITIVE_INFINITY): -1; }
    case "smartMoney": { const long=c.span??20; return long>=60?f.smart60: long>=20?f.smart20:f.smart5; }
    case "marketCap": case "largeCap": return f.mktCap;
    case "flowRatio": { const long=c.span??20; const fg= long>=60?f.fgn60: long>=20?f.fgn20:f.fgn5; const it= long>=60?f.inst60: long>=20?f.inst20:f.inst5; if(fg===null||it===null||f.mktCap===null||f.mktCap<=0) return null; return (((fg+it)/100)/f.mktCap)*100; }
    case "fgnRatio20": return (f.mktCap&&f.fgn20!==null)? (f.fgn20/100)/f.mktCap*100 : null;
    case "shortLevel": return f.short5;
    case "shortSaleUp": { if(f.short5===null) return null; const diff=f.short20===null?0:f.short5-f.short20; return diff+Math.max(0,(f.short5-20)/20); }
    case "lendingUp": return f.loanUp20; case "foreignRatioUp": return f.fgnRatioUp20;
    case "profitGrowth": return f.profitYoY??null; case "qStreak": return f.qStreak??null; case "qYoY": return f.qYoY??null; case "qMargin": return f.qMargin??null;
    default: return null;
  }
}
function grade(v: number, c: any): number {
  if (c.key==="trend") return v;
  if (c.capAt!==undefined && v>c.capAt) return c.capGrade ?? 0;
  if (!Number.isFinite(v)) return v>0?100:0;
  const hi=Math.max(c.threshold,c.strongAt), lo=Math.min(c.threshold,c.strongAt);
  if (c.low) { /* 작을수록 좋음: threshold(50) > strongAt(100) */ return v<=lo?100: v<=hi?50:0; }
  return v>=hi?100: v>=lo?50:0;
}
/* 서버 scoreFeat 와 같은 뼈대 */
function score(f: S, cfg: any, regime?: string): { score:number; level:string; risk:number|null; coverage:number; low:boolean; veto:boolean } | null {
  const axes: Record<string,{sum:number;w:number}> = {}; let coverAll=0, coverGot=0, veto=false;
  for (const c of cfg.checks) {
    if (!c.enabled) continue;
    const skipRegime = cfg.regimeSwitch && c.regime && regime && c.regime!==regime;
    const v = rawOf(f, c.key, c, cfg);
    if (c.veto && c.vetoAt!==undefined && v!==null && Number.isFinite(v)) { if (c.axis==="risk" ? v>=c.vetoAt : v<=c.vetoAt) veto=true; }
    if (skipRegime) continue;
    coverAll+=c.weight; if (v===null) continue; coverGot+=c.weight;
    const g=grade(v,c); (axes[c.axis]??={sum:0,w:0}); axes[c.axis].sum+=g*c.weight; axes[c.axis].w+=c.weight;
  }
  const coverage=coverAll>0?coverGot/coverAll:0; const low=coverAll>0&&coverage<cfg.minCoverage;
  const risk=axes.risk&&axes.risk.w>0?axes.risk.sum/axes.risk.w:null;
  const good=(["trend","flow","value"] as const).map(k=>({k,a:axes[k]})).filter(x=>x.a&&x.a.w>0); if(!good.length) return null;
  const wSum=good.reduce((s,x)=>s+cfg.axisWeights[x.k],0); if(wSum<=0) return null;
  const sc=Math.round(good.reduce((s,x)=>s+(x.a.sum/x.a.w)*cfg.axisWeights[x.k],0)/wSum);
  let level = (risk!==null&&risk>=cfg.riskRedAt&&cfg.riskBlocksGreen)?"red": sc>=cfg.greenAt?"green": sc>=cfg.yellowAt?"yellow":"red";
  if (veto) level="red";
  if (low&&level==="green") level="yellow";
  return { score:sc, level, risk, coverage, low, veto };
}

/* ---------- 설정 만들기 ---------- */
const clone=(o:any)=>JSON.parse(JSON.stringify(o));
function withChecks(base: any, patch: Record<string, any>, extra: any[] = [], top: any = {}) {
  const c=clone(base); Object.assign(c, top);
  for (const k of Object.keys(patch)) { const i=c.checks.findIndex((x:any)=>x.key===k); if (i>=0) Object.assign(c.checks[i], patch[k]); }
  for (const e of extra) c.checks.push(e);
  return c;
}
const OFF_ALL: Record<string,any> = {}; for (const c of cfg0.checks) OFF_ALL[c.key]={enabled:false, veto:false};

/** 현재 저장 설정 (표본에 실적을 붙였으니 약세장 커버리지도 산다) */
const CUR = cfg0;

/** P1 — 2부에서 넷 다 같은 방향인 것만, 봉우리엔 cap */
const P1 = withChecks(cfg0, {
  ...OFF_ALL,
  newHigh:     { enabled:true, regime:"bull", weight:1, threshold:97, strongAt:99 },
  flowPersist: { enabled:true, weight:2, threshold:3, strongAt:7, span:60 },
  flowAccel:   { enabled:true, weight:1, threshold:0.5, strongAt:1.0, capAt:4, span:20, turnZero:true },
  flowRatio:   { enabled:true, regime:"bear", weight:1, threshold:0, strongAt:0.25, capAt:1, capGrade:50, veto:true, vetoAt:-1, span:20 },
  qYoY:        { enabled:true, weight:2, threshold:-50, strongAt:0, capAt:50 },
  qMargin:     { enabled:true, weight:1, threshold:0, strongAt:10 },
  overhead:    { enabled:true, regime:"bull", weight:1, threshold:40, strongAt:65, veto:false },
  ma5Gap:      { enabled:true, weight:1, threshold:8, strongAt:12 },
  disparity:   { enabled:true, weight:1, threshold:20, strongAt:25 },
}, [
  { key:"fgnRatio20", label:"외국인 시총대비 20일", axis:"flow", enabled:true, weight:2, threshold:0, strongAt:0.25, capAt:2, capGrade:50, cost:0 },
  { key:"shortLevel", label:"공매도 비중 수준", axis:"flow", enabled:true, weight:1, threshold:5, strongAt:12, capAt:30, cost:1 },
], { greenAt: 70 });

/** P1 변형들 */
const P1_noShort = withChecks(P1, { shortLevel:{enabled:false} });
const P1_noProfit = withChecks(P1, { qYoY:{enabled:false}, qMargin:{enabled:false} });
const P1_cap = withChecks(P1, { marketCap:{ enabled:true, weight:1, threshold:5000, strongAt:3000, low:true } });   // 옛 방향(작을수록)
const P1_big = withChecks(P1, { largeCap:{ enabled:true, weight:1, threshold:100000, strongAt:300000 } });          // 이 계절 방향(클수록)
const P1_flowBoth = withChecks(P1, { flowRatio:{ regime:undefined } });
const P1_noVeto = withChecks(P1, { flowRatio:{ veto:false } });
const CUR_fixed = withChecks(cfg0, { overhead:{veto:false}, flowAccel:{threshold:0.5,strongAt:1.0,capAt:4,turnZero:true}, profitGrowth:{threshold:-50,strongAt:0,capAt:50}, smartMoney:{enabled:false} });

const CONFIGS_EXTRA: [string, any][] = [];
const P1_g60 = withChecks(P1, {}, [], { greenAt: 60 });
const P1_g65 = withChecks(P1, {}, [], { greenAt: 65 });
const P1_noDisp = withChecks(P1, { disparity:{enabled:false} });
const P1_qCap50 = withChecks(P1, { qYoY:{capGrade:50}, qMargin:{capGrade:50} });
const P1_short2 = withChecks(P1, { shortLevel:{weight:2} });
const P1_fgn1 = withChecks(P1, { fgnRatio20:{weight:1} });
const P1_axis = withChecks(P1, {}, [], { axisWeights:{trend:1, flow:1, value:1} });
const P1_qVeto = withChecks(P1, { qMargin:{ veto:true, vetoAt:0 } });
const P1_persistVeto = withChecks(P1, { flowPersist:{ veto:true, vetoAt:1 } });
CONFIGS_EXTRA.push(["P1 적자분기 탈락", P1_qVeto], ["P1 수급지속≤1 탈락", P1_persistVeto]);
const CONFIGS: [string, any][] = [
  ["CUR 지금 설정", CUR], ["CUR+최소수정(veto·가속·이익·주포)", CUR_fixed],
  ["P1 제안", P1], ["P1 greenAt60", P1_g60], ["P1 greenAt65", P1_g65], ["P1 -이격도(20일선)", P1_noDisp], ["P1 실적 cap→50점", P1_qCap50], ["P1 공매도수준 w2", P1_short2], ["P1 외인시총대비 w1", P1_fgn1], ["P1 축무게 1/1/1", P1_axis],
  ["P1 -공매도수준", P1_noShort], ["P1 -실적", P1_noProfit], ["P1 +시총(작을수록,w1)", P1_cap], ["P1 +대형주(클수록,w1)", P1_big], ["P1 수급규모 장세무관", P1_flowBoth], ["P1 -veto", P1_noVeto],
];

function evalCfg(name: string, cfg: any) {
  const rows = S.map(s=>({ s, r: score(s, cfg, reg.get(s.date)) })).filter(x=>x.r);
  const thin = rows.filter(x=>x.r!.low).length;
  const green = rows.filter(x=>x.r!.level==="green").map(x=>x.s);
  const red = rows.filter(x=>x.r!.level==="red").map(x=>x.s);
  const scored = rows.filter(x=>!x.r!.low);
  P(`\n=== ${name} · greenAt ${cfg.greenAt} · 채점 ${rows.length} · 덜잼 ${thin} · 초록 ${green.length} (${(100*green.length/rows.length).toFixed(1)}%) · 빨강 ${red.length}`);
  const L=(label:string, rr:S[], key:string)=>{ const a=cut(rr,key),bu=cut(rr.filter(r=>r.reg==="bull"),key),be=cut(rr.filter(r=>r.reg==="bear"),key),F=cut(rr.filter(r=>r.half==="F"),key),B=cut(rr.filter(r=>r.half==="B"),key); P(`${label.padEnd(14)}|${cell(a)} |강${cell(bu)} |약${cell(be)} |앞${cell(F)} |뒤${cell(B)}`); };
  P(`${"".padEnd(14)}|    n  med/win |강세장         |약세장         |앞             |뒤`);
  L("초록 exs20", green, "exs20"); L("초록 ex20", green, "ex20"); L("초록 d20(절대)", green, "d20"); L("빨강 exs20", red, "exs20");
  /* 20일 블록 넷 */
  P("  블록별 초록 exs20 (n med/win) : " + [0,1,2,3].map(b=>{ const c=cut(green.filter(r=>r.blk===b)); return `B${b+1}[${dates[b*20].slice(4)}~] ${c.n} ${f1(c.med)}/${f0(c.win)}`; }).join(" · "));
  P("  블록별 초록 ex20            : " + [0,1,2,3].map(b=>{ const c=cut(green.filter(r=>r.blk===b),"ex20"); return `B${b+1} ${f1(c.med)}/${f0(c.win)}`; }).join(" · "));
  /* 문턱 훑기 */
  const sweep: string[] = [];
  for (const g of [50,55,60,65,70,75,80,85,90]) { const rr=scored.filter(x=>x.r!.score>=g && x.r!.level!=="red").map(x=>x.s); const a=cut(rr), B=cut(rr.filter(r=>r.half==="B")), be=cut(rr.filter(r=>r.reg==="bear")); sweep.push(`${g}:${a.n} ${f1(a.med)}/${f0(a.win)} 뒤${f1(B.med)}/${f0(B.win)} 약${f1(be.med)}/${f0(be.win)}`); }
  P("  문턱(빨강 제외): " + sweep.join(" | "));
  /* walk-forward: 블록 0..k-1 학습 → 블록 k 채점. 규칙: 학습에서 med>0&win>50 인 가장 낮은 문턱(50~90) */
  const wf: string[] = [];
  for (const k of [1,2,3]) {
    const train=scored.filter(x=>x.s.blk!<k), test=scored.filter(x=>x.s.blk===k);
    let pick: number|null=null;
    for (const g of [50,55,60,65,70,75,80,85,90]) { const c=cut(train.filter(x=>x.r!.score>=g&&x.r!.level!=="red").map(x=>x.s)); if (c.n>=200&&c.med>0&&c.win>50) { pick=g; break; } }
    if (pick===null) { wf.push(`B${k+1}: 문턱 없음`); continue; }
    const c=cut(test.filter(x=>x.r!.score>=pick&&x.r!.level!=="red").map(x=>x.s)); const c2=cut(test.filter(x=>x.r!.score>=pick&&x.r!.level!=="red").map(x=>x.s),"ex20");
    wf.push(`B${k+1}: 문턱${pick} → n${c.n} exs${f1(c.med)}/${f0(c.win)} ex${f1(c2.med)}/${f0(c2.win)}`);
  }
  P("  walk-forward: " + wf.join(" · "));
}
P(`표본 ${S.length} · 블록 4×20일 · 장세 ${JSON.stringify(Object.fromEntries([...new Set(dates.map(d=>reg.get(d)))].map(k=>[k,dates.filter(d=>reg.get(d)===k).length])))}`);
for (const [n,c] of [...CONFIGS, ...CONFIGS_EXTRA]) evalCfg(n,c);
writeFileSync(SP + "sigtune-3.txt", out.join("\n"), "utf-8");
