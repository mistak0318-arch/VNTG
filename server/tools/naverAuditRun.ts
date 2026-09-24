/** 네이버 대조를 손으로 — `npx tsx tools/naverAuditRun.ts 2026-09-22` (조회 0회, 결과는 data/naverAudit/) */
import "dotenv/config";
import { auditNote, runNaverAudit } from "../src/naverAudit.js";

const day = process.argv[2] ?? new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const r = await runNaverAudit(day);
console.log(auditNote(r));
for (const m of r.mismatches.slice(0, 25)) console.log(`  ${m.code} ${m.what}: 우리 ${m.ours} / 네이버 ${m.naver}`);
process.exit(0);
