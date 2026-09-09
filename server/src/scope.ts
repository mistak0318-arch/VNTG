import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { KiwoomClient } from "./kiwoomClient.js";
import {
  DEFAULT_GROUP,
  SCOPE_GROUP,
  listWatchlist,
  updateWatchItem,
  type WatchItem,
} from "./watchlist.js";
import {
  loadLedger,
  type BarRow,
  type FlowRow,
  type LoanRow,
  type ProgRow,
  type RatioRow,
  type ShortRow,
} from "./dailyStore.js";
import { getMarketSnapshot } from "./marketSnapshot.js";
import { INST_KEYS, signed, stockSummary, type StockSummary } from "./stockSummary.js";
import { searchNews, type NewsItem } from "./newsDisclosure.js";
import { search as searchStore, type StoreHit } from "./channelStore.js";
import { alCode } from "./alCode.js";
import { loadBars } from "./dailyCloses.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTES_FILE = resolve(__dirname, "..", "data", "scopeNotes.json");

/**
 * **현미경** — 매수 직전 종목의 관리 화면 (2026-09-07).
 *
 * 벤티지: "마이페이지 밑에 「매수직전」 메뉴 하나 만들고 이 종목들 트래킹하는 화면.
 * 아주 정교하게 — 외국인 수급 흐름, 기관 흐름(특히 기관 3대장: 연기금·투신·사모펀드),
 * 공매도/대차잔고, 차트 흐름, 당일 수급, 관련 뉴스/텔레그램. 매수 직전의 종목들 중에서
 * 뭘 매수할지 내가 바로 고를 수 있도록. 간단한 메모도."
 *
 * ## 조회를 거의 안 늘린다
 *
 * 여기서 보여 주는 것의 대부분은 **이미 날마다 쌓이고 있던 것**이다:
 *
 *   수급 13주체 · 공매도 · 대차잔고 · 외국인 지분율 · 프로그램  ← `dailyStore` 원장 (전종목, 마감 뒤)
 *   일봉                                                      ← `dailyCloses` (전종목 500일)
 *   뉴스                                                      ← `searchNews` (네이버, 캐시)
 *   텔레그램                                                  ← `channelStore` (창고, 텔레그램 안 부름)
 *
 * 키움을 새로 부르는 것은 둘뿐이다 — 목록의 **현재가**(ka10095, 여러 종목 한 번에)와
 * 종목당 **오늘 수급**(ka10059 하나). 원장은 마감 뒤에 채워지므로 장중엔 「오늘」이
 * 원장에 없다. 오늘이 없는 매수 직전 화면은 뜻이 없다.
 *
 * ## 「담은 뒤」를 잰다
 *
 * 매수 직전으로 본 순간의 값을 적어 둔다(`since` · `sincePrice`). 그 뒤로 얼마나
 * 움직였는지가 「아직 사도 되나」의 첫 물음이다 — 담고 나서 +8% 갔으면 이미 늦었을 수
 * 있고, -5% 갔으면 판단이 틀렸거나 기회다. 이 값이 없으면 그 물음을 매번 기억에 기대야 한다.
 *
 * 담는 순간을 잡는 훅이 따로 없어서 **처음 목록에 나타날 때** 적는다. 관심종목 담기 시트
 * 어디서든 「현미경」에 체크하면 다음 목록 조회에서 잡힌다 — 그 사이 몇 분의 차이는
 * 판단에 영향이 없다.
 */

export interface ScopeNote {
  note: string;
  /** 현미경에 처음 나타난 때 */
  since: string;
  /** 그때 가격 — 없으면 처음 조회 때 시세를 못 받은 것 */
  sincePrice: number | null;
  updatedAt: string;
}

type NoteStore = Record<string, ScopeNote>;

let notesCache: NoteStore | null = null;

async function loadNotes(): Promise<NoteStore> {
  if (notesCache) return notesCache;
  try {
    notesCache = JSON.parse(await readFile(NOTES_FILE, "utf-8")) as NoteStore;
  } catch {
    notesCache = {};
  }
  return notesCache;
}

async function saveNotes(s: NoteStore): Promise<void> {
  notesCache = s;
  await mkdir(dirname(NOTES_FILE), { recursive: true });
  await writeFile(NOTES_FILE, JSON.stringify(s, null, 2), "utf-8");
}

