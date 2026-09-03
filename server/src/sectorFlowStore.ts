import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";

/**
 * 업종별 투자자 순매수 누적.
 *
 * 지금까지 화면에 있던 건 "오늘 외국인 +2.3조" 하나였다. 그런데 판단에 쓰이는 건
 * 총액이 아니라 **어디서 빼서 어디로 넣었나**다. 총액이 같아도 반도체에서 빼서
 * 방산으로 옮긴 날과, 전 업종을 고르게 산 날은 완전히 다른 장이다.
 *
 * 데이터는 이미 받고 있었다. `ka10051`은 업종별로 60행(코스피 28 + 코스닥 32)을 주는데
 * marketOverview 는 종합지수 한 줄만 쓰고 나머지를 버린다. 그래서 **추가 호출 없이**
 * 업종별 수급을 만들 수 있다.
 *
 * 시장 폭(breadthStore)과 결정적으로 다른 점: **`base_dt` 로 과거 조회가 된다.**
 * 그래서 오늘 시작해도 곧바로 몇 달치가 생긴다 — 하루씩 쌓기를 기다릴 필요가 없다.
 * (검증: scripts/flow-probe.mjs)
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
const FILE = join(DATA_DIR, "sectorFlow.json");
const SECT_RESOURCE = "/api/dostk/sect";

/**
 * 저장하는 투자자 주체와 그 순서.
 *
 * ka10051 은 12주체를 주지만 전부 쌓으면 파일만 커지고 판단에는 안 쓴다.
 * 방향을 읽는 데 필요한 여섯만 남긴다 — 특히 연기금과 투신은 서로 엇갈릴 때가
 * 변곡 신호라서 반드시 따로 봐야 한다.
 *
 * **이 순서가 곧 저장 스키마다.** 중간에 끼워 넣으면 기존 파일이 깨진다.
 */
export const SUBJECTS = [
  "foreign",
  "institution",
  "individual",
  "pension",
  "trust",
  "private",
  /*
   * 금융투자 (2026-08-27 추가 — 지수 시트 기관 세부). **맨 뒤에만 붙인다** —
   * 이 순서가 저장 스키마라 중간에 끼우면 기존 파일이 깨진다. 옛 행은 이 칸이
   * 없으므로 읽는 쪽이 v.length 로 가려 "-" 처리한다.
   * 필드 실측(2026-08-27, ka10051 원본): sc_netprps = 금융투자.
   * 검산: 금투 8328 + 투신 -37 + 연기금 -339 + 사모 1067 + 보험 73 + 은행 1
   * + 종신금 174 = 9267 = orgn_netprps(기관계) 정확히 일치.
   */
  "securities",
  /*
   * 나머지 다섯 (2026-08-31 — "지수 수급 전체 표시하라고 했더니 위에 한줄로만
   * 했구나 아래 표도 채워야지").
   *
   * 위쪽 한 줄은 그날 조회(ka10051)의 열두 주체를 다 쓰는데, **저장 스키마는
   * 일곱뿐**이라 아래 두 표(합산·일별)가 그만큼밖에 못 그렸다. 같은 시트 안에서
   * 위아래가 다른 주체를 보고 있었던 셈이다.
   *
   * ⚠️ **맨 뒤에만 붙인다** — 이 순서가 곧 저장 형식이라 중간에 끼우면 이미 쌓인
   * 파일이 통째로 어긋난다(금융투자를 뒤에 붙였던 것과 같은 규칙). 옛 행은 이 칸이
   * 없으므로 읽는 쪽이 `v.length` 로 가려 "-" 로 적는다 — **0 으로 채우면
   * 「안 샀다」로 읽혀 거짓이 된다.**
   *
   * 필드는 marketOverview.mapFlow 에서 이미 실측된 것을 그대로 쓴다(추측 아님).
   */
  "insurance",
  "bank",
  "otherFinance",
  "nation",
  "otherCorp",
] as const;
export type Subject = (typeof SUBJECTS)[number];

const FIELD_OF: Record<Subject, string> = {
  foreign: "frgnr_netprps",
  institution: "orgn_netprps",
  individual: "ind_netprps",
  pension: "endw_netprps", // 연기금
  trust: "invtrt_netprps", // 투신
  private: "samo_fund_netprps", // 사모펀드
  securities: "sc_netprps", // 금융투자 (실측 2026-08-27 — 검산은 SUBJECTS 주석)
  insurance: "insrnc_netprps",
  bank: "bank_netprps",
  otherFinance: "jnsinkm_netprps", // 종금·기타금융
  nation: "natn_netprps",
  otherCorp: "etc_corp_netprps",
};

