/**
 * HS코드 후보를 실제로 찔러보고 쓸 만한 것만 골라낸다.
 *
 * 코드를 기억으로 적으면 엉뚱한 품목이 들어온다. 실제 응답의 품목명(statKor)과
 * 수출입 규모를 보고 판단하는 게 유일하게 안전한 방법이다.
 *
 * 실행: cd server && node scripts/hs-probe.mjs
 */
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(serverRoot, ".env") });

const key = process.env.DATA_GO_KR_KEY?.trim();
if (!key) {
  console.error("DATA_GO_KR_KEY 가 .env 에 없습니다.");
  process.exit(1);
}

const ENDPOINT = "https://apis.data.go.kr/1220000/Itemtrade/getItemtradeList";

/** 확인할 후보. 이름은 내가 붙인 가설이고, 실제 품목명은 응답을 봐야 안다 */
const CANDIDATES = [
  // 전력기기
  ["8504", "변압기·정류기 (전력기기)"],
  ["8544", "절연전선·케이블"],
  ["8535", "고압 개폐기"],
  ["8536", "저압 개폐기·커넥터"],
  ["8537", "배전반·제어반"],
  // 디스플레이
  ["8524", "평판디스플레이 모듈"],
  ["9013", "액정디바이스"],
  // 바이오·의약
  ["3002", "혈액분획제제·백신"],
  ["3004", "의약품 (완제)"],
  ["9018", "의료기기"],
  // 화장품 계열 확장
  ["3304", "화장품 (기초·색조)"],
  ["3307", "면도·목욕용 제품"],
  ["3401", "비누·세정제"],
  // 기계·건설
  ["8429", "불도저·굴착기"],
  ["8481", "밸브"],
  ["8413", "펌프"],
  ["8477", "고무·플라스틱 가공기계"],
  // 식품
  ["1902", "면류 (라면 등)"],
  ["2106", "기타 조제식료품"],
  ["2009", "과실·채소 주스"],
  // 기타 제조
  ["4011", "타이어"],
  ["8471", "컴퓨터·주변기기"],
  ["8473", "컴퓨터 부품"],
  ["9001", "광섬유·렌즈"],
  ["3907", "폴리에스터·수지"],
  ["3902", "폴리프로필렌"],
  ["7601", "알루미늄"],
  ["7403", "구리"],
  ["8802", "항공기·부품"],
  ["9306", "탄약·발사체 (방산)"],
];

const now = new Date();
const ym = (d) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
const from = ym(new Date(now.getFullYear(), now.getMonth() - 2, 1));
const to = ym(now);

function parse(xml) {
  const out = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1];
    const g = (t) => {
      const r = new RegExp(`<${t}>([^<]*)</${t}>`).exec(b);
      return r ? r[1].trim() : "";
    };
    const year = g("year");
    if (!/^\d{4}\.\d{2}$/.test(year)) continue; // 총계 행 제외
    out.push({
      month: year.replace(".", "-"),
      name: g("statKor"),
      exp: Number(g("expDlr")) || 0,
      imp: Number(g("impDlr")) || 0,
    });
  }
  return out;
}

console.log(`${CANDIDATES.length}개 HS코드를 확인합니다 (${from}~${to})\n`);
console.log("HS    수출(억$)  수입(억$)  주요 품목");
console.log("─".repeat(78));

const useful = [];

for (const [hs, guess] of CANDIDATES) {
  const qs = new URLSearchParams({
    serviceKey: key,
    strtYymm: from,
    endYymm: to,
    hsSgn: hs,
    numOfRows: "100",
    pageNo: "1",
  });

  let rows = [];
  try {
    const res = await fetch(`${ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(20000) });
    rows = parse(await res.text());
  } catch {
    console.log(`${hs.padEnd(6)} 조회 실패 (${guess})`);
    continue;
  }

  if (rows.length === 0) {
    console.log(`${hs.padEnd(6)} 데이터 없음 (${guess})`);
    continue;
  }

  const latest = rows.reduce((a, b) => (a.month > b.month ? a : b)).month;
  const cur = rows.filter((r) => r.month === latest);
  const exp = cur.reduce((s, r) => s + r.exp, 0);
  const imp = cur.reduce((s, r) => s + r.imp, 0);
  const names = [...cur]
    .sort((a, b) => Math.max(b.exp, b.imp) - Math.max(a.exp, a.imp))
    .slice(0, 2)
    .map((r) => r.name)
    .join(", ");

  const e = (exp / 1e8).toFixed(1);
  const i = (imp / 1e8).toFixed(1);
  console.log(`${hs.padEnd(6)}${e.padStart(9)}${i.padStart(11)}  ${names}`);

  // 월 1억 달러(=100M) 이상이면 시장에 의미가 있다고 본다
  const big = Math.max(exp, imp) >= 1e8;
  if (big) useful.push({ hs, guess, exp, imp, names, watch: exp >= imp ? "export" : "import" });

  await new Promise((r) => setTimeout(r, 200));
}

console.log("\n" + "─".repeat(78));
console.log(`쓸 만한 것 (월 1억 달러 이상): ${useful.length}개\n`);
for (const u of useful) {
  console.log(
    `  ${u.hs}  ${u.watch === "export" ? "수출" : "수입"} ${(Math.max(u.exp, u.imp) / 1e8).toFixed(1)}억$  ${u.guess}`,
  );
  console.log(`        실제 품목명: ${u.names}`);
}
