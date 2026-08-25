import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { recordApiCall } from "./apiUsage.js";

/**
 * 관세청 품목별 수출입실적.
 *
 * 확인된 스펙 (2026-08-14, 실제 응답으로 검증):
 *   GET https://apis.data.go.kr/1220000/Itemtrade/getItemtradeList
 *   파라미터: serviceKey, strtYymm, endYymm(YYYYMM), hsSgn(HS 접두), numOfRows, pageNo
 *   응답: **XML** (type=json 을 줘도 XML로 온다)
 *   항목: hsCode(10자리) statKor(품목명) year("2026.07")
 *         expDlr(수출 달러) impDlr(수입 달러) expWgt/impWgt(중량) balPayments(무역수지)
 *
 * hsSgn 에 접두를 주면 그 아래 10자리 품목들이 쭉 나온다.
 * 예: 8542 → 디램, 플래시 메모리, 모노리식 집적회로 …
 *
 * **왜 이 데이터인가**: 반도체 수출이 꺾이는데 반도체 업종만 오르고 있으면 그건 경고다.
 * 분기 실적은 이미 주가에 반영된 뒤에 나오지만 이건 매월 갱신된다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const CACHE_FILE = join(DATA_DIR, "tradeStats.json");

const ENDPOINT = "https://apis.data.go.kr/1220000/Itemtrade/getItemtradeList";

/** 추적할 품목. HS 접두 → 우리가 부를 이름과 대응 업종 */
export interface TradeTarget {
  key: string;
  label: string;
  hs: string;
  sectors: string[];
  note: string;
  /**
   * 이 품목에서 봐야 할 쪽.
   * 원유·반도체장비처럼 우리가 사오기만 하는 품목은 수출이 0이라 수입을 봐야 한다.
   */
  watch: "export" | "import";
  /**
   * 관련 종목을 찾을 때 쓸 키움 테마 검색어. 앞에 있는 것부터 시도한다.
   * 테마를 못 찾으면 업종 구성종목으로 떨어진다.
   */
  themes?: string[];
}

