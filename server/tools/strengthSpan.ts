/**
 * **ka10046 이 하루치를 주는가** (2026-10-08 실측).
 *
 * 벤티지: "체결강도는 장 끝나고 나서는 기록이 안 되는 것 같거든 … 장 중에 어땠는지 알 수가 없네"
 * 캡처를 보니 18:01 에 그래프가 17:02~18:01, **딱 60분**이었다. 한 번 부르면 60줄만 온다는 뜻인데,
 * 그렇다면 장중에 봐도 「장 초반」은 애초에 안 나온다. 연속조회로 과거를 더 끌어올 수 있는지 잰다.
 *
 *   npx tsx tools/strengthSpan.ts 005930
 *
 * ⚠️ 조회를 쓴다(최대 5회). 장중에는 돌리지 말 것.
 */
import "dotenv/config";
import { createKiwoomClientFromEnv } from "../src/kiwoomClient.js";

const code = process.argv[2] ?? "005930";
const client = createKiwoomClientFromEnv();
const al = /^\d{6}$/.test(code) ? `${code}_AL` : code;

let contYn = "N";
let nextKey = "";
for (let page = 1; page <= 5; page++) {
  const r = await client.request<Record<string, unknown>>(
    "/api/dostk/mrkcond",
    "ka10046",
    { stk_cd: al },
    page === 1 ? {} : { contYn, nextKey },
  );
  const rows = (r.data.cntr_str_tm ?? []) as { cntr_tm?: string; cntr_str?: string }[];
  const t = rows.map((x) => String(x.cntr_tm ?? ""));
  console.log(
    `[${page}쪽] ${rows.length}줄 · ${t[t.length - 1] ?? "-"} ~ ${t[0] ?? "-"} · cont-yn=${r.contYn} next-key=${r.nextKey ? r.nextKey.slice(0, 12) + "…" : "(없음)"}`,
  );
  if (page === 1 && rows[0]) console.log("   첫 줄 키들:", Object.keys(rows[0]).join(", "));
  if (r.contYn !== "Y" || !r.nextKey) {
    console.log("   → 더 없음");
    break;
  }
  contYn = "Y";
  nextKey = r.nextKey;
}
process.exit(0);
