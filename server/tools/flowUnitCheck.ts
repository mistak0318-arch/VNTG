/**
 * **투자자 순매수 단위 검산** — `npx tsx tools/flowUnitCheck.ts`
 *
 * 벤티지: "오늘 외국인은 코스피에서 3896억을 팔았어" — 그런데 AI 정리는
 * 「36억 9,200만 원」이라 썼다. 100 배 차이다.
 *
 * `marketOverview.ts` 주석은 ka10051 이 **억원**이라 적어 두었지만 그건 **문서 말**이다.
 * 원시값을 그대로 찍어 벤티지가 아는 숫자와 맞춰 본다 — 곱해서 확인한다.
 */
import { readFileSync } from "node:fs";
import { KiwoomClient } from "../src/kiwoomClient.js";

/*
 * ⚠️ `.env` 첫 줄에 **UTF-8 BOM** 이 붙어 있다. `import "dotenv/config"` 로 읽으면
 * 첫 키 이름이 BOM 붙은 이름이 되어 **조용히 사라진다** — 그래서 KIWOOM_APP_KEY 만
 * undefined 였다(서버 본체는 `dotenv.config({path})` 라 괜찮다). 직접 벗겨서 읽는다.
 */
/* BOM 이 **파일 맨 앞이 아니라 둘째 줄 앞**에 박혀 있다 — 줄마다 벗긴다 */
for (const raw of readFileSync("./.env", "utf-8").split(/\r?\n/)) {
  const line = raw.replace(/﻿/g, "");
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const client = new KiwoomClient({
  appKey: process.env.KIWOOM_APP_KEY ?? "",
  appSecret: process.env.KIWOOM_APP_SECRET ?? "",
  isMock: process.env.KIWOOM_IS_MOCK === "true",
});

for (const [name, mrkt, idx] of [
  ["코스피", "0", "001"],
  ["코스닥", "1", "101"],
] as const) {
  const { data } = await client.request<Record<string, unknown>>(
    "/api/dostk/sect",
    "ka10051",
    { mrkt_tp: mrkt, amt_qty_tp: "0", base_dt: "", stex_tp: "3" },
    { noAl: true },
  );
  const rows = (data?.inds_netprps as Record<string, string>[]) ?? [];
  const total = rows.find((r) => String(r.inds_cd ?? "").startsWith(idx)) ?? rows[0];
  console.log(`\n===== ${name} (행 ${rows.length}) =====`);
  if (!total) {
    console.log("종합 행 없음. 응답 키:", Object.keys(data ?? {}).join(","));
    continue;
  }
  console.log("종합 행:", JSON.stringify(total));
  for (const [who, key] of [
    ["외국인", "frgnr_netprps"],
    ["기관", "orgn_netprps"],
    ["개인", "ind_netprps"],
  ] as const) {
    const v = Number(total[key]);
    console.log(
      `${who.padEnd(4)} 원시 ${String(v).padStart(12)}  |  억원이면 ${v.toLocaleString()}억  |  백만원이면 ${(v / 100).toLocaleString()}억`,
    );
  }
}
process.exit(0);