export const TRADE_TARGETS: TradeTarget[] = [
  {
    key: "ic",
    themes: ["반도체_생산", "반도체_시스템반도체"],
    watch: "export",
    label: "반도체 (집적회로)",
    hs: "8542",
    sectors: ["전기전자", "반도체"],
    note: "국내 수출 최대 품목. 디램·플래시가 여기 들어간다",
  },
  {
    key: "semi_device",
    themes: ["반도체_전공정소재", "반도체_시스템반도체"],
    watch: "export",
    label: "반도체 소자",
    hs: "8541",
    sectors: ["전기전자"],
    note: "다이오드·트랜지스터·전력반도체",
  },
  {
    key: "semi_equip",
    themes: ["반도체_전공정장비", "반도체_후공정장비"],
    watch: "import",
    label: "반도체 장비",
    hs: "8486",
    sectors: ["기계", "전기전자"],
    note: "수입 증가는 향후 증설을 뜻해 소부장 실적을 선행",
  },
  {
    key: "car",
    themes: ["자동차_전장화 수혜", "그린카_하이브리드카/전기차"],
    watch: "export",
    label: "승용차",
    hs: "8703",
    sectors: ["운수장비", "자동차"],
    note: "완성차 수출 물량이 곧 매출",
  },
  {
    key: "carpart",
    themes: ["자동차_차량경량화 수혜", "자동차_전장화 수혜"],
    watch: "export",
    label: "자동차 부품",
    hs: "8708",
    sectors: ["운수장비"],
    note: "완성차보다 먼저 움직이는 경우가 있다",
  },
  {
    key: "phone",
    themes: ["스마트폰_삼성전자관련주", "휴대폰_RF부품"],
    watch: "export",
    label: "무선통신기기",
    hs: "8517",
    sectors: ["전기전자", "통신업"],
    note: "휴대폰·부품",
  },
  {
    key: "crude",
    themes: ["LPG(액화석유가스)", "자원개발 E&P"],
    watch: "import",
    label: "원유",
    hs: "2709",
    sectors: ["화학"],
    note: "수입 단가 상승은 정유·화학 원가 부담",
  },
  {
    key: "petro",
    themes: ["LPG(액화석유가스)", "합성수지"],
    watch: "export",
    label: "석유제품",
    hs: "2710",
    sectors: ["화학"],
    note: "정제마진의 선행 지표",
  },
  {
    key: "ship",
    themes: ["조선_해양플랜트", "조선_Eco선"],
    watch: "export",
    label: "선박",
    hs: "8901",
    sectors: ["운수장비", "조선"],
    note: "인도 기준이라 실적과 시차가 있다",
  },
  {
    key: "steel",
    themes: ["강관", "합금철"],
    watch: "export",
    label: "철강 (판재)",
    hs: "7208",
    sectors: ["철강금속"],
    note: "중국 물량과 함께 봐야 의미가 있다",
  },
  {
    key: "battery",
    themes: ["2차전지_완제품", "2차전지_소재(양극화물질등)"],
    watch: "export",
    label: "이차전지",
    hs: "8507",
    sectors: ["전기전자", "화학"],
    note: "리튬이온 배터리. 전기차 수요와 연동",
  },
  {
    key: "dram_module",
    themes: ["반도체_생산", "반도체_후공정"],
    watch: "export",
    label: "디램 모듈·CPU",
    hs: "8473",
    sectors: ["전기전자", "반도체"],
    note: "8542(집적회로) 다음으로 큰 수출 항목. 모듈 단위라 서버 수요를 직접 반영",
  },
  {
    key: "display",
    themes: ["AMOLED_소재", "LCD_부품"],
    watch: "export",
    label: "평판디스플레이 모듈",
    hs: "8524",
    sectors: ["전기전자", "디스플레이"],
    note: "통신기기용·노트북용 패널. OLED 전환 속도가 여기 찍힌다",
  },
  {
    key: "polarizer",
    themes: ["LCD_소재", "AMOLED_소재"],
    watch: "export",
    label: "편광판·광학필름",
    hs: "9001",
    sectors: ["전기전자", "화학"],
    note: "디스플레이 소재. 패널보다 먼저 움직이는 경우가 있다",
  },
  {
    key: "transformer",
    themes: ["스마트 그리드", "화력_발전기자재"],
    watch: "export",
    label: "초고압 변압기",
    hs: "8504",
    sectors: ["전기전자", "전력기기"],
    note: "10,000kVA 초과 대형기가 주력. 미국 전력망 교체 수요와 연동",
  },
  {
    key: "switchgear",
    themes: ["스마트 그리드", "원자력_기자재"],
    watch: "export",
    label: "배전반·제어반",
    hs: "8537",
    sectors: ["전기전자", "전력기기"],
    note: "변압기와 같이 나가는 품목. 전력기기 수주 흐름 확인용",
  },
  {
    key: "connector",
    themes: ["PCB(인쇄회로기판)", "FPCB(연성회로기판)"],
    watch: "export",
    label: "커넥터·개폐기",
    hs: "8536",
    sectors: ["전기전자"],
    note: "동축케이블·인쇄회로용. 전자부품 전반의 대리 지표",
  },
  {
    key: "wiring",
    themes: ["자동차_전장화 수혜", "자동차_차량경량화 수혜"],
    watch: "export",
    label: "자동차 와이어링",
    hs: "8544",
    sectors: ["운수장비"],
    note: "자동차용 와이어링 하네스. 완성차 생산 계획을 선행",
  },
  {
    key: "tire",
    themes: ["타이어"],
    watch: "export",
    label: "타이어",
    hs: "4011",
    sectors: ["운수장비", "화학"],
    note: "래디알 구조가 주력. 교체 수요라 완성차와 사이클이 다르다",
  },
  {
    key: "bio",
    themes: ["바이오_바이오시밀러/베터", "바이오_진단/백신"],
    watch: "export",
    label: "바이오의약품",
    hs: "3002",
    sectors: ["의약품", "바이오"],
    note: "면역물품(항체·백신). 위탁생산(CMO) 물량이 여기 잡힌다",
  },
  {
    key: "medicine",
    themes: ["신약개발/기술수출", "바이오_바이오시밀러/베터"],
    watch: "import",
    label: "의약품 (완제)",
    hs: "3004",
    sectors: ["의약품"],
    note: "수입이 수출보다 크다. 신약 도입 규모를 본다",
  },
  {
    key: "medical_device",
    themes: ["의료기기"],
    watch: "import",
    label: "의료기기",
    hs: "9018",
    sectors: ["의료정밀"],
    note: "초음파 영상진단기 등. 국내 업체 경쟁 환경",
  },
  {
    key: "polycarbonate",
    themes: ["엔지니어링 플라스틱", "합성수지"],
    watch: "export",
    label: "폴리카보네이트·수지",
    hs: "3907",
    sectors: ["화학"],
    note: "엔지니어링 플라스틱. 전방 산업 수요를 반영",
  },
  {
    key: "polypropylene",
    themes: ["합성수지", "합성섬유_원료"],
    watch: "export",
    label: "폴리프로필렌",
    hs: "3902",
    sectors: ["화학"],
    note: "범용 수지. 중국 증설 물량과 경쟁 관계",
  },
  {
    key: "aluminum",
    themes: ["비철금속주", "희소금속"],
    watch: "import",
    label: "알루미늄",
    hs: "7601",
    sectors: ["철강금속"],
    note: "수입 원자재. 단가 상승은 이차전지·자동차 원가 부담",
  },
  {
    key: "copper",
    themes: ["비철금속주", "희소금속"],
    watch: "import",
    label: "구리",
    hs: "7403",
    sectors: ["철강금속", "전기전자"],
    note: "전선·전력기기 원가. 구리 가격은 경기 선행 지표로도 쓰인다",
  },
  {
    key: "excavator",
    themes: ["기계_건설기계", "기계_공작기계"],
    watch: "export",
    label: "굴착기·불도저",
    hs: "8429",
    sectors: ["기계"],
    note: "건설기계. 신품 기준이라 실수요를 반영",
  },
  {
    key: "valve",
    themes: ["기계_공작기계", "조선_해양플랜트기자재"],
    watch: "export",
    label: "밸브",
    hs: "8481",
    sectors: ["기계"],
    note: "플랜트·조선 전방 수요",
  },
  {
    key: "noodle",
    themes: ["라면", "제과스낵"],
    watch: "export",
    label: "면류 (라면)",
    hs: "1902",
    sectors: ["음식료품"],
    note: "K-푸드 수출. 라면이 대부분이며 음식료 업종의 대리 지표",
  },
  {
    key: "aircraft",
    themes: ["운송_항공", "우주항공"],
    watch: "import",
    label: "항공기·엔진",
    hs: "8802",
    sectors: ["운수창고", "운수장비"],
    note: "터보제트 엔진 등. 항공사 기재 도입 사이클",
  },
  {
    key: "cosmetic",
    themes: ["화장품"],
    watch: "export",
    label: "화장품",
    hs: "3304",
    sectors: ["화학", "화장품"],
    note: "기초화장용이 주력. 대중국·대미 소비 회복의 대리 지표",
  },
];

