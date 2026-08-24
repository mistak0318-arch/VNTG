import { recordApiCall } from "./apiUsage.js";

/**
 * 줄 단위 경고.
 *
 * `usMajor` 에도 같은 모양이 있지만 **거기서 가져오지 않는다** — usMajor 가 이 파일의
 * `fetchQuotes` 를 쓰므로 서로를 부르는 고리가 된다. 타입 하나라 여기 따로 둔다.
 */
export type RowLevel = "danger" | "warn" | "ok";

export interface RowSignal {
  level: RowLevel;
  /** 왜 그렇게 봤는지 한 줄 — 색만 있으면 왜 빨간지 모른다 */
  why: string;
}

/**
 * 글로벌 시황 (환율·원자재·미국지수·금리·암호화폐).
 * 키움 REST API는 국내 시장 중심이라 이 항목들을 제공하지 않아 Yahoo Finance를 쓴다.
 *
 * v7 quote 엔드포인트는 인증이 걸려 401이 나므로 v8 chart 엔드포인트를 사용한다.
 * (meta에 현재가와 전일종가가 함께 들어있어 등락 계산이 가능)
 */

export interface GlobalQuote {
  key: string;
  label: string;
  group: string;
  /**
   * 묶음 색.
   *
   * 스무 줄이 같은 색으로 늘어서면 어디까지가 원자재이고 어디부터가 아시아인지
   * 글자를 읽어야 안다. **서버가 정해서 내려보낸다** — 시황과 리포트가 같은 값을
   * 다른 색으로 칠하면 하나를 보고 다른 하나를 찾을 때 헷갈린다.
   */
  color: string;
  symbol: string;
  price: number | null;
  change: number | null;
  changeRate: number | null;
  /** 금리는 %p 표기라 등락률보다 절대 변화가 의미 있음 */
  isRate: boolean;
  /**
   * 선물인가 현물인가.
   *
   * 이걸 안 적어 두면 화면이 거짓말을 한다. 미국 **현물** 지수는 우리 시간 05:30 에
   * 닫혀서 낮에는 전일 종가에 멈춰 있는데, 인베스팅은 거의 24시간 도는 **선물**을
   * 보여준다. 같은 "US 500" 인데 값이 다른 이유가 그것이다.
   */
  kind: "선물" | "현물" | "";
  /** Yahoo 가 알려준 체결 시각(ms) — "언제 값인가"의 답 */
  quotedAt: number | null;
  /**
   * 줄 단위 경고. 미장 주요지수와 같은 방식이다 —
   * 색만 칠하면 왜 빨간지 모르므로 **이유를 문장으로** 같이 낸다.
   */
  signal: RowSignal | null;
  error: string | null;
}

/**
 * 묶음별 색.
 *
 * 성격이 다른 것끼리 확실히 갈리게 고른다 — 환율(외국인 수급의 전제)과
 * 미국 선물(개장가의 예고)이 판단에 제일 자주 쓰이므로 눈에 띄는 색을 준다.
 */
const GROUP_COLOR: Record<string, string> = {
  환율: "#f5c542",
  "미국 지수선물": "#4c8dff",
  아시아: "#35c46a",
  원자재: "#c0813a",
  암호화폐: "#a97bd6",
};

/**
 * 줄 하나가 위험한가.
 *
 * 문턱을 묶음마다 다르게 둔다 — **같은 3% 가 뜻하는 게 다르기 때문이다.**
 * 비트코인 3% 는 흔한 날이고 달러/원 3% 는 사고다.
 */
