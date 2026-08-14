/**
 * rank-probe 2차 — 1차에서 알아낸 필수 파라미터를 채워 다시 확인하고,
 * rkinfo 에 없던 TR(상하한가·고저가근접·가격급등락)을 다른 URI에서 찾는다.
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

/** [apiId, 이름, URI, 추가 파라미터] */
const TARGETS = [
  ["ka10023", "거래량급증", "rkinfo", { tm_tp: "2", tm: "60", trde_qty_tp: "5" }],
  ["ka10031", "전일거래량상위", "rkinfo", { qry_tp: "1", rank_strt: "0", rank_end: "20" }],
  ["ka10032", "거래대금상위", "rkinfo", {}],
  ["ka10034", "외인기간별매매상위", "rkinfo", { trde_tp: "2", dt: "1" }],
  ["ka10035", "외인연속순매매상위", "rkinfo", { trde_tp: "2", base_dt_tp: "1" }],
  ["ka10036", "외인한도소진율증가상위", "rkinfo", { dt: "1" }],
  ["ka10037", "외국계창구매매상위", "rkinfo", { dt: "1", trde_tp: "2", sort_tp: "1" }],
  ["ka10065", "장중투자자별매매상위", "rkinfo", { trde_tp: "2", mrkt_tp: "000", orgn_tp: "9000" }],
  ["ka10098", "시간외단일가등락율순위", "rkinfo", { sort_base: "1" }],
  // rkinfo 에 없던 것들 — 시세(mrkcond)나 종목정보(stkinfo) 쪽일 수 있다
  ["ka10017", "상하한가", "stkinfo", { updown_tp: "1", sort_tp: "1", stk_cnd: "0", trde_qty_tp: "00000" }],
  ["ka10017", "상하한가", "mrkcond", { updown_tp: "1", sort_tp: "1", stk_cnd: "0", trde_qty_tp: "00000" }],
  ["ka10018", "고저가근접", "stkinfo", { high_low_tp: "1", alacc_rt: "05", trde_qty_tp: "00000" }],
  ["ka10018", "고저가근접", "mrkcond", { high_low_tp: "1", alacc_rt: "05", trde_qty_tp: "00000" }],
  ["ka10019", "가격급등락", "stkinfo", { flu_tp: "1", tm_tp: "1", tm: "60", trde_qty_tp: "00000" }],
  ["ka10019", "가격급등락", "mrkcond", { flu_tp: "1", tm_tp: "1", tm: "60", trde_qty_tp: "00000" }],
];

for (const [id, label, uri, extra] of TARGETS) {
  try {
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
    const keys = Object.keys(data).filter((k) => Array.isArray(data[k]));
    const rows = keys.length > 0 ? data[keys[0]] : [];
    const ok = data.return_code === 0 && rows.length > 0;
    console.log(
      `${ok ? "OK " : "-- "} ${id} ${label.padEnd(18)} /${uri.padEnd(8)} ${rows.length}건 ${keys[0] ?? ""}` +
        (ok
          ? `\n      ${Object.keys(rows[0]).slice(0, 9).join(",")}`
          : `  ← ${String(data.return_msg ?? "").trim().slice(0, 58)}`),
    );
  } catch (err) {
    console.log(`ERR ${id} ${label} — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 260));
}
