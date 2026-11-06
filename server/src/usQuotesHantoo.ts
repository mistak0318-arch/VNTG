import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { hantooGet, hantooReady } from "./hantooClient.js";

/**
 * 미국 시세를 한국투자증권에서 받는다.
 *
 * 야후로 받던 것을 옮긴 이유는 셋이다.
 *
 *   1) **한 번에 10종목.** 야후는 종목마다 한 번씩 불렀다. 40종목이면 40번이 4번이 된다.
 *   2) **야후가 못 주던 값이 온다** — 원화환산가·52주 고저·체결강도·전일거래량.
 *   3) 야후는 공식 API 가 아니라 언제 막혀도 이상하지 않다. 한투는 계약된 창구다.
 *
 * **종목 검색은 야후에 남긴다.** 한투에는 이름으로 티커를 찾는 API 가 마땅치 않은데,
 * 야후 검색은 잘 된다. 담을 때만 야후, 시세는 한투 — 각자 잘하는 걸 시킨다.
 */

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, "..", "data");
/** 티커가 어느 거래소 것인지 — 한 번 알아내면 바뀌지 않는다 */
const EXCD_FILE = join(DATA_DIR, "usExchanges.json");

const MULT = "/uapi/overseas-price/v1/quotations/multprice";
const MULT_TR = "HHDFS76220000";

/**
 * 찾아볼 거래소.
 *
 * 한투는 미국 말고도 일본·홍콩·중국·베트남을 준다. **미국반도체와 일본반도체를 한 그룹에
 * 넣고 같이 보려면** 나라를 가리지 않아야 한다.
 *
 * 미국을 앞에 두는 건 티커가 겹칠 때 미국을 먼저 잡기 위해서다. `BAQ`/`BAY`/`BAA` 는
 * **주간거래**(한국시간 낮)라 정규장이 아니므로 아예 빼 둔다 — 같은 티커가 양쪽에 다 있어서
 * 넣어 두면 정규장 대신 주간 시세를 물어 오게 된다.
 */
const EXCHANGES = ["NAS", "NYS", "AMS", "TSE", "HKS", "SHS", "SZS", "HSX", "HNX"] as const;

/** 거래소가 어느 나라 것인가 — 화면에 국기를 붙이고 통화를 밝히는 데 쓴다 */
export const EXCHANGE_INFO: Record<string, { country: string; flag: string; currency: string }> = {
  NAS: { country: "미국", flag: "🇺🇸", currency: "USD" },
  NYS: { country: "미국", flag: "🇺🇸", currency: "USD" },
  AMS: { country: "미국", flag: "🇺🇸", currency: "USD" },
  TSE: { country: "일본", flag: "🇯🇵", currency: "JPY" },
  HKS: { country: "홍콩", flag: "🇭🇰", currency: "HKD" },
  SHS: { country: "중국", flag: "🇨🇳", currency: "CNY" },
  SZS: { country: "중국", flag: "🇨🇳", currency: "CNY" },
  HSX: { country: "베트남", flag: "🇻🇳", currency: "VND" },
  HNX: { country: "베트남", flag: "🇻🇳", currency: "VND" },
};

export interface UsHantooQuote {
  symbol: string;
  excd: string;
  /** 한투가 붙여 둔 한글 종목명 */
  koreanName: string | null;
  price: number | null;
  changeRate: number | null;
  /** 전일종가 */
  base: number | null;
  open: number | null;
  high: number | null;
  low: number | null;
  volume: number | null;
  /** 전일 거래량 — 오늘 거래가 평소보다 많은지 보려면 있어야 한다 */
  prevVolume: number | null;
  /** 원화 환산가. 야후엔 없다 */
  wonPrice: number | null;
  marketCap: number | null;
  high52: number | null;
  low52: number | null;
  /** 52주 구간에서 지금 어디쯤인가 (0=저가, 100=고가) */
  pos52: number | null;
  /** 체결강도. 100 보다 크면 사는 쪽이 세다 */
  power: number | null;
  /** "장중(실시간)" 같은 상태 문구 — 지연인지 아닌지를 화면에 밝힐 수 있다 */
  state: string | null;
  /** 한국시간 기준 마지막 체결 시각 (HHMMSS) */
  koreanTime: string | null;
  /** 통화 — 나라가 섞이면 78.89 가 달러인지 엔인지 알 수 없다 */
  currency: string | null;
  country: string | null;
  flag: string | null;
  error: string | null;
}