export async function setScopeNote(code: string, note: string): Promise<ScopeNote> {
  const s = await loadNotes();
  const now = new Date().toISOString();
  const cur = s[code] ?? { note: "", since: now, sincePrice: null, updatedAt: now };
  s[code] = { ...cur, note: note.slice(0, 1000), updatedAt: now };
  await saveNotes(s);
  return s[code];
}

/* ── 계산 ─────────────────────────────────────────────────────────── */

/** 마지막 `n` 줄의 합(억원). 값이 하나도 없으면 null — 0 은 「안 샀다」지 「모른다」가 아니다 */
function sumLast(rows: FlowRow[], key: keyof FlowRow, n: number): number | null {
  const tail = rows.slice(-n);
  let s = 0;
  let has = false;
  for (const r of tail) {
    const v = r[key];
    if (typeof v === "number") {
      s += v;
      has = true;
    }
  }
  return has ? s / 100 : null;
}

/** 연속 순매수(양수)·순매도(음수) 일수 — 방향이 바뀌는 날에서 멈춘다 */
function streak(rows: FlowRow[], key: keyof FlowRow): number {
  let k = 0;
  let sign = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const v = rows[i][key];
    if (typeof v !== "number" || v === 0) break;
    const s = v > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    if (s !== sign) break;
    k += 1;
  }
  return k * sign;
}

const pct = (a: number | null, b: number | null) =>
  a !== null && b !== null && b !== 0 ? Number((((a - b) / b) * 100).toFixed(2)) : null;

const avg = (xs: number[]) => (xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : null);

export interface ScopeFlow {
  d1: number | null;
  d5: number | null;
  d20: number | null;
  /** 연속 순매수(+)/순매도(−) 일수 */
  streak: number;
}

export interface ScopeRow {
  code: string;
  name: string;
  /** 코스피 / 코스닥 (2026-09-09 밤 — 벤티지 "코스피/코스닥 정보가 안 들어가 있네") */
  market: "코스피" | "코스닥" | null;
  sector: string | null;
  /** 억원 */
  marketCap: number | null;
  price: number | null;
  changeRate: number | null;
  /** 오늘 거래대금(억원) — 스냅샷 어림값 */
  tradeValue: number | null;
  since: string;
  sincePrice: number | null;
  /** 담은 뒤 등락(%) */
  sinceRet: number | null;
  note: string;
  /** 원장 마지막 날짜(YYYYMMDD) — 「어제까지」인지 「오늘까지」인지 */
  ledgerAt: string | null;
  /**
   * **오늘** 수급(억원) — ka10059 의 오늘 줄. 원장엔 마감 뒤에야 들어오므로 따로 받는다.
   * 장 시작 전이면 null.
   */
  today: {
    fgn: number | null;
    org: number | null;
    ind: number | null;
    pen: number | null;
    trust: number | null;
    samo: number | null;
  } | null;
  fgn: ScopeFlow;
  org: ScopeFlow;
  /** 기관 3대장 — 연기금·투신·사모. 「기관」 한 덩어리로는 누가 샀는지 모른다 */
  pen: ScopeFlow;
  trust: ScopeFlow;
  samo: ScopeFlow;
  /** 셋의 합 */
  big3: ScopeFlow;
  short: {
    /** 최근 공매도 비중(%) */
    ratio: number | null;
    /** 5일 평균 */
    ratio5: number | null;
    /** 20일 평균 */
    ratio20: number | null;
  };
  loan: {
    /** 대차잔고(주) */
    rmnd: number | null;
    /** 20일 전 대비(%) */
    chg20: number | null;
    /** 5일 전 대비(%) */
    chg5: number | null;
  };
  fgnRatio: {
    /** 외국인 지분율(%) */
    now: number | null;
    /** 20일 전 대비(%p) */
    chg20: number | null;
  };
  chart: {
    /** 최근 60일 종가 — 작은 선 */
    closes: number[];
    /** 5일선 대비 이격(%) — 벤티지: "5일선 이격도 표시해줘, 20일선 이격 앞에다가" */
    ma5Gap: number | null;
    /** 20일선 대비 이격(%) */
    ma20Gap: number | null;
    ma60Gap: number | null;
    /** 20일 고점 대비(%) — 0 이면 신고가 자리 */
    hi20Gap: number | null;
    ret5: number | null;
    ret20: number | null;
    /** 오늘 거래량 ÷ 20일 평균 */
    volRatio: number | null;
  };
}

function flowOf(rows: FlowRow[], key: keyof FlowRow): ScopeFlow {
  return {
    d1: sumLast(rows, key, 1),
    d5: sumLast(rows, key, 5),
    d20: sumLast(rows, key, 20),
    streak: streak(rows, key),
  };
}

