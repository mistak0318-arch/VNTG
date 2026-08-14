/**
 * 순위정보(rkinfo) TR 중 무엇이 실제로 되는지 확인한다.
 *
 * 키움 HTS의 [0194] 순위분석·시세분석에 있는 목록을 우리 화면에도 넣으려면
 * 먼저 REST로 열려 있는 TR이 무엇인지 알아야 한다. 문서만 보고 화면부터 만들면
 * 절반은 데이터가 안 와서 못 쓴다.
 *
 * 파라미터는 TR마다 다르므로 공통 후보를 한꺼번에 넣고 return_msg 로 판별한다.
 * 키움은 필수값이 빠지면 그 이름을 메시지에 알려주므로 그걸 보고 좁히면 된다.
 *
 *   node scripts/rank-probe.mjs
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

/** 순위 TR들이 공통으로 쓰는 값들. 안 쓰는 TR은 무시한다 */
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
  mrkt_open_tp: "0",
  rank_strt: "0",
  rank_end: "20",
};

const TARGETS = [
  ["ka10017", "상하한가"],
  ["ka10018", "고저가근접"],
  ["ka10019", "가격급등락"],
  ["ka10020", "호가잔량상위"],
  ["ka10023", "거래량급증"],
  ["ka10029", "예상체결등락률상위"],
  ["ka10031", "전일거래량상위"],
  ["ka10032", "거래대금상위"],
  ["ka10033", "신용비율상위"],
  ["ka10034", "외인기간별매매상위"],
  ["ka10035", "외인연속순매매상위"],
  ["ka10036", "외인한도소진율증가상위"],
  ["ka10037", "외국계창구매매상위"],
  ["ka10038", "종목별증권사순위"],
  ["ka10039", "증권사별매매상위"],
  ["ka10040", "당일주요거래원"],
  ["ka10042", "순매수거래원순위"],
  ["ka10044", "일별기관매매종목"],
  ["ka10045", "종목별기관매매추이"],
  ["ka10053", "당일상위이탈원"],
  ["ka10065", "장중투자자별매매상위"],
  ["ka10098", "시간외단일가등락율순위"],
];

async function probe(apiId) {
  const res = await fetch(`${BASE}/api/dostk/rkinfo`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json;charset=UTF-8",
      authorization: `Bearer ${token}`,
      "api-id": apiId,
    },
    body: JSON.stringify(COMMON),
  });
  const data = await res.json();
  const keys = Object.keys(data).filter((k) => Array.isArray(data[k]));
  const rows = keys.length > 0 ? data[keys[0]] : [];
  return {
    code: data.return_code,
    msg: String(data.return_msg ?? "").trim().slice(0, 60),
    listKey: keys[0] ?? "",
    count: rows.length,
    fields: rows[0] ? Object.keys(rows[0]).slice(0, 10).join(",") : "",
  };
}

for (const [id, label] of TARGETS) {
  try {
    const r = await probe(id);
    const ok = r.code === 0 && r.count > 0;
    console.log(
      `${ok ? "OK " : "-- "} ${id} ${label.padEnd(20)} rc=${r.code} ${r.count}건 ${r.listKey}` +
        (ok ? `\n      ${r.fields}` : `  ← ${r.msg}`),
    );
  } catch (err) {
    console.log(`ERR ${id} ${label} — ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, 260));
}