export const SUBJECT_LABEL: Record<Subject, string> = {
  foreign: "외국인",
  institution: "기관",
  individual: "개인",
  pension: "연기금",
  trust: "투신",
  private: "사모",
  securities: "금융투자",
  insurance: "보험",
  bank: "은행",
  otherFinance: "기타금융",
  nation: "국가",
  otherCorp: "기타법인",
};

export interface SectorFlowRow {
  /** 업종코드 (`_AL` 제거) */
  code: string;
  name: string;
  /** 업종지수 등락률(%) */
  changeRate: number;
  /** SUBJECTS 순서대로 순매수(억원) */
  v: number[];
}

export interface SectorFlowDay {
  /** YYYY-MM-DD */
  date: string;
  kospi: SectorFlowRow[];
  kosdaq: SectorFlowRow[];
}

type Market = "kospi" | "kosdaq";

/** 지수 자체를 나타내는 행 — 업종 비교에 섞이면 안 된다 */
const TOTAL_CODES = new Set(["001", "101"]);
/** 코스피 규모별 행. 업종은 아니지만 사이즈 로테이션을 보는 데 쓴다 */
const SIZE_CODES = new Set(["002", "003", "004"]);

/**
 * 업종 순위에서 빼야 하는 행.
 *
 * ka10051은 잎(전기/전자)과 가지(제조)와 지수 묶음(KOSDAQ 100)을 같은 배열에 섞어서 준다.
 * 그대로 순위를 매기면 **제조가 항상 1위**로 나온다 — 화학·금속·전기전자를 다 품은
 * 상위 집계라서 하위 업종의 합이기 때문이다. 같은 돈을 두 번 세는 셈이라 빼야 한다.
 *
 *   027 / 106 = 제조 (상위 집계)
 *   002~004   = 코스피 규모별
 *   138~151   = 코스닥 규모·스타일 지수 (KOSDAQ 100, 우량기업, 벤처기업 …)
 */
const AGGREGATE_CODES = new Set([
  "027", // 코스피 제조
  "106", // 코스닥 제조
  "138", "139", "140", // KOSDAQ 100 / MID 300 / SMALL
  "142", "143", "144", "145", // 우량 / 벤처 / 중견 / 신성장
  "150", "151", // KOSDAQ 150 / 글로벌지수
]);

