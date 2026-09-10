/**
 * 한투 **일정 API** — 휴장일·공모주 청약은 달력으로, 종목 이벤트는 종목 머리 배너로 (2026-09-10).
 *
 * 증권사 API 전수 조사에서 「지금 당장 붙일 수 있고 시장을 읽는 데 보탬이 되는 것」으로 고른 것.
 *
 * 1. **휴장일** `CTCA0903R` — 달력의 휴장일은 여태 신정·근로자의날·연말 셋만 씨앗으로 박혀 있었다.
 *    추석·설·선거일·임시공휴일은 손으로 넣어야 했다. 한투가 영업일·개장일 여부를 날짜별로 준다
 *    (실측 2026-09-10: 9/24·25 휴장). 연속조회 키가 같은 값을 돌려줘 페이지가 안 넘어가므로
 *    **기준일을 24일씩 옮겨** 넉 달치를 모은다.
 * 2. **공모주 청약** `HHKDB669108C0` — 청약일·공모가·주관사. 청약 이틀은 시장의 돈이 묶이는 날이다.
 * 3. **종목 이벤트** — 주주총회 `HHKDB669111C0`(임시총회 안건이 곧 재료), 합병·분할 `HHKDB669101C0`,
 *    신주 상장 `HHKDB669107C0`(CB 행사·유상증자 신주가 풀리는 날 = 오버행), 배당 `HHKDB669102C0`.
 *    종목 상세를 열 때 그 종목 것만 묻고 6시간 캐시.
 *
 * 전부 **읽기만** 하고, 실패하면 조용히 비운다 — 달력이 한투 때문에 죽으면 안 된다.
 */
import { replaceBySource, type CalendarEvent } from "./calendar.js";
import { hantooGet, hantooReady } from "./hantooClient.js";

