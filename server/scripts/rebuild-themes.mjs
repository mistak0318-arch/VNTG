/**
 * 키움 관심그룹을 내 테마로 옮긴다.
 *
 * 사용자가 키움 HTS 에서 관리 중인 관심그룹 화면을 그대로 옮겨 담는다.
 * 키움 테마 분류와 달리 **이건 사용자가 직접 편성한 판**이라, MAP·리포트·텔레그램 태그가
 * 전부 이 이름으로 돈다.
 *
 * 종목코드는 **절대 손으로 적지 않는다.** 이름을 /api/market/search 로 해석한다 —
 * 코드를 외워 적으면 한 글자 틀려도 조용히 다른 종목이 들어가고, 그걸 몇 달 뒤에 발견한다.
 * 못 찾은 이름은 지우지 않고 **끝에 모아 보고**한다. 사람이 보고 고쳐야 하는 것들이다.
 *
 *   node scripts/rebuild-themes.mjs          — 미리보기만 (파일 안 건드림)
 *   node scripts/rebuild-themes.mjs --write  — 실제로 덮어쓴다
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, "..", "data", "customThemes.json");
const API = process.env.VNTG_API ?? "http://localhost:4000";

/** 화면에 보이던 그룹 이름과 구성종목. 순서도 화면 그대로 둔다 */
const GROUPS = [
  ["반도체", "TIGER 반도체TOP10", ["삼성전자","SK하이닉스","원익IPS","주성엔지니어링","피에스케이","한미반도체","이수페타시스","대덕전자","한화비전"]],
  ["반도체 소부장 (전공정)", "", ["주성엔지니어링","원익IPS","피에스케이","HPSP","한솔케미칼","유진테크","브이엠","테스","솔브레인","티씨케이"]],
  ["반도체 소부장 (후공정)", "", ["한미반도체","이수페타시스","대덕전자","리노공업","이오테크닉스","하나마이크론","테크윙","티에스이","피에스케이홀딩스","해성디에스"]],
  ["MLCC·기판", "", ["삼성전기","이수페타시스","심텍","삼화콘덴서","LG이노텍","대덕전자","코리아써키트","해성디에스","대주전자재료","아모텍","코스모신소재"]],
  ["전력기기", "KODEX AI전력핵심설비", ["LS ELECTRIC","효성중공업","HD현대일렉트릭","가온전선","삼일전기","대한전선","LS","일진전기","제룡전기"]],
  ["로봇", "KODEX 로봇액티브 · 테마 수급 집중", ["현대차","현대모비스","로보티즈","현대오토에버","LG전자","LG씨엔에스","레인보우로보틱스","현대무벡스","두산로보틱스","HL만도","에스피지","에스엘","포스코DX","LG"]],
  ["2차전지", "KODEX 2차전지산업", ["삼성SDI","LG에너지솔루션","POSCO홀딩스","엘앤에프","에코프로","에코프로비엠","LG화학","포스코퓨처엠","SK이노베이션","에코프로머티","SKC"]],
  ["전고체·실리콘음극재", "SOL 전고체배터리,실리콘음극재", ["삼성SDI","이수스페셜티케미컬","대주전자재료","롯데에너지머티리얼즈","포스코퓨처엠"]],
  ["리튬·ESS", "LIT, 알버말, 리오틴토, 에너지스, 테슬라, 플루언스", ["POSCO홀딩스","삼성SDI","LG에너지솔루션","엘앤에프"]],
  ["신재생에너지", "KODEX 신재생에너지액티브", ["OCI홀딩스","한화솔루션","씨에스윈드","두산퓨얼셀","SK이터닉스","비나텍","HD현대에너지솔루션","SK오션플랜트","서진시스템"]],
  ["SOFC 연료전지", "블룸에너지 관련", ["두산퓨얼셀","비나텍","삼일전기","SK이터닉스","한선엔지니어링","아모센스"]],
  ["원자력", "TIGER 코리아원자력 · 뉴스케일, 오클로", ["두산에너빌리티","한국전력","비에이치아이","한전기술","대우건설","우진","현대건설","DL이앤씨","우리기술","SNT에너지","한전KPS","한전산업","오르비텍","우진엔텍","삼성물산"]],
  ["조선", "TIGER 조선TOP10", ["삼성중공업","한화오션","HD현대중공업","HD한국조선해양","한화엔진","대한조선","HD현대마린엔진"]],
  ["방산", "TIGER 방산TOP10", ["한화에어로스페이스","LIG넥스원","현대로템","한화시스템","한국항공우주","풍산","STX엔진","아이쓰리시스템"]],
  ["우주항공", "PLUS 우주항공&UAM · SPACE X", ["에이치브이엠","스피어","켄코아에어로스페이스","미래에셋벤처투자","쎄트렉아이","인텔리안테크","미래에셋증권","아주IB투자","센서뷰"]],
  ["바이오", "KoAct 바이오헬스케어액티브", ["알테오젠","셀트리온","리가켐바이오","삼성에피스홀딩스","삼성바이오로직스","디앤디파마텍","올릭스","에이비엘바이오","유한양행","삼천당제약","코오롱티슈진","펩트론","에스티팜","한미약품","보로노이"]],
  ["지주사", "TIGER 지주회사", ["SK","두산","한진칼","HD현대","LG","POSCO홀딩스","삼성물산","한화","GS","한화비전"]],
  ["금융", "KODEX 금융고배당TOP10", ["KB금융","하나금융지주","신한지주","우리금융지주","기업은행","DB손해보험","삼성화재","NH투자증권","삼성증권","키움증권"]],
  ["증권", "TIGER 증권", ["한국금융지주","미래에셋증권","삼성증권","키움증권","NH투자증권","대신증권","신영증권","한화투자증권","SK증권","유안타증권"]],
  ["자동차", "SOL 자동차TOP3플러스", ["현대차","현대모비스","기아","삼성전기","현대오토에버","한온시스템","HL만도","고영","현대위아","에스엘"]],
  ["철강 (종합)", "업종 주도주", ["POSCO홀딩스","현대제철"]],
  ["철강 (강관·파이프)", "", ["넥스틸","세아제강","휴스틸"]],
  ["건설 (재건)", "", ["DL이앤씨","현대건설","GS건설","삼성E&A"]],
  ["통신·광통신", "루멘텀 홀딩스, 어플라이드 옵토일렉", ["대한광통신","오이솔루션","옵티코어","RF머트리얼즈","RFHIC","SK텔레콤","KT","LG유플러스"]],
  ["SI·SW", "", ["삼성에스디에스","현대오토에버","LG씨엔에스","SK네트웍스","NAVER","카카오"]],
  ["게임", "", ["웹젠","NC","넷마블","크래프톤"]],
  ["화장품", "", ["에이피알","달바글로벌","한국콜마","LG생활건강","실리콘투","아모레퍼시픽"]],
  ["양자", "", ["아이씨티케이"]],
];