function signalOf(group: string, label: string, rate: number | null): RowSignal | null {
  if (rate === null || !Number.isFinite(rate)) return null;
  const a = Math.abs(rate);

  if (group === "환율") {
    // 원화 약세(상승)가 문제다. 외국인은 환차손을 먼저 본다
    if (rate >= 1.5) return { level: "danger", why: "원화가 크게 약해졌다 — 외국인이 팔 이유가 된다" };
    if (rate >= 0.8) return { level: "warn", why: "원화 약세 — 외국인 수급에 부담이다" };
    if (rate <= -0.8) return { level: "ok", why: "원화 강세 — 외국인이 들어오기 좋은 쪽이다" };
    return null;
  }
  if (group === "암호화폐") {
    // 변동성이 원래 크다. 문턱을 높게 둬야 늘 빨갛지 않다
    if (a >= 7) return { level: rate > 0 ? "ok" : "danger", why: "하루 7% 이상 — 위험자산 심리가 크게 움직였다" };
    return null;
  }
  if (group === "원자재") {
    if (a >= 4) return { level: "warn", why: `${label} 4% 이상 — 물가와 원가에 그대로 온다` };
    return null;
  }
  /*
   * 지수·선물.
   *
   * 이유 문장을 묶음마다 다르게 쓴다. 예전엔 하나로 썼는데 **코스피지수에도
   * 「국내 개장가가 그대로 받는다」가 붙었다** — 코스피 본인한테 할 말이 아니다.
   * 미국 선물은 우리 개장 전에 움직이므로 예고가 맞지만, 아시아는 우리와 같이 도는 판이다.
   */
  const lead =
    group === "미국 지수선물"
      ? " — 국내 개장가가 그대로 받는다"
      : group === "아시아"
        ? " — 아시아가 같이 밀리는 판이다"
        : "";
  const leadUp = group === "미국 지수선물" ? " — 국내 개장가에 좋게 온다" : "";
  if (rate <= -2) return { level: "danger", why: `2% 이상 하락${lead}` };
  if (rate <= -1) return { level: "warn", why: `1% 이상 하락${lead}` };
  if (rate >= 2) return { level: "ok", why: `2% 이상 상승${leadUp}` };
  return null;
}

/**
 * 조회 대상.
 *
 * **인베스팅 관심종목 목록과 같은 구성·순서**로 맞췄다 (사용자 요청).
 * 티커는 전부 실측으로 확인했다 — 니켈(LME), 금/달러, KOSPI 변동성은 야후에 없어 뺐다.
 * 알루미늄은 선물(ALI=F), 홍콩 H는 항셍중국기업지수(^HSCE)로 대응한다.
 *
 * 필라델피아 반도체(^SOX)와 미국 선물은 인베스팅 목록엔 없지만
 * **미국↔국내 연동과 조간 리포트가 쓰고 있어** 뒤에 남겼다.
 */
