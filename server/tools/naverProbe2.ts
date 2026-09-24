const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };
const urls = [
  "https://m.stock.naver.com/front-api/marketIndex/prices?category=exchange&reutersCode=FX_USDKRW&page=1&pageSize=3",
  "https://m.stock.naver.com/front-api/marketIndex/productDetail?category=exchange&reutersCode=FX_USDKRW",
  "https://m.stock.naver.com/front-api/marketIndex/productDetail?category=energy&reutersCode=CLc1",
  "https://m.stock.naver.com/front-api/marketIndex/productDetail?category=metals&reutersCode=GCcv1",
  "https://m.stock.naver.com/front-api/marketIndex/productDetail?category=bond&reutersCode=US10YT=RR",
  "https://m.stock.naver.com/front-api/marketIndex/prices?category=bond&reutersCode=US10YT=RR&page=1&pageSize=3",
  "https://m.stock.naver.com/api/marketindex/exchangeList",
  "https://m.stock.naver.com/front-api/marketIndex/list?category=exchange",
  "https://m.stock.naver.com/front-api/marketIndex/list?category=energy",
  "https://m.stock.naver.com/front-api/marketIndex/list?category=bond",
  "https://api.stock.naver.com/index/.IXIC/basic",
  "https://api.stock.naver.com/index/.NDX/basic",
  "https://api.stock.naver.com/index/.RUT/basic",
  "https://api.stock.naver.com/index/.N225/basic",
  "https://api.stock.naver.com/index/.SSEC/basic",
  "https://api.stock.naver.com/index/.HSI/basic",
  "https://api.stock.naver.com/index/.DXY/basic",
  "https://m.stock.naver.com/api/index/KOSPI/integration",
  "https://m.stock.naver.com/api/index/KPI200/basic",
  "https://m.stock.naver.com/api/index/FUT/basic",
  "https://m.stock.naver.com/api/index/KOSPI/trend?pageSize=3",
  "https://m.stock.naver.com/api/index/KOSPI/price?pageSize=3",
  "https://m.stock.naver.com/api/stock/005930/trend?pageSize=3",
  "https://m.stock.naver.com/api/stock/005930/price?pageSize=3",
  "https://m.stock.naver.com/api/stock/005930/dividend",
  "https://m.stock.naver.com/api/stocks/up/KOSPI?page=1&pageSize=3",
  "https://m.stock.naver.com/api/stocks/searchTop/KOSPI?page=1&pageSize=3",
  "https://m.stock.naver.com/api/stocks/foreignerBuying/KOSPI?page=1&pageSize=3",
  "https://m.stock.naver.com/api/stocks/institutionBuying/KOSPI?page=1&pageSize=3",
  "https://m.stock.naver.com/api/stocks/tradeValue/KOSPI?page=1&pageSize=3",
  "https://m.stock.naver.com/api/stocks/shortSelling/KOSPI?page=1&pageSize=3",
  "https://m.stock.naver.com/api/stocks/highLow/KOSPI?page=1&pageSize=3",
  "https://m.stock.naver.com/api/stock/upperLimit/KOSPI?page=1&pageSize=3",
  "https://m.stock.naver.com/api/index/investorTrend/KOSPI?pageSize=3",
  "https://m.stock.naver.com/api/index/KOSPI/investorTrend",
  "https://m.stock.naver.com/api/index/KOSPI/investorDaily?pageSize=3",
  "https://m.stock.naver.com/api/market/investorTrend?market=KOSPI&pageSize=3",
  "https://m.stock.naver.com/api/index/KOSPI/programTrade",
  "https://m.stock.naver.com/api/stock/005930/foreignerTrend?pageSize=3",
  "https://m.stock.naver.com/api/stock/005930/investorTrend?pageSize=3",
  "https://m.stock.naver.com/api/stock/005930/majorTrader",
  "https://m.stock.naver.com/api/stock/005930/askingPrice",
  "https://m.stock.naver.com/api/stock/005930/creditTrend?pageSize=3",
  "https://m.stock.naver.com/api/stock/005930/shortSelling?pageSize=3",
  "https://api.stock.naver.com/stock/NVDA.O/price?pageSize=3",
  "https://api.stock.naver.com/stock/NVDA.O/earnings",
  "https://api.stock.naver.com/stock/NVDA.O/dividend",
  "https://api.stock.naver.com/calendar/earnings?date=2026-09-24",
  "https://m.stock.naver.com/api/calendar/economic?date=2026-09-24",
];
for (const u of urls) {
  try {
    const r = await fetch(u, { headers: UA, signal: AbortSignal.timeout(8000), redirect: "manual" });
    const ct = r.headers.get("content-type") ?? "";
    let note = "";
    if (r.status === 200 && /json/.test(ct)) {
      const s = JSON.stringify(await r.json());
      note = s.length > 200 ? `${s.slice(0, 200)}…` : s;
    } else note = `${r.status}`;
    if (r.status === 200) console.log(`${u}\n      ${note}`);
    else console.log(`${r.status}  ${u}`);
  } catch (e) {
    console.log(`ERR  ${u}  ${e instanceof Error ? e.message : e}`);
  }
}
