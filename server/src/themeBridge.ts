import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import { loadThemes, type NaverThemeStore } from "./naverThemes.js";
import { getMarketSnapshot, peekSnapshot, type MarketSnapshot } from "./marketSnapshot.js";
import { isTradingDay } from "./tradingDay.js";
import { MIN } from "./marketHours.js";

/**
 * **국내 테마 ↔ 미국 업종 다리** (2026-09-15).
 *
 * 벤티지: "너 지금 미국 테마랑 국내 테마 모음 다 들고 있지?" → "두 개 매칭해서 엮어 볼래?" →
 * 선택지에서 「지금 화면에도 붙이기」. 국내 266 테마(편입 사유 달림)와 미국 132 업종(로이터 분류)을 잇는다.
 *
 * ## 두 가닥으로 잇는다
 *
 * 1. **회사 언급** — 국내 종목의 편입 사유에 미국 회사 이름이 나오면(「엔비디아향 HBM」 「테슬라에 공급」)
 *    그 회사의 업종과 잇는다. 근거가 글로 남아 있어 가장 단단하다. 9/15 실측 58개 테마.
 *    이름난 회사(시총 200억 달러 이상)만 사전에 넣는다 — 짧은 이름이 아무 데나 걸리지 않게.
 *    「타겟」(target) 「카니발」(기아 카니발) 「로켓」처럼 보통 말과 같은 이름은 뺐다(`STOP`).
 * 2. **낱말 사전** — 테마 이름의 낱말 → 미국 업종(`CONCEPT`). 사람이 적은 표라 **어림**이다. 164개.
 *
 * `themeLinks.ts`(테마 DB 「브리핑」 탭)의 18줄 사전과 목적이 겹치지만 그쪽은 개념 하나에 테마 하나만
 * 골라 주간 흐름을 견주는 화면이고, 이쪽은 **테마마다** 짝을 달고 날마다 기록을 쌓는다.
 *
 * ## 기록 — 이게 이 모듈의 진짜 몫이다
 *
 * 9/15 하루치로 재 보니 짝끼리의 상관이 −0.12 로 무작위(−0.16~+0.12)와 구별이 안 됐다. 하루로는 모른다.
 * 그래서 거래일마다 15:40(정규장 종가가 굳은 공백)에 **그날 아침 받은 미국 업종 등락**과 **오늘 국내 테마
 * 등락**을 한 줄로 쌓는다(`data/themeBridgeLog.jsonl`). 30거래일쯤 쌓이면 「미국을 따라가는 짝」만 남긴다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const LOG = join(here, "..", "data", "themeBridgeLog.jsonl");

/* ------------------------------------------------------------------ */
/* 사전                                                                */
/* ------------------------------------------------------------------ */

const SUFFIX =
  /\s*(ADR|클래스\s*[A-C]|Class\s*[A-C]|홀딩스|홀딩|코퍼레이션|코프|인코퍼레이티드|인크|테크놀로지스|테크놀로지|그룹|인터내셔널|컴퍼니스|컴퍼니|리미티드|피엘씨|PLC|SE|NV|\(.*?\))\s*$/;
function coreName(n: string): string {
  let c = n.trim();
  for (let i = 0; i < 4; i++) {
    const d = c.replace(SUFFIX, "").trim();
    if (d === c) break;
    c = d;
  }
  return c;
}
/** 편입 사유가 흔히 쓰는 다른 이름 */
const ALIAS: Record<string, string[]> = {
  알파벳: ["구글"],
  "메타 플랫폼스": ["메타", "페이스북"],
  아마존닷컴: ["아마존"],
};
/** 미국에 상장한 한국 회사 — 국내 종목을 미국 회사로 세면 안 된다 */
const KOREAN_CO = /SK하이닉스|KB금융|신한|우리금융|포스코|POSCO|^KT|한국전력|LG디스플레이|그라비티|웹젠|쿠팡/;
/** 보통 말과 같은 이름 — 「타겟 시장」 「카니발(기아)」 「로켓 배송」 */
const STOP = new Set(["타겟", "카니발", "로켓", "ING", "F5", "코어", "퍼스트", "유니온", "스타", "타깃", "이튼", "아레스", "블록", "로스"]);
/** 이름 뒤에 붙어도 되는 조사 — 「애플향」은 걸리고 「애플리케이션」은 안 걸리게 */
const PART = "은는이가을를의에와과도로향측사";
const MIN_CAP_USD = 20e9;

