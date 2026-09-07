/**
 * 검증 도장 살펴보기 (2026-09-07 밤) — 가짜 장부 하나에 체결 넷을 넣고 `verifyFill` 이 뭐라 하는지 본다.
 * 장부 파일은 건드리지 않는다. `npx tsx src/tools/cisVerifyProbe.ts 2026-09-05`
 */
import "dotenv/config";
import { createKiwoomClientFromEnv } from "../kiwoomClient.js";
import type { CisAccount, Fill } from "../cisAccount.js";
import { auditAccount, rebuildFromFills, verifyFill } from "../cisVerify.js";

const date = process.argv[2] ?? "2026-09-05";
const client = createKiwoomClientFromEnv();

const fill = (o: Partial<Fill> & Pick<Fill, "id" | "side" | "price">): Fill => ({
  date,
  slot: "morning",
  code: "005930",
  name: "삼성전자",
  qty: 10,
  funding: "cash",
  cost: 0,
  why: "probe",
  used: [],
  ...o,
});

const a: CisAccount = {
  id: "trade",
  cash: 40_000_000,
  misu: 0,
  credit: 0,
  positions: [],
  fills: [],
  createdAt: date,
} as unknown as CisAccount;

const cases: { label: string; f: Fill; ctx: Parameters<typeof verifyFill>[3] }[] = [
  { label: "정상 매수(일봉 범위 안 값은 아래서 채움)", f: fill({ id: "ok", side: "buy", price: 0 }), ctx: { mode: "intra" } },
  { label: "고가 위 체결", f: fill({ id: "hi", side: "buy", price: 9_999_999 }), ctx: { mode: "intra" } },
  { label: "시가배팅인데 시가와 먼 값", f: fill({ id: "op", side: "buy", price: 0 }), ctx: { mode: "open" } },
  { label: "손절 매도인데 저가가 손절가에 안 닿음", f: fill({ id: "st", side: "sell", price: 0 }), ctx: { exitKind: "stop", position: { code: "005930", name: "삼성전자", qty: 10, avg: 1, stop: 1, target: 2, funding: "cash", openedAt: date } as never } },
];

const bar = await (async () => {
  const { data } = await client.request<{ stk_dt_pole_chart_qry?: Record<string, unknown>[] }>("/api/dostk/chart", "ka10081", { stk_cd: "005930", base_dt: date.replace(/-/g, ""), upd_stkpc_tp: "1" });
  const r = (data.stk_dt_pole_chart_qry ?? []).find((x) => String(x.dt) === date.replace(/-/g, ""));
  const n = (v: unknown) => Math.abs(Number(String(v ?? "").replace(/[+,\s]/g, "")));
  return r ? { open: n(r.open_pric), high: n(r.high_pric), low: n(r.low_pric), close: n(r.cur_prc) } : null;
})();
console.log("일봉", date, bar);
if (!bar) process.exit(1);

for (const c of cases) {
  if (c.f.price === 0) c.f.price = c.f.id === "op" ? Math.round(bar.open * 1.03) : c.f.id === "st" ? Math.round((bar.low + bar.high) / 2) : Math.round((bar.low + bar.high) / 2);
  if (c.f.id === "st" && c.ctx.position) (c.ctx.position as { stop: number }).stop = Math.round(bar.low * 0.9);
  a.fills = [c.f];
  const v = await verifyFill(client, a, c.f, c.ctx);
  console.log(`\n■ ${c.label} — ${v.ok ? "통과" : "실패"}`);
  for (const n of v.notes) console.log("   ·", n);
}

/* 중복 */
a.fills = [fill({ id: "d1", side: "buy", price: bar.close }), fill({ id: "d2", side: "buy", price: bar.close })];
const dv = await verifyFill(client, a, a.fills[1], { mode: "close" });
console.log(`\n■ 같은 날·슬롯 중복 매수 — ${dv.ok ? "통과" : "실패"}`);
for (const n of dv.notes) console.log("   ·", n);

/* 재구성 */
a.fills = [
  fill({ id: "r1", side: "buy", price: 70_000, qty: 10, cost: 105 }),
  fill({ id: "r2", side: "sell", price: 72_000, qty: 4, cost: 500, pnl: 7_395 }),
];
console.log("\n■ 재구성", rebuildFromFills(a));
console.log("\n■ 실제 장부 점검 trade:", (await auditAccount("trade")).items);
process.exit(0);
