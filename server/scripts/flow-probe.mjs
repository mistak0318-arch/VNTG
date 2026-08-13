/**
 * ka10051(업종별투자자순매수)이 업종별 행을 주는지 확인한다.
 *
 * marketOverview.ts 는 이 응답에서 종합지수 한 줄만 뽑아 쓰고 나머지를 버린다.
 * 버려지는 행에 업종별 외국인·기관 순매수가 들어 있다면, 추가 호출 없이
 * "자금이 어느 업종에서 어느 업종으로 옮겨갔나"를 만들 수 있다.
 *
 * 실행: node scripts/flow-probe.mjs
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

// .env 를 직접 읽는다 (서버를 띄우지 않고 확인하기 위해)
for (const line of readFileSync(join(here, "..", ".env"), "utf-8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const BASE = process.env.KIWOOM_IS_MOCK === "true" ? "https://mockapi.kiwoom.com" : "https://api.kiwoom.com";

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

async function call(apiId, body) {
  const res = await fetch(`${BASE}/api/dostk/sect`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "api-id": apiId,
    },
    body: JSON.stringify(body),
  });
  return res.json();
}

/**
 * base_dt 에 과거 날짜를 넣으면 그날 수치가 나오는지.
 *
 * 이게 되면 업종별 자금 이동을 **소급해서** 만들 수 있다.
 * 안 되면 시장 폭처럼 오늘부터 하루씩 쌓는 수밖에 없다 — 설계가 완전히 달라진다.
 */
const dates = ["", "20260813", "20260812", "20260811", "20260807"];
for (const base of dates) {
  const data = await call("ka10051", { mrkt_tp: "0", amt_qty_tp: "0", base_dt: base, stex_tp: "3" });
  const rows = data.inds_netprps ?? [];
  const total = rows.find((r) => String(r.inds_cd ?? "").startsWith("001"));
  const chem = rows.find((r) => String(r.inds_nm ?? "") === "화학");
  console.log(
    `base_dt=${(base || "(빈값)").padEnd(10)} rc=${data.return_code} rows=${String(rows.length).padStart(3)}` +
      ` | 종합 외인 ${String(total?.frgnr_netprps ?? "-").padStart(8)} 기관 ${String(total?.orgn_netprps ?? "-").padStart(8)}` +
      ` | 화학 외인 ${String(chem?.frgnr_netprps ?? "-").padStart(7)}`,
  );
  await new Promise((r) => setTimeout(r, 400));
}
