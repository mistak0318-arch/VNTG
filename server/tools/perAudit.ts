/**
 * **PER 전수점검** (2026-10-21) — `npx tsx tools/perAudit.ts 000660 005930 ...`
 *
 * 한 종목에 PER 이 네 군데서 네 값으로 나온다. 어느 것이 무슨 기준인지 맞춰 본다.
 *
 * ⚠️ **키움은 안 찌른다.** 같은 앱키로 토큰을 새로 받으면 미니PC 운영 서버의 토큰이
 * 죽는다([memory] local-dev-server-eats-kiwoom-quota). 한투는 6시간 안 재발급에 같은
 * 토큰을 줘서 안 죽고, 네이버는 조회 0회다.
 */
import "dotenv/config";
import { estimatePerform } from "../src/estimatePerform.js";
import { krOutlook } from "../src/naverOutlook.js";

const UA = { "User-Agent": "Mozilla/5.0", Referer: "https://m.stock.naver.com/" };

async function naverInteg(code: string): Promise<Record<string, string>> {
  const r = await fetch(`https://m.stock.naver.com/api/stock/${code}/integration`, {
    headers: UA,
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) return {};
  const j = (await r.json()) as { totalInfos?: { code: string; value: string }[] };
  const out: Record<string, string> = {};
  for (const t of j.totalInfos ?? []) out[t.code] = t.value;
  return out;
}

for (const code of process.argv.slice(2)) {
  const [integ, est, out] = await Promise.all([
    naverInteg(code),
    estimatePerform(code).catch(() => null),
    krOutlook(code).catch(() => null),
  ]);
  console.log(`\n############ ${code} ############`);
  console.log("네이버 integration :", JSON.stringify({
    per: integ.per, eps: integ.eps, pbr: integ.pbr, bps: integ.bps,
    cnsPer: integ.cnsPer, cnsEps: integ.cnsEps, mktCap: integ.marketValue,
  }));
  console.log("naverOutlook(우리) :", JSON.stringify(out));
  if (est) {
    console.log("한투 추정 :", est.name, "| 의견", est.opinion, "| 기준", est.estimatedAt);
    for (const c of est.columns) {
      console.log(`   ${c.period}  EPS ${c.eps}  PER ${c.per}  ROE ${c.roe}  순이익 ${c.netIncome}`);
    }
  } else {
    console.log("한투 추정 : (없음)");
  }
}
process.exit(0);