export interface TradeItem {
  hsCode: string;
  name: string;
  month: string; // YYYY-MM
  exportUsd: number;
  importUsd: number;
  balanceUsd: number;
}

export interface TradeSummary {
  key: string;
  label: string;
  hs: string;
  sectors: string[];
  note: string;
  watch: "export" | "import";
  month: string;
  exportUsd: number;
  importUsd: number;
  balanceUsd: number;
  /** 전년 동월 대비 수출 증감률(%) — 비교 대상이 없으면 null */
  exportYoy: number | null;
  importYoy: number | null;
  /** 그 품목 안에서 수출이 큰 세부 항목 (디램·플래시 등) */
  top: { name: string; exportUsd: number; yoy: number | null }[];
}

export function isTradeConfigured(): boolean {
  return Boolean(process.env.DATA_GO_KR_KEY?.trim());
}

// ---------------------------------------------------------------- XML 파싱

/**
 * 응답이 평평한 구조라 정규식으로 충분하다.
 * 의존성을 늘리지 않으려고 XML 파서를 쓰지 않는다.
 */
function parseItems(xml: string): TradeItem[] {
  const out: TradeItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const get = (tag: string) => {
      const r = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block);
      return r ? r[1].trim() : "";
    };
    const num = (tag: string) => {
      const n = Number(get(tag).replace(/,/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const year = get("year"); // "2026.07" 또는 "총계"
    const hsCode = get("hsCode");
    // API는 기간 집계 행을 year="총계" 로 함께 준다.
    // 이걸 안 걸러내면 문자열 비교에서 "총계" > "2026-07" 이 되어
    // 최신 월 대신 집계 행이 잡히고 전년 동월 매칭이 통째로 깨진다.
    if (!/^\d{4}\.\d{2}$/.test(year)) continue;
    out.push({
      hsCode,
      name: get("statKor"),
      month: year.replace(".", "-"),
      exportUsd: num("expDlr"),
      importUsd: num("impDlr"),
      balanceUsd: num("balPayments"),
    });
  }
  return out;
}

/** 공공데이터포털 오류 판별 — 성공도 resultMsg 로 오므로 문구를 본다 */
function errorOf(xml: string): string | null {
  const m =
    /<resultMsg>([^<]+)<\/resultMsg>/.exec(xml) ??
    /<errMsg>([^<]+)<\/errMsg>/.exec(xml) ??
    /<returnAuthMsg>([^<]+)<\/returnAuthMsg>/.exec(xml);
  if (!m) return null;
  return /정상|NORMAL|SUCCESS/i.test(m[1]) ? null : m[1].trim();
}

// ---------------------------------------------------------------- 조회

async function fetchRange(hs: string, strtYymm: string, endYymm: string): Promise<TradeItem[]> {
  /*
   * 쪽을 넘겨 가며 다 받는다. 한 쪽 200행인데 세부 품목이 많은 HS(자동차부품 8708 등)는
   * 기간이 길면 200을 넘는다 — 첫 쪽만 받으면 **어느 달이 통째로 빠졌는지도 모른 채**
   * 합계가 작아진다.
   *
   * ⚠️ 이 API 는 **pageNo 를 무시하고 매번 전체를 준다** (2026-08-25 실측 —
   * 열 쪽을 그대로 합쳤더니 값이 정확히 10배가 됐다). 그래서 쪽 수로 멈추지 않고
   * (hsCode, month) 로 중복을 걸러, **새 행이 안 나오는 순간** 멈춘다.
   * 진짜 페이징을 하는 서버로 바뀌어도 이 조건은 그대로 맞는다.
   */
  const seen = new Set<string>();
  const out: TradeItem[] = [];
  for (let page = 1; page <= 10; page++) {
    const qs = new URLSearchParams({
      serviceKey: process.env.DATA_GO_KR_KEY!.trim(),
      strtYymm,
      endYymm,
      hsSgn: hs,
      numOfRows: "200",
      pageNo: String(page),
    });

    const res = await fetch(`${ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(20_000) });
    const xml = await res.text();
    const err = errorOf(xml);
    if (err) {
      void recordApiCall("dataGoKr", "Itemtrade", "failed");
      throw new Error(err);
    }
    void recordApiCall("dataGoKr", "Itemtrade", "ok");
    // 총계 행은 parseItems 가 거르므로, 쪽이 찼는지는 원본 <item> 수로 센다
    const rawCount = (xml.match(/<item>/g) ?? []).length;
    let added = 0;
    for (const item of parseItems(xml)) {
      const k = `${item.hsCode}:${item.month}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(item);
      added++;
    }
    if (rawCount < 200 || added === 0) break;
  }
  return out;
}

function ym(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/** 증감률. 기준이 0이면 계산하지 않는다 (0에서 늘어난 건 %로 말할 수 없다) */
function yoy(now: number, prev: number): number | null {
  if (!prev) return null;
  return ((now - prev) / prev) * 100;
}

/**
 * 한 품목의 최신 월 실적과 전년 동월 대비를 구한다.
 *
 * 최신 월이 언제인지는 알 수 없으므로(공표 시차) 최근 3개월을 받아 **가장 늦은 달**을 쓴다.
 * 전년 동월은 별도로 한 번 더 부른다 — 12개월을 통째로 받으면 응답이 너무 커진다.
 */
async function summarize(t: TradeTarget): Promise<TradeSummary | null> {
  const now = new Date();
  const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const recent = await fetchRange(t.hs, ym(from), ym(now));
  if (recent.length === 0) return null;

  const latest = recent.reduce((a, b) => (a.month > b.month ? a : b)).month;
  const cur = recent.filter((r) => r.month === latest);

  // 전년 동월
  const [y, m] = latest.split("-").map(Number);
  const prevYm = `${y - 1}${String(m).padStart(2, "0")}`;
  const prevRows = await fetchRange(t.hs, prevYm, prevYm).catch(() => [] as TradeItem[]);
  const prevByHs = new Map(prevRows.map((r) => [r.hsCode, r]));

  const sum = (rows: TradeItem[], f: (r: TradeItem) => number) =>
    rows.reduce((s, r) => s + f(r), 0);

  const exportUsd = sum(cur, (r) => r.exportUsd);
  const importUsd = sum(cur, (r) => r.importUsd);
  const prevExport = sum(prevRows, (r) => r.exportUsd);
  const prevImport = sum(prevRows, (r) => r.importUsd);

  /*
   * 세부 품목은 **이름으로 합친다.**
   *
   * HS 4단위 아래는 용도별로 갈라지는데(8542.31 프로세서 / .32 메모리 / .33 증폭기)
   * 그 아래 이름이 겹친다 — 「복합구조칩 집적회로」가 8542313000·8542323000·8542333000
   * 세 곳에 있다. 코드별로 세우면 **같은 이름이 목록에 두 번 뜬다.** 보는 사람은
   * 둘 중 어느 쪽이 진짜인지 알 수 없고, 어느 쪽도 그 품목의 전부가 아니다.
   */
  const byName = new Map<string, { exportUsd: number; prevUsd: number }>();
  for (const r of cur) {
    const acc = byName.get(r.name) ?? { exportUsd: 0, prevUsd: 0 };
    acc.exportUsd += r.exportUsd;
    acc.prevUsd += prevByHs.get(r.hsCode)?.exportUsd ?? 0;
    byName.set(r.name, acc);
  }
  const top = [...byName]
    .sort((a, b) => b[1].exportUsd - a[1].exportUsd)
    .slice(0, 4)
    .map(([name, v]) => ({ name, exportUsd: v.exportUsd, yoy: yoy(v.exportUsd, v.prevUsd) }));

  return {
    key: t.key,
    label: t.label,
    hs: t.hs,
    sectors: t.sectors,
    note: t.note,
    watch: t.watch,
    month: latest,
    exportUsd,
    importUsd,
    balanceUsd: exportUsd - importUsd,
    exportYoy: yoy(exportUsd, prevExport),
    importYoy: yoy(importUsd, prevImport),
    top,
  };
}

// ---------------------------------------------------------------- 캐시

interface Cache {
  at: string;
  items: TradeSummary[];
}

/**
 * 월 단위로 갱신되는 데이터라 하루 한 번이면 충분하다.
 * 품목마다 2회씩 부르므로 캐시 없이 매번 부르면 호출이 낭비된다.
 */
const CACHE_TTL_MS = 12 * 3600_000;

async function readCache(): Promise<Cache | null> {
  try {
    return JSON.parse(await readFile(CACHE_FILE, "utf-8")) as Cache;
  } catch {
    return null;
  }
}

export async function getTradeStats(force = false): Promise<{
  items: TradeSummary[];
  fetchedAt: string;
  error?: string;
}> {
  if (!isTradeConfigured()) {
    return {
      items: [],
      fetchedAt: "",
      error: "DATA_GO_KR_KEY 미설정 — docs/수출입API_설정가이드.md 참고",
    };
  }

  const cached = await readCache();
  if (!force && cached && Date.now() - new Date(cached.at).getTime() < CACHE_TTL_MS) {
    return { items: cached.items, fetchedAt: cached.at };
  }

  const items: TradeSummary[] = [];
  const failed: string[] = [];

  for (const t of TRADE_TARGETS) {
    try {
      const r = await summarize(t);
      if (r) items.push(r);
    } catch (err) {
      failed.push(`${t.label}: ${err instanceof Error ? err.message : "실패"}`);
    }
    // 공공데이터포털은 일 1만건이라 여유롭지만, 몰아치지는 않는다
    // 품목이 늘어 첫 조회가 오래 걸린다. 일 1만건이라 간격은 짧게 잡아도 된다.
    await new Promise((r) => setTimeout(r, 120));
  }

  // 전부 실패했으면 캐시를 덮어쓰지 않는다 — 있던 데이터를 날리면 안 된다
  if (items.length === 0) {
    return {
      items: cached?.items ?? [],
      fetchedAt: cached?.at ?? "",
      error: failed[0] ?? "조회 실패",
    };
  }

  const at = new Date().toISOString();
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(CACHE_FILE, JSON.stringify({ at, items }, null, 2), "utf-8");
  return { items, fetchedAt: at, error: failed.length > 0 ? failed.join(" / ") : undefined };
}

// ---------------------------------------------------------------- 월별 시계열

export interface TradeMonth {
  month: string; // YYYY-MM
  exportUsd: number;
  importUsd: number;
}

interface HistoryCache {
  [key: string]: { at: string; months: TradeMonth[] };
}

const HISTORY_FILE = join(DATA_DIR, "tradeHistory.json");
/** 월 단위 데이터 — 하루 한 번이면 충분하다 */
const HISTORY_TTL_MS = 24 * 3600_000;
const HISTORY_MONTHS = 36;

/**
 * 한 품목의 **월별 수출·수입 시계열** (최근 36개월).
 *
 * 최신 한 달 + 전년동월 % 만으로는 「이 산업이 잘 되어 가고 있나」를 알 수 없다 —
 * 꺾이는 중인지, 바닥 찍고 도는 중인지는 **선의 모양**이 말한다.
 *
 * 쌓이길 기다릴 필요가 없다: 관세청 API 가 과거 구간 조회를 지원하므로 그냥
 * 3년 치를 받아 온다. 12개월씩 세 번(응답이 너무 커지지 않게), 품목을 **펼칠 때만**
 * 부르고 하루 캐시한다 — 31품목을 미리 다 받으면 호출 낭비다.
 */
export async function getTradeHistory(key: string): Promise<{ months: TradeMonth[] }> {
  const t = TRADE_TARGETS.find((x) => x.key === key);
  if (!t) throw new Error("알 수 없는 품목입니다.");
  if (!isTradeConfigured()) throw new Error("DATA_GO_KR_KEY 미설정");

  let cache: HistoryCache = {};
  try {
    cache = JSON.parse(await readFile(HISTORY_FILE, "utf-8")) as HistoryCache;
  } catch {
    /* 처음이면 빈 캐시 */
  }
  const hit = cache[key];
  if (hit && Date.now() - new Date(hit.at).getTime() < HISTORY_TTL_MS) {
    return { months: hit.months };
  }

  const now = new Date();
  const byMonth = new Map<string, TradeMonth>();
  for (let w = 0; w < HISTORY_MONTHS / 12; w++) {
    const from = new Date(now.getFullYear(), now.getMonth() - 12 * (w + 1) + 1, 1);
    const to = new Date(now.getFullYear(), now.getMonth() - 12 * w, 1);
    const rows = await fetchRange(t.hs, ym(from), ym(to));
    for (const r of rows) {
      const acc = byMonth.get(r.month) ?? { month: r.month, exportUsd: 0, importUsd: 0 };
      acc.exportUsd += r.exportUsd;
      acc.importUsd += r.importUsd;
      byMonth.set(r.month, acc);
    }
  }

  const months = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));
  if (months.length === 0) {
    // 조회가 통째로 빈 날은 있던 캐시를 지우지 않는다
    if (hit) return { months: hit.months };
    return { months: [] };
  }

  cache[key] = { at: new Date().toISOString(), months };
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(HISTORY_FILE, JSON.stringify(cache, null, 2), "utf-8");
  return { months };
}

