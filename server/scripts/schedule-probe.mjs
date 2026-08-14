/**
 * "오늘 일정" 을 만들 수 있는지 확인한다.
 *
 * 인포스탁 조간의 2번 섹션(이슈 & 테마 스케줄)에는 실적발표·상장/폐지·유상증자·
 * 거래정지가 날짜별로 붙는다. 우리에겐 그게 통째로 없다.
 *
 * 확인할 것:
 *   1) DART list.json 이 corp_code 없이 날짜만으로 전체 공시를 주는가
 *   2) 공시유형(pblntf_ty)으로 상장/증자/거래정지 같은 이벤트를 골라낼 수 있는가
 *   3) 하루 분량이 몇 건이나 되는가 (많으면 걸러낼 기준이 필요하다)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(here, "..", ".env"), "utf-8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const KEY = process.env.DART_API_KEY;
if (!KEY) throw new Error("DART_API_KEY 없음");

const ymd = (d) =>
  `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;

/** 직전 거래일쯤을 본다 — 오늘 새벽이면 아직 공시가 없다 */
const day = ymd(new Date(Date.now() - 24 * 3600_000));

async function call(params) {
  const q = new URLSearchParams({ crtfc_key: KEY, ...params });
  const res = await fetch(`https://opendart.fss.or.kr/api/list.json?${q}`);
  return res.json();
}

// 1) corp_code 없이 날짜만
const all = await call({ bgn_de: day, end_de: day, page_count: "100" });
console.log(`[전체 공시 ${day}] status=${all.status} msg=${all.message}`);
console.log(`  총 ${all.total_count ?? 0}건 / 페이지 ${all.total_page ?? 0}`);

if (all.status !== "000") {
  console.log("  → corp_code 없이는 안 되는 것으로 보임");
  process.exit(0);
}

// 2) 공시유형별 분포
const types = new Map();
for (const it of all.list ?? []) {
  const t = it.corp_cls + "/" + (it.report_nm ?? "").slice(0, 20);
  types.set(t, (types.get(t) ?? 0) + 1);
}
console.log("\n[샘플 20건]");
for (const it of (all.list ?? []).slice(0, 20)) {
  console.log(`  ${it.corp_cls} ${String(it.corp_name).padEnd(14)} ${it.report_nm}`);
}

// 3) 유형 코드로 좁혀지는지 — I:거래소공시, B:주요사항보고
for (const [code, label] of [["I", "거래소공시"], ["B", "주요사항보고"], ["C", "발행공시"]]) {
  const r = await call({ bgn_de: day, end_de: day, pblntf_ty: code, page_count: "10" });
  console.log(`\n[${code} ${label}] status=${r.status} 총 ${r.total_count ?? 0}건`);
  for (const it of (r.list ?? []).slice(0, 8)) {
    console.log(`  ${String(it.corp_name).padEnd(14)} ${it.report_nm}`);
  }
  await new Promise((x) => setTimeout(x, 300));
}
