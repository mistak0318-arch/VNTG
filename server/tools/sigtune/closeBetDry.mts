/**
 * 종배 라운드 **마른 실행** — 장부에 안 남기고 판단만 본다 (2026-09-03).
 *
 * 실행: server/ 에서 `npx tsx tools/sigtune/closeBetDry.mts`
 * 메모리에 빈 계좌를 만들어 `closeBetRound` 를 돌린다. 저장하지 않는다 — 일지도 안 쓴다.
 * (일지를 쓰면 그날 저녁이 「이미 썼다」가 되어 진짜 저녁 실행이 빠진다.)
 */
import { readFileSync } from "node:fs";
/* .env 둘째 줄 앞에 BOM 이 있다 — 안 벗기면 KIWOOM_APP_KEY 가 안 읽힌다 */
for (const line of readFileSync(".env", "utf8").replace(/﻿/g, "").split(/\r?\n/)) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}
const { createKiwoomClientFromEnv } = await import("../../src/kiwoomClient.js");
const { closeBetRound, macroGauge } = await import("../../src/cisCloseBet.js");
const { rulesFor } = await import("../../src/cisConfig.js");
const { today } = await import("../../src/cisAccount.js");
const { listTrackLastRunDate } = await import("../../src/listTrack.js");

const client = createKiwoomClientFromEnv();
const rules = await rulesFor("close");
console.log("규칙(종배):", JSON.stringify({ stop: rules.stopPct, target: rules.targetPct, hold: rules.maxHoldDays, minScore: rules.minScore, rejectAlerts: rules.rejectAlerts, maxPositions: rules.maxPositions }));
console.log("원장 마지막 갱신일:", await listTrackLastRunDate(), "· 오늘:", today());

const m = await macroGauge();
console.log("\n미국장 분위기:", m.summary);
for (const l of m.lines) console.log("  ", l);

const a = {
  id: "close" as const,
  cash: 40_000_000,
  misu: 0,
  credit: 0,
  positions: [] as never[],
  fills: [] as never[],
  equityCurve: [] as never[],
  startedAt: today(),
};
const t0 = Date.now();
/* 밤엔 시장 점수가 0 이라 문에서 멈춘다 — `--force` 면 문을 무시하고 종목 경로만 시험 */
const ignoreGates = process.argv.includes("--force");
if (ignoreGates) console.log("\n⚠️ --force: 시장 문·미국장 문을 무시하고 종목 경로만 돌린다 (시험)");
const r = await closeBetRound(
  client,
  a as never,
  "close",
  today(),
  rules,
  {
    start: (k: string) => console.log(`  ▶ ${k}`),
    done: (k: string, note?: string) => console.log(`  ✓ ${k} ${note ?? ""}`),
    skip: (k: string, note?: string) => console.log(`  – ${k} ${note ?? ""}`),
  } as never,
  { ignoreGates },
);
console.log(`\n걸린 시간 ${Math.round((Date.now() - t0) / 1000)}초`);
console.log("시장 문:", r.gate.ok ? "열림" : "닫힘", "—", r.gate.reason);
console.log("체에 걸린 것:", r.sieved.length);
for (const s of r.sieved) console.log("  ✕", s.name, "—", s.reason);
console.log("후보:", r.candidates.length);
for (const c of r.candidates) console.log("  ○", c.name, c.score, "—", c.why);
console.log("계획:", r.plans.length);
for (const p of r.plans) console.log("  ■", p.candidate.name, p.qty, "주 ×", p.price, "손절", p.stop, "목표", p.target, p.funding);
console.log("체결(메모리):", r.actions.length, "· 남은 현금", a.cash.toLocaleString());
if (r.screenNotes.length) console.log("AI:", r.screenNotes.map((n) => `${n.name}:${n.verdict}`).join(" "));
if (r.aiError) console.log("AI 오류:", r.aiError);
