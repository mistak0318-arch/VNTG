/**
 * **통합(_AL)이 시세를 어긋나게 하는 자리 전수 점검** — `npx tsx tools/alAudit.ts [코드]`
 *
 * 벤티지: "이제 KRX가 메인이잖아 KRX로 가는게 맞겠어 … 다른데도 그런데 있는지 찾고 고치자고"
 *
 * `AL_TRS` 의 TR 들은 **수급·거래원·체결** 같은 「현황」을 통합으로 보려고 `_AL` 을 붙인다.
 * 그 자체는 옳다 — 외국인이 NXT 에서 산 것도 산 것이다. 문제는 그 응답에 **날짜별 시세
 * (종가·전일대비)가 같이 실려 오는** 경우다. 화면은 그걸 「그날 종가·등락률」로 적는데,
 * 통합 종가는 **공식 종가가 아니다.**
 *
 * 그래서 TR 마다 bare(KRX)와 `_AL` 을 나란히 찔러 **같은 날 종가가 다른지** 본다.
 * 다르면 그 화면은 증권사·네이버와 어긋난다.
 */
import { readFileSync } from "node:fs";
import { KiwoomClient } from "../src/kiwoomClient.js";

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

const code = process.argv[2] ?? "009150";

/** 날짜별 줄을 주는 TR 들 — 여기에 종가가 실려 오면 통합/KRX 가 갈린다 */
const CASES: {
  tr: string;
  path: string;
  name: string;
  params: Record<string, string>;
  list: string[];
  dateKey: string;
  priceKey: string;
}[] = [
  {
    tr: "ka10059",
    path: "/api/dostk/stkinfo",
    name: "일별 투자자 (투자자 수급 탭)",
    params: { dt: "20261022", amt_qty_tp: "1", trde_tp: "0", unit_tp: "1000" },
    list: ["stk_invsr_orgn"],
    dateKey: "dt",
    priceKey: "cur_prc",
  },
  {
    tr: "ka10060",
    path: "/api/dostk/chart",
    name: "투자자 차트",
    params: { dt: "20261022", amt_qty_tp: "1", trde_tp: "0", unit_tp: "1000" },
    list: ["stk_invsr_orgn_chart"],
    dateKey: "dt",
    priceKey: "cur_prc",
  },
  {
    tr: "ka10015",
    path: "/api/dostk/stkinfo",
    name: "일별 거래상세",
    params: { strt_dt: "20261022" },
    list: ["daly_trde_dtl"],
    dateKey: "dt",
    priceKey: "close_pric",
  },
  {
    tr: "ka10047",
    path: "/api/dostk/mrkcond",
    name: "체결강도 일별",
    params: {},
    list: ["cntr_str_daly"],
    dateKey: "dt",
    priceKey: "cur_prc",
  },
  {
    tr: "ka90013",
    path: "/api/dostk/mrkcond",
    name: "프로그램 일별",
    params: { date: "20261022", amt_qty_tp: "1" },
    list: ["stk_daly_prm_trde_trnsn"],
    dateKey: "dt",
    priceKey: "cur_prc",
  },
];

const pick = (data: Record<string, unknown>, keys: string[]) => {
  for (const k of keys) {
    const v = data?.[k];
    if (Array.isArray(v)) return v as Record<string, string>[];
  }
  return [];
};
const abs = (v: unknown) => Math.abs(Number(String(v ?? "").replace(/[+,\s]/g, ""))) || 0;

console.log(`종목 ${code} — TR 마다 KRX(bare) 와 통합(_AL) 의 날짜별 종가를 맞춰 본다\n`);
for (const c of CASES) {
  const out: Record<string, Map<string, number>> = {};
  for (const [label, noAl] of [
    ["KRX", true],
    ["통합", false],
  ] as const) {
    try {
      const { data } = await client.request<Record<string, unknown>>(
        c.path,
        c.tr,
        { ...c.params, stk_cd: code },
        { noAl },
      );
      const rows = pick(data, c.list);
      out[label] = new Map(rows.slice(0, 6).map((r) => [String(r[c.dateKey] ?? ""), abs(r[c.priceKey])]));
    } catch (e) {
      console.log(`${c.tr} ${c.name} — ❌ ${(e as Error).message}`);
    }
    await new Promise((ok) => setTimeout(ok, 350));
  }
  const krx = out.KRX;
  const all = out["통합"];
  if (!krx || !all || krx.size === 0) {
    console.log(`${c.tr.padEnd(9)}${c.name} — 줄 없음(필드명이 다를 수 있다)\n`);
    continue;
  }
  const diffs: string[] = [];
  for (const [d, v] of krx) {
    const a = all.get(d);
    if (a !== undefined && a !== v && v > 0 && a > 0) {
      diffs.push(`${d}: KRX ${v.toLocaleString()} vs 통합 ${a.toLocaleString()}`);
    }
  }
  console.log(`${c.tr.padEnd(9)}${c.name}`);
  console.log(`          ${diffs.length === 0 ? "✅ 같다 — 통합이어도 종가가 안 어긋난다" : `⚠️ 어긋남 ${diffs.length}건`}`);
  for (const d of diffs.slice(0, 4)) console.log(`            ${d}`);
  console.log();
}
process.exit(0);
