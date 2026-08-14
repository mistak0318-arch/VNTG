import { listWatchlist } from "./watchlist.js";
import { listThemes } from "./customThemes.js";
import { recordApiCall } from "./apiUsage.js";

/**
 * 오늘의 공시 — **내 종목 것부터.**
 *
 * DART 는 하루 2,000건 넘게 쏟아진다. 그걸 다 보는 건 불가능하고, 볼 이유도 없다.
 * 내가 들고 있거나 보고 있는 종목의 공시 한 건이 나머지 1,999건보다 중요하다.
 *
 * 그래서 세 겹으로 거른다.
 *   1) 시장을 코스피·코스닥으로 한정 (corp_cls=Y/K)
 *   2) 공시 유형을 주요사항·발행으로 한정 (pblntf_ty=B/I) — 정기보고서는 여기서 뺀다
 *   3) 남은 것을 **내 종목 / 내 테마 / 그 밖**으로 갈라 보여준다
 *
 * 조회는 하루 4회면 충분하다(2시장 × 2유형). DART 는 인증키당 하루 20,000건이라 여유롭다.
 */

const BASE = "https://opendart.fss.or.kr/api/list.json";

/**
 * 제목에 이게 들어가면 주가가 움직인다.
 * 가중치는 "얼마나 자주 크게 움직였나"가 아니라 **얼마나 되돌리기 어려운 사건인가**로 준다 —
 * 유상증자는 주식 수가 늘어 되돌릴 수 없고, 단순 정정공시는 대개 아무 일도 아니다.
 */
const WEIGHTS: [RegExp, number][] = [
  [/유상증자|무상증자|전환사채|신주인수권|교환사채/, 9],
  [/상장폐지|관리종목|거래정지|실질심사|자본잠식|감사의견|의견거절|부적정/, 10],
  [/공급계약|수주|납품|계약\s*체결/, 8],
  [/합병|분할|영업양수|영업양도|주식교환|인수/, 8],
  [/자기주식|자사주/, 7],
  [/무상감자|유상감자|액면/, 7],
  [/실적|영업(잠정)?실적|매출액또는손익/, 6],
  [/투자판단관련|풍문또는보도|조회공시/, 5],
  [/배당/, 5],
  [/특허|임상|품목허가|승인/, 6],
  [/최대주주\s*변경|경영권/, 7],
];

export interface DartEvent {
  corpName: string;
  /** 6자리 종목코드 (없을 수 있다) */
  stockCode: string;
  market: "코스피" | "코스닥" | "기타";
  title: string;
  date: string;
  /** DART 원문 링크 */
  url: string;
  /** 중요도 — 제목 키워드로 매긴다 */
  weight: number;
  /** 내 관심종목인가 */
  watched: boolean;
  /** 걸린 내 테마 이름들 */
  themes: string[];
  /** 정정공시인가 — 원문이 바뀐 것이라 따로 표시해야 오해가 없다 */
  amended: boolean;
}

interface DartRow {
  corp_name?: string;
  stock_code?: string;
  corp_cls?: string;
  report_nm?: string;
  rcept_no?: string;
  rcept_dt?: string;
}

function ymdKst(d = new Date()): string {
  const k = new Date(d.getTime() + 9 * 3600_000);
  return `${k.getUTCFullYear()}${String(k.getUTCMonth() + 1).padStart(2, "0")}${String(k.getUTCDate()).padStart(2, "0")}`;
}

function weightOf(title: string): number {
  let w = 0;
  for (const [re, v] of WEIGHTS) if (re.test(title)) w = Math.max(w, v);
  return w;
}

async function fetchDay(day: string, corpCls: string, type: string): Promise<DartRow[]> {
  const key = process.env.DART_API_KEY?.trim();
  if (!key) return [];
  const url = `${BASE}?crtfc_key=${key}&bgn_de=${day}&end_de=${day}&corp_cls=${corpCls}&pblntf_ty=${type}&page_count=100`;
  try {
    const res = await fetch(url);
    const j = (await res.json()) as { status?: string; list?: DartRow[] };
    // 013 = 데이터 없음. 정상 흐름이므로 실패로 세지 않는다
    void recordApiCall("dart", "list.json", j.status === "000" || j.status === "013" ? "ok" : "failed");
    return j.status === "000" && Array.isArray(j.list) ? j.list : [];
  } catch {
    void recordApiCall("dart", "list.json", "failed");
    return [];
  }
}