function toNum(v: unknown): number {
  const n = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function bare(code: unknown): string {
  return String(code ?? "").replace(/_AL$/, "").trim();
}

// ---------------------------------------------------------------- 저장소

async function readAll(): Promise<SectorFlowDay[]> {
  try {
    const parsed = JSON.parse(await readFile(FILE, "utf-8")) as SectorFlowDay[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** 2년치면 충분하다. 그보다 오래된 수급은 지금 시장을 읽는 데 안 쓴다 */
const KEEP_DAYS = 500;

async function writeAll(rows: SectorFlowDay[]): Promise<void> {
  rows.sort((a, b) => a.date.localeCompare(b.date));
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(rows.slice(-KEEP_DAYS)), "utf-8");
}

export async function listSectorFlow(days?: number): Promise<SectorFlowDay[]> {
  const rows = await readAll();
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return days && days > 0 ? rows.slice(-days) : rows;
}

// ---------------------------------------------------------------- 수집

interface Row {
  [k: string]: unknown;
}

async function fetchDay(client: KiwoomClient, market: Market, yyyymmdd: string): Promise<SectorFlowRow[]> {
  const { data } = await client.request<Row>(SECT_RESOURCE, "ka10051", {
    mrkt_tp: market === "kospi" ? "0" : "1",
    amt_qty_tp: "0",
    base_dt: yyyymmdd,
    stex_tp: "3",
  });
  const rows = Array.isArray(data.inds_netprps) ? (data.inds_netprps as Row[]) : [];
  return rows.map((r) => ({
    code: bare(r.inds_cd),
    name: String(r.inds_nm ?? "").trim(),
    changeRate: toNum(r.flu_rt),
    v: SUBJECTS.map((s) => toNum(r[FIELD_OF[s]])),
  }));
}

/** 종합 행의 숫자들 — 휴장일 판별용 지문 */
function fingerprint(day: SectorFlowDay): string {
  const total = day.kospi.find((r) => TOTAL_CODES.has(r.code));
  return total ? `${total.changeRate}|${total.v.join(",")}` : "";
}

/**
 * 아직 거래가 없는 날인가.
 *
 * 장 시작 전에 오늘 날짜로 조회하면 모든 수치가 0으로 온다. 그걸 하루치로 저장하면
 * 5일 누적이 0 하나로 희석되고, "마지막 날이 0이면 연속 아님"이라 연속 지표가 통째로 사라진다.
 * 실제로 07시대에 스케줄러가 0짜리 하루를 남겨 지표가 다 비었다.
 */
/**
 * 이 하루를 남기면 안 되는가.
 *
 * ## 왜 「전부 0」만으로는 부족한가 (2026-08-20 확인)
 *
 * 장 시작 전이나 장 초반에 오늘을 조회하면 **전부 0 이 아니라 잡음이 온다** —
 * 실측에서 「등락률 0, 외국인 +872억」 같은 값이 나왔고, 그게 그대로 저장됐다.
 * 그날의 진짜 값은 「등락률 −5.80%, 외국인 −38,298억」이었다.
 *
 * 더 나쁜 건 **휴장일**이다. 키움은 장이 안 선 날짜로 물으면 **가까운 거래일 값**을
 * 준다 — 8/14(휴장)로 물었더니 8/17 값이 왔고, 그게 8/14 로 저장됐다.
 *
 * 그래서 두 가지를 더 본다.
 *   · 종합 등락률이 정확히 0 이면서 순매수가 미미하면 → **미완성 캡처**
 *   · (휴장일은 여기서 못 거른다. 아래 지문 비교가 잡는다)
 */
function hasNoTrading(day: SectorFlowDay): boolean {
  const total = day.kospi.find((r) => TOTAL_CODES.has(r.code));
  if (!total) return true;
  if (total.v.every((n) => n === 0)) return true;
  /*
   * 등락률이 0 인데 수급이 몇백억뿐이면 장이 돌기 전에 찍힌 것이다.
   * 실제 거래일이라면 종합 등락률이 0.00% 이면서 수급만 도는 일은 사실상 없다.
   */
  const scale = Math.max(...total.v.map((n) => Math.abs(n)));
  return total.changeRate === 0 && scale < 5000;
}

/**
 * 오늘을 수집해도 되는 시각인가.
 *
 * **장이 끝나기 전에 오늘을 저장하면 안 된다.** 진행 중인 값이 그날의 최종값으로
 * 굳어 버리고, 다음날 다시 받지도 않는다(이미 있는 날짜는 건너뛰므로).
 * 실측에서 8/20 자리에 8/19 값이 들어가 있던 게 이것이다.
 */
function todaySettled(): boolean {
  const now = new Date();
  const mins = now.getHours() * 60 + now.getMinutes();
  // 15:30 장 마감 + 집계 여유 10분
  return mins >= 15 * 60 + 40;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

function dashed(yyyymmdd: string): string {
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`;
}

/**
 * 과거분을 채운다.
 *
 * 거래일 달력이 없으므로 평일만 훑고, **휴장일은 응답으로 걸러낸다** —
 * 키움은 휴장일에 직전 거래일 값을 그대로 주므로, 바로 앞 거래일과 종합 행 수치가
 * 똑같으면 그날은 장이 안 선 것으로 보고 버린다. 서로 다른 두 거래일의 수급이
 * 소수점까지 일치하는 일은 없다.
 *
 * 초당 5회 제한이 있어 2시장 × N일을 5개씩 끊어 부른다.
 */
export async function backfillSectorFlow(
  client: KiwoomClient,
  days = 60,
): Promise<{ added: number; skipped: number; total: number; refilled: number }> {
  const existing = await readAll();
  const have = new Set(existing.map((r) => r.date));

  /*
   * ## **칸이 모자란 날은 이미 있어도 다시 받는다** (2026-09-03)
   *
   * 벤티지: "시황대시보드에서 코스피 코스닥 눌렀을때 수급합산에 기타법인이나 보험 은행
   * 얘네들은 집계 안된다."
   *
   * 원인은 두 겹이었다. ① 저장 스키마(`SUBJECTS`)가 일곱뿐이다가 2026-08-31 에 다섯을
   * 뒤에 붙였다 — 그 전 날짜는 `v` 가 짧아 읽는 쪽이 「모름(null)」으로 적는다. ② 그런데
   * 이 함수가 **이미 있는 날짜를 통째로 건너뛰어서**(`!have.has(...)`) 옛 행이 영영 일곱
   * 칸으로 남았다. 실측(09-03 코스피): 70일 중 67일이 다섯 주체 null → 5·10·20·60일
   * 합산이 전부 「-」.
   *
   * `ka10051` 은 `base_dt` 로 과거를 그대로 준다(이 파일 머리 주석). 그러니 **칸이 모자란
   * 날만 다시 받으면** 되채워진다. 조회는 그 날짜들에만 든다 — 한 번 채우면 끝이다.
   */
  const short = new Set(
    existing
      .filter((d) =>
        [...d.kospi, ...d.kosdaq].some((r) => (r.v?.length ?? 0) < SUBJECTS.length),
      )
      .map((r) => r.date),
  );

  /*
   * 오늘부터 거꾸로 평일만 모은다.
   * **오늘은 장이 끝난 뒤에만** 넣는다 — 진행 중인 값을 최종값으로 굳히면
   * 다음날 다시 받지도 않아서 영영 틀린 채로 남는다.
   */
  const targets: string[] = [];
  const cursor = new Date();
  const skipToday = !todaySettled();
  const todayYmd = ymd(new Date());
  while (targets.length < days) {
    const day = cursor.getDay();
    const d = ymd(cursor);
    if (day !== 0 && day !== 6 && !(skipToday && d === todayYmd)) targets.push(d);
    cursor.setDate(cursor.getDate() - 1);
  }

  const fetched: SectorFlowDay[] = [];
  for (let i = 0; i < targets.length; i += 5) {
    /*
     * ⚠️ **오늘은 이미 있어도 다시 받는다** (2026-08-31).
     *
     * 저장은 15:40(마감 + 집계 여유 10분)에 한 번 하고, 이미 있는 날짜는 건너뛴다.
     * 그런데 **거래소가 그 뒤에 집계를 정정한다.** 실측(8/28 코스피 외국인):
     *
     *   15:40 저장분   -20,556억
     *   16:01 재조회   -20,732억   ← 176억 차이
     *
     * 그래서 리포트의 「투자자 순매수」(당일 조회)와 「시장 신호등」(저장분)이
     * 같은 값을 다르게 적었다. 신호등의 **5일 수급 누적**도 그만큼 이른 값을 쓴다.
     *
     * 오늘 하루만 덮어쓴다 — 과거 날짜는 이미 확정이라 다시 받을 이유가 없고,
     * 다시 받으면 조회만 늘어난다.
     */
    const chunk = targets
      .slice(i, i + 5)
      /* 없는 날 · 오늘(정정분) · **칸이 모자란 날**(위 주석) */
      .filter((d) => !have.has(dashed(d)) || d === todayYmd || short.has(dashed(d)));
    if (chunk.length > 0) {
      const results = await Promise.all(
        chunk.map(async (d) => {
          try {
            const [kospi, kosdaq] = await Promise.all([
              fetchDay(client, "kospi", d),
              fetchDay(client, "kosdaq", d),
            ]);
            const day = { date: dashed(d), kospi, kosdaq };
            // 장 시작 전에 오늘을 조회하면 전부 0으로 온다 — 그런 하루는 남기지 않는다
            return kospi.length > 0 && !hasNoTrading(day) ? day : null;
          } catch {
            return null;
          }
        }),
      );
      for (const r of results) if (r) fetched.push(r);
    }
    if (i + 5 < targets.length) await new Promise((r) => setTimeout(r, 1100));
  }

  /*
   * 휴장일 제거 — 지문이 같은 이웃 날짜는 하나만 남긴다.
   *
   * ⚠️ **뒤에 있는 날짜를 남겨야 한다.** 키움은 장이 안 선 날짜로 물으면
   * **가까운 다음 거래일 값**을 준다. 그래서 (8/14 휴장, 8/17 거래일) 쌍이 생기면
   * 둘의 지문이 같은데, **진짜는 8/17** 이다.
   *
   * 예전엔 앞의 것을 남겨서 8/14 가 살아남고 **8/17 이 사라졌다.**
   * 그러면 달력에 없는 날의 수급이 기록되고 실제 거래일은 통째로 빈다.
   */
  /*
   * 같은 날짜가 둘이면 **나중에 받은 것**이 이긴다 — 위에서 오늘을 다시 받으므로
   * 정정된 값이 옛 값을 덮어야 한다.
   */
  const byDate = new Map(existing.map((r) => [r.date, r]));
  for (const r of fetched) byDate.set(r.date, r);
  const merged = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const kept: SectorFlowDay[] = [];
  let skipped = 0;
  for (const day of merged) {
    // 예전에 저장해 둔 0짜리·미완성 하루도 이참에 걷어낸다
    if (hasNoTrading(day)) {
      skipped += 1;
      continue;
    }
    const fp = fingerprint(day);
    const last = kept[kept.length - 1];
    if (fp && last && fingerprint(last) === fp) {
      // 같은 지문이면 **앞의 것을 버리고 뒤의 것(진짜 거래일)을 남긴다**
      kept.pop();
      skipped += 1;
    }
    kept.push(day);
  }

  await writeAll(kept);
  // 새로 받아 남은 것만 "추가"로 센다. 기존 오염분을 걷어내면 총 일수가 줄 수도 있어서
  // 단순히 전후 개수를 빼면 음수가 나온다.
  const keptDates = new Set(kept.map((d) => d.date));
  const added = fetched.filter((d) => keptDates.has(d.date) && !have.has(d.date)).length;
  /* 이미 있던 날인데 칸이 모자라 다시 받아 채운 것 — 「새로 추가」와 뜻이 다르다 */
  const refilled = fetched.filter((d) => keptDates.has(d.date) && short.has(d.date)).length;
  return { added, skipped, total: kept.length, refilled };
}

/**
 * 오늘치 한 줄. 스케줄러가 부른다.
 *
 * ⚠️ **3일만 본다** — 되채우기(칸 모자란 옛 날짜)는 여기서 안 한다. 매일 60일을 훑으면
 * 조회가 늘고, 한 번 채우면 끝나는 일이다. 손으로 「과거분 채우기」를 부르거나 마감 뒤
 * 정리가 한 번 돌리면 된다(`/api/overview/sector-flow/backfill`).
 */
export async function captureSectorFlow(client: KiwoomClient): Promise<{ saved: boolean; reason?: string }> {
  /*
   * 칸이 모자란 옛 날짜가 남아 있으면 **이번 한 번만** 70일을 훑어 되채운다 — 미니PC 는
   * 데이터 파일이 따로라 개발PC 에서 돌린 되채우기가 안 닿는다. 다 채워지면 다시 3일로.
   */
  const existing = await readAll();
  const hasShort = existing.some((d) =>
    [...d.kospi, ...d.kosdaq].some((r) => (r.v?.length ?? 0) < SUBJECTS.length),
  );
  const res = await backfillSectorFlow(client, hasShort ? 70 : 3);
  return res.added > 0 || res.refilled > 0
    ? { saved: true }
    : { saved: false, reason: "새로 채울 거래일 없음" };
}

// ---------------------------------------------------------------- 파생 지표

/**
 * 순수 업종 행만. 종합·규모별·상위집계를 걷어낸다.
 *
 * 코스피와 코스닥에 같은 이름의 업종이 따로 있으므로(전기/전자 013 vs 124)
 * 시장을 붙여 구분한다 — 안 그러면 화면에 "전기/전자"가 두 줄 나와서 어느 쪽인지 모른다.
 */
function sectorsOf(day: SectorFlowDay): (SectorFlowRow & { market: Market; label: string })[] {
  const pick = (rows: SectorFlowRow[], market: Market) =>
    rows
      .filter((r) => r.name && !TOTAL_CODES.has(r.code) && !SIZE_CODES.has(r.code) && !AGGREGATE_CODES.has(r.code))
      .map((r) => ({ ...r, market, label: `${market === "kospi" ? "코스피" : "코스닥"} ${r.name}` }));
  return [...pick(day.kospi, "kospi"), ...pick(day.kosdaq, "kosdaq")];
}

function valueOf(row: SectorFlowRow, subject: Subject): number {
  return row.v[SUBJECTS.indexOf(subject)] ?? 0;
}

export interface SectorFlowStat {
  code: string;
  /** 업종명 */
  name: string;
  /** "코스피 전기/전자" — 시장까지 붙인 표시용 이름 */
  label: string;
  market: Market;
  /** 기간 누적 순매수(억원) */
  sum: number;
  /** 마지막 날 순매수 */
  today: number;
  /** 직전일 대비 증감 — 자금이 이 업종으로 더 들어왔는지 */
  delta: number;
  /** 기간 누적 기준 순위 (1이 가장 많이 산 업종) */
  rank: number;
  /** 직전 기간 대비 순위 변화. + 면 올라온 것 */
  rankChange: number | null;
}

/**
 * 업종별 자금 히트맵.
 *
 * 하루치는 노이즈가 많아서 기본 5일 누적으로 본다.
 * 순위 변화를 같이 내는 이유는, **절대 금액보다 순위가 바뀌는 게 로테이션의 신호**이기 때문이다.
 */
export function sectorFlowStats(
  days: SectorFlowDay[],
  subject: Subject = "foreign",
  window = 5,
): SectorFlowStat[] {
  if (days.length === 0) return [];
  const recent = days.slice(-window);
  const prior = days.slice(-window * 2, -window);

  const acc = new Map<
    string,
    { name: string; label: string; market: Market; sum: number; today: number; prev: number }
  >();
  for (const day of recent) {
    const isLast = day === recent[recent.length - 1];
    for (const row of sectorsOf(day)) {
      const cur =
        acc.get(row.code) ??
        { name: row.name, label: row.label, market: row.market, sum: 0, today: 0, prev: 0 };
      cur.sum += valueOf(row, subject);
      if (isLast) cur.today = valueOf(row, subject);
      acc.set(row.code, cur);
    }
  }
  // 직전일 값 (delta 계산용)
  if (recent.length >= 2) {
    for (const row of sectorsOf(recent[recent.length - 2])) {
      const cur = acc.get(row.code);
      if (cur) cur.prev = valueOf(row, subject);
    }
  }

  const priorRank = new Map<string, number>();
  if (prior.length > 0) {
    const priorSum = new Map<string, number>();
    for (const day of prior) {
      for (const row of sectorsOf(day)) {
        priorSum.set(row.code, (priorSum.get(row.code) ?? 0) + valueOf(row, subject));
      }
    }
    [...priorSum.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([code], i) => priorRank.set(code, i + 1));
  }

  return [...acc.entries()]
    .map(([code, x]) => ({
      code,
      name: x.name,
      label: x.label,
      market: x.market,
      sum: x.sum,
      today: x.today,
      delta: x.today - x.prev,
    }))
    .sort((a, b) => b.sum - a.sum)
    .map((x, i) => {
      const before = priorRank.get(x.code);
      return {
        ...x,
        rank: i + 1,
        // 순위는 작을수록 위 — 5위에서 2위로 가면 +3
        rankChange: before === undefined ? null : before - (i + 1),
      };
    });
}

export interface SectorStreak {
  code: string;
  name: string;
  label: string;
  market: Market;
  /** 연속 일수. 양수면 연속 순매수, 음수면 연속 순매도 */
  streak: number;
  sum: number;
}

/**
 * 업종별 연속 순매수/순매도.
 * 하루치 순매수는 노이즈지만 **며칠 연속인지는 신호**다.
 */
export function sectorStreaks(days: SectorFlowDay[], subject: Subject = "foreign"): SectorStreak[] {
  if (days.length === 0) return [];
  const byCode = new Map<string, { name: string; label: string; market: Market; series: number[] }>();
  for (const day of days) {
    for (const row of sectorsOf(day)) {
      const cur = byCode.get(row.code) ?? { name: row.name, label: row.label, market: row.market, series: [] };
      cur.series.push(valueOf(row, subject));
      byCode.set(row.code, cur);
    }
  }

  const out: SectorStreak[] = [];
  for (const [code, { name, label, market, series }] of byCode) {
    const last = series[series.length - 1] ?? 0;
    if (last === 0) continue;
    const sign = Math.sign(last);
    let streak = 0;
    let sum = 0;
    for (let i = series.length - 1; i >= 0; i -= 1) {
      if (Math.sign(series[i]) !== sign) break;
      streak += 1;
      sum += series[i];
    }
    out.push({ code, name, label, market, streak: streak * sign, sum });
  }
  return out.sort((a, b) => Math.abs(b.streak) - Math.abs(a.streak) || Math.abs(b.sum) - Math.abs(a.sum));
}

export interface SectorConsensus {
  code: string;
  name: string;
  label: string;
  market: Market;
  /** 주체별 기간 누적 (SUBJECTS 순서) */
  values: number[];
  /** 같은 방향으로 움직인 주체 수 */
  agree: number;
  /** +1 이면 다 같이 샀고, -1 이면 다 같이 팔았다 */
  side: 1 | -1;
  /** 합의한 주체들의 순매수 합계 */
  total: number;
}

/**
 * 여러 주체가 **같은 방향으로** 움직인 업종.
 *
 * 외국인만 사는 것과, 외국인·기관·연기금이 같이 사는 것은 무게가 다르다.
 * 한 주체는 하루아침에 방향을 바꿀 수 있지만 셋이 동시에 같은 곳을 보고 있다면
 * 그건 개별 판단이 아니라 흐름에 가깝다.
 *
 * 개인은 뺀다. 기관·외국인이 사면 개인은 자동으로 파는 쪽이 되므로
 * 같이 넣으면 "합의"라는 말이 성립하지 않는다.
 */
const CONSENSUS_SUBJECTS: Subject[] = ["foreign", "institution", "pension", "trust", "private"];

export function sectorConsensus(
  days: SectorFlowDay[],
  opts: { window?: number; minAgree?: number; side?: 1 | -1 } = {},
): SectorConsensus[] {
  const { window = 5, minAgree = 3, side } = opts;
  const recent = days.slice(-window);
  if (recent.length === 0) return [];

  const acc = new Map<string, { name: string; label: string; market: Market; sums: number[] }>();
  for (const day of recent) {
    for (const row of sectorsOf(day)) {
      const cur =
        acc.get(row.code) ??
        { name: row.name, label: row.label, market: row.market, sums: CONSENSUS_SUBJECTS.map(() => 0) };
      CONSENSUS_SUBJECTS.forEach((s, i) => {
        cur.sums[i] += valueOf(row, s);
      });
      acc.set(row.code, cur);
    }
  }

  const out: SectorConsensus[] = [];
  for (const [code, x] of acc) {
    const buys = x.sums.filter((v) => v > 0).length;
    const sells = x.sums.filter((v) => v < 0).length;
    // 매수 합의와 매도 합의 중 더 강한 쪽으로 판정한다
    const dir: 1 | -1 = buys >= sells ? 1 : -1;
    const agree = dir === 1 ? buys : sells;
    if (agree < minAgree) continue;
    if (side && dir !== side) continue;

    const total = x.sums.filter((v) => (dir === 1 ? v > 0 : v < 0)).reduce((a, b) => a + b, 0);
    out.push({ code, name: x.name, label: x.label, market: x.market, values: x.sums, agree, side: dir, total });
  }

  // 합의 주체가 많은 순 → 금액이 큰 순
  return out.sort((a, b) => b.agree - a.agree || Math.abs(b.total) - Math.abs(a.total));
}

/** 화면·리포트에서 쓸 주체 순서와 이름 */
export const CONSENSUS_LABELS = CONSENSUS_SUBJECTS.map((s) => ({ key: s, label: SUBJECT_LABEL[s] }));

export interface SectorSplit {
  code: string;
  name: string;
  label: string;
  market: Market;
  pension: number;
  trust: number;
}

/**
 * 연기금과 투신이 반대로 움직인 업종.
 *
 * 둘 다 기관이지만 성격이 다르다 — 연기금은 길게 보고 담고, 투신은 성과에 쫓겨 짧게 돈다.
 * 방향이 갈리는 구간은 기관 안에서도 판단이 엇갈린다는 뜻이라 변곡 후보로 볼 만하다.
 * 하루치로 보면 우연이 많아 기본 5일 누적으로 판정한다.
 */
export function institutionSplits(days: SectorFlowDay[], window = 5): SectorSplit[] {
  const recent = days.slice(-window);
  if (recent.length === 0) return [];
  const acc = new Map<string, SectorSplit>();
  for (const day of recent) {
    for (const row of sectorsOf(day)) {
      const cur =
        acc.get(row.code) ??
        { code: row.code, name: row.name, label: row.label, market: row.market, pension: 0, trust: 0 };
      cur.pension += valueOf(row, "pension");
      cur.trust += valueOf(row, "trust");
      acc.set(row.code, cur);
    }
  }
  return [...acc.values()]
    .filter((x) => Math.sign(x.pension) !== Math.sign(x.trust) && x.pension !== 0 && x.trust !== 0)
    .sort((a, b) => Math.abs(b.pension - b.trust) - Math.abs(a.pension - a.trust));
}

export interface SizeFlow {
  label: string;
  foreign: number;
  institution: number;
}

/**
 * 대형/중형/소형 자금 배분.
 * ka10051이 규모별 행(002/003/004)을 같이 주므로 공짜로 얻는다.
 * 대형주에서 중소형으로 옮겨가는 구간은 장의 성격이 바뀌는 지점이다.
 */
export function sizeRotation(days: SectorFlowDay[], window = 5): SizeFlow[] {
  const recent = days.slice(-window);
  const labels: Record<string, string> = { "002": "대형주", "003": "중형주", "004": "소형주" };
  const acc = new Map<string, SizeFlow>();
  for (const day of recent) {
    for (const row of day.kospi) {
      if (!SIZE_CODES.has(row.code)) continue;
      const cur = acc.get(row.code) ?? { label: labels[row.code] ?? row.name, foreign: 0, institution: 0 };
      cur.foreign += valueOf(row, "foreign");
      cur.institution += valueOf(row, "institution");
      acc.set(row.code, cur);
    }
  }
  return ["002", "003", "004"].map((c) => acc.get(c)).filter((x): x is SizeFlow => Boolean(x));
}

// ---------------------------------------------------------------- 리포트용

function fmt(n: number): string {
  return `${n > 0 ? "+" : ""}${Math.round(n).toLocaleString("ko-KR")}`;
}

/**
 * AI 리포트에 넣을 형태.
 * "외국인 +2.3조" 한 줄보다 **어디서 어디로 옮겼는지**가 판단에 쓰인다.
 */
export function toSectorFlowDigest(days: SectorFlowDay[]): string {
  if (days.length < 2) return "";

  const lines: string[] = ["\n[업종별 자금 흐름 — 최근 5일 누적, 단위 억원]"];

  const foreign = sectorFlowStats(days, "foreign", 5);
  const top = foreign.slice(0, 5);
  const bottom = foreign.slice(-5).reverse();

  const arrow = (c: number | null) => (c === null || c === 0 ? "" : c > 0 ? ` (순위 ${c}단계↑)` : ` (${-c}단계↓)`);

  lines.push(`외국인 순매수 상위: ${top.map((s) => `${s.label} ${fmt(s.sum)}${arrow(s.rankChange)}`).join(", ")}`);
  lines.push(`외국인 순매도 상위: ${bottom.map((s) => `${s.label} ${fmt(s.sum)}`).join(", ")}`);

  const streaks = sectorStreaks(days, "foreign").filter((s) => Math.abs(s.streak) >= 3).slice(0, 5);
  if (streaks.length > 0) {
    lines.push(
      `외국인 연속: ${streaks
        .map((s) => `${s.label} ${Math.abs(s.streak)}일 연속 ${s.streak > 0 ? "순매수" : "순매도"}(${fmt(s.sum)})`)
        .join(", ")}`,
    );
  }

  /*
   * 여러 주체가 같은 방향으로 움직인 업종.
   * "외국인이 샀다"보다 "외국인·기관·연기금이 같이 샀다"가 훨씬 무거운 정보다.
   */
  const buy = sectorConsensus(days, { window: 5, minAgree: 3, side: 1 }).slice(0, 4);
  const sell = sectorConsensus(days, { window: 5, minAgree: 3, side: -1 }).slice(0, 3);
  if (buy.length > 0) {
    lines.push(
      `주체 합의 매수(개인 제외): ${buy.map((c) => `${c.label} ${c.agree}개 주체 ${fmt(c.total)}`).join(", ")}`,
    );
  }
  if (sell.length > 0) {
    lines.push(
      `주체 합의 매도: ${sell.map((c) => `${c.label} ${c.agree}개 주체 ${fmt(c.total)}`).join(", ")}`,
    );
  }

  const splits = institutionSplits(days).slice(0, 3);
  if (splits.length > 0) {
    lines.push(
      `기관 내부 이견(연기금 vs 투신): ${splits
        .map((s) => `${s.label} 연기금 ${fmt(s.pension)} / 투신 ${fmt(s.trust)}`)
        .join(", ")} — 방향이 갈리는 업종은 변곡 후보로만 보고 단정하지 말 것`,
    );
  }

  const sizes = sizeRotation(days);
  if (sizes.length > 0) {
    lines.push(`규모별 외국인: ${sizes.map((s) => `${s.label} ${fmt(s.foreign)}`).join(", ")}`);
  }

  return lines.join("\n");
}
