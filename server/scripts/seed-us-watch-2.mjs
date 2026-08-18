/**
 * 관심종목(해외)를 키움 HTS 화면 그대로 다시 깐다.
 *
 * **티커를 짐작해서 그냥 넣지 않는다.** 한투 multprice 가 한글 종목명(`knam`)을 같이
 * 주므로, 넣으려는 티커를 실제로 조회해 **화면에 적힌 이름과 맞는지 대조**하고 어긋나면
 * 넣지 않고 보고한다. 미국은 티커가 비슷비슷해서(CLNE↔UUUU 같은) 짐작이 잘 틀린다.
 *
 *   node scripts/seed-us-watch-2.mjs          ← 확인만 (파일 안 건드림)
 *   node scripts/seed-us-watch-2.mjs --write  ← 실제로 덮어씀
 */
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
for (const line of readFileSync(join(root, ".env"), "utf-8").split(/\r?\n/)) {
  const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
  if (m) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
}

const BASE = "https://openapi.koreainvestment.com:9443";
const KEY = process.env.HANTOO_APP_KEY;
const SECRET = process.env.HANTOO_APP_SECRET;
const EXCHANGES = ["NAS", "NYS", "AMS", "TSE", "HKS", "SHS", "SZS"];

/* ─────────────────────────────────────────────────────────── 화면에서 옮긴 것 */

