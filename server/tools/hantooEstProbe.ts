/** 추정실적이 왜 빈 응답인가 + 업종 TR 탐색 — `npx tsx tools/hantooEstProbe.ts` */
import "dotenv/config";
import { hantooGet } from "../src/hantooClient.js";

const show = (label: string, body: Record<string, unknown>) => {
  console.log(`\n--- ${label}`);
  console.log("   rt_cd:", body.rt_cd, "| msg_cd:", body.msg_cd, "| msg1:", String(body.msg1 ?? "").trim());
  for (const k of ["output", "output1", "output2", "output3", "output4"]) {
    const v = body[k];
    if (Array.isArray(v)) console.log(`   ${k}: 배열 ${v.length}`, v.length ? JSON.stringify(v[0]).slice(0, 220) : "");
    else if (v && typeof v === "object") console.log(`   ${k}:`, JSON.stringify(v).slice(0, 220));
  }
};

/* ① 추정실적 — 파라미터 이름을 바꿔 가며 */
for (const p of [{ SHT_CD: "000660" }, { sht_cd: "000660" }, { SHT_CD: "005930" }, { SHT_CD: "A000660" }]) {
  try {
    show(`추정실적 ${JSON.stringify(p)}`, await hantooGet("/uapi/domestic-stock/v1/quotations/estimate-perform", "HHKST668300C0", p, "추정"));
  } catch (e) { console.log(`\n--- 추정실적 ${JSON.stringify(p)}  ❌ ${(e as Error).message}`); }
}

/* ② 업종 TR 후보 — PER 이 딸려 오나 */
const SECTOR: { name: string; path: string; tr: string; params: Record<string, string> }[] = [
  { name: "업종 현재지수", path: "/uapi/domestic-stock/v1/quotations/inquire-index-price", tr: "FHPUP02100000", params: { fid_cond_mrkt_div_code: "U", fid_input_iscd: "0013" } },
  { name: "업종별 지수 전체", path: "/uapi/domestic-stock/v1/quotations/inquire-index-category-price", tr: "FHPUP02140000", params: { fid_cond_mrkt_div_code: "U", fid_input_iscd: "0001", fid_cond_scr_div_code: "20214", fid_mrkt_cls_code: "K", fid_blng_cls_code: "0" } },
  { name: "국내업종 구분별 전체시세", path: "/uapi/domestic-stock/v1/quotations/inquire-index-category-price", tr: "FHPUP02140000", params: { fid_cond_mrkt_div_code: "U", fid_input_iscd: "0013", fid_cond_scr_div_code: "20214", fid_mrkt_cls_code: "K", fid_blng_cls_code: "0" } },
];
for (const s of SECTOR) {
  try { show(`${s.name} (${s.tr})`, await hantooGet(s.path, s.tr, s.params, s.name)); }
  catch (e) { console.log(`\n--- ${s.name}  ❌ ${(e as Error).message}`); }
}
process.exit(0);
