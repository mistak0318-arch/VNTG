/**
 * 표본의 실적 칸 채우기 — 한투 분기(8분기) + DART 연간. 종목당 각 1콜.
 *
 * 실행: server 디렉토리에서  npx tsx <이 파일>
 * 결과: scratchpad/profitFill.json  { code: { quarters: QuarterRow[], annual: {year: op}[] } }
 *
 * 표본 파일은 건드리지 않는다 — 분석 스크립트가 메모리에서 합친다.
 * look-ahead 방지(그 시점에 공시된 분기만)는 합칠 때 signalBacktest.quarterIndex 와 같은 규칙으로.
 */
import { pathToFileURL } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
const SRC = dirname(fileURLToPath(import.meta.url)) + "/../../src/";
const imp = (f: string) => import(pathToFileURL(SRC + f).href);

/* 서버는 index.ts 가 dotenv 로 .env 를 읽는다 — 여기선 직접 읽어 넣는다 (모듈 import 전에) */
for (const line of readFileSync(SRC + "../.env", "utf-8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const OUT = "C:/Users/Jaemin Kim/AppData/Local/Temp/claude/K--0000-3740--------------00-----2-AI------260810------/7fd40f4e-1d14-4899-892f-e551fe467027/scratchpad/profitFill.json";

const { loadSamples } = await imp("signalSamples.ts");
const { quarterFinance } = await imp("quarterFinance.ts");
const { getFinance } = await imp("dartFinance.ts");
const { hantooReady } = await imp("hantooClient.ts");

const file = await loadSamples();
const codes = [...new Set((file.samples as any[]).map((s) => s.code))].sort();
const db: Record<string, any> = existsSync(OUT) ? JSON.parse(readFileSync(OUT, "utf-8")) : {};
console.log(`종목 ${codes.length} · 이미 있음 ${Object.keys(db).length} · 한투 ${hantooReady() ? "OK" : "❌ 준비 안 됨"}`);

let done = 0, qFail = 0, aFail = 0;
const t0 = Date.now();
for (const code of codes) {
  if (db[code]?.quarters && db[code]?.annual) { done++; continue; }
  const rec: any = db[code] ?? {};
  if (!rec.quarters) {
    try {
      rec.quarters = await quarterFinance(code, 8);
    } catch (e) {
      rec.quarters = []; qFail++;
    }
  }
  if (!rec.annual) {
    try {
      const fin = await getFinance(code);
      rec.annual = (fin.periods ?? []).map((p: any) => ({ label: p.label, op: p.operatingProfit }));
    } catch {
      rec.annual = []; aFail++;
    }
  }
  db[code] = rec;
  done++;
  if (done % 50 === 0 || done === codes.length) {
    writeFileSync(OUT, JSON.stringify(db), "utf-8");
    const el = Math.round((Date.now() - t0) / 1000);
    console.log(`${done}/${codes.length} · ${el}s · 분기실패 ${qFail} · 연간실패 ${aFail}`);
  }
}
writeFileSync(OUT, JSON.stringify(db), "utf-8");
const qOk = Object.values(db).filter((r: any) => r.quarters?.length >= 2).length;
const aOk = Object.values(db).filter((r: any) => r.annual?.length >= 2).length;
console.log(`완료 — 분기 2개↑ ${qOk} · 연간 2개↑ ${aOk} / ${codes.length}`);