/**
 * 화면에서 읽은 이름 → 실제 상장명.
 *
 * 종목코드를 직접 적지 않는 원칙은 그대로 두되, **이름이 다른 것만** 여기서 바로잡는다.
 * 전부 검색으로 확인한 것들이다 (추측이 아니다):
 *   - "SK" 는 검색 결과에 SK하이닉스·SK증권이 먼저 나와 지주사 SK 를 못 잡는다 → 코드로
 *   - "삼일전기" 는 스크린샷 오독이었다. 실제로는 산일전기(변압기)
 *   - LIG넥스원은 사명이 바뀌었다
 */
const ALIAS = {
  "삼일전기": "산일전기",
  "LIG넥스원": "LIG디펜스앤에어로스페이스",
  "엔씨소프트": "NC",
};

/** 이름으로는 도저히 안 잡히는 것만 코드로 못박는다 (검색으로 확인함) */
const BY_CODE = {
  "SK": "034730",
};

const PALETTE = ["#4c8dff","#35c46a","#f5c542","#a97bd6","#f0555f","#4ab5c4","#e08a3c","#7b8ff5"];

async function resolve(name) {
  if (BY_CODE[name]) {
    const r = await fetch(`${API}/api/market/search?q=${BY_CODE[name]}`);
    const { results = [] } = await r.json();
    const hit = results.find((x) => String(x.code).replace(/_(AL|NX)$/, "") === BY_CODE[name]);
    if (hit) return { code: BY_CODE[name], name: hit.name, asked: name };
  }
  const q = ALIAS[name] ?? name;
  const res = await fetch(`${API}/api/market/search?q=${encodeURIComponent(q)}`);
  const { results = [] } = await res.json();
  // 정확히 같은 이름이 있으면 그것. 없으면 가장 짧은 이름(우선주·스팩이 뒤로 밀린다)
  const exact = results.find((r) => r.name === q);
  const pick = exact ?? results.slice().sort((a, b) => a.name.length - b.name.length)[0];
  if (!pick) return null;
  return { code: String(pick.code).replace(/_(AL|NX)$/, ""), name: pick.name, asked: name };
}

const now = new Date().toISOString();
const themes = [];
const missing = [];
const renamed = [];

for (let i = 0; i < GROUPS.length; i += 1) {
  const [name, memo, stocks] = GROUPS[i];
  const codes = [];
  for (const s of stocks) {
    const hit = await resolve(s);
    if (!hit) {
      missing.push(`${name} / ${s}`);
      continue;
    }
    if (hit.name !== s && (ALIAS[s] ?? s) !== hit.name) renamed.push(`${s} → ${hit.name}`);
    if (!codes.includes(hit.code)) codes.push(hit.code);
    await new Promise((r) => setTimeout(r, 40));
  }
  themes.push({
    id: `t_${Date.now().toString(36)}${i.toString(36).padStart(2, "0")}`,
    name,
    memo,
    codes,
    color: PALETTE[i % PALETTE.length],
    createdAt: now,
    source: "manual",
  });
  console.log(`${String(i + 1).padStart(2)}. ${name.padEnd(22)} ${codes.length}/${stocks.length}종목`);
}

console.log(`\n총 ${themes.length}개 테마 · ${themes.reduce((s, t) => s + t.codes.length, 0)}종목(중복 포함)`);
if (renamed.length) console.log(`\n[이름이 정식명으로 바뀐 것]\n  ${[...new Set(renamed)].join("\n  ")}`);
if (missing.length) console.log(`\n[못 찾음 — 손으로 확인 필요]\n  ${missing.join("\n  ")}`);

if (process.argv.includes("--write")) {
  writeFileSync(FILE, JSON.stringify(themes, null, 2), "utf-8");
  console.log(`\n저장했습니다 → ${FILE}`);
} else {
  console.log("\n(미리보기만 했습니다. 실제로 바꾸려면 --write)");
}