/** 국내 테마 이름 낱말 → 미국 업종 이름. **사람이 적은 표라 어림이다** */
const CONCEPT: [RegExp, string[]][] = [
  [/반도체|HBM|메모리|파운드리|CXL|소캠|SOCAMM|유리기판|뉴로모픽|온디바이스/, ["반도체", "반도체 장비 및 테스트"]],
  [/반도체 장비|프로브|웨이퍼/, ["반도체 장비 및 테스트"]],
  [/2차전지|배터리|리튬|전고체|양극재|음극재|전해질|분리막/, ["전기 부품 및 장비", "자동차 및 트럭 제조", "특수 채굴 및 금속"]],
  [/전기차|자율주행|수소차|자동차/, ["자동차 및 트럭 제조", "자동차, 트럭 및 오토바이 부품"]],
  [/원자력|원전|SMR|우라늄/, ["우라늄", "민자 발전 사업", "전력 유틸리티"]],
  [/전력|전선|변압기|초전도|ESS|스마트그리드/, ["중전기장비", "전기 부품 및 장비", "전력 유틸리티"]],
  [/태양광|풍력|수소|신재생/, ["재생 가능 에너지 장비 및 서비스", "재생 가능 연료"]],
  [/방산|방위|우주|항공기|드론|위성|누리호|스페이스X|UAM/, ["항공우주 및 방위"]],
  [/항공|LCC/, ["항공사"]],
  [/여행|카지노|호텔|면세/, ["호텔, 모텔 및 크루즈 라인", "카지노 및 도박", "여가 및 오락시설"]],
  [/바이오|신약|유전자|항암|면역|줄기세포|mRNA|비만|치매|백신|진단|모더나|화이자/, ["생명 공학 및 의학 연구", "제약"]],
  [/의료기기|미용기기|임플란트|치아/, ["첨단 의료 장비 및 기술", "의료 장비, 물품 및 유통"]],
  [/제약|의약품|원료의약/, ["제약"]],
  [/게임|메타버스|NFT/, ["오락용 제품", "엔터테인먼트 제작"]],
  [/엔터|K-POP|영화|드라마|영상콘텐츠|웹툰|OTT/, ["엔터테인먼트 제작", "방송"]],
  [/광고|마케팅/, ["광고 및 마케팅"]],
  [/블록체인|비트코인|가상화폐|암호화폐|스테이블코인|STO|토큰/, ["블록 체인 및 암호화폐", "핀테크"]],
  [/핀테크|전자결제|간편결제|애플페이|인터넷은행/, ["핀테크", "기타 핀테크 인프라"]],
  [/은행|금융지주/, ["은행"]],
  [/증권/, ["투자 은행 및 중개 서비스"]],
  [/보험/, ["손해보험", "생명 및 건강 보험"]],
  [/클라우드|소프트웨어|보안|SaaS|챗GPT|AI 챗봇|인공지능|딥페이크/, ["소프트웨어", "IT 서비스 및 컨설팅"]],
  [/데이터센터|AI 반도체/, ["반도체", "컴퓨터 하드웨어"]],
  [/5G|6G|통신|광통신|네트워크/, ["통신 및 네트워킹", "무선 통신 서비스"]],
  [/스마트폰|아이폰|폴더블|카메라모듈/, ["전화 및 소형 장치"]],
  [/PCB|MLCC|디스플레이|OLED|LED|전자부품/, ["전자 장비 및 부품"]],
  [/로봇|휴머노이드|스마트팩토리|자동화/, ["산업용 기계 및 장비"]],
  [/건설|인프라|재건|시멘트|레미콘/, ["건설 및 엔지니어링", "건설 자재"]],
  [/건설기계|농기계|중장비/, ["중장비 및 차량"]],
  [/철강|강관|비철|구리|알루미늄|아연|희토류|니켈/, ["철 및 강철", "특수 채굴 및 금속", "알루미늄", "다각적 채굴"]],
  [/^금$|귀금속|금값/, ["금", "금 제외 귀금속 및 광물"]],
  [/석유|정유|LNG|가스|셰일|유가/, ["오일, 가스 탐사 및 생산", "오일, 가스 정제 및 마케팅", "오일 및 가스 수송 서비스"]],
  [/석탄/, ["석탄"]],
  [/화학/, ["상품 화학", "특수 화학제", "다각적 화학 산업"]],
  [/비료|농업|스마트팜|종자/, ["농화학제", "어업 및 농업"]],
  [/음식료|식품|라면|육류|사료/, ["식품 가공"]],
  [/주류|맥주|소주|위스키/, ["양조업", "증류주 및 포도주"]],
  [/담배/, ["담배"]],
  [/화장품|미용/, ["개인 생활 필수 용품"]],
  [/의류|패션|신발/, ["의류 및 액세서리", "제화"]],
  [/유통|백화점|편의점|홈쇼핑|이커머스|전자상거래/, ["할인점", "백화점", "온라인 서비스"]],
  [/해운|조선|컨테이너|벌크/, ["해양 화물 및 물류"]],
  [/택배|물류|육운/, ["배달, 우편, 항공 화물 및 육상 물류", "지상 화물 및 물류"]],
  [/교육|에듀테크/, ["기타 교육 서비스 제공"]],
  [/리츠|REITs|부동산/, ["특수 REITs", "상업용 REITs", "부동산 서비스"]],
  [/제지|종이|포장/, ["종이 포장재", "종이 제품"]],
  [/가구|인테리어/, ["가정용 가구"]],
  [/가전|전자제품/, ["가전제품, 도구 및 가정 용품", "가정용 전자 제품"]],
  [/폐기물|환경|수처리|탄소/, ["환경 서비스 및 장비", "수자원 유틸리티"]],
];

