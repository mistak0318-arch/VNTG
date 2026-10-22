/**
 * **테마 기간 등락률 검산** — `npx tsx tools/themeAudit.ts 자전거 "고체산화물" ...`
 *
 * 벤티지: "대세테마 로직도 한 번 더 로직 점검 좀 해봐 5일 20일 등락률이 실제랑 안 맞는거 같네"
 *
 * 화면 값이 어떻게 나왔는지 **두 가지 방식으로 재현**해 어느 쪽인지 가린다:
 *
 *   ① 종목별 N일 수익률의 평균   `avg(cumOf(closes, N))`   ← `cumTheme`, 일봉 기준
 *   ② 테마 일별 평균의 누적       `cumulative(series, N)`   ← `build`, 기록 기준
 *
 * 국내 테마는 ①이 ②를 덮게 되어 있는데(`if (c.w1 !== null)`), **덮기 조건이 붙어 있어**
 * 종목 절반이 일봉 캐시에 없으면 ②가 그대로 남는다. 둘이 얼마나 벌어지는지 본다.
 *
 * 일봉은 **한투**로 받는다 — 장이 끝난 뒤라도 키움 토큰을 건드리지 않으려고.
 */
import { readFileSync } from "node:fs";
import { hantooGet } from "../src/hantooClient.js";

for (const raw of readFileSync("./.env", "utf-8").split(/\r?\n/)) {
  const line = raw.replace(/﻿/g, "");
  const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

interface ThemeRow {
  name: string;
  no?: number;
  stocks?: { code: string; name: string }[];
}

const store = JSON.parse(readFileSync("./data/naverThemes.json", "utf-8")) as { themes?: ThemeRow[] };
const themes = store.themes ?? [];
const snap = JSON.parse(readFileSync("./data/marketSnapshot.json", "utf-8")) as {
  stocks?: { code: string; name: string; changeRate: number }[];
};
const snapBy = new Map((snap.stocks ?? []).map((s) => [s.code, s]));

const ymd = (d: Date) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
const end = new Date();
const start = new Date(end.getTime() - 120 * 86400_000);

/** 한투 일봉 종가 — **과거→오늘** 순으로 */
async function closesOf(code: string): Promise<number[]> {
  const body = await hantooGet<{ output2?: Record<string, string>[] }>(
    "/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice",
    "FHKST03010100",
    {
      FID_COND_MRKT_DIV_CODE: "J",
      FID_INPUT_ISCD: code,
      FID_INPUT_DATE_1: ymd(start),
      FID_INPUT_DATE_2: ymd(end),
      FID_PERIOD_DIV_CODE: "D",
      FID_ORG_ADJ_PRC: "0",
    },
    "테마검산",
  );
  return (body.output2 ?? [])
    .filter((r) => r.stck_bsop_date && Number(r.stck_clpr) > 0)
    .map((r) => Number(r.stck_clpr))
    .reverse();
}

/** `dailyCloses.cumOf` 와 같은 정의 — N거래일 전 종가 대비 */
const cumOf = (c: number[], n: number) =>
  c.length < n + 1 ? null : ((c[c.length - 1] - c[c.length - 1 - n]) / c[c.length - 1 - n]) * 100;

const avg = (v: (number | null)[]) => {
  const ok = v.filter((x): x is number => x !== null);
  return ok.length ? ok.reduce((a, b) => a + b, 0) / ok.length : null;
};
const f = (v: number | null) => (v === null ? "   -  " : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`);

for (const want of process.argv.slice(2)) {
  const t = themes.find((x) => String(x.name).includes(want));
  if (!t) {
    console.log(`\n### ${want} — 테마 못 찾음`);
    continue;
  }
  const stocks = t.stocks ?? [];
  console.log(`\n######## ${t.name} (테마 ${t.no}) · 종목 ${stocks.length}개 ########`);
  console.log("종목              오늘(스냅샷)      5일      20일      60일");
  const per: { d5: number | null; d20: number | null; d60: number | null; today: number | null }[] = [];
  for (const s of stocks) {
    let c: number[] = [];
    try {
      c = await closesOf(s.code);
    } catch (e) {
      console.log(`  ${s.name} — 일봉 실패 ${(e as Error).message}`);
    }
    await new Promise((ok) => setTimeout(ok, 450));
    const row = {
      today: snapBy.get(s.code)?.changeRate ?? null,
      d5: cumOf(c, 5),
      d20: cumOf(c, 20),
      d60: cumOf(c, 60),
    };
    per.push(row);
    console.log(
      `  ${s.name.padEnd(14)}${f(row.today).padStart(10)}${f(row.d5).padStart(11)}${f(row.d20).padStart(10)}${f(row.d60).padStart(10)}  (봉 ${c.length})`,
    );
  }
  console.log(
    `  ${"── 단순평균".padEnd(14)}${f(avg(per.map((p) => p.today))).padStart(10)}` +
      `${f(avg(per.map((p) => p.d5))).padStart(11)}${f(avg(per.map((p) => p.d20))).padStart(10)}` +
      `${f(avg(per.map((p) => p.d60))).padStart(10)}`,
  );
}
process.exit(0);