/** 셋을 더한 가상의 주체 — 원장 줄을 합쳐 같은 계산에 태운다 */
function big3Rows(rows: FlowRow[]): FlowRow[] {
  return rows.map((r) => {
    const parts = [r.pen, r.trust, r.samo].filter((v): v is number => typeof v === "number");
    return { ...r, org: parts.length > 0 ? parts.reduce((s, v) => s + v, 0) : null };
  });
}

function chartOf(bars: BarRow[]): ScopeRow["chart"] {
  const closes = bars.map((b) => b.c).filter((c) => c > 0);
  const last = closes[closes.length - 1] ?? null;
  const ma = (n: number) => (closes.length >= n ? avg(closes.slice(-n)) : null);
  const hi20 = closes.length > 0 ? Math.max(...closes.slice(-20)) : null;
  const vols = bars.slice(-21, -1).map((b) => b.v).filter((v) => v > 0);
  const vToday = bars[bars.length - 1]?.v ?? 0;
  const vAvg = avg(vols);
  return {
    closes: closes.slice(-60),
    ma5Gap: pct(last, ma(5)),
    ma20Gap: pct(last, ma(20)),
    ma60Gap: pct(last, ma(60)),
    hi20Gap: pct(last, hi20),
    ret5: pct(last, closes[closes.length - 6] ?? null),
    ret20: pct(last, closes[closes.length - 21] ?? null),
    volRatio: vAvg && vAvg > 0 && vToday > 0 ? Number((vToday / vAvg).toFixed(2)) : null,
  };
}

/** 일봉 — `dailyCloses` 창고(전종목 500일). 원장의 `bars` 는 비어 있다 */
async function barsOf(code: string): Promise<BarRow[]> {
  const rows = await loadBars(code).catch(() => []);
  return rows
    .map((r) => ({
      d: String(r.d),
      o: Number(r.o) || Number(r.c),
      h: Number(r.h) || Number(r.c),
      l: Number(r.l) || Number(r.c),
      c: Number(r.c),
      v: Number(r.v) || 0,
    }))
    .filter((r) => /^\d{8}$/.test(r.d) && r.c > 0)
    .sort((a, b) => a.d.localeCompare(b.d));
}

/* ── 키움: 현재가(여럿 한 번에) · 오늘 수급(종목당 하나) ───────────── */

const num = (v: unknown) => {
  const x = Number(String(v ?? "").replace(/[+,\s]/g, ""));
  return Number.isFinite(x) ? x : 0;
};