const TARGETS: {
  key: string;
  label: string;
  group: string;
  symbol: string;
  isRate?: boolean;
  kind?: "선물" | "현물";
}[] = [
  // ── 환율·원자재 (인베스팅 순서)
  { key: "usdkrw", label: "달러/원", group: "환율", symbol: "KRW=X" },
  /*
   * WTI 는 뺐다 — 「미장 주요지수」 카드가 WTI 와 브렌트를 같이 준다.
   * 한 화면에 같은 값이 두 번 뜨면 어느 쪽이 지금 값인지 확인하게 되고, 그게 시간을 먹는다.
   */

  // ── 미국 지수
  /*
   * 미국 지수 — **선물을 먼저** 놓는다.
   *
   * 인베스팅에서 보시는 게 선물(Derived)이고, 우리 시간 낮에 실제로 움직이는 것도
   * 선물이다. 현물은 전일 종가에 멈춰 있으므로 아래에 따로 둔다.
   *
   * 예전에 ^IXIC(나스닥 **종합**)에 "US Tech 100"이라는 이름을 붙여 놨었다.
   * 나스닥 100 은 ^NDX / NQ=F 다 — 26,768 과 30,181 로 3,400 포인트가 달랐다.
   */
  { key: "ymF", label: "US 30", group: "미국 지수선물", symbol: "YM=F", kind: "선물" },
  { key: "esF", label: "US 500", group: "미국 지수선물", symbol: "ES=F", kind: "선물" },
  { key: "nqF", label: "US Tech 100", group: "미국 지수선물", symbol: "NQ=F", kind: "선물" },
  { key: "rtyF", label: "US 2000", group: "미국 지수선물", symbol: "RTY=F", kind: "선물" },

  /*
   * 미국 **현물** 지수(^DJI·^GSPC·^NDX·^IXIC·^RUT)는 여기서 뺐다.
   *
   * 선물과 나란히 놓으니 같은 지수가 두 줄씩 떠서 어느 게 지금 값인지 헷갈렸다 —
   * S&P 만 해도 "US 500 7,725.75" 와 "S&P 500 7,745.06" 이 나란히 있었다.
   * 게다가 현물은 우리 시간 05:30 에 닫혀 낮에는 전일 종가에 멈춰 있다.
   *
   * 이 화면은 **지금 움직이는 것**만 본다. 현물은 따로 자리를 만들어 거기서 본다.
   */

  /*
   * VIX 선물(VX=F)과 국채 금리(US10YT=X)는 야후에 없다 — 실측으로 확인했다.
   * 인베스팅은 자체 데이터라 되지만 우리는 현물로 대신하고, 그 사실을 표시한다.
   */
  /*
   * VIX·미국 금리도 뺐다. 「미장 주요지수」가 VIX 와 3개월·5년·10년·30년을 다 준다 —
   * 거기는 **장단기 역전**까지 봐 주는데 여기 두 줄은 그냥 숫자였다. 겹치면 거기가 낫다.
   */

  /*
   * ── 아시아
   *
   * **국내 지수는 뺐다** — 코스피·코스닥·코스피200·KODEX 코스닥150 넷 다
   * 맨 위 「국내 지수」 카드에 이미 있고, 거기가 키움 실시간이라 더 정확하다.
   * 야후로 한 번 더 받으면 같은 값이 두 번 뜨는 데다 조회만 넷 늘어난다.
   * 여기 남기는 건 **우리가 다른 데서 안 보는 아시아**뿐이다.
   */
  { key: "n225", label: "닛케이", group: "아시아", symbol: "^N225" },
  { key: "hsi", label: "항셍", group: "아시아", symbol: "^HSI" },
  { key: "hsce", label: "홍콩 H", group: "아시아", symbol: "^HSCE" },

  // ── 원자재
  { key: "gold", label: "금", group: "원자재", symbol: "GC=F" },
  { key: "silver", label: "은", group: "원자재", symbol: "SI=F" },
  { key: "copper", label: "구리", group: "원자재", symbol: "HG=F" },
  { key: "natgas", label: "천연가스", group: "원자재", symbol: "NG=F" },
  { key: "alum", label: "알루미늄", group: "원자재", symbol: "ALI=F" },
  /*
   * 리튬은 **선물이 없다.**
   *
   * 탄산리튬 선물은 광저우상품거래소(GFEX) 거래라 야후에 안 올라온다 — `LICO=F`,
   * `LI=F` 둘 다 실제로 찔러 보고 Not Found 를 확인했다(2026-08-24).
   *
   * 그래서 **대표 ETF** 로 대신한다. `LIT` 는 리튬 채굴·배터리 회사를 담은 묶음이라
   * 리튬 **가격 그 자체는 아니다** — 이름에 (LIT) 를 남겨 두는 이유가 그것이다.
   * 그래도 2차전지 종목이 왜 움직이는지 볼 때는 이쪽이 실제로 쓰인다.
   */
  { key: "lithium", label: "리튬(LIT)", group: "원자재", symbol: "LIT" },

  // ── 암호화폐
  { key: "btc", label: "비트코인", group: "암호화폐", symbol: "BTC-USD" },
  { key: "eth", label: "이더리움", group: "암호화폐", symbol: "ETH-USD" },


  /*
   * ^SOX·ES=F·NQ=F 도 뺐다. 셋 다 두 번씩 뜨고 있었다 —
   *   · ^SOX 는 「미장 주요지수」에 있다
   *   · ES=F 는 바로 위 `esF`(US 500), NQ=F 는 `nqF`(US Tech 100) 와 **같은 심볼**이다.
   *     그룹 이름만 달라서 「미국 지수선물」과 「미국선물」에 같은 값이 한 줄씩 있었다.
   *
   * 예전 주석에 "미국↔국내 연동과 조간 리포트가 쓰고 있어 남겼다"고 적혀 있었는데
   * **지금은 아니다.** `usKrLinks` 는 자기가 직접 야후를 부르고(TARGETS 를 안 본다),
   * `aiSummary` 는 목록 전체를 이름으로 훑을 뿐 특정 key 를 찾지 않는다. 확인하고 지웠다.
   */
];

const YAHOO_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";

let cache: { data: GlobalQuote[]; at: number } | null = null;
const TTL_MS = 60_000; // 외부 API 호출 제한을 고려해 1분 캐싱

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 심볼 하나를 야후에서 받는다.
 *
 * 「미장 주요지수」가 이 함수를 그대로 쓴다 — 같은 야후 응답을 두 군데서 다르게 읽으면
 * 언젠가 값이 어긋난다. 목록만 다르고 읽는 방식은 하나여야 한다.
 */
export async function fetchQuotes(symbols: string[]): Promise<Map<string, GlobalQuote>> {
  const out = new Map<string, GlobalQuote>();
  for (const symbol of symbols) {
    out.set(symbol, await fetchOne({ key: symbol, label: symbol, group: "", symbol }));
    await sleep(120);
  }
  return out;
}

