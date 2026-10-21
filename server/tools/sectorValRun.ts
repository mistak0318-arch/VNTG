/** 업종 평균 집계를 한 번 돌린다 — `npx tsx tools/sectorValRun.ts` (한투만, 키움 0회) */
import "dotenv/config";
import { allSectorValues, refresh, sectorValuationStat } from "../src/sectorValuation.js";

const t0 = Date.now();
await refresh();
console.log("걸린 시간:", ((Date.now() - t0) / 1000).toFixed(0), "초");
console.log("stat:", JSON.stringify(sectorValuationStat()));
const all = await allSectorValues();
console.log("\n업종              PER     PBR   쓴종목/뺀종목");
console.log("─".repeat(52));
for (const s of all?.sectors ?? []) {
  console.log(
    `${s.sector.padEnd(16)}${(s.per === null ? "-" : s.per.toFixed(1)).padStart(7)}${(s.pbr === null ? "-" : s.pbr.toFixed(2)).padStart(8)}   ${s.used}/${s.skipped}`,
  );
}
process.exit(0);
