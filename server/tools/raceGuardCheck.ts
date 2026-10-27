/** 채택 안전장치 시험 — 파일을 손으로 고쳤다고 치고, 금지된 열쇠가 매매에 닿는지 본다 */
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FILE = join(dirname(fileURLToPath(import.meta.url)), "..", "data", "cisScenario.json");
const backup = await readFile(FILE, "utf-8");
const store = JSON.parse(backup);

store.adopted = {
  trade: {
    from: "stop4", label: "손절 -4%", edge: 9.9, why: "시험", at: new Date().toISOString(),
    rules: {
      stopPct: -4,          // 허용 — 들어가야 한다
      targetPct: 25,        // 허용 — 들어가야 한다
      maxPositions: 3,      // 금지 — 적극 모드
      maxHoldDays: 2,       // 금지 — 적극 모드
      maxPerStock: 50,      // 금지
      minScore: 90,         // 금지 — 신호등 문턱 동결
    },
  },
};
await writeFile(FILE, JSON.stringify(store, null, 1), "utf-8");

/* 캐시를 안 타게 import 는 쓴 뒤에 */
const { rulesFor } = await import("../src/cisConfig.js");
const r = await rulesFor("trade");
console.log("손절      ", r.stopPct, r.stopPct === -4 ? "✓ 들어감(허용)" : "✗");
console.log("익절      ", r.targetPct, r.targetPct === 25 ? "✓ 들어감(허용)" : "✗");
console.log("자리      ", r.maxPositions, r.maxPositions === 10 ? "✓ 막힘(적극 모드 지킴)" : "✗ 뚫림!");
console.log("보유일    ", r.maxHoldDays, r.maxHoldDays === 12 ? "✓ 막힘(적극 모드 지킴)" : "✗ 뚫림!");
console.log("한종목%   ", r.maxPerStock, r.maxPerStock === 12 ? "✓ 막힘" : "✗ 뚫림!");
console.log("문턱      ", (r as any).minScore, (r as any).minScore !== 90 ? "✓ 막힘(동결 지킴)" : "✗ 뚫림!");

await writeFile(FILE, backup, "utf-8");
console.log("\n원래 파일로 되돌림");
