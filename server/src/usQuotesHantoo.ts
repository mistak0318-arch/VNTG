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
function hantooCanHave(symbol: string): boolean {
  return !symbol.includes(".");
}

async function resolveExcd(symbols: string[]): Promise<void> {
  const map = await loadExcd();
  const unknown = symbols.filter((s) => !map[s] && hantooCanHave(s));
  if (unknown.length === 0) return;

  // 거래소가 아홉이라 한 번에 한 종목씩 (10칸 한도)
  for (let i = 0; i < unknown.length; i += 1) {
    const batch = unknown.slice(i, i + 1);
    const pairs = batch.flatMap((symbol) => EXCHANGES.map((excd) => ({ excd, symbol })));
    try {
      const rows = await multRaw(pairs);
      for (const r of rows) {
        const sym = String(r.symb ?? "").trim();
        const excd = String(r.excd ?? "").trim();
        // 값이 실제로 돌아온 것만 인정한다 — 빈 껍데기가 오기도 한다
        if (sym && excd && num(r.last) !== null && !map[sym]) map[sym] = excd;
      }
    } catch {
      /* 못 찾으면 다음에 다시 시도한다 */
    }
  }
  await saveExcd();
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