function num(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) && n !== 0 ? n : null;
}

// ------------------------------------------------------------- 거래소 알아내기

let excdMap: Record<string, string> | null = null;

async function loadExcd(): Promise<Record<string, string>> {
  if (excdMap) return excdMap;
  try {
    excdMap = JSON.parse(await readFile(EXCD_FILE, "utf-8")) as Record<string, string>;
  } catch {
    excdMap = {};
  }
  return excdMap;
}

async function saveExcd(): Promise<void> {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(EXCD_FILE, JSON.stringify(excdMap ?? {}, null, 2), "utf-8");
}

/** multprice 한 번에 최대 10칸 */
async function multRaw(pairs: { excd: string; symbol: string }[]): Promise<Record<string, unknown>[]> {
  if (pairs.length === 0) return [];
  const params: Record<string, string> = { AUTH: "", NREC: String(pairs.length) };
  pairs.forEach((p, i) => {
    const n = String(i + 1).padStart(2, "0");
    params[`EXCD_${n}`] = p.excd;
    params[`SYMB_${n}`] = p.symbol;
  });
  const body = await hantooGet<{ output2?: Record<string, unknown>[] }>(
    MULT,
    MULT_TR,
    params,
    "미국 관심종목",
  );
  return body.output2 ?? [];
}

/**
 * 티커가 어느 거래소 것인지 찾는다.
 *
 * 한투는 티커만으론 조회가 안 되고 거래소코드를 같이 줘야 한다. 그런데 사용자는 티커만
 * 안다. 그래서 **세 거래소를 한 번에 물어보고 값이 돌아온 쪽**을 쓴다 — multprice 는
 * 슬롯이 10개라 한 번에 세 종목까지 이렇게 확인할 수 있다.
 *
 * 한 번 알아내면 파일에 적어 둔다. 상장 거래소는 바뀌지 않는다.
 */
/**
 * **한투가 못 주는 티커는 아예 물어보지 않는다.**
 *
 * 유럽은 한투 해외주식에 없다 — 거래소 목록이 미국·일본·홍콩·중국·베트남뿐이다.
 * 유럽 종목은 야후 방식대로 `RHM.DE`(라인메탈)·`BA.L`(BAE)처럼 **점 붙은 티커**로 담기니,
 * 점이 보이면 한투를 건너뛰고 야후로 넘긴다. 아홉 거래소를 헛되이 훑지 않는다.
 */
/**
 * ⚠️ **점이 있다고 다 유럽은 아니다** (2026-09-08 — 벤티지 "얘네는 왜 일봉 이런 거 못
 * 가져오는 거지", 키옥시아 `285A.T` 에서 「거래소를 찾지 못했습니다」).
 *
 * 야후는 미국 밖을 `285A.T`(도쿄) `0700.HK`(홍콩)처럼 **꼬리**로 구별한다. 그런데 여기서
 * 점만 보고 통째로 걸러 냈다 — 유럽을 거르려던 규칙이 **한투가 멀쩡히 주는 일본·홍콩·중국까지**
 * 같이 잘라 버렸다. 실측(2026-09-08): `EXCD=TSE, SYMB=285A` 로 일봉 100개가 정상으로 온다.
 *
 * 꼬리를 한투 거래소로 옮기고, 옮길 수 없는 것(유럽 등)만 야후로 보낸다.
 */
const YAHOO_SUFFIX_TO_EXCD: Record<string, string> = {
  T: "TSE", // 도쿄
  HK: "HKS", // 홍콩
  SS: "SHS", // 상하이
  SZ: "SZS", // 선전
};

/** 우리 심볼 → 한투가 아는 {거래소, 심볼}. 한투가 못 다루면 null */
export function hantooPair(symbol: string): { excd: string; symb: string } | null {
  const sym = symbol.trim().toUpperCase();
  const i = sym.lastIndexOf(".");
  if (i < 0) return null; // 미국 — 거래소는 아홉을 훑어 찾는다(아래 resolveExcd)
  const excd = YAHOO_SUFFIX_TO_EXCD[sym.slice(i + 1)];
  return excd ? { excd, symb: sym.slice(0, i) } : null;
}