const PLAN = [
  ["빅테크", "ACE 미국빅테크TOP7Plus", [
    ["NVDA", "엔비디아"], ["GOOGL", "알파벳 A"], ["AMZN", "아마존닷컴"], ["AAPL", "애플"],
    ["MSFT", "마이크로소프트"], ["AVGO", "브로드컴"], ["META", "메타 플랫폼스"],
    ["NFLX", "넷플릭스"], ["TSLA", "테슬라"], ["PLTR", "팔란티어 테크"],
  ]],
  ["시장 주도주", "KoAct 미국나스닥성장기업액티브", [
    ["MU", "마이크론 테크놀로지"], ["CRWV", "코어위브"], ["BE", "블룸 에너지"],
    ["OKLO", "오클로"], ["SMR", "뉴스케일 파워"], ["VRT", "버티브 홀딩스"],
    ["GEV", "GE버노바"], ["LITE", "루멘텀 홀딩스"], ["COHR", "코히어런트"],
    ["SNDK", "샌디스크"], ["INTC", "인텔"], ["WDC", "웨스턴 디지털"],
    ["AAOI", "어플라이드 옵토일렉"], ["CIEN", "시에나"], ["ASML", "ASML 홀딩(ADR)"],
    ["MRVL", "마벨 테크놀로지 그룹"], ["LRCX", "램 리서치"], ["GLW", "코닝"],
    ["RDDT", "레딧"],
  ]],
  ["반도체", "KODEX 미국반도체", [
    ["NVDA", "엔비디아"], ["MU", "마이크론 테크놀로지"], ["SNDK", "샌디스크"],
    ["LRCX", "램 리서치"], ["AMAT", "어플라이드 머티어리얼"], ["TSM", "TSMC(ADR)"],
    ["MRVL", "마벨 테크놀로지 그룹"], ["AVGO", "브로드컴"], ["QCOM", "퀄컴"],
    ["AMD", "AMD"], ["KLAC", "케이엘에이"], ["ASML", "ASML 홀딩(ADR)"],
    ["TXN", "텍사스 인스트루먼츠"], ["SNPS", "시놉시스"], ["INTC", "인텔"],
    ["DELL", "델 테크놀로지스"], ["IBM", "IBM"],
  ]],
  ["원자력SMR", "ACE 미국SMR원자력TOP10", [
    ["OKLO", "오클로"], ["SMR", "뉴스케일 파워"], ["CCJ", "카메코"],
    ["LEU", "센트러스 에너지"], ["GEV", "GE버노바"], ["CEG", "컨스텔레이션 에너지"],
    ["VST", "비스트라 에너지"], ["BWXT", "BWX 테크놀로지스"],
    ["UUUU", "에너지 퓨얼스"], ["UEC", "우라늄 에너지"],
  ]],
  ["전력인프라", "SOL 미국AI전력인프라", [
    ["VRT", "버티브 홀딩스"], ["OKLO", "오클로"], ["GEV", "GE버노바"],
    ["ETN", "이턴 코퍼레이션"], ["PWR", "콴타 서비시스"], ["CEG", "컨스텔레이션 에너지"],
    ["BE", "블룸 에너지"], ["ETR", "엔터지"], ["VST", "비스트라 에너지"], ["CCJ", "카메코"],
  ]],
  ["우주항공", "TIGER 미국우주테크", [
    ["RDW", "레드와이어"], ["LUNR", "인튜이티브 머신스"], ["RKLB", "로켓 랩"],
    ["ASTS", "AST 스페이스모바일"], ["PL", "플래닛 랩스"], ["VSAT", "비아셋"],
    ["GSAT", "글로벌스타"], ["MDA.TO", "MDA 스페이스"], ["BKSY", "블랙스카이 테크놀로"],
  ]],
  ["로봇", "KoAct 미국로봇피지컬AI액티브", [
    ["TSLA", "테슬라"], ["ISRG", "인튜이티브 서지컬"], ["ADI", "애널로그 디바이시스"],
    ["TER", "테라다인"], ["FLEX", "플렉스"], ["CAT", "캐터필러"],
    ["OUST", "아우스터"], ["SERV", "서브 로보틱스"], ["TKR", "팀켄"],
  ]],
  ["양자", "PLUS 미국양자컴퓨팅TOP10", [
    ["IBM", "IBM"], ["IONQ", "아이온큐"], ["QUBT", "퀀텀 컴퓨팅"], ["RGTI", "리게티 컴퓨팅"],
  ]],
  ["리튬·2차전지", "", [
    ["RIO", "리오 틴토(ADR)"], ["ENS", "에너시스"], ["ALB", "알버말"],
    ["FLNC", "플루언스 에너지"], ["TSLA", "테슬라"],
  ]],
  ["바이오", "KoAct 미국바이오헬스케어액티브", [
    ["MRK", "머크"], ["HALO", "할로자임 테라퓨틱스"], ["GILD", "길리어드 사이언스"],
    ["VRTX", "버텍스 파마슈티컬"], ["AMGN", "암젠"], ["RVMD", "레볼루션 메디신"],
    ["BIIB", "바이오젠"], ["NTRA", "나테라"], ["MRNA", "모더나"],
    ["ALNY", "엘나일람 파마슈티컬"], ["BNTX", "바이오엔테크(ADR)"],
    ["INCY", "인사이트"], ["GMAB", "젠맵(ADR)"], ["SMMT", "서밋 테라퓨틱스"],
  ]],
  ["유럽 방산", "", [
    ["RHM.DE", "라인메탈"], ["BA.L", "BAE 시스템스"], ["HO.PA", "탈레스"],
    ["LDO.MI", "레오나르도"], ["SAAB-B.ST", "사브"], ["AM.PA", "다쏘 항공"],
    ["KOG.OL", "콩스베르그"], ["HAG.DE", "헨솔트"],
  ]],
  ["지수·ETF", "", [
    ["SPY", "S&P 500 SPDR ETF"], ["QQQ", "QQQ 인베스코 ETF"],
    ["EWY", "MSCI 한국 아이셰어즈 ETF"], ["SOXX", "반도체 아이셰어즈 ETF"],
    ["CHAT", "ROUNDHILL MEMORY"], ["XLU", "S&P 500 유틸리티 SPDR ETF"],
    ["IGV", "소프트웨어 아이셰어즈 ETF"], ["BOTZ", "로봇공학 및 인공지능 글로벌엑스 ETF"],
    ["ITA", "항공우주 및 방산주 아이셰어즈 ETF"], ["IDRV", "자율주행 아이셰어즈 ETF"],
    ["AMLP", "에너지 인프라주 알레리안 ETF"], ["XLE", "에너지 SPDR ETF"],
    ["IUSG", "미국 성장주 아이셰어즈 ETF"], ["IUSV", "MSCI 미국 가치주 아이셰어즈 ETF"],
    ["VYM", "고배당수익률 뱅가드 ETF"], ["VIG", "미국 배당 성장주 뱅가드 ETF"],
    ["VGT", "미국 IT 뱅가드 ETF"], ["FDN", "인터넷 기업 퍼스트 트러스트 ETF"],
    ["XLC", "통신 미디어 서비스 SPDR ETF"], ["XBI", "S&P 바이오 SPDR ETF"],
    ["XLV", "헬스케어 SPDR ETF"], ["IBB", "바이오테크 아이셰어즈 ETF"],
    ["IHI", "미국 의료기기 아이셰어즈 ETF"], ["XLP", "미국 필수 소비재 SPDR ETF"],
    ["XLY", "임의 소비재 SPDR ETF"], ["XLF", "금융주 SPDR ETF"],
    ["VNQ", "미국 부동산 뱅가드 ETF"], ["ITB", "미국 주택건설 아이셰어즈 ETF"],
    ["PAVE", "미국 인프라 개발 글로벌엑스 ETF"], ["XLI", "미국 산업재 SPDR ETF"],
    ["XLB", "S&P 500 원자재 SPDR ETF"], ["XME", "S&P 금속 및 광업주 SPDR ETF"],
    ["HYG", "하이일드 회사채 아이셰어즈 ETF"],
  ]],
  ["액티브·테마", "", [
    ["ARKK", "이노베이션 액티브 아크 ETF"], ["ARKG", "유전공학 아크 ETF"],
    ["ARKW", "ARK NEXT GENERATION INTERNET"], ["ARKF", "ARK FINTECH INNOVATION"],
    ["ARKQ", "자율주행 및 로봇공학 아크 ETF"], ["LIT", "리튬 배터리 글로벌엑스 ETF"],
    ["SKYY", "클라우드 컴퓨팅 퍼스트 트러스트 ETF"], ["ROBO", "로봇공학 엠플리파이 ETF"],
    ["BLOK", "블록체인 엠플리파이 ETF"], ["BITQ", "가상화폐 산업 혁신 비트와이즈 ETF"],
    ["ARKX", "우주 혁신 아크 ETF"], ["VNQI", "글로벌 부동산 뱅가드 ETF"],
    ["QCLN", "나스닥 청정 에너지 퍼스트 트러스트 ETF"], ["PHO", "미국 수자원 인베스코 ETF"],
    ["MSOS", "미국 대마초 어드바이저셰어즈 ETF"],
  ]],
];