async function fetchOne(target: {
  key: string;
  label: string;
  group: string;
  symbol: string;
  isRate?: boolean;
  kind?: "선물" | "현물";
}): Promise<GlobalQuote> {
  const base: GlobalQuote = {
    key: target.key,
    label: target.label,
    group: target.group,
    symbol: target.symbol,
    price: null,
    change: null,
    changeRate: null,
    isRate: target.isRate ?? false,
    kind: target.kind ?? "",
    // 묶음에 없는 이름이면 회색 — 색이 없다고 줄이 사라지면 안 된다
    color: GROUP_COLOR[target.group] ?? "#8b98a5",
    quotedAt: null,
    signal: null,
    error: null,
  };

  try {
    const url = `${YAHOO_BASE}/${encodeURIComponent(target.symbol)}?range=1d&interval=1d`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) {
      void recordApiCall("yahoo", target.symbol, res.status === 429 ? "rateLimited" : "failed");
      base.error = `HTTP ${res.status}`;
      return base;
    }
    void recordApiCall("yahoo", target.symbol, "ok");

    const body = (await res.json()) as {
      chart?: { result?: Array<{ meta?: Record<string, unknown> }> };
    };
    const meta = body.chart?.result?.[0]?.meta;
    if (!meta) {
      base.error = "응답 형식 오류";
      return base;
    }

    const price = Number(meta.regularMarketPrice);
    const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
    if (Number.isFinite(price)) base.price = price;
    if (Number.isFinite(price) && Number.isFinite(prev) && prev !== 0) {
      base.change = price - prev;
      base.changeRate = ((price - prev) / prev) * 100;
    }
    // 체결 시각 — 현물은 낮에 멈춰 있고 선물은 계속 움직인다. 그걸 화면이 보여줘야 한다
    const t = Number(meta.regularMarketTime);
    if (Number.isFinite(t) && t > 0) base.quotedAt = t * 1000;
    // 금리 줄은 등락률로 판단하면 안 된다(%p 로 읽어야 한다) — 그래서 빼 둔다
    if (!base.isRate) base.signal = signalOf(target.group, target.label, base.changeRate);
  } catch (err) {
    base.error = err instanceof Error ? err.message : "조회 실패";
  }
  return base;
}

/** 한 번에 몇 개씩 받을지. 야후에 예의는 지키되 줄줄이 세우지는 않는다 */
const BATCH = 5;

/**
 * 같은 순간에 두 번 부르지 않게 하는 자물쇠.
 *
 * 시황을 열면 여러 카드가 동시에 뜨는데, 캐시가 비어 있으면 **저마다 전체를 받으러 간다.**
 * 야후를 그만큼 더 두들기고 시간도 그대로 걸린다. 먼저 온 요청 하나만 일하고
 * 나머지는 그 결과를 같이 받는다.
 */
let inflight: Promise<GlobalQuote[]> | null = null;

async function fetchAll(): Promise<GlobalQuote[]> {
  /*
   * **묶어서 받는다.**
   *
   * 예전엔 열아홉 개를 하나씩 받으며 사이에 120ms 씩 쉬었다 — 실측 **6.3초**였다.
   * 서버가 새로 뜬 뒤 첫 방문(즉 배포할 때마다)이 그걸 그대로 기다렸다.
   *
   * 다섯씩 묶으면 네 번이면 끝난다. 쉬는 것도 묶음 사이에만 둔다 —
   * 야후에 한꺼번에 열아홉을 던지지는 않으므로 예의는 그대로다.
   */
  const results: GlobalQuote[] = [];
  for (let i = 0; i < TARGETS.length; i += BATCH) {
    const batch = TARGETS.slice(i, i + BATCH);
    // 한 종목이 실패해도 나머지는 정상 표시되도록 개별 처리한다(fetchOne 이 스스로 삼킨다)
    results.push(...(await Promise.all(batch.map((t) => fetchOne(t)))));
    if (i + BATCH < TARGETS.length) await sleep(120);
  }
  return results;
}

export async function getGlobalMarket(force = false): Promise<GlobalQuote[]> {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.data;
  if (inflight) return inflight;

  inflight = (async () => {
    try {
      const results = await fetchAll();
      cache = { data: results, at: Date.now() };
      return results;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