/* ------------------------------------------------------------------ */
/* 다리 세우기                                                          */
/* ------------------------------------------------------------------ */

export interface BridgeCompany {
  symbol: string;
  name: string;
  /** 그 회사의 미국 업종 */
  industry: string;
  industryCode: string;
  /** 어젯밤 등락(%) */
  changeRate: number | null;
  /** 편입 사유에 이 회사가 나오는 국내 종목 */
  by: { code: string; name: string }[];
}

export interface BridgeIndustry {
  code: string;
  name: string;
  /** 무엇으로 이었나 — 회사 언급(근거 있음) · 낱말 사전(어림) */
  via: "회사" | "낱말" | "둘 다";
  /** 어젯밤 시총 가중 등락(%) */
  changeRate: number | null;
}

export interface BridgeTheme {
  no: number;
  name: string;
  industries: BridgeIndustry[];
  companies: BridgeCompany[];
}

interface Bridge {
  key: string;
  usAt: string;
  byNo: Map<number, BridgeTheme>;
  /** 업종 코드 → 붙은 국내 테마 번호 */
  byIndustry: Map<string, number[]>;
  usRate: Map<string, number>;
}

let cached: Bridge | null = null;

function hit(text: string, key: string): boolean {
  const latin = /^[A-Za-z0-9]/.test(key);
  let i = text.indexOf(key);
  while (i >= 0) {
    const nx = text[i + key.length] ?? " ";
    const pv = text[i - 1] ?? " ";
    const ok = latin
      ? !/[A-Za-z0-9]/.test(pv) && !/[A-Za-z0-9]/.test(nx)
      : !/[가-힣]/.test(pv) && (!/[가-힣]/.test(nx) || PART.includes(nx));
    if (ok) return true;
    i = text.indexOf(key, i + 1);
  }
  return false;
}