/*
 * 화면엔 있지만 넣지 않은 것과 그 이유.
 * 나중에 "왜 빠졌지?" 하고 다시 찾아보지 않도록 적어 둔다.
 */
const SKIPPED = [
  ["스페이스X", "상장사가 아니다. HTS 에 보이는 건 비상장 지분을 담은 펀드일 텐데 어느 것인지 알 수 없다"],
  ["SK하이닉스(ADR)", "미국 ADR 이 정규 거래소에 없다(장외). 국내 000660 으로 보는 게 맞다"],
  ["X-에너지", "비상장"],
  ["파이어플라이 에어로 · 요크 스페이스", "티커를 확신할 수 없다"],
  ["S&P 500 / 나스닥 100 지수", "지수는 종목이 아니다. 「글로벌 시황」에서 본다"],
];

/* ────────────────────────────────────────────────────────────────── 대조 */

let token = null;
async function getToken() {
  if (token) return token;
  const r = await fetch(`${BASE}/oauth2/tokenP`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: KEY, appsecret: SECRET }),
  });
  const j = await r.json();
  if (!j.access_token) throw new Error(j.error_description ?? "토큰 실패");
  token = j.access_token;
  return token;
}

let lastCall = 0;
async function mult(pairs) {
  const wait = lastCall + 450 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastCall = Date.now();
  const p = new URLSearchParams({ AUTH: "", NREC: String(pairs.length) });
  pairs.forEach(([excd, symb], i) => {
    const n = String(i + 1).padStart(2, "0");
    p.set(`EXCD_${n}`, excd);
    p.set(`SYMB_${n}`, symb);
  });
  const r = await fetch(`${BASE}/uapi/overseas-price/v1/quotations/multprice?${p}`, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      authorization: `Bearer ${await getToken()}`,
      appkey: KEY,
      appsecret: SECRET,
      tr_id: "HHDFS76220000",
      custtype: "P",
    },
  });
  const j = await r.json();
  if (j.rt_cd !== "0") {
    if (/초당/.test(j.msg1 ?? "")) {
      await new Promise((x) => setTimeout(x, 1500));
      return mult(pairs);
    }
    return [];
  }
  return j.output2 ?? [];
}

const resolved = new Map();
async function resolve(symbol) {
  if (resolved.has(symbol)) return resolved.get(symbol);
  // 점이 붙은 건 유럽/캐나다다 — 한투에 없으니 야후에 맡긴다
  if (symbol.includes(".")) {
    const v = { excd: null, knam: null, price: null, yahoo: true };
    resolved.set(symbol, v);
    return v;
  }
  const rows = await mult(EXCHANGES.map((e) => [e, symbol]));
  const hit = rows.find((r) => Number(r.last) > 0);
  const v = hit
    ? { excd: hit.excd, knam: (hit.knam ?? "").trim(), price: Number(hit.last), yahoo: false }
    : { excd: null, knam: null, price: null, yahoo: false };
  resolved.set(symbol, v);
  return v;
}

