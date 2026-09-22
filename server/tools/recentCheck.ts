/**
 * 최근조회 탭이 쓰는 값 확인 — `ka10095` 한 건으로 표를 채울 수 있나 (2026-09-22).
 *
 * 서버를 안 띄우고 조회 **1회**만 쓴다.
 *
 *   npx tsx tools/recentCheck.ts [종목코드...]
 */
import "dotenv/config";
import { createKiwoomClientFromEnv } from "../src/kiwoomClient.js";
import { extras } from "../src/rankExtras.js";
import { getStockIndex } from "../src/stockListCache.js";

const codes = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["005930", "000660", "069500"]).filter((c) =>
  /^\d{6}$/.test(c),
);

const client = createKiwoomClientFromEnv();
const index = await getStockIndex(client).catch(() => new Map());
const { data } = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10095", {
  stk_cd: codes.map((c) => `${c}_AL`).join("|"),
});
const rows = (data.atn_stk_infr ?? []) as Record<string, unknown>[];
console.log(`받은 줄: ${rows.length} / 물은 종목 ${codes.length}`);
if (rows[0]) console.log("칸 이름:", Object.keys(rows[0]).join(" "));

const need = ["stk_cd", "stk_nm", "cur_prc", "flu_rt", "trde_qty", "trde_prica"];
const missing = need.filter((k) => rows[0] === undefined || !(k in rows[0]));
console.log(missing.length === 0 ? "필요한 칸 전부 있음 ✔" : `⚠️ 없는 칸: ${missing.join(", ")}`);

for (const r of rows) {
  const code = String(r.stk_cd ?? "").replace(/_(AL|NX)$/i, "");
  const ex = extras(r, index.get(code));
  console.log(
    `${code} ${String(r.stk_nm).padEnd(10)} 현재가 ${String(r.cur_prc).padStart(9)} · 등락 ${String(r.flu_rt).padStart(7)} · ` +
      `거래대금(원값) ${String(r.trde_prica).padStart(10)} → tv ${ex.tv}억 · 거래량 ${String(r.trde_qty).padStart(10)} · ` +
      `시총 ${ex.cap}억 · ${ex.mkt || "(시장없음)"} · ETF ${ex.etf} · 보통주 ${ex.common}`,
  );
}
process.exit(missing.length === 0 && rows.length === codes.length ? 0 : 1);