function build(store: NaverThemeStore): Bridge {
  /* 미국 업종 등락 — 시총 가중. 「반도체」가 작은 종목 수백 개의 평균이 되면 엔비디아가 빠진 숫자가 된다 */
  const usRate = new Map<string, number>();
  const indByName = new Map<string, { code: string; name: string }>();
  const coIdx = new Map<string, { symbol: string; name: string; industry: string; industryCode: string; cap: number; changeRate: number | null }>();
  for (const ind of store.us) {
    indByName.set(ind.name, { code: ind.code, name: ind.name });
    let w = 0;
    let a = 0;
    for (const st of ind.stocks) {
      if (st.changeRate != null && st.marketCap) {
        w += st.marketCap;
        a += st.marketCap * st.changeRate;
      }
      if ((st.marketCap ?? 0) < MIN_CAP_USD || KOREAN_CO.test(st.name)) continue;
      const c = coreName(st.name);
      for (const k of new Set([c, ...(ALIAS[c] ?? [])])) {
        if (k.length < 2 || STOP.has(k)) continue;
        const prev = coIdx.get(k);
        if (!prev || prev.cap < (st.marketCap ?? 0))
          coIdx.set(k, { symbol: st.symbol, name: c, industry: ind.name, industryCode: ind.code, cap: st.marketCap ?? 0, changeRate: st.changeRate });
      }
    }
    if (w > 0) usRate.set(ind.code, Math.round((a / w) * 100) / 100);
  }
  const keys = [...coIdx.keys()].sort((a, b) => b.length - a.length);

  const byNo = new Map<number, BridgeTheme>();
  const byIndustry = new Map<string, number[]>();
  for (const t of store.themes) {
    const cos = new Map<string, BridgeCompany>();
    for (const st of t.stocks) {
      const d = st.desc ?? "";
      if (!d) continue;
      const seen = new Set<string>();
      for (const k of keys) {
        if (!hit(d, k)) continue;
        const u = coIdx.get(k)!;
        if (seen.has(u.symbol)) continue;
        seen.add(u.symbol);
        const had =
          cos.get(u.symbol) ??
          { symbol: u.symbol, name: u.name, industry: u.industry, industryCode: u.industryCode, changeRate: u.changeRate, by: [] };
        had.by.push({ code: st.code, name: st.name });
        cos.set(u.symbol, had);
      }
    }
    const companies = [...cos.values()].sort((a, b) => b.by.length - a.by.length);
    /* 회사 언급으로 업종을 잇는 건 **두 종목 이상**일 때만 — 하나뿐이면 그 회사 얘기지 업종 얘기가 아니다 */
    const byCo = new Map<string, number>();
    for (const c of companies) byCo.set(c.industryCode, (byCo.get(c.industryCode) ?? 0) + c.by.length);
    const viaCo = new Set([...byCo].filter(([, n]) => n >= 2).map(([code]) => code));
    const viaWord = new Set<string>();
    for (const [re, names] of CONCEPT) {
      if (!re.test(t.name)) continue;
      for (const n of names) {
        const ind = indByName.get(n);
        if (ind) viaWord.add(ind.code);
      }
    }
    const industries: BridgeIndustry[] = [...new Set([...viaCo, ...viaWord])].map((code) => {
      const ind = store.us.find((u) => u.code === code)!;
      return {
        code,
        name: ind.name,
        via: viaCo.has(code) && viaWord.has(code) ? "둘 다" : viaCo.has(code) ? "회사" : "낱말",
        changeRate: usRate.get(code) ?? null,
      };
    });
    /* 근거 있는 것부터 — 회사 언급 · 둘 다 · 낱말 */
    const rank = { "둘 다": 0, 회사: 1, 낱말: 2 } as const;
    industries.sort((a, b) => rank[a.via] - rank[b.via]);
    if (industries.length === 0 && companies.length === 0) continue;
    byNo.set(t.no, { no: t.no, name: t.name, industries, companies });
    for (const i of industries) {
      const arr = byIndustry.get(i.code) ?? [];
      arr.push(t.no);
      byIndustry.set(i.code, arr);
    }
  }
  return { key: `${store.fetchedAt}|${store.usFetchedAt}`, usAt: store.usFetchedAt, byNo, byIndustry, usRate };
}

async function bridge(): Promise<{ b: Bridge; store: NaverThemeStore }> {
  const store = await loadThemes();
  const key = `${store.fetchedAt}|${store.usFetchedAt}`;
  if (!cached || cached.key !== key) cached = build(store);
  return { b: cached, store };
}

/* ------------------------------------------------------------------ */
/* 화면이 부르는 것                                                      */
/* ------------------------------------------------------------------ */

/** 테마 DB 상세 — 이 국내 테마의 미국 짝 */
export async function bridgeForTheme(no: number): Promise<(BridgeTheme & { usAt: string }) | null> {
  const { b } = await bridge();
  const t = b.byNo.get(no);
  return t ? { ...t, usAt: b.usAt } : null;
}

function krThemeRate(store: NaverThemeStore, snap: MarketSnapshot | null, no: number): number | null {
  if (!snap) return null;
  const t = store.themes.find((x) => x.no === no);
  if (!t) return null;
  /* 테마 DB 와 같은 자 — 구성종목 **단순평균** */
  const rs = t.stocks.map((s) => snap.byCode.get(s.code)?.changeRate).filter((v): v is number => typeof v === "number");
  return rs.length >= 3 ? Math.round((rs.reduce((a, b) => a + b, 0) / rs.length) * 100) / 100 : null;
}