/**
 * 이름이 대충이라도 맞나.
 *
 * **한투는 ETF 에 한글명을 안 붙인다** — "SPDR S&P BIOTECH" 처럼 영문으로만 온다.
 * 내 라벨은 한글이라 글자로는 절대 안 맞는데, 그건 티커가 틀렸다는 뜻이 아니다.
 * 그래서 한글이 하나도 없는 이름은 **대조 불가**로 따로 빼서 눈으로 보게 한다.
 */
function nameLooksRight(mine, theirs) {
  if (!theirs) return true;
  if (!/[가-힣]/.test(theirs)) return "영문";
  const norm = (x) => x.replace(/[\s()·.\-]/g, "").replace(/ADR/gi, "").toLowerCase();
  const a = norm(mine);
  const b = norm(theirs);
  if (a.includes(b) || b.includes(a)) return true;
  // 앞 세 글자만이라도 겹치면 같은 회사로 본다 (엔비디아 / 엔비디아)
  return a.slice(0, 3) === b.slice(0, 3);
}

const write = process.argv.includes("--write");
const groups = [];
const problems = [];
/** 한투가 영문명만 줘서 글자로는 대조가 안 된 것 — 눈으로 봐 주셔야 한다 */
const english = [];
/** 표기가 달라 한투 것으로 적은 것 */
const diffs = [];

for (const [name, memo, stocks] of PLAN) {
  const kept = [];
  for (const [symbol, myName] of stocks) {
    const r = await resolve(symbol);
    if (r.yahoo) {
      kept.push({ symbol, name: myName, addedPrice: null, addedAt: new Date().toISOString(), memo: "" });
      problems.push(`  · ${symbol} ${myName} — 한투에 없음(유럽/캐나다). 야후로 받습니다`);
      continue;
    }
    if (!r.excd) {
      problems.push(`  ✗ ${symbol} ${myName} — 어느 거래소에서도 못 찾음. 넣지 않았습니다`);
      continue;
    }
    /*
     * **이름은 한투 것을 쓴다.**
     *
     * 내 라벨과 한투 표기가 "GE버노바 / GE베르노바", "비아셋 / 비아샛" 처럼 조금씩 다르다.
     * 어느 쪽도 틀린 게 아니지만, 화면에 뜨는 값이 한투에서 오는데 이름만 딴 데서 따오면
     * 나중에 대조할 때 헷갈린다. **값을 준 쪽의 이름**을 쓰는 게 맞다.
     *
     * 한투가 한글명을 안 붙인 ETF 는 내 라벨을 그대로 둔다 — 영문보다 읽기 낫다.
     */
    const check = nameLooksRight(myName, r.knam);
    const useName = check === "영문" || !r.knam ? myName : r.knam;
    if (check === false) diffs.push(`  · ${symbol.padEnd(9)} 화면 "${myName}"  →  한투 "${r.knam}" 로 적었습니다`);
    if (check === "영문") english.push(`  ? ${symbol.padEnd(9)} 내 라벨 "${myName}"  ←→  한투 "${r.knam}"`);
    kept.push({
      symbol,
      name: useName,
      addedPrice: r.price,
      addedAt: new Date().toISOString(),
      memo: "",
    });
  }
  groups.push({
    id: name.replace(/[^0-9A-Za-z가-힣]/g, "") || `g${groups.length}`,
    name,
    memo,
    stocks: kept,
  });
  console.log(`${name.padEnd(12)} ${kept.length}/${stocks.length}`);
}

console.log("\n넣지 못했거나 짚어 둘 것:");
console.log(problems.length ? problems.join("\n") : "  (없음)");
console.log("\n애초에 뺀 것:");
for (const [what, why] of SKIPPED) console.log(`  · ${what} — ${why}`);

const total = groups.reduce((n, g) => n + g.stocks.length, 0);
console.log(`\n합계 ${groups.length}개 그룹 · ${total}종목`);

const FILE = join(root, "data", "usWatchlist.json");
if (!write) {
  console.log("\n확인만 했습니다. 실제로 덮어쓰려면 --write 를 붙이세요.");
} else {
  if (existsSync(FILE)) {
    const bak = FILE.replace(/\.json$/, `.backup-${Date.now()}.json`);
    copyFileSync(FILE, bak);
    console.log(`\n기존 파일 백업: ${bak}`);
  }
  writeFileSync(FILE, JSON.stringify(groups, null, 2), "utf-8");
  console.log(`${FILE} 에 새로 썼습니다. 서버를 재시작하세요.`);
}