async function quotes(
  client: KiwoomClient,
  codes: string[],
): Promise<Record<string, { price: number; changeRate: number }>> {
  if (codes.length === 0) return {};
  try {
    const { data } = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10095", {
      stk_cd: codes.map((c) => `${c}_AL`).join("|"),
    });
    const rows = Array.isArray(data.atn_stk_infr) ? (data.atn_stk_infr as Record<string, unknown>[]) : [];
    const out: Record<string, { price: number; changeRate: number }> = {};
    for (const r of rows) {
      const code = String(r.stk_cd ?? "").replace(/_(AL|NX)$/i, "");
      const price = Math.abs(num(r.cur_prc));
      if (code && price > 0) out[code] = { price, changeRate: num(r.flu_rt) };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * 오늘 수급 한 줄 — ka10059 의 오늘 줄만. 없으면(장 시작 전) null.
 *
 * ⚠️ 1분 캐시. 목록이 30초마다 새로 고쳐도 종목마다 키움을 또 부르지 않는다 —
 * 열 종목이면 한도(초당 5)의 두 초를 먹는 조회다.
 */
const todayCache = new Map<string, { at: number; v: ScopeRow["today"] }>();
const TODAY_TTL = 60_000;

async function todayFlow(client: KiwoomClient, code: string): Promise<ScopeRow["today"]> {
  const hit = todayCache.get(code);
  if (hit && Date.now() - hit.at < TODAY_TTL) return hit.v;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  let v: ScopeRow["today"] = null;
  try {
    const { data } = await client.request<Record<string, unknown>>("/api/dostk/stkinfo", "ka10059", {
      dt: today,
      stk_cd: alCode(code),
      amt_qty_tp: "1",
      trde_tp: "0",
      unit_tp: "1000",
    });
    const rows = Array.isArray(data.stk_invsr_orgn) ? (data.stk_invsr_orgn as Record<string, unknown>[]) : [];
    const row = rows.find((r) => String(r.dt ?? "") === today) ?? null;
    if (row) {
      v = {
        fgn: signed(row.frgnr_invsr) / 100,
        org: signed(row.orgn) / 100,
        ind: signed(row.ind_invsr) / 100,
        pen: signed(row.penfnd_etc) / 100,
        trust: signed(row.invtrt) / 100,
        samo: signed(row.samo_fund) / 100,
      };
    }
  } catch {
    v = null;
  }
  todayCache.set(code, { at: Date.now(), v });
  return v;
}

/* ── 목록 ─────────────────────────────────────────────────────────── */

async function scopeItems(): Promise<WatchItem[]> {
  const items = await listWatchlist();
  return items.filter((i) => !i.divider && (i.groups ?? []).includes(SCOPE_GROUP));
}

export async function scopeList(client: KiwoomClient): Promise<{ rows: ScopeRow[]; ledgerNote: string | null }> {
  const items = await scopeItems();
  if (items.length === 0) return { rows: [], ledgerNote: null };
  const codes = items.map((i) => i.code);

  const [q, snap, notes] = await Promise.all([
    quotes(client, codes),
    getMarketSnapshot(client).catch(() => null),
    loadNotes(),
  ]);

  /* 오늘 수급은 종목마다 하나씩 — 한도가 초당 5라 몰아 보내지 않고 차례로 */
  const todays = new Map<string, ScopeRow["today"]>();
  for (const c of codes) todays.set(c, await todayFlow(client, c));

  let notesDirty = false;
  const now = new Date().toISOString();
  const rows: ScopeRow[] = [];
  let ledgerAt: string | null = null;

  for (const it of items) {
    const code = it.code;
    const led = await loadLedger(code).catch(() => null);
    const flow = led?.flow ?? [];
    /* 일봉은 원장이 아니라 `dailyCloses` 에 있다 — 수집기가 같은 것을 두 번 안 받으려고 갈라 뒀다 */
    const bars = await barsOf(code);
    const shortRows = led?.short ?? [];
    const loanRows = led?.loan ?? [];
    const ratioRows = led?.fgnRatio ?? [];
    const lastD = flow[flow.length - 1]?.d ?? bars[bars.length - 1]?.d ?? null;
    if (lastD && (!ledgerAt || lastD > ledgerAt)) ledgerAt = lastD;

    const quote = q[code];
    const s = snap?.byCode.get(code) ?? null;
    const price = quote?.price ?? s?.price ?? null;

    /* 처음 나타난 종목 — 담은 때와 값을 적는다 */
    let note = notes[code];
    if (!note) {
      note = { note: "", since: now, sincePrice: price, updatedAt: now };
      notes[code] = note;
      notesDirty = true;
    } else if (note.sincePrice === null && price !== null) {
      note.sincePrice = price;
      notesDirty = true;
    }

    const shortRatios = shortRows.map((r) => r.ratio).filter((v): v is number => typeof v === "number");
    /*
     * 대차잔고의 마지막 줄은 **0 으로 올 때가 있다** — 거래소가 하루 늦게 집계해서
     * 아직 없는 날이다(LG전자 09/04 실측: 502만주 → 0). 0 을 값으로 읽으면 「20일 −100%」
     * 라는 거짓이 적힌다. 0 은 없는 것이다 — 마지막 **있는** 줄부터 센다.
     */
    const loans = loanRows.filter((r) => typeof r.rmnd === "number" && r.rmnd > 0);
    const loanLast = loans[loans.length - 1]?.rmnd ?? null;
    const loan5 = loans[loans.length - 6]?.rmnd ?? null;
    const loan20 = loans[loans.length - 21]?.rmnd ?? null;
    const rNow = ratioRows[ratioRows.length - 1]?.ratio ?? null;
    const r20 = ratioRows[ratioRows.length - 21]?.ratio ?? null;

    rows.push({
      code,
      name: it.name,
      market: s?.market === "kospi" ? "코스피" : s?.market === "kosdaq" ? "코스닥" : null,
      sector: s?.sector ?? null,
      marketCap: s?.marketCap ?? null,
      price,
      changeRate: quote?.changeRate ?? s?.changeRate ?? null,
      tradeValue: s?.tradeValue ?? null,
      since: note.since,
      sincePrice: note.sincePrice,
      sinceRet: pct(price, note.sincePrice),
      note: note.note,
      ledgerAt: lastD,
      today: todays.get(code) ?? null,
      fgn: flowOf(flow, "fgn"),
      org: flowOf(flow, "org"),
      pen: flowOf(flow, "pen"),
      trust: flowOf(flow, "trust"),
      samo: flowOf(flow, "samo"),
      big3: flowOf(big3Rows(flow), "org"),
      short: {
        ratio: shortRatios[shortRatios.length - 1] ?? null,
        ratio5: avg(shortRatios.slice(-5)),
        ratio20: avg(shortRatios.slice(-20)),
      },
      loan: { rmnd: loanLast, chg5: pct(loanLast, loan5), chg20: pct(loanLast, loan20) },
      fgnRatio: {
        now: rNow,
        chg20: rNow !== null && r20 !== null ? Number((rNow - r20).toFixed(2)) : null,
      },
      chart: chartOf(bars),
    });
  }
  if (notesDirty) await saveNotes(notes);

  /* 원장이 어제까지라는 것을 화면이 알아야 「5일」이 어느 5일인지 안다 */
  const todayD = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, "");
  const ledgerNote =
    ledgerAt && ledgerAt < todayD
      ? `수급·공매도·대차는 ${ledgerAt.slice(4, 6)}/${ledgerAt.slice(6)} 까지 — 오늘치는 마감 뒤에 들어옵니다. 「오늘」 칸만 지금 값입니다`
      : null;
  return { rows, ledgerNote };
}