export interface OvernightRow {
  code: string;
  name: string;
  changeRate: number;
  themes: { no: number; name: string; via: BridgeIndustry["via"]; changeRate: number | null }[];
}

/**
 * 시황 대시보드 — **어젯밤 미국 업종이 크게 움직인 곳 → 오늘 볼 국내 테마.**
 * 국내 테마가 한 개라도 붙은 업종만, 움직임이 큰 차례로.
 */
export async function overnightBridge(limit = 8): Promise<{ usAt: string; rows: OvernightRow[] }> {
  const { b, store } = await bridge();
  const snap = peekSnapshot();
  const rows: OvernightRow[] = [];
  for (const [code, nos] of b.byIndustry) {
    const r = b.usRate.get(code);
    if (r == null) continue;
    const ind = store.us.find((u) => u.code === code);
    if (!ind) continue;
    const themes = nos
      .map((no) => {
        const t = b.byNo.get(no)!;
        const via = t.industries.find((i) => i.code === code)?.via ?? "낱말";
        return { no, name: t.name, via, changeRate: krThemeRate(store, snap, no) };
      })
      /* 근거 있는 짝 먼저, 그다음 이름 순 */
      .sort((x, y) => (x.via === "낱말" ? 1 : 0) - (y.via === "낱말" ? 1 : 0));
    rows.push({ code, name: ind.name, changeRate: r, themes });
  }
  rows.sort((a, b) => Math.abs(b.changeRate) - Math.abs(a.changeRate));
  return { usAt: b.usAt, rows: rows.slice(0, limit) };
}

/* ------------------------------------------------------------------ */
/* 기록 — 거래일 15:40, 하루 한 줄                                       */
/* ------------------------------------------------------------------ */

let loggedDay = "";

function kst(): { date: string; min: number } {
  const d = new Date(Date.now() + 9 * 3600_000);
  return { date: d.toISOString().slice(0, 10), min: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

async function alreadyLogged(date: string): Promise<boolean> {
  try {
    const tail = (await readFile(LOG, "utf-8")).trimEnd().split("\n").pop() ?? "";
    return tail.startsWith(`{"d":"${date}"`);
  } catch {
    return false;
  }
}

async function logTick(client: KiwoomClient): Promise<void> {
  const { date, min } = kst();
  if (loggedDay === date || !isTradingDay()) return;
  /* 15:40~15:59 — 정규장 종가가 굳고 애프터(16:00) 전. 국내 테마 값이 「정규장」이라는 뜻으로 고정된다 */
  if (min < MIN.regularClose + 10 || min >= MIN.afterOpen) return;
  if (await alreadyLogged(date)) {
    loggedDay = date;
    return;
  }
  const { b, store } = await bridge();
  const snap = peekSnapshot() ?? (await getMarketSnapshot(client).catch(() => null));
  if (!snap) return;
  /* 미국 값이 오늘 아침 받은 것이 아니면(미국 휴장·수집 실패) 미국 칸은 비운다 — 옛 값을 오늘 것으로 적지 않는다 */
  const usFresh = store.usFetchedAt && new Date(new Date(store.usFetchedAt).getTime() + 9 * 3600_000).toISOString().slice(0, 10) === date;
  const kr: Record<string, number> = {};
  for (const no of b.byNo.keys()) {
    const r = krThemeRate(store, snap, no);
    if (r != null) kr[no] = r;
  }
  const us: Record<string, number> = {};
  if (usFresh) for (const [code, r] of b.usRate) us[code] = r;
  const line = JSON.stringify({ d: date, usAt: store.usFetchedAt, us, kr });
  await mkdir(dirname(LOG), { recursive: true });
  await appendFile(LOG, line + "\n", "utf-8");
  loggedDay = date;
  console.log(`[테마 다리] ${date} 기록 — 미국 ${Object.keys(us).length} · 국내 ${Object.keys(kr).length}`);
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startThemeBridgeLog(client: KiwoomClient): void {
  if (timer) return;
  timer = setInterval(() => void logTick(client).catch((e) => console.warn("[테마 다리] 기록 실패", e instanceof Error ? e.message : e)), 60_000);
  timer.unref?.();
}
