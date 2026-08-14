/**
 * 시세분석 화면에 넣을 TR들의 **실제 필드와 값**을 뽑는다.
 * 컬럼을 문서나 추측으로 잡으면 화면에 빈 칸이 생긴다. 값까지 보고 정한다.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env"), "utf-8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const BASE =
  process.env.KIWOOM_IS_MOCK === "true" ? "https://mockapi.kiwoom.com" : "https://api.kiwoom.com";
const { token } = await (
  await fetch(`${BASE}/oauth2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      appkey: process.env.KIWOOM_APP_KEY,
      secretkey: process.env.KIWOOM_APP_SECRET,
    }),
  })
).json();

const COMMON = {
  mrkt_tp: "000",
  trde_qty_tp: "0000",
  trde_qty_cnd: "0000",
  stk_cnd: "0",
  crd_cnd: "0",
  updown_incls: "1",
  stex_tp: "3",
  sort_tp: "1",
  pric_cnd: "0",
  trde_prica_cnd: "0",
  mang_stk_incls: "0",
};

const TARGETS = [
  ["rkinfo", "ka10027", "전일대비등락률상위", {}],
  ["rkinfo", "ka10030", "당일거래량상위", {}],
  ["rkinfo", "ka10032", "거래대금상위", {}],
  ["rkinfo", "ka10029", "예상체결등락률상위", {}],
  ["rkinfo", "ka10020", "호가잔량상위", {}],
  ["rkinfo", "ka10033", "신용비율상위", {}],
  ["rkinfo", "ka10034", "외인기간별매매상위", { trde_tp: "2", dt: "1" }],
  ["rkinfo", "ka10035", "외인연속순매매상위", { trde_tp: "2", base_dt_tp: "1" }],
  ["rkinfo", "ka10036", "외인한도소진율증가상위", { dt: "1" }],
  ["rkinfo", "ka10037", "외국계창구매매상위", { dt: "1", trde_tp: "2" }],
  ["rkinfo", "ka10065", "장중투자자별매매상위", { trde_tp: "2", orgn_tp: "9000" }],
  ["stkinfo", "ka10018", "고저가근접", { high_low_tp: "1", alacc_rt: "05" }],
  ["stkinfo", "ka10019", "가격급등락", { flu_tp: "1", tm_tp: "1", tm: "60" }],
];

for (const [uri, id, label, extra] of TARGETS) {
  const res = await fetch(`${BASE}/api/dostk/${uri}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "api-id": id,
    },
    body: JSON.stringify({ ...COMMON, ...extra }),
  });
  const data = await res.json();
  const listKey = Object.keys(data).find((k) => Array.isArray(data[k]));
  const row = listKey ? data[listKey][0] : null;
  console.log(`\n### ${id} ${label}  (/${uri})  listKey=${listKey ?? "-"}`);
  if (!row) {
    console.log(`   rc=${data.return_code} ${String(data.return_msg ?? "").slice(0, 60)}`);
    continue;
  }
  for (const [k, v] of Object.entries(row)) console.log(`   ${k.padEnd(22)} = ${v}`);
  await new Promise((r) => setTimeout(r, 280));
}
