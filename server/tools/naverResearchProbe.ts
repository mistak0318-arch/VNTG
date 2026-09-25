/** 종목별 증권사 리포트 모듈 시험 — `npx tsx tools/naverResearchProbe.ts 005930` (조회 0회) */
import { stockReports } from "../src/naverResearch.js";

const code = process.argv[2] ?? "005930";
const rows = await stockReports(code, 5);
for (const r of rows) console.log(`${r.date} ${r.broker.padEnd(8)} ${r.opinion ?? "-"} 목표 ${r.prevGoal ?? "-"}→${r.goal ?? "-"} (작성일 ${r.priceAt ?? "-"}) ${r.pdf ? "PDF" : "-"}  ${r.title}\n   ${r.body.slice(0, 120).replace(/\n/g, " ")}…`);
process.exit(0);
