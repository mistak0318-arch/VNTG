import type { KiwoomClient } from "./kiwoomClient.js";
import { listSectorFlow, SUBJECTS } from "./sectorFlowStore.js";

/**
 * 코스피·코스닥 상세.
 *
 * 대시보드의 지수 카드는 오늘 하루만 말해 준다. 그런데 "지금 이 자리가 어디인가"는
 * **추이를 봐야** 답이 나온다 — 20일선을 뚫고 올라온 것과 고점에서 흘러내리는 중인 것이
 * 같은 +1.2% 로 보인다.
 *
 * 개별 종목에는 이미 일봉·주봉·월봉이 있는데 정작 지수에는 없었다. 거꾸로다.
 *
 * 두 가지를 붙인다.
 *   · **지수 추이** — `ka20006` 업종일봉. 주·월은 일봉을 묶어서 만든다
 *     (키움이 업종 주봉·월봉 TR 을 따로 주지 않는다)
 *   · **일별 수급** — 이미 쌓아 둔 `sectorFlow.json` 에서 종합지수 행만 꺼낸다.
 *     추가 호출이 없다
 */

const CHART = "/api/dostk/chart";

export type IndexRange = "day" | "week" | "month";

export interface IndexCandle {
  /** YYYYMMDD */
  dt: string;
  open: number;
  high: number;
  low: number;
  close: number;
  /**
   * **그날 시장 전체 거래대금(억원).**
   *
   * ⚠️ 오래 「키움이 지수 거래대금을 주는지 모른다」로 남아 있었는데, 원본을 열어 보니
   * `trde_prica` 가 그냥 들어 있었다(2026-08-25 확인). 캔들만 꺼내 쓰느라 못 보고 있었다.
   *
   * 이게 왜 중요한가 — **지수가 오르는 날과 돈이 들어오는 날은 다르다.** 거래대금이
   * 줄면서 오르는 건 팔 사람이 없어서 오르는 것이라 힘이 없다. 지수 %만 봐서는
   * 그 둘이 똑같이 생겼다.
   *
   * ⚠️ 지수값은 100배로 오지만 **거래대금은 아니다.** 나누면 안 된다.
   */
  tradeValue: number;
  /** 그날 거래량(천주) — 키움이 주는 단위 그대로 */
  volume: number;
}

export interface IndexFlowRow {
  /** YYYY-MM-DD */
  date: string;
  changeRate: number;
  foreign: number;
  institution: number;
  individual: number;
  pension: number;
  trust: number;
}

export interface IndexDetail {
  code: string;
  name: string;
  range: IndexRange;
  candles: IndexCandle[];
  flows: IndexFlowRow[];
}

function ymd(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${m}${day}`;
}

/**
 * `ka20006` 은 지수를 **100배로** 준다. 686983 이 6,869.83 이다.
 * (08/18 코스피 종가로 맞춰 확인했다)
 *
 * 이걸 놓치면 화면에 68만이 뜬다 — 지수라 자릿수만 보고는 틀린 줄 모른다.
 */
function num(v: unknown): number {
  const n = Math.abs(Number(String(v ?? "").replace(/,/g, "")));
  return Number.isFinite(n) ? n / 100 : 0;
}

/** ⚠️ 거래량·거래대금은 **100배가 아니다.** 지수값에만 쓰는 `num` 과 섞으면 안 된다 */
function plain(v: unknown): number {
  const n = Math.abs(Number(String(v ?? "").replace(/,/g, "")));
  return Number.isFinite(n) ? n : 0;
}

/**
 * 일봉을 주·월로 묶는다.
 *
 * 시가는 구간의 **첫날**, 종가는 **마지막 날**, 고저는 구간 전체다.
 * 순서를 헷갈리면 캔들이 통째로 거꾸로 그려지므로 여기서 한 번만 정리한다.
 */
function bucket(rows: IndexCandle[], range: IndexRange): IndexCandle[] {
  if (range === "day") return rows;
  const keyOf = (dt: string) => {
    if (range === "month") return dt.slice(0, 6);
    // 주는 그 주의 목요일을 대표로 삼는다 — 연도 경계에서 흔들리지 않게 ISO 주 대신
    // 단순히 "그 날짜가 속한 주의 월요일"로 묶는다
    const d = new Date(Number(dt.slice(0, 4)), Number(dt.slice(4, 6)) - 1, Number(dt.slice(6, 8)));
    const monday = new Date(d);
    monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return ymd(monday);
  };

  const out: IndexCandle[] = [];
  let key = "";
  for (const r of rows) {
    const k = keyOf(r.dt);
    if (k !== key) {
      key = k;
      out.push({ ...r });
      continue;
    }
    const last = out[out.length - 1];
    // rows 는 과거 → 최근 순이므로 뒤에 오는 것이 그 구간의 종가다
    last.close = r.close;
    last.high = Math.max(last.high, r.high);
    last.low = Math.min(last.low, r.low);
    // 거래대금·거래량은 **더한다** — 고저처럼 고르는 값이 아니라 쌓이는 값이다
    last.tradeValue += r.tradeValue;
    last.volume += r.volume;
  }
  return out;
}

interface Row {
  dt?: string;
  cur_prc?: string;
  open_pric?: string;
  high_pric?: string;
  low_pric?: string;
  /** 거래대금(백만원) · 거래량 — 2026-08-25 원본에서 확인했다 */
  trde_prica?: string;
  trde_qty?: string;
}

export async function indexDetail(
  client: KiwoomClient,
  code: string,
  range: IndexRange = "day",
): Promise<IndexDetail> {
  const name = code === "101" ? "코스닥" : "코스피";

  const { data } = await client.request<{ inds_dt_pole_qry?: Row[] }>(CHART, "ka20006", {
    inds_cd: code,
    base_dt: ymd(new Date()),
  });

  // 키움은 최신순으로 준다. 차트는 과거 → 최근이라 뒤집는다
  const daily: IndexCandle[] = (data.inds_dt_pole_qry ?? [])
    .map((r) => ({
      dt: String(r.dt ?? ""),
      open: num(r.open_pric),
      high: num(r.high_pric),
      low: num(r.low_pric),
      close: num(r.cur_prc),
      // 키움은 백만원으로 준다 (100 백만원 = 1억). 화면은 억으로 읽는다
      tradeValue: Math.round(plain(r.trde_prica) / 100),
      volume: plain(r.trde_qty),
    }))
    .filter((c) => c.dt && c.close > 0)
    .reverse();

  /*
   * 일별 수급은 이미 쌓아 둔 것에서 꺼낸다 — 추가 호출이 없다.
   * 저장 형식이 `v: number[]` 라 SUBJECTS 순서로 읽어야 한다.
   */
  const market = code === "101" ? "kosdaq" : "kospi";
  const at = (v: number[], key: (typeof SUBJECTS)[number]) => v[SUBJECTS.indexOf(key)] ?? 0;
  const flows: IndexFlowRow[] = (await listSectorFlow())
    .map((d) => {
      const row = d[market].find((x) => x.code === code);
      if (!row) return null;
      return {
        date: d.date,
        changeRate: row.changeRate,
        foreign: at(row.v, "foreign"),
        institution: at(row.v, "institution"),
        individual: at(row.v, "individual"),
        pension: at(row.v, "pension"),
        trust: at(row.v, "trust"),
      };
    })
    .filter((x): x is IndexFlowRow => x !== null)
    .reverse(); // 최근이 위로

  return { code, name, range, candles: bucket(daily, range), flows };
}
