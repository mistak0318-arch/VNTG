/** 조·억 표기 확인 — 10/23 실제 값으로 (조회 0회) */
import { joEok } from "../src/aiSummary.js";
for (const v of [-11028, 7696, 2639, -10900, 7790, 11710, -214, -354, 9869, -6830, 10000, -20000, 999, 0]) {
  console.log(String(v).padStart(8), "→", joEok(v));
}
process.exit(0);
