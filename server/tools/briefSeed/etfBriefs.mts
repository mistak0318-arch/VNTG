/**
 * ETF 설명을 **규칙으로** 만든다 (2026-09-08).
 *
 * 실행: server/ 에서 `npx tsx tools/briefSeed/etfBriefs.mts`  — 조회 0회, AI 0회.
 *
 * ## 왜 AI 를 안 쓰나
 *
 * ETF 는 DART 공시도 분기 재무도 네이버 테마도 없다. `companyBrief` 에 넣으면
 * 「엮을 재료를 하나도 못 모았습니다」로 끝난다.
 *
 * 그렇다고 모델의 학습 지식에 맡기면 안 된다. GPT 에게 시켰더니 1,167개 전부
 * **「ETF 상품으로 지수·자산·전략을 추종한다. 정확한 추종대상은 운용설명서를
 * 확인해야 한다」** 였다(2026-09-07). KODEX 200 한테도 그렇게 썼다.
 *
 * 그런데 **답은 이름에 다 있다.** 「TIGER 미국나스닥100레버리지(합성 H)」는
 * 나스닥100을 2배로, 스왑으로, 환헤지해서 좇는다는 뜻이고 그건 해석이 아니라 규약이다.
 * 키움 ka40004 가 준 추적지수(318종목분)까지 있으면 더 확실하다.
 *
 * ## 안 쓰는 것
 *
 * **운용보수·분배금·순자산은 이름에 없다.** 그래서 안 쓴다. 「보수 0.05%」 같은
 * 그럴듯한 숫자를 지어내면 그게 제일 나쁘다. 추적지수가 없는 849개는 이름에서
 * 읽히는 데까지만 쓰고 「비교지수는 확인이 필요하다」로 끝낸다.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promises as fs } from "node:fs";

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

interface EtfSeed {
  etfs: Record<string, { name: string; index: string | null }>;
}
interface Brief {
  code: string;
  name: string;
  day: string;
  at: string;
  text: string;
  model: string | null;
  sources: string[];
  inputTokens: number;
  outputTokens: number;
}

/* ------------------------------------------------------------------ */
/* 이름 뜯어보기                                                        */
/* ------------------------------------------------------------------ */

interface Parsed {
  /** 2 = 레버리지 · -1 = 인버스 · -2 = 인버스2X. 없으면 null */
  mult: number | null;
  hedged: boolean;
  synthetic: boolean;
  /** TR — 분배금을 안 주고 재투자한다 */
  totalReturn: boolean;
  coveredCall: boolean;
  /** 커버드콜 옵션 주기 — "데일리" | "위클리" | null */
  callCycle: string | null;
  active: boolean;
  /** 채권혼합 비율(주식 %) — "채권혼합50" 이면 50 */
  bondMix: number | null;
  /** 만기까지 들고 가는 채권형 */
  maturity: boolean;
  asset: "국내주식" | "해외주식" | "채권" | "금리" | "원자재" | "부동산";
}