/** 한투에 물어볼 때 쓰는 심볼 — 꼬리를 뗀다. 미국은 그대로 */
export function hantooSymb(symbol: string): string {
  return hantooPair(symbol)?.symb ?? symbol;
}

function hantooCanHave(symbol: string): boolean {
  return !symbol.includes(".") || hantooPair(symbol) !== null;
}

/**
 * **한 번에 풀 종목 수** (2026-11-07).
 *
 * 아래 루프는 **종목당 조회 한 건**을 쓴다(거래소 아홉을 한 번에 물어야 해서 10칸이 찬다).
 * 머리말에 "40종목이 4번"이라 적혀 있지만 그건 시세 조회 얘기고, 지도를 처음 만드는
 * 이 루프는 **모르는 종목 수만큼** 조회가 나간다.
 *
 * 벤티지 관심종목이 **187종목**이 되면서 그게 터졌다 — 한 번에 187건을 쏘다가 유량에
 * 막히고, 막힌 것은 아래 `catch` 가 삼켜서 지도가 **빈 채로 저장**됐다. 그러면 `known`
 * 이 비어 모든 줄이 「어느 거래소에서도 찾지 못했습니다」가 되고, 화면에서는 원화·52주·
 * 거래량·강도·봉이 전부 빈칸이 된다(실측: 187종목 중 187종목이 야후).
 *
 * 그래서 **한 번에 이만큼만** 풀고 나머지는 다음 호출로 미룬다. 몇 번 새로고침하면
 * 지도가 다 채워지고, 한 번 채워진 뒤로는 이 루프가 아예 안 돈다.
 */
const RESOLVE_PER_CALL = 12;

async function resolveExcd(symbols: string[]): Promise<void> {
  const map = await loadExcd();
  const unknown = symbols.filter((s) => !map[s] && hantooCanHave(s));
  if (unknown.length === 0) return;

  const todo = unknown.slice(0, RESOLVE_PER_CALL);
  let found = 0;
  let failed = 0;
  let lastWhy = "";

  /*
   * **미국 셋부터 세 종목씩** (2026-11-07).
   *
   * 아홉 거래소를 한꺼번에 물으면 10칸이 차서 **한 건에 한 종목**뿐이다. 그런데 이 앱이
   * 보는 종목은 대부분 미국(NAS·NYS·AMS)이라, 그 셋만 먼저 물으면 **한 건에 세 종목**이다.
   * 거기서 안 잡힌 것만 나머지 여섯(일본·홍콩·중국·베트남)으로 넘긴다.
   *
   * 같은 조회 수로 세 배를 푼다 — 187종목이 쌓인 지금은 그 차이가 크다.
   */
  const US = ["NAS", "NYS", "AMS"] as const;
  const REST = EXCHANGES.filter((e) => !US.includes(e as (typeof US)[number]));

  const ask = async (pairs: { excd: string; symbol: string }[]): Promise<boolean> => {
    try {
      const rows = await multRaw(pairs);
      for (const r of rows) {
        const sym = String(r.symb ?? "").trim();
        const excd = String(r.excd ?? "").trim();
        // 값이 실제로 돌아온 것만 인정한다 — 빈 껍데기가 오기도 한다
        if (sym && excd && num(r.last) !== null && !map[sym]) {
          map[sym] = excd;
          found += 1;
        }
      }
      return true;
    } catch (e) {
      failed += 1;
      lastWhy = e instanceof Error ? e.message : String(e);
      return false;
    }
  };

  /* ① 미국 셋 — 세 종목씩 (3×3 = 9칸) */
  let stopped = false;
  for (let i = 0; i < todo.length && !stopped; i += 3) {
    const part = todo.slice(i, i + 3);
    const pairs = part.flatMap((symbol) => US.map((excd) => ({ excd, symbol })));
    /*
     * ⚠️ **막히면 거기서 그만둔다.** 유량에 걸린 뒤 남은 것을 계속 쏘면 전부 실패하고
     * 그동안 화면이 기다린다. 다음 호출에 이어서 푼다 — 지도는 쌓이는 값이라 조급할 게 없다.
     */
    if (!(await ask(pairs))) stopped = true;
  }

  /* ② 미국에서 못 잡힌 것만 나머지 여섯으로 — 한 종목씩 (6칸) */
  for (const symbol of todo) {
    if (stopped) break;
    if (map[symbol]) continue;
    if (!(await ask(REST.map((excd) => ({ excd, symbol }))))) stopped = true;
  }

  await saveExcd();

  /*
   * 예전엔 이 루프의 실패를 **통째로 삼켰다.** 지도가 왜 안 채워지는지 로그에 한 줄도
   * 안 남아, 화면이 빈 칸만 보여 주는데 까닭을 찾을 길이 없었다.
   */
  const left = unknown.length - todo.length;
  if (found > 0 || failed > 0) {
    console.log(
      `[usExcd] 거래소 찾기 — 새로 ${found}개` +
        (failed > 0 ? ` · 실패 ${failed}건 (${lastWhy})` : "") +
        (left > 0 ? ` · 남은 ${left}종목은 다음에` : ""),
    );
  }
}

