/**
 * CIS 청산 규칙 비교 — 익절 고정 vs 고점 되돌림 (2026-09-02 밤, 벤티지 "응 바꾸자").
 *
 * 실행: server/ 에서 `npx tsx tools/sigtune/cisTrail.mts` (후한 가정: `CIS_TRAIL_LAG=1`)
 * 조회 0회 — 표본(signalSamples.json) + 전종목 일봉만 읽는다.
 *
 * 결과(2026-09-02, 표본 04~08월 1,812 자리, `cisTrail.txt`): 같은 날 고가→저가 순서를
 * 나쁜 쪽으로 가정하면 되돌림이 전부 고정 익절보다 나쁘고(-0.8~-2.5 vs -0.1), 후한 쪽이면
 * 살짝 낫다(+0.1~+0.3). 뒤쪽 절반은 늘 고정 익절이 낫다. → 기본값 안 바꿈, 12월 재검.
 */
import { cisBacktest } from "../../src/cisBacktest.js";
import { DEFAULT_RULES, type CisRules } from "../../src/cisTrader.js";

const f = (n: number, w = 6) => (n >= 0 ? "+" : "") + n.toFixed(1).padStart(w - 1);

async function row(label: string, patch: Partial<CisRules>): Promise<void> {
  const r = await cisBacktest({ ...DEFAULT_RULES, ...patch }, undefined, 1);
  if (!r) {
    console.log(`${label.padEnd(34)} | 표본 없음`);
    return;
  }
  const s = r.summary;
  const kinds = s.byKind.map((k) => `${k.label.split(" ")[0]} ${k.n}(${f(k.avg, 5)})`).join(" ");
  console.log(
    `${label.padEnd(34)} | n ${String(r.n).padStart(4)} 평균 ${f(s.ruled.avg)} 중앙 ${f(s.ruled.med)} 승률 ${s.ruled.win.toFixed(0).padStart(3)} ` +
      `보유 ${s.ruled.days.toFixed(1).padStart(4)}일 손익비 ${(s.payoff ?? 0).toFixed(2)} | 홀드20 ${f(s.hold.avg)} | ` +
      `앞 ${f(r.split.front.avg)} 뒤 ${f(r.split.back.avg)} ${r.split.bothPositive ? "✅" : "❌"} | ${kinds}`,
  );
}

console.log("기본 = 손절 -7 · 본전 전환 +7 · 최대 보유 10일 · 점수 60 · 대금 500억 · 시총 1000억");
console.log("");
console.log("### 지금 규칙 vs 되돌림 (보유 10일)");
await row("A 익절 +15 고정 (지금)", {});
await row("B 익절 없음 · 되돌림 -8", { targetPct: 0, trailDropPct: 8 });
await row("B 익절 없음 · 되돌림 -10", { targetPct: 0, trailDropPct: 10 });
await row("B 익절 없음 · 되돌림 -12", { targetPct: 0, trailDropPct: 12 });
await row("B 익절 없음 · 되돌림 -15", { targetPct: 0, trailDropPct: 15 });
await row("C 익절 없음 · 되돌림 없음", { targetPct: 0, trailDropPct: 0 });
console.log("");
console.log("### 보유 기간을 풀면 — 되돌림은 시간이 있어야 뜻이 있다");
for (const hold of [20, 40]) {
  await row(`A 익절 +15 고정 · 보유 ${hold}일`, { maxHoldDays: hold });
  for (const d of [8, 10, 12, 15]) {
    await row(`B 되돌림 -${d} · 보유 ${hold}일`, { targetPct: 0, trailDropPct: d, maxHoldDays: hold });
  }
  await row(`C 청산 없음 · 보유 ${hold}일`, { targetPct: 0, trailDropPct: 0, maxHoldDays: hold });
}
console.log("");
console.log("### 본전 전환을 끄면 (되돌림만으로 이익을 지키나)");
for (const d of [10, 12]) {
  await row(`B 되돌림 -${d} · 본전 전환 끔 · 20일`, { targetPct: 0, trailDropPct: d, maxHoldDays: 20, trailAfterPct: 0 });
}
console.log("");
console.log("### 되돌림 + 큰 익절 뚜껑 (+30)");
for (const d of [10, 12]) {
  await row(`B 되돌림 -${d} · 익절 +30 · 20일`, { targetPct: 30, trailDropPct: d, maxHoldDays: 20 });
}
