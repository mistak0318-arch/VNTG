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
}

export const TRADE_TARGETS: TradeTarget[] = [
  {
    key: "ic",
    watch: "export",
    label: "반도체 (집적회로)",
    hs: "8542",
    sectors: ["전기전자", "반도체"],
    note: "국내 수출 최대 품목. 디램·플래시가 여기 들어간다",
  },
  {
    key: "semi_device",
    watch: "export",
    label: "반도체 소자",
    hs: "8541",
    sectors: ["전기전자"],
    note: "다이오드·트랜지스터·전력반도체",
  },
  {
    key: "semi_equip",
    watch: "import",
    label: "반도체 장비",
    hs: "8486",
    sectors: ["기계", "전기전자"],
    note: "수입 증가는 향후 증설을 뜻해 소부장 실적을 선행",
  },
  {
    key: "car",
    watch: "export",
    label: "승용차",
    hs: "8703",
    sectors: ["운수장비", "자동차"],
    note: "완성차 수출 물량이 곧 매출",
  },
  {
    key: "carpart",
    watch: "export",
    label: "자동차 부품",
    hs: "8708",
    sectors: ["운수장비"],
    note: "완성차보다 먼저 움직이는 경우가 있다",
  },
  {
    key: "phone",
    watch: "export",
    label: "무선통신기기",
    hs: "8517",
    sectors: ["전기전자", "통신업"],
    note: "휴대폰·부품",
  },
  {
    key: "crude",
    watch: "import",
    label: "원유",
    hs: "2709",
    sectors: ["화학"],
    note: "수입 단가 상승은 정유·화학 원가 부담",
  },
  {
    key: "petro",
    watch: "export",
    label: "석유제품",
    hs: "2710",
    sectors: ["화학"],
    note: "정제마진의 선행 지표",
  },
  {
    key: "ship",
    watch: "export",
    label: "선박",
    hs: "8901",
    sectors: ["운수장비", "조선"],
    note: "인도 기준이라 실적과 시차가 있다",
  },
  {
    key: "steel",
    watch: "export",
    label: "철강 (판재)",
    hs: "7208",
    sectors: ["철강금속"],
    note: "중국 물량과 함께 봐야 의미가 있다",
  },
  {
    key: "battery",
    watch: "export",
    label: "이차전지",
    hs: "8507",
    sectors: ["전기전자", "화학"],
    note: "리튬이온 배터리. 전기차 수요와 연동",
  },
  {
    key: "dram_module",
    watch: "export",
    label: "디램 모듈·CPU",
    hs: "8473",
    sectors: ["전기전자", "반도체"],
    note: "8542(집적회로) 다음으로 큰 수출 항목. 모듈 단위라 서버 수요를 직접 반영",
  },
  {
    key: "display",
    watch: "export",
    label: "평판디스플레이 모듈",
    hs: "8524",
    sectors: ["전기전자", "디스플레이"],
    note: "통신기기용·노트북용 패널. OLED 전환 속도가 여기 찍힌다",
  },
  {
    key: "polarizer",
    watch: "export",
    label: "편광판·광학필름",
    hs: "9001",
    sectors: ["전기전자", "화학"],
    note: "디스플레이 소재. 패널보다 먼저 움직이는 경우가 있다",
  },
  {
    key: "transformer",
    watch: "export",
    label: "초고압 변압기",
    hs: "8504",
    sectors: ["전기전자", "전력기기"],
    note: "10,000kVA 초과 대형기가 주력. 미국 전력망 교체 수요와 연동",
  },
  {
    key: "switchgear",
    watch: "export",
    label: "배전반·제어반",
    hs: "8537",
    sectors: ["전기전자", "전력기기"],
    note: "변압기와 같이 나가는 품목. 전력기기 수주 흐름 확인용",
  },
  {
    key: "connector",
    watch: "export",
    label: "커넥터·개폐기",
    hs: "8536",
    sectors: ["전기전자"],
    note: "동축케이블·인쇄회로용. 전자부품 전반의 대리 지표",
  },
  {
    key: "wiring",
    watch: "export",
    label: "자동차 와이어링",
    hs: "8544",
    sectors: ["운수장비"],
    note: "자동차용 와이어링 하네스. 완성차 생산 계획을 선행",
  },
  {
    key: "tire",
    watch: "export",
    label: "타이어",
    hs: "4011",
    sectors: ["운수장비", "화학"],
    note: "래디알 구조가 주력. 교체 수요라 완성차와 사이클이 다르다",
  },
  {
    key: "bio",
    watch: "export",
    label: "바이오의약품",
    hs: "3002",
    sectors: ["의약품", "바이오"],
    note: "면역물품(항체·백신). 위탁생산(CMO) 물량이 여기 잡힌다",
  },
  {
    key: "medicine",
    watch: "import",
    label: "의약품 (완제)",
    hs: "3004",
    sectors: ["의약품"],
    note: "수입이 수출보다 크다. 신약 도입 규모를 본다",
  },
  {
    key: "medical_device",
    watch: "import",
    label: "의료기기",
    hs: "9018",
    sectors: ["의료정밀"],
    note: "초음파 영상진단기 등. 국내 업체 경쟁 환경",
  },
  {
    key: "polycarbonate",
    watch: "export",
    label: "폴리카보네이트·수지",
    hs: "3907",
    sectors: ["화학"],
    note: "엔지니어링 플라스틱. 전방 산업 수요를 반영",
  },
  {
    key: "polypropylene",
    watch: "export",
    label: "폴리프로필렌",
    hs: "3902",
    sectors: ["화학"],
    note: "범용 수지. 중국 증설 물량과 경쟁 관계",
  },
  {
    key: "aluminum",
    watch: "import",
    label: "알루미늄",
    hs: "7601",
    sectors: ["철강금속"],
    note: "수입 원자재. 단가 상승은 이차전지·자동차 원가 부담",
  },
  {
    key: "copper",
    watch: "import",
    label: "구리",
    hs: "7403",
    sectors: ["철강금속", "전기전자"],
    note: "전선·전력기기 원가. 구리 가격은 경기 선행 지표로도 쓰인다",
  },
  {
    key: "excavator",
    watch: "export",
    label: "굴착기·불도저",
    hs: "8429",
    sectors: ["기계"],
    note: "건설기계. 신품 기준이라 실수요를 반영",
  },
  {
    key: "valve",
    watch: "export",
    label: "밸브",
    hs: "8481",
    sectors: ["기계"],
    note: "플랜트·조선 전방 수요",
  },
  {
    key: "noodle",
    watch: "export",
    label: "면류 (라면)",
    hs: "1902",
    sectors: ["음식료품"],
    note: "K-푸드 수출. 라면이 대부분이며 음식료 업종의 대리 지표",
  },
  {
    key: "aircraft",
    watch: "import",
    label: "항공기·엔진",
    hs: "8802",
    sectors: ["운수창고", "운수장비"],
    note: "터보제트 엔진 등. 항공사 기재 도입 사이클",
  },
  {
    key: "cosmetic",
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
  const qs = new URLSearchParams({
    serviceKey: process.env.DATA_GO_KR_KEY!.trim(),
    strtYymm,
    endYymm,
    hsSgn: hs,
    numOfRows: "200",
    pageNo: "1",
  });

  const res = await fetch(`${ENDPOINT}?${qs}`, { signal: AbortSignal.timeout(20_000) });
  const xml = await res.text();
  const err = errorOf(xml);
  if (err) {
    void recordApiCall("dataGoKr", "Itemtrade", "failed");
    throw new Error(err);
  }
  void recordApiCall("dataGoKr", "Itemtrade", "ok");
  return parseItems(xml);
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

  const top = [...cur]
    .sort((a, b) => b.exportUsd - a.exportUsd)
    .slice(0, 4)
    .map((r) => ({
      name: r.name,
      exportUsd: r.exportUsd,
      yoy: yoy(r.exportUsd, prevByHs.get(r.hsCode)?.exportUsd ?? 0),
    }));

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
