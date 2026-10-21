/**
 * **「작년 결산 PER」이 얼마나 빗나가나** — `npx tsx tools/perGap.ts 000660 005930 …`
 *
 * 키움 ka10001 의 per·pbr 은 **오늘 주가 ÷ 직전 결산(2025.12) EPS·BPS** 임을
 * 하이닉스로 확정했다 (1,287,000÷58,955 = 21.83 = 화면값, ÷171,751 = 7.49 = 화면값).
 *
 * 그러니 키움을 안 찔러도 재현된다. 주가는 약분되므로 아예 필요 없다:
 *
 *     작년PER = TTM PER × (TTM EPS ÷ 작년 EPS)
 *
 * 네이버 조회 2건, 키움 조회 0회.
 */
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };
const n = (s: unknown): number | null => {
  const v = Number(String(s ?? "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(v) && String(s ?? "").trim() !== "" ? v : null;
};
const get = async (u: string): Promise<any> => {
  try {
    const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(10000) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
};
const f = (v: number | null, d = 2) => (v === null ? "-" : v.toFixed(d));

console.log("종목            작년PER   TTM PER   추정PER │ 부풀림(작년÷TTM)");
console.log("─".repeat(66));
const gaps: { name: string; mult: number }[] = [];
for (const code of process.argv.slice(2)) {
  const [integ, fin] = await Promise.all([
    get(`https://m.stock.naver.com/api/stock/${code}/integration`),
    get(`https://m.stock.naver.com/api/stock/${code}/finance/annual`),
  ]);
  const t: Record<string, string> = {};
  for (const x of integ?.totalInfos ?? []) t[x.code] = x.value;
  const rows = fin?.financeInfo?.rowList ?? [];
  const cell = (title: string, key: string) =>
    n(rows.find((r: any) => r.title === title)?.columns?.[key]?.value);
  const name = String(integ?.stockName ?? code);
  const ttmPer = n(t.per);
  const ttmEps = n(t.eps);
  const lastEps = cell("EPS", "202512");
  const estPer = n(t.cnsPer);
  const lastPer = ttmPer !== null && ttmEps !== null && lastEps ? ttmPer * (ttmEps / lastEps) : null;
  const mult = lastPer !== null && ttmPer ? lastPer / ttmPer : null;
  if (mult !== null) gaps.push({ name, mult });
  console.log(
    `${name.padEnd(14)}${f(lastPer).padStart(8)}${f(ttmPer).padStart(10)}${f(estPer).padStart(10)} │ ${mult === null ? "-" : `${mult.toFixed(2)}배`}`,
  );
}
console.log("─".repeat(66));
const bad = gaps.filter((g) => g.mult >= 1.3 || g.mult <= 0.77);
console.log(`1.3배 이상 어긋난 종목: ${bad.length}/${gaps.length} — ${bad.map((b) => `${b.name}(${b.mult.toFixed(1)}배)`).join(", ") || "없음"}`);
process.exit(0);
