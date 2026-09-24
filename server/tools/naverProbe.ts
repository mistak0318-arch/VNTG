/** 네이버 모바일 증권 JSON 창구 탐색 — 어느 주소가 살아 있고 무엇을 주는지 (2026-09-24) */
const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };
const urls = [
  "https://api.stock.naver.com/index/.INX/basic",
  "https://api.stock.naver.com/index/.DJI/basic",
  "https://api.stock.naver.com/index/.SOX/basic",
  "https://api.stock.naver.com/index/.VIX/basic",
  "https://m.stock.naver.com/api/index/KOSPI/basic",
  "https://m.stock.naver.com/api/index/KOSPI/investor",
  "https://m.stock.naver.com/api/marketindex/exchange/FX_USDKRW",
  "https://m.stock.naver.com/api/marketindex/oil/OIL_CL",
  "https://m.stock.naver.com/api/marketindex/gold/CMDT_GC",
  "https://m.stock.naver.com/api/marketindex/bond/US10YT",
  "https://api.stock.naver.com/marketindex/exchange/FX_USDKRW/basic",
  "https://api.stock.naver.com/marketindex/oil/CL/basic",
  "https://api.stock.naver.com/marketindex/metals/GC/basic",
  "https://api.stock.naver.com/marketindex/bond/US10YT=RR/basic",
  "https://api.stock.naver.com/stock/NVDA.O/basic",
  "https://api.stock.naver.com/stock/NVDA.O/integration",
  "https://m.stock.naver.com/api/stock/005930/basic",
  "https://m.stock.naver.com/api/stock/005930/integration",
  "https://m.stock.naver.com/api/stock/005930/consensus",
  "https://m.stock.naver.com/api/stock/005930/finance/annual",
  "https://m.stock.naver.com/api/stock/005930/investorTrend",
  "https://m.stock.naver.com/api/stock/005930/overviewInfo",
  "https://m.stock.naver.com/api/stocks/marketValue/KOSPI?page=1&pageSize=5",
  "https://m.stock.naver.com/api/stocks/industry/KOSPI?page=1&pageSize=5",
  "https://m.stock.naver.com/api/home/majorIndex",
  "https://m.stock.naver.com/api/home/marketIndex",
  "https://api.stock.naver.com/etf/069500/basic",
  "https://api.stock.naver.com/etf/069500/holdings?page=1&pageSize=5",
  "https://api.stock.naver.com/stock/exchange/NASDAQ/marketValue?page=1&pageSize=3",
  "https://api.stock.naver.com/stock/NVDA.O/finance/annual",
  "https://api.stock.naver.com/stock/NVDA.O/consensus",
];
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000), redirect: "manual" });
    const ct = r.headers.get("content-type") ?? "";
    let note = "";
    if (r.status === 200 && /json/.test(ct)) {
      const j = (await r.json()) as unknown;
      const s = JSON.stringify(j);
      note = s.length > 220 ? `${s.slice(0, 220)}…` : s;
    } else note = `${ct} ${r.headers.get("location") ?? ""}`;
    console.log(`${String(r.status).padEnd(4)} ${u}\n      ${note}`);
  } catch (e) {
    console.log(`ERR  ${u}  ${e instanceof Error ? e.message : e}`);
  }
}