// ---------------------------------------------------------------- 리포트용

function pct(n: number | null): string {
  if (n === null) return "-";
  return `${n > 0 ? "+" : ""}${n.toFixed(1)}%`;
}

function bil(usd: number): string {
  return `${(usd / 1e8).toFixed(1)}억달러`;
}

/** AI 리포트 다이제스트에 넣을 형태 */
export function toTradeDigest(items: TradeSummary[]): string {
  if (items.length === 0) return "";
  const month = items[0]?.month ?? "";
  const val = (i: TradeSummary) => (i.watch === "import" ? i.importUsd : i.exportUsd);
  const rate = (i: TradeSummary) => (i.watch === "import" ? i.importYoy : i.exportYoy);
  const lines = items
    .slice()
    .sort((a, b) => (rate(b) ?? -999) - (rate(a) ?? -999))
    .map(
      (i) =>
        `${i.label} ${i.watch === "import" ? "수입" : "수출"} ${bil(val(i))} (전년동월 ${pct(rate(i))}) → ${i.sectors.join("·")}`,
    );
  return `\n[수출입 동향 ${month} · 관세청]\n${lines.join("\n")}`;
}

/** 특정 업종의 수출 증감률 — 섹터 강세 판정·신호등에서 쓴다 */
export function exportYoyForSector(items: TradeSummary[], sectorName: string): number | null {
  const n = sectorName.replace(/[\s/]/g, "");
  const hit = items.filter((i) =>
    i.sectors.some((s) => n.includes(s.replace(/[\s/]/g, "")) || s.includes(n)),
  );
  if (hit.length === 0) return null;
  // 수입 품목(원유 등)은 수출 증감률이 없으므로 섹터 판정에서 뺀다
  const withYoy = hit.filter((h) => h.watch === "export" && h.exportYoy !== null);
  if (withYoy.length === 0) return null;
  // 수출 규모로 가중평균 — 작은 품목이 큰 품목을 흔들면 안 된다
  const total = withYoy.reduce((s, h) => s + h.exportUsd, 0);
  if (!total) return null;
  return withYoy.reduce((s, h) => s + (h.exportYoy ?? 0) * h.exportUsd, 0) / total;
}