type Row = Record<string, unknown>;
const str = (v: unknown) => String(v ?? "").trim();
const ymd8 = (s: string) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : "");
/** "2026/09/10 ~ 2026/09/11" → ["2026-09-10", "2026-09-11"] */
const range = (s: string): [string, string] => {
  const m = s.match(/(\d{4})\/(\d{2})\/(\d{2})/g) ?? [];
  const a = m[0] ? m[0].replace(/\//g, "-") : "";
  const b = m[1] ? m[1].replace(/\//g, "-") : a;
  return [a, b];
};
const kst = (offsetDays = 0) => new Date(Date.now() + 9 * 3600_000 + offsetDays * 86400_000);
const kstYmd = (d: Date) => d.toISOString().slice(0, 10);
const yyyymmdd = (d: Date) => kstYmd(d).replace(/-/g, "");
const num = (v: unknown) => {
  const n = Number(str(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};

/* ───────────── 휴장일 ───────────── */

export async function fetchHolidays(): Promise<{ date: string; wday: string }[]> {
  const out: { date: string; wday: string }[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < 5; i += 1) {
    const base = yyyymmdd(kst(i * 24));
    const r = await hantooGet<{ output?: Row[] }>(
      "/uapi/domestic-stock/v1/quotations/chk-holiday",
      "CTCA0903R",
      { BASS_DT: base, CTX_AREA_NK: "", CTX_AREA_FK: "" },
      "휴장일",
    );
    for (const row of r.output ?? []) {
      const d = ymd8(str(row.bass_dt));
      const wday = str(row.wday_dvsn_cd); // 01 일 … 07 토
      if (!d || seen.has(d)) continue;
      seen.add(d);
      if (str(row.opnd_yn) === "N" && wday !== "01" && wday !== "07") out.push({ date: d, wday });
    }
    await new Promise((res) => setTimeout(res, 200));
  }
  return out;
}

/* ───────────── 공모주 청약 ───────────── */

export interface IpoRow {
  name: string;
  code: string;
  price: number;
  subscribe: [string, string];
  payDate: string;
  listDate: string;
  lead: string;
}

export async function fetchIpo(days = 45): Promise<IpoRow[]> {
  const r = await hantooGet<{ output1?: Row[] }>(
    "/uapi/domestic-stock/v1/ksdinfo/pub-offer",
    "HHKDB669108C0",
    { CTS: "", F_DT: yyyymmdd(kst(-3)), T_DT: yyyymmdd(kst(days)), SHT_CD: "" },
    "공모주 청약",
  );
  return (r.output1 ?? [])
    .map((row) => ({
      name: str(row.isin_name),
      code: str(row.sht_cd),
      price: num(row.fix_subscr_pri),
      subscribe: range(str(row.subscr_dt)),
      payDate: range(str(row.pay_dt))[0],
      listDate: range(str(row.list_dt))[0],
      lead: str(row.lead_mgr),
    }))
    .filter((x) => x.name && x.subscribe[0]);
}

/* ───────────── 달력 동기화 ───────────── */

export const HOLIDAY_SOURCE = "hantoo:holiday";
export const IPO_SOURCE = "hantoo:ipo";

let lastSync: { at: string; holidays: number; ipo: number; error?: string } | null = null;

export async function syncSchedules(): Promise<typeof lastSync> {
  if (!hantooReady()) return lastSync;
  try {
    const holidays = await fetchHolidays();
    const hEvents: Omit<CalendarEvent, "id">[] = holidays.map((h) => ({
      date: h.date,
      title: "증시 휴장일",
      kind: "holiday",
      memo: "한국투자증권 영업일 조회(CTCA0903R) 기준 — 개장하지 않는 평일",
      source: HOLIDAY_SOURCE,
      srcKey: h.date,
    }));
    /* 씨앗(신정·근로자의날·연말)과 겹치는 날은 한투 것으로만 둔다 — 같은 날 둘이면 헷갈린다 */
    const hr = await replaceBySource(HOLIDAY_SOURCE, hEvents);

    let ipoCount = 0;
    try {
      const ipo = await fetchIpo();
      const iEvents: Omit<CalendarEvent, "id">[] = ipo.map((x) => ({
        date: x.subscribe[0],
        endDate: x.subscribe[1] !== x.subscribe[0] ? x.subscribe[1] : undefined,
        title: `공모청약 ${x.name}${x.price ? ` ${x.price.toLocaleString("ko-KR")}원` : ""}`,
        kind: "market",
        memo: [x.lead && `주관 ${x.lead}`, x.payDate && `납입 ${x.payDate.slice(5)}`, x.listDate && `상장 ${x.listDate.slice(5)}`]
          .filter(Boolean)
          .join(" · "),
        source: IPO_SOURCE,
        srcKey: `${x.code}|${x.subscribe[0]}`,
      }));
      ipoCount = (await replaceBySource(IPO_SOURCE, iEvents)).added;
    } catch {
      /* 공모주는 덤이다 — 휴장일이 들어갔으면 됐다 */
    }
    lastSync = { at: new Date().toISOString(), holidays: hr.added, ipo: ipoCount };
  } catch (e) {
    lastSync = { at: new Date().toISOString(), holidays: 0, ipo: 0, error: e instanceof Error ? e.message : String(e) };
  }
  return lastSync;
}

export function scheduleSyncStatus(): typeof lastSync {
  return lastSync;
}

let timer: ReturnType<typeof setInterval> | null = null;
export function startHantooScheduleSync(): void {
  if (timer) return;
  setTimeout(() => void syncSchedules(), 120_000);
  timer = setInterval(() => void syncSchedules(), 6 * 3600_000);
  console.log("[hantoo] 휴장일·공모주 일정 동기화 시작 (6시간 주기)");
}

/* ───────────── 종목 이벤트 ───────────── */

export interface StockEvent {
  /** YYYY-MM-DD — 시장에 영향이 오는 날 */
  date: string;
  kind: "meeting" | "merger" | "listing" | "dividend";
  label: string;
  desc: string;
}

const evCache = new Map<string, { at: number; rows: StockEvent[] }>();
const EV_TTL = 6 * 3600_000;

async function ksd<T extends Row>(path: string, tr: string, code: string, extra: Record<string, string> = {}): Promise<T[]> {
  const r = await hantooGet<{ output1?: T[] }>(
    `/uapi/domestic-stock/v1/ksdinfo/${path}`,
    tr,
    { CTS: "", F_DT: yyyymmdd(kst(-7)), T_DT: yyyymmdd(kst(120)), SHT_CD: code, ...extra },
    "종목 일정",
  );
  return r.output1 ?? [];
}

/** 종목 하나의 앞으로 120일 이벤트 — 주총·합병분할·신주 상장·배당. 날짜순 */
export async function stockEvents(code: string): Promise<StockEvent[]> {
  if (!hantooReady()) return [];
  const hit = evCache.get(code);
  if (hit && Date.now() - hit.at < EV_TTL) return hit.rows;
  const out: StockEvent[] = [];
  const today = kstYmd(kst());
  const jobs: Promise<void>[] = [
    ksd("sharehld-meet", "HHKDB669111C0", code)
      .then((rows) => {
        for (const r of rows) {
          const d = range(str(r.gen_meet_dt))[0];
          if (!d) continue;
          out.push({
            date: d,
            kind: "meeting",
            label: `${str(r.gen_meet_type) || "주주총회"} ${d.slice(5).replace("-", "/")}`,
            desc: str(r.agenda) || "안건 미공개",
          });
        }
      })
      .catch(() => undefined),
    ksd("merger-split", "HHKDB669101C0", code)
      .then((rows) => {
        for (const r of rows) {
          const d = ymd8(str(r.record_date)) || ymd8(str(r.right_dt));
          if (!d) continue;
          const rate = num(r.fix_rate);
          out.push({
            date: d,
            kind: "merger",
            label: `합병·분할 기준일 ${d.slice(5).replace("-", "/")}`,
            desc: `비율 ${rate}% · 권리락 ${ymd8(str(r.right_dt)).slice(5) || "-"} — 기준일 전후로 가격이 뛴다`,
          });
        }
      })
      .catch(() => undefined),
    ksd("list-info", "HHKDB669107C0", code)
      .then((rows) => {
        for (const r of rows) {
          const d = ymd8(str(r.list_dt));
          if (!d || d < today) continue;
          const q = num(r.issue_stk_qty);
          const tot = num(r.tot_issue_stk_qty);
          const pct = tot > 0 ? (q / tot) * 100 : 0;
          out.push({
            date: d,
            kind: "listing",
            label: `신주 상장 ${d.slice(5).replace("-", "/")} (${str(r.issue_type)})`,
            desc: `${q.toLocaleString("ko-KR")}주${pct >= 0.1 ? ` · 발행주식의 ${pct.toFixed(1)}%` : ""}${num(r.issue_price) ? ` · 발행가 ${num(r.issue_price).toLocaleString("ko-KR")}원` : ""} — 그날부터 팔 수 있는 물량(오버행)`,
          });
        }
      })
      .catch(() => undefined),
    ksd("dividend", "HHKDB669102C0", code, { GB1: "0", HIGH_GB: "" })
      .then((rows) => {
        for (const r of rows) {
          const d = ymd8(str(r.record_date));
          if (!d || d < today) continue;
          const amt = num(r.per_sto_divi_amt);
          out.push({
            date: d,
            kind: "dividend",
            label: `배당 기준일 ${d.slice(5).replace("-", "/")}`,
            desc: `${str(r.divi_kind) || ""}배당${amt ? ` 주당 ${amt.toLocaleString("ko-KR")}원` : " (금액 미정)"}${num(r.divi_rate) ? ` · ${num(r.divi_rate)}%` : ""} — 기준일 다음 날 배당락`,
          });
        }
      })
      .catch(() => undefined),
  ];
  await Promise.all(jobs);
  const rows = out.filter((e) => e.date >= kstYmd(kst(-7))).sort((a, b) => a.date.localeCompare(b.date));
  evCache.set(code, { at: Date.now(), rows });
  if (evCache.size > 1000) evCache.clear();
  return rows;
}

/* ───────────── 장중 외인·기관 추정 ───────────── */

export interface InvestorEstimate {
  /** 집계 시각 라벨 — 09:30 / 10:00 / 11:20 / 13:20 / 14:30 */
  time: string;
  fgn: number;
  orgn: number;
  sum: number;
}

const estCache = new Map<string, { at: number; rows: InvestorEstimate[] }>();
const EST_TTL = 5 * 60_000;
const EST_TIME: Record<string, string> = { "1": "09:30", "2": "10:00", "3": "11:20", "4": "13:20", "5": "14:30" };

/**
 * **종목별 외인·기관 추정가집계** `HHPTJ04160200` — 장중에 하루 다섯 번(09:30·10:00·11:20·13:20·14:30)
 * 나오는 잠정치. 장 마감 뒤 확정치(ka10059/ka10060)보다 **몇 시간 먼저** 방향을 말해 준다.
 * 단위는 주(수량). 장전·장후엔 빈 배열이다(실측 07:5x).
 */
export async function investorEstimate(code: string): Promise<InvestorEstimate[]> {
  if (!hantooReady()) return [];
  const hit = estCache.get(code);
  if (hit && Date.now() - hit.at < EST_TTL) return hit.rows;
  try {
    const r = await hantooGet<{ output2?: Row[] }>(
      "/uapi/domestic-stock/v1/quotations/investor-trend-estimate",
      "HHPTJ04160200",
      { MKSC_SHRN_ISCD: code },
      "외인·기관 추정",
    );
    const rows = (r.output2 ?? [])
      .map((row) => ({
        time: EST_TIME[str(row.bsop_hour_gb)] ?? str(row.bsop_hour_gb),
        fgn: num(row.frgn_fake_ntby_qty),
        orgn: num(row.orgn_fake_ntby_qty),
        sum: num(row.sum_fake_ntby_qty),
      }))
      .filter((x) => x.time)
      /* 한투는 최신이 앞이다(실측 11:20·10:00·09:30) — 화면은 왼→오 시간순으로 읽는다 */
      .sort((a, b) => a.time.localeCompare(b.time));
    estCache.set(code, { at: Date.now(), rows });
    if (estCache.size > 500) estCache.clear();
    return rows;
  } catch {
    return [];
  }
}