/* ── 상세 ─────────────────────────────────────────────────────────── */

export interface ScopeDetail {
  row: ScopeRow;
  bars: BarRow[];
  flow: FlowRow[];
  short: ShortRow[];
  loan: LoanRow[];
  fgnRatio: RatioRow[];
  prog: ProgRow[];
  /** 지금 이 순간 — 시세·오늘 수급·장중 누적. 키움 넷 */
  today: StockSummary | null;
  news: NewsItem[];
  telegram: StoreHit[];
  /** 텔레그램 창고가 뒤로 닿는 데 */
  telegramOldest: string | null;
  instLabels: Record<string, string>;
}

export async function scopeDetail(client: KiwoomClient, code: string): Promise<ScopeDetail | null> {
  const { rows } = await scopeList(client);
  const row = rows.find((r) => r.code === code);
  if (!row) return null;

  const [led, today, news, tg] = await Promise.all([
    loadLedger(code).catch(() => null),
    stockSummary(client, code).catch(() => null),
    searchNews(row.name, { majorOnly: false, limit: 15 }).catch(() => [] as NewsItem[]),
    /* 창고 사흘치 — 종목 이름으로. 텔레그램을 새로 부르지 않는다 */
    searchStore([row.name], 3 * 24 * 60).catch(() => null),
  ]);

  return {
    row,
    bars: (await barsOf(code)).slice(-120),
    flow: (led?.flow ?? []).slice(-60),
    short: (led?.short ?? []).slice(-60),
    /* 0 은 미집계 — 선이 바닥으로 꽂히지 않게 뺀다 */
    loan: (led?.loan ?? []).filter((r) => typeof r.rmnd === "number" && r.rmnd > 0).slice(-60),
    fgnRatio: (led?.fgnRatio ?? []).slice(-60),
    prog: (led?.prog ?? []).slice(-60),
    today,
    news: news.slice(0, 15),
    telegram: (tg?.hits ?? []).slice(0, 30),
    telegramOldest: tg?.oldest ?? null,
    instLabels: INST_KEYS,
  };
}

/**
 * 현미경에서 뺀다 — **관심종목에서는 안 뺀다.**
 *
 * 매수 직전에서 물러난 것이지 관심이 사라진 게 아니다. 다른 그룹이 하나도 없으면
 * 기본 그룹으로 보낸다. 관심종목에서까지 빼는 건 관심종목 화면의 일이다.
 */
export async function scopeRemove(code: string): Promise<boolean> {
  const items = await listWatchlist();
  const w = items.find((i) => i.code === code);
  if (!w || !(w.groups ?? []).includes(SCOPE_GROUP)) return false;
  const rest = (w.groups ?? []).filter((g) => g !== SCOPE_GROUP);
  await updateWatchItem(code, { groups: rest.length > 0 ? rest : [DEFAULT_GROUP] });
  /* 담은 때는 지운다 — 다시 담으면 그때가 새 「담은 뒤」다 */
  const notes = await loadNotes();
  if (notes[code]) {
    delete notes[code];
    await saveNotes(notes);
  }
  return true;
}
