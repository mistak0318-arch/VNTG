/**
 * 「이 종목이 왜 이 점수인가」 — 실전 채점기를 그대로 불러 축·기준·탈락을 전부 펼친다.
 * 실행: server/ 에서 `npx tsx tools/sigtune/whyScore.mts 000660 [005930 ...]`
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env", "utf8").replace(/﻿/g, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const { createKiwoomClientFromEnv } = await import("../../src/kiwoomClient.js");
const { evaluateSignal, getConfig } = await import("../../src/signalLight.js");
const client = createKiwoomClientFromEnv();
const cfg = await getConfig();
console.log(`설정 세대 ${cfg.configVersion} ${cfg.configLabel} · 초록 ${cfg.greenAt}점 · 커버리지 ${cfg.minCoverage}`);
for (const code of process.argv.slice(2)) {
  const s = await evaluateSignal(client, code, true);
  console.log(`\n=== ${code} · ${s.level} ${s.score}점 · 커버리지 ${((s.coverage ?? 0) * 100).toFixed(0)}% · 대금 ${s.tradeEok ?? "-"}억 · 장세 ${s.regime?.label ?? "-"}(폭 ${s.regime?.breadth ?? "-"}%)`);
  if (s.vetoedBy?.length) console.log("탈락:", s.vetoedBy.join(" · "));
  if (s.riskCapped) console.log("위험 축이 초록을 막음");
  if (s.lowCoverage) console.log("커버리지 미달 · 못 잰 것:", (s.missing ?? []).join(", "));
  if (s.alerts) console.log("경보:", [...s.alerts.hot, ...s.alerts.late].map((a) => a.label).join(" · ") || "없음");
  for (const a of s.axes) console.log(`축 ${a.label.padEnd(4)} ${a.score ?? "-"} (${a.level})`);
  for (const c of s.checks) {
    const g = c.grade === null ? "  -" : String(c.grade).padStart(3);
    console.log(`  ${g}  ${c.axis.padEnd(5)} ${c.label.padEnd(18)} ${(c as { value?: unknown }).value ?? ""} ${(c as { note?: string }).note ?? ""}`);
  }
}
