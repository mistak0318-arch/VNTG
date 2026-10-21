/**
 * **한투 국내 TR 날것으로 찌르기** — `npx tsx tools/hantooKrProbe.ts`
 *
 * estimatePerform 등은 예외를 catch 로 삼켜 「없음」으로 바꾼다(화면이 막히면 안 되니까).
 * 그래서 **왜** 안 되는지가 안 보인다. 여기서는 에러를 그대로 찍는다.
 */
import "dotenv/config";
import { hantooGet, hantooReady } from "../src/hantooClient.js";

console.log("키 꽂힘:", hantooReady());

const CASES: { name: string; path: string; tr: string; params: Record<string, string> }[] = [
  {
    name: "종목추정실적 (HHKST668300C0)",
    path: "/uapi/domestic-stock/v1/quotations/estimate-perform",
    tr: "HHKST668300C0",
    params: { SHT_CD: "000660" },
  },
  {
    name: "재무비율 (FHKST66430300)",
    path: "/uapi/domestic-stock/v1/finance/financial-ratio",
    tr: "FHKST66430300",
    params: { FID_DIV_CLS_CODE: "1", fid_cond_mrkt_div_code: "J", fid_input_iscd: "000660" },
  },
  {
    name: "기타주요비율 (FHKST66430500)",
    path: "/uapi/domestic-stock/v1/finance/other-major-ratios",
    tr: "FHKST66430500",
    params: { FID_DIV_CLS_CODE: "1", fid_cond_mrkt_div_code: "J", fid_input_iscd: "000660" },
  },
  {
    name: "국내주식 현재가 (FHKST01010100)",
    path: "/uapi/domestic-stock/v1/quotations/inquire-price",
    tr: "FHKST01010100",
    params: { fid_cond_mrkt_div_code: "J", fid_input_iscd: "000660" },
  },
];

for (const c of CASES) {
  try {
    const body = await hantooGet<Record<string, unknown>>(c.path, c.tr, c.params, c.name);
    const keys = Object.keys(body);
    console.log(`\n✅ ${c.name}  키: ${keys.join(",")}`);
    const o = (body.output ?? body.output1) as Record<string, unknown> | Record<string, unknown>[] | undefined;
    const first = Array.isArray(o) ? o[0] : o;
    if (first) {
      const picked = Object.fromEntries(
        Object.entries(first).filter(([k]) => /per|pbr|eps|bps|roe|lblt|prdy|stck/i.test(k)),
      );
      console.log("   ", JSON.stringify(Object.keys(picked).length ? picked : first).slice(0, 400));
    }
  } catch (e) {
    console.log(`\n❌ ${c.name}  →  ${(e as Error).message}`);
  }
}
process.exit(0);