/**
 * 이 티커의 거래소코드. 모르면 한 번 찾아보고 적어 둔다.
 *
 * 종목 상세가 이걸 쓴다 — 상세는 한 종목만 부르는데, 그 한 종목의 거래소를 모르면
 * 조회 자체가 안 된다.
 */
export async function excdOf(symbol: string): Promise<string | null> {
  /* 꼬리로 알 수 있는 것(일본·홍콩·중국)은 아홉 거래소를 훑을 이유가 없다 */
  const known = hantooPair(symbol);
  if (known) return known.excd;
  const map = await loadExcd();
  if (map[symbol]) return map[symbol];
  if (!hantooCanHave(symbol)) return null;
  await resolveExcd([symbol]);
  return (await loadExcd())[symbol] ?? null;
}

// ------------------------------------------------------------------ 시세 받기

export async function hantooUsQuotes(symbols: string[]): Promise<Map<string, UsHantooQuote>> {
  const out = new Map<string, UsHantooQuote>();
  if (!hantooReady() || symbols.length === 0) return out;

  await resolveExcd(symbols);
  const map = await loadExcd();

  const known = symbols.filter((s) => map[s]);
  for (const s of symbols) {
    if (!map[s]) {
      // 못 찾은 건 야후가 받아 간다. 유럽은 처음부터 이쪽이다
      out.set(s, {
        symbol: s,
        excd: "",
        koreanName: null,
        price: null,
        changeRate: null,
        base: null,
        open: null,
        high: null,
        low: null,
        volume: null,
        prevVolume: null,
        wonPrice: null,
        marketCap: null,
        high52: null,
        low52: null,
        pos52: null,
        power: null,
        state: null,
        koreanTime: null,
        currency: null,
        country: null,
        flag: null,
        error: "어느 거래소에서도 찾지 못했습니다",
      });
    }
  }

  for (let i = 0; i < known.length; i += 10) {
    const batch = known.slice(i, i + 10);
    try {
      const rows = await multRaw(batch.map((symbol) => ({ excd: map[symbol], symbol })));
      for (const r of rows) {
        const symbol = String(r.symb ?? "").trim();
        if (!symbol) continue;
        const high52 = num(r.h52p);
        const low52 = num(r.l52p);
        const price = num(r.last);
        out.set(symbol, {
          symbol,
          excd: String(r.excd ?? "").trim(),
          koreanName: String(r.knam ?? "").trim() || null,
          price,
          changeRate: Number.isFinite(Number(r.rate)) ? Number(r.rate) : null,
          base: num(r.base),
          open: num(r.open),
          high: num(r.high),
          low: num(r.low),
          volume: num(r.tvol),
          prevVolume: num(r.pvol),
          wonPrice: num(r.t_xprc),
          marketCap: num(r.tomv),
          high52,
          low52,
          // 52주 구간의 어디쯤인지. 신고가 근처인지 바닥인지가 값 자체보다 읽힌다
          pos52:
            price !== null && high52 !== null && low52 !== null && high52 > low52
              ? ((price - low52) / (high52 - low52)) * 100
              : null,
          power: num(r.powx),
          state: String(r.stat2 ?? "").trim() || null,
          koreanTime: String(r.khms ?? "").trim() || null,
          currency: String(r.curr ?? "").trim() || null,
          country: EXCHANGE_INFO[String(r.excd ?? "").trim()]?.country ?? null,
          flag: EXCHANGE_INFO[String(r.excd ?? "").trim()]?.flag ?? null,
          error: null,
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : "조회 실패";
      for (const s of batch) {
        if (!out.has(s)) {
          out.set(s, {
            symbol: s,
            excd: map[s],
            koreanName: null,
            price: null,
            changeRate: null,
            base: null,
            open: null,
            high: null,
            low: null,
            volume: null,
            prevVolume: null,
            wonPrice: null,
            marketCap: null,
            high52: null,
            low52: null,
            pos52: null,
            power: null,
            state: null,
            koreanTime: null,
            currency: null,
            country: null,
            flag: null,
            error: msg,
          });
        }
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 미국 주간거래 (오버나이트)                                          */
/* ------------------------------------------------------------------ */

/**
 * 정규장 거래소 → **주간거래** 거래소.
 *
 * 한투가 `BAQ`(나스닥 주간)·`BAY`(뉴욕 주간)·`BAA`(아멕스 주간)를 준다.
 * **이미 쓰는 multprice 그대로**이고 거래소 코드만 바꾸면 된다 — 새 API 가 아니다.
 */
const DAY_EXCD: Record<string, string> = { NAS: "BAQ", NYS: "BAY", AMS: "BAA" };

export interface UsDayQuote {
  symbol: string;
  /** 주간거래 현재가 */
  price: number | null;
  /** 등락률(%) — 정규장 종가 대비 */
  changeRate: number | null;
  /** 기준가(정규장 종가) */
  base: number | null;
  /** 주간거래 거래량. 0 이면 아직 거래가 없다는 뜻이라 값을 믿으면 안 된다 */
  volume: number | null;
}

/**
 * 미국 주간거래 시세.
 *
 * **이름을 정확히 쓴다.** 이건 미 동부 프리마켓(04:00~09:30 ET, 한국 밤)이 **아니다.**
 * 한국 낮에 열리는 **오버나이트 세션**이다. 그런데 국내장이 열려 있는 동안 움직이는
 * 미국 가격은 이것뿐이라, "미국이 지금 어디로 가는가"를 보려면 이걸 봐야 한다.
 * 화면에도 「프리장」이 아니라 「미국 주간거래」로 적는다 — 나중에 헷갈리면 판단이 틀어진다.
 *
 * 미국 종목만 대상이다. 일본·홍콩·유럽은 주간거래가 없어 아예 부르지 않는다.
 */
export async function hantooUsDayQuotes(symbols: string[]): Promise<Map<string, UsDayQuote>> {
  const out = new Map<string, UsDayQuote>();
  if (!hantooReady() || symbols.length === 0) return out;

  const map = await loadExcd();
  // 거래소를 아는 미국 종목만. 모르는 건 정규장 조회가 먼저 채워 준다
  const pairs = symbols
    .filter((s) => map[s] && DAY_EXCD[map[s]])
    .map((symbol) => ({ excd: DAY_EXCD[map[symbol]], symbol }));
  if (pairs.length === 0) return out;

  for (let i = 0; i < pairs.length; i += 10) {
    try {
      const rows = await multRaw(pairs.slice(i, i + 10));
      for (const r of rows) {
        const symbol = String(r.symb ?? "").trim();
        if (!symbol) continue;
        const volume = num(r.tvol);
        out.set(symbol, {
          symbol,
          price: num(r.last),
          changeRate: Number.isFinite(Number(r.rate)) ? Number(r.rate) : null,
          base: num(r.base),
          volume,
        });
      }
    } catch {
      // 주간거래는 있으면 좋은 값이다. 실패해도 정규장 시세를 막지 않는다
    }
  }
  return out;
}
