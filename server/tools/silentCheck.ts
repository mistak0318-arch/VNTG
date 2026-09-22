/**
 * 전수검토 (나) 조용한 실패 — **바깥 창구가 지금 실제로 뭘 주는지** 한 번에 잰다 (2026-09-23).
 *
 * 「ok 로 기록되는데 화면은 빈」 유형(1회차: 네이버 PC 뉴스가 한 달 302)을 잡으려면 기록이 아니라
 * 창구를 직접 두드려야 한다. 키움·한투는 안 쓴다(앱 키 공유). 각 줄: 창구 · HTTP · 파싱한 개수 · 판정.
 *
 *   npx tsx tools/silentCheck.ts
 */
import "dotenv/config";
import { naverBoard } from "../src/naverBoard.js";
import { usRank } from "../src/usRank.js";
import { futuresFlow } from "../src/naverFuturesFlow.js";
import { fetchEtfs } from "../src/naverThemes.js";
import { getEtfInfo } from "../src/etfInfo.js";
import { yahooChart } from "../src/yahooChart.js";
import { usFastQuotes } from "../src/usFastQuotes.js";
import { usPopular, discussionRanking, depositTrend, naverBriefings, npayRanking, researchBoard, marketCalendar } from "../src/naverMarket.js";

type Line = { where: string; http: string; count: number | string; verdict: string };
const lines: Line[] = [];
const push = (l: Line) => {
  lines.push(l);
  console.log(`${l.verdict.padEnd(6)} ${l.where.padEnd(34)} ${String(l.http).padEnd(8)} ${l.count}`);
};
const kst = (back = 0) => new Date(Date.now() + 9 * 3600_000 - back * 86_400_000).toISOString().slice(0, 10);

async function raw(where: string, url: string, init: RequestInit, count: (body: string) => number | string) {
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(15_000), redirect: "manual" });
    const body = res.status >= 300 && res.status < 400 ? "" : await res.text();
    const c = body ? count(body) : `→ ${res.headers.get("location") ?? ""}`;
    push({ where, http: String(res.status), count: c, verdict: res.ok && Number(c) > 0 ? "OK" : "❌" });
  } catch (e) {
    push({ where, http: "ERR", count: e instanceof Error ? e.message : String(e), verdict: "❌" });
  }
}

async function mod(where: string, fn: () => Promise<number | string>) {
  try {
    const c = await fn();
    push({ where, http: "(모듈)", count: c, verdict: Number(c) > 0 ? "OK" : "❌" });
  } catch (e) {
    push({ where, http: "THROW", count: e instanceof Error ? e.message : String(e), verdict: "❌" });
  }
}

