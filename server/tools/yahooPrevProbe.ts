/**
 * 야후 5일 일봉의 timestamp·close·meta 를 그대로 찍는다 — 「전일 종가」 기준이 왜 어긋나는지 볼 때 (2026-09-24).
 *   npx tsx tools/yahooPrevProbe.ts ^NDX ^SOX ^GSPC
 */
const syms = process.argv.slice(2);
if (syms.length === 0) syms.push("^NDX", "^SOX", "^GSPC");
for (const s of syms) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?range=5d&interval=1d`;
  const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  const j = (await res.json()) as { chart?: { result?: { meta?: Record<string, unknown>; timestamp?: number[]; indicators?: { quote?: { close?: (number | null)[] }[] } }[] } };
  const r = j.chart?.result?.[0];
  const m = r?.meta ?? {};
  const et = (t: number) => new Date(t * 1000).toLocaleString("en-US", { timeZone: "America/New_York", hour12: false });
  console.log(`\n== ${s}  price=${m.regularMarketPrice}  regularMarketTime=${et(Number(m.regularMarketTime))}  chartPreviousClose=${m.chartPreviousClose}  previousClose=${m.previousClose}`);
  const ts = r?.timestamp ?? [];
  const cl = r?.indicators?.quote?.[0]?.close ?? [];
  ts.forEach((t, i) => console.log(`   ${et(t)}  close=${cl[i]}`));
}
