/*
 * 한투 FHPTJ04030000 (시장별 투자자매매동향 · HTS [0403]) 탐침 — 2026-08-25.
 *
 * 목적: **선물(코스피200 선물) 투자자별 수급**을 이 API 가 주는지 실측한다.
 * 키움은 선물 투자자 수급을 안 준다(확인 완료). HTS [0403] 화면에는 선물이
 * 있으므로 그 API 판도 받아줄 가능성이 있다 — 시장 코드가 문서에 없어서
 * 후보를 하나씩 넣어 본다. 추측으로 코드를 박지 않기 위한 절차다.
 *
 * 토큰은 서버가 받아 둔 파일(data/hantooToken.json)을 **재사용**한다 —
 * 새로 발급하면 서버 토큰이 무효화될 수 있다. 키는 절대 출력하지 않는다.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const env = await readFile(join(here, "..", ".env"), "utf-8");
const pick = (k) => env.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim() ?? "";
const APP_KEY = pick("HANTOO_APP_KEY");
const APP_SECRET = pick("HANTOO_APP_SECRET");
const tok = JSON.parse(await readFile(join(here, "..", "data", "hantooToken.json"), "utf-8"));
if (!APP_KEY || !tok.token) {
  console.log("키 또는 토큰 파일이 없습니다");
  process.exit(1);
}

const BASE = "https://openapi.koreainvestment.com:9443";
const PATH = "/uapi/domestic-stock/v1/quotations/inquire-investor-time-by-market";

// (시장구분, 업종구분) 후보 — 예제는 (999, S001) 이었다. 선물 후보를 훑는다
const CANDS = [
  ["999", "S001", "예제 그대로 (코스피 추정)"],
  ["999", "S101", "코스닥 추정"],
  ["999", "F001", "선물 추정 1"],
  ["F001", "S001", "선물 추정 2 (자리 바꿈)"],
  ["999", "101F", "선물 추정 3"],
  ["999", "F101", "선물 추정 4"],
  ["999", "O001", "콜옵션 추정"],
];

for (const [a, b, label] of CANDS) {
  const qs = new URLSearchParams({ FID_INPUT_ISCD: a, FID_INPUT_ISCD_2: b });
  const res = await fetch(`${BASE}${PATH}?${qs}`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${tok.token}`,
      appkey: APP_KEY,
      appsecret: APP_SECRET,
      tr_id: "FHPTJ04030000",
      custtype: "P",
    },
  });
  const body = await res.json().catch(() => ({}));
  const rows = body.output ?? body.output1 ?? [];
  const first = Array.isArray(rows) ? rows[0] : rows;
  console.log(`\n[${a} / ${b}] ${label} — rt_cd=${body.rt_cd} msg=${body.msg1 ?? ""} rows=${Array.isArray(rows) ? rows.length : first ? 1 : 0}`);
  if (first) {
    const keys = Object.keys(first);
    console.log("  fields:", keys.slice(0, 14).join(", "));
    console.log("  sample:", JSON.stringify(Object.fromEntries(keys.slice(0, 8).map((k) => [k, first[k]]))));
  }
  await new Promise((r) => setTimeout(r, 500));
}
