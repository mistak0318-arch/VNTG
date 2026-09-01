import { mkdir, readFile, readdir, writeFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **종목별 일별 원장** (2026-09-01) — 전종목이 매일 받는 모든 것을 한 곳에.
 *
 * 벤티지: "지금 로직상에 수집하는 모든것 전종목 기준으로 데이터 다 받아."
 * "어차피 표본데이터이고 전부 가지고 있으면 그만큼 신호등 체계로 더 세분화하고
 * 정교하게 만들 수 있어."
 *
 * ## 왜 이게 필요한가
 *
 * 여태 이 값들은 **필요할 때 그 자리에서 부르고 버렸다.**
 *
 *   · 종목 상세의 일별 수급 그래프 → 눌러야 뜬다 (매번 새로 부른다)
 *   · 표본(`signalSamples`) → 500종목만, 재수집하면 40~60분
 *   · 검증이 막힌 기준 셋(목표가·대차·지분율) → 되짚기가 짧아 표본의 3~16%
 *
 * 셋 다 같은 병이다 — **안 쌓았으니 과거가 없다.** 매일 받아 두면 하루 지날 때마다
 * 하루씩 자란다. 표본은 조회 0회가 되고, 상세 화면은 즉시 뜨고, 되짚기가 짧아
 * 못 재던 기준은 시간이 해결한다.
 *
 * ## 왜 종목별 파일인가
 *
 * 한 파일에 다 담으면 2년치가 850MB, 5년치가 2.1GB 다(관측당 698바이트 실측
 * 기준). 종목 상세가 한 종목을 보려고 **2GB 를 파싱**하게 된다.
 *
 * 종목별로 나누면 상세 화면은 자기 파일(수백 KB) 하나만 읽는다. 전종목 순회는
 * 표본 만들 때뿐이고 그건 느려도 된다.
 *
 * 전종목이 **동시에** 필요한 것(장세 판정·테마·ETF)은 `dailyCloses.json` 이
 * 종가만 뽑아 5MB 로 들고 있다 — 그건 그대로 둔다.
 *
 * ## 보관
 *
 * 벤티지: "최대 2년치로 설정하고 2년 되는날 나한테 알려줘 리셋할건지 백업할건지."
 * "더 늘릴수도 있게끔." "아니면 최대 5년치 약 100기가 정도로 두고 5년 지나면
 * 앞에것부터 지워나가는 로직으로 해도 되겠다."
 *
 * 둘 다 한다 — **한도에 닿으면 알리고**, 넘으면 **앞에서부터 지운다.** 다만
 * 자동 삭제는 켜고 끌 수 있고 **기본은 켜져 있지 않다**: 지운 데이터는 다시
 * 받을 수 없다(키움이 과거 수급을 100일치만 준다). 알림을 먼저 보고 사람이
 * 정하는 편이 맞다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DIR = join(here, "..", "data", "daily");

/** 하루치 봉 — `dailyCloses.DayBar` 와 같은 모양 */
export interface BarRow {
  d: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/**
 * 하루치 투자자별 순매수 — **열세 주체를 다 담는다.**
 *
 * 예전 표본은 외국인·기관과 「주포 셋의 합」만 들고 있었다. 그래서 「보험이
 * 사는 종목이 좋은가」 같은 물음에 아예 답할 수가 없었다 — 값을 안 남겼으니까.
 * 같은 응답에 다 들어 있는데 골라서 버린 것이다.
 *
 * 단위는 **백만원**(`amt_qty_tp:"1"`, `unit_tp:"1000"`).
 */
export interface FlowRow {
  d: string;
  /** 개인 */
  ind: number | null;
  /** 외국인 */
  fgn: number | null;
  /** 기관계 */
  org: number | null;
  /** 금융투자(증권사) */
  fin: number | null;
  /** 보험 */
  ins: number | null;
  /** 투신 */
  trust: number | null;
  /** 은행 */
  bank: number | null;
  /** 연기금등 */
  pen: number | null;
  /** 사모펀드 */
  samo: number | null;
  /** 국가 */
  natn: number | null;
  /** 기타법인 */
  corp: number | null;
  /** 기타외국인 */
  natfor: number | null;
  /** 종합금융·기타금융 */
  etcFin: number | null;
}

export interface ShortRow {
  d: string;
  /** 공매도 수량 */
  qty: number | null;
  /** 거래대금 대비 공매도 비중(%) */
  ratio: number | null;
}

export interface LoanRow {
  d: string;
  /** 대차 잔고 수량 */
  rmnd: number | null;
}

export interface RatioRow {
  d: string;
  /** 외국인 지분율(%) */
  ratio: number | null;
}

export interface ProgRow {
  d: string;
  /** 프로그램 순매수(백만원) */
  net: number | null;
}

/**
 * 한 종목의 원장.
 *
 * 칸이 비어 있는 것과 `null` 로 채워진 것은 뜻이 다르다 — **없으면 배열이 없고**,
 * 그날 값을 못 받았으면 그 줄의 칸이 `null` 이다. 「안 받았다」와 「받았는데
 * 값이 없다」를 구분해야 나중에 다시 받을지 판단할 수 있다.
 */
export interface DailyLedger {
  code: string;
  /** 마지막으로 손댄 때 */
  updatedAt: string;
  /** 종류별 마지막 수집 시각 — 무엇이 낡았는지 알아야 다시 받는다 */
  fetchedAt?: Partial<Record<LedgerKind, string>>;
  bars?: BarRow[];
  flow?: FlowRow[];
  short?: ShortRow[];
  loan?: LoanRow[];
  fgnRatio?: RatioRow[];
  prog?: ProgRow[];
}

export type LedgerKind = "bars" | "flow" | "short" | "loan" | "fgnRatio" | "prog";

export const LEDGER_KINDS: LedgerKind[] = ["bars", "flow", "short", "loan", "fgnRatio", "prog"];

export const KIND_LABEL: Record<LedgerKind, string> = {
  bars: "일봉",
  flow: "투자자별 수급",
  short: "공매도",
  loan: "대차잔고",
  fgnRatio: "외국인 지분율",
  prog: "프로그램",
};

/* ------------------------------------------------------------------ */
/* 보관 정책                                                            */
/* ------------------------------------------------------------------ */

/** 기본 2년(거래일). 벤티지가 처음 고른 값 */
export const KEEP_DEFAULT = 500;
/** 최대 5년 — 그 이상은 안 받는다. 늘리려면 여기를 고쳐야 한다 */
export const KEEP_MAX = 1300;

export function keepDays(): number {
  const raw = Number(process.env.VNTG_DAILY_KEEP);
  if (!Number.isFinite(raw) || raw <= 0) return KEEP_DEFAULT;
  return Math.min(Math.round(raw), KEEP_MAX);
}

/**
 * 한도를 넘으면 **앞에서부터 지울까.**
 *
 * ⚠️ 기본은 **꺼져 있다.** 지운 데이터는 다시 받을 수 없다 — 키움은 과거 수급을
 * 100일치쯤만 준다. 「2년 되는 날 알려줘, 리셋할지 백업할지」가 벤티지의 첫 말이라,
 * **알림이 먼저고 삭제는 사람이 켜는 것**으로 둔다.
 */
export function autoTrim(): boolean {
  return process.env.VNTG_DAILY_TRIM === "1";
}

/* ------------------------------------------------------------------ */
/* 읽기·쓰기                                                            */
/* ------------------------------------------------------------------ */

function fileOf(code: string): string {
  return join(DIR, `${code}.json`);
}

/** 종목 하나의 원장. 없으면 빈 원장 */
export async function loadLedger(code: string): Promise<DailyLedger> {
  try {
    const raw = JSON.parse(await readFile(fileOf(code), "utf-8")) as DailyLedger;
    return { ...raw, code };
  } catch {
    return { code, updatedAt: "" };
  }
}

export async function saveLedger(l: DailyLedger): Promise<void> {
  await mkdir(DIR, { recursive: true });
  await writeFile(fileOf(l.code), JSON.stringify(l), "utf-8");
}

/**
 * 날짜 있는 줄들을 **이어 붙인다** — 이 함수가 「몇 년치」의 핵심이다.
 *
 * ⚠️ 갈아치우면 보관 일수를 늘려도 과거가 안 자란다. 한 응답이 주는 만큼(수급은
 * 100일, 일봉은 400봉)에서 멈춘다. 옛 줄을 남기고 겹치는 날짜만 새 값으로
 * 덮으면 하루하루 뒤로 자란다.
 *
 * 겹치는 날은 **새 값이 이긴다.** 수정주가라 액면분할이 있으면 과거가 통째로
 * 다시 계산돼 오는데, 옛 값을 남기면 그 종목만 눈금이 어긋난다.
 *
 * `keep` 이 0 이면 안 자른다 — 자동 삭제가 꺼져 있을 때 쓴다.
 */
export function mergeRows<T extends { d: string }>(oldRows: T[], got: T[], keep: number): T[] {
  const by = new Map<string, T>();
  for (const r of oldRows) if (r.d) by.set(r.d, r);
  for (const r of got) if (r.d) by.set(r.d, r);
  const all = [...by.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  return keep > 0 ? all.slice(-keep) : all;
}

/* ------------------------------------------------------------------ */
/* 현황 — 얼마나 쌓였나 · 한도에 얼마나 왔나                             */
/* ------------------------------------------------------------------ */

export interface LedgerStatus {
  /** 원장이 있는 종목 수 */
  codes: number;
  /** 파일 크기 합(바이트) */
  bytes: number;
  /** 가장 긴 원장이 며칠치인가 */
  maxDays: number;
  /** 종목별 일수의 중앙값 — 「대부분 며칠치인가」 */
  medDays: number;
  /** 가장 오래된 날짜 · 가장 최근 날짜 */
  from: string;
  to: string;
  /** 지금 보관 한도(거래일) */
  keep: number;
  /** 한도까지 몇 % 왔나 */
  fullPct: number;
  /** 자동 삭제가 켜져 있나 */
  trim: boolean;
  /**
   * **한도에 닿았다** — 사람이 정해야 한다(리셋할지 백업할지 늘릴지).
   *
   * 벤티지: "2년 되는날 나한테 알려줘 리셋할건지 백업할건지 말야."
   */
  atLimit: boolean;
}

/**
 * 얼마나 쌓였나.
 *
 * ⚠️ 파일을 다 열면 느리다(2,400개). **크기는 `stat` 으로**, 일수는 **표본 200개**만
 * 열어서 잰다 — 「대충 며칠치인가」에 답하는 데 전수가 필요하지 않다.
 */
export async function ledgerStatus(): Promise<LedgerStatus> {
  const keep = keepDays();
  let codes = 0;
  let bytes = 0;
  const days: number[] = [];
  let from = "";
  let to = "";

  let names: string[] = [];
  try {
    names = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    names = [];
  }
  codes = names.length;

  for (const f of names) {
    try {
      bytes += (await stat(join(DIR, f))).size;
    } catch {
      /* 지워졌으면 그냥 건너뛴다 */
    }
  }

  /* 표본만 연다 — 고르게 뽑으려고 일정 간격으로 집는다 */
  const step = Math.max(1, Math.floor(names.length / 200));
  for (let i = 0; i < names.length; i += step) {
    try {
      const l = JSON.parse(await readFile(join(DIR, names[i]), "utf-8")) as DailyLedger;
      /*
       * **가장 긴 줄로 잰다.** 처음엔 `bars` 로 쟀는데 이 원장에는 일봉이 없다 —
       * 일봉은 `dailyCloses` 가 전종목을 따로 들고 있어서 여기서 또 받지 않기
       * 때문이다. 그래서 현황이 늘 0 이었다. 「며칠치가 쌓였나」는 이 원장이
       * 실제로 담는 것 중 가장 긴 것으로 봐야 한다.
       */
      const b = ([l.flow, l.short, l.loan, l.fgnRatio, l.prog, l.bars] as ({ d: string }[] | undefined)[])
        .filter((x): x is { d: string }[] => Array.isArray(x) && x.length > 0)
        .sort((x, y) => y.length - x.length)[0];
      if (!b || b.length === 0) continue;
      days.push(b.length);
      const f0 = b[0].d;
      const t0 = b[b.length - 1].d;
      if (!from || f0 < from) from = f0;
      if (!to || t0 > to) to = t0;
    } catch {
      /* 깨진 파일 하나 때문에 현황을 못 내면 안 된다 */
    }
  }

  days.sort((a, b) => a - b);
  const maxDays = days.length > 0 ? days[days.length - 1] : 0;
  const medDays = days.length > 0 ? days[Math.floor(days.length / 2)] : 0;

  return {
    codes,
    bytes,
    maxDays,
    medDays,
    from,
    to,
    keep,
    fullPct: keep > 0 ? Math.round((maxDays / keep) * 100) : 0,
    trim: autoTrim(),
    /* 90% 를 넘으면 알린다 — 꽉 찬 뒤에 말하면 이미 지워지고 있다 */
    atLimit: keep > 0 && maxDays >= keep * 0.9,
  };
}

/* ------------------------------------------------------------------ */
/* 원장으로 만드는 순위 — 조회 0회                                       */
/* ------------------------------------------------------------------ */

/**
 * **주체별 N일 순매수 상위** (2026-09-01) — 키움에 없는 순위를 우리가 세운다.
 *
 * 벤티지: "기관 3대장 순매수 상위는 없어? 연속매매 말고 순매수 상위 같은것들
 * 필터 더 없어?"
 *
 * 없었다. 키움 순위 조회의 수급 그룹은 **전부 외국인**이다(연속순매매·한도소진율·
 * 기간별·외국계 창구). 기관은 `ka10065`(장중 투자자별)뿐인데 **장중에만** 값이 온다.
 *
 * 그런데 이제 원장이 전종목 × 주체 열셋 × 일별로 쌓인다. **조회 없이 우리가
 * 세울 수 있다** — 그것도 키움이 안 주는 조합으로:
 *
 *   · 투신 20일 순매수 상위
 *   · 연기금 60일 순매수 상위
 *   · **주포(투신+연기금+사모) 10일** 순매수 상위  ← 키움에 아예 없는 것
 *
 * ⚠️ **원장이 쌓인 만큼만 볼 수 있다.** 첫 수집(오늘 밤) 전에는 빈 목록이고,
 * 60일 순위는 60거래일이 쌓여야 제대로 된다. 부르는 쪽이 그걸 알 수 있게
 * `covered`(며칠치를 실제로 봤나)를 같이 돌려준다.
 */

/** 합산할 주체 */
export type FlowSubject = "fgn" | "org" | "trust" | "pen" | "samo" | "ins" | "bank" | "smart";

export const SUBJECT_LABEL: Record<FlowSubject, string> = {
  fgn: "외국인",
  org: "기관계",
  trust: "투신",
  pen: "연기금",
  samo: "사모펀드",
  ins: "보험",
  bank: "은행",
  smart: "주포 (투신+연기금+사모)",
};

/** 한 줄에서 그 주체의 값 — 「주포」는 셋의 합이다 */
function subjectOf(r: FlowRow, s: FlowSubject): number | null {
  if (s === "smart") {
    const v = [r.trust, r.pen, r.samo].filter((x): x is number => x !== null);
    /* 셋 다 없으면 「모른다」 — 하나라도 있으면 있는 것만 더한다 */
    return v.length === 0 ? null : v.reduce((a, b) => a + b, 0);
  }
  return r[s] ?? null;
}

export interface FlowRankRow {
  code: string;
  /** 그 기간 순매수 합(백만원) */
  net: number;
  /** 실제로 더한 날 수 — 요청한 기간보다 적을 수 있다 */
  days: number;
}

let rankCache: { key: string; at: number; rows: FlowRankRow[]; covered: number } | null = null;
const RANK_TTL_MS = 10 * 60_000;

/**
 * 주체별 N거래일 순매수 상위.
 *
 * ⚠️ 파일 2,400개를 여는 작업이라 **10분 캐시**한다. 하루 한 번 갱신되는
 * 데이터라 그 정도는 충분하다.
 */
export async function flowRank(
  subject: FlowSubject,
  days: number,
  limit = 500,
): Promise<{ rows: FlowRankRow[]; covered: number }> {
  const key = `${subject}:${days}`;
  if (rankCache && rankCache.key === key && Date.now() - rankCache.at < RANK_TTL_MS) {
    return { rows: rankCache.rows.slice(0, limit), covered: rankCache.covered };
  }

  let names: string[] = [];
  try {
    names = (await readdir(DIR)).filter((f) => f.endsWith(".json"));
  } catch {
    return { rows: [], covered: 0 };
  }

  const rows: FlowRankRow[] = [];
  let covered = 0;
  for (const f of names) {
    try {
      const l = JSON.parse(await readFile(join(DIR, f), "utf-8")) as DailyLedger;
      const flow = l.flow ?? [];
      if (flow.length === 0) continue;
      /* 최근 `days` 거래일 — 원장은 옛날 → 최신 순이다 */
      const win = flow.slice(-days);
      const vals = win.map((r) => subjectOf(r, subject)).filter((v): v is number => v !== null);
      if (vals.length === 0) continue;
      covered = Math.max(covered, vals.length);
      rows.push({
        code: l.code,
        net: vals.reduce((a, b) => a + b, 0),
        days: vals.length,
      });
    } catch {
      /* 깨진 파일 하나 때문에 순위를 못 내면 안 된다 */
    }
  }

  rows.sort((a, b) => b.net - a.net);
  rankCache = { key, at: Date.now(), rows, covered };
  return { rows: rows.slice(0, limit), covered };
}