function parse(name: string): Parsed {
  const n = name.replace(/\s+/g, "");

  /* 인버스가 레버리지보다 먼저다 — 「인버스2X」에 2X 가 들어 있어서 순서를 바꾸면 +2 로 읽힌다 */
  let mult: number | null = null;
  if (/인버스\s*2X|곱버스/i.test(n)) mult = -2;
  else if (/인버스/.test(n)) mult = -1;
  else if (/레버리지|2X/i.test(n)) mult = 2;

  /* 「(합성 H)」는 합성이면서 환헤지다. 둘을 따로 본다 */
  const hedged = /\(H\)|\(합성\s*H\)|\(H\s*합성\)|환헤지/i.test(name);
  const synthetic = /합성/.test(n);

  const bondMixM = n.match(/채권혼합(\d{2})?/);
  const bondMix = bondMixM ? (bondMixM[1] ? Number(bondMixM[1]) : null) : null;

  let asset: Parsed["asset"] = "국내주식";
  if (/리츠|부동산|REIT/i.test(n)) asset = "부동산";
  else if (/금현물|금선물|^.*금\(|은액티브|은현물|원유|천연가스|구리|농산물|팔라듐|백금|WTI/.test(n)) asset = "원자재";
  else if (/CD금리|KOFR|머니마켓|단기자금|MMF/i.test(n)) asset = "금리";
  else if (/채권|국고채|통안채|회사채|금융채|크레딧|국채|물가채/.test(n) && bondMix === null) asset = "채권";
  else if (/미국|나스닥|S&P|SP500|일본|TOPIX|중국|본토|CSI|항셍|홍콩|인도|NIFTY|베트남|유럽|STOXX|글로벌|선진국|신흥국|아시아|대만|멕시코|인도네시아|필리핀|브라질|독일|영국/i.test(n))
    asset = "해외주식";

  return {
    mult,
    hedged,
    synthetic,
    totalReturn: /TR(?![A-Za-z])/.test(name) || /토탈리턴/.test(n),
    coveredCall: /커버드콜/.test(n),
    callCycle: /데일리/.test(n) ? "데일리" : /위클리/.test(n) ? "위클리" : null,
    active: /액티브/.test(n),
    bondMix,
    maturity: /만기자동연장|만기매칭|\d{1,2}월만기/.test(n),
    asset,
  };
}

/**
 * 추적지수 코드명에 **한 줄 풀이**를 붙인다. 이름은 그대로 쓰고 설명만 덧댄다 —
 * 「KIS 국고채 10년(총수익)」처럼 그대로 써도 읽히는 것은 굳이 풀지 않는다.
 */
const INDEX_NOTE: Record<string, string> = {
  KOSPI200: "국내 대형주 200종목을 담은 대표 지수다.",
  "F-KOSPI200": "코스피200 선물 지수다.",
  KOSPI100: "코스피 대형주 100종목이다.",
  "종합(KOSPI)": "코스피 전체다.",
  "종합(KOSDAQ)": "코스닥 전체다.",
  "KOSDAQ 150": "코스닥 대표 150종목이다.",
  "F-KOSDAQ150": "코스닥150 선물 지수다.",
  KRX300: "코스피·코스닥을 합쳐 뽑은 300종목이다.",
  코리아밸류업지수: "주주환원·수익성 기준으로 뽑은 국내 기업들이다.",
  "S&P 500": "미국 대형주 500종목이다.",
  "NASDAQ 100": "미국 나스닥 상위 100종목으로 기술주 비중이 크다.",
  "CSI 300": "중국 본토 대형주 300종목이다.",
  TOPIX: "일본 도쿄증권거래소 전체다.",
  "HSCEI (Hang Seng China Enterprise Index)": "홍콩에 상장된 중국 본토 기업(H주)이다.",
  "EURO STOXX50": "유로존 대형주 50종목이다.",
  "CNX NIFTY INDEX(PR)": "인도 대표 50종목이다.",
};

/**
 * **이름에서 기초자산을 읽는다.** 이게 이 도구의 값어치다.
 *
 * 키움이 비교지수를 안 준 849개도 「TIGER 미국필라델피아반도체나스닥」처럼
 * 이름에 답이 적혀 있다. 여기서 못 읽으면 GPT 가 쓴 「운용설명서를 확인하라」와
 * 다를 게 없어진다.
 *
 * 순서가 중요하다 — 먼저 걸리는 것이 이긴다. 「미국나스닥100」이 「나스닥」보다 앞에 와야
 * 100 을 안 놓친다.
 */
const NAME_ASSET: [RegExp, string][] = [
  [/필라델피아반도체|SOX(?![A-Za-z])/i, "미국 필라델피아 반도체 지수"],
  [/나스닥100/i, "미국 나스닥100"],
  [/나스닥/i, "미국 나스닥"],
  [/S&P\s*500|SP500|에스앤피500/i, "미국 S&P500"],
  [/다우존스|다우30/i, "미국 다우존스"],
  [/러셀2000/i, "미국 러셀2000"],
  [/미국배당다우존스|SCHD/i, "미국 배당성장주(다우존스 배당 계열)"],
  [/코스닥150/i, "코스닥150"],
  [/코스피200|(?<![0-9])200(?![0-9])/, "코스피200"],
  [/KRX금현물|금현물/, "KRX 금현물"],
  [/금선물/, "금 선물"],
  [/은현물|은선물|은액티브/, "은"],
  [/WTI|원유/, "원유"],
  [/천연가스/, "천연가스"],
  [/구리/, "구리"],
  [/CD금리/, "CD 91일물 금리"],
  [/KOFR/, "KOFR(무위험지표금리)"],
  [/머니마켓|단기자금/, "초단기 자금시장 금리"],
  [/국고채/, "국고채"],
  [/국공채/, "국채·공채"],
  [/통안채/, "통화안정증권"],
  [/회사채|크레딧/, "회사채"],
  [/종합채권/, "국채·회사채를 아우르는 종합 채권"],
  [/변동금리부채권|FRN/i, "변동금리부 채권"],
  [/물가채|물가연동/, "물가연동국채"],
  [/단기채권|단기통안|단기금융채|단기특수은행채/, "단기 채권"],
  [/CSI\s*300|중국본토/i, "중국 본토 대형주(CSI300 계열)"],
  [/항셍|HSCEI/i, "홍콩 항셍 계열"],
  [/TOPIX|일본/i, "일본 증시"],
  [/NIFTY|인도/i, "인도 증시"],
  [/베트남/, "베트남 증시"],
  [/유로스탁스|유로스톡스|STOXX/i, "유로존 대형주(유로스톡스 계열)"],
  [/유럽/, "유럽 증시"],
  /* 통화·금리 선물 */
  [/미국달러선물|달러선물|달러인덱스/, "미국 달러"],
  [/엔선물|일본엔/, "일본 엔"],
  [/미국채|미국국채|미국\d+년국채/, "미국 국채"],
  [/국채선물|중장기국채/, "국채"],
  [/MSCI\s*Korea|코리아TOP|코리아\s*\d/i, "한국 증시"],
  [/빅테크|IT인터넷|WideMoat/i, "미국 대형 기술주"],
  [/지주회사|지주사/, "지주회사"],
  [/우량주/, "우량주로 분류되는 대형주"],
  [/최소변동성/, "가격이 덜 흔들리는 종목(저변동성)"],
  [/골드/, "금"],
  /* 스마트베타 팩터 — 이름이 곧 규칙이다 */
  [/배당성장/, "배당이 늘어 온 종목"],
  [/고배당|배당주|배당\d{2}/, "배당을 많이 주는 종목"],
  [/로우볼|저변동/, "가격이 덜 흔들리는 종목(저변동성)"],
  [/모멘텀/, "최근 많이 오른 종목(모멘텀)"],
  [/퀄리티|Quality/i, "재무가 튼튼한 종목(퀄리티)"],
  [/밸류|Value/i, "싸게 거래되는 종목(밸류)"],
  [/경기방어/, "경기를 덜 타는 업종"],
  [/가치주/, "싸게 거래되는 종목(밸류)"],
  [/성장주/, "이익이 빠르게 느는 종목(그로스)"],
  [/우선주/, "우선주"],
  [/주식혼합/, "주식과 채권을 섞은 자산"],
  [/인프라/, "전력·통신·교통 같은 인프라 기업"],
  [/농산물|옥수수|밀선물|대두/, "농산물"],
  [/심천|차이넥스트|ChiNext/i, "중국 선전(심천) 증시"],
  [/러시아/, "러시아 증시"],
  [/필리핀/, "필리핀 증시"],
  [/인도네시아/, "인도네시아 증시"],
  [/멕시코/, "멕시코 증시"],
  [/브라질/, "브라질 증시"],
  [/대만/, "대만 증시"],
  [/글로벌|선진국|신흥국/, "여러 나라에 나눠 담는 글로벌 자산"],
];

/** 이름에 박힌 테마 — 있으면 태그로 붙인다 */
const NAME_THEME: [RegExp, string][] = [
  [/반도체/, "반도체"],
  [/2차전지|이차전지|배터리/, "2차전지"],
  [/바이오|헬스케어|제약/, "바이오"],
  [/방산|K방산|우주항공/, "방산"],
  [/조선/, "조선"],
  [/원자력|원전|SMR/, "원자력"],
  [/AI|인공지능|휴머노이드|로봇/i, "AI·로봇"],
  [/자동차|모빌리티/, "자동차"],
  [/은행|금융지주/, "은행"],
  [/증권/, "증권"],
  [/보험/, "보험"],
  [/게임|엔터|미디어|KPOP/i, "엔터·게임"],
  [/화장품|뷰티/, "화장품"],
  [/리츠|부동산/, "리츠"],
  [/고배당|배당/, "배당"],
  [/그룹/, "그룹주"],
  [/밸류업/, "밸류업"],
  [/ESG/, "ESG"],
  [/전력|전선|그리드/, "전력"],
];

/**
 * 받침을 보고 조사를 고른다. 「코스피200을」 / 「나스닥100를」 이 섞이면 읽다가 걸린다.
 * 숫자는 읽는 소리의 받침으로 판단한다 — 0 영 · 1 일 · 3 삼 · 6 육 · 7 칠 · 8 팔.
 */
function josa(word: string, withBat: string, noBat: string): string {
  const last = word.trim().slice(-1);
  const c = last.charCodeAt(0);
  if (c >= 0xac00 && c <= 0xd7a3) return (c - 0xac00) % 28 !== 0 ? withBat : noBat;
  if (/[0-9]/.test(last)) return "0136780".includes(last) ? withBat : noBat;
  return noBat;
}

/** 이름에서 기초자산을 읽어 본다. 못 읽으면 null */
function assetFromName(name: string): string | null {
  for (const [re, label] of NAME_ASSET) if (re.test(name)) return label;
  return null;
}

function tell(name: string, index: string | null): string {
  const p = parse(name);
  const L: string[] = [];

  /* ── 1. 무엇을 추종하나 ────────────────────────────────── */
  const what: string[] = [];
  const guess = assetFromName(name);

  if (index) {
    what.push(`${index}${josa(index, "을", "를")} 기초지수로 삼는다.`);
    const note = INDEX_NOTE[index];
    if (note) what.push(note);
  } else if (guess) {
    /* 비교지수는 못 받았지만 이름에 적혀 있는 경우 — 어디까지가 추정인지 밝힌다 */
    what.push(`이름으로 보아 ${guess}${josa(guess, "을", "를")} 좇는다.`);
    what.push("다만 키움 시세에 비교지수가 안 실려 있어, 정확한 기초지수는 상품 페이지에서 확인해야 한다.");
  } else {
    /* 기초자산은 못 짚어도 테마가 박혀 있으면 그것만이라도 말해 준다 — 「KODEX 바이오」 같은 것 */
    const themes = NAME_THEME.filter(([re]) => re.test(name)).map(([, l]) => l);
    if (themes.length > 0) {
      what.push(`이름으로 보아 ${themes.join("·")} 쪽 종목을 담는다.`);
      what.push("키움 시세에 비교지수가 안 실려 있어, 편입 기준은 상품 페이지에서 확인해야 한다.");
    } else {
      what.push("키움 시세에 비교지수가 안 실려 있고, 이름만으로는 기초자산을 특정하기 어렵다. 상품 페이지에서 확인해야 한다.");
    }
  }

  if (p.mult === 2) what.push("이름의 「레버리지」대로 기초지수의 하루치 수익률을 2배로 좇는다.");
  else if (p.mult === -1) what.push("이름의 「인버스」대로 기초지수가 내릴 때 오르도록 하루치 수익률을 반대로 좇는다.");
  else if (p.mult === -2) what.push("기초지수의 하루치 수익률을 반대 방향으로 2배 좇는다.");

  if (p.bondMix !== null) {
    const tag = `채권혼합${p.bondMix}`;
    what.push(`이름의 「${tag}」${josa(tag, "은", "는")} 주식과 채권을 ${p.bondMix} 대 ${100 - p.bondMix}으로 섞는다는 뜻이다.`);
  } else if (/채권혼합/.test(name)) {
    what.push("주식과 채권을 섞어 담는 혼합형이다.");
  }

  if (p.active) what.push("「액티브」라 지수를 그대로 복제하지 않고 운용역 재량이 들어간다.");
  L.push("1. 무엇을 추종하나\n" + what.join(" "));

  /* ── 2. 어느 판에 속하나 ───────────────────────────────── */
  const tags = new Set<string>([p.asset]);
  for (const [re, label] of NAME_THEME) if (re.test(name)) tags.add(label);
  if (p.mult === 2) tags.add("레버리지");
  if (p.mult !== null && p.mult < 0) tags.add("인버스");
  if (p.active) tags.add("액티브");
  if (p.coveredCall) tags.add("커버드콜");
  if (p.hedged) tags.add("환헤지");
  if (p.synthetic) tags.add("합성");
  if (p.totalReturn) tags.add("TR");
  if (p.maturity) tags.add("만기매칭");
  if (p.bondMix !== null || /채권혼합/.test(name)) tags.add("채권혼합");
  L.push("2. 어느 판에 속하나\n" + [...tags].join(", "));

  /* ── 3. 이름에서 읽히는 특이점 ─────────────────────────── */
  const notes: string[] = [];
  if (p.mult !== null) {
    notes.push(
      "레버리지·인버스는 하루 단위 수익률을 좇는다. 여러 날 쌓이면 그 기간 지수 등락률의 배수와 어긋난다(변동성이 클수록 더 벌어진다).",
    );
  }
  if (p.synthetic) notes.push("「합성」은 자산을 직접 담지 않고 증권사와 스왑으로 수익률을 주고받는 구조다 — 거래상대방 위험이 따라온다.");
  if (p.hedged) notes.push("「(H)」는 환헤지다. 환율이 움직여도 수익률에 거의 반영되지 않는 대신 헤지 비용이 든다.");
  else if (p.asset === "해외주식") notes.push("환헤지 표기가 없으므로 환율 변동이 수익률에 그대로 들어온다.");
  if (p.totalReturn) notes.push("「TR」은 분배금을 안 주고 자동 재투자한다 — 현금 분배를 기대하는 자리에는 안 맞는다.");
  if (p.coveredCall) {
    notes.push(
      `콜옵션을 팔아 프리미엄을 받는 커버드콜${p.callCycle ? `(${p.callCycle} 만기)` : ""}이다. 분배금은 두터워지는 대신 크게 오를 때 상승을 못 따라간다.`,
    );
  }
  if (p.maturity) notes.push("만기까지 들고 가는 채권형이라 만기에 가까워질수록 금리 변동에 덜 흔들린다.");
  notes.push("운용보수·분배 주기·순자산은 이 자료에 없다 — 상품 페이지에서 확인해야 한다.");
  L.push("3. 이름에서 읽히는 특이점\n" + notes.join(" "));

  return L.join("\n\n");
}

/* ------------------------------------------------------------------ */

const seedPath = path.join(serverRoot, "data", "etfIndex.seed.json");
const seed = JSON.parse(await fs.readFile(seedPath, "utf-8")) as EtfSeed;

const briefPath = path.join(serverRoot, "data", "companyBriefs.json");
let store: Record<string, Brief> = {};
try {
  store = JSON.parse(await fs.readFile(briefPath, "utf-8")) as Record<string, Brief>;
} catch {
  store = {};
}

const now = new Date();
const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
const day = kst.toISOString().slice(0, 10);

let made = 0;
for (const [code, e] of Object.entries(seed.etfs)) {
  store[code] = {
    code,
    name: e.name,
    day,
    at: now.toISOString(),
    text: tell(e.name, e.index),
    /* AI 를 안 썼다는 게 화면에 보여야 한다 — 「누가 썼나」가 신뢰의 절반이다 */
    model: null,
    sources: e.index ? ["ETF 이름", "키움 추적지수"] : ["ETF 이름"],
    inputTokens: 0,
    outputTokens: 0,
  };
  made++;
}

/*
 * ⚠️ `--dry` 는 파일을 안 건드린다. fillBriefs 가 도는 중에 눈으로 확인하려고 둔 것이다 —
 * 둘 다 companyBriefs.json 을 통째로 다시 쓰기 때문에 겹쳐 돌면 한쪽이 날아간다.
 */
const dry = process.argv.includes("--dry");
if (!dry) {
  await fs.writeFile(briefPath, JSON.stringify(store, null, 1), "utf-8");
  console.log(`ETF ${made}개 생성 · 파일 전체 ${Object.keys(store).length}개`);
} else {
  console.log(`[dry] ETF ${made}개 — 저장하지 않음`);
}

/*
 * 얼마나 읽어냈는지를 센다. 「특정하기 어렵다」로 끝난 게 많으면 NAME_ASSET 을 더 채워야
 * 한다는 뜻이다 — GPT 가 1,167개 전부 그렇게 끝냈던 자리다.
 */
if (process.argv.includes("--stat")) {
  let withIndex = 0;
  let byName = 0;
  let unknown = 0;
  const assets = new Map<string, number>();
  for (const [code, e] of Object.entries(seed.etfs)) {
    /* 테마 폴백까지 쳐야 실제로 화면에 뭐가 나가는지와 맞는다 */
    const themed = NAME_THEME.some(([re]) => re.test(e.name));
    if (e.index) withIndex++;
    else if (assetFromName(e.name) || themed) byName++;
    else unknown++;
    const a = parse(e.name).asset;
    assets.set(a, (assets.get(a) ?? 0) + 1);
    void code;
  }
  console.log(`\n기초자산을 밝힌 정도: 키움 지수 ${withIndex} · 이름에서 ${byName} · 못 밝힘 ${unknown}`);
  console.log("자산군:", [...assets.entries()].map(([k, v]) => `${k} ${v}`).join(" · "));
  console.log("\n못 밝힌 것 20개:");
  let n = 0;
  for (const e of Object.values(seed.etfs)) {
    if (e.index || assetFromName(e.name) || NAME_THEME.some(([re]) => re.test(e.name))) continue;
    if (++n > 20) break;
    console.log(`  ${e.name}`);
  }
}

/* 눈으로 확인할 표본을 찍는다 — 규칙이 어긋나면 여기서 티가 난다 */
if (dry || process.argv.includes("--sample")) {
  const picks = process.argv.includes("--all-sample")
    ? Object.keys(store).slice(0, 40)
    : ["069500", "122630", "251340", "381180", "482730", "0184E0", "411060", "473440"];
  for (const c of picks) {
    if (store[c]) console.log(`\n───── ${store[c].name} (${c})\n${store[c].text}`);
  }
}
