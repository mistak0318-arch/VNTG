/**
 * 관세청 무역통계 API 스펙 탐색.
 *
 * 공공데이터포털 문서 페이지에는 엔드포인트와 파라미터가 안 적혀 있다.
 * 그래서 후보 주소를 순서대로 찔러보고, 성공한 것의 **실제 응답 필드**를 뽑아낸다.
 * 그 결과를 보고 수집 모듈을 붙이면 추측 없이 정확하게 만들 수 있다.
 *
 * 쓰는 법:
 *   cd server
 *   node scripts/trade-probe.mjs                    # 후보 자동 탐색
 *   node scripts/trade-probe.mjs "<엔드포인트 URL>"  # 문서에서 확인한 주소로 직접
 */
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: join(serverRoot, ".env") });

const key = process.env.DATA_GO_KR_KEY?.trim();
if (!key) {
  console.error("DATA_GO_KR_KEY 가 .env 에 없습니다.");
  console.error("docs/수출입API_설정가이드.md 를 보고 발급받아 넣으세요.");
  process.exit(1);
}

// 인코딩 키를 넣으면 이중 인코딩으로 실패한다 — 가장 흔한 사고라 미리 잡는다
if (/%[0-9A-Fa-f]{2}/.test(key)) {
  console.warn("⚠ 키에 %XX 가 보입니다 — Encoding 키를 넣으신 것 같습니다.");
  console.warn("  Decoding 키로 바꿔주세요. 안 그러면 SERVICE_KEY_IS_NOT_REGISTERED_ERROR 가 납니다.\n");
}

/**
 * 후보 엔드포인트.
 * 공공데이터포털은 기관코드/서비스명 조합이 API마다 달라서 한 번에 못 맞춘다.
 * 관세청 기관코드는 1220000 이다.
 */
const CANDIDATES = [
  // 수입 주요품목별 10일 단위 잠정치 (15157901)
  "https://apis.data.go.kr/1220000/Itemtrade/getItemtradeList",
  "https://apis.data.go.kr/1220000/nitemtrade/getNitemtradeList",
  "https://apis.data.go.kr/1220000/ImpMajorItem10Days/getImpMajorItem10DaysList",
  // 품목별 수출입실적 (15101609)
  "https://apis.data.go.kr/1220000/Itemtrade/getItemtrade",
  "https://apis.data.go.kr/1220000/itemtrade/getItemtradeList",
  // 국가별 수출입실적 (15101612)
  "https://apis.data.go.kr/1220000/Nationtrade/getNationtradeList",
];

const targets = process.argv[2] ? [process.argv[2]] : CANDIDATES;

/** 이 API들이 흔히 쓰는 파라미터 조합 */
function paramSets() {
  const now = new Date();
  const ym = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevYm = `${prev.getFullYear()}${String(prev.getMonth() + 1).padStart(2, "0")}`;
  return [
    { strtYymm: prevYm, endYymm: ym, hsSgn: "8542" }, // 반도체 HS 8542
    { strtYymm: prevYm, endYymm: ym },
    { searchBgnDe: prevYm, searchEndDe: ym },
    { basDt: prevYm },
    {},
  ];
}

/** 응답에서 실제 필드 이름을 뽑는다 (XML/JSON 모두) */
function extractFields(body) {
  const tags = [...body.matchAll(/<([a-zA-Z][\w]*)>/g)].map((m) => m[1]);
  if (tags.length > 0) return [...new Set(tags)];
  try {
    const j = JSON.parse(body);
    const walk = (o, depth = 0) => {
      if (depth > 4 || !o || typeof o !== "object") return [];
      if (Array.isArray(o)) return o.length ? walk(o[0], depth + 1) : [];
      return Object.keys(o).flatMap((k) => [k, ...walk(o[k], depth + 1)]);
    };
    return [...new Set(walk(j))];
  } catch {
    return [];
  }
}

/** 공공데이터포털의 표준 오류 메시지를 읽기 좋게 */
function readError(body) {
  const m =
    /<returnAuthMsg>([^<]+)</.exec(body) ??
    /<errMsg>([^<]+)</.exec(body) ??
    /<resultMsg>([^<]+)</.exec(body) ??
    /<returnReasonCode>([^<]+)</.exec(body);
  return m ? m[1] : null;
}

console.log(`후보 ${targets.length}개를 확인합니다.\n`);

let found = false;

for (const base of targets) {
  for (const extra of paramSets()) {
    const qs = new URLSearchParams({
      serviceKey: key,
      numOfRows: "5",
      pageNo: "1",
      type: "json",
      ...extra,
    });
    const url = `${base}?${qs}`;

    let res;
    let body = "";
    try {
      res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      body = await res.text();
    } catch (err) {
      continue; // 주소 자체가 없는 경우 — 조용히 다음으로
    }

    const err = readError(body);
    const paramDesc = Object.keys(extra).length ? JSON.stringify(extra) : "(파라미터 없음)";

    // 인증 오류는 주소가 맞다는 뜻이므로 크게 알린다
    if (err && /SERVICE.?KEY|인증/i.test(err)) {
      console.log(`🔑 주소는 맞는 것 같습니다: ${base}`);
      console.log(`   그런데 키 오류: ${err}`);
      console.log(`   → Decoding 키인지, 해당 API 활용신청이 승인됐는지 확인하세요.\n`);
      found = true;
      break;
    }

    if (res.ok && !err && body.length > 120) {
      const fields = extractFields(body);
      // 껍데기만 오는 경우와 실제 데이터가 있는 경우를 구분
      const hasData = fields.length > 6;
      console.log(`${hasData ? "✅" : "△"} ${base}`);
      console.log(`   파라미터: ${paramDesc}`);
      console.log(`   응답 필드(${fields.length}): ${fields.slice(0, 30).join(", ")}`);
      console.log(`   원본 앞부분:\n   ${body.slice(0, 400).replace(/\n/g, "\n   ")}\n`);
      if (hasData) {
        found = true;
        break;
      }
    } else if (err) {
      console.log(`✕ ${base} ${paramDesc} → ${err}`);
    }
  }
  if (found) break;
}

if (!found) {
  console.log("\n어느 후보도 데이터를 주지 않았습니다.");
  console.log("공공데이터포털 → 마이페이지 → 활용신청 상세 → 참고문서(.docx) 또는 Swagger 에서");
  console.log("정확한 엔드포인트를 확인한 뒤 인자로 넘겨주세요:");
  console.log('  node scripts/trade-probe.mjs "https://apis.data.go.kr/1220000/..."');
} else {
  console.log("이 출력을 그대로 알려주시면 수집 모듈을 붙이겠습니다.");
}
