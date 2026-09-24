/** 네이버 컨센서스·추정치 모듈 시험 — `npx tsx tools/naverOutlookProbe.ts 005930 NVDA` (조회 0회) */
import { krOutlook, usConsensus } from "../src/naverOutlook.js";

const [kr = "005930", us = "NVDA"] = process.argv.slice(2);
console.log(JSON.stringify(await krOutlook(kr), null, 1));
console.log(JSON.stringify(await usConsensus(us), null, 1));
process.exit(0);
