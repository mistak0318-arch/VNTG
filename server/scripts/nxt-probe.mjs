/**
 * NXT(대체거래소) 값이 따로 나오는지 확인한다.
 *
 * 우리는 지금 모든 조회에 stex_tp="3"(통합)을 쓰고 있다. 그러면 화면의 등락률·거래량이
 * KRX와 NXT를 합친 값이라는 뜻인데, 정작 어느 쪽에서 얼마가 거래됐는지는 알 수 없다.
 *
 * 확인할 것:
 *   1) stex_tp 1(KRX) / 2(NXT) / 3(통합) 이 실제로 다른 값을 주는가
 *   2) 고가·저가도 거래소별로 갈리는가
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

async function call(uri, apiId, body) {
  const res = await fetch(`${BASE}/api/dostk/${uri}`, {
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

const LABEL = { 1: "KRX", 2: "NXT", 3: "통합" };

// 1) 등락률상위 — 거래소별로 순위와 거래량이 갈리는가
console.log("=== ka10027 전일대비등락률상위 (상위 3종목) ===");
for (const tp of ["1", "2", "3"]) {
  const d = await call("rkinfo", "ka10027", {
    mrkt_tp: "000",
    sort_tp: "1",
    trde_qty_cnd: "0000",
    stk_cnd: "0",
    crd_cnd: "0",
    updown_incls: "1",
    pric_cnd: "0",
    trde_prica_cnd: "0",
    stex_tp: tp,
  });
  const rows = d.pred_pre_flu_rt_upper ?? [];
  console.log(`  [${LABEL[tp]}] ${rows.length}건`);
  for (const r of rows.slice(0, 3)) {
    console.log(`     ${String(r.stk_nm).padEnd(14)} ${String(r.flu_rt).padStart(7)}% 거래량 ${r.now_trde_qty}`);
  }
  await new Promise((r) => setTimeout(r, 300));
}

// 2) 종목 기본정보 — 고가/저가가 거래소별로 갈리는가
console.log("\n=== ka10001 주식기본정보 (삼성전자) ===");
const info = await call("stkinfo", "ka10001", { stk_cd: "005930" });
const pick = ["cur_prc", "high_pric", "low_pric", "open_pric", "trde_qty", "flu_rt"];
console.log("  " + pick.map((k) => `${k}=${info[k]}`).join("  "));
console.log("  응답 키에 NXT/KRX 구분이 있는가:",
  Object.keys(info).filter((k) => /nxt|krx|stex|exch/i.test(k)).join(", ") || "없음");

// 3) 체결정보(ka10003) 등에 거래소 구분이 있는지
console.log("\n=== ka10003 체결정보 (삼성전자) ===");
const trd = await call("stkinfo", "ka10003", { stk_cd: "005930" });
const key = Object.keys(trd).find((k) => Array.isArray(trd[k]));
const first = key ? trd[key][0] : null;
console.log("  rc=", trd.return_code, "리스트키=", key, "필드=", first ? Object.keys(first).join(",") : "-");
