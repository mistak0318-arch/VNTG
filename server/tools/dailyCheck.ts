/**
 * **일봉 원본 대조** — `npx tsx tools/dailyCheck.ts 009150`
 *
 * 벤티지: "삼성전기 차트에서 나오는 숫자랑 실제 등락률이랑 안 맞음".
 * 장중이라 키움은 안 건드린다(토큰이 갈린다). 한투로 받아 **종가로 직접 등락률을
 * 계산해** 화면 값과 맞춰 본다.
 */
import "dotenv/config";
import { hantooGet } from "../src/hantooClient.js";

const code = process.argv[2] ?? "009150";
const end = new Date();
const start = new Date(end.getTime() - 40 * 86400_000);
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

for (const adj of ["0", "1"]) {
  const body = await hantooGet<{ output2?: Record<string, string>[] }>(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    "FHKST03010100",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: ymd(start),
      FID_INPUT_DATE_2: ymd(end),
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: adj,
    },
    "일봉대조",
  );
  const rows = (body.output2 ?? []).filter((r) => r.stck_bsop_date);
  console.log(`\n===== FID_ORG_ADJ_PRC=${adj} (${adj === "0" ? "수정주가" : "원주가"}) =====`);
  console.log("일자        시가        고가        저가        종가     한투전일대비  직접계산");
  for (let i = 0; i < Math.min(rows.length, 10); i += 1) {
    const r = rows[i];
    const close = Number(r.stck_clpr);
    const prev = rows[i + 1] ? Number(rows[i + 1].stck_clpr) : null;
    const calc = prev ? ((close - prev) / prev) * 100 : null;
    console.log(
      `${r.stck_bsop_date}  ${Number(r.stck_oprc).toLocaleString().padStart(10)}` +
        `${Number(r.stck_hgpr).toLocaleString().padStart(12)}${Number(r.stck_lwpr).toLocaleString().padStart(12)}` +
        `${close.toLocaleString().padStart(12)}   ${String(r.prdy_ctrt ?? "-").padStart(7)}%  ` +
        `${calc === null ? "-" : `${calc >= 0 ? "+" : ""}${calc.toFixed(2)}%`}`,
    );
  }
}
process.exit(0);
