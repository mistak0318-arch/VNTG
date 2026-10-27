import { runRace } from "../src/cisScenario.js";
import { ACCOUNT_IDS } from "../src/cisAccounts.js";

const n = (v: number | null, d = 2) => (v === null ? "  –  " : (v > 0 ? "+" : "") + v.toFixed(d));
for (const id of ACCOUNT_IDS) {
  const r = await runRace(id);
  console.log(`\n████ ${r.accountName} (${id})`);
  if (r.rows.length === 0 && !r.current) { console.log("  " + r.verdict); continue; }
  const all = [r.current!, ...r.rows];
  console.log("  " + "줄".padEnd(16) + "초과".padStart(8) + "규칙".padStart(9) + "홀드".padStart(9) + "승률".padStart(7) + "손익비".padStart(8) + "거래".padStart(7) + "  문턱");
  for (const x of all) {
    console.log(
      "  " + x.label.padEnd(16) +
      n(x.excess).padStart(8) + n(x.avg).padStart(9) + n(x.hold).padStart(9) +
      (x.winRate === null ? "  –  " : x.winRate.toFixed(0) + "%").padStart(7) +
      (x.payoff === null ? "  –  " : x.payoff.toFixed(2)).padStart(8) +
      String(x.trades).padStart(7) +
      "  " + (x.bothBeatHold ? "앞뒤✓" : "앞뒤✗"),
    );
  }
  console.log("  → " + r.verdict);
}