async function main() {
  /* KIND 당일공시 — 오늘·어제. 200 인데 표가 비면 「ok + 빈 파일」 */
  for (const back of [0, 1]) {
    const date = kst(back);
    const form = new URLSearchParams({
      method: "searchTodayDisclosureSub", currentPageSize: "100", pageIndex: "1", orderMode: "0", orderStat: "D",
      forward: "todaydisclosure_sub", chose: "S", todayFlag: "N", selDate: date, marketType: "",
    });
    await raw(`KIND 당일공시 ${date}`, "https://kind.krx.co.kr/disclosure/todaydisclosure.do", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "user-agent": "Mozilla/5.0", referer: "https://kind.krx.co.kr/disclosure/todaydisclosure.do" },
      body: form.toString(),
    }, (html) => (html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) ?? []).filter((tr) => (tr.match(/<td/g) ?? []).length >= 4).length);
  }

  /* 네이버 장중 투자자 — E1-b 에서 410 확인. 아직 410 인지, 200+빈 표로 바뀌었는지 */
  await raw("네이버 장중투자자(PC) 어제", `https://finance.naver.com/sise/investorDealTrendTime.naver?bizdate=${kst(1).replace(/-/g, "")}&sosok=01&page=1`,
    { headers: { "user-agent": "Mozilla/5.0" } }, (html) => (html.match(/<td class="date2">/g) ?? []).length);

  /* 네이버 테마 목록(모바일 JSON) */
  await raw("네이버 테마 목록", "https://m.stock.naver.com/api/stocks/theme?page=1&pageSize=100",
    { headers: { "user-agent": "Mozilla/5.0" } }, (b) => { try { return (JSON.parse(b).groups ?? []).length; } catch { return "JSON 아님"; } });

  /* 네이버 해외 검색 자동완성 */
  await raw("네이버 해외검색 autoComplete", "https://m.stock.naver.com/front-api/search/autoComplete?query=apple&target=stock",
    { headers: { "user-agent": "Mozilla/5.0" } }, (b) => { try { const j = JSON.parse(b); return (j.result?.items ?? j.items ?? []).length || JSON.stringify(j).slice(0, 80); } catch { return "JSON 아님"; } });

  /* 야후 trending — usBuzz 재료 */
  await raw("야후 trending/US", "https://query1.finance.yahoo.com/v1/finance/trending/US?count=20",
    { headers: { "User-Agent": "Mozilla/5.0" } }, (b) => { try { return (JSON.parse(b).finance?.result?.[0]?.quotes ?? []).length; } catch { return "JSON 아님"; } });

  /* 모듈 — 우리 파서를 그대로 태운다 */
  await mod("naverBoard(005930).posts", async () => { const p = await naverBoard("005930"); return p.error ? `error: ${p.error}` : p.posts.length; });
  /* 거래소는 대문자 — 라우트가 toUpperCase 한다. 소문자로 물으면 네이버가 200 + 빈 목록을 주고 「ok」로 찍힌다(실측) */
  await mod("usRank(NASDAQ,up).rows", async () => (await usRank({ kind: "up", ex: "NASDAQ", limit: 20 })).rows.length);
  await mod("futuresFlow(5).days", async () => (await futuresFlow(5)).length);
  await mod("fetchEtfs().length", async () => (await fetchEtfs()).length);
  await mod("getEtfInfo(069500)", async () => { const i = await getEtfInfo("069500"); return i.nav ?? i.name ?? JSON.stringify(i).slice(0, 80); });

  /* ── (마) 바깥 의존 — 나머지 창구 (2026-09-23 4회차) ── */
  await raw("업비트 ticker", "https://api.upbit.com/v1/ticker?markets=KRW-BTC,KRW-ETH", {}, (b) => { try { return (JSON.parse(b) as unknown[]).length; } catch { return "JSON 아님"; } });
  await raw("야후 RSS headline(AAPL)", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=AAPL&region=US&lang=en-US",
    { headers: { "User-Agent": "Mozilla/5.0" } }, (b) => (b.match(/<item>/g) ?? []).length);
  await raw("SEC company_tickers", "https://www.sec.gov/files/company_tickers.json",
    { headers: { "User-Agent": "VNTG research contact@example.com" } }, (b) => { try { return Object.keys(JSON.parse(b)).length; } catch { return "JSON 아님"; } });
  await mod("yahooChart(^KS11,1mo).bars", async () => (await yahooChart("^KS11", "1mo")).candles.length);
  await mod("usFastQuotes([AAPL,MSFT])", async () => (await usFastQuotes(["AAPL", "MSFT"])).size);
  await mod("naverMarket.usPopular(20)", async () => (await usPopular(20)).rows.length);
  await mod("naverMarket.discussionRanking(KOR)", async () => (await discussionRanking("KOR")).items.length);
  await mod("naverMarket.depositTrend(10)", async () => (await depositTrend(10)).days.length);
  await mod("naverMarket.naverBriefings()", async () => (await naverBriefings()).recent.length);
  await mod("naverMarket.npayRanking(earningRate)", async () => (await npayRanking("earningRate", "all", 10)).rows.length);
  await mod("naverMarket.researchBoard()", async () => { const r = await researchBoard() as Record<string, unknown>; const first = Object.values(r).find((v) => Array.isArray(v)) as unknown[] | undefined; return first?.length ?? JSON.stringify(r).slice(0, 60); });
  await mod("naverMarket.marketCalendar(이번주)", async () => { const d = kst(0); const e = kst(-7); return (await marketCalendar(d, e)).events.length; });
  /* 키가 있는 창구 — 로컬 .env 에 있을 때만, 한 번씩(둘 다 일 한도 1만) */
  if (process.env.DART_API_KEY) {
    await raw("DART list.json 오늘", `https://opendart.fss.or.kr/api/list.json?crtfc_key=${process.env.DART_API_KEY}&bgn_de=${kst(0).replace(/-/g, "")}&page_count=10`,
      {}, (b) => { try { const j = JSON.parse(b); return j.status === "000" ? (j.list ?? []).length : `status ${j.status} ${j.message ?? ""}`; } catch { return "JSON 아님"; } });
  }

  console.log(`\n${lines.filter((l) => l.verdict === "OK").length} OK / ${lines.filter((l) => l.verdict !== "OK").length} ❌`);
}

main().then(() => process.exit(0));