let cache: { day: string; at: number; events: DartEvent[] } | null = null;
const TTL_MS = 20 * 60_000;

/**
 * 오늘 공시. 오늘 것이 없으면 **직전 영업일**로 물러난다.
 *
 * 장 시작 전이나 휴장일에 "공시 없음"만 뜨면 화면이 죽은 것처럼 보인다.
 * 사흘까지만 뒤로 간다 — 그보다 오래된 건 오늘 볼 이유가 없다.
 */
export async function todayDartEvents(force = false): Promise<{ day: string; events: DartEvent[] }> {
  const today = ymdKst();
  if (!force && cache && cache.day === today && Date.now() - cache.at < TTL_MS) {
    return { day: cache.day, events: cache.events };
  }

  const [watch, themes] = await Promise.all([
    listWatchlist().catch(() => []),
    listThemes().catch(() => []),
  ]);
  const watched = new Set(watch.map((w) => w.code));
  const themeOf = new Map<string, string[]>();
  for (const t of themes) {
    for (const c of t.codes) {
      const arr = themeOf.get(c);
      if (arr) arr.push(t.name);
      else themeOf.set(c, [t.name]);
    }
  }

  for (let back = 0; back < 4; back += 1) {
    const day = ymdKst(new Date(Date.now() - back * 86400_000));
    const lists = await Promise.all([
      fetchDay(day, "Y", "B"),
      fetchDay(day, "Y", "I"),
      fetchDay(day, "K", "B"),
      fetchDay(day, "K", "I"),
    ]);
    const rows = lists.flat();
    if (rows.length === 0) continue;

    const seen = new Set<string>();
    const events: DartEvent[] = [];
    for (const r of rows) {
      const rcept = String(r.rcept_no ?? "");
      if (!rcept || seen.has(rcept)) continue;
      seen.add(rcept);
      const title = String(r.report_nm ?? "").replace(/\s+/g, " ").trim();
      const code = String(r.stock_code ?? "").trim();
      events.push({
        corpName: String(r.corp_name ?? "").trim(),
        stockCode: code,
        market: r.corp_cls === "Y" ? "코스피" : r.corp_cls === "K" ? "코스닥" : "기타",
        title,
        date: String(r.rcept_dt ?? day),
        url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${rcept}`,
        weight: weightOf(title),
        watched: watched.has(code),
        themes: themeOf.get(code) ?? [],
        amended: /\[기재정정\]|\[첨부정정\]/.test(title),
      });
    }

    /*
     * 내 종목 → 내 테마 → 그 밖, 각각 안에서는 중요도 순.
     * 중요도가 아무리 높아도 남의 종목이 내 종목 위에 오면 안 된다 — 이 화면의 목적은
     * "오늘 무슨 공시가 있었나"가 아니라 "내가 볼 게 있나"다.
     */
    events.sort((a, b) => {
      const rank = (e: DartEvent) => (e.watched ? 0 : e.themes.length > 0 ? 1 : 2);
      return rank(a) - rank(b) || b.weight - a.weight || a.corpName.localeCompare(b.corpName);
    });

    cache = { day, at: Date.now(), events };
    return { day, events };
  }

  cache = { day: today, at: Date.now(), events: [] };
  return { day: today, events: [] };
}

/** 리포트 프롬프트에 넣을 형태 — 내 종목 것만, 짧게 */
export function toDartDigest(day: string, events: DartEvent[]): string {
  const mine = events.filter((e) => e.watched || e.themes.length > 0);
  const notable = events.filter((e) => !e.watched && e.themes.length === 0 && e.weight >= 8);
  if (mine.length === 0 && notable.length === 0) return "";

  const line = (e: DartEvent) =>
    `${e.corpName}${e.themes.length > 0 ? `(${e.themes[0]})` : ""} — ${e.title}`;

  const parts = [`\n[오늘 공시 ${day.slice(4, 6)}/${day.slice(6, 8)} — DART]`];
  if (mine.length > 0) {
    parts.push("<내 종목·내 테마>", ...mine.slice(0, 10).map(line));
  }
  if (notable.length > 0) {
    parts.push("<그 밖 주요 공시>", ...notable.slice(0, 6).map(line));
  }
  return parts.join("\n");
}
