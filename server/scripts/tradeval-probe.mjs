/**
 * 거래대금상위(ka10032)가 ETF·ETN 을 걸러 주는지 확인한다.
 *
 * 신호등 스크리너의 모집단이 거래대금 상위인데, 실제로 돌려 보니
 * KODEX 200 / TIGER 200 / 삼성전자우 같은 것들이 상위를 채운다.
 * ETF는 "정배열·수급"만으로 만점이 나오므로 종목 발굴에 방해가 된다.
 *
 * ka10032 문서에는 mrkt_tp / mang_stk_incls / stex_tp 만 있지만,
 * 다른 순위 TR이 쓰는 stk_cnd(16=ETF+ETN 제외)를 받아 주는지 실제로 넣어 본다.
 *
 *   node scripts/tradeval-probe.mjs
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

const tokenRes = await fetch(`${BASE}/oauth2/token`, {
  method: "POST",
  headers: { "Content-Type": "application/json;charset=UTF-8" },
  body: JSON.stringify({
    grant_type: "client_credentials",
    appkey: process.env.KIWOOM_APP_KEY,
    secretkey: process.env.KIWOOM_APP_SECRET,
  }),
});
const { token } = await tokenRes.json();
if (!token) throw new Error("토큰 발급 실패");

async function call(params) {
  const res = await fetch(`${BASE}/api/dostk/rkinfo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "api-id": "ka10032",
    },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  return json;
}

const CASES = [
  ["기본", { mrkt_tp: "000", mang_stk_incls: "0", stex_tp: "3" }],
  ["stk_cnd=16", { mrkt_tp: "000", mang_stk_incls: "0", stk_cnd: "16", stex_tp: "3" }],
  ["stk_cnd=16+mang=1", { mrkt_tp: "000", mang_stk_incls: "1", stk_cnd: "16", stex_tp: "3" }],
];

for (const [label, params] of CASES) {
  const json = await call(params);
  const rows = json.trde_prica_upper ?? [];
  console.log(`\n=== ${label} === rc=${json.return_code} msg=${json.return_msg} rows=${rows.length}`);
  if (rows.length) {
    console.log("필드:", Object.keys(rows[0]).join(", "));
    for (const r of rows.slice(0, 12)) {
      console.log(`  ${r.stk_cd}  ${String(r.stk_nm).padEnd(22)} ${r.trde_prica}`);
    }
  }
  await new Promise((r) => setTimeout(r, 400));
}
