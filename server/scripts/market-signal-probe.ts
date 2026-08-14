/** 시장 신호등 실측. npx tsx scripts/market-signal-probe.ts */
import "dotenv/config";
import { createKiwoomClientFromEnv } from "../src/kiwoomClient.js";
import { evaluateMarket, toMarketSignalDigest } from "../src/marketSignal.js";
const sig = await evaluateMarket(createKiwoomClientFromEnv());
console.log(`등급 ${sig.level} · ${sig.score}점`);
console.log(sig.summary);
console.log("");
for (const c of sig.checks) {
  const mark = c.pass === true ? "O" : c.pass === false ? "X" : "-";
  console.log(`[${mark}] ${c.label.padEnd(8)} (w${c.weight})  ${c.value}`);
}
console.log("\n--- 리포트 다이제스트 ---");
console.log(toMarketSignalDigest(sig));
